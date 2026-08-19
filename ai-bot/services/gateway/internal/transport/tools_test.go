// Testes das rotas da UI fora do turno (tools.go).
//
// Aqui se prova o CONTRATO da borda — token, corpo, códigos e o formato
// {ok, output|error} / {text} — pela rota inteira (Handler + auth + supervisor
// de verdade). A mecânica do funil (aprovação, digest, envelopes) já é provada
// nos testes do supervisor; repeti-la aqui esconderia qual camada garante o quê.
package transport

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"aibot/gateway/internal/config"
	"aibot/gateway/internal/eventbus"
	"aibot/gateway/internal/fusion"
	"aibot/gateway/internal/modelrouter"
	"aibot/gateway/internal/permissions"
	"aibot/gateway/internal/protocol"
	"aibot/gateway/internal/store"
	"aibot/gateway/internal/supervisor"
	"aibot/gateway/internal/workspace"
)

const uiToolsTestToken = "token-de-teste-da-ui"

// newUIToolsHarness monta o caminho REAL da rota: store, bus, portão com a
// política padrão, Toolbox inteiro e o gerente de workspace — o mesmo conjunto
// que o processo de verdade liga. `models` pode vir nil quando o teste não
// toca o autocomplete.
func newUIToolsHarness(t *testing.T, models *modelrouter.Router) (http.Handler, string) {
	t.Helper()
	dataStore, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("abrir o store: %v", err)
	}
	t.Cleanup(func() { _ = dataStore.Close() })

	projeto := t.TempDir()
	if _, err := dataStore.CreateSession(store.SessionMeta{
		ID: "s-ui", CWD: projeto, Specialist: "code",
	}); err != nil {
		t.Fatalf("criar sessão: %v", err)
	}

	bus := eventbus.New(dataStore)
	registry := supervisor.NewRegistry()
	(&supervisor.Toolbox{}).Install(registry)
	if models == nil {
		models = modelrouter.New(nil, nil)
	}
	sup := supervisor.New(supervisor.Deps{
		Store:  dataStore,
		Bus:    bus,
		Gate:   permissions.NewGate(permissions.DefaultPolicy()),
		Tools:  registry,
		Models: models,
		Workspaces: workspace.NewManager(func(id string) string {
			meta, err := dataStore.GetSession(id)
			if err != nil {
				return ""
			}
			return meta.CWD
		}),
	})
	server := NewServer(
		config.Config{Token: uiToolsTestToken},
		dataStore, bus, sup, models,
		fusion.NewRegistry(),
		permissions.NewGate(permissions.DefaultPolicy()),
		nil, nil, "",
		slog.New(slog.NewTextHandler(io.Discard, nil)),
	)
	return server.Handler(), projeto
}

// uiDo dispara uma requisição pela rota inteira, com ou sem token.
func uiDo(t *testing.T, handler http.Handler, path, token string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var reader io.Reader
	if texto, cru := body.(string); cru {
		reader = strings.NewReader(texto)
	} else if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("serializar corpo: %v", err)
		}
		reader = bytes.NewReader(raw)
	}
	request := httptest.NewRequest(http.MethodPost, path, reader)
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

