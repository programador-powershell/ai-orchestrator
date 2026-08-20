// Testes do PORTÃO DE NARRAÇÃO (ver narration.go).
//
// O flagrante que este arquivo guarda: o Código respondeu "Resultado do
// fs.list em .:" com uma listagem INVENTADA — nenhuma ferramenta rodou, a
// pasta estava vazia. A persona já proibia; aqui se fixa o portão MECÂNICO:
// a heurística com casos de mesa dos DOIS lados (o falso positivo pune quem
// trabalhou certo, então cada caso que PASSA é tão contrato quanto cada caso
// que reprova), o laço corretivo capado em UMA tentativa e a reincidência
// saindo pelo caminho de FALHA que já existe — nunca com cara de ✓.
package supervisor

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"aibot/gateway/internal/eventbus"
	"aibot/gateway/internal/permissions"
	"aibot/gateway/internal/protocol"
	"aibot/gateway/internal/specialist"
	"aibot/gateway/internal/store"
)

/* ------------------------------- heurística ------------------------------- */

// A tabela de mesa da heurística. Os casos que PASSAM importam tanto quanto os
// que reprovam: a detecção é conservadora de propósito, porque descartar
// trabalho legítimo é pior (e mais silencioso) do que deixar passar uma
// encenação que a pessoa ainda vê na tela.
func TestRespostaNarradaCasosDeMesa(t *testing.T) {
	cases := []struct {
		name    string
		answer  string
		narrada bool
	}{
		// REPROVA — alegação de resultado de ferramenta que não rodou.
		{"flagrante: saída de fs.list inventada",
			"Resultado do fs.list em .:\napi/index.js (312 bytes)\nvercel.json (88 bytes)", true},
		{"alegação de arquivo criado",
			"Criei o arquivo index.html com toda a estrutura do site.", true},
		{"alegação de gravação consumada",
			"O site já está gravado em public/index.html, pode abrir.", true},
		{"alegação de saída do proc.run",
			"Resultado do proc.run: build concluído sem erros.", true},

		// REPROVA — artefato inteiro colado em cerca, grande demais para ser
		// trecho ilustrativo.
		{"arquivo inteiro colado em cerca",
			"Aqui está o site completo:\n```html\n" +
				strings.Repeat("<div>linha do arquivo narrado</div>\n", linhasMinimasDeCerca) + "```", true},
		{"cerca sem fecho: streaming cortado no meio do artefato",
			"Segue o arquivo:\n```html\n" + strings.Repeat("<p>corpo</p>\n", linhasMinimasDeCerca), true},

		// PASSA — resposta técnica legítima com trecho ilustrativo CURTO, que a
		// persona do Código permite de propósito.
		{"trecho ilustrativo curto",
			"O handler fica assim:\n```go\nfunc handler(w http.ResponseWriter, r *http.Request) {\n" +
				"\tw.WriteHeader(200)\n}\n```\nQuer que eu grave no projeto?", false},
		// PASSA — pergunta legítima: o especialista que pergunta antes de chutar
		// está fazendo a coisa certa, e o portão não pode puni-lo por isso.
		{"pergunta curta de esclarecimento", "Qual stack você prefere: Next.js ou Vite?", false},
		// PASSA — plano no futuro não é alegação de efeito: "vou criar" ainda
		// não mentiu sobre nada.
		{"plano de trabalho no futuro", "Vou criar o arquivo index.html e depois rodar o build.", false},
		// PASSA — cerca de PROTOCOLO é máquina, não artefato narrado.
		{"cerca de protocolo não conta",
			"```aibot:tool\n" + strings.Repeat("{\"tool\":\"fs.write\"},\n", linhasMinimasDeCerca) + "```", false},
		// PASSA — descrever o ESTADO do projeto sem alegar efeito.
		{"resumo curto sem alegação",
			"A pasta do projeto está vazia; preciso criar a estrutura do zero. Posso começar?", false},
	}
	for _, tc := range cases {
		if got := respostaNarrada(tc.answer); got != tc.narrada {
			t.Errorf("%s: respostaNarrada = %v, esperava %v\nresposta:\n%s", tc.name, got, tc.narrada, tc.answer)
		}
	}
}

