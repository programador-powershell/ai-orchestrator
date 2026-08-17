// Package transport expõe o gateway.
//
// O protocolo é UM só (o Canonical Agent Protocol); aqui só há serialização. É
// por isso que o WebSocket, o SSE, o REST, o ACP e o MCP não têm regra própria:
// quem decide o que é legítimo é o supervisor, e um transporte que decidisse
// sozinho seria um caminho por onde a política não passa — que foi exatamente o
// que aconteceu no app anterior, onde a aprovação valia na UI e não valia no
// caminho MCP.
package transport

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"aibot/gateway/internal/config"
	"aibot/gateway/internal/eventbus"
	"aibot/gateway/internal/modelrouter"
	"aibot/gateway/internal/permissions"
	"aibot/gateway/internal/protocol"
	"aibot/gateway/internal/sandbox"
	"aibot/gateway/internal/specialist"
	"aibot/gateway/internal/store"
	"aibot/gateway/internal/supervisor"
)

// hostToolTimeout é quanto o gateway espera o aplicativo nativo executar uma
// ferramenta de máquina. Generoso porque um `cargo build` demora — mas finito,
// porque um host que morreu no meio deixaria o turno pendurado para sempre.
const hostToolTimeout = 15 * time.Minute

// Server é a fachada HTTP.
type Server struct {
	cfg    config.Config
	store  *store.Store
	bus    *eventbus.Bus
	sup    *supervisor.Supervisor
	models *modelrouter.Router
	gate   *permissions.Gate
	// environments guarda ONDE o próximo comando de cada sessão roda. Fica no
	// servidor porque duas coisas dependem dele e não podem divergir: o `ready`,
	// que a tela usa para nascer sabendo onde está, e a rota de troca.
	environments *sandbox.Registry
	// vault e catalogPath servem às rotas de catálogo (catalog.go): a chave do
	// provedor vai para o cofre e o catalog.json guarda só a referência.
	vault       CatalogVault
	catalogPath string
	log         *slog.Logger

	mu        sync.Mutex
	hostCalls map[string]chan hostResult
	counter   uint64

	// catalogMu serializa o ler-alterar-regravar do catalog.json. É trava
	// própria (e não `mu`) porque o arquivo pode demorar num disco lento, e
	// segurar a trava dos hostCalls nesse meio tempo pararia as ferramentas.
	catalogMu sync.Mutex
}

type hostResult struct {
	output string
	err    string
}

// NewServer monta a fachada.
//
// vault e catalogPath alimentam as rotas de catálogo. Podem vir vazios (nil e
// ""): o gateway continua inteiro e essas rotas recusam com o motivo, em vez
// de o processo não subir por causa de uma tela de configuração.
func NewServer(
	cfg config.Config,
	durable *store.Store,
	bus *eventbus.Bus,
	sup *supervisor.Supervisor,
	models *modelrouter.Router,
	gate *permissions.Gate,
	environments *sandbox.Registry,
	vault CatalogVault,
	catalogPath string,
	log *slog.Logger,
) *Server {
	return &Server{
		cfg:          cfg,
		store:        durable,
		bus:          bus,
		sup:          sup,
		models:       models,
		gate:         gate,
		environments: environments,
		vault:        vault,
		catalogPath:  catalogPath,
		log:          log,
		hostCalls:    make(map[string]chan hostResult),
	}
}

