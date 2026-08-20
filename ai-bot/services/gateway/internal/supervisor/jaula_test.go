// A JAULA em teste — o modelo de aprovação do sandbox universal, ponta a
// ponta. O que cada teste guarda:
//
//   - gesto de arquivo na cópia (fs.write, office.edit de host com root
//     injetado) roda SEM cartão, com o chip "no sandbox", e aparece na ENTREGA;
//   - proc.run que vai para o container roda sem cartão, com o chip;
//   - a lista do que NUNCA relaxa (segredo, rede sensível, efeito fora da
//     cópia) continua perguntando mesmo jaulada — mundo fechado dos dois lados;
//   - a entrega com mudança gera UM cartão com contagens e lista; permitir
//     promove; recusar descarta com o fechamento honesto; prazo vencido recusa;
//   - o turno degradado para inplace volta ao modelo por-comando (a jaula não
//     existiu) — e o rebaixamento é avisado alto;
//   - staging sem mudança promove em silêncio, sem cartão nenhum.
package supervisor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"aibot/gateway/internal/permissions"
	"aibot/gateway/internal/protocol"
	"aibot/gateway/internal/store"
	"aibot/gateway/internal/workspace"
)

// politicaEdicoes é a política em que a jaula aparece de verdade: fora dela,
// escrita e execução pedem cartão por comando.
func politicaEdicoes() permissions.Policy {
	return permissions.Policy{Mode: permissions.ModeEdits, AgentTools: true}
}

/* --------------------------------- apoio ----------------------------------- */

// approvalRequests decodifica TODOS os approval.request do log — é por eles
// que os testes afirmam "sem cartão" e "um cartão de entrega".
func approvalRequests(t *testing.T, dataStore *store.Store, sessionID string) []protocol.ApprovalRequest {
	t.Helper()
	var out []protocol.ApprovalRequest
	for _, envelope := range envelopesByKind(t, dataStore, sessionID, protocol.KindApprovalRequest) {
		var request protocol.ApprovalRequest
		if err := envelope.Decode(&request); err != nil {
			t.Fatalf("decodificar approval.request: %v", err)
		}
		out = append(out, request)
	}
	return out
}

// decideQuandoPedir espera (em goroutine) o approval.request da ferramenta
// dada aparecer no log e entrega a decisão — é a pessoa clicando no cartão.
// Devolve um canal com o request visto, para o teste afirmar sobre o conteúdo.
// A goroutine NÃO usa t.Fatal (FailNow fora da goroutine do teste é inválido):
// erro de leitura só espera o próximo giro, e o prazo esgotado fecha o canal.
func decideQuandoPedir(t *testing.T, fixture *stagingTurnFixture, tool string, allow bool) <-chan protocol.ApprovalRequest {
	t.Helper()
	seen := make(chan protocol.ApprovalRequest, 1)
	go func() {
		deadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(deadline) {
			envelopes, err := fixture.store.Since(fixture.session, 0, 1000)
			if err == nil {
				for _, envelope := range envelopes {
					if envelope.Kind != protocol.KindApprovalRequest {
						continue
					}
					var request protocol.ApprovalRequest
					if envelope.Decode(&request) != nil || request.Tool != tool {
						continue
					}
					_ = fixture.supervisor.Decide(protocol.ApprovalDecision{
						CallID: request.CallID, Allow: allow, Scope: "once",
					})
					seen <- request
					return
				}
			}
			time.Sleep(10 * time.Millisecond)
		}
		close(seen)
	}()
	return seen
}

// fenceTool monta um bloco de ferramenta arbitrário para o roteiro do modelo.
func fenceTool(tool string, args map[string]any) string {
	raw, _ := json.Marshal(map[string]any{"tool": tool, "args": args})
	return toolFence + "\n" + string(raw) + "\n```"
}

// drenaAvisos coleta os KindNotice/KindThinking efêmeros que saíram no
// barramento durante o turno — é onde o chip "no sandbox" e o aviso alto da
// degradação vivem.
type avisosDrenados struct {
	notices  []protocol.Notice
	thinking []string
}

