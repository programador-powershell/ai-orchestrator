// O PLANEJAMENTO DO MASTER — o contrato de master_plan.go, ponta a ponta.
//
// O defeito que este arquivo guarda (teste do dono): "crie um site completo em
// next" delegava DIRETO ao Código e o Design ficava de fora — a corrente
// dependia de a persona do Código lembrar de delegar, que é instrução, não
// mecânica. As fronteiras, cada uma com teste próprio:
//
//   - lista VÁLIDA: visível e durável na raiz ANTES de qualquer delegação, e
//     os itens executam em ordem de dependência, cada um pelo masterDelegate
//     de sempre (mesma-filha-por-par, rota na filha);
//   - o goal do dependente CITA a entrega do anterior — e, com staging real,
//     o dependente LÊ no projeto o arquivo que o anterior JÁ promoveu;
//   - saída inválida → retry UMA vez → fallback para o item único da cascata
//     (o comportamento de antes, byte a byte: sem lista, sem mensagem);
//   - ciclo e teto são recusados pela validação (a mesma régua da Equipe);
//   - falha de um item corta os dependentes com aviso honesto na raiz e os
//     independentes seguem.
package supervisor

import (
	"strings"
	"sync/atomic"
	"testing"

	"aibot/gateway/internal/eventbus"
	"aibot/gateway/internal/permissions"
	"aibot/gateway/internal/protocol"
	"aibot/gateway/internal/specialist"
	"aibot/gateway/internal/store"
)

// planoCodigoDesign é a lista que o modelo devolve no cenário do dono: o
// Código estrutura, o Design entra DEPOIS, lendo o que foi entregue.
const planoCodigoDesign = `[{"specialist":"code","goal":"estruture o site no projeto","dependsOn":[]},` +
	`{"specialist":"design","goal":"defina o visual do site","dependsOn":[1]}]`

/* ------------------------- validação (função pura) ------------------------- */

func TestValidaPlanoDoMasterAceitaListaEDevolveOrdemTopologica(t *testing.T) {
	// O item 1 depende do 2: a ordem de EXECUÇÃO tem de inverter a ordem de
	// declaração — é o PlanTasks (a régua da Equipe) quem decide, não a lista.
	plano, err := validaPlanoDoMaster([]masterPlanItem{
		{Specialist: "design", Goal: "defina o visual", DependsOn: []int{2}},
		{Specialist: "code", Goal: "estruture o site"},
	}, nil)
	if err != nil {
		t.Fatalf("lista válida foi recusada: %v", err)
	}
	if !plano.planejado {
		t.Error("o plano validado tinha de sair marcado como planejado")
	}
	if len(plano.ordem) != 2 || plano.ordem[0] != 1 || plano.ordem[1] != 0 {
		t.Errorf("a ordem tinha de ser [code, design] (índices [1 0]), veio %v", plano.ordem)
	}
}

func TestValidaPlanoDoMasterRecusaOQueAEquipeRecusaria(t *testing.T) {
	cases := []struct {
		name   string
		items  []masterPlanItem
		reason string
	}{
		{"vazio", nil, "pelo menos um item"},
		{"teto de itens", []masterPlanItem{
			{Specialist: "code", Goal: "a"}, {Specialist: "code", Goal: "b"},
			{Specialist: "code", Goal: "c"}, {Specialist: "code", Goal: "d"},
			{Specialist: "code", Goal: "e"},
		}, "no máximo 4"},
		{"goal vazio", []masterPlanItem{{Specialist: "code", Goal: "  "}}, "sem goal"},
		{"especialista inexistente", []masterPlanItem{{Specialist: "xpto", Goal: "a"}}, "não existe"},
		{"o master não executa", []masterPlanItem{{Specialist: "master", Goal: "a"}}, "master"},
		{"dependência fantasma", []masterPlanItem{{Specialist: "code", Goal: "a", DependsOn: []int{9}}}, "não existe"},
		{"auto-dependência", []masterPlanItem{{Specialist: "code", Goal: "a", DependsOn: []int{1}}}, "si mesma"},
		{"ciclo", []masterPlanItem{
			{Specialist: "code", Goal: "a", DependsOn: []int{2}},
			{Specialist: "design", Goal: "b", DependsOn: []int{1}},
		}, "ciclo"},
	}
	for _, caso := range cases {
		t.Run(caso.name, func(t *testing.T) {
			if _, err := validaPlanoDoMaster(caso.items, nil); err == nil ||
				!strings.Contains(err.Error(), caso.reason) {
				t.Errorf("esperava recusa com %q, obtive %v", caso.reason, err)
			}
		})
	}
}

