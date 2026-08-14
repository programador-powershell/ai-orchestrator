// Package store guarda o log durável das sessões.
//
// LOCAL-FIRST, como no app anterior: o disco desta máquina é a FONTE DA VERDADE
// e qualquer servidor é cópia. É o que permite abrir o AI-BOT sem rede, mandar
// um prompt para o modelo local e não perder nada — o inverso (servidor como
// fonte) transforma queda de rede em perda de conversa.
//
// O formato é um log APPEND-ONLY de envelopes, um por linha (JSONL), com `seq`
// contínuo por sessão. Não é banco por decisão de dependência: SQLite não está
// na biblioteca padrão do Go, e um driver seria uma dependência de terceiro no
// processo que guarda a conversa inteira do usuário. O que o banco daria e aqui
// é feito à mão: numeração atômica (mutex por sessão + arquivo aberto em
// O_APPEND), leitura por cursor (`Since`) e durabilidade (`Sync` antes de
// confirmar a escrita).
//
// O que este formato NÃO dá, e é aceito de propósito: consulta por conteúdo. A
// busca vive em internal/memory, sobre um índice próprio — varrer JSONL
// procurando texto é aceitável em conversa de usuário e seria inaceitável em
// telemetria de servidor, que não é o caso aqui.
package store

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"aibot/gateway/internal/protocol"
)

// MaxEventBatch é o teto de envelopes devolvidos por leitura. Igual ao teto do
// cliente de propósito: quando os dois divergem, o lado menor pagina para
// sempre pedindo o mesmo pedaço e o replay nunca termina.
const MaxEventBatch = 500

// ErrNotFound diz que a sessão não existe no disco.
var ErrNotFound = errors.New("sessão não encontrada")

// ErrLocked diz que outro processo já é dono deste diretório.
var ErrLocked = errors.New("diretório de dados já está em uso por outro processo")