func drenaAvisos(t *testing.T, events <-chan protocol.Envelope) avisosDrenados {
	t.Helper()
	var out avisosDrenados
	for {
		select {
		case envelope, ok := <-events:
			if !ok {
				return out
			}
			switch envelope.Kind {
			case protocol.KindNotice:
				var notice protocol.Notice
				if json.Unmarshal(envelope.Payload, &notice) == nil {
					out.notices = append(out.notices, notice)
				}
			case protocol.KindThinking:
				var thinking protocol.Thinking
				if json.Unmarshal(envelope.Payload, &thinking) == nil && thinking.Label != "" {
					out.thinking = append(out.thinking, thinking.Label)
				}
			}
		default:
			return out
		}
	}
}

/* --------------------- o gesto na jaula não pergunta ------------------------ */

// fs.write num turno com staging e política "edições": NENHUM cartão para o
// gesto — o chip "no sandbox" sai no barramento — e a aprovação única é a da
// ENTREGA, cujo cartão lista contagens e caminhos (3 criados + 1 apagado).
// Permitir entrega; recusar está no teste seguinte.
func TestGestoNaJaulaNaoPedeECartaoDeEntregaListaAsMudancas(t *testing.T) {
	escrita := "gravando\n\n" + fenceWrite("a.txt", "A") + "\n\n" +
		fenceWrite("b.txt", "B") + "\n\n" + fenceWrite("src/c.txt", "C")

	var fixture *stagingTurnFixture
	hook := func(body string) {
		// Entre as escritas e a resposta final: apaga um arquivo pré-existente
		// DA CÓPIA — é o "1 apagado" do cartão.
		if fixture == nil || !strings.Contains(body, "Resultado das ferramentas") {
			return
		}
		entries := stagingEntries(t, fixture.store)
		if len(entries) == 1 {
			copia := filepath.Join(fixture.store.Root(), "staging", entries[0].Name())
			_ = os.Remove(filepath.Join(copia, "antigo.txt"))
		}
	}
	server := stagingProvider(t, []route{
		{trigger: "Resultado das ferramentas", answer: "três arquivos gravados."},
		{trigger: "grava os três", answer: escrita},
	}, hook)
	fixture = newStagingTurnFixtureComPolitica(t, server, true, "code", politicaEdicoes())
	escreveEm(t, fixture.projeto, "antigo.txt", "vai sumir")

	subscription := fixture.supervisor.deps.Bus.Subscribe(fixture.session)
	defer subscription.Close()

	entregue := decideQuandoPedir(t, fixture, entregaTool, true)
	if err := fixture.supervisor.Prompt(motorContext(t), fixture.session,
		protocol.Prompt{Text: "grava os três arquivos"}); err != nil {
		t.Fatalf("prompt: %v", err)
	}

	// UM cartão só — o de entrega. Os gestos de fs.write não pediram.
	requests := approvalRequests(t, fixture.store, fixture.session)
	if len(requests) != 1 || requests[0].Tool != entregaTool {
		t.Fatalf("esperava exatamente o cartão de entrega, obtive %+v", requests)
	}
	request, ok := <-entregue
	if !ok {
		t.Fatal("o cartão de entrega nunca apareceu")
	}
	if !strings.Contains(request.Summary, "3 criado(s)") || !strings.Contains(request.Summary, "1 apagado(s)") {
		t.Errorf("o resumo tinha de contar 3 criados e 1 apagado: %q", request.Summary)
	}
	if !strings.Contains(request.Summary, "Código") {
		t.Errorf("o cartão tinha de dizer QUEM quer entregar: %q", request.Summary)
	}
	for _, path := range []string{"+ a.txt", "+ b.txt", "+ src/c.txt", "- antigo.txt"} {
		if !strings.Contains(request.Detail, path) {
			t.Errorf("a lista do cartão tinha de conter %q:\n%s", path, request.Detail)
		}
	}
	if request.Digest == "" {
		t.Error("o cartão de entrega tinha de sair com digest — é o mesmo mecanismo durável de sempre")
	}

	// O chip do gesto saiu — "no sandbox" — e a decisão da entrega ficou durável.
	avisos := drenaAvisos(t, subscription.Events)
	chip := false
	for _, notice := range avisos.notices {
		if strings.HasPrefix(notice.Title, "no sandbox:") {
			chip = true
		}
	}
	if !chip {
		t.Error("o gesto jaulado tinha de sair com o chip \"no sandbox\" no barramento")
	}
	if got := len(envelopesByKind(t, fixture.store, fixture.session, protocol.KindApprovalDecision)); got != 1 {
		t.Errorf("a decisão da entrega tinha de ficar durável (1), obtive %d", got)
	}

	// Permitida, a entrega aconteceu: criados no projeto, apagado removido.
	if leEm(t, fixture.projeto, "a.txt") != "A" || leEm(t, fixture.projeto, "src/c.txt") != "C" {
		t.Error("a entrega aprovada não chegou ao projeto")
	}
	if existeEm(fixture.projeto, "antigo.txt") {
		t.Error("o apagado da cópia tinha de sumir do projeto na entrega")
	}
	if got := len(envelopesByKind(t, fixture.store, fixture.session, protocol.KindDone)); got != 1 {
		t.Errorf("esperava 1 done, obtive %d", got)
	}
}