// A classificação de efeito é DERIVADA da tabela de risco (permissions.RiskOf),
// não de uma lista solta: escrita e execução deixam rastro; leitura não.
// Ferramenta desconhecida conta como efeito porque RiskOf a trata como execute
// — e o lado conservador DESTE portão é calar diante de efeito possível, nunca
// acusar uma resposta legítima.
func TestFerramentaDeEfeitoDerivaDoRisco(t *testing.T) {
	efeito := []string{"fs.write", "fs.patch", "proc.run", "design.replicate",
		"schema.export", "sql.render", "git.commit", "office.edit", "plugin.desconhecida"}
	for _, tool := range efeito {
		if !ferramentaDeEfeito(tool) {
			t.Errorf("%s deixa rastro e tinha de contar como efeito", tool)
		}
	}
	semEfeito := []string{"fs.read", "fs.list", "fs.search", "git.status",
		"git.diff", "web.search", "memory.read", "context.fetch"}
	for _, tool := range semEfeito {
		if ferramentaDeEfeito(tool) {
			t.Errorf("%s é leitura e não pode calar o portão de narração", tool)
		}
	}
}

/* ---------------------------- exemplo concreto ---------------------------- */

// O exemplo concreto da cerca tem de passar pelo PARSER DE VERDADE: se o
// formato que parseToolCalls espera mudar um dia, este teste quebra junto com
// o exemplo — que é exatamente o acoplamento desejado.
func TestExemploDaCercaPassaPeloParserDeVerdade(t *testing.T) {
	calls := parseToolCalls(exemploDeCercaDeFerramenta)
	if len(calls) != 1 {
		t.Fatalf("o exemplo tinha de virar exatamente 1 chamada, virou %d: %+v", len(calls), calls)
	}
	if calls[0].Tool != "fs.write" {
		t.Fatalf("o exemplo tinha de chamar fs.write, chamou %q", calls[0].Tool)
	}
	var args struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	if err := json.Unmarshal(calls[0].Args, &args); err != nil {
		t.Fatalf("os argumentos do exemplo têm de ser JSON válido: %v", err)
	}
	if args.Path == "" || args.Content == "" {
		t.Fatalf("o exemplo tem de mostrar path E content preenchidos: %+v", args)
	}
	// E a correção reinjetada carrega o exemplo — é ela que o modelo menor lê
	// na hora em que mais precisa do formato.
	if !strings.Contains(correcaoDeNarracao, exemploDeCercaDeFerramenta) {
		t.Error("a correção de narração não carrega o exemplo concreto da cerca")
	}
}

// O exemplo entra no contrato de quem TRABALHA e grava arquivo — e só. O chat
// responde no próprio texto (o portão nem o cobre) e o office não tem fs.write:
// exemplificar uma ferramenta que o portão de permissão recusa ensinaria o
// modelo a bater na porta errada.
func TestToolContractGanhaExemploConcretoSoParaTrabalhoComEscrita(t *testing.T) {
	registry := NewRegistry()
	registry.Register("fs.read", "lê um arquivo", nil)
	registry.Register("fs.write", "grava um arquivo", nil)
	registry.Register("office.open", "lê um documento", nil)
	supervisor := New(Deps{Gate: permissions.NewGate(permissions.DefaultPolicy()), Tools: registry})

	code := supervisor.toolContract(specialist.GetOrDefault("code"))
	if !strings.Contains(code, exemploDeCercaDeFerramenta) {
		t.Errorf("o contrato do Código não traz o exemplo concreto:\n%s", code)
	}
	chat := supervisor.toolContract(specialist.GetOrDefault("chat"))
	if chat == "" {
		t.Fatal("o chat tem ferramentas de leitura e o contrato não pode sumir")
	}
	if strings.Contains(chat, exemploDeCercaDeFerramenta) {
		t.Errorf("o exemplo de fs.write vazou para o chat, que não grava arquivo:\n%s", chat)
	}
	office := supervisor.toolContract(specialist.GetOrDefault("office"))
	if strings.Contains(office, exemploDeCercaDeFerramenta) {
		t.Errorf("o exemplo de fs.write vazou para o office, que edita binário por office.edit:\n%s", office)
	}
}

