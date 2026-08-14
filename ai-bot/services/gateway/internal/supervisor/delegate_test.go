// Testes da delegação entre especialistas.
//
// A ordem dos testes é a ordem do risco. Primeiro o parser, porque ele lê texto
// gerado por modelo — o único lugar do turno onde a entrada é adversarial por
// natureza (bloco cortado no meio, JSON quase certo, cerca dentro de cerca) e
// onde o erro é silencioso: um bloco mal lido chama OUTRO especialista, ou pede
// a ele outra coisa, e ninguém percebe até a resposta vir estranha.
//
// Depois os limites, que são a parte que precisa estar certa mesmo sem modelo,
// sem rede e sem sessão. Eles não são conforto de execução: sem o teto de
// profundidade, dois especialistas que se acham incompetentes um para o assunto
// do outro delegam em pingue-pongue até o orçamento acabar; sem a recusa por
// política, a delegação seria a porta pela qual um especialista barrado pelo
// admin voltaria para a conversa — chamado por um colega em vez de escolhido
// pelo master.
package supervisor

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"aibot/gateway/internal/eventbus"
	"aibot/gateway/internal/modelrouter"
	"aibot/gateway/internal/permissions"
	"aibot/gateway/internal/protocol"
	"aibot/gateway/internal/specialist"
	"aibot/gateway/internal/store"
)

/* ------------------------------ auxiliares ------------------------------ */

// allowAll é a política que não barra ninguém — o padrão do produto (lista de
// especialistas vazia significa todos).
func allowAll(string) bool { return true }

// delegateBlock monta um bloco cercado com o corpo dado, sem cerimônia.
func delegateBlock(body string) string {
	return delegateFence + "\n" + body + "\n```"
}

// goodRequest é o pedido legítimo do qual os testes de limite partem,
// quebrando UMA coisa por vez.
func goodRequest() delegateRequest {
	return delegateRequest{Specialist: "data", Goal: "modele as tabelas de cobrança"}
}

func requireRefusal(t *testing.T, reason, substring string) {
	t.Helper()
	if reason == "" {
		t.Fatalf("esperava recusa contendo %q, a delegação foi liberada", substring)
	}
	if !strings.Contains(reason, substring) {
		t.Fatalf("esperava recusa contendo %q, obtive %q", substring, reason)
	}
}

/* -------------------------------- parser -------------------------------- */

func TestParseDelegationsExtraiOsBlocosNaOrdem(t *testing.T) {
	answer := "Vou precisar de ajuda.\n\n" +
		delegateBlock(`{"specialist":"data","goal":"modele as tabelas","reason":"schema é com ela"}`) +
		"\n\ne também disto:\n\n" +
		delegateBlock(`{"specialist":"security","goal":"revise o login"}`) +
		"\n\nDepois eu junto tudo."

	requests := parseDelegations(answer)

	if len(requests) != 2 {
		t.Fatalf("esperava 2 delegações, obtive %d: %+v", len(requests), requests)
	}
	if requests[0].Specialist != "data" || requests[0].Goal != "modele as tabelas" {
		t.Errorf("primeira delegação: obtive %+v", requests[0])
	}
	if requests[0].Reason != "schema é com ela" {
		t.Errorf("o motivo se perdeu: obtive %q", requests[0].Reason)
	}
	if requests[1].Specialist != "security" || requests[1].Goal != "revise o login" {
		t.Errorf("segunda delegação: obtive %+v", requests[1])
	}
}

// Um bloco que o modelo cortou no meio não pode virar delegação: o JSON
// truncado pode chamar outro especialista, ou pedir a ele outra coisa.
func TestParseDelegationsIgnoraBlocoNaoFechado(t *testing.T) {
	answer := "Antes disto:\n\n" +
		delegateBlock(`{"specialist":"data","goal":"modele as tabelas"}`) +
		"\n\nE agora o modelo cortou:\n\n" +
		delegateFence + "\n{\"specialist\":\"security\",\"goal\":\"revi"

	requests := parseDelegations(answer)

	if len(requests) != 1 {
		t.Fatalf("esperava só a delegação fechada, obtive %d: %+v", len(requests), requests)
	}
	if requests[0].Specialist != "data" {
		t.Errorf("a delegação que sobrou deveria ser a fechada, obtive %+v", requests[0])
	}
}

