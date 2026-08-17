// Package backup — snapshots do diretório de dados, com redundância.
//
// O produto anterior ADIOU backup por decisão; aqui ele entra. O desenho segue
// três regras que valem mais que qualquer feature:
//
//  1. O snapshot é um TAR SEM compressão, montado só com archive/tar da
//     biblioteca padrão. Sem compressão porque o conteúdo grande (log de
//     sessões) já é texto barato de guardar, e um tar cru é o formato que
//     qualquer ferramenta abre dali a cinco anos — backup que precisa do
//     nosso binário para ser lido não é backup.
//
//  2. O cofre (vault.json) ENTRA no snapshot, e isso é seguro POR DESENHO: o
//     internal/secrets sela cada segredo com AES-256-GCM usando a chave
//     mestra, então o arquivo copiado é ciphertext. A chave mestra e o token
//     ficam DE FORA de propósito — um backup que carrega a chave ao lado do
//     que ela abre se deslacra sozinho no primeiro disco perdido. Quem
//     restaura em outra estação leva a master.key por outro canal (o cofre da
//     empresa), como qualquer chave.
//
//  3. A restauração NUNCA escreve por cima do diretório vivo: ela cria uma
//     pasta NOVA e imprime o caminho. Restauração que sobrescreve transforma
//     um backup bom em dois dados ruins quando o tar está truncado — o vivo
//     morreu no meio da escrita e o backup era a única cópia íntegra. Trocar
//     as pastas é gesto da pessoa, com o gateway parado.
//
// A consistência do snapshot é a de arquivo, não a de transação: cada arquivo
// é lido uma vez, do começo ao tamanho visto no stat. O log de sessões é
// append-only (JSONL), então o pior caso de copiar durante uma escrita é a
// última linha cortada — o custo é um evento, nunca o log.
package backup

