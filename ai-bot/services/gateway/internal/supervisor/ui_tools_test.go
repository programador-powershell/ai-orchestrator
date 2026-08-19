// Testes do destravador da Onda 4 — a UI chamando ferramenta fora do turno.
//
// O que cada teste guarda:
//
//   - a WHITELIST é a fronteira nova, e a recusa dela não pode nem sujar o log;
//   - leitura passa direto (política "edições"), mas deixa os envelopes
//     tool.call/tool.result auditáveis, com o ator da UI e o turno próprio;
//   - escrita PENDE no MESMO approval.request do turno, executa depois do sim
//     e recusa quando ninguém decide dentro do prazo — silêncio não é
//     consentimento, nem vindo de rota;
//   - o catálogo do especialista continua valendo por cima da whitelist;
//   - o one-shot de autocomplete respeita o teto duro de 512 tokens e não
//     escreve nada no log da conversa.
package supervisor

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"aibot/gateway/internal/eventbus"
	"aibot/gateway/internal/modelrouter"
	"aibot/gateway/internal/permissions"
	"aibot/gateway/internal/protocol"
	"aibot/gateway/internal/store"
	"aibot/gateway/internal/workspace"
)

// uiToolsHarness monta o supervisor mínimo do caminho de ferramenta pela UI:
// store + bus (o executeTool emite envelopes DURÁVEIS), portão com a política
// padrão ("edições" — leitura passa, escrita pergunta), o Toolbox real e o
// gerente de workspace que congela a pasta da sessão, como no turno.
func uiToolsHarness(t *testing.T, specialistID string) (*Supervisor, *store.Store, string, string) {
	t.Helper()
	dataStore, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("abrir o store: %v", err)
	}
	t.Cleanup(func() { _ = dataStore.Close() })

	projeto := t.TempDir()
	const sessionID = "s-ui"
	if _, err := dataStore.CreateSession(store.SessionMeta{
		ID: sessionID, CWD: projeto, Specialist: specialistID,
	}); err != nil {
		t.Fatalf("criar sessão: %v", err)
	}

	registry := NewRegistry()
	(&Toolbox{}).Install(registry)
	sup := New(Deps{
		Store: dataStore,
		Bus:   eventbus.New(dataStore),
		Gate:  permissions.NewGate(permissions.DefaultPolicy()),
		Tools: registry,
		Workspaces: workspace.NewManager(func(id string) string {
			meta, err := dataStore.GetSession(id)
			if err != nil {
				return ""
			}
			return meta.CWD
		}),
	})
	return sup, dataStore, sessionID, projeto
}

// uiEnvelopes lê o log inteiro da sessão, paginado — o teste afirma sobre o que
// ficou DURÁVEL, que é o contrato de auditoria da rota.
func uiEnvelopes(t *testing.T, dataStore *store.Store, sessionID string) []protocol.Envelope {
	t.Helper()
	var out []protocol.Envelope
	var from uint64
	for {
		batch, err := dataStore.Since(sessionID, from, store.MaxEventBatch)
		if err != nil {
			t.Fatalf("ler o log: %v", err)
		}
		if len(batch) == 0 {
			return out
		}
		out = append(out, batch...)
		from = batch[len(batch)-1].Seq
		if len(batch) < store.MaxEventBatch {
			return out
		}
	}
}

