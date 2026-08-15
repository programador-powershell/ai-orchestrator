// Os testes das rotas de catálogo.
//
// O que está em jogo aqui não é o CRUD — é a regra de segredo: a chave que
// entra pelo POST tem de existir SÓ no cofre, nunca no catalog.json nem em
// resposta. Por isso vários testes leem o arquivo cru e procuram a chave nele:
// um contains é a forma mais direta de provar a ausência, e falha alto no dia
// em que alguém "simplificar" a persistência gravando o valor junto.
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
	"testing"

	"aibot/gateway/internal/config"
	"aibot/gateway/internal/modelrouter"
	"aibot/gateway/internal/protocol"
	"aibot/gateway/internal/secrets"
)

const catalogTestToken = "token-de-teste-do-catalogo"

// newCatalogHarness monta um servidor mínimo: cofre real (em pasta temporária),
// roteador real e nada mais — sessões, barramento e supervisor ficam nil porque
// as rotas de catálogo não os tocam, e montá-los aqui só esconderia qual
// dependência o catálogo realmente tem.
func newCatalogHarness(t *testing.T) (*Server, *modelrouter.Router, *secrets.Vault, string) {
	t.Helper()
	dir := t.TempDir()

	masterKey := bytes.Repeat([]byte{7}, config.MasterKeySize)
	vault, err := secrets.Open(filepath.Join(dir, "vault.json"), masterKey)
	if err != nil {
		t.Fatalf("abrir cofre de teste: %v", err)
	}

	router := modelrouter.New(nil, vault)
	catalogPath := filepath.Join(dir, "catalog.json")
	server := NewServer(
		config.Config{Token: catalogTestToken},
		nil, nil, nil,
		router,
		nil, nil,
		vault,
		catalogPath,
		slog.New(slog.NewTextHandler(io.Discard, nil)),
	)
	return server, router, vault, catalogPath
}

// do dispara uma requisição autenticada contra o Handler e devolve o gravador.
func do(t *testing.T, handler http.Handler, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("serializar corpo de %s %s: %v", method, path, err)
		}
		reader = bytes.NewReader(raw)
	}
	request := httptest.NewRequest(method, path, reader)
	request.Header.Set("Authorization", "Bearer "+catalogTestToken)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func decodeBody(t *testing.T, recorder *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var parsed map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &parsed); err != nil {
		t.Fatalf("resposta não é JSON: %v\n%s", err, recorder.Body.String())
	}
	return parsed
}

// createProvider é o POST de provedor que a maioria dos testes precisa.
func createProvider(t *testing.T, handler http.Handler, id, kind, baseURL, apiKey string) *httptest.ResponseRecorder {
	t.Helper()
	return do(t, handler, http.MethodPost, "/v1/catalog/providers", map[string]any{
		"id":      id,
		"name":    "Provedor " + id,
		"kind":    kind,
		"baseUrl": baseURL,
		"apiKey":  apiKey,
	})
}

/* ------------------------------- segredo ---------------------------------- */

func TestCatalogProviderKeyGoesToVaultNeverToFile(t *testing.T) {
	server, _, vault, catalogPath := newCatalogHarness(t)
	handler := server.Handler()
	const apiKey = "sk-chave-supersecreta-9911"

	response := createProvider(t, handler, "acme", "openai-compatible", "https://api.acme.dev/v1", apiKey)
	if response.Code != http.StatusCreated {
		t.Fatalf("POST provider: esperava 201, veio %d: %s", response.Code, response.Body.String())
	}

	parsed := decodeBody(t, response)
	if stored, _ := parsed["keyStored"].(bool); !stored {
		t.Fatalf("a resposta tinha de dizer que a chave foi gravada: %s", response.Body.String())
	}
	if strings.Contains(response.Body.String(), apiKey) {
		t.Fatalf("a resposta do POST ecoou a chave: %s", response.Body.String())
	}

	if !vault.Has("provider:acme") {
		t.Fatal("a chave não chegou ao cofre em provider:acme")
	}

	raw, err := os.ReadFile(catalogPath)
	if err != nil {
		t.Fatalf("ler catalog.json gravado: %v", err)
	}
	if strings.Contains(string(raw), apiKey) {
		t.Fatalf("o catalog.json contém a chave em claro:\n%s", raw)
	}
	if !strings.Contains(string(raw), `"secretRef": "provider:acme"`) {
		t.Fatalf("o catalog.json tinha de guardar só o secretRef:\n%s", raw)
	}

	// O GET também não pode ecoar nem a chave nem o secretRef como valor — só
	// o booleano que a tela usa para escrever "cadastrada/ausente".
	catalog := do(t, handler, http.MethodGet, "/v1/catalog", nil)
	if catalog.Code != http.StatusOK {
		t.Fatalf("GET /v1/catalog: esperava 200, veio %d", catalog.Code)
	}
	if strings.Contains(catalog.Body.String(), apiKey) {
		t.Fatalf("o GET /v1/catalog ecoou a chave: %s", catalog.Body.String())
	}
	if strings.Contains(catalog.Body.String(), "secretRef") {
		t.Fatalf("o GET /v1/catalog expôs o secretRef: %s", catalog.Body.String())
	}
	if !strings.Contains(catalog.Body.String(), `"hasKey":true`) {
		t.Fatalf("o GET tinha de marcar hasKey=true: %s", catalog.Body.String())
	}
}