// JSON inválido NÃO derruba o turno e NÃO é engolido: ele volta como erro para o
// modelo, que é quem tem como corrigir. Engolir faria o modelo repetir o mesmo
// bloco quebrado até o turno acabar.
func TestParseDelegationsGuardaJSONInvalidoParaVoltarAoModelo(t *testing.T) {
	answer := delegateBlock(`{"specialist":"data", "goal":`)

	requests := parseDelegations(answer)

	if len(requests) != 1 {
		t.Fatalf("esperava 1 pedido guardado, obtive %d: %+v", len(requests), requests)
	}
	if requests[0].Specialist != "" {
		t.Errorf("pedido quebrado não pode virar destino: obtive %q", requests[0].Specialist)
	}
	if !strings.Contains(requests[0].raw, `"specialist":"data"`) {
		t.Fatalf("o texto original se perdeu: obtive %q", requests[0].raw)
	}

	reason := delegationRefusal("code", requests[0], firstDelegationDepth, 0, allowAll)
	requireRefusal(t, reason, "JSON válido")
	if !strings.Contains(reason, `"goal":`) {
		t.Errorf("a recusa precisa citar o que veio para o modelo consertar, obtive %q", reason)
	}
}

// Um objeto JSON válido mas sem `specialist` é tão inútil quanto JSON quebrado —
// e cai no mesmo caminho, para o modelo saber o que faltou.
func TestParseDelegationsRecusaBlocoSemEspecialista(t *testing.T) {
	requests := parseDelegations(delegateBlock(`{"goal":"modele as tabelas"}`))

	if len(requests) != 1 {
		t.Fatalf("esperava 1 pedido guardado, obtive %d", len(requests))
	}
	if requests[0].Specialist != "" {
		t.Fatalf("esperava destino vazio, obtive %q", requests[0].Specialist)
	}
	requireRefusal(t, delegationRefusal("code", requests[0], firstDelegationDepth, 0, allowAll), "JSON válido")
}

func TestParseDelegationsSemBlocoNaoInventaNada(t *testing.T) {
	if requests := parseDelegations("resposta comum, sem bloco nenhum"); len(requests) != 0 {
		t.Fatalf("esperava nenhuma delegação, obtive %+v", requests)
	}
}

func TestStripDelegateBlocksPreservaOTextoForaDosBlocos(t *testing.T) {
	answer := "Vou pedir ajuda.\n\n" +
		delegateBlock(`{"specialist":"data","goal":"modele as tabelas"}`) +
		"\n\nEnquanto isso, sigo no código."

	visible := stripDelegateBlocks(answer)

	if strings.Contains(visible, "aibot:delegate") || strings.Contains(visible, "specialist") {
		t.Fatalf("o bloco vazou para o texto da pessoa: %q", visible)
	}
	for _, want := range []string{"Vou pedir ajuda.", "sigo no código."} {
		if !strings.Contains(visible, want) {
			t.Errorf("o texto fora do bloco se perdeu: esperava %q em %q", want, visible)
		}
	}
}

// Bloco aberto e não fechado: o que vem antes dele é texto de verdade e fica; o
// resto é lixo truncado e some.
func TestStripDelegateBlocksCortaNoBlocoNaoFechado(t *testing.T) {
	visible := stripDelegateBlocks("Isto é a resposta.\n\n" + delegateFence + "\n{\"specialist\":\"da")

	if visible != "Isto é a resposta." {
		t.Fatalf("esperava só o texto anterior ao bloco, obtive %q", visible)
	}
}

