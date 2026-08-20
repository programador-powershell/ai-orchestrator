// Testes da pergunta bloqueante do supervisor: clarificação e plano aprovável.
//
// O que está em jogo é o contrato pergunta → resposta → continuação:
//
//   - o primeiro input incerto NÃO gasta modelo — vira `ask` com opções do
//     shortlist e o turno acaba ali;
//   - o `reply` com uma opção roda o turno ORIGINAL com a escolha, sem duplicar
//     a fala da pessoa no log — escolha de TRABALHO desce pela delegação do
//     master (a filha nasce, a raiz não vira a IDE) e escolha de conversa
//     responde na própria raiz;
//   - a mensagem normal seguinte MATA a pendência (quem ignorou o cartão já
//     respondeu);
//   - o bloco `aibot:plan` interrompe o turno ANTES de qualquer ferramenta — o
//     modelo que propõe plano e sai executando não propôs nada.
//
// O provedor é roteirizado (scriptedProvider, de delegate_test.go) e CONTA as
// chamadas: metade das garantias daqui é sobre o que NÃO aconteceu.
package supervisor

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"aibot/gateway/internal/eventbus"
	"aibot/gateway/internal/permissions"
	"aibot/gateway/internal/protocol"
	"aibot/gateway/internal/specialist"
	"aibot/gateway/internal/store"
)

/* ------------------------------- harness --------------------------------- */

// askFixture é o supervisor completo de um teste de pergunta bloqueante.
type askFixture struct {
	supervisor *Supervisor
	store      *store.Store
	session    string
	// modelCalls conta as idas ao provedor. Metade dos testes afirma ZERO.
	modelCalls *int32
}

func newAskFixture(t *testing.T, answers []string, registry *Registry) *askFixture {
	t.Helper()
	dataStore, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("abrir o store: %v", err)
	}
	t.Cleanup(func() { dataStore.Close() })

	const sessionID = "s-ask"
	// Sessão SEM especialista: os cenários daqui são de primeiro input.
	if _, err := dataStore.CreateSession(store.SessionMeta{ID: sessionID}); err != nil {
		t.Fatalf("criar sessão: %v", err)
	}

	var calls int32
	server := scriptedProvider(t, answers, func() { atomic.AddInt32(&calls, 1) })
	t.Cleanup(server.Close)

	if registry == nil {
		registry = NewRegistry()
	}
	supervisor := New(Deps{
		Store:  dataStore,
		Bus:    eventbus.New(dataStore),
		Models: scriptedRouter(server.URL),
		Gate:   permissions.NewGate(permissions.DefaultPolicy()),
		Tools:  registry,
		Router: NewRouter(nil, nil),
	})
	return &askFixture{supervisor: supervisor, store: dataStore, session: sessionID, modelCalls: &calls}
}

// askContext falha RÁPIDO: a regressão típica destes cenários trava esperando
// uma aprovação que ninguém vai dar — melhor dez segundos que dez minutos.
func askContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	return ctx
}

// envelopesByKind lê do log os envelopes do verbo dado, na ordem.
func envelopesByKind(t *testing.T, dataStore *store.Store, sessionID string, kind protocol.Kind) []protocol.Envelope {
	t.Helper()
	envelopes, err := dataStore.Since(sessionID, 0, 1000)
	if err != nil {
		t.Fatalf("ler o log: %v", err)
	}
	out := make([]protocol.Envelope, 0, 4)
	for _, envelope := range envelopes {
		if envelope.Kind == kind {
			out = append(out, envelope)
		}
	}
	return out
}

// pendingAskOf devolve a ÚNICA pergunta do log — e reprova se houver mais de
// uma: pergunta duplicada é o cartão reabrindo depois de respondido.
func pendingAskOf(t *testing.T, fixture *askFixture) protocol.Ask {
	t.Helper()
	envelopes := envelopesByKind(t, fixture.store, fixture.session, protocol.KindAsk)
	if len(envelopes) != 1 {
		t.Fatalf("esperava exatamente 1 ask no log, obtive %d", len(envelopes))
	}
	var ask protocol.Ask
	if err := envelopes[0].Decode(&ask); err != nil {
		t.Fatalf("decodificar o ask: %v", err)
	}
	return ask
}