func TestCatalogPatchWithoutKeyPreservesTheCurrentOne(t *testing.T) {
	server, _, vault, _ := newCatalogHarness(t)
	handler := server.Handler()
	const original = "sk-original-1234567890"

	if code := createProvider(t, handler, "acme", "openai", "https://api.acme.dev/v1", original).Code; code != http.StatusCreated {
		t.Fatalf("POST provider: esperava 201, veio %d", code)
	}

	// PATCH sem apiKey: muda o nome, a chave fica.
	response := do(t, handler, http.MethodPatch, "/v1/catalog/providers/acme", map[string]any{
		"name": "Acme Renomeada",
	})
	if response.Code != http.StatusOK {
		t.Fatalf("PATCH: esperava 200, veio %d: %s", response.Code, response.Body.String())
	}
	if stored, _ := decodeBody(t, response)["keyStored"].(bool); stored {
		t.Fatal("PATCH sem apiKey não pode dizer que gravou chave")
	}
	assertVaultValue(t, vault, "provider:acme", original)

	// apiKey em branco também conta como ausente: é o formulário sem digitação.
	response = do(t, handler, http.MethodPatch, "/v1/catalog/providers/acme", map[string]any{
		"apiKey": "",
	})
	if response.Code != http.StatusOK {
		t.Fatalf("PATCH com chave vazia: esperava 200, veio %d: %s", response.Code, response.Body.String())
	}
	assertVaultValue(t, vault, "provider:acme", original)

	// Com apiKey nova, ela substitui a antiga.
	const renewed = "sk-renovada-0987654321"
	response = do(t, handler, http.MethodPatch, "/v1/catalog/providers/acme", map[string]any{
		"apiKey": renewed,
	})
	if response.Code != http.StatusOK {
		t.Fatalf("PATCH com chave: esperava 200, veio %d: %s", response.Code, response.Body.String())
	}
	if stored, _ := decodeBody(t, response)["keyStored"].(bool); !stored {
		t.Fatal("PATCH com apiKey tinha de confirmar a gravação")
	}
	assertVaultValue(t, vault, "provider:acme", renewed)
}

// assertVaultValue confere o valor pelo ÚNICO caminho que o cofre oferece — o
// callback do Use. O valor não sai do closure, que é exatamente o contrato.
func assertVaultValue(t *testing.T, vault *secrets.Vault, ref, expected string) {
	t.Helper()
	matched := false
	if err := vault.Use(ref, func(secret string) error {
		matched = secret == expected
		return nil
	}); err != nil {
		t.Fatalf("ler %s do cofre: %v", ref, err)
	}
	if !matched {
		t.Fatalf("o cofre não guarda o valor esperado em %s", ref)
	}
}

func TestCatalogDeleteProviderRemovesModelsAndKey(t *testing.T) {
	server, router, vault, catalogPath := newCatalogHarness(t)
	handler := server.Handler()

	if code := createProvider(t, handler, "acme", "openai-compatible", "https://api.acme.dev/v1", "sk-some-key-123").Code; code != http.StatusCreated {
		t.Fatalf("POST provider: esperava 201, veio %d", code)
	}
	for _, model := range []string{"acme-mini", "acme-max"} {
		response := do(t, handler, http.MethodPost, "/v1/catalog/models", map[string]any{
			"id": model, "providerId": "acme", "label": model, "context": 8192, "skills": []string{"chat"},
		})
		if response.Code != http.StatusCreated {
			t.Fatalf("POST model %s: esperava 201, veio %d: %s", model, response.Code, response.Body.String())
		}
	}

	response := do(t, handler, http.MethodDelete, "/v1/catalog/providers/acme", nil)
	if response.Code != http.StatusOK {
		t.Fatalf("DELETE: esperava 200, veio %d: %s", response.Code, response.Body.String())
	}
	if removed, _ := decodeBody(t, response)["removedModels"].(float64); removed != 2 {
		t.Fatalf("esperava 2 modelos removidos junto, veio %v", removed)
	}

	if vault.Has("provider:acme") {
		t.Fatal("a chave tinha de sair do cofre junto com o provedor")
	}
	raw, err := os.ReadFile(catalogPath)
	if err != nil {
		t.Fatalf("ler catalog.json: %v", err)
	}
	if strings.Contains(string(raw), "acme") {
		t.Fatalf("o arquivo ainda menciona o provedor removido:\n%s", raw)
	}
	if len(router.Catalog()) != 0 {
		t.Fatalf("o roteador ainda serve modelos do provedor removido: %v", router.Catalog())
	}
}