// A tela e o log da conversa não podem mostrar NENHUM dos dois protocolos.
func TestStripBlocksTiraFerramentaEDelegacao(t *testing.T) {
	answer := "Primeiro leio o arquivo.\n\n" +
		toolFence + "\n{\"tool\":\"fs.read\",\"args\":{\"path\":\"a.go\"}}\n```" +
		"\n\nE peço a modelagem.\n\n" +
		delegateBlock(`{"specialist":"data","goal":"modele as tabelas"}`) +
		"\n\nJá volto."

	visible := stripBlocks(answer)

	for _, forbidden := range []string{"aibot:tool", "aibot:delegate", "fs.read", "specialist"} {
		if strings.Contains(visible, forbidden) {
			t.Errorf("%q vazou para o texto da pessoa: %q", forbidden, visible)
		}
	}
	for _, want := range []string{"Primeiro leio o arquivo.", "E peço a modelagem.", "Já volto."} {
		if !strings.Contains(visible, want) {
			t.Errorf("o texto fora dos blocos se perdeu: esperava %q em %q", want, visible)
		}
	}
}

/* -------------------------------- limites -------------------------------- */

func TestDelegationRefusalLiberaPedidoLegitimo(t *testing.T) {
	if reason := delegationRefusal("code", goodRequest(), firstDelegationDepth, 0, allowAll); reason != "" {
		t.Fatalf("esperava delegação liberada, obtive a recusa %q", reason)
	}
}

// O delegado PODE delegar uma vez; o terceiro nível é recusado com motivo. Sem
// este teto o pingue-pongue entre dois especialistas não termina sozinho.
func TestDelegationRefusalRespeitaOTetoDeProfundidade(t *testing.T) {
	for depth := 1; depth <= maxDelegationDepth; depth++ {
		if reason := delegationRefusal("code", goodRequest(), depth, 0, allowAll); reason != "" {
			t.Errorf("profundidade %d deveria ser aceita, obtive %q", depth, reason)
		}
	}
	reason := delegationRefusal("code", goodRequest(), maxDelegationDepth+1, 0, allowAll)
	requireRefusal(t, reason, "profundidade")
}

func TestDelegationRefusalRespeitaOTetoPorTurno(t *testing.T) {
	for used := 0; used < maxDelegationsPerTurn; used++ {
		if reason := delegationRefusal("code", goodRequest(), firstDelegationDepth, used, allowAll); reason != "" {
			t.Errorf("a %dª delegação do turno deveria ser aceita, obtive %q", used+1, reason)
		}
	}
	reason := delegationRefusal("code", goodRequest(), firstDelegationDepth, maxDelegationsPerTurn, allowAll)
	requireRefusal(t, reason, "delegações por turno")
}

// Delegar para si mesmo é o laço mais barato de todos: o mesmo especialista,
// com o mesmo prompt, respondendo à mesma coisa.
func TestDelegationRefusalRecusaAutodelegacao(t *testing.T) {
	request := goodRequest()
	request.Specialist = "code"

	requireRefusal(t, delegationRefusal("code", request, firstDelegationDepth, 0, allowAll), "si mesmo")
}

func TestDelegationRefusalRecusaEspecialistaInexistente(t *testing.T) {
	request := goodRequest()
	request.Specialist = "juridico"

	requireRefusal(t, delegationRefusal("code", request, firstDelegationDepth, 0, allowAll), "não existe")
}

// O master existe no catálogo, e é justamente por isso que ele precisa de
// recusa própria: ele só decide quem atende — não tem superfície, não tem
// ferramenta e o prompt dele manda responder JSON de roteamento.
func TestDelegationRefusalRecusaDelegarParaOMaster(t *testing.T) {
	request := goodRequest()
	request.Specialist = specialist.MasterID

	requireRefusal(t, delegationRefusal("code", request, firstDelegationDepth, 0, allowAll), "master")
}

// A política da sessão vale para a delegação. Sem isto, um especialista barrado
// pelo admin voltaria para a conversa pela porta de trás — chamado por um
// colega em vez de escolhido pelo master.
func TestDelegationRefusalRecusaEspecialistaForaDaPolitica(t *testing.T) {
	policy := permissions.DefaultPolicy()
	policy.AllowedSpecialists = []string{"code"}
	gate := permissions.NewGate(policy)

	reason := delegationRefusal("code", goodRequest(), firstDelegationDepth, 0, gate.AllowsSpecialist)

	requireRefusal(t, reason, "não está liberado")
	if !strings.Contains(reason, "data") {
		t.Errorf("a recusa precisa dizer QUEM foi barrado, obtive %q", reason)
	}
}