import (
	"archive/tar"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Nomes das variáveis de ambiente. Moram aqui (e não em internal/config)
// porque só este pacote as interpreta: o backup é opcional e autocontido, e o
// main só liga as pontas.
const (
	EnvEvery  = "AIBOT_BACKUP_EVERY"
	EnvKeep   = "AIBOT_BACKUP_KEEP"
	EnvMirror = "AIBOT_BACKUP_MIRROR"
)

const (
	// DefaultEvery é o intervalo de quem não configurou nada. Seis horas:
	// curto o bastante para um dia de trabalho não caber inteiro numa janela
	// perdida, longo o bastante para não virar IO de fundo constante.
	DefaultEvery = 6 * time.Hour

	// DefaultKeep mantém duas semanas do ritmo padrão de encerramento diário.
	DefaultKeep = 14

	filePrefix = "aibot-"
	fileSuffix = ".tar"
)

// targets é o que entra no snapshot: o log de conversas e os quatro arquivos
// de estado. A lista é explícita — copiar o DataDir inteiro arrastaria junto
// worktrees (que são cópias do repositório da pessoa), updates baixados e os
// próprios backups, e o tar cresceria até encher o disco que ele deveria
// proteger.
var targets = []string{
	"sessions",
	"memory.json",
	"schedule.json",
	"catalog.json",
	"vault.json",
}

// Options configura o serviço. Zero values caem nos padrões.
type Options struct {
	// Every é o intervalo entre snapshots periódicos.
	Every time.Duration
	// Keep é quantos tars ficam no disco local; o excedente mais velho morre.
	Keep int
	// Mirror é a pasta de REDUNDÂNCIA (outro disco, pasta de rede). Vazio
	// desliga o espelho. Falha no espelho nunca falha o snapshot local.
	Mirror string
}

// OptionsFromEnv lê AIBOT_BACKUP_EVERY/KEEP/MIRROR.
//
// Valor inválido NÃO derruba o boot: backup é proteção, e recusar a subida do
// gateway por causa de um "6 horas" digitado onde ia "6h" deixaria a pessoa
// sem o app E sem o backup. O erro vai para o log e o padrão assume.
func OptionsFromEnv(log *slog.Logger) Options {
	if log == nil {
		log = slog.Default()
	}
	options := Options{Mirror: strings.TrimSpace(os.Getenv(EnvMirror))}

	if raw := strings.TrimSpace(os.Getenv(EnvEvery)); raw != "" {
		every, err := time.ParseDuration(raw)
		if err != nil || every <= 0 {
			log.Warn("intervalo de backup inválido — usando o padrão",
				"variavel", EnvEvery, "valor", raw, "padrao", DefaultEvery.String())
		} else {
			options.Every = every
		}
	}
	if raw := strings.TrimSpace(os.Getenv(EnvKeep)); raw != "" {
		keep, err := strconv.Atoi(raw)
		if err != nil || keep <= 0 {
			log.Warn("retenção de backup inválida — usando o padrão",
				"variavel", EnvKeep, "valor", raw, "padrao", DefaultKeep)
		} else {
			options.Keep = keep
		}
	}
	return options
}

// Service grava e apaga snapshots de um diretório de dados.
type Service struct {
	dataDir string
	every   time.Duration
	keep    int
	mirror  string
	log     *slog.Logger

	// Um snapshot por vez: o relógio e o gancho de encerramento podem
	// coincidir, e dois tars sendo montados juntos dobrariam o IO para
	// produzir dois arquivos quase idênticos.
	mu sync.Mutex

	// lifecycle guarda `done` e NÃO é o `mu` acima de propósito: `mu` fica preso
	// durante um snapshot inteiro, e quem chama Wait() no encerramento ficaria
	// bloqueado antes mesmo de conseguir ler o canal que precisa esperar.
	lifecycle sync.Mutex
	// done fecha quando o laço do relógio termina. Nil antes do Start.
	done chan struct{}
}

// New monta o serviço. Zero values de Options caem nos padrões.
func New(dataDir string, options Options) *Service {
	every := options.Every
	if every <= 0 {
		every = DefaultEvery
	}
	keep := options.Keep
	if keep <= 0 {
		keep = DefaultKeep
	}
	return &Service{
		dataDir: dataDir,
		every:   every,
		keep:    keep,
		mirror:  strings.TrimSpace(options.Mirror),
		log:     slog.Default(),
	}
}

// SetLogger troca o logger (o main injeta o dele; nil é ignorado).
func (s *Service) SetLogger(log *slog.Logger) {
	if log != nil {
		s.log = log
	}
}

// Start sobe a goroutine do relógio e volta na hora; ela morre no ctx.Done().
//
// O primeiro snapshot NÃO acontece aqui: no boot o diretório acabou de ser
// lido e nada mudou desde o encerramento anterior — que já tirou o dele.
func (s *Service) Start(ctx context.Context) {
	if s == nil {
		return
	}
	done := make(chan struct{})
	s.lifecycle.Lock()
	s.done = done
	s.lifecycle.Unlock()
	go func() {
		defer close(done)
		s.loop(ctx)
	}()
}

// Wait espera o relógio terminar depois de o contexto ser cancelado.
//
// Cancelar o contexto só impede a PRÓXIMA volta: um snapshot já em andamento
// continua montando o tar, renomeando o `.partial` e aplicando a retenção depois
// de quem cancelou já ter seguido em frente. Sem esta espera não havia como
// saber que o serviço parou de escrever — e isso aparecia como intermitência no
// teste do relógio, que sob carga via a limpeza do diretório temporário
// esbarrar num arquivo nascendo.
func (s *Service) Wait() {
	if s == nil {
		return
	}
	s.lifecycle.Lock()
	done := s.done
	s.lifecycle.Unlock()
	if done != nil {
		<-done
	}
}

func (s *Service) loop(ctx context.Context) {
	ticker := time.NewTicker(s.every)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if path, err := s.Snapshot(); err != nil {
				s.log.Warn("backup periódico falhou", "erro", err)
			} else {
				s.log.Info("backup gravado", "arquivo", path)
			}
		}
	}
}

