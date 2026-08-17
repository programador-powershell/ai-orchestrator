// Os achados da revisão adversarial do motor, cada um com o cenário que o
// disparava.
//
// Todos foram confirmados executando o motor, não lendo o código — e é por isso
// que os testes daqui exercitam o caminho inteiro em vez de afirmar sobre uma
// função. O que eles guardam é a diferença entre "o motor recusou" e "o motor
// deixou passar calado", que é onde moravam os defeitos.
package supervisor

import (
	"context"
	"strings"
	"testing"

	"aibot/gateway/internal/eventbus"
	"aibot/gateway/internal/permissions"
	"aibot/gateway/internal/protocol"
	"aibot/gateway/internal/specialist"
	"aibot/gateway/internal/store"
)

/* ------------------------- anexo sem texto (bloqueio) --------------------- */

// Anexar um arquivo e apertar Enter, sem digitar nada, É um pedido.
//
// O composer libera esse envio de propósito. O turno o recusava na PRIMEIRA
// linha, antes de existir id de turno para carimbar envelope: nada chegava à
// tela, o `busy` nunca fechava, o orbe girava e o chip do anexo já tinha sido
// apagado. A pessoa perdia o arquivo e o pedido sem uma palavra — e o pior é que
// o roteamento por extensão existe exatamente para atender esse caso.
func TestAnexoSemTextoValeComoPedido(t *testing.T) {
	fixture := newCrewFixture(t, "office", []route{
		{trigger: "contrato.docx", answer: "li o contrato: o prazo é de 30 dias"},
	}, "sem rota")

	err := fixture.supervisor.Prompt(motorContext(t), fixture.session, protocol.Prompt{
		Attachments: []protocol.Attachment{{Name: "contrato.docx", Mime: "application/vnd.openxmlformats", Ref: "r1"}},
	})
	if err != nil {
		t.Fatalf("anexo sem texto tem de valer como pedido: %v", err)
	}

	if got := len(envelopesByKind(t, fixture.store, fixture.session, protocol.KindDone)); got != 1 {
		t.Errorf("esperava 1 `done` fechando o turno, obtive %d — sem ele a tela fica girando", got)
	}
	if !fixture.provider.sawRequestContaining("contrato.docx") {
		t.Error("o nome do anexo não chegou ao modelo — ele não tem o que analisar")
	}
	answers := messageTexts(t, fixture.store, fixture.session, "assistant")
	if len(answers) != 1 || !strings.Contains(answers[0], "30 dias") {
		t.Errorf("a resposta não chegou ao log: %q", answers)
	}
}

// Prompt vazio DE VERDADE (sem texto e sem anexo) continua sendo erro — mas o
// erro precisa chegar a quem está olhando.
//
// As saídas antecipadas de runTurn devolvem `error` sem ter emitido envelope
// nenhum, e quem chama só registrava no log do SERVIDOR. Do lado do cliente isso
// é indistinguível de um turno que nunca responde.
func TestErroAntesDoTurnoChegaAPessoa(t *testing.T) {
	fixture := newCrewFixture(t, "chat", nil, "nada")

	err := fixture.supervisor.Prompt(motorContext(t), fixture.session, protocol.Prompt{})
	if err == nil {
		t.Fatal("prompt sem texto e sem anexo tem de falhar")
	}
	// É o transporte que faz esta chamada ao receber o erro; aqui ela é direta.
	fixture.supervisor.ReportTurnFailure(fixture.session, err)

	envelopes := envelopesByKind(t, fixture.store, fixture.session, protocol.KindError)
	if len(envelopes) != 1 {
		t.Fatalf("esperava 1 erro publicado na sessão, obtive %d", len(envelopes))
	}
	var failure protocol.Error
	if decodeErr := envelopes[0].Decode(&failure); decodeErr != nil {
		t.Fatalf("decodificar o erro: %v", decodeErr)
	}
	if !strings.Contains(failure.Message, "vazio") {
		t.Errorf("o erro publicado não diz o que houve: %+v", failure)
	}
}

/* --------------------------------- /mode ---------------------------------- */