// A POLÍTICA da sessão vale no plano como vale na delegação e na Equipe: o
// portão não chega ao PlanTasks, então a checagem é do contrato do master.
func TestValidaPlanoDoMasterRespeitaAPolitica(t *testing.T) {
	allows := func(id string) bool { return id != "design" }
	_, err := validaPlanoDoMaster([]masterPlanItem{
		{Specialist: "design", Goal: "defina o visual"},
	}, allows)
	if err == nil || !strings.Contains(err.Error(), "não está liberado") {
		t.Errorf("especialista barrado pela política tinha de recusar o plano: %v", err)
	}
}

// parseMasterPlan tolera prosa e cerca em volta — a mesma tolerância do
// parseVerdict: etiqueta do modelo não pode derrubar o planejamento.
func TestParseMasterPlanExtraiOArrayComProsaEmVolta(t *testing.T) {
	items, err := parseMasterPlan("Claro! Segue o plano:\n```json\n" + planoCodigoDesign + "\n```")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(items) != 2 || items[0].Specialist != "code" || items[1].DependsOn[0] != 1 {
		t.Errorf("itens extraídos errados: %+v", items)
	}
	if _, err := parseMasterPlan("não vou dar lista nenhuma"); err == nil {
		t.Error("resposta sem array tinha de falhar o parse")
	}
}

/* -------------------- lista visível e execução em ordem -------------------- */