/* ----------------------------- aplicação a quente -------------------------- */

func TestCatalogAppliesHotWithoutReboot(t *testing.T) {
	server, router, _, _ := newCatalogHarness(t)
	handler := server.Handler()

	if len(router.Catalog()) != 0 {
		t.Fatalf("o catálogo tinha de começar vazio, veio %v", router.Catalog())
	}

	if code := createProvider(t, handler, "acme", "openai-compatible", "https://api.acme.dev/v1", "sk-hot-apply-123").Code; code != http.StatusCreated {
		t.Fatalf("POST provider: esperava 201, veio %d", code)
	}
	response := do(t, handler, http.MethodPost, "/v1/catalog/models", map[string]any{
		"id": "acme-max", "providerId": "acme", "label": "Acme Max", "context": 32768,
		"skills": []string{"chat"}, "default": true,
	})
	if response.Code != http.StatusCreated {
		t.Fatalf("POST model: esperava 201, veio %d: %s", response.Code, response.Body.String())
	}

	// O MESMO roteador que o servidor recebeu — nada foi reaberto nem recarregado.
	catalog := router.Catalog()
	if len(catalog) != 1 || catalog[0].ID != "acme-max" {
		t.Fatalf("o modelo cadastrado não apareceu a quente: %v", catalog)
	}

	if response := do(t, handler, http.MethodDelete, "/v1/catalog/models/acme-max", nil); response.Code != http.StatusOK {
		t.Fatalf("DELETE model: esperava 200, veio %d", response.Code)
	}
	if len(router.Catalog()) != 0 {
		t.Fatalf("a remoção também tinha de valer a quente: %v", router.Catalog())
	}
}

func TestCatalogShowsAndMaterializesPluginProvider(t *testing.T) {
	server, router, vault, catalogPath := newCatalogHarness(t)
	handler := server.Handler()
	if err := router.SetCatalogLayer("plugin:grok:models", 10,
		[]modelrouter.Provider{{
			ID: "xai", Name: "xAI", Kind: modelrouter.KindXAI,
			BaseURL: "https://api.x.ai/v1", SecretRef: "provider:xai",
		}},
		[]modelrouter.Entry{{
			Model:      protocol.Model{ID: "grok-4.5", Provider: "xai", Label: "Grok 4.5"},
			ProviderID: "xai", Default: true,
		}},
	); err != nil {
		t.Fatal(err)
	}

	response := do(t, handler, http.MethodGet, "/v1/catalog", nil)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"id":"xai"`) ||
		!strings.Contains(response.Body.String(), `"id":"grok-4.5"`) {
		t.Fatalf("GET não compôs o plugin: %d %s", response.Code, response.Body.String())
	}
	if strings.Count(response.Body.String(), `"canDelete":false`) < 2 {
		t.Fatalf("itens só do plugin não podem oferecer remoção: %s", response.Body.String())
	}

	response = do(t, handler, http.MethodPatch, "/v1/catalog/providers/xai", map[string]any{
		"enabled": true,
		"apiKey":  "xai-plugin-key",
	})
	if response.Code != http.StatusOK {
		t.Fatalf("PATCH não materializou provedor do plugin: %d %s", response.Code, response.Body.String())
	}
	if !vault.Has("provider:xai") {
		t.Fatal("a chave do provedor de plugin não chegou ao cofre")
	}
	raw, err := os.ReadFile(catalogPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"id": "xai"`) || strings.Contains(string(raw), "xai-plugin-key") {
		t.Fatalf("override do plugin foi persistido de forma insegura:\n%s", raw)
	}
}

