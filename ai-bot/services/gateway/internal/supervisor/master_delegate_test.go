// O contrato do MASTER ORQUESTRADOR: a conversa raiz nunca vira o bot de
// trabalho.
//
// O defeito que este arquivo guarda é o mais reclamado do produto: "construa um
// html" roteava para o Código e a conversa INTEIRA virava a IDE — a pessoa
// ficava presa na superfície do bot. O certo (padrão Grok Bot) é a raiz ficar
// com o master, na superfície de conversa, e o especialista de TRABALHO nascer
// como conversa FILHA aninhada — pela MESMA máquina da delegação bot-a-bot.
//
// As fronteiras do contrato, cada uma com teste próprio abaixo:
//
//   - primeiro input de trabalho na raiz → delegação (filha com CWD herdado,
//     espelho, envelopes, raiz sem dono);
//   - pergunta simples → o chat responde NA raiz, sem filha;
//   - mesmo bot de novo → a MESMA filha continua, com memória;
//   - /mode e hello.specialist são ESCOLHAS → a conversa vira o bot, como hoje;
//   - recusa/falha → fica na raiz, a filha não nasce.
package supervisor

import (
	"net/http"
	"strings"
	"testing"

	"aibot/gateway/internal/eventbus"
	"aibot/gateway/internal/modelrouter"
	"aibot/gateway/internal/permissions"
	"aibot/gateway/internal/protocol"
	"aibot/gateway/internal/specialist"
	"aibot/gateway/internal/store"
)

// pedidoDeTrabalho decide para o Código no fast router ("constr" + o
// entregável "site"), sem modelo e sem clarificação — é o primeiro input do
// cenário da reclamação.
const pedidoDeTrabalho = "construa um site em html simples hello world"

// raizFixture monta um supervisor com uma conversa RAIZ sem dono — o cenário
// de todo teste deste arquivo — apontando para uma pasta de projeto real, para
// a herança de CWD ser observável.
type raizFixture struct {
	supervisor *Supervisor
	store      *store.Store
	provider   *routedProvider
	session    string
	projeto    string
}

func newRaizFixture(t *testing.T, routes []route) *raizFixture {
	t.Helper()
	dataStore, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("abrir o store: %v", err)
	}
	t.Cleanup(func() { dataStore.Close() })

	projeto := t.TempDir()
	const sessionID = "s-raiz"
	if _, err := dataStore.CreateSession(store.SessionMeta{ID: sessionID, CWD: projeto, Model: "m1"}); err != nil {
		t.Fatalf("criar sessão: %v", err)
	}

	provider := newRoutedProvider(t, routes, "sem rota")
	supervisor := New(Deps{
		Store:  dataStore,
		Bus:    eventbus.New(dataStore),
		Models: scriptedRouter(provider.server.URL),
		Gate:   permissions.NewGate(permissions.DefaultPolicy()),
		Tools:  NewRegistry(),
		// Sem Needle e sem classificador: se o fast router não decidir sozinho,
		// o cenário está errado e o teste tem de falhar.
		Router: NewRouter(nil, nil),
	})
	return &raizFixture{supervisor: supervisor, store: dataStore, provider: provider,
		session: sessionID, projeto: projeto}
}

/* --------------------- 1. trabalho na raiz vira filha ---------------------- */