// messageTexts devolve os textos das mensagens de um papel, na ordem.
func messageTexts(t *testing.T, dataStore *store.Store, sessionID, role string) []string {
	t.Helper()
	out := make([]string, 0, 4)
	for _, envelope := range envelopesByKind(t, dataStore, sessionID, protocol.KindMessage) {
		var message protocol.Message
		if err := envelope.Decode(&message); err != nil {
			t.Fatalf("decodificar mensagem: %v", err)
		}
		if message.Role == role {
			out = append(out, message.Text)
		}
	}
	return out
}

func countOf(values []string, want string) int {
	count := 0
	for _, value := range values {
		if value == want {
			count++
		}
	}
	return count
}

// clarifyLabelOf é o rótulo que a clarificação monta para um especialista — o
// teste o reconstrói da MESMA fonte (o catálogo) para não fixar texto em dois
// lugares.
func clarifyLabelOf(id string) string {
	definition := specialist.GetOrDefault(id)
	return definition.Name + " — " + definition.Tagline
}

/* ----------------------------- clarificação ------------------------------ */

// O primeiro input que cai no fallback NÃO chama modelo nenhum: publica um
// `ask` bloqueante com as opções do shortlist do fast router e encerra o turno.
// A conversa continua SEM dono — gravar um modo agora seria decidir justamente
// o que se acabou de perguntar.
func TestFirstInputFallbackAsksInsteadOfGuessing(t *testing.T) {
	requireNoLexicalSignal(t, noSignalText)
	fixture := newAskFixture(t, []string{"não era para o modelo falar"}, nil)

	if err := fixture.supervisor.Prompt(askContext(t), fixture.session, protocol.Prompt{Text: noSignalText}); err != nil {
		t.Fatalf("Prompt: %v", err)
	}

	if calls := atomic.LoadInt32(fixture.modelCalls); calls != 0 {
		t.Errorf("o supervisor consultou o modelo %d vez(es) — a clarificação existe para custar zero", calls)
	}

	ask := pendingAskOf(t, fixture)
	if !ask.Blocking {
		t.Error("a clarificação precisa ser bloqueante: o turno só continua com a resposta")
	}
	if ask.AskID == "" {
		t.Error("ask sem id não tem como ser respondido")
	}
	if len(ask.Options) < clarifyMinOptions || len(ask.Options) > clarifyMaxOptions {
		t.Fatalf("esperava entre %d e %d opções, obtive %d: %v",
			clarifyMinOptions, clarifyMaxOptions, len(ask.Options), ask.Options)
	}
	// Sem sinal léxico o shortlist é a ordem do catálogo — e cada opção é
	// objetiva: quem é + o que faz, sem exigir que a pessoa conheça o app.
	if ask.Options[0] != clarifyLabelOf("chat") {
		t.Errorf("primeira opção: esperava %q, obtive %q", clarifyLabelOf("chat"), ask.Options[0])
	}

	if routes := envelopesByKind(t, fixture.store, fixture.session, protocol.KindRoute); len(routes) != 0 {
		t.Errorf("a clarificação publicou %d rota(s) — perguntar é justamente NÃO decidir", len(routes))
	}
	if done := envelopesByKind(t, fixture.store, fixture.session, protocol.KindDone); len(done) != 1 {
		t.Errorf("esperava o turno encerrado (1 done), obtive %d", len(done))
	}
	meta, err := fixture.store.GetSession(fixture.session)
	if err != nil {
		t.Fatalf("ler a sessão: %v", err)
	}
	if meta.Specialist != "" {
		t.Errorf("a clarificação gravou o modo %q na conversa antes da resposta", meta.Specialist)
	}
}