// Handler monta as rotas.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	// Sem autenticação: diz se o processo está de pé, e nada mais.
	mux.HandleFunc("GET /health", s.health)

	mux.Handle("GET /v1/specialists", s.auth(s.listSpecialists))
	mux.Handle("GET /v1/models", s.auth(s.listModels))

	// A administração do catálogo (catalog.go). Autenticada como tudo: quem
	// cadastra provedor decide para ONDE as conversas da estação viajam.
	mux.Handle("GET /v1/catalog", s.auth(s.getCatalog))
	mux.Handle("POST /v1/catalog/providers", s.auth(s.postCatalogProvider))
	mux.Handle("PATCH /v1/catalog/providers/{id}", s.auth(s.patchCatalogProvider))
	mux.Handle("DELETE /v1/catalog/providers/{id}", s.auth(s.deleteCatalogProvider))
	mux.Handle("POST /v1/catalog/models", s.auth(s.postCatalogModel))
	mux.Handle("DELETE /v1/catalog/models/{id}", s.auth(s.deleteCatalogModel))
	mux.Handle("POST /v1/catalog/test/{id}", s.auth(s.testCatalogProvider))

	mux.Handle("GET /v1/sessions", s.auth(s.listSessions))
	mux.Handle("POST /v1/sessions", s.auth(s.createSession))
	mux.Handle("GET /v1/sessions/{id}", s.auth(s.getSession))
	mux.Handle("DELETE /v1/sessions/{id}", s.auth(s.deleteSession))
	mux.Handle("GET /v1/sessions/{id}/events", s.auth(s.sessionEvents))
	mux.Handle("POST /v1/sessions/{id}/prompt", s.auth(s.postPrompt))
	mux.Handle("POST /v1/sessions/{id}/cancel", s.auth(s.postCancel))
	mux.Handle("POST /v1/sessions/{id}/environment", s.auth(s.postEnvironment))
	// Ramifica a conversa: copia o prefixo do log para uma sessão nova (fork.go).
	mux.Handle("POST /v1/sessions/{id}/fork", s.auth(s.postFork))
	mux.Handle("GET /v1/sessions/{id}/sse", s.auth(s.sessionSSE))

	mux.Handle("POST /v1/approvals", s.auth(s.postApproval))
	mux.Handle("POST /v1/gates", s.auth(s.postGate))

	// O aplicativo nativo devolve por aqui o resultado das ferramentas de máquina.
	mux.Handle("POST /v1/host/tool-result", s.auth(s.postHostResult))

	mux.HandleFunc("GET /v1/stream", s.stream)

	return s.cors(mux)
}

/* ------------------------------ middleware ------------------------------ */

// auth exige o token do gateway.
//
// O gateway escuta em loopback e executa ferramenta. Sem token, QUALQUER
// processo da estação — inclusive uma página aberta no navegador — manda o
// AI-BOT rodar comando. "É só localhost" não é fronteira de segurança numa
// máquina com navegador.
func (s *Server) auth(next func(http.ResponseWriter, *http.Request)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.tokenOK(r.Header.Get("Authorization")) {
			s.fail(w, http.StatusUnauthorized, "unauthorized", "token ausente ou inválido")
			return
		}
		next(w, r)
	})
}

func (s *Server) tokenOK(header string) bool {
	value, found := strings.CutPrefix(header, "Bearer ")
	if !found {
		return false
	}
	return constantTimeEqual(strings.TrimSpace(value), s.cfg.Token)
}

// constantTimeEqual compara sem vazar o tamanho por tempo. Não é paranoia
// gratuita: o token é o que separa "meu app" de "qualquer página do navegador".
func constantTimeEqual(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	var diff byte
	for index := 0; index < len(a); index++ {
		diff |= a[index] ^ b[index]
	}
	return diff == 0
}

// cors libera só as origens configuradas.
func (s *Server) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && originAllowed(origin, s.cfg.AllowOrigins) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Headers", "authorization, content-type, accept")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func originAllowed(origin string, allowed []string) bool {
	for _, candidate := range allowed {
		if strings.EqualFold(strings.TrimRight(candidate, "/"), strings.TrimRight(origin, "/")) {
			return true
		}
	}
	return false
}

/* -------------------------------- rotas --------------------------------- */

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	s.ok(w, map[string]any{
		"status":      "ok",
		"product":     "AI-BOT",
		"protocol":    protocol.Version,
		"specialists": len(specialist.All()),
		"models":      len(s.models.Catalog()),
	})
}

func (s *Server) listSpecialists(w http.ResponseWriter, _ *http.Request) {
	// O master vai junto, ao FIM: o cliente precisa do avatar e do rótulo dele
	// para desenhar o botão da barra lateral e o estado antes da primeira rota.
	catalog := specialist.All()
	s.ok(w, append(catalog, specialist.Master))
}

func (s *Server) listModels(w http.ResponseWriter, _ *http.Request) {
	s.ok(w, s.models.Catalog())
}

// specialistIDs deixa o handshake do WebSocket (stream.go) montar o `ready` sem
// importar o pacote de especialistas em mais um arquivo.
func specialistIDs() []string { return specialist.IDs() }