// O primeiro input de TRABALHO numa raiz sem modo não vira o modo: o master
// delega. A filha nasce pendurada na raiz, do bot, com o CWD herdado (a IDE
// precisa da pasta do projeto); a raiz fica com o espelho — delegate abre com o
// id da filha, fecha com o resultado, done normal — e SEM dono gravado: o ready
// dela nunca flipa a superfície.
func TestPrimeiroInputDeTrabalhoNaRaizDelegaParaAFilha(t *testing.T) {
	fixture := newRaizFixture(t, []route{
		{trigger: pedidoDeTrabalho, answer: "<html>hello world</html>"},
	})

	if err := fixture.supervisor.Prompt(motorContext(t), fixture.session,
		protocol.Prompt{Text: pedidoDeTrabalho}); err != nil {
		t.Fatalf("prompt: %v", err)
	}

	// A filha: do bot, pendurada na raiz, com a pasta do projeto.
	filhoID := store.ChildSessionID(fixture.session, "code")
	filho, err := fixture.store.GetSession(filhoID)
	if err != nil {
		t.Fatalf("a conversa filha do código não nasceu: %v", err)
	}
	if filho.ParentID != fixture.session || filho.BotID != "code" || filho.Specialist != "code" {
		t.Errorf("a filha não é a conversa do bot pendurada na raiz: %+v", filho)
	}
	if filho.CWD != fixture.projeto {
		t.Errorf("a filha não herdou o CWD da raiz: %q, esperava %q — sem ele a árvore da IDE abre vazia",
			filho.CWD, fixture.projeto)
	}

	// A raiz: espelho completo (abre com o id da filha, fecha com o resultado).
	delegations := delegateEnvelopes(t, fixture.store, fixture.session)
	if len(delegations) != 2 {
		t.Fatalf("esperava o par abre/fecha na raiz, obtive %d: %+v", len(delegations), delegations)
	}
	if delegations[0].From != specialist.MasterID || delegations[0].To != "code" || delegations[0].Done {
		t.Errorf("o primeiro envelope tinha de abrir master→code: %+v", delegations[0])
	}
	if delegations[0].Session != filhoID {
		t.Errorf("o id da filha não viajou no envelope: %q, esperava %q", delegations[0].Session, filhoID)
	}
	if !delegations[1].Done || !strings.Contains(delegations[1].Result, "<html>hello world</html>") {
		t.Errorf("o resultado não fechou o espelho na raiz: %+v", delegations[1])
	}
	if dones := envelopesByKind(t, fixture.store, fixture.session, protocol.KindDone); len(dones) != 1 {
		t.Errorf("o turno da raiz tinha de terminar com o done normal, obtive %d", len(dones))
	}
	// O pedido continua sendo a fala da pessoa NA raiz — é lá que ela escreveu.
	if users := messageTexts(t, fixture.store, fixture.session, "user"); countOf(users, pedidoDeTrabalho) != 1 {
		t.Errorf("a fala da pessoa tinha de estar na raiz uma vez: %v", users)
	}

	// A raiz NÃO vira o bot: sem dono gravado, sem rota (é a rota que troca a
	// superfície) — e o título nasce do primeiro texto, como sempre.
	meta, err := fixture.store.GetSession(fixture.session)
	if err != nil {
		t.Fatalf("ler a raiz: %v", err)
	}
	if meta.Specialist != "" {
		t.Errorf("a raiz ganhou o dono %q — o master delega, não adota o modo", meta.Specialist)
	}
	if meta.Title != pedidoDeTrabalho {
		t.Errorf("o título da raiz tinha de nascer do primeiro texto: %q", meta.Title)
	}
	if rotas := envelopesByKind(t, fixture.store, fixture.session, protocol.KindRoute); len(rotas) != 0 {
		t.Errorf("a raiz recebeu %d rota(s) — a superfície de trabalho é da filha", len(rotas))
	}

	// Na FILHA: o par pedido/resposta (é ele que a torna continuável) e a rota
	// com a superfície do editor — o banner "agora é Código" mora lá.
	falas := mensagensDe(t, fixture.store, filhoID)
	if len(falas) != 2 || falas[0].Role != "user" || falas[1].Role != "assistant" {
		t.Fatalf("a filha tinha de ter o par pedido/resposta: %+v", falas)
	}
	if falas[0].Text != pedidoDeTrabalho || !strings.Contains(falas[1].Text, "<html>hello world</html>") {
		t.Errorf("pedido/resposta errados na filha: %+v", falas)
	}
	rotas := envelopesByKind(t, fixture.store, filhoID, protocol.KindRoute)
	if len(rotas) != 1 {
		t.Fatalf("esperava 1 rota na filha, obtive %d", len(rotas))
	}
	var rota protocol.Route
	if err := rotas[0].Decode(&rota); err != nil {
		t.Fatalf("decodificar a rota da filha: %v", err)
	}
	if rota.Specialist != "code" || rota.Surface != string(specialist.SurfaceEditor) {
		t.Errorf("a rota da filha tinha de ser code/editor: %+v", rota)
	}
}

/* ----------------------- 2. pergunta responde na raiz ---------------------- */