// replyWithChoice responde a clarificação pendente com o rótulo do
// especialista dado, reprovando se a opção não estiver no cartão — o cenário
// depende de a escolha existir de verdade.
func replyWithChoice(t *testing.T, ctx context.Context, fixture *askFixture, id string) protocol.Ask {
	t.Helper()
	ask := pendingAskOf(t, fixture)
	choice := clarifyLabelOf(id)
	found := false
	for _, option := range ask.Options {
		if option == choice {
			found = true
		}
	}
	if !found {
		t.Fatalf("o cenário exige a opção %q no ask, obtive: %v", choice, ask.Options)
	}
	if err := fixture.supervisor.Reply(ctx, fixture.session,
		protocol.Reply{AskID: ask.AskID, Answer: choice}); err != nil {
		t.Fatalf("Reply: %v", err)
	}
	return ask
}

// A resposta com uma opção de TRABALHO não adota o modo: escolher "Código" no
// cartão é dizer QUEM TRABALHA, e a raiz DELEGA como se a cascata tivesse
// decidido com confiança 1 — a filha nasce (com pai, dono e pasta de projeto
// provisionada), a rota "clarified" sai NA FILHA e a raiz continua sem dono.
// Era exatamente aqui que a conversa inteira virava a IDE.
func TestReplyEscolhendoTrabalhoDelegaEmVezDeAdotar(t *testing.T) {
	requireNoLexicalSignal(t, noSignalText)
	fixture := newAskFixture(t, []string{"bora nessa"}, nil)
	ctx := askContext(t)

	if err := fixture.supervisor.Prompt(ctx, fixture.session, protocol.Prompt{Text: noSignalText}); err != nil {
		t.Fatalf("Prompt: %v", err)
	}
	ask := replyWithChoice(t, ctx, fixture, "code")

	if calls := atomic.LoadInt32(fixture.modelCalls); calls != 1 {
		t.Errorf("esperava 1 chamada de modelo (o sub-turno do delegado), obtive %d", calls)
	}

	// A FILHA: pendurada na raiz, do bot, e com pasta de projeto NÃO-vazia —
	// a sessão nasceu sem cwd, então a pasta veio do workspace automático e
	// mora dentro de <dataDir>/projects.
	filhoID := store.ChildSessionID(fixture.session, "code")
	filho, err := fixture.store.GetSession(filhoID)
	if err != nil {
		t.Fatalf("a escolha de trabalho não abriu a conversa filha: %v", err)
	}
	if filho.ParentID != fixture.session || filho.BotID != "code" {
		t.Errorf("a filha não é a conversa do bot pendurada na raiz: %+v", filho)
	}
	if strings.TrimSpace(filho.CWD) == "" {
		t.Error("a filha nasceu sem pasta de projeto — a árvore da IDE abre morta")
	}
	projetos := filepath.Join(fixture.store.Root(), "projects") + string(filepath.Separator)
	if !strings.HasPrefix(filho.CWD, projetos) {
		t.Errorf("a pasta provisionada tinha de morar em %q, obtive %q", projetos, filho.CWD)
	}
	if info, err := os.Stat(filho.CWD); err != nil || !info.IsDir() {
		t.Errorf("a pasta provisionada não existe no disco: %v", err)
	}

	// A rota mora NA FILHA e conta de onde a decisão veio: clarified, com a
	// confiança de quem respondeu — a raiz não recebe rota nenhuma.
	if rotas := envelopesByKind(t, fixture.store, fixture.session, protocol.KindRoute); len(rotas) != 0 {
		t.Errorf("a raiz recebeu %d rota(s) — a superfície de trabalho é da filha", len(rotas))
	}
	rotas := envelopesByKind(t, fixture.store, filhoID, protocol.KindRoute)
	if len(rotas) != 1 {
		t.Fatalf("esperava 1 rota na filha, obtive %d", len(rotas))
	}
	var rota protocol.Route
	if err := rotas[0].Decode(&rota); err != nil {
		t.Fatalf("decodificar a rota da filha: %v", err)
	}
	if rota.Reason != protocol.RouteClarified || rota.Specialist != "code" || rota.Confidence != 1 {
		t.Errorf("esperava code/clarified/1 na filha, obtive %q/%q/%v",
			rota.Specialist, rota.Reason, rota.Confidence)
	}

	// A RAIZ segue orquestradora: sem dono, com o espelho da delegação e a fala
	// original UMA vez só (ela já estava no log desde o turno da pergunta).
	meta, err := fixture.store.GetSession(fixture.session)
	if err != nil {
		t.Fatalf("ler a sessão: %v", err)
	}
	if meta.Specialist != "" {
		t.Errorf("a escolha da clarificação virou o modo %q — o master delega, não adota", meta.Specialist)
	}
	if delegations := envelopesByKind(t, fixture.store, fixture.session, protocol.KindDelegate); len(delegations) != 2 {
		t.Errorf("esperava o par abre/fecha da delegação na raiz, obtive %d", len(delegations))
	}
	users := messageTexts(t, fixture.store, fixture.session, "user")
	if countOf(users, noSignalText) != 1 {
		t.Errorf("a fala original tinha de aparecer UMA vez no log, apareceu %d: %v",
			countOf(users, noSignalText), users)
	}
	if replies := envelopesByKind(t, fixture.store, fixture.session, protocol.KindReply); len(replies) != 1 {
		t.Errorf("esperava o eco do reply no log (fecha o cartão nas outras janelas), obtive %d", len(replies))
	}

	// A pendência foi consumida: responder de novo é erro com motivo, não um
	// segundo turno fantasma.
	if err := fixture.supervisor.Reply(ctx, fixture.session,
		protocol.Reply{AskID: ask.AskID, Answer: clarifyLabelOf("code")}); err == nil {
		t.Error("Reply repetido deveria falhar — a pendência já foi consumida")
	}
}