func (s *Server) listSessions(w http.ResponseWriter, _ *http.Request) {
	sessions, err := s.store.ListSessions()
	if err != nil {
		s.fail(w, http.StatusInternalServerError, "store", err.Error())
		return
	}
	if sessions == nil {
		sessions = []store.SessionMeta{}
	}
	s.ok(w, sessions)
}

func (s *Server) createSession(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Title string `json:"title"`
		CWD   string `json:"cwd"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)

	meta, err := s.store.CreateSession(store.SessionMeta{
		ID:    s.newID("s"),
		Title: body.Title,
		CWD:   body.CWD,
	})
	if err != nil {
		s.fail(w, http.StatusInternalServerError, "store", err.Error())
		return
	}
	// O cabeçalho vem ANTES do WriteHeader: depois dele, Header().Set é ignorado
	// em silêncio e o Go passa a adivinhar o tipo pelo corpo — um JSON sai como
	// text/plain e o cliente que confia no Content-Type recusa a resposta.
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusCreated)
	s.ok(w, meta)
}

func (s *Server) getSession(w http.ResponseWriter, r *http.Request) {
	meta, err := s.store.GetSession(r.PathValue("id"))
	if err != nil {
		s.storeError(w, err)
		return
	}
	s.ok(w, meta)
}

func (s *Server) deleteSession(w http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("id")
	if err := s.store.DeleteSession(sessionID); err != nil {
		s.storeError(w, err)
		return
	}
	// O ambiente ativo mora em memória, indexado por sessão. Sem esta linha o
	// mapa cresceria para sempre com id de conversa apagada.
	if s.environments != nil {
		s.environments.Forget(sessionID)
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) sessionEvents(w http.ResponseWriter, r *http.Request) {
	from, _ := strconv.ParseUint(r.URL.Query().Get("from"), 10, 64)
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	events, err := s.store.Since(r.PathValue("id"), from, limit)
	if err != nil {
		s.storeError(w, err)
		return
	}
	if events == nil {
		events = []protocol.Envelope{}
	}
	s.ok(w, events)
}

func (s *Server) postPrompt(w http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("id")
	var prompt protocol.Prompt
	if err := json.NewDecoder(r.Body).Decode(&prompt); err != nil {
		s.fail(w, http.StatusBadRequest, "bad_request", "corpo inválido: "+err.Error())
		return
	}
	if _, err := s.store.GetSession(sessionID); err != nil {
		s.storeError(w, err)
		return
	}

	// O turno roda em segundo plano e o progresso sai pelo barramento. Segurar a
	// resposta HTTP até o fim faria o cliente esperar minutos por um 200 que não
	// carrega informação nenhuma — o texto já foi entregue pelo WebSocket.
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
		defer cancel()
		if err := s.sup.Prompt(ctx, sessionID, prompt); err != nil {
			s.log.Error("turno falhou", "sessao", sessionID, "erro", err)
			s.sup.ReportTurnFailure(sessionID, err)
		}
	}()

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusAccepted)
	s.ok(w, map[string]string{"status": "aceito"})
}

func (s *Server) postCancel(w http.ResponseWriter, r *http.Request) {
	s.sup.Cancel(r.PathValue("id"))
	s.ok(w, map[string]string{"status": "cancelado"})
}

// postEnvironment troca ONDE o próximo comando da sessão roda.
//
// A ordem aqui é a regra: confere a sessão, confere que o ambiente EXISTE,
// confere que ele está DISPONÍVEL agora, e só então grava e publica. Aceitar um
// ambiente indisponível e falhar depois, na hora do comando, jogaria o erro
// para o meio de um turno — a pessoa descobriria que o Docker não está
// instalado como uma ferramenta que falhou, e não como uma opção que não podia
// ser escolhida.
func (s *Server) postEnvironment(w http.ResponseWriter, r *http.Request) {
	if s.environments == nil {
		s.fail(w, http.StatusServiceUnavailable, "sem_ambientes", "este gateway não tem ambientes de execução")
		return
	}
	sessionID := r.PathValue("id")

	var body struct {
		Environment protocol.Environment `json:"environment"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		s.fail(w, http.StatusBadRequest, "bad_request", "corpo inválido: "+err.Error())
		return
	}
	if _, err := s.store.GetSession(sessionID); err != nil {
		s.storeError(w, err)
		return
	}
	if _, known := s.environments.Runner(body.Environment); !known {
		s.fail(w, http.StatusBadRequest, "ambiente_desconhecido",
			fmt.Sprintf("ambiente %q não existe neste gateway", body.Environment))
		return
	}
	if available, detail := s.environments.Availability(r.Context(), body.Environment); !available {
		// 409 e não 400: o pedido está correto, a máquina é que não tem o
		// ambiente agora. O `detail` é a frase acionável que a tela mostra.
		s.fail(w, http.StatusConflict, "ambiente_indisponivel", detail)
		return
	}
	if err := s.environments.Set(sessionID, body.Environment); err != nil {
		s.fail(w, http.StatusBadRequest, "ambiente_invalido", err.Error())
		return
	}

	// O `state` sai para TODAS as janelas da sessão. Sem isto, uma segunda
	// janela continuaria mostrando o ambiente anterior e a pessoa mandaria o
	// comando achando que ele roda em outro lugar.
	envelope := protocol.Envelope{
		V:       protocol.Version,
		ID:      s.newID("st"),
		TS:      time.Now().UTC(),
		Session: sessionID,
		Kind:    protocol.KindState,
		From:    protocol.Actor{Kind: protocol.ActorSystem},
	}
	if err := envelope.SetPayload(protocol.State{
		Environment: body.Environment,
		Busy:        s.sup.Busy(sessionID),
	}); err != nil {
		s.fail(w, http.StatusInternalServerError, "state", err.Error())
		return
	}
	// Efêmero porque `state` não é histórico: o log guarda o que aconteceu na
	// conversa, e o replay de um `state` de ontem reencenaria uma troca de
	// ambiente que já não vale. Quem reconecta lê o ambiente do `ready`.
	s.bus.PublishEphemeral(sessionID, envelope)

	s.ok(w, map[string]string{"environment": string(body.Environment)})
}

