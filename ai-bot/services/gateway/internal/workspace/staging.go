// O motor do staging v1: a cópia de segurança em que o turno de modelo
// trabalha ANTES de entregar ao projeto.
//
// A regra do produto é uma frase: o modelo trabalha numa cópia e SÓ o desfecho
// bem-sucedido promove — falha, interrupção, recusa e o portão que narrou sem
// executar descartam a cópia, e nada meio-escrito chega à pessoa. Este arquivo
// é a mecânica dessa frase: copiar com teto, espelhar de volta e jogar fora.
//
// O escopo v1 é DELIBERADO: só a raiz dentro de <dataDir>/projects/ ganha
// cópia (workspace provisionado, pequeno por construção). A raiz apontada pela
// pessoa — a pasta própria dela, potencialmente gigante — continua inplace,
// porque a resposta para repositório grande é worktree/Puter, não cópia cega.
package workspace

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// ErrStaleStaging é a segunda cerca, a do PRÓPRIO staging: o diretório da
// cópia ainda existe, mas pertence a OUTRA materialização — um turno
// substituído que sobreviveu à troca não pode entregar (nem apagar) a cópia
// que o substituto acabou de materializar no mesmo lugar. Falha honesta, com
// motivo, em vez de um espelho que apagaria trabalho alheio.
var ErrStaleStaging = errors.New("o staging já pertence a outra materialização — este turno foi substituído")

/* ------------------------------- decisões -------------------------------- */

