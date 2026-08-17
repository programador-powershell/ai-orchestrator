// O motor de ponta a ponta: um bot só, e vários bots.
//
// Os testes de equipe que existiam (crew_test.go) cobriam duas funções puras —
// `escalation` e `gateReason`. O CAMINHO, de `task.dispatch` até o relatório de
// volta, nunca tinha sido executado. É o que este arquivo faz.
//
// O provedor daqui roteia por CONTEÚDO, não por ordem (routedProvider). Numa
// equipe os trabalhadores rodam concorrentes, então um roteiro sequencial
// entregaria a fala de um trabalhador para outro conforme o escalonador do dia —
// o teste passaria e falharia sozinho, que é pior que não existir.
package supervisor

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"aibot/gateway/internal/eventbus"
	"aibot/gateway/internal/permissions"
	"aibot/gateway/internal/protocol"
	"aibot/gateway/internal/store"
)

/* ------------------------------- bancada --------------------------------- */

// routedProvider responde conforme o que a mensagem CONTÉM. `routes` é uma lista
// ordenada de (gatilho, resposta): vence o primeiro gatilho que aparecer no
// corpo. Determinístico sob concorrência, que é o ponto.
type routedProvider struct {
	server *httptest.Server
	// bodies guarda o texto de cada requisição, para o teste afirmar o que o
	// trabalhador REALMENTE recebeu (é assim que se prova a propagação do
	// resultado de uma tarefa para a dependente).
	mu     sync.Mutex
	bodies []string
	calls  int32
	// peak é o maior número de chamadas simultâneas observado — a medida direta
	// do paralelismo real, em vez da confiança no que o plano prometeu.
	inFlight int32
	peak     int32
}

type route struct{ trigger, answer string }

func newRoutedProvider(t *testing.T, routes []route, fallback string) *routedProvider {
	t.Helper()
	provider := &routedProvider{}
	provider.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		now := atomic.AddInt32(&provider.inFlight, 1)
		defer atomic.AddInt32(&provider.inFlight, -1)
		for {
			peak := atomic.LoadInt32(&provider.peak)
			if now <= peak || atomic.CompareAndSwapInt32(&provider.peak, peak, now) {
				break
			}
		}
		atomic.AddInt32(&provider.calls, 1)

		var request struct {
			Messages []struct {
				Content string `json:"content"`
			} `json:"messages"`
		}
		body := ""
		if err := json.NewDecoder(r.Body).Decode(&request); err == nil {
			parts := make([]string, 0, len(request.Messages))
			for _, message := range request.Messages {
				parts = append(parts, message.Content)
			}
			body = strings.Join(parts, "\n")
		}

		provider.mu.Lock()
		provider.bodies = append(provider.bodies, body)
		provider.mu.Unlock()

		answer := fallback
		for _, candidate := range routes {
			if strings.Contains(body, candidate.trigger) {
				answer = candidate.answer
				break
			}
		}
		// Gatilho reservado: derruba a chamada para o teste poder produzir um
		// trabalhador que FALHA sem inventar um modo de falha que não existe.
		if answer == "@@500" {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}

		// O provedor abre a janela de concorrência de propósito: sem esta pausa
		// os trabalhadores de uma onda podem se revezar tão rápido que o pico
		// medido fica em 1 e o teste de paralelismo não testaria nada.
		time.Sleep(15 * time.Millisecond)

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
	t.Cleanup(provider.server.Close)
	return provider
}

// sawRequestContaining diz se ALGUM prompt enviado ao modelo continha o texto.
func (p *routedProvider) sawRequestContaining(needle string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, body := range p.bodies {
		if strings.Contains(body, needle) {
			return true
		}
	}
	return false
}

func (p *routedProvider) countRequestsContaining(needle string) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	count := 0
	for _, body := range p.bodies {
		if strings.Contains(body, needle) {
			count++
		}
	}
	return count
}

// crewFixture é o supervisor de um teste de motor, com a equipe instalada.
type crewFixture struct {
	supervisor *Supervisor
	store      *store.Store
	provider   *routedProvider
	session    string
}