// O SUB-TURNO delegado recebe o exemplo pelo mesmo contrato: é lá que o
// flagrante aconteceu, e é o modelo menor do delegado que mais erra o formato.
func TestContratoDoSubTurnoLevaOExemploConcreto(t *testing.T) {
	registry := NewRegistry()
	registry.Register("fs.write", "grava um arquivo", nil)
	supervisor := New(Deps{Gate: permissions.NewGate(permissions.DefaultPolicy()), Tools: registry})

	messages := supervisor.delegateMessages(specialist.Master, specialist.GetOrDefault("code"),
		delegateRequest{Specialist: "code", Goal: "crie o site"}, firstDelegationDepth, nil)

	found := false
	for _, message := range messages {
		if message.Role == "system" && strings.Contains(message.Content, exemploDeCercaDeFerramenta) {
			found = true
		}
	}
	if !found {
		t.Error("o sub-turno delegado não recebeu o exemplo concreto da cerca de ferramenta")
	}
}

/* ------------------------------ turno inteiro ----------------------------- */

// narracaoFixture monta um supervisor com a conversa JÁ do especialista dado
// (rota sticky — o cenário do portão é a conversa de trabalho em andamento).
type narracaoFixture struct {
	supervisor *Supervisor
	store      *store.Store
	provider   *routedProvider
	session    string
}

func newNarracaoFixture(t *testing.T, specialistID string, routes []route,
	registry *Registry, mode permissions.Mode) *narracaoFixture {
	t.Helper()
	dataStore, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("abrir o store: %v", err)
	}
	t.Cleanup(func() { dataStore.Close() })

	const sessionID = "s-narracao"
	// CWD preenchido de propósito: sem ele o provisionamento automático criaria
	// pasta e emitiria etapas que não são o assunto destes testes.
	if _, err := dataStore.CreateSession(store.SessionMeta{
		ID: sessionID, Title: "narração", Specialist: specialistID, Model: "m1", CWD: t.TempDir(),
	}); err != nil {
		t.Fatalf("criar sessão: %v", err)
	}

	if registry == nil {
		registry = NewRegistry()
	}
	provider := newRoutedProvider(t, routes, "sem rota")
	supervisor := New(Deps{
		Store:  dataStore,
		Bus:    eventbus.New(dataStore),
		Models: scriptedRouter(provider.server.URL),
		Gate:   permissions.NewGate(permissions.Policy{Mode: mode, AgentTools: true}),
		Tools:  registry,
		Router: NewRouter(nil, nil),
	})
	return &narracaoFixture{supervisor: supervisor, store: dataStore, provider: provider, session: sessionID}
}

// corposDoProvedor copia o que cada chamada de modelo recebeu, na ordem.
func corposDoProvedor(provider *routedProvider) []string {
	provider.mu.Lock()
	defer provider.mu.Unlock()
	out := make([]string, len(provider.bodies))
	copy(out, provider.bodies)
	return out
}