// O caminho feliz do contrato: o master LISTA antes de delegar — a mensagem em
// markdown de lista sai na raiz ANTES do primeiro envelope de delegação — e os
// itens executam em ordem, cada um na própria filha, com o goal do dependente
// citando a entrega do anterior.
func TestPlanoDoMasterListaAntesDeDelegarEExecutaEmOrdem(t *testing.T) {
	fixture := newRaizFixture(t, []route{
		{trigger: "PLANEJAMENTO DO MASTER", answer: planoCodigoDesign},
		{trigger: "defina o visual", answer: "visual definido"},
		{trigger: "estruture o site", answer: "estrutura pronta em index.html"},
	})

	if err := fixture.supervisor.Prompt(motorContext(t), fixture.session,
		protocol.Prompt{Text: pedidoDeTrabalho}); err != nil {
		t.Fatalf("prompt: %v", err)
	}

	// A LISTA na raiz: uma fala do master, markdown de lista, com a
	// dependência dita em palavras.
	falas := messageTexts(t, fixture.store, fixture.session, "assistant")
	if len(falas) != 1 {
		t.Fatalf("esperava só a lista do plano como fala na raiz, obtive %d: %q", len(falas), falas)
	}
	for _, want := range []string{"Para este pedido preciso de", "1. **Código**", "2. **Design**", "(depois de 1)"} {
		if !strings.Contains(falas[0], want) {
			t.Errorf("a lista visível não carrega %q:\n%s", want, falas[0])
		}
	}

	// ANTES de qualquer delegação: no log da raiz, a mensagem da lista vem
	// antes do primeiro KindDelegate — é a ordem dos envelopes que prova.
	envelopes, err := fixture.store.Since(fixture.session, 0, 1000)
	if err != nil {
		t.Fatalf("ler o log: %v", err)
	}
	lista, primeiraDelegacao := -1, -1
	for index, envelope := range envelopes {
		switch envelope.Kind {
		case protocol.KindMessage:
			var message protocol.Message
			if envelope.Decode(&message) == nil && strings.Contains(message.Text, "Para este pedido preciso de") && lista < 0 {
				lista = index
			}
		case protocol.KindDelegate:
			if primeiraDelegacao < 0 {
				primeiraDelegacao = index
			}
		}
	}
	if lista < 0 || primeiraDelegacao < 0 || lista >= primeiraDelegacao {
		t.Errorf("a lista tinha de estar no log ANTES da primeira delegação: lista=%d, delegação=%d",
			lista, primeiraDelegacao)
	}

	// A ORDEM da execução: code abre e FECHA antes de o design abrir — o
	// dependente só roda depois da entrega do anterior.
	delegacoes := delegateEnvelopes(t, fixture.store, fixture.session)
	if len(delegacoes) != 4 {
		t.Fatalf("esperava 2 pares abre/fecha (code e design), obtive %d: %+v", len(delegacoes), delegacoes)
	}
	if delegacoes[0].To != "code" || delegacoes[0].Done {
		t.Errorf("o primeiro envelope tinha de abrir master→code: %+v", delegacoes[0])
	}
	if delegacoes[1].To != "code" || !delegacoes[1].Done ||
		!strings.Contains(delegacoes[1].Result, "estrutura pronta") {
		t.Errorf("o segundo envelope tinha de fechar o code com o resultado: %+v", delegacoes[1])
	}
	if delegacoes[2].To != "design" || delegacoes[2].Done {
		t.Errorf("o terceiro envelope tinha de abrir master→design: %+v", delegacoes[2])
	}
	if delegacoes[3].To != "design" || !delegacoes[3].Done ||
		!strings.Contains(delegacoes[3].Result, "visual definido") {
		t.Errorf("o quarto envelope tinha de fechar o design: %+v", delegacoes[3])
	}

	// O goal do DEPENDENTE cita a entrega do anterior: o sub-turno do design
	// recebeu o item 1 nomeado e o resultado que o code entregou.
	fixture.provider.mu.Lock()
	corpoDoDesign := ""
	for _, body := range fixture.provider.bodies {
		if strings.Contains(body, "defina o visual") {
			corpoDoDesign = body
		}
	}
	fixture.provider.mu.Unlock()
	if corpoDoDesign == "" {
		t.Fatal("o sub-turno do design não chegou ao modelo")
	}
	for _, want := range []string{"Entrega do item 1", "estrutura pronta em index.html", "fs.list/fs.read"} {
		if !strings.Contains(corpoDoDesign, want) {
			t.Errorf("o goal do dependente não cita %q — ele desenharia de cabeça", want)
		}
	}

	// Cada item na PRÓPRIA filha, com a rota publicada lá: o dono da cascata
	// mantém a rota decidida; o item escalado pelo plano sai como RouteModel.
	filhaDoDesign := store.ChildSessionID(fixture.session, "design")
	rotas := envelopesByKind(t, fixture.store, filhaDoDesign, protocol.KindRoute)
	if len(rotas) != 1 {
		t.Fatalf("esperava 1 rota na filha do design, obtive %d", len(rotas))
	}
	var rota protocol.Route
	if err := rotas[0].Decode(&rota); err != nil {
		t.Fatalf("decodificar a rota do design: %v", err)
	}
	if rota.Specialist != "design" || rota.Reason != protocol.RouteModel ||
		rota.Surface != string(specialist.SurfaceCanvas) {
		t.Errorf("a rota do item planejado tinha de ser design/model/canvas: %+v", rota)
	}

	// A raiz continua orquestradora: sem dono, sem rota, um done só.
	meta, err := fixture.store.GetSession(fixture.session)
	if err != nil {
		t.Fatalf("ler a raiz: %v", err)
	}
	if meta.Specialist != "" {
		t.Errorf("a raiz ganhou o dono %q", meta.Specialist)
	}
	if rotas := envelopesByKind(t, fixture.store, fixture.session, protocol.KindRoute); len(rotas) != 0 {
		t.Errorf("a raiz recebeu %d rota(s)", len(rotas))
	}
	if dones := envelopesByKind(t, fixture.store, fixture.session, protocol.KindDone); len(dones) != 1 {
		t.Errorf("esperava 1 done na raiz, obtive %d", len(dones))
	}
}