// Snapshot grava um tar novo em <dataDir>/backups e devolve o caminho dele.
//
// A ordem dos efeitos importa: o tar é montado num `.partial` e RENOMEADO só
// quando fechado — retenção e espelho nunca enxergam um tar pela metade. Só
// depois do rename vêm a retenção e o espelho, e falha em qualquer um dos
// dois não desfaz o snapshot que já está no disco.
func (s *Service) Snapshot() (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	directory := filepath.Join(s.dataDir, "backups")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return "", fmt.Errorf("criar a pasta de backups: %w", err)
	}

	// Timestamp UTC + nanossegundos com largura fixa: nomes únicos E em ordem
	// lexicográfica igual à cronológica — é o que deixa a retenção ordenar por
	// nome sem interpretar data.
	now := time.Now().UTC()
	name := fmt.Sprintf("%s%s-%09d%s", filePrefix, now.Format("20060102-150405"), now.Nanosecond(), fileSuffix)
	final := filepath.Join(directory, name)
	partial := final + ".partial"

	count, err := s.writeArchive(partial)
	if err != nil {
		_ = os.Remove(partial)
		return "", err
	}
	if count == 0 {
		// Sucesso vazio aqui seria o pior dos silêncios: um DataDir errado
		// geraria para sempre tars de zero arquivos e ninguém descobriria até
		// precisar restaurar.
		_ = os.Remove(partial)
		return "", fmt.Errorf("nada para copiar em %s — nenhum dos alvos (%s) existe", s.dataDir, strings.Join(targets, ", "))
	}
	if err := os.Rename(partial, final); err != nil {
		_ = os.Remove(partial)
		return "", fmt.Errorf("fechar o snapshot: %w", err)
	}

	s.prune(directory)
	s.mirrorCopy(final, name)
	return final, nil
}

// writeArchive monta o tar e devolve quantos arquivos entraram.
func (s *Service) writeArchive(path string) (int, error) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return 0, fmt.Errorf("criar o snapshot: %w", err)
	}

	writer := tar.NewWriter(file)
	count := 0
	for _, target := range targets {
		full := filepath.Join(s.dataDir, target)
		info, err := os.Stat(full)
		if errors.Is(err, fs.ErrNotExist) {
			// schedule.json (e afins) só nasce no primeiro uso da agenda;
			// um alvo ausente é estado normal, não falha do backup.
			continue
		}
		if err != nil {
			_ = file.Close()
			return 0, fmt.Errorf("ler %s: %w", target, err)
		}
		if info.IsDir() {
			added, err := s.addTree(writer, full, target)
			if err != nil {
				_ = file.Close()
				return 0, err
			}
			count += added
			continue
		}
		if err := addFile(writer, full, target); err != nil {
			_ = file.Close()
			return 0, err
		}
		count++
	}

	if err := writer.Close(); err != nil {
		_ = file.Close()
		return 0, fmt.Errorf("fechar o tar: %w", err)
	}
	// Sync antes do rename do chamador: sem ele, um corte de energia pode
	// entregar um tar de nome definitivo e conteúdo pela metade — exatamente o
	// arquivo em que a restauração confia.
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return 0, fmt.Errorf("sincronizar o snapshot: %w", err)
	}
	if err := file.Close(); err != nil {
		return 0, fmt.Errorf("fechar o snapshot: %w", err)
	}
	return count, nil
}

// addTree acrescenta uma árvore de diretório, com nomes relativos ao DataDir.
func (s *Service) addTree(writer *tar.Writer, root, base string) (int, error) {
	count := 0
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		// Diretórios não ganham entrada própria: a restauração os recria a
		// partir dos caminhos dos arquivos, e menos entradas são menos jeitos
		// de um tar externo inventar permissões.
		if entry.IsDir() {
			return nil
		}
		if !entry.Type().IsRegular() {
			// Um symlink dentro de sessions/ não é nosso (o store não cria
			// nenhum); copiá-lo arrastaria para o backup um alvo de fora.
			return nil
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		name := base + "/" + filepath.ToSlash(relative)
		if err := addFile(writer, path, name); err != nil {
			return err
		}
		count++
		return nil
	})
	if err != nil {
		return 0, fmt.Errorf("copiar %s: %w", base, err)
	}
	return count, nil
}