// `/mode office` + Shift+Enter + pedido na linha de baixo é um comando.
//
// O corte era no literal " ", nunca em \n ou \t: o candidato virava
// "office\ncorrige", não existia no catálogo, e o comando voltava como texto
// comum. A troca de modo simplesmente não acontecia, sem aviso.
func TestModeAceitaQuebraDeLinhaEntreOIdEOPedido(t *testing.T) {
	casos := []struct{ nome, texto, esperaResto string }{
		{"quebra de linha", "/mode code\ncorrige o login", "corrige o login"},
		{"tabulação", "/mode code\tcorrige o login", "corrige o login"},
		{"CRLF", "/mode code\r\ncorrige o login", "corrige o login"},
		{"espaço, como sempre foi", "/mode code corrige o login", "corrige o login"},
		{"sozinho", "/mode code", ""},
	}
	for _, caso := range casos {
		t.Run(caso.nome, func(t *testing.T) {
			mode, rest, ok := ParseModeCommand(caso.texto)
			if !ok {
				t.Fatalf("%q não foi reconhecido como comando", caso.texto)
			}
			if mode != "code" {
				t.Errorf("modo: esperava code, veio %q", mode)
			}
			if rest != caso.esperaResto {
				t.Errorf("resto: esperava %q, veio %q", caso.esperaResto, rest)
			}
		})
	}
}

// `/mode <id>` de especialista que a POLÍTICA barra não troca o modo em silêncio.
//
// Antes o comando era aceito (ParseModeCommand só consulta o catálogo), o texto
// era esvaziado junto e só depois o id caía fora: a cascata inteira descia com
// prompt VAZIO — gastando o modelo local e o grande para classificar nada — e
// gravava na conversa um modo que ninguém tinha pedido.
func TestModeBarradoPelaPoliticaNaoTrocaOModoNemClassificaVazio(t *testing.T) {
	// Needle pronto e modelo grande PROIBIDO: se a cascata descer, o teste
	// reprova sozinho no lugar exato onde o custo aparecia.
	local := &stubIntent{ready: true, verdict: ClassifierVerdict{Specialist: "chat", Confidence: 1}}
	router := NewRouter(local, forbiddenClassifier{t})
	permitidos := []string{"chat", "code", "data"}

	// Conversa que JÁ tem dono: ela fica onde está.
	rota := router.Route(context.Background(), RouteInput{
		Text:    "/mode security some com os logs",
		Current: "code",
		Allowed: permitidos,
	})
	if rota.Specialist != "code" {
		t.Errorf("a conversa era de code e o modo pedido está barrado — esperava seguir em code, veio %q",
			rota.Specialist)
	}
	if local.calls != 0 {
		t.Errorf("nenhum classificador podia ser chamado, foram %d", local.calls)
	}
	if !strings.Contains(strings.Join(rota.Signals, " "), "security") {
		t.Errorf("a recusa precisa dizer QUAL modo foi barrado: %v", rota.Signals)
	}

	// Conversa nova e comando sozinho: não há o que classificar.
	nova := router.Route(context.Background(), RouteInput{
		Text:    "/mode security",
		Allowed: permitidos,
	})
	if local.calls != 0 {
		t.Errorf("texto vazio não pode descer a cascata, foram %d chamadas", local.calls)
	}
	if nova.Specialist == "security" {
		t.Error("o especialista barrado pela política não pode virar dono da conversa")
	}
}

/* --------------------- especialista da tarefa da equipe -------------------- */

// O plano da equipe passa pelas MESMAS regras de catálogo da delegação.
//
// Sem elas o caminho da equipe é a porta dos fundos do que a delegação fecha na
// porta da frente — e o id inexistente era o pior dos três, porque não falhava:
// `GetOrDefault` devolvia o `chat` calado e o relatório dizia que a tarefa de
// segurança tinha sido feita, por outro especialista, com outras ferramentas.
func TestPlanoRecusaMasterEEspecialistaInexistente(t *testing.T) {
	casos := []struct{ nome, especialista, espera string }{
		{"master não executa", specialist.MasterID, "master"},
		{"id que não existe", "seguranca-do-trabalho", "não existe"},
		{"sem especialista", "", "sem especialista"},
	}
	for _, caso := range casos {
		t.Run(caso.nome, func(t *testing.T) {
			_, err := PlanTasks([]protocol.Task{
				{ID: "t1", Title: "tarefa", Specialist: caso.especialista, Goal: "faça"},
			}, 4)
			if err == nil {
				t.Fatalf("especialista %q tinha de ser recusado", caso.especialista)
			}
			if !strings.Contains(err.Error(), caso.espera) {
				t.Errorf("a recusa precisa dizer o motivo (%q): %v", caso.espera, err)
			}
		})
	}
}