// newCrewFixture monta o motor com política "aprovar tudo".
//
// A política de produção (ModeEdits) manda `task.dispatch` — risco `execute` —
// para aprovação humana, e um teste sem ninguém para clicar ficaria dez minutos
// parado no portão em vez de falhar. O que está sob teste aqui é a MECÂNICA da
// equipe; que ela peça autorização antes de montar é assunto de outro teste.
func newCrewFixture(t *testing.T, specialistID string, routes []route, fallback string) *crewFixture {
	t.Helper()
	dataStore, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("abrir o store: %v", err)
	}
	t.Cleanup(func() { dataStore.Close() })

	const sessionID = "s-motor"
	if _, err := dataStore.CreateSession(store.SessionMeta{
		ID: sessionID, Title: "motor", Specialist: specialistID, Model: "m1",
	}); err != nil {
		t.Fatalf("criar sessão: %v", err)
	}

	provider := newRoutedProvider(t, routes, fallback)
	registry := NewRegistry()
	supervisor := New(Deps{
		Store:  dataStore,
		Bus:    eventbus.New(dataStore),
		Models: scriptedRouter(provider.server.URL),
		Gate:   permissions.NewGate(permissions.Policy{Mode: permissions.ModeAll, AgentTools: true}),
		Tools:  registry,
		Router: NewRouter(nil, nil),
	})
	supervisor.InstallCrewTools(registry)

	return &crewFixture{supervisor: supervisor, store: dataStore, provider: provider, session: sessionID}
}

// motorContext falha rápido: as regressões deste arquivo TRAVAM (portão sem
// decisão, aprovação que ninguém dá) em vez de errar o resultado.
func motorContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func dispatchFence(tasks string) string {
	return toolFence + "\n{\"tool\":\"task.dispatch\",\"args\":" + tasks + "}\n```"
}

// workerDones lê os `worker.done` do log, na ordem em que foram gravados.
func workerDones(t *testing.T, fixture *crewFixture) []protocol.WorkerDone {
	t.Helper()
	out := make([]protocol.WorkerDone, 0, 4)
	for _, envelope := range envelopesByKind(t, fixture.store, fixture.session, protocol.KindWorkerDone) {
		var done protocol.WorkerDone
		if err := envelope.Decode(&done); err != nil {
			t.Fatalf("decodificar worker.done: %v", err)
		}
		out = append(out, done)
	}
	return out
}

func taskDispatches(t *testing.T, fixture *crewFixture) []protocol.TaskDispatch {
	t.Helper()
	out := make([]protocol.TaskDispatch, 0, 4)
	for _, envelope := range envelopesByKind(t, fixture.store, fixture.session, protocol.KindTaskDispatch) {
		var dispatch protocol.TaskDispatch
		if err := envelope.Decode(&dispatch); err != nil {
			t.Fatalf("decodificar task.dispatch: %v", err)
		}
		out = append(out, dispatch)
	}
	return out
}

/* ------------------------------ um bot só -------------------------------- */

// O caminho mais comum do produto: uma conversa que já tem dono, uma pergunta,
// uma resposta. Nenhum bot extra entra em cena — e é isso que se afirma aqui,
// porque um motor que monta equipe para responder "bom dia" queima dinheiro e
// enche a tela de bonecos.
func TestBotUnicoRespondeSemChamarNinguem(t *testing.T) {
	fixture := newCrewFixture(t, "chat", nil, "O prazo do contrato vence em 30 dias.")

	if err := fixture.supervisor.Prompt(motorContext(t), fixture.session,
		protocol.Prompt{Text: "qual o prazo?"}); err != nil {
		t.Fatalf("prompt: %v", err)
	}

	answers := messageTexts(t, fixture.store, fixture.session, "assistant")
	if len(answers) != 1 {
		t.Fatalf("esperava 1 resposta do assistente, obtive %d: %q", len(answers), answers)
	}
	if !strings.Contains(answers[0], "30 dias") {
		t.Errorf("a resposta não chegou ao log: %q", answers[0])
	}
	if calls := atomic.LoadInt32(&fixture.provider.calls); calls != 1 {
		t.Errorf("um bot só e sem ferramenta tem de custar UMA chamada de modelo, custou %d", calls)
	}
	if dones := envelopesByKind(t, fixture.store, fixture.session, protocol.KindDone); len(dones) != 1 {
		t.Errorf("esperava exatamente 1 `done` fechando o turno, obtive %d", len(dones))
	}
	if got := len(delegateEnvelopes(t, fixture.store, fixture.session)); got != 0 {
		t.Errorf("ninguém pediu equipe: esperava 0 delegações, obtive %d", got)
	}
	if got := len(taskDispatches(t, fixture)); got != 0 {
		t.Errorf("ninguém pediu equipe: esperava 0 despachos, obtive %d", got)
	}
}