// uiToolResult lê o contrato {ok, output|error} da rota de ferramenta.
func uiToolResult(t *testing.T, recorder *httptest.ResponseRecorder) (bool, string, string) {
	t.Helper()
	var parsed struct {
		OK     bool   `json:"ok"`
		Output string `json:"output"`
		Error  string `json:"error"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &parsed); err != nil {
		t.Fatalf("resposta fora do contrato {ok, output|error}: %v\n%s", err, recorder.Body.String())
	}
	return parsed.OK, parsed.Output, parsed.Error
}

/* ---------------------------------- token ---------------------------------- */

// As duas rotas são autenticadas como tudo no gateway: sem o token, qualquer
// página aberta no navegador da estação leria arquivo do projeto por fs.read —
// o caminho mais barato de exfiltração que existe.
func TestUIToolsExigemToken(t *testing.T) {
	handler, _ := newUIToolsHarness(t, nil)

	for _, path := range []string{"/v1/tools/call", "/v1/model/complete"} {
		if code := uiDo(t, handler, path, "", map[string]string{}).Code; code != http.StatusUnauthorized {
			t.Errorf("%s sem token: esperava 401, veio %d", path, code)
		}
		if code := uiDo(t, handler, path, "token-errado", map[string]string{}).Code; code != http.StatusUnauthorized {
			t.Errorf("%s com token errado: esperava 401, veio %d", path, code)
		}
	}
}

/* -------------------------------- tools/call ------------------------------- */

func TestToolsCallValidaCorpoESessao(t *testing.T) {
	handler, _ := newUIToolsHarness(t, nil)

	if code := uiDo(t, handler, "/v1/tools/call", uiToolsTestToken, "não é json").Code; code != http.StatusBadRequest {
		t.Fatalf("corpo inválido: esperava 400, veio %d", code)
	}
	if code := uiDo(t, handler, "/v1/tools/call", uiToolsTestToken,
		map[string]string{"session": "s-ui"}).Code; code != http.StatusBadRequest {
		t.Fatalf("sem tool: esperava 400, veio %d", code)
	}
	if code := uiDo(t, handler, "/v1/tools/call", uiToolsTestToken,
		map[string]string{"session": "s-inexistente", "tool": "fs.read"}).Code; code != http.StatusNotFound {
		t.Fatalf("sessão inexistente: esperava 404, veio %d", code)
	}
}

// Recusa de mérito é 200 com {ok:false, error}: para a tela, whitelist, portão
// e falha de ferramenta são o mesmo evento — "não rodou, mostre o motivo".
func TestToolsCallRecusaForaDaWhitelistComMotivo(t *testing.T) {
	handler, _ := newUIToolsHarness(t, nil)

	recorder := uiDo(t, handler, "/v1/tools/call", uiToolsTestToken, map[string]any{
		"session": "s-ui", "tool": "proc.run",
		"args": map[string]string{"command": "rm -rf ."},
	})
	if recorder.Code != http.StatusOK {
		t.Fatalf("recusa de mérito: esperava 200, veio %d: %s", recorder.Code, recorder.Body.String())
	}
	ok, _, motivo := uiToolResult(t, recorder)
	if ok {
		t.Fatal("proc.run pela UI tinha de ser recusado")
	}
	if !strings.Contains(motivo, "proc.run") {
		t.Fatalf("a recusa tinha de citar a ferramenta, veio %q", motivo)
	}
}

func TestToolsCallLeituraDevolveOArquivo(t *testing.T) {
	handler, projeto := newUIToolsHarness(t, nil)
	if err := os.WriteFile(filepath.Join(projeto, "main.go"), []byte("package main"), 0o644); err != nil {
		t.Fatalf("preparar o projeto: %v", err)
	}

	recorder := uiDo(t, handler, "/v1/tools/call", uiToolsTestToken, map[string]any{
		"session": "s-ui", "tool": "fs.read",
		"args": map[string]string{"path": "main.go"},
	})
	if recorder.Code != http.StatusOK {
		t.Fatalf("esperava 200, veio %d: %s", recorder.Code, recorder.Body.String())
	}
	ok, output, motivo := uiToolResult(t, recorder)
	if !ok || !strings.Contains(output, "package main") {
		t.Fatalf("a leitura tinha de voltar com o conteúdo: ok=%v output=%q error=%q", ok, output, motivo)
	}
}

/* ------------------------------ model/complete ----------------------------- */

func TestModelCompleteValidaCorpo(t *testing.T) {
	handler, _ := newUIToolsHarness(t, nil)

	if code := uiDo(t, handler, "/v1/model/complete", uiToolsTestToken, "não é json").Code; code != http.StatusBadRequest {
		t.Fatalf("corpo inválido: esperava 400, veio %d", code)
	}
	if code := uiDo(t, handler, "/v1/model/complete", uiToolsTestToken,
		map[string]string{"session": "s-ui", "prompt": "   "}).Code; code != http.StatusBadRequest {
		t.Fatalf("prompt vazio: esperava 400, veio %d", code)
	}
	if code := uiDo(t, handler, "/v1/model/complete", uiToolsTestToken,
		map[string]string{"session": "s-inexistente", "prompt": "complete"}).Code; code != http.StatusNotFound {
		t.Fatalf("sessão inexistente: esperava 404, veio %d", code)
	}
	// Roteador sem provedor nenhum: o catálogo não atende e a rota conta em qual
	// código — 503, porque o pedido está certo e a estação é que não tem modelo.
	if code := uiDo(t, handler, "/v1/model/complete", uiToolsTestToken,
		map[string]string{"session": "s-ui", "prompt": "complete"}).Code; code != http.StatusServiceUnavailable {
		t.Fatalf("sem modelo: esperava 503, veio %d", code)
	}
}

// O caminho feliz do autocomplete pela rota inteira — e a prova de que o teto
// de 512 chega ao provedor mesmo quando o cliente pede mais.
func TestModelCompleteDevolveTextoComTetoAplicado(t *testing.T) {
	var visto atomic.Int64
	visto.Store(-1)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			MaxTokens *int `json:"max_tokens"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("pedido ilegível no provedor de mentira: %v", err)
		}
		if body.MaxTokens != nil {
			visto.Store(int64(*body.MaxTokens))
		}
		chunk, err := json.Marshal(map[string]any{
			"choices": []map[string]any{{"delta": map[string]any{"content": "soma(a, b)"}}},
		})
		if err != nil {
			t.Errorf("montar o chunk: %v", err)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprintf(w, "data: %s\n\n", chunk)
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	t.Cleanup(provider.Close)

	models := modelrouter.New(http.DefaultClient, nil)
	models.SetProviders([]modelrouter.Provider{
		{ID: "fake", Kind: modelrouter.KindOpenAI, BaseURL: provider.URL, Enabled: true},
	})
	models.SetModels([]modelrouter.Entry{
		{Model: protocol.Model{ID: "m1", Provider: "fake", Label: "Modelo"}, ProviderID: "fake"},
	})
	handler, _ := newUIToolsHarness(t, models)

	recorder := uiDo(t, handler, "/v1/model/complete", uiToolsTestToken, map[string]any{
		"session": "s-ui", "prompt": "complete: função de soma", "maxTokens": 4096,
	})
	if recorder.Code != http.StatusOK {
		t.Fatalf("esperava 200, veio %d: %s", recorder.Code, recorder.Body.String())
	}
	var parsed struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &parsed); err != nil {
		t.Fatalf("resposta fora do contrato {text}: %v\n%s", err, recorder.Body.String())
	}
	if parsed.Text != "soma(a, b)" {
		t.Fatalf("texto do provedor: veio %q", parsed.Text)
	}
	if got := visto.Load(); got != 512 {
		t.Fatalf("o provedor tinha de receber max_tokens=512 apesar do pedido de 4096, recebeu %d", got)
	}
}
