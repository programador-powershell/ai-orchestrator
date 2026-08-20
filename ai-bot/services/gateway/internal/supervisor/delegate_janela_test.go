// A JANELA DO SUB-TURNO — o contrato do item 1 de docs/execucao-na-janela.md:
// a janela que mostra o trabalho é dona do container onde o trabalho é escrito.
//
// O defeito que este arquivo guarda: o laço do sub-turno delegado emitia TUDO
// na sessão do dono — quem olhava a raiz via o trabalho cru do delegado
// (inclusive uma bolha de deltas que o replay não reconstruía) e quem clicava
// na linha da filha encontrava a janela morta: só a pergunta, nenhuma
// ferramenta, nenhum progresso. As fronteiras, cada uma com teste próprio:
//
//   - os envelopes de EXECUÇÃO (tool.call/tool.result) saem na FILHA, e o
//     replay dela reconstrói rota + ferramentas + resposta + done;
//   - a RAIZ fica com o RESUMO: o par delegate abre/fecha, nenhum tool.*;
//   - espelho que falhou NÃO cala o trabalho: fallback para a raiz;
//   - as APROVAÇÕES saem na filha E espelhadas na raiz com o MESMO callID —
//     inclusive o cartão de entrega (workspace.promote).
package supervisor

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"aibot/gateway/internal/eventbus"
	"aibot/gateway/internal/permissions"
	"aibot/gateway/internal/protocol"
	"aibot/gateway/internal/specialist"
	"aibot/gateway/internal/store"
)

/* --------------------------------- apoio ----------------------------------- */

