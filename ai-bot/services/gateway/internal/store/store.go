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
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"aibot/gateway/internal/protocol"
)

// MaxEventBatch é o teto de envelopes devolvidos por leitura. Igual ao teto do
// cliente de propósito: quando os dois divergem, o lado menor pagina para
// sempre pedindo o mesmo pedaço e o replay nunca termina.
const MaxEventBatch = 500

// maxLineSize é o teto de uma linha do log. Uma mensagem inteira cabe numa
// linha, e resposta de modelo passa fácil dos 64 KiB do buffer padrão do
// Scanner — sem isto, `bufio.ErrTooLong` cortaria o replay no primeiro turno
// longo.
const maxLineSize = 8 * 1024 * 1024

// metaFlushDelay é a janela do debounce do cabeçalho.
//
// O cabeçalho é CACHE: a fonte é o log, e `lastSeqOnDisk` sabe reconstruir o
// que importa a partir dele. Gravá-lo a cada envelope custava um fsync e um
// rename por linha — mais caro que gravar a própria linha. Com a janela, uma
// rajada de streaming paga UMA gravação em vez de uma por token, e o que se
// arrisca numa queda é o cabeçalho ficar até 200 ms atrás (título, contagem de
// turnos), nunca o conteúdo da conversa.
const metaFlushDelay = 200 * time.Millisecond

// indexStride é de quantos em quantos envelopes o log ganha um marco de
// deslocamento. Guardar TODOS custaria memória proporcional ao log para
// economizar uma varredura de no máximo 64 linhas — índice cheio não paga.
const indexStride = 64

// tailProbe é quanto se lê do FIM do log para achar a última linha.
const tailProbe = 64 * 1024

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
	// BotID é o DONO da conversa: o especialista com quem se fala aqui.
	//
	// Diferente de `Specialist`, que é "quem atendeu por último" e muda a cada
	// turno. Uma conversa de bot tem dono fixo — é a conversa DELE —, e é isso
	// que permite abrir o Código e continuar falando com o Código.
	BotID string `json:"botId,omitempty"`
	// ParentID é a conversa que deu origem a esta.
	//
	// Quando o dono da conversa delega para outro especialista, o trabalho do
	// delegado ganha conversa própria pendurada aqui: na barra lateral ela
	// aparece aninhada sob a conversa que a criou, e clicar nela leva a pessoa a
	// falar direto com aquele bot, sem passar pelo dono.
	ParentID string `json:"parentId,omitempty"`
	// LastGoal é o ÚLTIMO pedido feito ao bot desta conversa (só conversa de
	// bot o tem). É o subtítulo da linha na barra: o título diz de QUEM a
	// conversa é, e este diz O QUE ele está fazendo — sem ele, duas filhas do
	// mesmo bot em conversas diferentes são linhas idênticas. Mora no meta, e
	// não numa leitura do log no handshake: abrir o log de até cinquenta
	// conversas para montar o `ready` pesaria o primeiro quadro em nome de um
	// subtítulo.
	LastGoal string `json:"lastGoal,omitempty"`
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
	mu       sync.Mutex
	meta     SessionMeta
	file     *os.File
	path     string
	metaPath string

	// metaDirty diz que o cabeçalho em memória está à frente do disco, e
	// metaTimer é a gravação já agendada (nil = nenhuma). Ver metaFlushDelay.
	metaDirty bool
	metaTimer *time.Timer
	// retired impede que uma gravação agendada ressuscite o cabeçalho depois do
	// Close ou do DeleteSession.
	retired bool

	// index é o mapa esparso "seq -> byte em que a linha começa", em ordem
	// crescente de seq. Sem ele, `Since` varre do começo em toda página e o
	// replay, que pagina de 500 em 500, fica quadrático no tamanho do log.
	index []logOffset
}

// logOffset marca em que byte do log começa a linha do envelope `seq`.
type logOffset struct {
	seq    uint64
	offset int64
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
	// Quem responde "esse pid ainda roda?" depende do sistema, e a resposta
	// errada tem dois preços opostos: dizer VIVO para um pid morto trava a pasta
	// para sempre (foi o que aconteceu no Windows, ver lock_windows.go); dizer
	// MORTO para um pid vivo faz dois donos numerarem `seq` sobre a mesma
	// sessão, que é a corrupção que esta trava existe para impedir.
	return !processAlive(pid)
}