// waitUIApproval espera o approval.request aparecer no log e devolve o callID —
// é o mesmo cartão que o cliente desenha, lido pelo mesmo canal durável.
func waitUIApproval(t *testing.T, dataStore *store.Store, sessionID string) string {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		for _, envelope := range uiEnvelopes(t, dataStore, sessionID) {
			if envelope.Kind != protocol.KindApprovalRequest {
				continue
			}
			var request protocol.ApprovalRequest
			if err := envelope.Decode(&request); err != nil {
				t.Fatalf("decodificar approval.request: %v", err)
			}
			return request.CallID
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("o approval.request nunca chegou ao log")
	return ""
}

/* -------------------------------- whitelist ------------------------------- */

func TestCallToolFromUIRecusaForaDaWhitelist(t *testing.T) {
	sup, dataStore, sessionID, _ := uiToolsHarness(t, "code")
	antes, err := dataStore.LastSeq(sessionID)
	if err != nil {
		t.Fatalf("ler o seq inicial: %v", err)
	}

	// proc.run e git.commit estão no CATÁLOGO do especialista code — a recusa
	// aqui prova que a whitelist é uma fronteira própria, mais estreita que o
	// catálogo, e que nem aprovação humana a atravessa (nunca chega a pedir).
	for _, tool := range []string{"proc.run", "git.commit", "mcp.call", "memory.write", "worktree.remove"} {
		result, err := sup.CallToolFromUI(context.Background(), sessionID, tool, nil)
		if err != nil {
			t.Fatalf("%s: recusa de whitelist não é erro de infraestrutura: %v", tool, err)
		}
		if result.OK {
			t.Fatalf("%s: fora da whitelist tinha de recusar", tool)
		}
		if !strings.Contains(result.Error, tool) || !strings.Contains(result.Error, "fs.read") {
			t.Fatalf("%s: a recusa tinha de citar a ferramenta e a lista permitida, veio %q", tool, result.Error)
		}
	}

	// E o log fica INTACTO: a recusa de contrato da rota não pode ser um jeito
	// de encher a conversa de envelopes sem passar por portão nenhum.
	depois, err := dataStore.LastSeq(sessionID)
	if err != nil {
		t.Fatalf("ler o seq final: %v", err)
	}
	if depois != antes {
		t.Fatalf("a recusa de whitelist sujou o log: seq %d → %d", antes, depois)
	}
}

/* --------------------------------- leitura -------------------------------- */

// Leitura passa direto na política "edições" — e mesmo passando direto deixa o
// par tool.call/tool.result no log, com o ator da UI e o turno próprio. A
// sessão nasce SEM modo de propósito: o vazio tem de cair no "code".
func TestCallToolFromUILeituraPassaDiretoEDeixaEnvelopes(t *testing.T) {
	sup, dataStore, sessionID, projeto := uiToolsHarness(t, "")
	if err := os.WriteFile(filepath.Join(projeto, "leia.txt"), []byte("conteúdo pela rota"), 0o644); err != nil {
		t.Fatalf("preparar o projeto: %v", err)
	}

	args, _ := json.Marshal(map[string]string{"path": "leia.txt"})
	result, err := sup.CallToolFromUI(context.Background(), sessionID, "fs.read", args)
	if err != nil {
		t.Fatalf("fs.read pela UI: %v", err)
	}
	if !result.OK || !strings.Contains(result.Output, "conteúdo pela rota") {
		t.Fatalf("a leitura tinha de passar direto com o conteúdo, veio %+v", result)
	}

	var call, toolResult *protocol.Envelope
	for _, envelope := range uiEnvelopes(t, dataStore, sessionID) {
		envelope := envelope
		switch envelope.Kind {
		case protocol.KindToolCall:
			call = &envelope
		case protocol.KindToolResult:
			toolResult = &envelope
		}
	}
	if call == nil || toolResult == nil {
		t.Fatal("a chamada pela UI tinha de deixar tool.call E tool.result no log")
	}
	if call.Turn == "" || call.Turn != toolResult.Turn || !strings.HasPrefix(call.Turn, "ui-") {
		t.Fatalf("os envelopes tinham de compartilhar um turno próprio da UI, veio %q e %q", call.Turn, toolResult.Turn)
	}
	// A auditoria distingue a ORIGEM: quem pediu foi a pessoa pela interface,
	// sob o especialista da sessão (vazio caiu no code).
	if call.From.Kind != protocol.ActorUser || call.From.ID != "ui" || call.From.Specialist != "code" {
		t.Fatalf("o ator do tool.call tinha de ser a UI sob o code, veio %+v", call.From)
	}
	var payload protocol.ToolResult
	if err := toolResult.Decode(&payload); err != nil || !payload.OK {
		t.Fatalf("o tool.result durável tinha de registrar sucesso: %v / %+v", err, payload)
	}
}

/* --------------------------------- escrita -------------------------------- */

// Escrita pende no MESMO approval.request do turno; o sim executa e a decisão
// vira envelope durável — a rota é outro chamador do funil, não um atalho.
func TestCallToolFromUIEscritaPendeAprovacaoEExecutaAposOSim(t *testing.T) {
	sup, dataStore, sessionID, projeto := uiToolsHarness(t, "code")
	args, _ := json.Marshal(map[string]string{"path": "novo.txt", "content": "gravado pela UI"})

	type outcome struct {
		result UIToolResult
		err    error
	}
	done := make(chan outcome, 1)
	go func() {
		result, err := sup.CallToolFromUI(context.Background(), sessionID, "fs.write", args)
		done <- outcome{result, err}
	}()

	callID := waitUIApproval(t, dataStore, sessionID)

	// Enquanto o cartão está aberto, NADA foi escrito: o portão suspende a
	// execução, não a registra para depois.
	if _, err := os.Stat(filepath.Join(projeto, "novo.txt")); err == nil {
		t.Fatal("a escrita rodou antes de alguém aprovar")
	}

	if err := sup.Decide(protocol.ApprovalDecision{CallID: callID, Allow: true, Scope: "once"}); err != nil {
		t.Fatalf("entregar a decisão: %v", err)
	}

	select {
	case got := <-done:
		if got.err != nil {
			t.Fatalf("a chamada falhou depois do sim: %v", got.err)
		}
		if !got.result.OK {
			t.Fatalf("aprovada, a escrita tinha de executar: %+v", got.result)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("aprovação dada e a chamada nunca voltou")
	}

	content, err := os.ReadFile(filepath.Join(projeto, "novo.txt"))
	if err != nil || string(content) != "gravado pela UI" {
		t.Fatalf("o arquivo tinha de existir com o conteúdo aprovado: %v / %q", err, content)
	}

	// A decisão humana fica durável — é o registro do último degrau antes do
	// efeito colateral, igual ao turno.
	temDecisao := false
	for _, envelope := range uiEnvelopes(t, dataStore, sessionID) {
		if envelope.Kind == protocol.KindApprovalDecision {
			temDecisao = true
		}
	}
	if !temDecisao {
		t.Fatal("o approval.decision tinha de estar no log")
	}
}

// Ninguém decidiu dentro do prazo da rota → recusa, nunca liberação. O prazo
// curto do teste simula o deadline de 2 minutos do transporte: o contexto
// expira e o supervisor lê o silêncio como não.
func TestCallToolFromUIRecusaQuandoNinguemDecideNoPrazo(t *testing.T) {
	sup, _, sessionID, projeto := uiToolsHarness(t, "code")
	args, _ := json.Marshal(map[string]string{"path": "nunca.txt", "content": "não era para gravar"})

	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()

	result, err := sup.CallToolFromUI(ctx, sessionID, "fs.write", args)
	if err != nil {
		t.Fatalf("timeout de aprovação não é erro de infraestrutura: %v", err)
	}
	if result.OK {
		t.Fatal("silêncio não é consentimento: a escrita tinha de ser recusada")
	}
	if !strings.Contains(result.Error, "decis") {
		t.Fatalf("a recusa tinha de explicar que ninguém decidiu, veio %q", result.Error)
	}
	if _, err := os.Stat(filepath.Join(projeto, "nunca.txt")); err == nil {
		t.Fatal("o arquivo foi gravado apesar da recusa")
	}
}

/* ------------------------- catálogo por cima da lista ---------------------- */

// flow.validate ESTÁ na whitelist, mas o especialista da sessão (code) não a
// tem no catálogo — o Gate recusa, e a recusa do funil fica no log, ao
// contrário da recusa de whitelist, que nem chega a entrar.
func TestCallToolFromUIRespeitaOCatalogoDoEspecialista(t *testing.T) {
	sup, dataStore, sessionID, _ := uiToolsHarness(t, "code")

	result, err := sup.CallToolFromUI(context.Background(), sessionID, "flow.validate", nil)
	if err != nil {
		t.Fatalf("recusa de catálogo não é erro de infraestrutura: %v", err)
	}
	if result.OK {
		t.Fatal("o catálogo do especialista tinha de valer por cima da whitelist")
	}
	if !strings.Contains(result.Error, "flow.validate") {
		t.Fatalf("a recusa tinha de citar a ferramenta, veio %q", result.Error)
	}

	temResultado := false
	for _, envelope := range uiEnvelopes(t, dataStore, sessionID) {
		if envelope.Kind != protocol.KindToolResult {
			continue
		}
		var payload protocol.ToolResult
		if err := envelope.Decode(&payload); err == nil && !payload.OK {
			temResultado = true
		}
	}
	if !temResultado {
		t.Fatal("a recusa do portão tinha de ficar auditável como tool.result no log")
	}
}

/* ------------------------------- autocomplete ------------------------------ */

// uiFakeProvider responde como um provedor OpenAI de mentira e CAPTURA o
// max_tokens que chegou no pedido — é a única forma de provar que o teto foi
// aplicado do lado de quem paga, e não confiado ao cliente.
func uiFakeProvider(t *testing.T, answer string, sawMaxTokens *atomic.Int64) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			MaxTokens *int `json:"max_tokens"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("pedido ilegível no provedor de mentira: %v", err)
		}
		if body.MaxTokens != nil {
			sawMaxTokens.Store(int64(*body.MaxTokens))
		} else {
			sawMaxTokens.Store(0)
		}
		chunk, err := json.Marshal(map[string]any{
			"choices": []map[string]any{{"delta": map[string]any{"content": answer}}},
		})
		if err != nil {
			t.Errorf("montar o chunk: %v", err)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprintf(w, "data: %s\n\n", chunk)
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
}

func uiCompletionRouter(base string) *modelrouter.Router {
	router := modelrouter.New(http.DefaultClient, nil)
	router.SetProviders([]modelrouter.Provider{
		{ID: "fake", Kind: modelrouter.KindOpenAI, BaseURL: base, Enabled: true},
	})
	router.SetModels([]modelrouter.Entry{
		{Model: protocol.Model{ID: "m1", Provider: "fake", Label: "Modelo"}, ProviderID: "fake"},
	})
	return router
}

func TestCompleteFromUIRespeitaOTetoESaiDoLog(t *testing.T) {
	dataStore, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("abrir o store: %v", err)
	}
	defer dataStore.Close()
	const sessionID = "s-fim"
	if _, err := dataStore.CreateSession(store.SessionMeta{
		ID: sessionID, Specialist: "code", Model: "m1",
	}); err != nil {
		t.Fatalf("criar sessão: %v", err)
	}

	var visto atomic.Int64
	visto.Store(-1)
	provider := uiFakeProvider(t, "sugestao()", &visto)
	t.Cleanup(provider.Close)

	sup := New(Deps{Store: dataStore, Models: uiCompletionRouter(provider.URL)})

	antes, err := dataStore.LastSeq(sessionID)
	if err != nil {
		t.Fatalf("ler o seq inicial: %v", err)
	}

	// Pedido acima do teto cai NO teto — 512 é duro, não sugestão.
	text, err := sup.CompleteFromUI(context.Background(), sessionID, "complete a função de soma", 4096)
	if err != nil {
		t.Fatalf("completar: %v", err)
	}
	if text != "sugestao()" {
		t.Fatalf("texto do provedor: veio %q", text)
	}
	if got := visto.Load(); got != 512 {
		t.Fatalf("o provedor tinha de receber max_tokens=512, recebeu %d", got)
	}

	// Pedido dentro do teto passa como veio; ausente (zero) também cai no teto.
	if _, err := sup.CompleteFromUI(context.Background(), sessionID, "de novo", 64); err != nil {
		t.Fatalf("completar com teto menor: %v", err)
	}
	if got := visto.Load(); got != 64 {
		t.Fatalf("pedido de 64 tokens tinha de passar intacto, virou %d", got)
	}
	if _, err := sup.CompleteFromUI(context.Background(), sessionID, "sem teto pedido", 0); err != nil {
		t.Fatalf("completar sem maxTokens: %v", err)
	}
	if got := visto.Load(); got != 512 {
		t.Fatalf("maxTokens ausente tinha de cair no teto de 512, virou %d", got)
	}

	// Prompt vazio é recusado antes de gastar chamada.
	if _, err := sup.CompleteFromUI(context.Background(), sessionID, "   ", 10); err == nil {
		t.Fatal("prompt vazio tinha de ser recusado")
	}

	// E NADA disso entrou no log da conversa: autocomplete é efêmero, como os
	// deltas — um envelope por tecla afogaria a conversa em ruído.
	depois, err := dataStore.LastSeq(sessionID)
	if err != nil {
		t.Fatalf("ler o seq final: %v", err)
	}
	if depois != antes {
		t.Fatalf("o autocomplete sujou o log: seq %d → %d", antes, depois)
	}
}