/* ------------------------------ vários bots ------------------------------ */

// A equipe inteira, do despacho ao relatório: duas ondas, três tarefas, e — o
// que mais importa — o resultado de t1 chegando ao prompt de quem depende dele.
//
// A propagação é o coração do multi-bot. Uma tarefa que não vê a saída de quem
// ela depende refaz o trabalho ou decide diferente, e o conjunto sai coerente na
// aparência e incoerente no conteúdo.
func TestEquipeRodaOndasEPassaOResultadoAdiante(t *testing.T) {
	const esquema = "ESQUEMA: cobranca(id, valor, vencimento)"
	plano := `{"tasks":[` +
		`{"id":"t1","title":"ler o banco","specialist":"data","goal":"descrever o esquema"},` +
		`{"id":"t2","title":"gerar a API","specialist":"code","goal":"endpoints","dependsOn":["t1"]},` +
		`{"id":"t3","title":"escrever o doc","specialist":"office","goal":"manual","dependsOn":["t1"]}` +
		`],"maxConcurrency":4}`

	fixture := newCrewFixture(t, "agent", []route{
		// A ordem importa: o gatilho da tarefa vem ANTES do gatilho do
		// orquestrador, senão o briefing do trabalhador (que cita o objetivo)
		// casaria com a rota do orquestrador.
		{trigger: "Tarefa t1", answer: esquema},
		{trigger: "Tarefa t2", answer: "GET /cobrancas e POST /cobrancas"},
		{trigger: "Tarefa t3", answer: "manual escrito"},
		{trigger: "Resultado das ferramentas", answer: "Equipe concluída: banco lido, API e manual prontos."},
		{trigger: "monte a suíte", answer: "vou montar a equipe\n\n" + dispatchFence(plano)},
	}, "resposta sem rota")

	if err := fixture.supervisor.Prompt(motorContext(t), fixture.session,
		protocol.Prompt{Text: "monte a suíte de cobrança"}); err != nil {
		t.Fatalf("prompt: %v", err)
	}

	dispatches := taskDispatches(t, fixture)
	if len(dispatches) != 3 {
		t.Fatalf("esperava 3 despachos de tarefa, obtive %d", len(dispatches))
	}
	waveOf := map[string]int{}
	for _, dispatch := range dispatches {
		waveOf[dispatch.Task.ID] = dispatch.Wave
	}
	if waveOf["t1"] != 1 {
		t.Errorf("t1 não depende de ninguém e tem de sair na onda 1, saiu na %d", waveOf["t1"])
	}
	if waveOf["t2"] != 2 || waveOf["t3"] != 2 {
		t.Errorf("t2 e t3 dependem de t1 e têm de sair na onda 2, saíram em %d e %d",
			waveOf["t2"], waveOf["t3"])
	}

	dones := workerDones(t, fixture)
	if len(dones) != 3 {
		t.Fatalf("esperava 3 `worker.done`, obtive %d", len(dones))
	}
	for _, done := range dones {
		if !done.OK {
			t.Errorf("tarefa %s falhou sem motivo: %q", done.TaskID, done.Error)
		}
		if done.WorkerID == "" {
			t.Errorf("tarefa %s saiu sem id de trabalhador — a tela não consegue casar o cartão", done.TaskID)
		}
	}

	// A prova da propagação: o prompt de t2 tinha DENTRO dele a saída de t1.
	if !fixture.provider.sawRequestContaining(esquema) {
		t.Error("o resultado de t1 não chegou ao prompt de quem depende dele — " +
			"as tarefas da onda 2 trabalharam às cegas")
	}

	// E o orquestrador recebeu o relatório de volta e falou por último.
	answers := messageTexts(t, fixture.store, fixture.session, "assistant")
	if len(answers) == 0 || !strings.Contains(answers[len(answers)-1], "Equipe concluída") {
		t.Errorf("o relatório da equipe não voltou ao orquestrador: %q", answers)
	}
}