// A resposta escolhendo CONVERSA responde na própria raiz: pergunta não
// precisa de conversa lateral nem de pasta de projeto — o chat atende onde a
// pessoa está, sem filha e sem delegação.
func TestReplyEscolhendoConversaRespondeNaRaiz(t *testing.T) {
	requireNoLexicalSignal(t, noSignalText)
	fixture := newAskFixture(t, []string{"bora nessa"}, nil)
	ctx := askContext(t)

	if err := fixture.supervisor.Prompt(ctx, fixture.session, protocol.Prompt{Text: noSignalText}); err != nil {
		t.Fatalf("Prompt: %v", err)
	}
	replyWithChoice(t, ctx, fixture, "chat")

	if calls := atomic.LoadInt32(fixture.modelCalls); calls != 1 {
		t.Errorf("esperava 1 chamada de modelo (a continuação), obtive %d", calls)
	}
	if delegations := envelopesByKind(t, fixture.store, fixture.session, protocol.KindDelegate); len(delegations) != 0 {
		t.Errorf("a escolha de conversa virou delegação: %d envelope(s)", len(delegations))
	}
	if _, err := fixture.store.GetSession(store.ChildSessionID(fixture.session, "chat")); err == nil {
		t.Error("a escolha de conversa abriu conversa filha")
	}
	assistants := messageTexts(t, fixture.store, fixture.session, "assistant")
	if countOf(assistants, "bora nessa") != 1 {
		t.Errorf("a resposta tinha de sair NA raiz: %v", assistants)
	}
}

// O reply com TEXTO LIVRE não escolhe prateleira: vira o prompt de continuação
// com o pedido original anexado, e só a resposta entra como fala nova no log.
func TestReplyWithFreeTextBecomesContinuationPrompt(t *testing.T) {
	requireNoLexicalSignal(t, noSignalText)
	// A continuação de texto livre roteia pela CASCATA (não é escolha explícita),
	// então o master PLANEJA antes de delegar (ver master_plan.go): as duas
	// primeiras falas do roteiro são a chamada de planejamento e o retry — aqui
	// inválidas de propósito, para o caminho cair no item único de sempre.
	fixture := newAskFixture(t, []string{"sem plano", "sem plano", "aqui está"}, nil)
	ctx := askContext(t)

	if err := fixture.supervisor.Prompt(ctx, fixture.session, protocol.Prompt{Text: noSignalText}); err != nil {
		t.Fatalf("Prompt: %v", err)
	}
	ask := pendingAskOf(t, fixture)

	const freeText = "quero um relatorio mensal de vendas"
	if err := fixture.supervisor.Reply(ctx, fixture.session,
		protocol.Reply{AskID: ask.AskID, Answer: freeText}); err != nil {
		t.Fatalf("Reply: %v", err)
	}

	if calls := atomic.LoadInt32(fixture.modelCalls); calls != 3 {
		t.Errorf("esperava 3 chamadas na continuação (planejamento + retry + sub-turno), obtive %d", calls)
	}
	users := messageTexts(t, fixture.store, fixture.session, "user")
	if countOf(users, freeText) != 1 || countOf(users, noSignalText) != 1 {
		t.Errorf("esperava a fala original e a resposta livre UMA vez cada, obtive: %v", users)
	}
	// E não nasce uma segunda pergunta: quem já clarificou uma vez não entra em
	// laço de clarificação.
	if asks := envelopesByKind(t, fixture.store, fixture.session, protocol.KindAsk); len(asks) != 1 {
		t.Errorf("a continuação reabriu a clarificação: %d asks no log", len(asks))
	}
}