// addFile copia UM arquivo para o tar, no tamanho visto agora.
//
// io.CopyN com o tamanho do stat é o que dá a consistência por arquivo: se o
// log crescer durante a cópia, o tar leva o arquivo do instante do stat — o
// tar.Writer recusaria bytes além do cabeçalho de qualquer jeito.
func addFile(writer *tar.Writer, path, name string) error {
	source, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("abrir %s: %w", name, err)
	}
	defer source.Close()

	info, err := source.Stat()
	if err != nil {
		return fmt.Errorf("medir %s: %w", name, err)
	}
	header := &tar.Header{
		Name:    name,
		Mode:    0o600,
		Size:    info.Size(),
		ModTime: info.ModTime(),
	}
	if err := writer.WriteHeader(header); err != nil {
		return fmt.Errorf("gravar o cabeçalho de %s: %w", name, err)
	}
	if _, err := io.CopyN(writer, source, info.Size()); err != nil {
		return fmt.Errorf("copiar %s: %w", name, err)
	}
	return nil
}

// prune apaga os tars além dos `keep` mais novos. Falha aqui é log, não erro:
// um disco com um tar a mais é melhor que um snapshot recém-gravado reportado
// como falho.
func (s *Service) prune(directory string) {
	names, err := listBackups(directory)
	if err != nil {
		s.log.Warn("não foi possível listar os backups para a retenção", "erro", err)
		return
	}
	if len(names) <= s.keep {
		return
	}
	// listBackups devolve do mais novo para o mais velho.
	for _, name := range names[s.keep:] {
		if err := os.Remove(filepath.Join(directory, name)); err != nil {
			s.log.Warn("não foi possível apagar o backup antigo", "arquivo", name, "erro", err)
		}
	}
}

// listBackups devolve os nomes aibot-*.tar em ordem do MAIS NOVO para o mais
// velho. O nome carrega o timestamp em largura fixa, então ordenar o texto é
// ordenar o tempo.
func listBackups(directory string) ([]string, error) {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if entry.Type().IsRegular() && strings.HasPrefix(name, filePrefix) && strings.HasSuffix(name, fileSuffix) {
			names = append(names, name)
		}
	}
	sort.Sort(sort.Reverse(sort.StringSlice(names)))
	return names, nil
}

// mirrorCopy leva o tar FECHADO para a pasta de redundância.
//
// Falha aqui NUNCA falha o snapshot: o espelho é a segunda perna, e a rede
// fora do ar não pode derrubar a primeira. O log fica com o motivo — espelho
// que falha em silêncio é redundância que só existe no plano.
func (s *Service) mirrorCopy(final, name string) {
	if s.mirror == "" {
		return
	}
	if err := copyToMirror(final, s.mirror, name); err != nil {
		s.log.Warn("espelho do backup falhou — o snapshot local está íntegro",
			"espelho", s.mirror, "erro", err)
		return
	}
	s.log.Info("backup espelhado", "arquivo", filepath.Join(s.mirror, name))
}

func copyToMirror(source, mirror, name string) error {
	if err := os.MkdirAll(mirror, 0o700); err != nil {
		return fmt.Errorf("criar a pasta do espelho: %w", err)
	}
	in, err := os.Open(source)
	if err != nil {
		return fmt.Errorf("abrir o snapshot: %w", err)
	}
	defer in.Close()

	// Mesmo padrão do snapshot local: `.partial` + rename, para uma queda de
	// rede no meio da cópia não deixar no espelho um tar que PARECE inteiro.
	destination := filepath.Join(mirror, name)
	partial := destination + ".partial"
	out, err := os.OpenFile(partial, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("criar a cópia no espelho: %w", err)
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		_ = os.Remove(partial)
		return fmt.Errorf("copiar para o espelho: %w", err)
	}
	if err := out.Sync(); err != nil {
		_ = out.Close()
		_ = os.Remove(partial)
		return fmt.Errorf("sincronizar a cópia no espelho: %w", err)
	}
	if err := out.Close(); err != nil {
		_ = os.Remove(partial)
		return fmt.Errorf("fechar a cópia no espelho: %w", err)
	}
	if err := os.Rename(partial, destination); err != nil {
		_ = os.Remove(partial)
		return fmt.Errorf("fechar a cópia no espelho: %w", err)
	}
	return nil
}