// O paralelismo pedido é o paralelismo executado. `PlanTasks` corta a onda no
// teto; este teste mede o PICO REAL de chamadas simultâneas, porque o corte no
// plano só vale se ninguém disparar as goroutines por fora dele.
func TestEquipeRespeitaOTetoDeParalelismo(t *testing.T) {
	var tasks []string
	routes := []route{}
	for index := 1; index <= 6; index++ {
		id := fmt.Sprintf("p%d", index)
		tasks = append(tasks, fmt.Sprintf(
			`{"id":%q,"title":"tarefa %d","specialist":"chat","goal":"responda ok"}`, id, index))
		routes = append(routes, route{trigger: "Tarefa " + id, answer: "ok " + id})
	}
	plano := `{"tasks":[` + strings.Join(tasks, ",") + `],"maxConcurrency":2}`

	routes = append(routes,
		route{trigger: "Resultado das ferramentas", answer: "pronto"},
		route{trigger: "toque tudo junto", answer: dispatchFence(plano)})

	fixture := newCrewFixture(t, "agent", routes, "sem rota")
	if err := fixture.supervisor.Prompt(motorContext(t), fixture.session,
		protocol.Prompt{Text: "toque tudo junto"}); err != nil {
		t.Fatalf("prompt: %v", err)
	}

	if got := len(workerDones(t, fixture)); got != 6 {
		t.Fatalf("esperava 6 tarefas concluídas, obtive %d", got)
	}
	if peak := atomic.LoadInt32(&fixture.provider.peak); peak > 2 {
		t.Errorf("o pico de trabalhadores simultâneos foi %d, e o pedido era 2 — "+
			"o teto do plano não está segurando as goroutines", peak)
	}
}

/* ------------------------- o que o motor promete ------------------------- */