func (s *Server) postApproval(w http.ResponseWriter, r *http.Request) {
	var decision protocol.ApprovalDecision
	if err := json.NewDecoder(r.Body).Decode(&decision); err != nil {
		s.fail(w, http.StatusBadRequest, "bad_request", "corpo inválido: "+err.Error())
		return
	}
	if err := s.sup.Decide(decision); err != nil {
		s.fail(w, http.StatusConflict, "sem_pendencia", err.Error())
		return
	}
	s.ok(w, map[string]string{"status": "registrado"})
}

func (s *Server) postGate(w http.ResponseWriter, r *http.Request) {
	var gate protocol.Gate
	if err := json.NewDecoder(r.Body).Decode(&gate); err != nil {
		s.fail(w, http.StatusBadRequest, "bad_request", "corpo inválido: "+err.Error())
		return
	}
	// Mesmo caminho que a ferramenta `task.gate` do modelo usa: a decisão da
	// pessoa e a do orquestrador entram pela mesma porta, senão as duas
	// divergem e a onda seguinte roda com o veredito errado.
	if err := s.sup.DecideGate(gate); err != nil {
		s.fail(w, http.StatusConflict, "sem_portao", err.Error())
		return
	}
	s.ok(w, map[string]string{"status": string(gate.Decision)})
}

/* ---------------------------- ponte com o host --------------------------- */