// A mensagem normal seguinte MATA a pendência: quem ignorou o cartão e seguiu
// escrevendo já respondeu — a mensagem nova é a resposta. O reply atrasado da
// pergunta morta falha com motivo em vez de rodar um turno fantasma.
func TestNewMessageKillsPendingClarification(t *testing.T) {
	requireNoLexicalSignal(t, noSignalText)
	// A mensagem clara desce pela cascata e o master PLANEJA antes de delegar
	// (ver master_plan.go): as duas primeiras falas são o planejamento e o
	// retry, inválidos de propósito — o caminho cai no item único de sempre.
	fixture := newAskFixture(t, []string{"sem plano", "sem plano", "revisando a vulnerabilidade"}, nil)
	ctx := askContext(t)

	if err := fixture.supervisor.Prompt(ctx, fixture.session, protocol.Prompt{Text: noSignalText}); err != nil {
		t.Fatalf("Prompt: %v", err)
	}
	ask := pendingAskOf(t, fixture)

	// A pessoa ignora a pergunta e manda um pedido claro. Ele roteia para o
	// especialista de TRABALHO (security) — e numa raiz sem modo isso vira a
	// delegação do master: a filha nasce, a raiz continua sem dono.
	if err := fixture.supervisor.Prompt(ctx, fixture.session, protocol.Prompt{Text: xssText}); err != nil {
		t.Fatalf("Prompt normal: %v", err)
	}

	if _, err := fixture.store.GetSession(store.ChildSessionID(fixture.session, "security")); err != nil {
		t.Fatalf("a mensagem clara tinha de rotear normalmente — a filha de security não nasceu: %v", err)
	}
	meta, err := fixture.store.GetSession(fixture.session)
	if err != nil {
		t.Fatalf("ler a sessão: %v", err)
	}
	if meta.Specialist != "" {
		t.Fatalf("a raiz ganhou o dono %q — o master delega, não adota o modo", meta.Specialist)
	}
	if calls := atomic.LoadInt32(fixture.modelCalls); calls != 3 {
		t.Errorf("esperava 3 chamadas (planejamento + retry + sub-turno do delegado), obtive %d", calls)
	}

	if err := fixture.supervisor.Reply(ctx, fixture.session,
		protocol.Reply{AskID: ask.AskID, Answer: clarifyLabelOf("code")}); err == nil {
		t.Error("o reply da pergunta morta deveria falhar — a mensagem nova já era a resposta")
	}
	if calls := atomic.LoadInt32(fixture.modelCalls); calls != 3 {
		t.Errorf("o reply morto rodou um turno fantasma: %d chamadas de modelo", atomic.LoadInt32(fixture.modelCalls))
	}
}

// Escolha explícita não clarifica: a pessoa JÁ escolheu — perguntar de novo
// seria devolver a ela a decisão que ela acabou de tomar.
func TestExplicitChoiceSkipsClarification(t *testing.T) {
	requireNoLexicalSignal(t, noSignalText)
	fixture := newAskFixture(t, []string{"oi"}, nil)

	if err := fixture.supervisor.Prompt(askContext(t), fixture.session,
		protocol.Prompt{Text: noSignalText, Specialist: "chat"}); err != nil {
		t.Fatalf("Prompt: %v", err)
	}

	if asks := envelopesByKind(t, fixture.store, fixture.session, protocol.KindAsk); len(asks) != 0 {
		t.Errorf("escolha explícita virou pergunta: %d asks no log", len(asks))
	}
	if calls := atomic.LoadInt32(fixture.modelCalls); calls != 1 {
		t.Errorf("esperava o turno normal (1 chamada de modelo), obtive %d", calls)
	}
}