func TestCatalogRewritePreservesForeignSections(t *testing.T) {
	server, _, _, catalogPath := newCatalogHarness(t)
	handler := server.Handler()

	// Um catálogo pré-existente com seções de OUTROS donos — o motor de busca
	// do web.search e a VPS do ambiente de execução. Editar provedor regrava o
	// arquivo inteiro, e a regravação não pode apagar o que não é dela.
	seed := `{
  "providers": [],
  "models": [],
  "search": {"kind": "searxng", "endpoint": "https://busca.interna/search"},
  "vps": {"host": "10.0.0.7", "port": 22, "user": "ai-bot"}
}`
	if err := os.WriteFile(catalogPath, []byte(seed), 0o600); err != nil {
		t.Fatalf("semear catalog.json: %v", err)
	}

	if code := createProvider(t, handler, "acme", "openai", "https://api.acme.dev/v1", "").Code; code != http.StatusCreated {
		t.Fatalf("POST provider: esperava 201, veio %d", code)
	}

	raw, err := os.ReadFile(catalogPath)
	if err != nil {
		t.Fatalf("ler catalog.json: %v", err)
	}
	for _, fragment := range []string{"searxng", "busca.interna", `"vps"`, "10.0.0.7"} {
		if !strings.Contains(string(raw), fragment) {
			t.Fatalf("a regravação perdeu a seção alheia (%q):\n%s", fragment, raw)
		}
	}
	if !strings.Contains(string(raw), `"acme"`) {
		t.Fatalf("o provedor novo não entrou no arquivo:\n%s", raw)
	}
}

func TestCatalogPolicyStillExcludesUnallowedModels(t *testing.T) {
	server, router, _, _ := newCatalogHarness(t)
	handler := server.Handler()

	// A política do admin liberou só um id que não é o cadastrado. Cadastrar
	// pelo catálogo NÃO pode virar liberação — o portão de AllowedModels manda.
	router.SetAllowed([]string{"somente-este"})

	if code := createProvider(t, handler, "acme", "openai-compatible", "https://api.acme.dev/v1", "sk-policy-key-123").Code; code != http.StatusCreated {
		t.Fatalf("POST provider: esperava 201, veio %d", code)
	}
	response := do(t, handler, http.MethodPost, "/v1/catalog/models", map[string]any{
		"id": "fora-da-politica", "providerId": "acme", "label": "Fora", "context": 8192,
	})
	if response.Code != http.StatusCreated {
		t.Fatalf("POST model: esperava 201, veio %d: %s", response.Code, response.Body.String())
	}

	for _, entry := range router.Catalog() {
		if entry.ID == "fora-da-politica" {
			t.Fatal("um modelo fora de AllowedModels entrou no catálogo utilizável")
		}
	}
}

/* -------------------------------- validação -------------------------------- */

func TestCatalogValidationRefusesWithReason(t *testing.T) {
	server, _, _, _ := newCatalogHarness(t)
	handler := server.Handler()

	cases := []struct {
		name   string
		body   map[string]any
		status int
		reason string
	}{
		{
			name:   "kind desconhecido",
			body:   map[string]any{"id": "x1", "kind": "banana", "baseUrl": "https://x.dev"},
			status: http.StatusBadRequest,
			reason: "banana",
		},
		{
			name:   "http fora de loopback",
			body:   map[string]any{"id": "x2", "kind": "openai", "baseUrl": "http://api.exemplo.com/v1"},
			status: http.StatusBadRequest,
			reason: "loopback",
		},
		{
			name:   "id com barra",
			body:   map[string]any{"id": "a/b", "kind": "openai", "baseUrl": "https://x.dev"},
			status: http.StatusBadRequest,
			reason: "inválido",
		},
		{
			name:   "chave em provedor local",
			body:   map[string]any{"id": "x3", "kind": "local", "baseUrl": "http://127.0.0.1:8788/v1", "apiKey": "sk-inutil-123"},
			status: http.StatusBadRequest,
			reason: "local não usa chave",
		},
	}
	for _, testCase := range cases {
		response := do(t, handler, http.MethodPost, "/v1/catalog/providers", testCase.body)
		if response.Code != testCase.status {
			t.Fatalf("%s: esperava %d, veio %d: %s", testCase.name, testCase.status, response.Code, response.Body.String())
		}
		if !strings.Contains(response.Body.String(), testCase.reason) {
			t.Fatalf("%s: a recusa tinha de ser acionável (esperava %q): %s",
				testCase.name, testCase.reason, response.Body.String())
		}
	}

	// http em loopback passa — é o runtime local e o teste de integração.
	if response := createProvider(t, handler, "local-ok", "openai-compatible", "http://127.0.0.1:8788/v1", ""); response.Code != http.StatusCreated {
		t.Fatalf("loopback http tinha de passar, veio %d: %s", response.Code, response.Body.String())
	}
	// Id repetido é conflito, não sobrescrita silenciosa.
	if response := createProvider(t, handler, "local-ok", "openai-compatible", "http://127.0.0.1:8788/v1", ""); response.Code != http.StatusConflict {
		t.Fatalf("id repetido tinha de dar 409, veio %d", response.Code)
	}
}