// Pergunta simples (superfície de conversa) NÃO abre filha: o chat responde na
// própria raiz — delegar uma dúvida seria abrir uma conversa lateral para uma
// frase.
func TestPerguntaDeChatNaRaizRespondeNaPropriaRaiz(t *testing.T) {
	fixture := newRaizFixture(t, []route{
		{trigger: "o que é html", answer: "é a linguagem de marcação da web"},
	})

	if err := fixture.supervisor.Prompt(motorContext(t), fixture.session,
		protocol.Prompt{Text: "o que é html?"}); err != nil {
		t.Fatalf("prompt: %v", err)
	}

	if delegations := delegateEnvelopes(t, fixture.store, fixture.session); len(delegations) != 0 {
		t.Errorf("uma pergunta abriu %d delegação(ões): %+v", len(delegations), delegations)
	}
	if _, err := fixture.store.GetSession(store.ChildSessionID(fixture.session, "chat")); err == nil {
		t.Error("uma pergunta de chat abriu conversa filha")
	}
	respostas := messageTexts(t, fixture.store, fixture.session, "assistant")
	if len(respostas) != 1 || !strings.Contains(respostas[0], "linguagem de marcação") {
		t.Errorf("a resposta tinha de sair NA raiz: %v", respostas)
	}
}

/* ------------------- 3. mesmo bot reusa a mesma filha ---------------------- */

// O segundo input de trabalho na MESMA raiz roteia de novo (a raiz é
// orquestradora, o modo nunca foi gravado) e, vencendo o mesmo bot, continua a
// MESMA filha — o id é estável por par (raiz, bot) — com a memória do que o bot
// já fez descendo ao sub-turno.
func TestSegundoInputDeTrabalhoReusaAMesmaFilhaComMemoria(t *testing.T) {
	const segundoPedido = "construa um app com um botao de contato"
	fixture := newRaizFixture(t, []route{
		// O gatilho do segundo pedido vem PRIMEIRO: o corpo da segunda chamada
		// também contém o primeiro pedido (é a memória descendo).
		{trigger: segundoPedido, answer: "adicionei o botão de contato"},
		{trigger: pedidoDeTrabalho, answer: "<html>hello</html>"},
	})

	ctx := motorContext(t)
	if err := fixture.supervisor.Prompt(ctx, fixture.session,
		protocol.Prompt{Text: pedidoDeTrabalho}); err != nil {
		t.Fatalf("primeiro prompt: %v", err)
	}
	if err := fixture.supervisor.Prompt(ctx, fixture.session,
		protocol.Prompt{Text: segundoPedido}); err != nil {
		t.Fatalf("segundo prompt: %v", err)
	}

	// As duas delegações apontam para a MESMA filha.
	filhoID := store.ChildSessionID(fixture.session, "code")
	delegations := delegateEnvelopes(t, fixture.store, fixture.session)
	if len(delegations) != 4 {
		t.Fatalf("esperava 2 pares abre/fecha, obtive %d: %+v", len(delegations), delegations)
	}
	for i, payload := range delegations {
		if payload.Session != filhoID {
			t.Errorf("envelope %d aponta para %q, esperava a mesma filha %q", i, payload.Session, filhoID)
		}
	}

	// A filha tem os DOIS trechos, na ordem — uma conversa, não duas.
	falas := mensagensDe(t, fixture.store, filhoID)
	if len(falas) != 4 {
		t.Fatalf("a filha tinha de ter os dois pares pedido/resposta, obtive %d: %+v", len(falas), falas)
	}
	if falas[2].Text != segundoPedido || !strings.Contains(falas[3].Text, "botão de contato") {
		t.Errorf("o segundo trecho não continuou a mesma conversa: %+v", falas[2:])
	}

	// E a MEMÓRIA desceu: o sub-turno do segundo pedido recebeu o primeiro par.
	fixture.provider.mu.Lock()
	defer fixture.provider.mu.Unlock()
	segundaChamada := ""
	for _, body := range fixture.provider.bodies {
		if strings.Contains(body, segundoPedido) {
			segundaChamada = body
		}
	}
	if segundaChamada == "" {
		t.Fatal("o sub-turno do segundo pedido não chegou ao modelo")
	}
	if !strings.Contains(segundaChamada, pedidoDeTrabalho) ||
		!strings.Contains(segundaChamada, "<html>hello</html>") {
		t.Error("o childHistory não desceu — o bot não lembra do próprio trabalho anterior")
	}
}

/* --------------------- 4. /mode explícito vira o bot ----------------------- */