// rotulosDeEtapa drena os KindThinking já entregues à assinatura — os rótulos
// são efêmeros (não vão ao log), então a telemetria do portão só é observável
// por aqui.
func rotulosDeEtapa(t *testing.T, subscription *eventbus.Subscription) []string {
	t.Helper()
	labels := make([]string, 0, 8)
	for {
		select {
		case envelope, ok := <-subscription.Events:
			if !ok {
				return labels
			}
			if envelope.Kind != protocol.KindThinking {
				continue
			}
			var thinking protocol.Thinking
			if err := envelope.Decode(&thinking); err == nil && thinking.Label != "" {
				labels = append(labels, thinking.Label)
			}
		default:
			return labels
		}
	}
}

// O caminho do flagrante: especialista de trabalho narra, leva UMA correção,
// insiste na encenação — e o turno fecha como FALHA honesta: nenhuma fala do
// bot no log, KindError no caminho visual de erro que já existe, nenhum done
// com cara de ✓.
func TestTurnoDeTrabalhoNarradoReprovaComFalhaHonestaAposUmaCorrecao(t *testing.T) {
	const pedido = "liste os arquivos do projeto e monte o site"
	narrado := "Resultado do fs.list em .:\napi/index.js (312 bytes)\nvercel.json (88 bytes)"
	insistencia := "Criei o arquivo api/index.js com todo o conteúdo do site."
	fixture := newNarracaoFixture(t, "code", []route{
		// A rota da correção vem PRIMEIRO: o corpo da segunda chamada também
		// contém o pedido original (histórico), e a ordem decide o vencedor.
		{trigger: "CORREÇÃO DO SUPERVISOR", answer: insistencia},
		{trigger: pedido, answer: narrado},
	}, nil, permissions.ModeEdits)

	subscription := fixture.supervisor.deps.Bus.Subscribe(fixture.session)
	defer subscription.Close()

	if err := fixture.supervisor.Prompt(motorContext(t), fixture.session,
		protocol.Prompt{Text: pedido}); err != nil {
		t.Fatalf("prompt: %v", err)
	}

	// 1. Nenhuma das duas encenações virou fala do bot na conversa.
	if respostas := messageTexts(t, fixture.store, fixture.session, "assistant"); len(respostas) != 0 {
		t.Errorf("a resposta narrada foi publicada como boa: %v", respostas)
	}

	// 2. A falha honesta saiu pelo caminho de erro que já existe.
	erros := envelopesByKind(t, fixture.store, fixture.session, protocol.KindError)
	if len(erros) != 1 {
		t.Fatalf("esperava 1 erro de turno, obtive %d", len(erros))
	}
	var falha protocol.Error
	if err := erros[0].Decode(&falha); err != nil {
		t.Fatalf("decodificar o erro: %v", err)
	}
	if falha.Code != narracaoFailCode {
		t.Errorf("código da falha: esperava %q, obtive %q", narracaoFailCode, falha.Code)
	}
	if !strings.Contains(falha.Message, "descartada") || !strings.Contains(falha.Message, "Criei o arquivo") {
		t.Errorf("a falha tem de dizer o que foi descartado, para a pessoa entender o portão: %q", falha.Message)
	}

	// 3. "Não executado" não pode parecer ✓: sem done.
	if dones := envelopesByKind(t, fixture.store, fixture.session, protocol.KindDone); len(dones) != 0 {
		t.Errorf("o turno reprovado terminou com %d done(s) — encenação com cara de sucesso", len(dones))
	}

	// 4. A correção foi UMA, e levou o exemplo concreto da cerca ao modelo.
	bodies := corposDoProvedor(fixture.provider)
	if len(bodies) != 2 {
		t.Fatalf("esperava exatamente 2 chamadas de modelo (resposta + correção), obtive %d", len(bodies))
	}
	if !strings.Contains(bodies[1], "CORREÇÃO DO SUPERVISOR") ||
		!strings.Contains(bodies[1], exemploDeCercaDeFerramenta) {
		t.Error("a segunda chamada não recebeu a correção com o exemplo concreto")
	}

	// 5. Telemetria honesta: a pessoa viu o portão agindo.
	labels := rotulosDeEtapa(t, subscription)
	seen := false
	for _, label := range labels {
		if label == avisoDeNarracao {
			seen = true
		}
	}
	if !seen {
		t.Errorf("o aviso do portão não chegou à tela; rótulos vistos: %v", labels)
	}
}

