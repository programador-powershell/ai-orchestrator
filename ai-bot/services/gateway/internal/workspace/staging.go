// O motor do staging v1: a cópia de segurança em que o turno de modelo
// trabalha ANTES de entregar ao projeto.
//
// A regra do produto é uma frase: o modelo trabalha numa cópia e SÓ o desfecho
// bem-sucedido promove — falha, interrupção, recusa e o portão que narrou sem
// executar descartam a cópia, e nada meio-escrito chega à pessoa. Este arquivo
// é a mecânica dessa frase: copiar com teto, espelhar de volta e jogar fora.
//
// O escopo é UNIVERSAL desde a decisão do dono ("todos os especialistas
// trabalham em sandbox"): TODO turno de modelo com raiz definida ganha cópia —
// a provisionada E a apontada pela pessoa. O que tornou a pasta da pessoa
// viável foi a cópia de ida passar a EXCLUIR os reproduzíveis (mirrorSkips):
// um projeto com node_modules não estoura mais o teto à toa. O teto continua
// valendo para o que sobra, e estourá-lo degrada para inplace com aviso alto —
// e, degradado, o turno volta ao modelo de aprovação por comando (a jaula não
// existiu, então não há entrega para aprovar).
package workspace

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
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

// stagesRoot decide se a raiz ganha cópia. Desde o sandbox universal a
// resposta é SIM para qualquer raiz definida — provisionada ou apontada pela
// pessoa —, com UMA cerca que não é política, é física: a raiz não pode
// conter a área de staging nem morar dentro dela. Copiar uma raiz que contém
// <dataDir>/staging copiaria a cópia enquanto ela é escrita (a caminhada
// revisita o destino que cresce debaixo dela), e uma raiz DENTRO do staging é
// a cópia de outro turno — espelhá-la entregaria trabalho alheio. A comparação
// é por caminho CANONICALIZADO (Abs + Rel), não por prefixo cru: "staging-2"
// não pode cair na cerca de "staging".
func (m *Manager) stagesRoot(root string) bool {
	if m.stagingBase == "" || strings.TrimSpace(root) == "" {
		return false
	}
	staging, err := filepath.Abs(m.stagingBase)
	if err != nil {
		return false
	}
	// A URI persistente troca \ por /; desfaz antes de canonicalizar.
	absolute, err := filepath.Abs(filepath.FromSlash(root))
	if err != nil {
		return false
	}
	if pathWithin(staging, absolute) || pathWithin(absolute, staging) {
		return false
	}
	return true
}

// pathWithin diz se `child` é o próprio `parent` ou mora dentro dele. Por
// Rel, não por prefixo de string: "staging-2" começa com "staging" como texto
// e não mora dentro dele como caminho.
func pathWithin(parent, child string) bool {
	relative, err := filepath.Rel(parent, child)
	if err != nil {
		return false
	}
	return relative == "." ||
		(relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)))
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

/* ----------------------------- o diff da entrega --------------------------- */

// Changes é O QUE a promoção vai fazer com o projeto — criados, alterados e
// apagados, em caminhos relativos com /. É o conteúdo do cartão de entrega: a
// pessoa aprova UMA vez olhando esta lista, em vez de aprovar gesto a gesto
// dentro da jaula. Reproduzíveis (mirrorSkips) ficam fora, exatamente como
// ficam fora do espelho — listar o que não vai acontecer seria mentir no cartão.
type Changes struct {
	Created  []string
	Modified []string
	Deleted  []string
}

// Empty diz se a entrega não muda nada — e aí a promoção é silenciosa
// (constatação), sem cartão.
func (c Changes) Empty() bool { return c.Total() == 0 }

// Total conta as mudanças, para o resumo do cartão.
func (c Changes) Total() int { return len(c.Created) + len(c.Modified) + len(c.Deleted) }

// StagingChanges calcula o diff staging→projeto ANTES da promoção. Passa pelas
// mesmas cercas do Promote (trava por plano, nonce da materialização): calcular
// o diff de uma cópia que pertence a outro turno anunciaria uma entrega que
// este turno não tem o direito de fazer. Staging inexistente devolve vazio —
// não há o que entregar.
func (m *Manager) StagingChanges(plan Plan, result Publication) (Changes, error) {
	if m == nil || m.stagingBase == "" || !strings.HasPrefix(result.StagingURI, StagingURIPrefix) {
		return Changes{}, nil
	}
	lock := m.planLock(plan.ID)
	lock.Lock()
	defer lock.Unlock()

	stagingDir := m.stagingPathFor(plan)
	if _, err := os.Stat(stagingDir); os.IsNotExist(err) {
		return Changes{}, nil
	}

	m.stagingMu.Lock()
	current, known := m.stagingNonces[plan.ID]
	m.stagingMu.Unlock()
	if !known || current != result.Nonce {
		return Changes{}, ErrStaleStaging
	}

	project := localPath(plan.Source.URI)
	if project == "" {
		return Changes{}, errors.New("o plano com staging perdeu a pasta do projeto")
	}
	return diffTrees(stagingDir, filepath.FromSlash(project))
}