// RECUSAR a entrega descarta a cópia e fecha o turno HONESTO: o projeto fica
// intocado e o erro diz exatamente isso.
func TestEntregaRecusadaDescartaEFechaHonesto(t *testing.T) {
	server := stagingProvider(t, []route{
		{trigger: "Resultado das ferramentas", answer: "gravado."},
		{trigger: "grava um arquivo", answer: "gravando\n\n" + fenceWrite("nao-vai.txt", "recusado")},
	}, nil)
	fixture := newStagingTurnFixtureComPolitica(t, server, true, "code", politicaEdicoes())

	recusa := decideQuandoPedir(t, fixture, entregaTool, false)
	if err := fixture.supervisor.Prompt(motorContext(t), fixture.session,
		protocol.Prompt{Text: "grava um arquivo"}); err != nil {
		t.Fatalf("prompt: %v", err)
	}
	if _, ok := <-recusa; !ok {
		t.Fatal("o cartão de entrega nunca apareceu")
	}

	if existeEm(fixture.projeto, "nao-vai.txt") {
		t.Error("a recusa não podia deixar NADA chegar ao projeto")
	}
	if entries := stagingEntries(t, fixture.store); len(entries) != 0 {
		t.Errorf("a recusa tinha de descartar o staging, sobraram %d entrada(s)", len(entries))
	}
	failures := envelopesByKind(t, fixture.store, fixture.session, protocol.KindError)
	if len(failures) != 1 {
		t.Fatalf("esperava a falha honesta no log, obtive %d erro(s)", len(failures))
	}
	var failure protocol.Error
	if err := failures[0].Decode(&failure); err != nil {
		t.Fatalf("decodificar o erro: %v", err)
	}
	if failure.Code != "entrega_recusada" ||
		!strings.Contains(failure.Message, "a entrega foi recusada — nada foi alterado no projeto") {
		t.Errorf("o fechamento tinha de ser honesto e literal, veio %q / %q", failure.Code, failure.Message)
	}
	if got := len(envelopesByKind(t, fixture.store, fixture.session, protocol.KindDone)); got != 0 {
		t.Errorf("entrega recusada não pode fechar com done, obtive %d", got)
	}
}