func TestCatalogRoutesRequireToken(t *testing.T) {
	server, _, _, _ := newCatalogHarness(t)
	handler := server.Handler()

	request := httptest.NewRequest(http.MethodGet, "/v1/catalog", nil)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("sem token tinha de ser 401, veio %d", recorder.Code)
	}
}

/* ------------------------------ teste de conexão ---------------------------- */

func TestCatalogTestProviderReportsWithoutEchoingKey(t *testing.T) {
	server, _, _, _ := newCatalogHarness(t)
	handler := server.Handler()
	const apiKey = "sk-conexao-de-teste-777"

	// O provedor de mentira valida que a credencial CHEGOU (prova que o teste
	// usa o cofre) e devolve 200 ou 401 conforme a chave.
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/models" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Authorization") != "Bearer "+apiKey {
			w.WriteHeader(http.StatusUnauthorized)
			fmt.Fprint(w, `{"error":{"message":"chave inválida"}}`)
			return
		}
		fmt.Fprint(w, `{"data":[]}`)
	}))
	defer fake.Close()

	if code := createProvider(t, handler, "fake", "openai-compatible", fake.URL, apiKey).Code; code != http.StatusCreated {
		t.Fatalf("POST provider: esperava 201, veio %d", code)
	}

	response := do(t, handler, http.MethodPost, "/v1/catalog/test/fake", nil)
	if response.Code != http.StatusOK {
		t.Fatalf("POST test: esperava 200, veio %d: %s", response.Code, response.Body.String())
	}
	parsed := decodeBody(t, response)
	if okFlag, _ := parsed["ok"].(bool); !okFlag {
		t.Fatalf("com a chave certa o teste tinha de passar: %s", response.Body.String())
	}

	// Chave trocada: o resultado é legível (fala do 401) e NÃO ecoa nenhuma
	// das chaves.
	const wrongKey = "sk-chave-errada-000000"
	if code := do(t, handler, http.MethodPatch, "/v1/catalog/providers/fake", map[string]any{"apiKey": wrongKey}).Code; code != http.StatusOK {
		t.Fatalf("PATCH da chave: esperava 200, veio %d", code)
	}
	response = do(t, handler, http.MethodPost, "/v1/catalog/test/fake", nil)
	if response.Code != http.StatusOK {
		t.Fatalf("POST test: esperava 200, veio %d", response.Code)
	}
	parsed = decodeBody(t, response)
	if okFlag, _ := parsed["ok"].(bool); okFlag {
		t.Fatal("com a chave errada o teste tinha de reprovar")
	}
	detail, _ := parsed["detail"].(string)
	if !strings.Contains(detail, "401") {
		t.Fatalf("o detalhe tinha de citar o 401: %q", detail)
	}
	if strings.Contains(response.Body.String(), apiKey) || strings.Contains(response.Body.String(), wrongKey) {
		t.Fatalf("o resultado do teste ecoou uma chave: %s", response.Body.String())
	}

	// Provedor que não existe: 404 com frase, não pânico nem sucesso vazio.
	if response := do(t, handler, http.MethodPost, "/v1/catalog/test/nao-existe", nil); response.Code != http.StatusNotFound {
		t.Fatalf("teste de provedor inexistente tinha de dar 404, veio %d", response.Code)
	}
}

func TestCatalogAcceptsAndProbesXAIProvider(t *testing.T) {
	server, _, _, _ := newCatalogHarness(t)
	handler := server.Handler()
	const apiKey = "xai-chave-catalogo"

	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/models" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Authorization") != "Bearer "+apiKey {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		fmt.Fprint(w, `{"data":[{"id":"grok-4.5"}]}`)
	}))
	defer fake.Close()

	response := createProvider(t, handler, "xai", "xai", fake.URL, apiKey)
	if response.Code != http.StatusCreated {
		t.Fatalf("POST xAI: esperava 201, veio %d: %s", response.Code, response.Body.String())
	}
	response = do(t, handler, http.MethodPost, "/v1/catalog/test/xai", nil)
	if response.Code != http.StatusOK {
		t.Fatalf("teste xAI: esperava 200, veio %d: %s", response.Code, response.Body.String())
	}
	if okFlag, _ := decodeBody(t, response)["ok"].(bool); !okFlag {
		t.Fatalf("teste xAI devia validar GET /models: %s", response.Body.String())
	}
}
