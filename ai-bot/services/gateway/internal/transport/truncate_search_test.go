// Testes das rotas de corte (truncate.go) e de busca (search.go).
//
// Como nos vizinhos, o que se prova aqui é o CONTRATO da borda — token, corpo,
// códigos e formato — pela rota inteira (Handler + auth + store de verdade).
// A mecânica do corte e da varredura já é provada nos testes do store.
package transport

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"aibot/gateway/internal/config"
	"aibot/gateway/internal/eventbus"
	"aibot/gateway/internal/fusion"
	"aibot/gateway/internal/modelrouter"
	"aibot/gateway/internal/permissions"
	"aibot/gateway/internal/protocol"
	"aibot/gateway/internal/store"
	"aibot/gateway/internal/supervisor"
)

const sessionsTestToken = "token-de-teste-de-sessoes"

// newSessionsHarness monta a rota inteira E devolve o store, porque estes
// testes precisam semear o log antes de bater na borda.
func newSessionsHarness(t *testing.T) (http.Handler, *store.Store) {
	t.Helper()
	dataStore, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("abrir o store: %v", err)
	}
	t.Cleanup(func() { _ = dataStore.Close() })

	bus := eventbus.New(dataStore)
	models := modelrouter.New(nil, nil)
	sup := supervisor.New(supervisor.Deps{
		Store:  dataStore,
		Bus:    bus,
		Gate:   permissions.NewGate(permissions.DefaultPolicy()),
		Tools:  supervisor.NewRegistry(),
		Models: models,
	})
	server := NewServer(
		config.Config{Token: sessionsTestToken},
		dataStore, bus, sup, models,
		fusion.NewRegistry(),
		permissions.NewGate(permissions.DefaultPolicy()),
		nil, nil, "",
		slog.New(slog.NewTextHandler(io.Discard, nil)),
	)
	return server.Handler(), dataStore
}

func seedTurn(t *testing.T, dataStore *store.Store, session, turn, text string) uint64 {
	t.Helper()
	message := &protocol.Envelope{
		Kind: protocol.KindMessage,
		Turn: turn,
		From: protocol.Actor{Kind: protocol.ActorUser},
	}
	_ = message.SetPayload(protocol.Message{Role: "user", Text: text})
	seq, err := dataStore.Append(session, message)
	if err != nil {
		t.Fatalf("Append: %v", err)
	}
	done := &protocol.Envelope{
		Kind: protocol.KindDone,
		Turn: turn,
		From: protocol.Actor{Kind: protocol.ActorSupervisor},
	}
	_ = done.SetPayload(protocol.Done{Turn: turn})
	if _, err := dataStore.Append(session, done); err != nil {
		t.Fatalf("Append done: %v", err)
	}
	return seq
}

func doJSON(t *testing.T, handler http.Handler, method, path, token string, body string) *httptest.ResponseRecorder {
	t.Helper()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	request := httptest.NewRequest(method, path, reader)
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

/* -------------------------------- truncate ------------------------------- */

func TestTruncateRouteCortaPorTurno(t *testing.T) {
	handler, dataStore := newSessionsHarness(t)
	if _, err := dataStore.CreateSession(store.SessionMeta{ID: "s-corte", Title: "corte"}); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	seedTurn(t, dataStore, "s-corte", "t1", "primeira")
	inicioT2 := seedTurn(t, dataStore, "s-corte", "t2", "segunda")

	recorder := doJSON(t, handler, http.MethodPost, "/v1/sessions/s-corte/truncate",
		sessionsTestToken, `{"turn":"t2"}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("truncate por turno: esperava 200, obteve %d: %s", recorder.Code, recorder.Body.String())
	}
	var parsed struct {
		LastSeq uint64 `json:"lastSeq"`
		Turns   int    `json:"turns"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &parsed); err != nil {
		t.Fatalf("resposta fora do contrato: %v", err)
	}
	if parsed.LastSeq != inicioT2-1 || parsed.Turns != 1 {
		t.Fatalf("corte errado: lastSeq=%d turns=%d (esperava %d e 1)", parsed.LastSeq, parsed.Turns, inicioT2-1)
	}
}

func TestTruncateRouteExigeTokenECorpo(t *testing.T) {
	handler, dataStore := newSessionsHarness(t)
	if _, err := dataStore.CreateSession(store.SessionMeta{ID: "s-corte", Title: "corte"}); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	if code := doJSON(t, handler, http.MethodPost, "/v1/sessions/s-corte/truncate", "", `{"beforeSeq":1}`).Code; code != http.StatusUnauthorized {
		t.Fatalf("sem token: esperava 401, obteve %d", code)
	}
	if code := doJSON(t, handler, http.MethodPost, "/v1/sessions/s-corte/truncate", sessionsTestToken, `{}`).Code; code != http.StatusBadRequest {
		t.Fatalf("sem beforeSeq nem turn: esperava 400, obteve %d", code)
	}
	if code := doJSON(t, handler, http.MethodPost, "/v1/sessions/nao-existe/truncate", sessionsTestToken, `{"beforeSeq":1}`).Code; code != http.StatusNotFound {
		t.Fatalf("sessão inexistente: esperava 404, obteve %d", code)
	}
	if code := doJSON(t, handler, http.MethodPost, "/v1/sessions/s-corte/truncate", sessionsTestToken, `{"turn":"t-fantasma"}`).Code; code != http.StatusNotFound {
		t.Fatalf("turno inexistente: esperava 404, obteve %d", code)
	}
}

/* --------------------------------- search -------------------------------- */

func TestSearchRouteDevolveTrechos(t *testing.T) {
	handler, dataStore := newSessionsHarness(t)
	if _, err := dataStore.CreateSession(store.SessionMeta{ID: "s-busca", Title: "busca"}); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	seedTurn(t, dataStore, "s-busca", "t1", "onde mora o Elefante azul?")

	recorder := doJSON(t, handler, http.MethodGet, "/v1/sessions/search?q=elefante", sessionsTestToken, "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("busca: esperava 200, obteve %d: %s", recorder.Code, recorder.Body.String())
	}
	var parsed struct {
		Results []store.SearchHit `json:"results"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &parsed); err != nil {
		t.Fatalf("resposta fora do contrato: %v", err)
	}
	if len(parsed.Results) != 1 || parsed.Results[0].Session != "s-busca" {
		t.Fatalf("esperava 1 trecho de s-busca, obteve %+v", parsed.Results)
	}
}

func TestSearchRouteExigeTokenEAceitaQueryVazia(t *testing.T) {
	handler, _ := newSessionsHarness(t)

	if code := doJSON(t, handler, http.MethodGet, "/v1/sessions/search?q=x", "", "").Code; code != http.StatusUnauthorized {
		t.Fatalf("sem token: esperava 401, obteve %d", code)
	}

	recorder := doJSON(t, handler, http.MethodGet, "/v1/sessions/search", sessionsTestToken, "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("query vazia: esperava 200 com lista vazia, obteve %d", recorder.Code)
	}
	var parsed struct {
		Results []store.SearchHit `json:"results"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &parsed); err != nil || len(parsed.Results) != 0 {
		t.Fatalf("query vazia: esperava results [], obteve %s (erro: %v)", recorder.Body.String(), err)
	}
}