// PRAZO VENCIDO recusa — silêncio não é consentimento nem para entregar.
func TestEntregaSemDecisaoNoPrazoRecusa(t *testing.T) {
	server := stagingProvider(t, []route{
		{trigger: "Resultado das ferramentas", answer: "gravado."},
		{trigger: "grava um arquivo", answer: "gravando\n\n" + fenceWrite("nunca.txt", "x")},
	}, nil)
	fixture := newStagingTurnFixtureComPolitica(t, server, true, "code", politicaEdicoes())
	// O prazo real é o approvalTimeout (10 min); o teste o encurta para provar
	// o DESFECHO, não a espera.
	fixture.supervisor.prazoDeEntrega = 100 * time.Millisecond

	if err := fixture.supervisor.Prompt(motorContext(t), fixture.session,
		protocol.Prompt{Text: "grava um arquivo"}); err != nil {
		t.Fatalf("prompt: %v", err)
	}

	if existeEm(fixture.projeto, "nunca.txt") {
		t.Error("sem decisão dentro do prazo, nada podia chegar ao projeto")
	}
	if entries := stagingEntries(t, fixture.store); len(entries) != 0 {
		t.Errorf("o prazo vencido tinha de descartar o staging, sobraram %d entrada(s)", len(entries))
	}
	failures := envelopesByKind(t, fixture.store, fixture.session, protocol.KindError)
	if len(failures) != 1 {
		t.Fatalf("esperava a falha honesta, obtive %d erro(s)", len(failures))
	}
	var failure protocol.Error
	_ = failures[0].Decode(&failure)
	if failure.Code != "entrega_recusada" || !strings.Contains(failure.Message, "prazo") {
		t.Errorf("o prazo vencido tinha de recusar citando o prazo, veio %q / %q", failure.Code, failure.Message)
	}
}

// Staging SEM mudança promove em silêncio: nenhum cartão, nenhum erro — a
// promoção é constatação.
func TestStagingSemMudancaNaoGeraCartao(t *testing.T) {
	server := stagingProvider(t, []route{
		{trigger: "Resultado das ferramentas", answer: "conferido, nada a mudar."},
		{trigger: "regrava igual", answer: "regravando\n\n" + fenceWrite("igual.txt", "mesmo conteúdo")},
	}, nil)
	fixture := newStagingTurnFixtureComPolitica(t, server, true, "code", politicaEdicoes())
	escreveEm(t, fixture.projeto, "igual.txt", "mesmo conteúdo")

	if err := fixture.supervisor.Prompt(motorContext(t), fixture.session,
		protocol.Prompt{Text: "regrava igual o arquivo"}); err != nil {
		t.Fatalf("prompt: %v", err)
	}

	if requests := approvalRequests(t, fixture.store, fixture.session); len(requests) != 0 {
		t.Fatalf("sem mudança não pode haver cartão nenhum, obtive %+v", requests)
	}
	if got := len(envelopesByKind(t, fixture.store, fixture.session, protocol.KindDone)); got != 1 {
		t.Errorf("esperava 1 done, obtive %d", got)
	}
	if entries := stagingEntries(t, fixture.store); len(entries) != 0 {
		t.Errorf("a promoção silenciosa tinha de limpar o staging, sobraram %d entrada(s)", len(entries))
	}
}

/* ---------------------- host com root e proc.run no container --------------- */

// hostJaulaBridge é o aplicativo nativo de mentira: honra o contrato novo —
// executa o efeito de arquivo DENTRO do root injetado — e guarda os roots
// recebidos para o teste afirmar que era a CÓPIA.
type hostJaulaBridge struct {
	mu    sync.Mutex
	roots []string
}

func (b *hostJaulaBridge) Call(_ context.Context, _, tool string, raw json.RawMessage) (string, error) {
	var args struct {
		Root    string `json:"root"`
		Path    string `json:"path"`
		Replace string `json:"replace"`
	}
	if err := json.Unmarshal(raw, &args); err != nil {
		return "", err
	}
	if args.Root == "" {
		return "", errors.New("o despacho chegou sem o root da execução")
	}
	b.mu.Lock()
	b.roots = append(b.roots, args.Root)
	b.mu.Unlock()
	if err := os.WriteFile(filepath.Join(args.Root, args.Path), []byte(args.Replace), 0o644); err != nil {
		return "", err
	}
	return fmt.Sprintf("%s aplicado em %s", tool, args.Path), nil
}