// "Refazer" tem de refazer.
//
// O portão publica três decisões e a tela oferece as três. `runCrew` só trata
// `abort`; `retry` cai no mesmo caminho de `proceed` — a onda que falhou NÃO é
// reexecutada e o relatório ainda escreve "portão da onda 1: retry", que é a
// frase de algo que aconteceu. Quem clicou em refazer segue para a onda 2 com a
// dependência vazia, achando que mandou refazer.
func TestPortaoRefazerRealmenteRefazAOnda(t *testing.T) {
	plano := `{"tasks":[` +
		`{"id":"t1","title":"tarefa que falha","specialist":"chat","goal":"vai quebrar"},` +
		`{"id":"t2","title":"depende","specialist":"chat","goal":"usa t1","dependsOn":["t1"]}` +
		`],"maxConcurrency":2}`

	fixture := newCrewFixture(t, "agent", []route{
		{trigger: "Tarefa t1", answer: "@@500"},
		{trigger: "Tarefa t2", answer: "usei o que veio de t1"},
		{trigger: "Resultado das ferramentas", answer: "relatório recebido"},
		{trigger: "toque com falha", answer: dispatchFence(plano)},
	}, "sem rota")

	// Quem decide os portões: o PRIMEIRO leva "refazer", os seguintes levam
	// "seguir".
	//
	// Responder só o primeiro travaria o teste por dois minutos — e travaria
	// justamente quando o conserto funciona, porque a refação abre um segundo
	// portão que ninguém responderia. O decisor precisa acompanhar o motor
	// consertado, não o quebrado.
	parar := make(chan struct{})
	pronto := make(chan struct{})
	go func() {
		defer close(pronto)
		decididos := map[string]bool{}
		primeiro := true
		for {
			select {
			case <-parar:
				return
			default:
			}
			envelopes, err := fixture.store.Since(fixture.session, 0, 1000)
			if err == nil {
				for _, envelope := range envelopes {
					if envelope.Kind != protocol.KindGate {
						continue
					}
					var gate protocol.Gate
					if envelope.Decode(&gate) != nil || gate.GateID == "" ||
						gate.Decision != "" || decididos[gate.GateID] {
						continue
					}
					decididos[gate.GateID] = true
					decision := protocol.GateProceed
					if primeiro {
						decision = protocol.GateRetry
						primeiro = false
					}
					_ = fixture.supervisor.DecideGate(protocol.Gate{
						GateID: gate.GateID, Decision: decision,
					})
				}
			}
			time.Sleep(20 * time.Millisecond)
		}
	}()
	defer func() { close(parar); <-pronto }()

	if err := fixture.supervisor.Prompt(motorContext(t), fixture.session,
		protocol.Prompt{Text: "toque com falha"}); err != nil {
		t.Fatalf("prompt: %v", err)
	}

	gates := envelopesByKind(t, fixture.store, fixture.session, protocol.KindGate)
	if len(gates) == 0 {
		t.Fatal("a onda 1 falhou e nenhum portão abriu")
	}

	// A afirmação: refazer reexecuta a tarefa que falhou. Uma tentativa só
	// significa que a decisão foi lida, registrada e ignorada.
	if tentativas := fixture.provider.countRequestsContaining("Tarefa t1"); tentativas < 2 {
		t.Errorf("a decisão foi REFAZER e t1 rodou %d vez(es) — a onda não foi reexecutada", tentativas)
	}
}

// Equipe dentro de equipe: permitida até o teto, recusada depois dele.
//
// O especialista `agent` tem `task.dispatch` no catálogo, e um trabalhador é um
// especialista rodando com as ferramentas dele — logo um trabalhador `agent`
// pode despachar outra equipe, que pode despachar outra. Decompor em sub-equipes
// é caso de uso legítimo; o que não pode é a árvore não ter fim, porque cada
// nível multiplica por até 128 tarefas.
//
// O teto é `Policy.MaxDepth`, e o teste o aperta para 2 de propósito: com o
// padrão (3) a árvore de prova precisaria de mais um nível sem provar mais nada.
func TestEquipeDentroDeEquipeParaNoTetoDaPolitica(t *testing.T) {
	fence := func(id, kind string) string {
		return dispatchFence(fmt.Sprintf(
			`{"tasks":[{"id":%q,"title":"nivel","specialist":%q,"goal":"siga"}],"maxConcurrency":1}`,
			id, kind))
	}

	fixture := newCrewFixture(t, "agent", []route{
		// Depois de qualquer resultado de ferramenta o trabalhador encerra: sem
		// isto ele reemitiria o despacho a cada rodada até esgotar as seis.
		{trigger: "Resultado das ferramentas", answer: "nivel concluido"},
		{trigger: "Tarefa g3", answer: "folha"},
		{trigger: "Tarefa g2", answer: fence("g3", "agent")},
		{trigger: "Tarefa g1", answer: fence("g2", "agent")},
		{trigger: "monte a arvore", answer: fence("g1", "agent")},
	}, "sem rota")

	policy := permissions.Policy{Mode: permissions.ModeAll, AgentTools: true, MaxDepth: 2}
	fixture.supervisor.deps.Gate.SetPolicy(policy)

	if err := fixture.supervisor.Prompt(motorContext(t), fixture.session,
		protocol.Prompt{Text: "monte a arvore"}); err != nil {
		t.Fatalf("prompt: %v", err)
	}

	// A sub-equipe legítima roda...
	if !fixture.provider.sawRequestContaining("Tarefa g2") {
		t.Error("a sub-equipe do primeiro nível não rodou — o teto está apertado demais " +
			"e decompor em sub-equipes deixou de funcionar")
	}
	// ...e a geração seguinte é recusada pelo teto, em vez de multiplicar.
	if fixture.provider.sawRequestContaining("Tarefa g3") {
		t.Error("a árvore passou de MaxDepth=2: o terceiro nível montou equipe e o motor " +
			"executou — o teto da política não está segurando a recursão")
	}
}