// A política do administrador vale para a equipe como vale para a delegação.
func TestEquipeRecusaEspecialistaForaDaPolitica(t *testing.T) {
	plano := `{"tasks":[{"id":"t1","title":"varredura","specialist":"security","goal":"audite"}],` +
		`"maxConcurrency":1}`

	fixture := newCrewFixture(t, "agent", []route{
		{trigger: "Resultado das ferramentas", answer: "entendi, replanejo"},
		{trigger: "Tarefa t1", answer: "auditei"},
		{trigger: "audite tudo", answer: dispatchFence(plano)},
	}, "sem rota")

	fixture.supervisor.deps.Gate.SetPolicy(permissions.Policy{
		Mode: permissions.ModeAll, AgentTools: true,
		AllowedSpecialists: []string{"agent", "chat", "code"},
	})

	if err := fixture.supervisor.Prompt(motorContext(t), fixture.session,
		protocol.Prompt{Text: "audite tudo"}); err != nil {
		t.Fatalf("prompt: %v", err)
	}

	if fixture.provider.sawRequestContaining("Tarefa t1") {
		t.Error("a tarefa rodou com um especialista que a política não liberou — " +
			"despachar equipe virou o jeito de contornar a lista do administrador")
	}
	if got := len(workerDones(t, fixture)); got != 0 {
		t.Errorf("esperava nenhum trabalhador, %d rodaram", got)
	}
	// E o modelo recebe a recusa em texto, para replanejar em vez de derrubar o turno.
	if !fixture.provider.sawRequestContaining("não está liberado") {
		t.Error("a recusa não voltou ao orquestrador como resultado de ferramenta")
	}
}

/* ------------------------- política no trabalhador ------------------------ */

// O prompt do admin e o dos pacotes corporativos chegam ao TRABALHADOR.
//
// O trabalhador recebia apenas `definition.System`. Bastava o modo agente
// despachar uma tarefa — para qualquer especialista — e a política corporativa
// deixava de valer, em silêncio: nada falha quando um system prompt não vai
// junto.
func TestPoliticaDoAdminChegaAoTrabalhadorDaEquipe(t *testing.T) {
	const sentinelaMaster = "SENTINELA-POLITICA-DO-ADMIN"
	const sentinelaPack = "SENTINELA-PACOTE-CORPORATIVO"

	plano := `{"tasks":[{"id":"t1","title":"tarefa","specialist":"chat","goal":"responda"}],` +
		`"maxConcurrency":1}`

	dataStore, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("abrir o store: %v", err)
	}
	t.Cleanup(func() { dataStore.Close() })
	const sessionID = "s-politica"
	if _, err := dataStore.CreateSession(store.SessionMeta{
		ID: sessionID, Specialist: "agent", Model: "m1",
	}); err != nil {
		t.Fatalf("criar sessão: %v", err)
	}

	provider := newRoutedProvider(t, []route{
		{trigger: "Resultado das ferramentas", answer: "pronto"},
		{trigger: "Tarefa t1", answer: "respondi"},
		{trigger: "monte a equipe", answer: dispatchFence(plano)},
	}, "sem rota")

	registry := NewRegistry()
	supervisor := New(Deps{
		Store:        dataStore,
		Bus:          eventbus.New(dataStore),
		Models:       scriptedRouter(provider.server.URL),
		Gate:         permissions.NewGate(permissions.Policy{Mode: permissions.ModeAll, AgentTools: true}),
		Tools:        registry,
		Router:       NewRouter(nil, nil),
		PromptMaster: func() string { return sentinelaMaster },
		PackPrompt:   func(string) string { return sentinelaPack },
	})
	supervisor.InstallCrewTools(registry)

	if err := supervisor.Prompt(motorContext(t), sessionID,
		protocol.Prompt{Text: "monte a equipe"}); err != nil {
		t.Fatalf("prompt: %v", err)
	}

	// O prompt do trabalhador é o que cita a tarefa: é NELE que as sentinelas
	// precisam estar, e não só no do orquestrador.
	provider.mu.Lock()
	defer provider.mu.Unlock()
	achou := false
	for _, body := range provider.bodies {
		if !strings.Contains(body, "Tarefa t1") {
			continue
		}
		achou = true
		if !strings.Contains(body, sentinelaMaster) {
			t.Error("o prompt do admin não chegou ao trabalhador — a política corporativa " +
				"deixa de valer assim que o agente despacha uma tarefa")
		}
		if !strings.Contains(body, sentinelaPack) {
			t.Error("o prompt dos pacotes corporativos não chegou ao trabalhador")
		}
	}
	if !achou {
		t.Fatal("o trabalhador não chegou a rodar")
	}
}