// Call implementa supervisor.HostBridge: despacha a ferramenta ao aplicativo
// nativo e espera o resultado.
func (s *Server) Call(ctx context.Context, sessionID, tool string, args json.RawMessage) (string, error) {
	if s.bus.Listeners(sessionID) == 0 {
		return "", fmt.Errorf("a ferramenta %s roda na máquina e o aplicativo não está conectado", tool)
	}

	callID := s.newID("h")
	channel := make(chan hostResult, 1)
	s.mu.Lock()
	s.hostCalls[callID] = channel
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.hostCalls, callID)
		s.mu.Unlock()
	}()

	envelope := protocol.Envelope{
		V:       protocol.Version,
		ID:      callID,
		TS:      time.Now().UTC(),
		Session: sessionID,
		Kind:    protocol.KindToolCall,
		From:    protocol.Actor{Kind: protocol.ActorSupervisor},
		To:      &protocol.Actor{Kind: protocol.ActorSystem, ID: "host"},
	}
	if err := envelope.SetPayload(protocol.ToolCall{CallID: callID, Tool: tool, Args: args}); err != nil {
		return "", err
	}
	// Efêmero: o pedido ao host não pertence ao histórico da conversa — o que
	// pertence é o `tool.call` que o supervisor já gravou, com o mesmo conteúdo.
	s.bus.PublishEphemeral(sessionID, envelope)

	timer := time.NewTimer(hostToolTimeout)
	defer timer.Stop()

	select {
	case result := <-channel:
		if result.err != "" {
			return "", errors.New(result.err)
		}
		return result.output, nil
	case <-timer.C:
		return "", fmt.Errorf("o aplicativo não respondeu a %s em %s", tool, hostToolTimeout)
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

func (s *Server) postHostResult(w http.ResponseWriter, r *http.Request) {
	var result protocol.ToolResult
	if err := json.NewDecoder(r.Body).Decode(&result); err != nil {
		s.fail(w, http.StatusBadRequest, "bad_request", "corpo inválido: "+err.Error())
		return
	}
	s.mu.Lock()
	channel := s.hostCalls[result.CallID]
	s.mu.Unlock()
	if channel == nil {
		s.fail(w, http.StatusConflict, "sem_pendencia", "nenhuma chamada pendente com esse id")
		return
	}
	failure := result.Error
	if !result.OK && failure == "" {
		failure = "a ferramenta falhou sem detalhe"
	}
	select {
	case channel <- hostResult{output: result.Output, err: failure}:
	default:
	}
	s.ok(w, map[string]string{"status": "registrado"})
}

/* ------------------------------- streaming ------------------------------- */

// sessionSSE é a alternativa ao WebSocket para clientes que só falam HTTP —
// o `aibot watch` do terminal e qualquer integração de CI.
func (s *Server) sessionSSE(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		s.fail(w, http.StatusInternalServerError, "sse", "o servidor não suporta streaming")
		return
	}
	sessionID := r.PathValue("id")
	from, _ := strconv.ParseUint(r.URL.Query().Get("from"), 10, 64)

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)

	// Assina ANTES do replay: assinar depois abre uma janela em que um evento
	// nasce entre a última linha lida do log e a assinatura, e some para sempre.
	subscription := s.bus.Subscribe(sessionID)
	defer subscription.Close()

	if history, err := s.store.Since(sessionID, from, store.MaxEventBatch); err == nil {
		for _, envelope := range history {
			writeSSE(w, envelope)
			from = envelope.Seq
		}
		flusher.Flush()
	}

	heartbeat := time.NewTicker(20 * time.Second)
	defer heartbeat.Stop()

	for {
		select {
		case envelope, open := <-subscription.Events:
			if !open {
				return
			}
			if envelope.Seq != 0 && envelope.Seq <= from {
				continue // já entregue no replay
			}
			if envelope.Seq != 0 {
				from = envelope.Seq
			}
			writeSSE(w, envelope)
			flusher.Flush()
		case <-heartbeat.C:
			// Comentário SSE: mantém o proxy de pé sem inventar evento.
			fmt.Fprint(w, ": ping\n\n")
			flusher.Flush()
		case <-r.Context().Done():
			return
		}
	}
}

func writeSSE(w http.ResponseWriter, envelope protocol.Envelope) {
	raw, err := json.Marshal(envelope)
	if err != nil {
		return
	}
	fmt.Fprintf(w, "event: %s\ndata: %s\n\n", envelope.Kind, raw)
}

/* --------------------------------- apoio --------------------------------- */

func (s *Server) newID(prefix string) string {
	s.mu.Lock()
	s.counter++
	value := s.counter
	s.mu.Unlock()
	return fmt.Sprintf("%s%d%d", prefix, time.Now().UnixNano()/1e6, value)
}

func (s *Server) ok(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	if err := json.NewEncoder(w).Encode(value); err != nil {
		s.log.Error("falha ao escrever resposta", "erro", err)
	}
}

func (s *Server) fail(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]string{"code": code, "message": message},
	})
}

func (s *Server) storeError(w http.ResponseWriter, err error) {
	if errors.Is(err, store.ErrNotFound) {
		s.fail(w, http.StatusNotFound, "not_found", err.Error())
		return
	}
	s.fail(w, http.StatusInternalServerError, "store", err.Error())
}

// O servidor É a ponte com o aplicativo nativo. A asserção falha na compilação
// se a assinatura de HostBridge mudar — que é melhor do que descobrir em
// execução que a ferramenta de máquina parou de ser despachada.
var _ supervisor.HostBridge = (*Server)(nil)