// office.edit — ferramenta de HOST com efeito de arquivo — roda na CÓPIA (o
// root da execução congelada viaja no despacho), SEM cartão de gesto, e o que
// ela mudou aparece no cartão de ENTREGA. É o conserto da varredura: antes o
// efeito escapava para a pasta da janela.
func TestOfficeEditRodaNaCopiaSemCartaoEApareceNaEntrega(t *testing.T) {
	edicao := "editando\n\n" + fenceTool("office.edit", map[string]any{
		"path": "relatorio.txt", "find": "original", "replace": "conteúdo editado",
	})
	server := stagingProvider(t, []route{
		{trigger: "Resultado das ferramentas", answer: "documento editado."},
		{trigger: "edita o documento", answer: edicao},
	}, nil)
	fixture := newStagingTurnFixtureComPolitica(t, server, true, "office", politicaEdicoes())
	// O host de mentira abaixo HONRA o root injetado — e é isso que a
	// instalação declara aqui: sem a declaração, o gesto de host não relaxa
	// (ver o teste seguinte).
	fixture.supervisor.deps.HostHonraRoot = true
	bridge := &hostJaulaBridge{}
	fixture.registry.SetBridge(bridge)
	escreveEm(t, fixture.projeto, "relatorio.txt", "original")

	entregue := decideQuandoPedir(t, fixture, entregaTool, true)
	if err := fixture.supervisor.Prompt(motorContext(t), fixture.session,
		protocol.Prompt{Text: "edita o documento do projeto"}); err != nil {
		t.Fatalf("prompt: %v", err)
	}

	// O host recebeu o root DA CÓPIA, nunca o projeto real.
	bridge.mu.Lock()
	roots := append([]string(nil), bridge.roots...)
	bridge.mu.Unlock()
	if len(roots) != 1 {
		t.Fatalf("esperava 1 despacho ao host, obtive %d", len(roots))
	}
	stagingBase := filepath.Join(fixture.store.Root(), "staging")
	if !strings.HasPrefix(roots[0], stagingBase+string(filepath.Separator)) {
		t.Errorf("o root injetado tinha de ser a cópia (%s…), veio %q", stagingBase, roots[0])
	}

	// Sem cartão para o gesto; UM cartão de entrega com a alteração.
	requests := approvalRequests(t, fixture.store, fixture.session)
	if len(requests) != 1 || requests[0].Tool != entregaTool {
		t.Fatalf("esperava só o cartão de entrega, obtive %+v", requests)
	}
	request, ok := <-entregue
	if !ok {
		t.Fatal("o cartão de entrega nunca apareceu")
	}
	if !strings.Contains(request.Summary, "Documentos") || !strings.Contains(request.Detail, "~ relatorio.txt") {
		t.Errorf("o cartão tinha de citar o dono e a alteração: %q / %q", request.Summary, request.Detail)
	}
	if leEm(t, fixture.projeto, "relatorio.txt") != "conteúdo editado" {
		t.Error("a edição aprovada não chegou ao projeto")
	}
}