/* ------------------------------- restauração ------------------------------ */

// Restore desempacota um snapshot numa pasta NOVA ao lado do tar e devolve o
// caminho dela. NUNCA escreve no diretório vivo — ver a regra 3 do cabeçalho:
// se o tar estiver truncado, o erro aparece AQUI, com o dado vivo intacto, e
// não no meio de uma sobrescrita que já apagou metade do original.
func Restore(archivePath string) (string, error) {
	file, err := os.Open(archivePath)
	if err != nil {
		return "", fmt.Errorf("abrir %s: %w", archivePath, err)
	}
	defer file.Close()

	destination, err := newRestoreDir(archivePath)
	if err != nil {
		return "", err
	}

	reader := tar.NewReader(file)
	extracted := 0
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			// Tar truncado ou corrompido: a pasta parcial fica no disco COM o
			// erro na tela — apagar o que já saiu esconderia a única pista de
			// até onde o backup era bom.
			return "", fmt.Errorf("ler o tar (a restauração parcial ficou em %s): %w", destination, err)
		}
		if header.Typeflag != tar.TypeReg {
			// Nossos tars só têm arquivo comum; qualquer outro tipo veio de
			// fora e não tem o que fazer aqui.
			continue
		}
		relative, err := safeEntryName(header.Name)
		if err != nil {
			return "", err
		}
		target := filepath.Join(destination, relative)
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			return "", fmt.Errorf("criar a pasta de %s: %w", relative, err)
		}
		out, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			return "", fmt.Errorf("criar %s: %w", relative, err)
		}
		if _, err := io.Copy(out, reader); err != nil {
			_ = out.Close()
			return "", fmt.Errorf("extrair %s (a restauração parcial ficou em %s): %w", relative, destination, err)
		}
		if err := out.Close(); err != nil {
			return "", fmt.Errorf("fechar %s: %w", relative, err)
		}
		extracted++
	}
	if extracted == 0 {
		return "", fmt.Errorf("%s não tem nenhum arquivo — o tar está vazio ou não é um snapshot do AI-BOT", archivePath)
	}
	return destination, nil
}

// newRestoreDir cria a pasta de destino ao lado do tar: `<nome>-restaurado`,
// com sufixo numérico quando já existe. os.Mkdir (sem All) é o portão — a
// pasta que já existe pode ser a restauração de ontem que alguém ainda usa.
func newRestoreDir(archivePath string) (string, error) {
	base := strings.TrimSuffix(filepath.Base(archivePath), fileSuffix)
	parent := filepath.Dir(archivePath)
	for attempt := 0; attempt < 1000; attempt++ {
		name := base + "-restaurado"
		if attempt > 0 {
			name = fmt.Sprintf("%s-restaurado-%d", base, attempt+1)
		}
		candidate := filepath.Join(parent, name)
		err := os.Mkdir(candidate, 0o700)
		if err == nil {
			return candidate, nil
		}
		if !errors.Is(err, fs.ErrExist) {
			return "", fmt.Errorf("criar a pasta de restauração: %w", err)
		}
	}
	return "", errors.New("mil pastas de restauração no mesmo lugar — limpe as antigas antes de restaurar de novo")
}

// safeEntryName valida o nome de uma entrada do tar contra path traversal.
//
// Nossos tars só têm nomes limpos, mas Restore aceita QUALQUER tar que a
// pessoa apontar — e um tar malicioso com `../` escreveria fora da pasta nova,
// que é exatamente o que a restauração promete nunca fazer.
func safeEntryName(name string) (string, error) {
	cleaned := filepath.ToSlash(name)
	if cleaned == "" || strings.HasPrefix(cleaned, "/") || strings.Contains(cleaned, ":") {
		return "", fmt.Errorf("o tar tem uma entrada com caminho absoluto (%q) — não é um snapshot do AI-BOT", name)
	}
	for _, part := range strings.Split(cleaned, "/") {
		if part == ".." {
			return "", fmt.Errorf("o tar tem uma entrada que sobe de diretório (%q) — não é um snapshot do AI-BOT", name)
		}
	}
	return filepath.FromSlash(cleaned), nil
}