// O teto de trabalhadores do turno vale para a árvore INTEIRA.
//
// Profundidade sozinha não segura largura: três níveis de 128 tarefas cabem em
// `MaxDepth`. `MaxTotal` é o orçamento compartilhado, e ele só funciona se
// descer por contexto — um orçamento novo por nível não limitaria nada.
func TestOrcamentoDeTrabalhadoresValeParaOTurnoInteiro(t *testing.T) {
	quatro := `{"tasks":[` +
		`{"id":"a1","title":"um","specialist":"chat","goal":"faca"},` +
		`{"id":"a2","title":"dois","specialist":"chat","goal":"faca"},` +
		`{"id":"a3","title":"tres","specialist":"chat","goal":"faca"},` +
		`{"id":"a4","title":"quatro","specialist":"chat","goal":"faca"}` +
		`],"maxConcurrency":4}`

	fixture := newCrewFixture(t, "agent", []route{
		{trigger: "Resultado das ferramentas", answer: "encerrado"},
		{trigger: "Tarefa a", answer: "ok"},
		{trigger: "monte demais", answer: dispatchFence(quatro)},
	}, "sem rota")

	fixture.supervisor.deps.Gate.SetPolicy(permissions.Policy{
		Mode: permissions.ModeAll, AgentTools: true, MaxTotal: 3,
	})

	if err := fixture.supervisor.Prompt(motorContext(t), fixture.session,
		protocol.Prompt{Text: "monte demais"}); err != nil {
		t.Fatalf("prompt: %v", err)
	}

	if got := len(workerDones(t, fixture)); got != 0 {
		t.Errorf("o teto era 3 trabalhadores e o plano pedia 4 — esperava a equipe recusada "+
			"inteira, mas %d trabalhador(es) rodaram", got)
	}
	answers := messageTexts(t, fixture.store, fixture.session, "assistant")
	if len(answers) == 0 || !strings.Contains(answers[len(answers)-1], "encerrado") {
		t.Errorf("a recusa do orçamento tem de voltar ao modelo como texto de ferramenta, "+
			"para ele replanejar em vez de derrubar o turno: %q", answers)
	}
}