// proc.run que VAI para o container não pede cartão — sai o chip — e o turno
// fecha em silêncio quando nada mudou na cópia. A previsão é a mesma decisão
// do despacho (Deps.ProcSandboxed); aqui ela responde "container" fixo porque
// esta bancada não tem Docker de verdade.
func TestProcRunNoContainerNaoPedeCartaoESaiOChip(t *testing.T) {
	execucao := "rodando\n\n" + fenceTool("proc.run", map[string]any{"command": "pnpm build"})
	server := stagingProvider(t, []route{
		{trigger: "Resultado das ferramentas", answer: "build ok."},
		{trigger: "roda o build", answer: execucao},
	}, nil)
	fixture := newStagingTurnFixtureComPolitica(t, server, true, "code", politicaEdicoes())
	fixture.supervisor.deps.ProcSandboxed = func(context.Context, string, json.RawMessage) bool { return true }
	// O proc.run de verdade despacharia ao host/ambiente; o executor de mentira
	// prova só o PORTÃO — que a chamada rodou sem cartão.
	fixture.registry.Register("proc.run", "executor de mentira do teste",
		func(context.Context, string, json.RawMessage) (string, error) {
			return "[ambiente: docker] código de saída 0", nil
		})

	subscription := fixture.supervisor.deps.Bus.Subscribe(fixture.session)
	defer subscription.Close()

	if err := fixture.supervisor.Prompt(motorContext(t), fixture.session,
		protocol.Prompt{Text: "roda o build do projeto"}); err != nil {
		t.Fatalf("prompt: %v", err)
	}

	if requests := approvalRequests(t, fixture.store, fixture.session); len(requests) != 0 {
		t.Fatalf("o proc.run no container não podia pedir cartão, obtive %+v", requests)
	}
	avisos := drenaAvisos(t, subscription.Events)
	chip := false
	for _, notice := range avisos.notices {
		if strings.HasPrefix(notice.Title, "no sandbox:") && strings.Contains(notice.Title, "pnpm build") {
			chip = true
		}
	}
	if !chip {
		t.Error("o proc.run jaulado tinha de sair com o chip \"no sandbox: … pnpm build\"")
	}
	if got := len(envelopesByKind(t, fixture.store, fixture.session, protocol.KindDone)); got != 1 {
		t.Errorf("esperava 1 done, obtive %d", got)
	}
}

/* ------------------- a equipe cai no cartão do turno ------------------------ */

// Os TRABALHADORES de um turno com staging trabalham na cópia do turno e a
// entrega da equipe cai no MESMO cartão — UMA entrega por turno, não por
// worker: o gesto do trabalhador não pede (jaulado), a promoção por-tarefa é
// constatação (inplace), e o único approval.request do log é o da entrega.
func TestEquipeEntregaNoMesmoCartaoDoTurno(t *testing.T) {
	plano := `{"tasks":[{"id":"t1","title":"gravar arquivo","specialist":"code",` +
		`"goal":"grave o arquivo pedido"}]}`
	server := stagingProvider(t, []route{
		{trigger: "gravado: equipe.txt", answer: "tarefa concluída"},
		{trigger: "Tarefa t1", answer: "gravando\n\n" + fenceWrite("equipe.txt", "da equipe")},
		{trigger: "plano: 1 tarefas", answer: "equipe terminou e o arquivo foi produzido"},
		{trigger: "monta a equipe", answer: "vou montar\n\n" + dispatchFence(plano)},
	}, nil)
	fixture := newStagingTurnFixtureComPolitica(t, server, true, "agent", politicaEdicoes())

	// MONTAR a equipe continua pedindo por comando (risco execute, e não é
	// efeito de arquivo na cópia — a jaula não o cobre); quem não pergunta é o
	// GESTO do trabalhador, e a entrega vira o cartão único do fim.
	despacho := decideQuandoPedir(t, fixture, "task.dispatch", true)
	entregue := decideQuandoPedir(t, fixture, entregaTool, true)
	if err := fixture.supervisor.Prompt(motorContext(t), fixture.session,
		protocol.Prompt{Text: "monta a equipe para gravar o arquivo"}); err != nil {
		t.Fatalf("prompt: %v", err)
	}
	if _, ok := <-despacho; !ok {
		t.Fatal("o task.dispatch tinha de pedir o cartão por comando")
	}

	// DOIS cartões no log — o despacho da equipe e a entrega do TURNO. Nem o
	// fs.write do trabalhador nem a promoção por-tarefa pediram nada.
	requests := approvalRequests(t, fixture.store, fixture.session)
	if len(requests) != 2 || requests[0].Tool != "task.dispatch" || requests[1].Tool != entregaTool {
		t.Fatalf("esperava task.dispatch + o cartão de entrega, obtive %+v", requests)
	}
	request, ok := <-entregue
	if !ok {
		t.Fatal("o cartão de entrega do turno nunca apareceu")
	}
	if !strings.Contains(request.Detail, "+ equipe.txt") {
		t.Errorf("o trabalho da equipe tinha de estar no cartão do turno: %q", request.Detail)
	}
	if leEm(t, fixture.projeto, "equipe.txt") != "da equipe" {
		t.Error("a entrega aprovada não levou o trabalho da equipe ao projeto")
	}
	if got := len(envelopesByKind(t, fixture.store, fixture.session, protocol.KindError)); got != 0 {
		t.Errorf("turno de equipe feliz não pode deixar KindError, obtive %d", got)
	}
}