/* --------------------------- cabeçalho pendente -------------------------- */
//
// Os métodos abaixo mexem no cabeçalho e no agendamento do debounce. Todos
// exigem handle.mu segurado e NENHUM toca em Store.mu: quem grava segura
// handle.mu e o Close segura Store.mu antes de handle.mu — pegar Store.mu aqui
// fecharia o ciclo e travaria o app inteiro no meio de uma resposta.

// touchMeta anota que o cabeçalho mudou e agenda a gravação.
func (h *sessionHandle) touchMeta() {
	h.metaDirty = true
	if h.retired || h.metaTimer != nil {
		return
	}
	h.metaTimer = time.AfterFunc(metaFlushDelay, h.flushMetaAsync)
}

// flushMetaAsync é o disparo do agendamento.
func (h *sessionHandle) flushMetaAsync() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.metaTimer = nil
	if h.retired || !h.metaDirty {
		return
	}
	// Erro aqui é ignorado como já era no Append: perder o cabeçalho não perde
	// a conversa, porque o log é a fonte e a reabertura o reconstrói.
	_ = h.writeMeta()
}

// writeMeta grava o cabeçalho na hora e cancela o pendente.
func (h *sessionHandle) writeMeta() error {
	if err := writeJSONAtomic(h.metaPath, h.meta); err != nil {
		return err
	}
	h.metaDirty = false
	return nil
}

// retire descarrega o pendente (se `flush`), desarma o agendamento e fecha o
// arquivo. É o que garante que a barra lateral não abra desatualizada depois de
// fechar o app.
func (h *sessionHandle) retire(flush bool) {
	if h.metaTimer != nil {
		h.metaTimer.Stop()
		h.metaTimer = nil
	}
	if flush && h.metaDirty {
		_ = h.writeMeta()
	}
	h.metaDirty = false
	h.retired = true
	if h.file != nil {
		_ = h.file.Sync()
		_ = h.file.Close()
		h.file = nil
	}
}