// O bloco de delegação de um trabalhador não pode vazar como texto.
//
// `runWorker` só entende `aibot:tool`; se o trabalhador emitir `aibot:delegate`
// (e o contrato do especialista o ensina a delegar), o bloco não é executado NEM
// removido — `stripToolBlocks` tira só a cerca de ferramenta. O JSON cru vira
// "resultado" da tarefa, entra no relatório e é servido como contexto para as
// dependentes.
func TestResultadoDoTrabalhadorNaoVazaBlocoDeDelegacao(t *testing.T) {
	plano := `{"tasks":[` +
		`{"id":"t1","title":"pede ajuda","specialist":"code","goal":"faça"},` +
		`{"id":"t2","title":"depende","specialist":"chat","goal":"use","dependsOn":["t1"]}` +
		`],"maxConcurrency":1}`

	comDelegacao := "vou pedir ajuda ao banco\n\n" + delegateFence +
		"\n{\"specialist\":\"data\",\"goal\":\"descreva o esquema\"}\n```"

	fixture := newCrewFixture(t, "agent", []route{
		// A recusa precisa ser ACIONÁVEL: o trabalhador que a lê termina a tarefa
		// sozinho. Se ela chegasse muda, ele repetiria o bloco até esgotar as seis
		// rodadas e a tarefa morreria por esgotamento, com o motivo errado no log.
		{trigger: "não se delega", answer: "fiz sozinho: esquema conferido"},
		{trigger: "Tarefa t1", answer: comDelegacao},
		{trigger: "Tarefa t2", answer: "ok"},
		{trigger: "Resultado das ferramentas", answer: "pronto"},
		{trigger: "faça o serviço", answer: dispatchFence(plano)},
	}, "sem rota")

	if err := fixture.supervisor.Prompt(motorContext(t), fixture.session,
		protocol.Prompt{Text: "faça o serviço"}); err != nil {
		t.Fatalf("prompt: %v", err)
	}

	achou := false
	for _, done := range workerDones(t, fixture) {
		if done.TaskID != "t1" {
			continue
		}
		achou = true
		if strings.Contains(done.Result, "aibot:delegate") {
			t.Errorf("o resultado de t1 carrega a cerca de delegação crua: %q\n"+
				"ela não foi executada nem removida — vai para o relatório e para o "+
				"prompt das tarefas dependentes como se fosse conteúdo", done.Result)
		}
		if !done.OK {
			t.Errorf("t1 tinha como terminar depois da recusa e não terminou: %q", done.Error)
		}
		if !strings.Contains(done.Result, "fiz sozinho") {
			t.Errorf("o trabalhador não seguiu depois da recusa: %q", done.Result)
		}
	}
	if !achou {
		t.Fatal("t1 não produziu `worker.done`")
	}
}

/* --------------------- um bot chamando outro (delegação) ------------------ */

// Duas delegações no MESMO turno.
//
// O teste que existia cobria uma só. Duas exercitam o que uma não alcança: o
// orçamento compartilhado, o par abre/fecha de cada popup e — o que a tela usa
// para casar os cartões — dois destinos diferentes no mesmo turno.
func TestDuasDelegacoesNoMesmoTurnoAbremEFechamSeusPopups(t *testing.T) {
	bloco := func(id, goal string) string {
		return delegateFence + "\n{\"specialist\":\"" + id + "\",\"goal\":\"" + goal + "\"}\n```"
	}

	fixture := newCrewFixture(t, "code", []route{
		{trigger: "Resultado da delegação", answer: "juntei as duas respostas"},
		{trigger: "descreva o esquema do banco", answer: "cobranca(id, valor)"},
		{trigger: "escreva o manual do usuario", answer: "manual pronto"},
		{trigger: "peca aos dois", answer: "vou chamar os dois\n\n" +
			bloco("data", "descreva o esquema do banco") + "\n\n" +
			bloco("office", "escreva o manual do usuario")},
	}, "sem rota")

	if err := fixture.supervisor.Prompt(motorContext(t), fixture.session,
		protocol.Prompt{Text: "peca aos dois"}); err != nil {
		t.Fatalf("prompt: %v", err)
	}

	delegations := delegateEnvelopes(t, fixture.store, fixture.session)
	abertos, fechados := map[string]int{}, map[string]int{}
	for _, entry := range delegations {
		if entry.Done {
			fechados[entry.To]++
		} else {
			abertos[entry.To]++
		}
	}
	for _, destino := range []string{"data", "office"} {
		if abertos[destino] != 1 || fechados[destino] != 1 {
			t.Errorf("o popup de %s abriu %d vez(es) e fechou %d — cada delegação precisa do par, "+
				"senão o boneco fica girando na tela para sempre",
				destino, abertos[destino], fechados[destino])
		}
	}
	if !fixture.provider.sawRequestContaining("descreva o esquema do banco") ||
		!fixture.provider.sawRequestContaining("escreva o manual do usuario") {
		t.Error("um dos dois delegados não chegou a rodar")
	}

	answers := messageTexts(t, fixture.store, fixture.session, "assistant")
	if len(answers) == 0 || !strings.Contains(answers[len(answers)-1], "juntei as duas") {
		t.Errorf("as duas respostas não voltaram para quem delegou: %q", answers)
	}
}