// Quem escreve /mode ESCOLHEU o modo: a conversa vira o bot como sempre virou —
// modo gravado, rota explícita NA raiz, resposta na raiz e nenhuma filha.
func TestModeExplicitoContinuaVirandoOBot(t *testing.T) {
	fixture := newRaizFixture(t, []route{
		{trigger: "ajuste o rodape", answer: "rodapé ajustado"},
	})

	if err := fixture.supervisor.Prompt(motorContext(t), fixture.session,
		protocol.Prompt{Text: "/mode code ajuste o rodape do site"}); err != nil {
		t.Fatalf("prompt: %v", err)
	}

	meta, err := fixture.store.GetSession(fixture.session)
	if err != nil {
		t.Fatalf("ler a sessão: %v", err)
	}
	if meta.Specialist != "code" {
		t.Errorf("/mode code tinha de gravar o modo, obtive %q", meta.Specialist)
	}
	rotas := envelopesByKind(t, fixture.store, fixture.session, protocol.KindRoute)
	if len(rotas) != 1 {
		t.Fatalf("esperava a rota explícita na raiz, obtive %d", len(rotas))
	}
	var rota protocol.Route
	if err := rotas[0].Decode(&rota); err != nil {
		t.Fatalf("decodificar a rota: %v", err)
	}
	if rota.Reason != protocol.RouteExplicit || rota.Specialist != "code" {
		t.Errorf("esperava code/explicit, obtive %q/%q", rota.Specialist, rota.Reason)
	}
	if delegations := delegateEnvelopes(t, fixture.store, fixture.session); len(delegations) != 0 {
		t.Errorf("a escolha explícita virou delegação: %+v", delegations)
	}
	if _, err := fixture.store.GetSession(store.ChildSessionID(fixture.session, "code")); err == nil {
		t.Error("a escolha explícita abriu conversa filha")
	}
	if respostas := messageTexts(t, fixture.store, fixture.session, "assistant"); len(respostas) != 1 {
		t.Errorf("a resposta tinha de sair na própria conversa: %v", respostas)
	}
}

/* ------------------ 5. conversa nascida no bot fica nele -------------------- */

// A conversa criada JÁ no bot (hello.specialist — "novo schema") tem dono desde
// o nascimento: a rota é sticky, o turno roda nela mesma e nada deste contrato
// a toca.
func TestConversaNascidaNoBotContinuaSticky(t *testing.T) {
	dataStore, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("abrir o store: %v", err)
	}
	t.Cleanup(func() { dataStore.Close() })

	// É assim que o transporte cria a sessão do hello.specialist.
	const sessionID = "s-nascida-no-bot"
	if _, err := dataStore.CreateSession(store.SessionMeta{ID: sessionID, Specialist: "data", Model: "m1"}); err != nil {
		t.Fatalf("criar sessão: %v", err)
	}

	provider := newRoutedProvider(t, []route{
		{trigger: "modele a tabela", answer: "cliente(id, nome, email)"},
	}, "sem rota")
	supervisor := New(Deps{
		Store:  dataStore,
		Bus:    eventbus.New(dataStore),
		Models: scriptedRouter(provider.server.URL),
		Gate:   permissions.NewGate(permissions.DefaultPolicy()),
		Tools:  NewRegistry(),
		Router: NewRouter(nil, nil),
	})

	if err := supervisor.Prompt(motorContext(t), sessionID,
		protocol.Prompt{Text: "modele a tabela de clientes"}); err != nil {
		t.Fatalf("prompt: %v", err)
	}

	meta, err := dataStore.GetSession(sessionID)
	if err != nil {
		t.Fatalf("ler a sessão: %v", err)
	}
	if meta.Specialist != "data" {
		t.Errorf("a conversa nascida no bot trocou de dono para %q", meta.Specialist)
	}
	rotas := envelopesByKind(t, dataStore, sessionID, protocol.KindRoute)
	if len(rotas) != 1 {
		t.Fatalf("esperava 1 rota, obtive %d", len(rotas))
	}
	var rota protocol.Route
	if err := rotas[0].Decode(&rota); err != nil {
		t.Fatalf("decodificar a rota: %v", err)
	}
	if rota.Reason != protocol.RouteSticky {
		t.Errorf("a conversa com dono tinha de ser sticky, veio %q", rota.Reason)
	}
	if delegations := delegateEnvelopes(t, dataStore, sessionID); len(delegations) != 0 {
		t.Errorf("a conversa do bot delegou o próprio trabalho: %+v", delegations)
	}
	if respostas := messageTexts(t, dataStore, sessionID, "assistant"); len(respostas) != 1 ||
		!strings.Contains(respostas[0], "cliente(id, nome, email)") {
		t.Errorf("a resposta tinha de sair na própria conversa: %v", respostas)
	}
}

/* --------------------- 6. recusa/falha fica na raiz ------------------------ */