/* --------------------------------- plano --------------------------------- */

// O bloco `aibot:plan` interrompe o turno ANTES de qualquer execução: a
// ferramenta que veio no MESMO texto não roda, o ask sai com o plano no detail
// e as opções fixas, e a aprovação continua o turno com o mesmo dono.
func TestPlanBlockAsksAndDoesNotExecuteToolsBeforeReply(t *testing.T) {
	var wrote int32
	registry := NewRegistry()
	registry.Register("fs.write", "escreve arquivo. args: {path, content}",
		func(context.Context, string, json.RawMessage) (string, error) {
			atomic.AddInt32(&wrote, 1)
			return "ok", nil
		})

	answers := []string{
		"Segue o plano:\n\n" + planFence + "\n1. editar a.go\n2. editar b.go\n```\n\n" +
			toolFence + "\n{\"tool\":\"fs.write\",\"args\":{\"path\":\"a.go\",\"content\":\"x\"}}\n```",
		"executando conforme o plano",
	}
	fixture := newAskFixture(t, answers, registry)
	ctx := askContext(t)

	// Explícito para o cenário ser só de plano — a clarificação tem testes
	// próprios acima.
	if err := fixture.supervisor.Prompt(ctx, fixture.session,
		protocol.Prompt{Text: "reorganiza o pacote de cobrança inteiro", Specialist: "code"}); err != nil {
		t.Fatalf("Prompt: %v", err)
	}

	if executed := atomic.LoadInt32(&wrote); executed != 0 {
		t.Fatalf("a ferramenta rodou %d vez(es) ANTES da aprovação do plano", executed)
	}

	ask := pendingAskOf(t, fixture)
	if len(ask.Options) != 2 || ask.Options[0] != planApproveOption || ask.Options[1] != planAdjustOption {
		t.Fatalf("esperava as opções [%s %s], obtive %v", planApproveOption, planAdjustOption, ask.Options)
	}
	if !strings.Contains(ask.Detail, "1. editar a.go") {
		t.Errorf("o plano não chegou no detail do ask: %q", ask.Detail)
	}
	if !ask.Blocking {
		t.Error("a aprovação de plano precisa ser bloqueante")
	}

	// A mensagem da conversa mantém o plano (é ele que a pessoa lê) e esconde o
	// bloco de ferramenta (protocolo de máquina).
	assistants := messageTexts(t, fixture.store, fixture.session, "assistant")
	if len(assistants) != 1 || !strings.Contains(assistants[0], "1. editar a.go") {
		t.Errorf("o plano sumiu da mensagem: %v", assistants)
	}
	if strings.Contains(assistants[0], "fs.write") {
		t.Errorf("o bloco de ferramenta vazou para a conversa: %q", assistants[0])
	}
	if done := envelopesByKind(t, fixture.store, fixture.session, protocol.KindDone); len(done) != 1 {
		t.Errorf("o turno do plano tinha de encerrar (1 done), obtive %d", len(done))
	}

	// Aprovar continua o turno com o MESMO dono e a instrução vira fala da
	// pessoa — é lendo ela que o modelo sabe que pode executar.
	if err := fixture.supervisor.Reply(ctx, fixture.session,
		protocol.Reply{AskID: ask.AskID, Answer: planApproveOption}); err != nil {
		t.Fatalf("Reply: %v", err)
	}

	if calls := atomic.LoadInt32(fixture.modelCalls); calls != 2 {
		t.Errorf("esperava 2 chamadas de modelo (plano + continuação), obtive %d", calls)
	}
	if executed := atomic.LoadInt32(&wrote); executed != 0 {
		t.Errorf("a continuação roteirizada não chama ferramenta, mas fs.write rodou %d vez(es)", executed)
	}
	users := messageTexts(t, fixture.store, fixture.session, "user")
	if countOf(users, planApprovedPrompt) != 1 {
		t.Errorf("a aprovação não virou mensagem para o modelo ler: %v", users)
	}
	assistants = messageTexts(t, fixture.store, fixture.session, "assistant")
	if countOf(assistants, "executando conforme o plano") != 1 {
		t.Errorf("a continuação não respondeu: %v", assistants)
	}
	meta, err := fixture.store.GetSession(fixture.session)
	if err != nil {
		t.Fatalf("ler a sessão: %v", err)
	}
	if meta.Specialist != "code" {
		t.Errorf("o plano trocou o dono da conversa para %q", meta.Specialist)
	}
}