// stagesRoot decide se a raiz mora dentro de <dataDir>/projects/. A comparação
// é por caminho CANONICALIZADO (Abs + Rel), não por prefixo cru: "projects-2"
// não pode passar por "projects", e "projects/x/../../y" não pode entrar. Os
// dois lados nascem da mesma string de dataDir (o provisionamento monta a
// pasta com o MESMO Store.Root), então caixa e separador já batem.
func (m *Manager) stagesRoot(root string) bool {
	if m.stagingBase == "" || strings.TrimSpace(root) == "" {
		return false
	}
	projects, err := filepath.Abs(m.projectsBase)
	if err != nil {
		return false
	}
	// A URI persistente troca \ por /; desfaz antes de canonicalizar.
	absolute, err := filepath.Abs(filepath.FromSlash(root))
	if err != nil {
		return false
	}
	relative, err := filepath.Rel(projects, absolute)
	if err != nil {
		return false
	}
	if relative == "." {
		// A própria projects/ não é um projeto: espelhá-la apagaria os vizinhos.
		return false
	}
	return relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

// stagingPathFor resolve a pasta física da cópia de um plano. O nome é CURTO
// de propósito: um prefixo saneado do id (só para o humano reconhecer no
// disco) + o hash do id inteiro, que carrega sozinho a unicidade e mata o
// traversal de um id hostil ("../x"). O corte do prefixo não é estética — o
// workdir do sandbox passa por CreateProcess, que recusa lpCurrentDirectory
// acima de MAX_PATH (260) com um "The directory name is invalid" que não diz
// a causa; o id do plano embute sessão+tarefa e crescia sem teto (flagrado
// pelo conferente com o sbx real: caminho de 313 caracteres).
func (m *Manager) stagingPathFor(plan Plan) string {
	sum := sha256.Sum256([]byte(plan.ID))
	prefix := safeSegment(plan.ID)
	if len(prefix) > 24 {
		prefix = prefix[:24]
	}
	return filepath.Join(m.stagingBase,
		fmt.Sprintf("%s-%s", prefix, hex.EncodeToString(sum[:8])))
}

// safeSegment reduz um id a UM componente de caminho: só [a-zA-Z0-9._-], o
// resto vira hífen. Sem como subir de diretório porque não sobra com o quê.
func safeSegment(id string) string {
	var builder strings.Builder
	builder.Grow(len(id))
	for _, symbol := range id {
		switch {
		case symbol >= 'a' && symbol <= 'z',
			symbol >= 'A' && symbol <= 'Z',
			symbol >= '0' && symbol <= '9',
			symbol == '_', symbol == '-':
			builder.WriteRune(symbol)
		default:
			builder.WriteByte('-')
		}
	}
	trimmed := strings.Trim(builder.String(), "-.")
	if len(trimmed) > 80 {
		trimmed = trimmed[:80]
	}
	if trimmed == "" {
		return "plano"
	}
	return trimmed
}

// planLock serializa materializar/promover/descartar POR PLANO. Por plano, e
// não global: uma trava única seguraria toda sessão enquanto uma cópia de
// 128 MiB anda no disco de outra.
func (m *Manager) planLock(planID string) *sync.Mutex {
	lock, _ := m.stagingLocks.LoadOrStore(planID, &sync.Mutex{})
	return lock.(*sync.Mutex)
}

/* ----------------------------- materializar ------------------------------ */

// materializeStaging copia o projeto para a pasta de staging do plano e
// devolve a execução apontando para a CÓPIA. Estourar o teto (ou encontrar uma
// entrada que o espelho não sabe reproduzir) DEGRADA para inplace com o motivo
// preenchido — o turno continua, avisado, em vez de morrer por causa do
// sandbox. Erro de disco de verdade é erro: fingir que há workspace seria pior.
func (m *Manager) materializeStaging(plan Plan, root string) (*Execution, error) {
	lock := m.planLock(plan.ID)
	lock.Lock()
	defer lock.Unlock()

	stagingDir := m.stagingPathFor(plan)
	// Sobra de um turno anterior (ou de uma queda) não é reaproveitada: a
	// cópia nasce FRESCA do projeto de agora, senão o modelo trabalharia sobre
	// um passado que ninguém pediu.
	if err := os.RemoveAll(stagingDir); err != nil {
		return nil, fmt.Errorf("limpar o staging anterior: %w", err)
	}

	degrade, err := copyProject(root, stagingDir, m.stagingMaxBytes, m.stagingMaxFiles)
	if err != nil {
		_ = os.RemoveAll(stagingDir)
		return nil, fmt.Errorf("copiar o projeto para o staging: %w", err)
	}
	if degrade != "" {
		// Teto estourado: a metade copiada some e o turno trabalha direto no
		// projeto, como sempre trabalhou — com o motivo para a telemetria.
		_ = os.RemoveAll(stagingDir)
		return &Execution{Plan: plan, LocalRoot: root, StagingDegraded: degrade}, nil
	}

	m.stagingMu.Lock()
	m.nonceSeq++
	nonce := m.nonceSeq
	if m.stagingNonces == nil {
		m.stagingNonces = make(map[string]uint64)
	}
	m.stagingNonces[plan.ID] = nonce
	m.stagingMu.Unlock()

	return &Execution{
		Plan:         plan,
		LocalRoot:    stagingDir,
		LocalStaging: stagingDir,
		StagingNonce: nonce,
	}, nil
}

/* ------------------------- promover e descartar --------------------------- */

// promoteStaging é o espelho staging→projeto: novo e alterado copiados, sumido
// apagado, e a cópia removida no fim. A cerca de época já passou (Promote);
// aqui roda a cerca do PRÓPRIO staging, pelo nonce. Idempotente: sem diretório
// não há o que promover — a entrega já aconteceu (ou o descarte, e aí o
// chamador já sabia que falhou por outro caminho).
func (m *Manager) promoteStaging(plan Plan, result Publication) error {
	lock := m.planLock(plan.ID)
	lock.Lock()
	defer lock.Unlock()

	stagingDir := m.stagingPathFor(plan)
	if _, err := os.Stat(stagingDir); os.IsNotExist(err) {
		return nil
	}

	m.stagingMu.Lock()
	current, known := m.stagingNonces[plan.ID]
	m.stagingMu.Unlock()
	if !known || current != result.Nonce {
		// O diretório existe mas não é desta materialização (turno substituído,
		// ou sobra de uma queda que reiniciou o processo): espelhá-lo entregaria
		// — e apagaria do projeto — trabalho que não é deste turno.
		return ErrStaleStaging
	}

	project := localPath(plan.Source.URI)
	if project == "" {
		return errors.New("o plano com staging perdeu a pasta do projeto")
	}
	if err := mirrorTree(stagingDir, filepath.FromSlash(project)); err != nil {
		// O staging FICA: promover de novo depois de resolver o disco é
		// legítimo, e removê-lo agora transformaria um erro transitório em
		// trabalho perdido.
		return fmt.Errorf("espelhar o staging no projeto: %w", err)
	}

	if err := os.RemoveAll(stagingDir); err != nil {
		return fmt.Errorf("remover o staging promovido: %w", err)
	}
	m.stagingMu.Lock()
	delete(m.stagingNonces, plan.ID)
	m.stagingMu.Unlock()
	return nil
}

// discardStaging remove a cópia sem tocar o projeto. Nonce de outro dono é
// não-op: a cópia atual é do substituto, e o turno que morreu não apaga o
// trabalho de quem o substituiu.
func (m *Manager) discardStaging(plan Plan, result Publication) error {
	lock := m.planLock(plan.ID)
	lock.Lock()
	defer lock.Unlock()

	m.stagingMu.Lock()
	current, known := m.stagingNonces[plan.ID]
	m.stagingMu.Unlock()
	if known && current != result.Nonce {
		return nil
	}

	if err := os.RemoveAll(m.stagingPathFor(plan)); err != nil {
		return fmt.Errorf("descartar o staging: %w", err)
	}
	m.stagingMu.Lock()
	delete(m.stagingNonces, plan.ID)
	m.stagingMu.Unlock()
	return nil
}

/* ------------------------------ cópia/espelho ----------------------------- */

// copyProject copia a árvore inteira com TETO. Devolve (motivoDeDegradar, err):
// motivo preenchido = o projeto não cabe no sandbox (tamanho, contagem ou uma
// entrada que o espelho não sabe reproduzir) e o chamador degrada para inplace.
func copyProject(src, dst string, maxBytes int64, maxFiles int) (string, error) {
	var bytes int64
	var files int
	err := filepath.WalkDir(src, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		if relative == "." {
			return os.MkdirAll(dst, 0o755)
		}
		target := filepath.Join(dst, relative)
		if entry.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		if !entry.Type().IsRegular() {
			// Link simbólico, pipe, device: a cópia não os reproduz e o espelho
			// de volta os APAGARIA do projeto (sumido do staging = removido).
			// Degradar é a única saída que não perde nada.
			return errDegrade("o projeto tem entradas que a cópia de segurança não espelha (links/dispositivos)")
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		files++
		bytes += info.Size()
		if files > maxFiles || bytes > maxBytes {
			return errDegrade(fmt.Sprintf(
				"o projeto passou do teto da cópia de segurança (%d arquivos / %d MiB)",
				maxFiles, maxBytes>>20))
		}
		return copyFile(path, target, info.Mode().Perm())
	})
	var degrade *degradeError
	if errors.As(err, &degrade) {
		return degrade.reason, nil
	}
	return "", err
}

// degradeError transporta o motivo de degradar pelo WalkDir sem inventar um
// segundo canal de retorno.
type degradeError struct{ reason string }

func (e *degradeError) Error() string { return e.reason }
func errDegrade(reason string) error  { return &degradeError{reason: reason} }

// mirrorSkips lista os REPRODUZÍVEIS por nome: o que uma instalação ou uma
// execução reconstrói sozinha e por isso NÃO é produto do turno. A entrega é o
// PRODUTO — código-fonte e build de verdade (dist/ ENTRA: é o que a pessoa
// pediu) — nunca o material de obra que o container acumulou para chegar lá.
//
// A lista vale nos DOIS sentidos do espelho: o que está no staging com esses
// nomes não chega ao projeto, e o que já existe no projeto com esses nomes não
// é apagado por estar "sumido" da cópia — apagar o node_modules que a própria
// pessoa instalou seria interferir na máquina dela, que é exatamente o que o
// sandbox existe para não fazer.
func mirrorSkips(name string) bool {
	switch name {
	case "node_modules":
		// Instalado pelo npm/pnpm DENTRO do sandbox; são dezenas de milhares de
		// arquivos que um `install` reconstrói do lockfile — espelhá-los não
		// entrega nada e enche o disco da pessoa.
		return true
	case ".pnpm-store":
		// Cache de conteúdo do pnpm, endereçado por hash: recriado sob demanda.
		return true
	case "__pycache__":
		// Bytecode do Python: nasce de novo na primeira execução.
		return true
	case ".venv":
		// Ambiente virtual do Python: carrega caminhos absolutos do lugar onde
		// nasceu — copiado para outra máquina (ou outra pasta), quebra.
		return true
	case ".git":
		// O .git do staging é da CÓPIA (um scaffold com `git init` dentro do
		// container, ou objetos que o turno mexeu): espelhá-lo sobrescreveria —
		// e o apagamento do espelho destruiria — o histórico da própria pessoa.
		return true
	}
	return false
}

// mirrorTree faz do destino um ESPELHO da origem: copia tudo o que existe na
// origem (o projeto é pequeno por construção — comparar tamanho+mtime pouparia
// menos do que custa errar a comparação) e remove do destino o que sumiu.
// Reproduzíveis (mirrorSkips) ficam fora dos dois lados: nem chegam, nem são
// apagados.
func mirrorTree(src, dst string) error {
	// 1. O que vive na origem vai para o destino — e fica anotado como vivo.
	alive := make(map[string]bool)
	err := filepath.WalkDir(src, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		if relative == "." {
			return os.MkdirAll(dst, 0o755)
		}
		if mirrorSkips(entry.Name()) {
			// Reproduzível não é produto: não copia e não marca como vivo. O
			// SkipDir poupa a subárvore inteira — um node_modules é a maior
			// parte dos arquivos de qualquer projeto web.
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		alive[relative] = true
		target := filepath.Join(dst, relative)
		if entry.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		// Se o destino tem um DIRETÓRIO onde a origem tem arquivo, o diretório
		// sai primeiro — copiar por cima falharia com "is a directory".
		if existing, statErr := os.Lstat(target); statErr == nil && existing.IsDir() {
			if err := os.RemoveAll(target); err != nil {
				return err
			}
		}
		return copyFile(path, target, info.Mode().Perm())
	})
	if err != nil {
		return err
	}

	// 2. O que sumiu da origem sai do destino. Coletado primeiro, removido
	// depois: remover durante o WalkDir puxa o tapete do próprio caminhante.
	var stale []string
	err = filepath.WalkDir(dst, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(dst, path)
		if err != nil || relative == "." {
			return err
		}
		if alive[relative] {
			return nil
		}
		if mirrorSkips(entry.Name()) {
			// O reproduzível PRÉ-EXISTENTE do projeto sobrevive: o passo 1 não o
			// copiou do staging (então ele nunca está "vivo"), e apagá-lo aqui
			// destruiria o node_modules/.venv que a própria pessoa instalou.
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		stale = append(stale, path)
		if entry.IsDir() {
			return filepath.SkipDir
		}
		return nil
	})
	if err != nil {
		return err
	}
	for _, path := range stale {
		if err := os.RemoveAll(path); err != nil {
			return err
		}
	}
	return nil
}

// copyFile copia UM arquivo preservando o modo. io.Copy em vez de ReadFile:
// não paga o arquivo inteiro em memória.
func copyFile(src, dst string, mode fs.FileMode) error {
	source, err := os.Open(src)
	if err != nil {
		return err
	}
	defer source.Close()
	target, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(target, source); err != nil {
		target.Close()
		return err
	}
	return target.Close()
}