// O contraponto do portão: quem EXECUTOU de verdade pode anunciar — "gravei o
// arquivo" com fs.write ok no turno passa direto, sem correção nenhuma.
func TestTurnoComEfeitoRealPassaDiretoMesmoAnunciandoAGravacao(t *testing.T) {
	registry := NewRegistry()
	gravou := false
	registry.Register("fs.write", "grava um arquivo do projeto",
		func(context.Context, string, json.RawMessage) (string, error) {
			gravou = true
			return "gravado: index.html (7 bytes)", nil
		})

	const pedido = "crie um site hello world"
	fixture := newNarracaoFixture(t, "code", []route{
		{trigger: "Resultado das ferramentas", answer: "Gravei o arquivo index.html no projeto — abra no editor."},
		{trigger: pedido, answer: "vou gravar agora\n\n" + toolFence +
			"\n{\"tool\":\"fs.write\",\"args\":{\"path\":\"index.html\",\"content\":\"<html/>\"}}\n```"},
	}, registry, permissions.ModeAll)

	if err := fixture.supervisor.Prompt(motorContext(t), fixture.session,
		protocol.Prompt{Text: pedido}); err != nil {
		t.Fatalf("prompt: %v", err)
	}

	if !gravou {
		t.Fatal("o fs.write de verdade não rodou — o cenário está errado")
	}
	if erros := envelopesByKind(t, fixture.store, fixture.session, protocol.KindError); len(erros) != 0 {
		t.Errorf("o turno com efeito real reprovou: %+v", erros)
	}
	respostas := messageTexts(t, fixture.store, fixture.session, "assistant")
	final := strings.Join(respostas, "\n")
	if !strings.Contains(final, "Gravei o arquivo index.html") {
		t.Errorf("a resposta legítima não foi publicada: %v", respostas)
	}
	if dones := envelopesByKind(t, fixture.store, fixture.session, protocol.KindDone); len(dones) != 1 {
		t.Errorf("esperava o done normal, obtive %d", len(dones))
	}
	if fixture.provider.sawRequestContaining("CORREÇÃO DO SUPERVISOR") {
		t.Error("o portão corrigiu um turno que executou de verdade")
	}
}

// A pergunta legítima NUNCA dispara o portão: o especialista de trabalho que
// pergunta antes de chutar está fazendo a coisa certa.
func TestPerguntaCurtaDoEspecialistaDeTrabalhoNuncaDisparaOPortao(t *testing.T) {
	const pedido = "monte o projeto do site"
	fixture := newNarracaoFixture(t, "code", []route{
		{trigger: pedido, answer: "Qual stack você prefere: Next.js puro ou Vite com React?"},
	}, nil, permissions.ModeEdits)

	if err := fixture.supervisor.Prompt(motorContext(t), fixture.session,
		protocol.Prompt{Text: pedido}); err != nil {
		t.Fatalf("prompt: %v", err)
	}

	respostas := messageTexts(t, fixture.store, fixture.session, "assistant")
	if len(respostas) != 1 || !strings.Contains(respostas[0], "Qual stack") {
		t.Errorf("a pergunta legítima tinha de sair publicada: %v", respostas)
	}
	if erros := envelopesByKind(t, fixture.store, fixture.session, protocol.KindError); len(erros) != 0 {
		t.Errorf("a pergunta legítima reprovou no portão: %+v", erros)
	}
	if bodies := corposDoProvedor(fixture.provider); len(bodies) != 1 {
		t.Errorf("a pergunta legítima gastou %d chamadas de modelo, esperava 1", len(bodies))
	}
}

