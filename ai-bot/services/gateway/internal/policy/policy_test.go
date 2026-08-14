// Testes da política: o padrão restritivo da edição gerenciada e a busca
// remota.
//
// O que estes testes travam é sempre a mesma direção da falha: a política pode
// ficar mais apertada por acidente, nunca mais frouxa. Servidor fora do ar,
// documento truncado, 500, JSON inválido — nada disso pode virar liberação.
package policy

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"aibot/gateway/internal/modelrouter"
	"aibot/gateway/internal/permissions"
	"aibot/gateway/internal/protocol"
)

/* ------------------------------- apoio ---------------------------------- */

// clientFetcher é o Fetcher do teste. O netguard de verdade recusa loopback —
// corretamente, é o SSRF que ele existe para fechar — então o httptest precisa
// de um canal que não passe por ele. A interface Fetcher existe por isto.
type clientFetcher struct{}

func (clientFetcher) Fetch(ctx context.Context, raw string, header http.Header) (*http.Response, []byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
	if err != nil {
		return nil, nil, err
	}
	for key, values := range header {
		for _, value := range values {
			request.Header.Add(key, value)
		}
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return nil, nil, err
	}
	body, err := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if err != nil {
		return nil, nil, err
	}
	return response, body, nil
}

// recordingModels guarda o que o roteador receberia.
type recordingModels struct {
	mu     sync.Mutex
	calls  int
	last   []string
	wasNil bool
}

func (m *recordingModels) SetAllowed(ids []string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.calls++
	m.last = ids
	m.wasNil = ids == nil
}

func (m *recordingModels) snapshot() (int, []string, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.calls, m.last, m.wasNil
}

// quietLogger cala o aviso esperado: os testes de falha existem justamente para
// provocá-lo, e um `go test` cheio de WARN esconde o que é problema de verdade.
func quietLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, &slog.HandlerOptions{Level: slog.LevelError}))
}

func managedBase() permissions.Policy {
	base := permissions.DefaultPolicy()
	base.Mode = permissions.ModeAsk
	base.AllowedModels = []string{"gpt-5"}
	return base
}

/* --------------------------- padrão gerenciado --------------------------- */

func TestRestrictManagedDerrubaOProvedorLocal(t *testing.T) {
	providers := []modelrouter.Provider{
		{ID: "openai", Kind: modelrouter.KindOpenAI, Enabled: true},
		{ID: "local", Kind: modelrouter.KindLocal, Enabled: true},
	}
	catalog := []modelrouter.Entry{
		{Model: protocol.Model{ID: "gpt-5", Provider: "openai"}, ProviderID: "openai"},
		{Model: protocol.Model{ID: "local-gguf", Provider: "local", Local: true}, ProviderID: "local"},
	}

	restricted, allowed := RestrictManaged(providers, catalog)

	for _, provider := range restricted {
		if provider.ID == "local" && provider.Enabled {
			t.Fatalf("o runtime local continuou habilitado na edição gerenciada")
		}
		if provider.ID == "openai" && !provider.Enabled {
			t.Fatalf("a edição gerenciada derrubou um provedor que não é local")
		}
	}
	if len(allowed) != 1 || allowed[0] != "gpt-5" {
		t.Fatalf("lista permitida: esperava só gpt-5, obteve %v", allowed)
	}
	// A entrada original não pode ter sido alterada: o chamador ainda tem a
	// fatia do catalog.json na mão.
	if !providers[1].Enabled {
		t.Fatalf("RestrictManaged escreveu na fatia de quem chamou")
	}
}

// Modelo local servido por um provedor "openai-compatible" apontado para
// 127.0.0.1 não tem Kind local nenhum — o corte precisa pegar a marca do
// MODELO também.
func TestRestrictManagedDerrubaModeloLocalDeProvedorCompativel(t *testing.T) {
	providers := []modelrouter.Provider{
		{ID: "compat", Kind: modelrouter.KindCompatible, BaseURL: "http://127.0.0.1:8788/v1", Enabled: true},
	}
	catalog := []modelrouter.Entry{
		{Model: protocol.Model{ID: "disfarcado", Provider: "compat", Local: true}, ProviderID: "compat"},
	}

	_, allowed := RestrictManaged(providers, catalog)
	if allowed == nil {
		t.Fatalf("lista nil libera o catálogo inteiro — o gerenciado precisa de lista vazia")
	}
	if len(allowed) != 0 {
		t.Fatalf("lista permitida: esperava nenhuma, obteve %v", allowed)
	}
}

/* ------------------------------ Document -------------------------------- */