// diffTrees compara a cópia (src) com o projeto (dst) com as MESMAS regras do
// mirrorTree — o diff descreve o espelho que vai rodar, não outra coisa: o que
// só existe na cópia é criado, o que difere é alterado, o que sumiu da cópia é
// apagado, e reproduzível não conta em lado nenhum.
func diffTrees(src, dst string) (Changes, error) {
	var changes Changes
	alive := make(map[string]bool)
	err := filepath.WalkDir(src, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(src, path)
		if err != nil || relative == "." {
			return err
		}
		if mirrorSkips(entry.Name()) {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		// Diretório também é marcado como vivo: no passo 2 é o mapa que separa
		// "a pasta segue" de "a pasta sumiu inteira".
		alive[relative] = true
		if entry.IsDir() {
			return nil
		}
		slash := filepath.ToSlash(relative)
		target := filepath.Join(dst, relative)
		info, statErr := os.Lstat(target)
		switch {
		case os.IsNotExist(statErr):
			changes.Created = append(changes.Created, slash)
		case statErr != nil:
			return statErr
		case !info.Mode().IsRegular():
			// O projeto tem um diretório (ou link) onde a cópia tem arquivo: o
			// espelho substitui — para o cartão, é uma alteração.
			changes.Modified = append(changes.Modified, slash)
		default:
			equal, err := filesEqual(path, target)
			if err != nil {
				return err
			}
			if !equal {
				changes.Modified = append(changes.Modified, slash)
			}
		}
		return nil
	})
	if err != nil {
		return Changes{}, err
	}

	err = filepath.WalkDir(dst, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(dst, path)
		if err != nil || relative == "." {
			return err
		}
		if mirrorSkips(entry.Name()) {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if alive[relative] {
			return nil
		}
		// A pasta sumida não é item do cartão — desce e lista os ARQUIVOS dela,
		// que é o que a pessoa entende por "apagado".
		if entry.IsDir() {
			return nil
		}
		changes.Deleted = append(changes.Deleted, filepath.ToSlash(relative))
		return nil
	})
	if err != nil {
		return Changes{}, err
	}

	// Ordem estável porque isto vira texto de um cartão: mapa e WalkDir até
	// entregam ordenado hoje, mas o cartão não pode depender desse acaso.
	sort.Strings(changes.Created)
	sort.Strings(changes.Modified)
	sort.Strings(changes.Deleted)
	return changes, nil
}

// filesEqual compara dois arquivos por conteúdo, em blocos — o projeto cabe no
// teto do staging, mas ler pares inteiros em memória pagaria o dobro à toa.
// Tamanho diferente decide sem abrir nada.
func filesEqual(a, b string) (bool, error) {
	infoA, err := os.Stat(a)
	if err != nil {
		return false, err
	}
	infoB, err := os.Stat(b)
	if err != nil {
		return false, err
	}
	if infoA.Size() != infoB.Size() {
		return false, nil
	}

	fileA, err := os.Open(a)
	if err != nil {
		return false, err
	}
	defer fileA.Close()
	fileB, err := os.Open(b)
	if err != nil {
		return false, err
	}
	defer fileB.Close()

	bufA := make([]byte, 64<<10)
	bufB := make([]byte, 64<<10)
	for {
		lenA, errA := io.ReadFull(fileA, bufA)
		lenB, errB := io.ReadFull(fileB, bufB)
		if lenA != lenB || !bytes.Equal(bufA[:lenA], bufB[:lenB]) {
			return false, nil
		}
		endA := errors.Is(errA, io.EOF) || errors.Is(errA, io.ErrUnexpectedEOF)
		endB := errors.Is(errB, io.EOF) || errors.Is(errB, io.ErrUnexpectedEOF)
		if errA != nil && !endA {
			return false, errA
		}
		if errB != nil && !endB {
			return false, errB
		}
		if endA || endB {
			return endA == endB, nil
		}
	}
}

/* ------------------------------ cópia/espelho ----------------------------- */

// copyProject copia a árvore com TETO. Devolve (motivoDeDegradar, err):
// motivo preenchido = o projeto não cabe no sandbox (tamanho, contagem ou uma
// entrada que o espelho não sabe reproduzir) e o chamador degrada para inplace.
//
// A cópia de IDA exclui os REPRODUZÍVEIS (a MESMA lista do espelho —
// mirrorSkips): o node_modules da pessoa não é produto do turno, não seria
// espelhado de volta de qualquer forma, e contá-lo aqui era o que estourava o
// teto à toa em qualquer projeto web real (a pendência declarada da v1). De
// quebra, os links simbólicos que o pnpm planta lá dentro deixam de degradar
// uma cópia que nunca precisou deles.
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
		if mirrorSkips(entry.Name()) {
			// Reproduzível fica no projeto: o turno que precisar dele (um build
			// dentro do container) o reconstrói do lockfile na própria cópia.
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
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