// O CHAT não é afetado: a superfície dele é o próprio texto, e um bloco de
// código grande no chat é exatamente o que a pessoa pediu.
func TestChatNaoEAfetadoPeloPortaoMesmoComCercaGrande(t *testing.T) {
	const pergunta = "me mostra um exemplo de quicksort em python"
	resposta := "Claro! Um exemplo completo:\n```python\n" +
		strings.Repeat("linha = 1\n", linhasMinimasDeCerca+2) + "```\nQuer que eu explique?"
	fixture := newNarracaoFixture(t, "chat", []route{
		{trigger: pergunta, answer: resposta},
	}, nil, permissions.ModeEdits)

	if err := fixture.supervisor.Prompt(motorContext(t), fixture.session,
		protocol.Prompt{Text: pergunta}); err != nil {
		t.Fatalf("prompt: %v", err)
	}

	respostas := messageTexts(t, fixture.store, fixture.session, "assistant")
	if len(respostas) != 1 || !strings.Contains(respostas[0], "linha = 1") {
		t.Errorf("a resposta do chat com o código tinha de sair inteira: %v", respostas)
	}
	if erros := envelopesByKind(t, fixture.store, fixture.session, protocol.KindError); len(erros) != 0 {
		t.Errorf("o chat reprovou no portão de narração: %+v", erros)
	}
	if bodies := corposDoProvedor(fixture.provider); len(bodies) != 1 {
		t.Errorf("o chat levou correção: %d chamadas de modelo", len(bodies))
	}
}

// O OFFICE segue trabalhando como sempre: a resposta legítima dele — descrever
// a alteração em uma linha e confirmar — não tem alegação nem artefato colado,
// e sai publicada sem o portão encostar.
func TestOfficeSegueRespondendoSemSerAfetado(t *testing.T) {
	const pedido = "troque o titulo da secao 2 do contrato"
	fixture := newNarracaoFixture(t, "office", []route{
		{trigger: pedido, answer: "A alteração troca o título da seção 2 de \"Objeto\" para \"Escopo\" — confirmo antes de aplicar?"},
	}, nil, permissions.ModeEdits)

	if err := fixture.supervisor.Prompt(motorContext(t), fixture.session,
		protocol.Prompt{Text: pedido}); err != nil {
		t.Fatalf("prompt: %v", err)
	}

	respostas := messageTexts(t, fixture.store, fixture.session, "assistant")
	if len(respostas) != 1 || !strings.Contains(respostas[0], "confirmo antes de aplicar") {
		t.Errorf("a resposta do office tinha de sair publicada: %v", respostas)
	}
	if erros := envelopesByKind(t, fixture.store, fixture.session, protocol.KindError); len(erros) != 0 {
		t.Errorf("o office reprovou no portão: %+v", erros)
	}
}

/* ------------------------------- sub-turno -------------------------------- */