// Delegação sem objetivo entrega ao outro especialista um turno inteiro para
// adivinhar o que fazer — e ele adivinha.
func TestDelegationRefusalRecusaPedidoSemObjetivo(t *testing.T) {
	request := goodRequest()
	request.Goal = "   "

	requireRefusal(t, delegationRefusal("code", request, firstDelegationDepth, 0, allowAll), "sem objetivo")
}

/* -------------------------------- contrato ------------------------------- */

func TestDelegateContractListaOsColegasESoEles(t *testing.T) {
	supervisor := New(Deps{})

	contract := supervisor.delegateContract(specialist.GetOrDefault("code"), firstDelegationDepth)

	if contract == "" {
		t.Fatal("esperava contrato de delegação, veio vazio")
	}
	if !strings.Contains(contract, delegateFence) {
		t.Errorf("o contrato precisa mostrar a cerca %q, obtive:\n%s", delegateFence, contract)
	}
	// A instrução de NÃO pedir permissão é o ponto do recurso: sem ela o modelo
	// pergunta, e perguntar devolve à pessoa o roteamento que o master faz.
	if !strings.Contains(contract, "não precisa pedir permissão") &&
		!strings.Contains(contract, "NÃO precisa pedir permissão") {
		t.Errorf("o contrato precisa dispensar a permissão, obtive:\n%s", contract)
	}
	if !strings.Contains(contract, "- data (Dados): ") {
		t.Errorf("o contrato precisa listar id, nome e vocação, obtive:\n%s", contract)
	}
	if strings.Contains(contract, "- code (") {
		t.Errorf("o contrato listou o próprio especialista, obtive:\n%s", contract)
	}
	if strings.Contains(contract, "- "+specialist.MasterID+" (") {
		t.Errorf("o contrato listou o master, obtive:\n%s", contract)
	}
}

// No último nível o contrato SOME: convidar para o que vai ser recusado gasta
// uma rodada de modelo inteira para dizer não.
func TestDelegateContractSomeNoUltimoNivel(t *testing.T) {
	supervisor := New(Deps{})

	contract := supervisor.delegateContract(specialist.GetOrDefault("code"), maxDelegationDepth+1)

	if contract != "" {
		t.Fatalf("esperava contrato vazio além do teto, obtive:\n%s", contract)
	}
}

func TestDelegateContractRespeitaAPolitica(t *testing.T) {
	policy := permissions.DefaultPolicy()
	policy.AllowedSpecialists = []string{"code", "data"}
	supervisor := New(Deps{Gate: permissions.NewGate(policy)})

	contract := supervisor.delegateContract(specialist.GetOrDefault("code"), firstDelegationDepth)

	if !strings.Contains(contract, "- data (") {
		t.Errorf("o especialista liberado sumiu da lista, obtive:\n%s", contract)
	}
	if strings.Contains(contract, "- security (") {
		t.Errorf("o contrato ofereceu um especialista fora da política, obtive:\n%s", contract)
	}
}

// Política que só libera quem está atendendo não deixa ninguém para chamar — e
// aí o contrato inteiro some, em vez de listar uma lista vazia.
func TestDelegateContractSomeQuandoNaoSobraNinguem(t *testing.T) {
	policy := permissions.DefaultPolicy()
	policy.AllowedSpecialists = []string{"code"}
	supervisor := New(Deps{Gate: permissions.NewGate(policy)})

	if contract := supervisor.delegateContract(specialist.GetOrDefault("code"), firstDelegationDepth); contract != "" {
		t.Fatalf("esperava contrato vazio sem colegas, obtive:\n%s", contract)
	}
}

/* ------------------------------ turno inteiro ---------------------------- */