/* --------------------- inválido → retry → item único ----------------------- */

// Saída inválida ganha UM retry com o erro; inválida de novo, o comportamento
// ATUAL continua — item único com o dono da cascata, sem lista visível. É a
// regressão zero dos testes do masterDelegate, agora afirmada de propósito.
func TestPlanoInvalidoTentaUmaVezEDepoisCaiNoItemUnico(t *testing.T) {
	fixture := newRaizFixture(t, []route{
		{trigger: "PLANEJAMENTO DO MASTER", answer: "não sei planejar nada"},
		{trigger: pedidoDeTrabalho, answer: "<html>ok</html>"},
	})

	if err := fixture.supervisor.Prompt(motorContext(t), fixture.session,
		protocol.Prompt{Text: pedidoDeTrabalho}); err != nil {
		t.Fatalf("prompt: %v", err)
	}

	// O retry aconteceu UMA vez: duas chamadas com o contrato, nem mais nem menos.
	if got := fixture.provider.countRequestsContaining("PLANEJAMENTO DO MASTER"); got != 2 {
		t.Errorf("esperava 2 chamadas de planejamento (a primeira + um retry), obtive %d", got)
	}
	// Sem lista visível: o fallback é o comportamento de antes.
	if falas := messageTexts(t, fixture.store, fixture.session, "assistant"); len(falas) != 0 {
		t.Errorf("o fallback não publica lista nenhuma na raiz: %q", falas)
	}
	delegacoes := delegateEnvelopes(t, fixture.store, fixture.session)
	if len(delegacoes) != 2 || delegacoes[0].To != "code" ||
		!strings.Contains(delegacoes[1].Result, "<html>ok</html>") {
		t.Errorf("o item único da cascata tinha de rodar como sempre: %+v", delegacoes)
	}
	if dones := envelopesByKind(t, fixture.store, fixture.session, protocol.KindDone); len(dones) != 1 {
		t.Errorf("esperava 1 done, obtive %d", len(dones))
	}
}

// Ciclo é recusado pela validação (a régua da Equipe) e o desfecho é o mesmo
// fallback — nunca uma execução de um grafo que não fecha.
func TestPlanoComCicloCaiNoItemUnico(t *testing.T) {
	const planoComCiclo = `[{"specialist":"code","goal":"a","dependsOn":[2]},` +
		`{"specialist":"design","goal":"b","dependsOn":[1]}]`
	fixture := newRaizFixture(t, []route{
		{trigger: "PLANEJAMENTO DO MASTER", answer: planoComCiclo},
		{trigger: pedidoDeTrabalho, answer: "<html>ok</html>"},
	})

	if err := fixture.supervisor.Prompt(motorContext(t), fixture.session,
		protocol.Prompt{Text: pedidoDeTrabalho}); err != nil {
		t.Fatalf("prompt: %v", err)
	}

	if _, err := fixture.store.GetSession(store.ChildSessionID(fixture.session, "design")); err == nil {
		t.Error("o ciclo virou execução — a filha do design não podia nascer")
	}
	delegacoes := delegateEnvelopes(t, fixture.store, fixture.session)
	if len(delegacoes) != 2 || delegacoes[0].To != "code" {
		t.Errorf("esperava só o item único do code: %+v", delegacoes)
	}
}

/* ------------------- falha corta dependentes, não os demais ----------------- */