func TestDocumentAplicaSobreABase(t *testing.T) {
	sim := true
	document := Document{
		Mode:          "edits",
		AllowedModels: []string{"claude-opus-5", "gpt-5"},
		DeniedTools:   []string{"proc.run"},
		AgentTools:    &sim,
		MaxDepth:      2,
	}

	applied := document.Apply(managedBase())
	if applied.Mode != permissions.ModeEdits {
		t.Fatalf("modo: esperava edits, obteve %q", applied.Mode)
	}
	if len(applied.AllowedModels) != 2 {
		t.Fatalf("modelos: esperava 2, obteve %v", applied.AllowedModels)
	}
	if applied.MaxDepth != 2 {
		t.Fatalf("MaxDepth: esperava 2, obteve %d", applied.MaxDepth)
	}
	if len(applied.DeniedTools) != 1 {
		t.Fatalf("DeniedTools: esperava 1, obteve %v", applied.DeniedTools)
	}
}

// Documento sem os campos mantém a base — que na estação gerenciada é o padrão
// restritivo. Um documento incompleto não pode zerar restrição de pé.
func TestDocumentAusenteMantemABaseRestritiva(t *testing.T) {
	applied := Document{}.Apply(managedBase())

	if applied.Mode != permissions.ModeAsk {
		t.Fatalf("modo: esperava ask, obteve %q", applied.Mode)
	}
	if len(applied.AllowedModels) != 1 || applied.AllowedModels[0] != "gpt-5" {
		t.Fatalf("modelos: esperava a lista base, obteve %v", applied.AllowedModels)
	}
	if !applied.AgentTools {
		t.Fatalf("AgentTools: campo ausente não pode desligar a ferramenta inteira")
	}
}

// Lista vazia DECLARADA é o admin dizendo "nenhum modelo" — e sobrevive ao
// parse porque encoding/json entrega fatia de tamanho zero, não nil.
func TestDocumentListaVaziaBloqueiaTodosOsModelos(t *testing.T) {
	server := policyServer(t, http.StatusOK, `{"allowedModels":[]}`)
	defer server.Close()

	models := &recordingModels{}
	applied, err := Sync(context.Background(), Options{
		URL: server.URL, Base: managedBase(), Fetcher: clientFetcher{}, Models: models,
	})
	if err != nil {
		t.Fatalf("Sync: %v", err)
	}
	if applied.AllowedModels == nil {
		t.Fatalf("lista vazia virou nil — isso libera o catálogo inteiro")
	}
	if len(applied.AllowedModels) != 0 {
		t.Fatalf("modelos: esperava nenhum, obteve %v", applied.AllowedModels)
	}
	_, last, wasNil := models.snapshot()
	if wasNil || len(last) != 0 {
		t.Fatalf("o roteador recebeu %v (nil=%t) em vez de uma lista vazia", last, wasNil)
	}
}

/* -------------------------------- Sync ---------------------------------- */

func policyServer(t *testing.T, status int, body string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if accept := r.Header.Get("Accept"); !strings.Contains(accept, "application/json") {
			t.Errorf("Accept: esperava application/json, obteve %q", accept)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}))
}

func TestSyncAplicaNoPortaoENoCatalogo(t *testing.T) {
	server := policyServer(t, http.StatusOK, `{
		"mode": "edits",
		"allowedModels": ["gpt-5"],
		"blockedDomains": ["exemplo.com"],
		"agentTools": true
	}`)
	defer server.Close()

	gate := permissions.NewGate(managedBase())
	models := &recordingModels{}

	applied, err := Sync(context.Background(), Options{
		URL: server.URL, Base: managedBase(), Fetcher: clientFetcher{}, Gate: gate, Models: models,
	})
	if err != nil {
		t.Fatalf("Sync: %v", err)
	}
	if applied.Mode != permissions.ModeEdits {
		t.Fatalf("modo aplicado: %q", applied.Mode)
	}
	if got := gate.Policy(); got.Mode != permissions.ModeEdits || len(got.BlockedDomains) != 1 {
		t.Fatalf("o portão não recebeu a política remota: %+v", got)
	}
	calls, last, _ := models.snapshot()
	if calls != 1 || len(last) != 1 || last[0] != "gpt-5" {
		t.Fatalf("o catálogo recebeu %d chamada(s) com %v", calls, last)
	}
}

// O teste do modo de falha que importa: servidor fora do ar não pode relaxar
// nada. Sem política aplicada, o portão continua com a base restritiva.
func TestSyncFalhaMantemOPadraoRestritivo(t *testing.T) {
	server := policyServer(t, http.StatusInternalServerError, "erro")
	url := server.URL
	server.Close() // conexão recusada: o pior caso, não só o 500

	gate := permissions.NewGate(managedBase())
	models := &recordingModels{}

	applied, err := Sync(context.Background(), Options{
		URL: url, Base: managedBase(), Fetcher: clientFetcher{}, Gate: gate, Models: models,
	})
	if err == nil {
		t.Fatalf("Sync com o servidor fora do ar: esperava erro")
	}
	if applied.Mode != permissions.ModeAsk || len(applied.AllowedModels) != 1 {
		t.Fatalf("a falha mexeu na política em vigor: %+v", applied)
	}
	if got := gate.Policy(); got.Mode != permissions.ModeAsk {
		t.Fatalf("o portão foi relaxado por uma falha de rede: %q", got.Mode)
	}
	if calls, _, _ := models.snapshot(); calls != 0 {
		t.Fatalf("o catálogo foi tocado apesar da falha (%d chamadas)", calls)
	}
}