// SessionMeta é o cabeçalho da sessão — o que a barra lateral precisa para
// listar sem abrir o log.
type SessionMeta struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	// Specialist é o último especialista que atendeu. A lista mostra o ícone
	// dele; abrir a sessão restaura a superfície sem esperar o primeiro turno.
	Specialist string `json:"specialist,omitempty"`
	Model      string `json:"model,omitempty"`
	CWD        string `json:"cwd,omitempty"`
	// ProjectID agrupa sessões em pasta. Vazio = solta.
	ProjectID string    `json:"projectId,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
	LastSeq   uint64    `json:"lastSeq"`
	// SyncedSeq é o cursor já espelhado num servidor. Só anda para frente.
	SyncedSeq uint64 `json:"syncedSeq"`
	Turns     int    `json:"turns"`
	Archived  bool   `json:"archived,omitempty"`
}

// Store é o dono do diretório de dados.
type Store struct {
	root string
	lock *os.File

	mu       sync.Mutex
	sessions map[string]*sessionHandle
}

// sessionHandle mantém o arquivo aberto e o seq corrente de uma sessão.
type sessionHandle struct {
	mu   sync.Mutex
	meta SessionMeta
	file *os.File
	path string
}

// Open abre (ou cria) o diretório de dados e o tranca.
//
// A trava existe porque `seq` é atribuído em memória: dois processos sobre a
// mesma pasta gerariam dois eventos com o mesmo número, e o replay entregaria
// um deles como se fosse o outro. Falhar na subida é melhor que corromper em
// silêncio.
func Open(root string) (*Store, error) {
	if root == "" {
		return nil, errors.New("diretório de dados vazio")
	}
	if err := os.MkdirAll(filepath.Join(root, "sessions"), 0o700); err != nil {
		return nil, fmt.Errorf("criar diretório de dados: %w", err)
	}

	lockPath := filepath.Join(root, ".lock")
	lock, err := os.OpenFile(lockPath, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0o600)
	if err != nil {
		if os.IsExist(err) {
			// Trava órfã de um processo morto trava o app para sempre. Se o pid
			// gravado não existe mais, a trava é reaproveitada.
			if stale(lockPath) {
				_ = os.Remove(lockPath)
				lock, err = os.OpenFile(lockPath, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0o600)
			}
		}
		if err != nil {
			return nil, fmt.Errorf("%w: %s", ErrLocked, lockPath)
		}
	}
	if _, err := fmt.Fprintf(lock, "%d\n", os.Getpid()); err != nil {
		_ = lock.Close()
		return nil, fmt.Errorf("gravar trava: %w", err)
	}

	return &Store{root: root, lock: lock, sessions: make(map[string]*sessionHandle)}, nil
}

// stale diz se a trava aponta para um processo que não existe mais.
func stale(lockPath string) bool {
	raw, err := os.ReadFile(lockPath)
	if err != nil {
		return true
	}
	var pid int
	if _, err := fmt.Sscanf(strings.TrimSpace(string(raw)), "%d", &pid); err != nil || pid <= 0 {
		return true
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		return true
	}

	// Windows: os.FindProcess abre um handle de verdade (OpenProcess), então ele
	// JÁ falhou acima se o pid não existe mais. Chegar aqui significa processo
	// vivo — e é obrigatório parar aqui, porque (*Process).signal no Windows
	// devolve erro para tudo o que não seja Kill. Perguntar por sinal ali daria
	// "sempre morto", o gateway roubaria a trava de um processo vivo e dois
	// donos escreveriam `seq` sobre a mesma sessão — exatamente a corrupção que
	// esta trava existe para impedir.
	if runtime.GOOS == "windows" {
		return false
	}

	// Unix: os.FindProcess NUNCA falha (só embrulha o número), então quem
	// responde de verdade é o sinal 0 — o idioma do kill(2): o núcleo faz a
	// checagem de existência e de permissão e não entrega sinal nenhum ao alvo.
	// Erro aqui é ESRCH (pid morto) e a trava é órfã; nil é processo vivo.
	//
	// O sinal precisa ser syscall.Signal: os.Process.Signal faz uma asserção de
	// tipo para ela, e qualquer outro os.Signal — inclusive nil — sai como
	// "unsupported signal type", que é erro e seria lido como pid morto.
	return process.Signal(syscall.Signal(0)) != nil
}

// Close solta a trava.
func (s *Store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, handle := range s.sessions {
		handle.mu.Lock()
		if handle.file != nil {
			_ = handle.file.Sync()
			_ = handle.file.Close()
			handle.file = nil
		}
		handle.mu.Unlock()
	}
	s.sessions = make(map[string]*sessionHandle)
	if s.lock != nil {
		name := s.lock.Name()
		_ = s.lock.Close()
		_ = os.Remove(name)
		s.lock = nil
	}
	return nil
}

// Root devolve o diretório de dados.
func (s *Store) Root() string { return s.root }

func (s *Store) sessionDir(id string) string {
	return filepath.Join(s.root, "sessions", safeID(id))
}

// safeID impede que um id vindo do cliente escape do diretório de dados. Um id
// com `..` viraria escrita em qualquer lugar do disco — este é o único ponto em
// que o id do cliente encosta no sistema de arquivos.
func safeID(id string) string {
	var builder strings.Builder
	builder.Grow(len(id))
	for _, symbol := range id {
		switch {
		case symbol >= 'a' && symbol <= 'z',
			symbol >= 'A' && symbol <= 'Z',
			symbol >= '0' && symbol <= '9',
			symbol == '-', symbol == '_':
			builder.WriteRune(symbol)
		default:
			builder.WriteByte('_')
		}
	}
	out := builder.String()
	if out == "" {
		return "sessao"
	}
	if len(out) > 96 {
		out = out[:96]
	}
	return out
}

/* ------------------------------- sessões ------------------------------- */

// CreateSession grava o cabeçalho de uma sessão nova.
func (s *Store) CreateSession(meta SessionMeta) (SessionMeta, error) {
	if meta.ID == "" {
		return SessionMeta{}, errors.New("sessão sem id")
	}
	now := time.Now().UTC()
	if meta.CreatedAt.IsZero() {
		meta.CreatedAt = now
	}
	meta.UpdatedAt = now
	meta.LastSeq = 0
	meta.SyncedSeq = 0

	directory := s.sessionDir(meta.ID)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return SessionMeta{}, fmt.Errorf("criar sessão: %w", err)
	}
	if err := writeJSONAtomic(filepath.Join(directory, "meta.json"), meta); err != nil {
		return SessionMeta{}, err
	}
	return meta, nil
}

// GetSession lê o cabeçalho.
func (s *Store) GetSession(id string) (SessionMeta, error) {
	handle, err := s.handle(id)
	if err != nil {
		return SessionMeta{}, err
	}
	handle.mu.Lock()
	defer handle.mu.Unlock()
	return handle.meta, nil
}

// UpdateSession grava campos editáveis do cabeçalho. `LastSeq` e `SyncedSeq`
// são ignorados aqui de propósito: quem move o cursor é o próprio log.
func (s *Store) UpdateSession(id string, mutate func(*SessionMeta)) (SessionMeta, error) {
	handle, err := s.handle(id)
	if err != nil {
		return SessionMeta{}, err
	}
	handle.mu.Lock()
	defer handle.mu.Unlock()

	previousSeq, previousSynced := handle.meta.LastSeq, handle.meta.SyncedSeq
	mutate(&handle.meta)
	handle.meta.ID = id
	handle.meta.LastSeq, handle.meta.SyncedSeq = previousSeq, previousSynced
	handle.meta.UpdatedAt = time.Now().UTC()

	if err := writeJSONAtomic(filepath.Join(s.sessionDir(id), "meta.json"), handle.meta); err != nil {
		return SessionMeta{}, err
	}
	return handle.meta, nil
}

// MarkSynced move o cursor de sincronização. Usa MAX para o cursor nunca andar
// para trás: uma confirmação atrasada chegando depois de outra mais nova faria
// o espelho reenviar o que já foi aceito.
func (s *Store) MarkSynced(id string, seq uint64) error {
	handle, err := s.handle(id)
	if err != nil {
		return err
	}
	handle.mu.Lock()
	defer handle.mu.Unlock()
	if seq <= handle.meta.SyncedSeq {
		return nil
	}
	handle.meta.SyncedSeq = seq
	handle.meta.UpdatedAt = time.Now().UTC()
	return writeJSONAtomic(filepath.Join(s.sessionDir(id), "meta.json"), handle.meta)
}

// ListSessions devolve os cabeçalhos, mais recente primeiro.
func (s *Store) ListSessions() ([]SessionMeta, error) {
	entries, err := os.ReadDir(filepath.Join(s.root, "sessions"))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("listar sessões: %w", err)
	}
	out := make([]SessionMeta, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		var meta SessionMeta
		path := filepath.Join(s.root, "sessions", entry.Name(), "meta.json")
		if err := readJSON(path, &meta); err != nil {
			// Sessão ilegível não derruba a listagem: a pessoa perde UMA linha
			// da barra lateral, não o acesso ao histórico inteiro.
			continue
		}
		out = append(out, meta)
	}
	sort.SliceStable(out, func(i, j int) bool {
		return out[i].UpdatedAt.After(out[j].UpdatedAt)
	})
	return out, nil
}

// DeleteSession apaga a sessão inteira.
func (s *Store) DeleteSession(id string) error {
	s.mu.Lock()
	if handle, ok := s.sessions[id]; ok {
		handle.mu.Lock()
		if handle.file != nil {
			_ = handle.file.Close()
			handle.file = nil
		}
		handle.mu.Unlock()
		delete(s.sessions, id)
	}
	s.mu.Unlock()
	return os.RemoveAll(s.sessionDir(id))
}

/* --------------------------------- log --------------------------------- */

// Append numera e grava o envelope. Devolve o `seq` atribuído.
//
// A numeração acontece com o mutex da sessão segurado e o arquivo em O_APPEND:
// ler o último seq e gravar depois, sem trava, reabriria a corrida que faz dois
// eventos nascerem com o mesmo número — e o replay entregar um pelo outro.
func (s *Store) Append(sessionID string, envelope *protocol.Envelope) (uint64, error) {
	if envelope == nil {
		return 0, errors.New("envelope nulo")
	}
	handle, err := s.handle(sessionID)
	if err != nil {
		return 0, err
	}

	handle.mu.Lock()
	defer handle.mu.Unlock()

	if handle.file == nil {
		file, err := os.OpenFile(handle.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
		if err != nil {
			return 0, fmt.Errorf("abrir log da sessão: %w", err)
		}
		handle.file = file
	}

	handle.meta.LastSeq++
	envelope.Seq = handle.meta.LastSeq
	envelope.Session = sessionID
	envelope.V = protocol.Version
	if envelope.TS.IsZero() {
		envelope.TS = time.Now().UTC()
	}

	line, err := json.Marshal(envelope)
	if err != nil {
		handle.meta.LastSeq-- // não gravou: o número volta.
		return 0, fmt.Errorf("serializar envelope: %w", err)
	}
	line = append(line, '\n')
	if _, err := handle.file.Write(line); err != nil {
		handle.meta.LastSeq--
		return 0, fmt.Errorf("gravar envelope: %w", err)
	}

	// Sync só nos verbos que a pessoa não pode perder. Dar fsync em cada delta
	// de streaming daria uma ida ao disco por token — o app ficaria mais lento
	// que o modelo, para durabilizar texto que o `done` seguinte consolida.
	if durable(envelope.Kind) {
		if err := handle.file.Sync(); err != nil {
			return 0, fmt.Errorf("sincronizar log: %w", err)
		}
	}

	handle.meta.UpdatedAt = time.Now().UTC()
	if envelope.Kind == protocol.KindDone {
		handle.meta.Turns++
	}
	if envelope.From.Specialist != "" {
		handle.meta.Specialist = envelope.From.Specialist
	}
	_ = writeJSONAtomic(filepath.Join(s.sessionDir(sessionID), "meta.json"), handle.meta)

	return envelope.Seq, nil
}

// durable diz quais verbos merecem ida ao disco na hora.
func durable(kind protocol.Kind) bool {
	switch kind {
	case protocol.KindDelta, protocol.KindThinking, protocol.KindTaskProgress, protocol.KindState:
		return false
	default:
		return true
	}
}

// Since devolve os envelopes com seq > fromSeq, até `limit` (teto MaxEventBatch).
//
// É o replay: um cliente que caiu no meio da resposta reconecta dizendo o
// último seq que viu e recebe o resto — em vez de recomeçar o turno.
func (s *Store) Since(sessionID string, fromSeq uint64, limit int) ([]protocol.Envelope, error) {
	if limit <= 0 || limit > MaxEventBatch {
		limit = MaxEventBatch
	}
	handle, err := s.handle(sessionID)
	if err != nil {
		return nil, err
	}

	// Flush antes de ler: o que está no buffer do arquivo aberto para escrita
	// precisa estar visível para quem lê por outro descritor.
	handle.mu.Lock()
	if handle.file != nil {
		_ = handle.file.Sync()
	}
	path := handle.path
	handle.mu.Unlock()

	file, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("abrir log da sessão: %w", err)
	}
	defer file.Close()

	out := make([]protocol.Envelope, 0, 32)
	scanner := bufio.NewScanner(file)
	// Uma mensagem inteira cabe numa linha, e mensagem de modelo passa fácil dos
	// 64 KiB do buffer padrão do Scanner — sem isto, `bufio.ErrTooLong` corta o
	// replay no primeiro turno longo.
	scanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var envelope protocol.Envelope
		if err := json.Unmarshal(line, &envelope); err != nil {
			// Linha truncada por queda de energia no meio da escrita: pular é o
			// certo. O log é append-only, então só a ÚLTIMA linha pode estar
			// partida — abortar aqui perderia todo o histórico anterior a ela.
			continue
		}
		if envelope.Seq <= fromSeq {
			continue
		}
		out = append(out, envelope)
		if len(out) >= limit {
			break
		}
	}
	if err := scanner.Err(); err != nil && !errors.Is(err, io.EOF) {
		return out, fmt.Errorf("ler log da sessão: %w", err)
	}
	return out, nil
}

// LastSeq devolve o último número gravado.
func (s *Store) LastSeq(sessionID string) (uint64, error) {
	handle, err := s.handle(sessionID)
	if err != nil {
		return 0, err
	}
	handle.mu.Lock()
	defer handle.mu.Unlock()
	return handle.meta.LastSeq, nil
}

/* -------------------------------- interno ------------------------------- */

// handle devolve (e cacheia) o descritor da sessão, recuperando `LastSeq` do
// disco na primeira vez.
func (s *Store) handle(id string) (*sessionHandle, error) {
	s.mu.Lock()
	if handle, ok := s.sessions[id]; ok {
		s.mu.Unlock()
		return handle, nil
	}
	s.mu.Unlock()

	directory := s.sessionDir(id)
	var meta SessionMeta
	if err := readJSON(filepath.Join(directory, "meta.json"), &meta); err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("%w: %s", ErrNotFound, id)
		}
		return nil, err
	}
	logPath := filepath.Join(directory, "log.jsonl")

	// O meta.json pode estar atrás do log se o processo morreu entre a escrita
	// do envelope e a do cabeçalho. O log manda: ele é append-only e é a fonte.
	if seq, err := lastSeqOnDisk(logPath); err == nil && seq > meta.LastSeq {
		meta.LastSeq = seq
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if handle, ok := s.sessions[id]; ok {
		return handle, nil
	}
	handle := &sessionHandle{meta: meta, path: logPath}
	s.sessions[id] = handle
	return handle, nil
}

// lastSeqOnDisk varre o log e devolve o maior seq gravado.
func lastSeqOnDisk(path string) (uint64, error) {
	file, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer file.Close()

	var last uint64
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	for scanner.Scan() {
		var head struct {
			Seq uint64 `json:"seq"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &head); err != nil {
			continue
		}
		if head.Seq > last {
			last = head.Seq
		}
	}
	return last, scanner.Err()
}

// writeJSONAtomic grava por arquivo temporário + rename. Escrever por cima do
// original deixa o cabeçalho vazio se o processo morrer no meio — e cabeçalho
// vazio é sessão que some da barra lateral.
func writeJSONAtomic(path string, value any) error {
	raw, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return fmt.Errorf("serializar %s: %w", filepath.Base(path), err)
	}
	temporary := path + ".tmp"
	file, err := os.OpenFile(temporary, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("gravar %s: %w", filepath.Base(path), err)
	}
	if _, err := file.Write(raw); err != nil {
		_ = file.Close()
		_ = os.Remove(temporary)
		return fmt.Errorf("gravar %s: %w", filepath.Base(path), err)
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		_ = os.Remove(temporary)
		return fmt.Errorf("sincronizar %s: %w", filepath.Base(path), err)
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	// No Windows o rename sobre arquivo existente falha em alguns sistemas de
	// arquivo; os.Rename já usa MoveFileEx com REPLACE_EXISTING, então serve.
	return os.Rename(temporary, path)
}

func readJSON(path string, dst any) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(raw, dst); err != nil {
		return fmt.Errorf("ler %s: %w", filepath.Base(path), err)
	}
	return nil
}