// scriptedProvider é um provedor OpenAI de mentira: cada chamada consome a
// próxima fala do roteiro. `onCall` roda ANTES da resposta sair, e é por ele que
// o teste observa o estado do log no instante em que o modelo do delegado foi
// realmente acionado.
func scriptedProvider(t *testing.T, answers []string, onCall func()) *httptest.Server {
	t.Helper()
	var mu sync.Mutex
	next := 0

	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if onCall != nil {
			onCall()
		}
		mu.Lock()
		answer := ""
		if next < len(answers) {
			answer = answers[next]
		}
		next++
		mu.Unlock()

		chunk, err := json.Marshal(map[string]any{
			"choices": []map[string]any{{"delta": map[string]any{"content": answer}}},
		})
		if err != nil {
			t.Errorf("montar o chunk do provedor de mentira: %v", err)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprintf(w, "data: %s\n\n", chunk)
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
}

func scriptedRouter(base string) *modelrouter.Router {
	router := modelrouter.New(http.DefaultClient, nil)
	router.SetProviders([]modelrouter.Provider{
		{ID: "fake", Kind: modelrouter.KindOpenAI, BaseURL: base, Enabled: true},
	})
	router.SetModels([]modelrouter.Entry{
		{Model: protocol.Model{ID: "m1", Provider: "fake", Label: "Modelo"}, ProviderID: "fake"},
	})
	return router
}

// delegateEnvelopes devolve os envelopes de delegação do log, na ordem.
func delegateEnvelopes(t *testing.T, dataStore *store.Store, sessionID string) []protocol.Delegate {
	t.Helper()
	envelopes, err := dataStore.Since(sessionID, 0, 1000)
	if err != nil {
		t.Fatalf("ler o log: %v", err)
	}
	out := make([]protocol.Delegate, 0, 2)
	for _, envelope := range envelopes {
		if envelope.Kind != protocol.KindDelegate {
			continue
		}
		var payload protocol.Delegate
		if err := envelope.Decode(&payload); err != nil {
			t.Fatalf("decodificar delegação: %v", err)
		}
		out = append(out, payload)
	}
	return out
}

// O caminho inteiro de uma delegação, e as três coisas que ela promete: o bot
// entra ANTES de rodar (senão o popup anuncia quem já foi embora), a ferramenta
// dele passa pelo portão de aprovação e a conversa NÃO troca de dono.
func TestDelegateAnunciaOBotAntesDeExecutarEDevolveOResultado(t *testing.T) {
	dataStore, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("abrir o store: %v", err)
	}
	defer dataStore.Close()

	const sessionID = "s-delegacao"
	if _, err := dataStore.CreateSession(store.SessionMeta{
		ID: sessionID, Title: "cobrança", Specialist: "code", Model: "m1",
	}); err != nil {
		t.Fatalf("criar sessão: %v", err)
	}

	// Roteiro do delegado: primeiro ele tenta uma ferramenta que NÃO é dele,
	// depois entrega o resultado.
	answers := []string{
		"vou conferir o processo\n\n" + toolFence +
			"\n{\"tool\":\"proc.run\",\"args\":{\"command\":\"psql\"}}\n```",
		"cobranca(id, valor, vencimento) e cobranca_item(id, cobranca_id)",
	}

	// Quantas delegações já estavam no log quando a primeira chamada de modelo
	// do delegado chegou. É a prova de ordem: o popup precisa estar aberto antes.
	var mu sync.Mutex
	openAtFirstCall := -1
	server := scriptedProvider(t, answers, func() {
		mu.Lock()
		defer mu.Unlock()
		if openAtFirstCall >= 0 {
			return
		}
		envelopes, err := dataStore.Since(sessionID, 0, 1000)
		if err != nil {
			t.Errorf("ler o log durante a chamada: %v", err)
			return
		}
		openAtFirstCall = 0
		for _, envelope := range envelopes {
			if envelope.Kind == protocol.KindDelegate {
				openAtFirstCall++
			}
		}
	})
	defer server.Close()

	// Registro vazio de propósito: a ferramenta que o delegado tenta morre no
	// portão, antes de chegar ao registro. É esse o ponto do cenário.
	supervisor := New(Deps{
		Store:  dataStore,
		Bus:    eventbus.New(dataStore),
		Models: scriptedRouter(server.URL),
		Gate:   permissions.NewGate(permissions.DefaultPolicy()),
		Tools:  NewRegistry(),
	})

	// Prazo curto porque a regressão que este teste caça TRAVA em vez de falhar:
	// avaliar a ferramenta com o catálogo de quem delegou (`code` tem `proc.run`)
	// troca a recusa por um pedido de aprovação, e aí o turno fica dez minutos
	// esperando alguém que não existe. Melhor falhar em cinco segundos.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	budget := &delegationBudget{}
	back := supervisor.delegate(ctx, sessionID, "t1",
		specialist.GetOrDefault("code"), goodRequest(), budget, firstDelegationDepth)

	// 1. O resultado volta para quem delegou, como o de uma ferramenta volta.
	if !strings.Contains(back, "cobranca(id, valor, vencimento)") {
		t.Errorf("o resultado do delegado não voltou para quem delegou: %q", back)
	}
	if !strings.Contains(back, "data") {
		t.Errorf("o texto de volta precisa dizer quem respondeu: %q", back)
	}
	if budget.used != 1 {
		t.Errorf("orçamento consumido: esperava 1, obtive %d", budget.used)
	}

	// 2. O popup abre antes de o delegado rodar e fecha com o resultado.
	mu.Lock()
	seen := openAtFirstCall
	mu.Unlock()
	if seen != 1 {
		t.Errorf("no instante da primeira chamada do delegado havia %d delegação(ões) no log, esperava 1 — "+
			"o popup precisa abrir ANTES de o bot rodar", seen)
	}

	delegations := delegateEnvelopes(t, dataStore, sessionID)
	if len(delegations) != 2 {
		t.Fatalf("esperava 2 envelopes de delegação (abre e fecha), obtive %d: %+v", len(delegations), delegations)
	}
	if delegations[0].Done {
		t.Errorf("o primeiro envelope não pode vir concluído: %+v", delegations[0])
	}
	if delegations[0].From != "code" || delegations[0].To != "data" {
		t.Errorf("de/para errado: %+v", delegations[0])
	}
	if delegations[0].Goal != goodRequest().Goal {
		t.Errorf("o objetivo não chegou à tela: %q", delegations[0].Goal)
	}
	if delegations[0].Depth != firstDelegationDepth {
		t.Errorf("profundidade: esperava %d, obtive %d", firstDelegationDepth, delegations[0].Depth)
	}
	if !delegations[1].Done {
		t.Errorf("o segundo envelope precisa fechar a delegação: %+v", delegations[1])
	}
	// O par from+to+goal é o que a tela usa para casar o fim com o começo.
	if delegations[1].From != delegations[0].From ||
		delegations[1].To != delegations[0].To ||
		delegations[1].Goal != delegations[0].Goal {
		t.Errorf("o envelope de fim não casa com o de início:\n%+v\n%+v", delegations[0], delegations[1])
	}
	if !strings.Contains(delegations[1].Result, "cobranca(id, valor, vencimento)") {
		t.Errorf("o resultado não chegou à tela: %q", delegations[1].Result)
	}

	// 3. A FERRAMENTA do delegado passou pelo portão — `data` não tem `proc.run`,
	// e o portão recusou. Sem esta linha, delegar seria a forma barata de escapar
	// da aprovação: bastaria pedir a um colega que tem a ferramenta.
	envelopes, err := dataStore.Since(sessionID, 0, 1000)
	if err != nil {
		t.Fatalf("ler o log: %v", err)
	}
	refused := false
	for _, envelope := range envelopes {
		if envelope.Kind != protocol.KindToolResult {
			continue
		}
		var result protocol.ToolResult
		if err := envelope.Decode(&result); err != nil {
			t.Fatalf("decodificar resultado de ferramenta: %v", err)
		}
		if result.Tool == "proc.run" && !result.OK {
			refused = true
			if envelope.From.Specialist != "data" {
				t.Errorf("a ferramenta foi avaliada como sendo de %q, esperava do delegado",
					envelope.From.Specialist)
			}
		}
	}
	if !refused {
		t.Error("a ferramenta do delegado não passou pelo portão — nenhuma recusa de proc.run no log")
	}

	// 4. O modo GRAVADO na conversa não muda: quem delegou continua dono dela.
	meta, err := dataStore.GetSession(sessionID)
	if err != nil {
		t.Fatalf("ler a sessão: %v", err)
	}
	if meta.Specialist != "code" {
		t.Errorf("a delegação trocou o modo da conversa para %q — delegar é empréstimo, não troca de dono",
			meta.Specialist)
	}
}