// A regra da Equipe no caminho do master: o item que falhou corta os
// DEPENDENTES dele — com aviso honesto na raiz — e os INDEPENDENTES seguem.
func TestFalhaDeUmItemCortaDependentesEIndependentesSeguem(t *testing.T) {
	const planoComTresItens = `[{"specialist":"code","goal":"estruture o site","dependsOn":[]},` +
		`{"specialist":"design","goal":"defina o visual","dependsOn":[1]},` +
		`{"specialist":"data","goal":"modele o banco","dependsOn":[]}]`
	fixture := newRaizFixture(t, []route{
		{trigger: "PLANEJAMENTO DO MASTER", answer: planoComTresItens},
		{trigger: "estruture o site", answer: "@@500"},
		{trigger: "modele o banco", answer: "banco modelado"},
	})

	if err := fixture.supervisor.Prompt(motorContext(t), fixture.session,
		protocol.Prompt{Text: pedidoDeTrabalho}); err != nil {
		t.Fatalf("prompt: %v", err)
	}

	// O design NÃO rodou: nem filha, nem envelope de delegação para ele.
	if _, err := fixture.store.GetSession(store.ChildSessionID(fixture.session, "design")); err == nil {
		t.Error("o dependente de um item que falhou rodou mesmo assim")
	}
	delegacoes := delegateEnvelopes(t, fixture.store, fixture.session)
	if len(delegacoes) != 4 {
		t.Fatalf("esperava code (falha) + data (sucesso), 4 envelopes, obtive %d: %+v",
			len(delegacoes), delegacoes)
	}
	for _, payload := range delegacoes {
		if payload.To == "design" {
			t.Errorf("abriu delegação para o dependente cortado: %+v", payload)
		}
	}

	// Os avisos honestos na raiz: a falha do code E o corte do design, com a
	// dependência nomeada.
	avisos := messageTexts(t, fixture.store, fixture.session, "system")
	if len(avisos) != 2 {
		t.Fatalf("esperava 2 avisos (falha + corte), obtive %d: %q", len(avisos), avisos)
	}
	if !strings.Contains(avisos[0], "NÃO DEU CERTO") {
		t.Errorf("o primeiro aviso tinha de ser a falha do code: %q", avisos[0])
	}
	if !strings.Contains(avisos[1], "não rodou") || !strings.Contains(avisos[1], "item 1") {
		t.Errorf("o corte do dependente tinha de nomear a dependência: %q", avisos[1])
	}

	// O independente SEGUIU: o data entregou.
	dataFechou := false
	for _, payload := range delegacoes {
		if payload.To == "data" && payload.Done && strings.Contains(payload.Result, "banco modelado") {
			dataFechou = true
		}
	}
	if !dataFechou {
		t.Error("o item independente tinha de rodar e entregar apesar da falha do outro")
	}
	if dones := envelopesByKind(t, fixture.store, fixture.session, protocol.KindDone); len(dones) != 1 {
		t.Errorf("o turno tinha de fechar com 1 done, obtive %d", len(dones))
	}
}

/* -------------------- o dependente lê o que foi ENTREGUE -------------------- */