// aprovaQuandoPedirEm espera o approval.request da ferramenta aparecer NO LOG
// INDICADO (é assim que se prova que o cartão espelhado da raiz decide o
// trabalho da filha) e entrega a decisão pelo funil normal. Mesma disciplina do
// decideQuandoPedir de jaula_test.go: nada de t.Fatal na goroutine, prazo
// esgotado fecha o canal.
func aprovaQuandoPedirEm(
	t *testing.T,
	dataStore *store.Store,
	supervisor *Supervisor,
	sessionID, tool string,
	allow bool,
) <-chan protocol.ApprovalRequest {
	t.Helper()
	seen := make(chan protocol.ApprovalRequest, 1)
	go func() {
		deadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(deadline) {
			envelopes, err := dataStore.Since(sessionID, 0, 1000)
			if err == nil {
				for _, envelope := range envelopes {
					if envelope.Kind != protocol.KindApprovalRequest {
						continue
					}
					var request protocol.ApprovalRequest
					if envelope.Decode(&request) != nil || request.Tool != tool {
						continue
					}
					_ = supervisor.Decide(protocol.ApprovalDecision{
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

// decisoesDe decodifica os approval.decision de um log, na ordem.
func decisoesDe(t *testing.T, dataStore *store.Store, sessionID string) []protocol.ApprovalDecision {
	t.Helper()
	var out []protocol.ApprovalDecision
	for _, envelope := range envelopesByKind(t, dataStore, sessionID, protocol.KindApprovalDecision) {
		var decision protocol.ApprovalDecision
		if err := envelope.Decode(&decision); err != nil {
			t.Fatalf("decodificar approval.decision: %v", err)
		}
		out = append(out, decision)
	}
	return out
}

/* -------------------- 1. o trabalho do sub-turno sai na filha --------------- */

// O caminho do master de ponta a ponta: o sub-turno grava um arquivo e o replay
// da FILHA reconstrói o turno inteiro — rota, pedido, o par tool.call/
// tool.result (é dele que a IDE deriva a superfície), a resposta na voz do bot
// e o done. A RAIZ conta a delegação como RESUMO: o par delegate abre/fecha e
// NENHUM tool.* vaza para lá.
func TestSubTurnoDoMasterEmiteAsFerramentasNaFilha(t *testing.T) {
	server := stagingProvider(t, []route{
		{trigger: "Resultado das ferramentas", answer: "site criado em index.html"},
		{trigger: pedidoDeTrabalho, answer: "criando\n\n" + fenceWrite("index.html", "<html>hello</html>")},
	}, nil)
	fixture := newStagingTurnFixture(t, server, true, "")

	if err := fixture.supervisor.Prompt(motorContext(t), fixture.session,
		protocol.Prompt{Text: pedidoDeTrabalho}); err != nil {
		t.Fatalf("prompt: %v", err)
	}

	filhoID := store.ChildSessionID(fixture.session, "code")

	// A FILHA reconstrói: rota (a superfície do editor mora lá)…
	if rotas := envelopesByKind(t, fixture.store, filhoID, protocol.KindRoute); len(rotas) != 1 {
		t.Errorf("esperava 1 rota na filha, obtive %d", len(rotas))
	}
	// …o par de ferramenta…
	chamadas := envelopesByKind(t, fixture.store, filhoID, protocol.KindToolCall)
	resultados := envelopesByKind(t, fixture.store, filhoID, protocol.KindToolResult)
	if len(chamadas) != 1 || len(resultados) != 1 {
		t.Fatalf("o par tool.call/tool.result tinha de estar na filha: %d/%d — sem ele a IDE dela não deriva nada",
			len(chamadas), len(resultados))
	}
	var resultado protocol.ToolResult
	if err := resultados[0].Decode(&resultado); err != nil {
		t.Fatalf("decodificar tool.result: %v", err)
	}
	if resultado.Tool != "fs.write" || !resultado.OK {
		t.Errorf("o resultado da ferramenta na filha veio errado: %+v", resultado)
	}
	// …a resposta na voz do bot e o done.
	falas := mensagensDe(t, fixture.store, filhoID)
	ultima := falas[len(falas)-1]
	if ultima.Role != "assistant" || !strings.Contains(ultima.Text, "site criado") {
		t.Errorf("a resposta final tinha de ser fala do bot na filha: %+v", ultima)
	}
	if dones := envelopesByKind(t, fixture.store, filhoID, protocol.KindDone); len(dones) != 1 {
		t.Errorf("esperava 1 done na filha, obtive %d", len(dones))
	}

	// A RAIZ é resumo, não transcrição: nenhum tool.* vaza para ela.
	if envs := envelopesByKind(t, fixture.store, fixture.session, protocol.KindToolCall); len(envs) != 0 {
		t.Errorf("tool.call vazou para a raiz: %d — a raiz conta a delegação como resumo", len(envs))
	}
	if envs := envelopesByKind(t, fixture.store, fixture.session, protocol.KindToolResult); len(envs) != 0 {
		t.Errorf("tool.result vazou para a raiz: %d", len(envs))
	}
	// E o resumo continua inteiro: o par delegate abre/fecha com o resultado.
	delegations := delegateEnvelopes(t, fixture.store, fixture.session)
	if len(delegations) != 2 || !delegations[1].Done ||
		!strings.Contains(delegations[1].Result, "site criado") {
		t.Fatalf("o espelho-resumo da raiz quebrou: %+v", delegations)
	}
}

/* ------------------- 2. espelho que falhou não cala o trabalho -------------- */

// Quando mirrorDelegation devolve vazio (aqui: supervisor SEM store — o espelho
// não tem onde criar a filha), o sub-turno emite na RAIZ: o fallback existe
// porque o espelho é acessório e a falha dele não pode esconder o que o
// delegado fez.
func TestSubTurnoSemEspelhoEmiteNaRaizComoFallback(t *testing.T) {
	dataStore, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("abrir o store: %v", err)
	}
	t.Cleanup(func() { dataStore.Close() })

	const sessionID = "s-sem-espelho"
	if _, err := dataStore.CreateSession(store.SessionMeta{ID: sessionID, Model: "m1"}); err != nil {
		t.Fatalf("criar sessão: %v", err)
	}

	registry := NewRegistry()
	registry.Register("fs.write", "grava um arquivo do projeto",
		func(_ context.Context, _ string, _ json.RawMessage) (string, error) {
			return "gravado: a.txt", nil
		})

	server := scriptedProvider(t, []string{
		"gravando\n\n" + fenceTool("fs.write", map[string]any{"path": "a.txt", "content": "A"}),
		"pronto, arquivo criado no projeto",
	}, nil)
	defer server.Close()

	supervisor := New(Deps{
		// Store NULO de propósito: mirrorDelegation devolve vazio e o alvo do
		// sub-turno cai na raiz. O barramento continua durável — o log da raiz
		// existe no MESMO dataStore, criado acima.
		Store:  nil,
		Bus:    eventbus.New(dataStore),
		Models: scriptedRouter(server.URL),
		Gate:   permissions.NewGate(permissions.Policy{Mode: permissions.ModeAll, AgentTools: true}),
		Tools:  registry,
	})

	back := supervisor.delegate(motorContext(t), sessionID, "t1",
		specialist.GetOrDefault("chat"),
		delegateRequest{Specialist: "code", Goal: "grave o arquivo"},
		&delegationBudget{}, firstDelegationDepth)

	if !strings.Contains(back, "RESULTADO DA DELEGAÇÃO") {
		t.Fatalf("a delegação tinha de terminar bem apesar do espelho: %q", back)
	}
	// O trabalho NÃO foi calado: o par de ferramenta está na raiz.
	if envs := envelopesByKind(t, dataStore, sessionID, protocol.KindToolCall); len(envs) != 1 {
		t.Errorf("esperava o tool.call no fallback da raiz, obtive %d", len(envs))
	}
	resultados := envelopesByKind(t, dataStore, sessionID, protocol.KindToolResult)
	if len(resultados) != 1 {
		t.Fatalf("esperava o tool.result no fallback da raiz, obtive %d", len(resultados))
	}
	var resultado protocol.ToolResult
	if err := resultados[0].Decode(&resultado); err != nil || !resultado.OK {
		t.Errorf("o trabalho do delegado sumiu no fallback: %+v (%v)", resultado, err)
	}
}

/* --------- 3. aprovação do sub-turno: filha E raiz, o MESMO callID ---------- */

// O cartão de FERRAMENTA do sub-turno abre nos dois logs com o mesmo callID, e
// a decisão dada olhando a RAIZ (onde a pessoa normalmente está) destrava o
// trabalho da filha — o Decide é por callID, não por sessão. O eco da decisão
// fecha o cartão nas duas janelas.
func TestAprovacaoDoSubTurnoSaiNaFilhaEEspelhadaNaRaizComMesmoCallID(t *testing.T) {
	dataStore, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("abrir o store: %v", err)
	}
	t.Cleanup(func() { dataStore.Close() })

	const sessionID = "s-aprovacao-espelhada"
	if _, err := dataStore.CreateSession(store.SessionMeta{
		ID: sessionID, Title: "raiz", Specialist: "chat", Model: "m1",
	}); err != nil {
		t.Fatalf("criar sessão: %v", err)
	}

	registry := NewRegistry()
	executou := false
	registry.Register("fs.write", "grava um arquivo do projeto",
		func(_ context.Context, _ string, _ json.RawMessage) (string, error) {
			executou = true
			return "gravado: index.html", nil
		})

	server := scriptedProvider(t, []string{
		"gravando\n\n" + fenceTool("fs.write", map[string]any{"path": "index.html", "content": "<html/>"}),
		"gravado com aprovação",
	}, nil)
	defer server.Close()

	supervisor := New(Deps{
		Store:  dataStore,
		Bus:    eventbus.New(dataStore),
		Models: scriptedRouter(server.URL),
		// "Edições" é onde o cartão existe: sem staging não há jaula e o
		// fs.write pede por comando.
		Gate:  permissions.NewGate(politicaEdicoes()),
		Tools: registry,
	})

	// A pessoa decide OLHANDO A RAIZ: o poller só lê o log dela.
	seen := aprovaQuandoPedirEm(t, dataStore, supervisor, sessionID, "fs.write", true)

	back := supervisor.delegate(motorContext(t), sessionID, "t1",
		specialist.GetOrDefault("chat"),
		delegateRequest{Specialist: "code", Goal: "grave o index"},
		&delegationBudget{}, firstDelegationDepth)

	if visto := <-seen; visto.CallID == "" {
		t.Fatal("o cartão espelhado nunca apareceu na raiz — a pessoa não teria como decidir")
	}
	if !executou {
		t.Fatal("a decisão dada na raiz não destravou a ferramenta da filha")
	}
	if !strings.Contains(back, "RESULTADO DA DELEGAÇÃO") {
		t.Fatalf("a delegação aprovada tinha de terminar bem: %q", back)
	}

	filhoID := store.ChildSessionID(sessionID, "code")
	pedidosNaFilha := approvalRequests(t, dataStore, filhoID)
	pedidosNaRaiz := approvalRequests(t, dataStore, sessionID)
	if len(pedidosNaFilha) != 1 || len(pedidosNaRaiz) != 1 {
		t.Fatalf("esperava o MESMO cartão nos dois logs, obtive filha=%d raiz=%d",
			len(pedidosNaFilha), len(pedidosNaRaiz))
	}
	if pedidosNaFilha[0].CallID != pedidosNaRaiz[0].CallID {
		t.Errorf("callID divergente entre filha (%q) e raiz (%q) — o cartão de uma delas fica invisível para o Decide",
			pedidosNaFilha[0].CallID, pedidosNaRaiz[0].CallID)
	}
	decisoesNaFilha := decisoesDe(t, dataStore, filhoID)
	decisoesNaRaiz := decisoesDe(t, dataStore, sessionID)
	if len(decisoesNaFilha) != 1 || len(decisoesNaRaiz) != 1 {
		t.Fatalf("o eco da decisão tinha de fechar o cartão nas duas janelas: filha=%d raiz=%d",
			len(decisoesNaFilha), len(decisoesNaRaiz))
	}
	if decisoesNaFilha[0].CallID != pedidosNaFilha[0].CallID || !decisoesNaFilha[0].Allow {
		t.Errorf("a decisão da filha não casa com o cartão: %+v", decisoesNaFilha[0])
	}
	if decisoesNaRaiz[0].CallID != pedidosNaRaiz[0].CallID {
		t.Errorf("a decisão da raiz não casa com o cartão: %+v", decisoesNaRaiz[0])
	}
	// E o efeito aconteceu na FILHA: o resultado ok mora no log dela.
	if resultados := envelopesByKind(t, dataStore, filhoID, protocol.KindToolResult); len(resultados) != 1 {
		t.Errorf("o tool.result aprovado tinha de estar na filha, obtive %d", len(resultados))
	}
}

/* ------------- 4. o cartão de ENTREGA também abre nas duas janelas ---------- */

// O workspace.promote do sub-turno do master — a aprovação única da jaula —
// segue a mesma regra: cartão na filha, espelho na raiz, MESMO callID, e a
// decisão dada na raiz entrega o arquivo ao projeto.
func TestCartaoDeEntregaDoSubTurnoEspelhadoNaRaizComMesmoCallID(t *testing.T) {
	server := stagingProvider(t, []route{
		{trigger: "Resultado das ferramentas", answer: "site criado em index.html"},
		{trigger: pedidoDeTrabalho, answer: "criando\n\n" + fenceWrite("index.html", "<html>entregue</html>")},
	}, nil)
	fixture := newStagingTurnFixtureComPolitica(t, server, true, "", politicaEdicoes())

	// A pessoa aprova a ENTREGA olhando a raiz — o cartão só existe lá por
	// causa do espelho.
	seen := decideQuandoPedir(t, fixture, entregaTool, true)

	if err := fixture.supervisor.Prompt(motorContext(t), fixture.session,
		protocol.Prompt{Text: pedidoDeTrabalho}); err != nil {
		t.Fatalf("prompt: %v", err)
	}
	if visto := <-seen; visto.CallID == "" {
		t.Fatal("o cartão de entrega nunca apareceu na raiz")
	}

	if leEm(t, fixture.projeto, "index.html") != "<html>entregue</html>" {
		t.Error("a entrega aprovada pela raiz não chegou ao projeto")
	}

	filhoID := store.ChildSessionID(fixture.session, "code")
	naFilha := approvalRequests(t, fixture.store, filhoID)
	naRaiz := approvalRequests(t, fixture.store, fixture.session)
	if len(naFilha) != 1 || naFilha[0].Tool != entregaTool {
		t.Fatalf("esperava o cartão de entrega na filha, obtive %+v", naFilha)
	}
	if len(naRaiz) != 1 || naRaiz[0].Tool != entregaTool {
		t.Fatalf("esperava o espelho do cartão na raiz, obtive %+v", naRaiz)
	}
	if naFilha[0].CallID != naRaiz[0].CallID {
		t.Errorf("callID divergente: filha %q, raiz %q", naFilha[0].CallID, naRaiz[0].CallID)
	}
	if decisoes := decisoesDe(t, fixture.store, filhoID); len(decisoes) != 1 || !decisoes[0].Allow {
		t.Errorf("o eco da decisão tinha de fechar o cartão na filha: %+v", decisoes)
	}
	if decisoes := decisoesDe(t, fixture.store, fixture.session); len(decisoes) != 1 || !decisoes[0].Allow {
		t.Errorf("o eco da decisão tinha de fechar o cartão na raiz: %+v", decisoes)
	}
}