// Close solta a trava.
func (s *Store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, handle := range s.sessions {
		handle.mu.Lock()
		handle.retire(true)
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

	// Edição do usuário (renomear, arquivar) vai ao disco na hora: é rara e é o
	// tipo de mudança que a pessoa espera ver de volta se o app cair em seguida.
	if err := handle.writeMeta(); err != nil {
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
	return handle.writeMeta()
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
	// Sessões abertas mandam sobre o disco: a gravação do cabeçalho é debounced
	// (ver metaFlushDelay), então o meta.json de uma conversa EM ANDAMENTO pode
	// estar alguns milissegundos atrás. Quem está com o arquivo aberto é o
	// escritor, e é ele que sabe o número e o horário corretos — sem esta
	// sobreposição, a barra lateral pisca a conversa ativa fora de ordem.
	s.mu.Lock()
	live := make(map[string]*sessionHandle, len(s.sessions))
	for id, handle := range s.sessions {
		live[id] = handle
	}
	s.mu.Unlock()

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
		if handle, ok := live[meta.ID]; ok {
			handle.mu.Lock()
			meta = handle.meta
			handle.mu.Unlock()
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
		// Sem flush: o diretório vai embora logo abaixo, e uma gravação
		// agendada que escapasse recriaria o cabeçalho de uma sessão apagada.
		handle.retire(false)
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

	now := time.Now().UTC()
	handle.meta.LastSeq++
	envelope.Seq = handle.meta.LastSeq
	envelope.Session = sessionID
	envelope.V = protocol.Version
	if envelope.TS.IsZero() {
		envelope.TS = now
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

	// Marco de deslocamento para o índice de leitura: o envelope seguinte começa
	// onde este terminou. A posição é PERGUNTADA ao descritor em vez de somada a
	// partir do tamanho da linha — soma erraria se o arquivo crescesse por fora,
	// e um marco errado é replay entregando o envelope errado. Custa uma chamada
	// a cada indexStride envelopes.
	if next := envelope.Seq + 1; next%indexStride == 0 {
		if end, seekErr := handle.file.Seek(0, io.SeekCurrent); seekErr == nil {
			handle.noteOffset(next, end)
		}
	}

	handle.meta.UpdatedAt = now
	if envelope.Kind == protocol.KindDone {
		handle.meta.Turns++
	}
	if envelope.From.Specialist != "" {
		handle.meta.Specialist = envelope.From.Specialist
	}
	// Cabeçalho é cache do log: vai ao disco em janela (ver metaFlushDelay), não
	// a cada envelope.
	handle.touchMeta()

	return envelope.Seq, nil
}

// noteOffset acrescenta um marco ao índice. Exige handle.mu segurado.
//
// Só aceita marcos em ordem crescente. Assim a fatia fica sempre ordenada — o
// que a busca binária de `startFrom` exige — mesmo com duas leituras
// concorrentes semeando o índice ao mesmo tempo.
func (h *sessionHandle) noteOffset(seq uint64, offset int64) {
	if len(h.index) > 0 && seq <= h.index[len(h.index)-1].seq {
		return
	}
	h.index = append(h.index, logOffset{seq: seq, offset: offset})
}

// startFrom devolve de que byte começar a leitura para achar o primeiro
// envelope com seq > fromSeq, e qual seq deve estar exatamente ali. Exige
// handle.mu segurado.
//
// Devolve (0, 0) quando não há marco útil: leitura do começo, sem promessa.
func (h *sessionHandle) startFrom(fromSeq uint64) (offset int64, expect uint64) {
	target := fromSeq + 1
	position := sort.Search(len(h.index), func(i int) bool { return h.index[i].seq > target })
	if position == 0 {
		return 0, 0
	}
	mark := h.index[position-1]
	return mark.offset, mark.seq
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

	// Não há Sync antes de ler, e não é esquecimento: `os.File.Write` não tem
	// buffer em espaço de usuário, então a linha já está visível para qualquer
	// descritor assim que o write volta — o cache do sistema de arquivos é o
	// mesmo para os dois lados. Sync empurra para o DISPOSITIVO, que é o que a
	// durabilidade quer e a visibilidade não; fazê-lo aqui punia cada página do
	// replay com um fsync.
	handle.mu.Lock()
	path := handle.path
	lastSeq := handle.meta.LastSeq
	offset, expect := handle.startFrom(fromSeq)
	handle.mu.Unlock()

	// Nada novo depois do cursor. O replay pagina até receber lote vazio, então
	// TODA reconexão termina exatamente aqui — sem esta saída, a última chamada
	// varre o log inteiro para devolver nada.
	if lastSeq <= fromSeq {
		return nil, nil
	}
	capacity := limit
	if pending := lastSeq - fromSeq; pending < uint64(limit) {
		capacity = int(pending)
	}

	file, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("abrir log da sessão: %w", err)
	}
	defer file.Close()

	out, marks, trusted, err := scanLog(file, offset, expect, fromSeq, limit, capacity)
	if err != nil {
		return out, err
	}
	if !trusted {
		// O marco não cumpriu a promessa (log mexido por fora, por exemplo).
		// Reler do começo é lento e correto — melhor que devolver um pedaço do
		// meio da conversa como se fosse o começo dela.
		if out, marks, _, err = scanLog(file, 0, 0, fromSeq, limit, capacity); err != nil {
			return out, err
		}
	}
	if len(marks) > 0 {
		handle.mu.Lock()
		for _, mark := range marks {
			handle.noteOffset(mark.seq, mark.offset)
		}
		handle.mu.Unlock()
	}
	return out, nil
}

// scanLog lê o log a partir de `offset` e recolhe até `limit` envelopes com
// seq > fromSeq, devolvendo também os marcos de deslocamento que encontrou pelo
// caminho — é assim que o índice se enche na primeira leitura.
//
// `expect` é o seq que o índice promete encontrar em `offset` (0 = leitura do
// começo, sem promessa). Promessa quebrada devolve `trusted = false` em vez de
// erro: um marco furado degrada para varredura completa, nunca para replay com
// o envelope errado.
func scanLog(file *os.File, offset int64, expect, fromSeq uint64, limit, capacity int) (out []protocol.Envelope, marks []logOffset, trusted bool, err error) {
	if _, err := file.Seek(offset, io.SeekStart); err != nil {
		return nil, nil, false, fmt.Errorf("posicionar no log da sessão: %w", err)
	}

	out = make([]protocol.Envelope, 0, capacity)
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), maxLineSize)

	position := offset
	first := true
	// Antes do cursor basta o NÚMERO da linha; depois dele, o envelope inteiro.
	// Sondar as duas coisas em toda linha faria a leitura do começo pagar dois
	// json por envelope devolvido — foi medido, e ficou mais lento que a versão
	// que este código substitui.
	skipping := true
	for scanner.Scan() {
		line := scanner.Bytes()
		start := position
		// O escritor grava exatamente uma quebra por linha e nunca '\r', então o
		// começo da próxima linha é o tamanho desta mais um. Se o arquivo for
		// mexido por fora e a conta furar, o marco aponta para o lugar errado —
		// e é por isso que quem USA um marco confere o seq que achou nele.
		position += int64(len(line)) + 1

		var seq uint64
		if skipping {
			valid := false
			seq, valid = seqOfLine(line)
			if first {
				first = false
				if expect != 0 && (!valid || seq != expect) {
					return nil, nil, false, nil
				}
			}
			if !valid {
				// Linha truncada por queda de energia no meio da escrita: pular
				// é o certo. O log é append-only, então só a ÚLTIMA linha pode
				// estar partida — abortar aqui perderia todo o histórico
				// anterior a ela.
				continue
			}
			if seq > fromSeq {
				skipping = false
			}
		}

		if !skipping {
			var envelope protocol.Envelope
			if err := json.Unmarshal(line, &envelope); err != nil {
				continue
			}
			seq = envelope.Seq
			if seq > fromSeq {
				out = append(out, envelope)
			}
		}

		if seq != 0 && seq%indexStride == 0 {
			marks = append(marks, logOffset{seq: seq, offset: start})
		}
		if len(out) >= limit {
			break
		}
	}
	if err := scanner.Err(); err != nil && !errors.Is(err, io.EOF) {
		return out, marks, true, fmt.Errorf("ler log da sessão: %w", err)
	}
	return out, marks, true, nil
}

// seqOfLine tira só o número da linha, sem desserializar o resto. `false` para
// linha vazia, partida ou sem número.
func seqOfLine(line []byte) (uint64, bool) {
	if len(line) == 0 {
		return 0, false
	}
	var head struct {
		Seq uint64 `json:"seq"`
	}
	if err := json.Unmarshal(line, &head); err != nil || head.Seq == 0 {
		return 0, false
	}
	return head.Seq, true
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
	handle := &sessionHandle{
		meta:     meta,
		path:     logPath,
		metaPath: filepath.Join(directory, "meta.json"),
	}
	s.sessions[id] = handle
	return handle, nil
}

// lastSeqOnDisk devolve o último seq gravado, lendo o FIM do log.
//
// O `seq` é monotônico por construção — o único escritor é o `Append`, com o
// mutex da sessão segurado e o arquivo em O_APPEND —, então a última linha
// COMPLETA carrega o maior número. Varrer do começo para descobrir isso custava
// um json por linha na abertura de cada sessão, ou seja, a subida do app ficava
// proporcional ao tamanho do histórico.
func lastSeqOnDisk(path string) (uint64, error) {
	file, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil {
		return 0, err
	}
	size := info.Size()
	if size == 0 {
		return 0, nil
	}

	// Blocos cada vez maiores a partir do fim: um bloco fixo não serve porque a
	// última linha pode ser uma resposta de modelo de dezenas de KB e porque a
	// linha final pode estar partida por queda de energia — aí a resposta está
	// na penúltima.
	for probe := int64(tailProbe); ; probe *= 2 {
		fromStart := probe >= size
		if fromStart {
			probe = size
		}
		buffer := make([]byte, probe)
		if _, err := file.ReadAt(buffer, size-probe); err != nil && !errors.Is(err, io.EOF) {
			return 0, err
		}
		if seq, ok := lastSeqInChunk(buffer, fromStart); ok {
			return seq, nil
		}
		if fromStart || probe >= maxLineSize {
			// Ou o log inteiro foi lido sem uma linha legível, ou a última linha
			// passa do teto que este pacote sabe ler de qualquer jeito
			// (maxLineSize). Desistir aqui é o que impede um log estranho de
			// puxar centenas de MB para a memória só para responder um número.
			return 0, nil
		}
	}
}

// lastSeqInChunk procura, de trás para frente, a última linha completa do
// pedaço. `fromStart` diz se o pedaço começa no início do arquivo — quando não
// começa, a primeira linha dele pode ter sido cortada pela leitura e não vale.
func lastSeqInChunk(chunk []byte, fromStart bool) (uint64, bool) {
	// O que vier depois da última quebra é linha sem terminador: escrita
	// interrompida no meio, que o log tolera de propósito.
	if cut := bytes.LastIndexByte(chunk, '\n'); cut >= 0 {
		chunk = chunk[:cut]
	} else if !fromStart {
		return 0, false
	}

	for len(chunk) > 0 {
		start := bytes.LastIndexByte(chunk, '\n') + 1
		if start == 0 && !fromStart {
			return 0, false
		}
		if seq, ok := seqOfLine(chunk[start:]); ok {
			return seq, true
		}
		if start == 0 {
			return 0, false
		}
		chunk = chunk[:start-1]
	}
	return 0, false
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