func TestSyncRecusaRespostaDeErro(t *testing.T) {
	server := policyServer(t, http.StatusForbidden, `{"mode":"all"}`)
	defer server.Close()

	models := &recordingModels{}
	_, err := Sync(context.Background(), Options{
		URL: server.URL, Base: managedBase(), Fetcher: clientFetcher{}, Models: models,
	})
	if err == nil {
		t.Fatalf("403 com corpo válido: esperava erro, e a política do corpo NÃO pode valer")
	}
	if calls, _, _ := models.snapshot(); calls != 0 {
		t.Fatalf("o catálogo foi tocado por uma resposta 403")
	}
}

// JSON quebrado é indisponibilidade, não permissão.
func TestSyncRecusaCorpoInvalido(t *testing.T) {
	server := policyServer(t, http.StatusOK, `{"mode": "all"`)
	defer server.Close()

	gate := permissions.NewGate(managedBase())
	if _, err := Sync(context.Background(), Options{
		URL: server.URL, Base: managedBase(), Fetcher: clientFetcher{}, Gate: gate,
	}); err == nil {
		t.Fatalf("corpo truncado: esperava erro")
	}
	if got := gate.Policy(); got.Mode != permissions.ModeAsk {
		t.Fatalf("corpo truncado relaxou o portão: %q", got.Mode)
	}
}

// URL vazia é o caso do uso pessoal: sem política remota e sem erro.
func TestSyncSemURLNaoFalha(t *testing.T) {
	applied, err := Sync(context.Background(), Options{Base: managedBase()})
	if err != nil {
		t.Fatalf("Sync sem URL: %v", err)
	}
	if applied.Mode != permissions.ModeAsk {
		t.Fatalf("política sem URL: esperava a base, obteve %q", applied.Mode)
	}
}

/* -------------------------------- Start --------------------------------- */

// Start não bloqueia o boot e aplica assim que a resposta chega.
func TestStartAplicaEmSegundoPlano(t *testing.T) {
	server := policyServer(t, http.StatusOK, `{"allowedModels":["gpt-5"]}`)
	defer server.Close()

	models := &recordingModels{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	begun := time.Now()
	Start(ctx, Options{
		URL: server.URL, Base: managedBase(), Fetcher: clientFetcher{},
		Models: models, Interval: time.Hour, Log: quietLogger(),
	})
	if elapsed := time.Since(begun); elapsed > time.Second {
		t.Fatalf("Start bloqueou o boot por %s", elapsed)
	}

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if calls, _, _ := models.snapshot(); calls > 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("a política nunca foi aplicada em segundo plano")
}

// Falha na primeira passada não pode derrubar nada nem parar o refresh: o
// cancelamento do contexto é o único fim da goroutine.
func TestStartSobreviveAFalha(t *testing.T) {
	server := policyServer(t, http.StatusOK, "{}")
	url := server.URL
	server.Close()

	ctx, cancel := context.WithCancel(context.Background())
	Start(ctx, Options{
		URL: url, Base: managedBase(), Fetcher: clientFetcher{},
		Interval: 10 * time.Millisecond, Log: quietLogger(),
	})
	time.Sleep(50 * time.Millisecond)
	cancel()
}

func TestStartSemURLNaoDisparaNada(t *testing.T) {
	models := &recordingModels{}
	Start(context.Background(), Options{Base: managedBase(), Fetcher: clientFetcher{}, Models: models})
	time.Sleep(50 * time.Millisecond)
	if calls, _, _ := models.snapshot(); calls != 0 {
		t.Fatalf("sem URL o catálogo não pode ser tocado (%d chamadas)", calls)
	}
}

// failingFetcher devolve sempre o mesmo erro — o do guarda de rede recusando o
// destino, que é o caso real que precisa chegar inteiro a quem chamou.
type failingFetcher struct{ err error }

func (f failingFetcher) Fetch(context.Context, string, http.Header) (*http.Response, []byte, error) {
	return nil, nil, f.err
}

func TestSyncPropagaOErroDoGuarda(t *testing.T) {
	blocked := errors.New("destino bloqueado: 169.254.169.254 é endereço interno")
	_, err := Sync(context.Background(), Options{
		URL: "http://politica.exemplo/policy.json", Base: managedBase(),
		Fetcher: failingFetcher{err: blocked},
	})
	if !errors.Is(err, blocked) {
		t.Fatalf("erro do guarda perdido no caminho: %v", err)
	}
}