// O teto por turno recusa a delegação EXCEDENTE sem deixar popup órfão.
//
// A recusa tem de acontecer antes de o popup abrir. Publicar o `Done:false` e só
// então descobrir que estourou o teto deixaria um boneco girando na tela sem
// nada para fechá-lo — e a pessoa esperando por um bot que nunca rodou.
func TestDelegacaoAcimaDoTetoNaoDeixaPopupOrfao(t *testing.T) {
	bloco := func(id, goal string) string {
		return delegateFence + "\n{\"specialist\":\"" + id + "\",\"goal\":\"" + goal + "\"}\n```"
	}

	fixture := newCrewFixture(t, "code", []route{
		{trigger: "Resultado da delegação", answer: "encerrando"},
		{trigger: "alvo numero", answer: "feito"},
		{trigger: "chame todos", answer: "vou chamar todo mundo\n\n" +
			bloco("data", "alvo numero um") + "\n\n" +
			bloco("office", "alvo numero dois") + "\n\n" +
			bloco("web", "alvo numero tres") + "\n\n" +
			bloco("video", "alvo numero quatro")},
	}, "sem rota")

	if err := fixture.supervisor.Prompt(motorContext(t), fixture.session,
		protocol.Prompt{Text: "chame todos"}); err != nil {
		t.Fatalf("prompt: %v", err)
	}

	abertos, fechados := 0, 0
	for _, entry := range delegateEnvelopes(t, fixture.store, fixture.session) {
		if entry.Done {
			fechados++
		} else {
			abertos++
		}
	}
	if abertos != fechados {
		t.Errorf("%d popup(s) abertos e %d fechados — sobrou boneco girando na tela", abertos, fechados)
	}
	if abertos > maxDelegationsPerTurn {
		t.Errorf("o teto por turno é %d e abriram %d delegações", maxDelegationsPerTurn, abertos)
	}
	if abertos == 0 {
		t.Error("nenhuma delegação rodou — o teto não pode recusar todas")
	}
}

// A política do administrador APERTA os tetos da delegação, e não os afrouxa.
//
// O campo existia, o administrador podia configurá-lo por JSON e nenhuma linha
// do gateway o lia. Agora ele vale — mas só para baixo: uma política que peça
// dez níveis não passa dos dois que o produto aceita, senão bastaria publicar um
// JSON permissivo para desligar o limite que impede o pingue-pongue entre dois
// especialistas.
func TestPoliticaApertaOsTetosDaDelegacaoSemAfrouxar(t *testing.T) {
	fixture := newCrewFixture(t, "code", nil, "nada")

	padrao := fixture.supervisor.effectiveDelegationLimits()
	if padrao.depth != maxDelegationDepth || padrao.perTurn != maxDelegationsPerTurn {
		t.Errorf("sem política apertada os tetos têm de ser os do produto (%d/%d), vieram %d/%d",
			maxDelegationDepth, maxDelegationsPerTurn, padrao.depth, padrao.perTurn)
	}

	fixture.supervisor.deps.Gate.SetPolicy(permissions.Policy{
		Mode: permissions.ModeAll, AgentTools: true, MaxDepth: 1, MaxTotal: 2,
	})
	apertado := fixture.supervisor.effectiveDelegationLimits()
	if apertado.depth != 1 || apertado.perTurn != 2 {
		t.Errorf("a política pediu 1/2 e os tetos efetivos ficaram %d/%d", apertado.depth, apertado.perTurn)
	}

	fixture.supervisor.deps.Gate.SetPolicy(permissions.Policy{
		Mode: permissions.ModeAll, AgentTools: true, MaxDepth: 99, MaxTotal: 999,
	})
	frouxo := fixture.supervisor.effectiveDelegationLimits()
	if frouxo.depth != maxDelegationDepth || frouxo.perTurn != maxDelegationsPerTurn {
		t.Errorf("uma política frouxa não pode afrouxar o teto do produto: %d/%d",
			frouxo.depth, frouxo.perTurn)
	}
}