// Delegação que NÃO acontece não abre filha — a regra existente da delegação
// ("só resultado bom entra na filha") vale no caminho do master. Aqui o
// catálogo de modelos está vazio: a delegação falha ANTES de o bot existir, a
// falha fica na RAIZ como aviso do sistema e o turno fecha com done — a tela
// não fica girando.
func TestFalhaDaDelegacaoDoMasterFicaNaRaizSemFilha(t *testing.T) {
	dataStore, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("abrir o store: %v", err)
	}
	t.Cleanup(func() { dataStore.Close() })

	const sessionID = "s-raiz-sem-modelo"
	if _, err := dataStore.CreateSession(store.SessionMeta{ID: sessionID}); err != nil {
		t.Fatalf("criar sessão: %v", err)
	}

	supervisor := New(Deps{
		Store: dataStore,
		Bus:   eventbus.New(dataStore),
		// Roteador de modelos VAZIO: resolver o modelo do delegado falha.
		Models: modelrouter.New(http.DefaultClient, nil),
		Gate:   permissions.NewGate(permissions.DefaultPolicy()),
		Tools:  NewRegistry(),
		Router: NewRouter(nil, nil),
	})

	if err := supervisor.Prompt(motorContext(t), sessionID,
		protocol.Prompt{Text: pedidoDeTrabalho}); err != nil {
		t.Fatalf("prompt: %v", err)
	}

	if _, err := dataStore.GetSession(store.ChildSessionID(sessionID, "code")); err == nil {
		t.Error("a filha nasceu para uma delegação que não aconteceu")
	}
	if delegations := delegateEnvelopes(t, dataStore, sessionID); len(delegations) != 0 {
		t.Errorf("a falha abriu popup de um bot que nunca entrou: %+v", delegations)
	}
	avisos := messageTexts(t, dataStore, sessionID, "system")
	if len(avisos) != 1 || !strings.Contains(avisos[0], "NÃO DEU CERTO") {
		t.Errorf("a falha tinha de ficar na raiz como aviso do sistema: %v", avisos)
	}
	if dones := envelopesByKind(t, dataStore, sessionID, protocol.KindDone); len(dones) != 1 {
		t.Errorf("o turno tinha de fechar mesmo na falha (1 done), obtive %d", len(dones))
	}
	meta, err := dataStore.GetSession(sessionID)
	if err != nil {
		t.Fatalf("ler a raiz: %v", err)
	}
	if meta.Specialist != "" {
		t.Errorf("a falha gravou o dono %q na raiz", meta.Specialist)
	}
}

/* ------------------ 7. o briefing manda produzir no projeto ----------------- */

// O briefing do sub-turno master→bot reforça a regra da JANELA: o bot de
// trabalho produz NO PROJETO com as ferramentas, e a pessoa vê o resultado na
// superfície dele. Sem o reforço, o Código devolvia o HTML inteiro num bloco
// de markdown no chat e o editor ficava em "nenhum arquivo aberto".
//
// O bot-a-bot NÃO ganha o parágrafo: lá quem lê o resultado é o OUTRO bot, o
// texto volta como contexto de ferramenta — mandar "mostrar na sua superfície"
// para quem não tem audiência produziria o tom errado nos dois lados.
func TestBriefingDoMasterMandaProduzirNoProjetoComAsFerramentas(t *testing.T) {
	supervisor := New(Deps{
		Gate:  permissions.NewGate(permissions.DefaultPolicy()),
		Tools: NewRegistry(),
	})
	request := delegateRequest{Specialist: "code", Goal: pedidoDeTrabalho}

	messages := supervisor.delegateMessages(specialist.Master,
		specialist.GetOrDefault("code"), request, firstDelegationDepth, nil)
	briefing := messages[len(messages)-1]
	if briefing.Role != "user" {
		t.Fatalf("o briefing tinha de ser a fala de usuário do sub-turno, veio %q", briefing.Role)
	}
	for _, want := range []string{"SUA janela", "NO PROJETO", "ferramentas", "superfície"} {
		if !strings.Contains(briefing.Content, want) {
			t.Errorf("o briefing do master não diz %q:\n%s", want, briefing.Content)
		}
	}

	botABot := supervisor.delegateMessages(specialist.GetOrDefault("chat"),
		specialist.GetOrDefault("code"), request, firstDelegationDepth, nil)
	texto := botABot[len(botABot)-1].Content
	if strings.Contains(texto, "SUA janela") {
		t.Errorf("o parágrafo da janela vazou para o briefing bot-a-bot:\n%s", texto)
	}
}