/* -------------------------- o que nunca relaxa ------------------------------ */

// A lista fechada: segredo, rede sensível e efeito fora da cópia continuam
// perguntando MESMO jaulados — e ferramenta desconhecida idem, porque o mundo
// é fechado dos dois lados. O proc.run sem previsor também não relaxa.
func TestJaulaNuncaRelaxaSegredoRedeSensivelNemEfeitoForaDaCopia(t *testing.T) {
	sup := New(Deps{
		ProcSandboxed: func(context.Context, string, json.RawMessage) bool { return true },
		HostHonraRoot: true,
	})
	jailed := workspace.WithExecution(context.Background(),
		&workspace.Execution{LocalRoot: "c:/copia", LocalStaging: "c:/copia"})

	for _, tool := range nuncaRelaxamNaJaula {
		if _, relaxed := sup.gestoNaJaula(jailed, "s1", toolInvocation{Tool: tool}); relaxed {
			t.Errorf("%s NUNCA pode relaxar na jaula — cofre e rede sensível não são sandboxáveis", tool)
		}
	}
	// Desconhecida não relaxa: nasce perguntando.
	if _, relaxed := sup.gestoNaJaula(jailed, "s1", toolInvocation{Tool: "plugin.novo"}); relaxed {
		t.Error("ferramenta fora do allowlist não pode relaxar")
	}
	// Os gestos confinados relaxam jaulados — os locais sempre, os de host
	// porque ESTA instalação declarou que o host honra o root injetado.
	for tool := range gestosConfinadosAJaula {
		if _, relaxed := sup.gestoNaJaula(jailed, "s1", toolInvocation{Tool: tool}); !relaxed {
			t.Errorf("%s é efeito de arquivo confinado ao root e tinha de relaxar na jaula", tool)
		}
	}
	for tool := range gestosDeHostConfinaveis {
		if _, relaxed := sup.gestoNaJaula(jailed, "s1", toolInvocation{Tool: tool}); !relaxed {
			t.Errorf("%s com host que honra o root tinha de relaxar na jaula", tool)
		}
	}
	// SEM a declaração (o padrão de produção enquanto o apps/desktop não lê o
	// campo `root`), o gesto de host NÃO relaxa: o efeito dele cairia na pasta
	// da janela — o projeto real — sem cartão e fora do cartão de entrega.
	hostSurdo := New(Deps{ProcSandboxed: func(context.Context, string, json.RawMessage) bool { return true }})
	for tool := range gestosDeHostConfinaveis {
		if _, relaxed := hostSurdo.gestoNaJaula(jailed, "s1", toolInvocation{Tool: tool}); relaxed {
			t.Errorf("%s sem host que honre o root NÃO pode relaxar — seria a porta lateral", tool)
		}
	}
	// E os locais continuam relaxando: o confinamento deles é deste processo.
	if _, relaxed := hostSurdo.gestoNaJaula(jailed, "s1", toolInvocation{Tool: "fs.write"}); !relaxed {
		t.Error("fs.write é confinado pelo próprio gateway e relaxa mesmo sem a declaração do host")
	}
	// proc.run relaxa SÓ com a previsão dizendo container.
	if _, relaxed := sup.gestoNaJaula(jailed, "s1", toolInvocation{Tool: "proc.run"}); !relaxed {
		t.Error("proc.run previsto no container tinha de relaxar")
	}
	semPrevisor := New(Deps{})
	if _, relaxed := semPrevisor.gestoNaJaula(jailed, "s1", toolInvocation{Tool: "proc.run"}); relaxed {
		t.Error("sem previsor o proc.run tem de continuar perguntando — fechado na dúvida")
	}

	// FORA da jaula (inplace) nada relaxa — é o modelo de hoje.
	inplace := workspace.WithExecution(context.Background(), &workspace.Execution{LocalRoot: "c:/projeto"})
	if _, relaxed := sup.gestoNaJaula(inplace, "s1", toolInvocation{Tool: "fs.write"}); relaxed {
		t.Error("sem staging não há jaula — fs.write tem de perguntar como sempre")
	}
	if _, relaxed := sup.gestoNaJaula(context.Background(), "s1", toolInvocation{Tool: "fs.write"}); relaxed {
		t.Error("sem execução nenhuma não há jaula")
	}
}