// Especialista SEM ferramenta de escrita não recebe o contrato de plano — e um
// bloco `aibot:plan` ecoado por ele não congela o turno esperando aprovação.
func TestPlanBlockFromReadOnlySpecialistIsJustText(t *testing.T) {
	answers := []string{"olha um exemplo:\n\n" + planFence + "\n1. um passo\n```"}
	fixture := newAskFixture(t, answers, nil)

	if err := fixture.supervisor.Prompt(askContext(t), fixture.session,
		protocol.Prompt{Text: "me mostra um exemplo de plano", Specialist: "security"}); err != nil {
		t.Fatalf("Prompt: %v", err)
	}

	if asks := envelopesByKind(t, fixture.store, fixture.session, protocol.KindAsk); len(asks) != 0 {
		t.Errorf("o eco de plano de um especialista só-leitura virou pergunta: %d asks", len(asks))
	}
	if done := envelopesByKind(t, fixture.store, fixture.session, protocol.KindDone); len(done) != 1 {
		t.Errorf("o turno tinha de terminar normalmente, obtive %d done", len(done))
	}
}

/* ------------------------------- unidades -------------------------------- */

func TestParsePlan(t *testing.T) {
	cases := []struct {
		name     string
		in       string
		wantPlan string
		wantOK   bool
	}{
		{"bloco válido", "texto\n" + planFence + "\n1. a\n2. b\n```\nresto", "1. a\n2. b", true},
		{"sem bloco", "resposta comum", "", false},
		// Truncado é o modelo cortado no meio: aprovar plano truncado seria
		// aprovar outra coisa.
		{"bloco não fechado", planFence + "\n1. a", "", false},
		{"bloco vazio não é plano", planFence + "\n\n```", "", false},
	}
	for _, each := range cases {
		t.Run(each.name, func(t *testing.T) {
			plan, ok := parsePlan(each.in)
			if ok != each.wantOK || plan != each.wantPlan {
				t.Errorf("parsePlan(%q): esperava (%q, %v), obteve (%q, %v)",
					each.in, each.wantPlan, each.wantOK, plan, ok)
			}
		})
	}
}

// O contrato de plano segue a ferramenta de escrita: quem altera arquivo
// planeja; quem só lê (security) ou só anota memória (chat) não é convidado a
// planejar o que não pode executar.
func TestPlanContractOnlyForWriters(t *testing.T) {
	supervisor := New(Deps{Gate: permissions.NewGate(permissions.DefaultPolicy())})

	if contract := supervisor.planContract(specialist.GetOrDefault("code")); !strings.Contains(contract, planFence) {
		t.Errorf("code altera arquivos e ficou sem contrato de plano: %q", contract)
	}
	for _, id := range []string{"security", "chat"} {
		if contract := supervisor.planContract(specialist.GetOrDefault(id)); contract != "" {
			t.Errorf("%s não altera arquivo do projeto e recebeu contrato de plano: %q", id, contract)
		}
	}

	// Com as ferramentas de agente desligadas pela política não há o que
	// planejar: o contrato some para todo mundo.
	policy := permissions.DefaultPolicy()
	policy.AgentTools = false
	disarmed := New(Deps{Gate: permissions.NewGate(policy)})
	if contract := disarmed.planContract(specialist.GetOrDefault("code")); contract != "" {
		t.Errorf("sem AgentTools o contrato de plano tinha de sumir, obtive: %q", contract)
	}
}