// No SUB-TURNO delegado — onde o flagrante aconteceu — a reincidência fecha a
// delegação como falha: o popup fecha com erro, a filha registra "A tarefa não
// terminou" e nada narrado vira fala do bot.
func TestSubTurnoNarradoDuasVezesFechaComoFalhaHonesta(t *testing.T) {
	dataStore, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("abrir o store: %v", err)
	}
	defer dataStore.Close()
	const sessionID = "s-sub-narrado"
	if _, err := dataStore.CreateSession(store.SessionMeta{
		ID: sessionID, Title: "raiz", Specialist: "chat", Model: "m1", CWD: t.TempDir(),
	}); err != nil {
		t.Fatalf("criar sessão: %v", err)
	}

	server := scriptedProvider(t, []string{
		"Resultado do fs.list em .:\napi/index.js\nvercel.json",
		"Criei os arquivos api/index.js e vercel.json com o conteúdo completo.",
	}, nil)
	defer server.Close()

	supervisor := New(Deps{
		Store:  dataStore,
		Bus:    eventbus.New(dataStore),
		Models: scriptedRouter(server.URL),
		Gate:   permissions.NewGate(permissions.DefaultPolicy()),
		Tools:  NewRegistry(),
	})

	budget := &delegationBudget{}
	back := supervisor.delegate(motorContext(t), sessionID, "t1",
		specialist.GetOrDefault("chat"),
		delegateRequest{Specialist: "code", Goal: "crie o site hello world"},
		budget, firstDelegationDepth)

	if !strings.Contains(back, "NÃO DEU CERTO") || !strings.Contains(back, "descreveu o resultado") {
		t.Errorf("a encenação tinha de voltar como falha da delegação: %q", back)
	}

	// O espelho fecha com a falha, e a filha registra o desfecho como aviso do
	// SISTEMA — nunca como fala do bot com a listagem inventada.
	delegations := delegateEnvelopes(t, dataStore, sessionID)
	if len(delegations) != 2 || !delegations[1].Done {
		t.Fatalf("esperava o par abre/fecha da delegação, obtive %+v", delegations)
	}
	filho := store.ChildSessionID(sessionID, "code")
	avisos := messageTexts(t, dataStore, filho, "system")
	if len(avisos) != 1 || !strings.Contains(avisos[0], "A tarefa não terminou") {
		t.Errorf("a filha tinha de registrar a falha honesta: %v", avisos)
	}
	if respostas := messageTexts(t, dataStore, filho, "assistant"); len(respostas) != 0 {
		t.Errorf("a listagem inventada virou fala do bot na filha: %v", respostas)
	}
}

// O laço corretivo funcionando no sub-turno: narra, leva a correção, EXECUTA
// de verdade no segundo passo — e a delegação termina bem, com o anúncio
// legítimo passando porque o efeito aconteceu.
func TestSubTurnoCorrigidoExecutaDeVerdadeETermina(t *testing.T) {
	dataStore, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("abrir o store: %v", err)
	}
	defer dataStore.Close()
	const sessionID = "s-sub-corrigido"
	if _, err := dataStore.CreateSession(store.SessionMeta{
		ID: sessionID, Title: "raiz", Specialist: "chat", Model: "m1", CWD: t.TempDir(),
	}); err != nil {
		t.Fatalf("criar sessão: %v", err)
	}

	registry := NewRegistry()
	gravou := false
	registry.Register("fs.write", "grava um arquivo do projeto",
		func(context.Context, string, json.RawMessage) (string, error) {
			gravou = true
			return "gravado: index.html (7 bytes)", nil
		})

	server := scriptedProvider(t, []string{
		"Resultado do fs.list em .:\napi/index.js\nvercel.json",
		"agora vou gravar\n\n" + toolFence +
			"\n{\"tool\":\"fs.write\",\"args\":{\"path\":\"index.html\",\"content\":\"<html/>\"}}\n```",
		"Gravei o arquivo index.html no projeto.",
	}, nil)
	defer server.Close()

	supervisor := New(Deps{
		Store:  dataStore,
		Bus:    eventbus.New(dataStore),
		Models: scriptedRouter(server.URL),
		Gate:   permissions.NewGate(permissions.Policy{Mode: permissions.ModeAll, AgentTools: true}),
		Tools:  registry,
	})

	budget := &delegationBudget{}
	back := supervisor.delegate(motorContext(t), sessionID, "t1",
		specialist.GetOrDefault("chat"),
		delegateRequest{Specialist: "code", Goal: "crie o site hello world"},
		budget, firstDelegationDepth)

	if !gravou {
		t.Fatal("a correção não levou o delegado a executar de verdade")
	}
	if !strings.Contains(back, "RESULTADO DA DELEGAÇÃO") ||
		!strings.Contains(back, "Gravei o arquivo index.html") {
		t.Errorf("a delegação corrigida tinha de terminar bem com o anúncio legítimo: %q", back)
	}
}