/* ----------------------- degradado volta ao por-comando --------------------- */

// O turno DEGRADADO para inplace (teto estourado) mantém a aprovação POR
// COMANDO — a jaula não existiu — e o rebaixamento sai como aviso ALTO
// (KindNotice), não só rodapé. Não há cartão de entrega: não há staging.
func TestTurnoDegradadoMantemAprovacaoPorComandoEAvisaAlto(t *testing.T) {
	server := stagingProvider(t, []route{
		{trigger: "Resultado das ferramentas", answer: "x.txt gravado."},
		{trigger: "grava mais um", answer: "gravando\n\n" + fenceWrite("x.txt", "X")},
	}, nil)
	fixture := newStagingTurnFixtureComPolitica(t, server, true, "code", politicaEdicoes())
	// Dois arquivos e teto de UM: a materialização degrada para inplace.
	escreveEm(t, fixture.projeto, "um.txt", "1")
	escreveEm(t, fixture.projeto, "dois.txt", "2")
	fixture.manager.EnableStagingWithLimits(fixture.store.Root(), 128<<20, 1)

	subscription := fixture.supervisor.deps.Bus.Subscribe(fixture.session)
	defer subscription.Close()

	aprovado := decideQuandoPedir(t, fixture, "fs.write", true)
	if err := fixture.supervisor.Prompt(motorContext(t), fixture.session,
		protocol.Prompt{Text: "grava mais um arquivo"}); err != nil {
		t.Fatalf("prompt: %v", err)
	}
	if _, ok := <-aprovado; !ok {
		t.Fatal("degradado, o fs.write tinha de pedir o cartão por comando")
	}

	// SÓ o cartão por comando — nenhum cartão de entrega (não houve jaula).
	requests := approvalRequests(t, fixture.store, fixture.session)
	if len(requests) != 1 || requests[0].Tool != "fs.write" {
		t.Fatalf("esperava só o cartão do fs.write, obtive %+v", requests)
	}
	if leEm(t, fixture.projeto, "x.txt") != "X" {
		t.Error("aprovado por comando, o arquivo tinha de ir direto ao projeto")
	}

	// O rebaixamento saiu ALTO: um KindNotice contando que o turno trabalha
	// direto no projeto e que a aprovação voltou ao por-comando.
	avisos := drenaAvisos(t, subscription.Events)
	alto := false
	for _, notice := range avisos.notices {
		if strings.Contains(notice.Title, "sem sandbox") &&
			strings.Contains(notice.Detail, "aprovação individual") {
			alto = true
		}
	}
	if !alto {
		t.Error("a degradação tinha de sair como AVISO ALTO (KindNotice) — rebaixar aprovação em silêncio é defeito")
	}
}