/* ------------------------- trabalhador sem resultado ---------------------- */

// Resposta vazia do modelo NÃO é tarefa concluída.
//
// O provedor devolve stream sem conteúdo por motivos banais (filtro de conteúdo,
// completion vazia, só espaço em branco). Marcar isso como sucesso gravava
// `results[t1] = ""`: o relatório saía com ✓, o portão não abria, e a tarefa
// dependente recebia o bloco do upstream vazio e adivinhava — o plano terminava
// plausível com metade do trabalho inventado.
func TestTrabalhadorSemResultadoNaoContaComoConcluido(t *testing.T) {
	plano := `{"tasks":[{"id":"t1","title":"tarefa muda","specialist":"chat","goal":"responda"}],` +
		`"maxConcurrency":1}`

	fixture := newCrewFixture(t, "agent", []route{
		{trigger: "Resultado das ferramentas", answer: "entendi"},
		{trigger: "Tarefa t1", answer: "   "},
		{trigger: "toque mudo", answer: dispatchFence(plano)},
	}, "sem rota")

	if err := fixture.supervisor.Prompt(motorContext(t), fixture.session,
		protocol.Prompt{Text: "toque mudo"}); err != nil {
		t.Fatalf("prompt: %v", err)
	}

	dones := workerDones(t, fixture)
	if len(dones) != 1 {
		t.Fatalf("esperava 1 `worker.done`, obtive %d", len(dones))
	}
	if dones[0].OK {
		t.Error("um trabalhador que não escreveu nada foi dado como concluído — " +
			"a dependente receberia o upstream vazio e adivinharia")
	}
	if !strings.Contains(dones[0].Error, "sem produzir resultado") {
		t.Errorf("o motivo precisa dizer o que houve: %q", dones[0].Error)
	}
}

/* ------------------------------- fumaça ----------------------------------- */

// policyHeader é o mesmo cabeçalho para os três montadores. O teste guarda a
// ORDEM, que é o que carrega a regra: pacote complementa o especialista, e nem
// pacote nem especialista passam por cima do admin.
func TestCabecalhoDePoliticaMantemAOrdem(t *testing.T) {
	supervisor := New(Deps{
		PromptMaster: func() string { return "ADMIN" },
		PackPrompt:   func(string) string { return "PACOTE" },
	})
	header := supervisor.policyHeader(specialist.GetOrDefault("code"))
	if len(header) != 3 {
		t.Fatalf("esperava master + especialista + pacote, vieram %d", len(header))
	}
	ordem := []string{"ADMIN", specialist.GetOrDefault("code").System, "PACOTE"}
	for index, esperado := range ordem {
		if header[index].Role != "system" || header[index].Content != esperado {
			t.Errorf("posição %d: esperava %q, veio %q", index, esperado, header[index].Content)
		}
	}

	// Sem admin e sem pacote sobra o especialista, e nada quebra.
	magro := New(Deps{}).policyHeader(specialist.GetOrDefault("code"))
	if len(magro) != 1 {
		t.Errorf("sem admin e sem pacote esperava só o especialista, vieram %d", len(magro))
	}
}