// Com o staging REAL ligado: o item 1 (code) grava na CÓPIA dele e entrega; o
// item 2 (design) nasce numa cópia NOVA — feita do projeto já com a entrega
// dentro — e LÊ o arquivo com fs.read. É a frase "o Design lê os arquivos JÁ
// promovidos" executada, não afirmada.
func TestItemDependenteLeOArquivoQueOAnteriorPromoveu(t *testing.T) {
	var designLeuOEntregue atomic.Bool
	var citacaoDesceu atomic.Bool
	hook := func(body string) {
		if strings.Contains(body, "fs.read =>") && strings.Contains(body, "OSSO-DO-SITE") {
			designLeuOEntregue.Store(true)
		}
		if strings.Contains(body, "Entrega do item 1") && strings.Contains(body, "arquivos: index.html") {
			citacaoDesceu.Store(true)
		}
	}
	server := stagingProvider(t, []route{
		{trigger: "PLANEJAMENTO DO MASTER", answer: planoCodigoDesign},
		{trigger: "fs.read =>", answer: "visual definido com base no esqueleto lido"},
		{trigger: "gravado: index.html", answer: "estrutura pronta em index.html"},
		{trigger: "defina o visual", answer: "lendo\n\n" + fenceTool("fs.read", map[string]any{"path": "index.html"})},
		{trigger: "estruture o site", answer: "gravando\n\n" + fenceWrite("index.html", "OSSO-DO-SITE")},
	}, hook)
	fixture := newStagingTurnFixture(t, server, true, "")

	if err := fixture.supervisor.Prompt(motorContext(t), fixture.session,
		protocol.Prompt{Text: pedidoDeTrabalho}); err != nil {
		t.Fatalf("prompt: %v", err)
	}

	// A entrega do item 1 chegou ao projeto — é dela que o item 2 leu.
	if leEm(t, fixture.projeto, "index.html") != "OSSO-DO-SITE" {
		t.Error("a entrega do item 1 não chegou ao projeto")
	}
	if !citacaoDesceu.Load() {
		t.Error("o goal do dependente não citou os caminhos entregues (coletor da promoção)")
	}
	if !designLeuOEntregue.Load() {
		t.Error("o design não leu o arquivo promovido — a cópia dele nasceu antes da entrega?")
	}
	// Nenhuma cópia sobra: cada item limpou a própria (promoção ou descarte).
	if entries := stagingEntries(t, fixture.store); len(entries) != 0 {
		t.Errorf("sobraram %d cópia(s) de staging", len(entries))
	}
	if erros := envelopesByKind(t, fixture.store, fixture.session, protocol.KindError); len(erros) != 0 {
		t.Errorf("turno feliz não deixa KindError, obtive %d", len(erros))
	}
	delegacoes := delegateEnvelopes(t, fixture.store, fixture.session)
	if len(delegacoes) != 4 {
		t.Fatalf("esperava os 2 pares abre/fecha, obtive %d", len(delegacoes))
	}
}

/* --------------------- auditoria (c): delegável + memória ------------------- */

// A auditoria do lado Go, item (c): TODO especialista do catálogo é delegável
// (aparece na lista de quem o master pode chamar) e o childHistory funciona
// para ele — o espelho grava, a memória volta na segunda chamada.
func TestTodoEspecialistaEDelegavelEComMemoriaDeFilha(t *testing.T) {
	peers := delegableSpecialists(specialist.MasterID, nil)
	listados := make(map[string]bool, len(peers))
	for _, peer := range peers {
		listados[peer.ID] = true
	}
	for _, definition := range specialist.All() {
		if !listados[definition.ID] {
			t.Errorf("o especialista %s não aparece entre os delegáveis do master", definition.ID)
		}
	}

	dataStore, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("abrir o store: %v", err)
	}
	t.Cleanup(func() { dataStore.Close() })
	const sessionID = "s-auditoria"
	if _, err := dataStore.CreateSession(store.SessionMeta{ID: sessionID, Title: "auditoria"}); err != nil {
		t.Fatalf("criar sessão: %v", err)
	}
	supervisor := New(Deps{
		Store: dataStore,
		Bus:   eventbus.New(dataStore),
		Gate:  permissions.NewGate(permissions.DefaultPolicy()),
		Tools: NewRegistry(),
	})

	for _, definition := range specialist.All() {
		filho := supervisor.mirrorDelegation(sessionID, definition, "primeiro pedido para "+definition.ID)
		if filho == "" {
			t.Fatalf("o espelho não abriu a conversa do bot %s", definition.ID)
		}
		if err := supervisor.emit(filho, "t0", protocol.KindMessage,
			protocol.Actor{Kind: protocol.ActorSpecialist, ID: definition.ID, Specialist: definition.ID},
			protocol.Message{Role: "assistant", Text: "resposta anterior de " + definition.ID}); err != nil {
			t.Fatalf("gravar a resposta de %s: %v", definition.ID, err)
		}

		memoria := supervisor.childHistory(sessionID, definition.ID)
		texto := ""
		for _, message := range memoria {
			texto += message.Role + ": " + message.Content + "\n"
		}
		if !strings.Contains(texto, "primeiro pedido para "+definition.ID) ||
			!strings.Contains(texto, "resposta anterior de "+definition.ID) {
			t.Errorf("o childHistory de %s não devolve o par pedido/resposta:\n%s", definition.ID, texto)
		}
	}
}
