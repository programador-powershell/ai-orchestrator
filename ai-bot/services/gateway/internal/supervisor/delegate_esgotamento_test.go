// O ESGOTAMENTO DO SUB-TURNO — o contrato do item 2 de docs/execucao-na-janela.md:
// estágio contado, trabalho preservado, progresso nomeado.
//
// O defeito que este arquivo guarda: "não concluiu em 4 rodadas" queimava
// dezesseis gestos bons — o teto de 4 foi calibrado para o bot-a-bot ("uma
// coisa pontual") e o caminho do master reusava o MESMO laço para o pedido
// INTEIRO da pessoa; ao estourar, o desfecho genérico descartava o staging e o
// motivo verdadeiro. As fronteiras, cada uma com teste próprio:
//
//   - teto POR PAPEL: 8 no sub-turno do master, 4 no bot-a-bot;
//   - esgotar dispara a chamada final de RELATO (sem executar mais nada);
//   - com efeito consumado o resultado é PARCIAL e promove pelo caminho normal;
//   - sem efeito a falha continua falha — com o motivo VERDADEIRO;
//   - o portão de narração vale no relato: cena narrada não vira texto;
//   - o rótulo do orbe CONTA as rodadas nos dois laços.
package supervisor

import (
	"context"
	"encoding/json"
	"strings"
	"sync/atomic"
	"testing"

	"aibot/gateway/internal/eventbus"
	"aibot/gateway/internal/permissions"
	"aibot/gateway/internal/protocol"
	"aibot/gateway/internal/specialist"
	"aibot/gateway/internal/store"
)

/* --------------------------------- apoio ----------------------------------- */

// esgotamentoFixture monta o supervisor mínimo para chamar delegateWithRoute
// direto: sessão raiz real (o espelho da filha precisa dela), ferramenta
// fs.read de mentira (executa sem efeito — leitura) e política aprova-tudo,
// porque o que está sob teste é o TETO, não a aprovação.
type esgotamentoFixture struct {
	supervisor *Supervisor
	store      *store.Store
	session    string
	calls      *int32
}

func newEsgotamentoFixture(t *testing.T, answers []string) *esgotamentoFixture {
	t.Helper()
	dataStore, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("abrir o store: %v", err)
	}
	t.Cleanup(func() { dataStore.Close() })

	const sessionID = "s-esgotamento"
	if _, err := dataStore.CreateSession(store.SessionMeta{ID: sessionID, Title: "raiz", Model: "m1"}); err != nil {
		t.Fatalf("criar sessão: %v", err)
	}

	registry := NewRegistry()
	registry.Register("fs.read", "lê um arquivo do projeto",
		func(_ context.Context, _ string, _ json.RawMessage) (string, error) {
			return "conteúdo do arquivo", nil
		})

	calls := new(int32)
	server := scriptedProvider(t, answers, func() { atomic.AddInt32(calls, 1) })
	t.Cleanup(server.Close)

	supervisor := New(Deps{
		Store:  dataStore,
		Bus:    eventbus.New(dataStore),
		Models: scriptedRouter(server.URL),
		Gate:   permissions.NewGate(permissions.Policy{Mode: permissions.ModeAll, AgentTools: true}),
		Tools:  registry,
	})
	return &esgotamentoFixture{supervisor: supervisor, store: dataStore, session: sessionID, calls: calls}
}

// rodadasDeLeitura monta N respostas que só chamam fs.read — o delegado
// "teimoso" que nunca fecha sozinho.
func rodadasDeLeitura(n int) []string {
	out := make([]string, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, "lendo\n\n"+fenceTool("fs.read", map[string]any{"path": "schema.sql"}))
	}
	return out
}

/* ------------------------- 1. o teto é por papel ---------------------------- */

// O sub-turno do MASTER usa o teto do turno principal (8): ele É o turno da
// pessoa, apenas emitido na filha. Cinco rodadas de ferramenta e a resposta na
// sexta — com o teto antigo de 4 isto morria queimado; agora termina bem.
func TestSubTurnoDoMasterUsaOTetoDeOitoRodadas(t *testing.T) {
	answers := append(rodadasDeLeitura(5), "análise concluída: o schema tem 3 tabelas")
	fixture := newEsgotamentoFixture(t, answers)

	texto, ok := fixture.supervisor.delegateWithRoute(motorContext(t), fixture.session, "t1",
		specialist.Master,
		delegateRequest{Specialist: "data", Goal: "analise o schema do projeto"},
		&delegationBudget{}, firstDelegationDepth, nil)

	if !ok || !strings.Contains(texto, "análise concluída") {
		t.Fatalf("o sub-turno do master tinha de sobreviver a 5 rodadas: ok=%v %q", ok, texto)
	}
	if got := atomic.LoadInt32(fixture.calls); got != 6 {
		t.Errorf("esperava 6 chamadas de modelo (5 rodadas + resposta), obtive %d", got)
	}
}

// O bot-a-bot MANTÉM o teto de 4 — o argumento original continua certo: um
// delegado que precisa de oito rodadas está resolvendo o problema de quem
// delegou. Esgotado, sai a chamada de RELATO (a 5ª) e a falha carrega o motivo
// VERDADEIRO — rodadas usadas e última ferramenta executada — mais o relato,
// nunca o genérico de antes.
func TestBotABotEsgotaEmQuatroComRelatoEMotivoVerdadeiro(t *testing.T) {
	answers := append(rodadasDeLeitura(maxDelegationRounds),
		"consegui ler a estrutura; faltou gerar o sql final")
	fixture := newEsgotamentoFixture(t, answers)

	texto, ok := fixture.supervisor.delegateWithRoute(motorContext(t), fixture.session, "t1",
		specialist.GetOrDefault("chat"),
		delegateRequest{Specialist: "data", Goal: "modele as tabelas de cobrança"},
		&delegationBudget{}, firstDelegationDepth, nil)

	if ok || !strings.Contains(texto, "NÃO DEU CERTO") {
		t.Fatalf("sem nenhum efeito, o esgotamento tinha de continuar falha: ok=%v %q", ok, texto)
	}
	if got := atomic.LoadInt32(fixture.calls); got != int32(maxDelegationRounds+1) {
		t.Errorf("esperava %d chamadas (4 rodadas + relato), obtive %d", maxDelegationRounds+1, got)
	}
	// O motivo verdadeiro no lugar do genérico.
	if strings.Contains(texto, "não concluiu em") {
		t.Errorf("a frase genérica voltou: %q", texto)
	}
	for _, want := range []string{"4 rodadas", "fs.read", "faltou gerar o sql final"} {
		if !strings.Contains(texto, want) {
			t.Errorf("o desfecho não carrega %q — motivo verdadeiro e relato são o contrato: %q", want, texto)
		}
	}
	// E a filha registra o desfecho como aviso do sistema, como toda falha.
	filhoID := store.ChildSessionID(fixture.session, "data")
	avisos := messageTexts(t, fixture.store, filhoID, "system")
	if len(avisos) != 1 || !strings.Contains(avisos[0], "A tarefa não terminou") {
		t.Errorf("a filha tinha de registrar a falha honesta: %v", avisos)
	}
}

/* -------------------- 2. com efeito, o parcial promove ---------------------- */

// O caminho do master de ponta a ponta: o sub-turno grava em TODAS as rodadas e
// nunca fecha — esgota as 8. Com efeito consumado, o desfecho é PARCIAL: a
// chamada de relato roda (9ª), o staging é promovido pelo MESMO caminho do
// sucesso e o texto diz o motivo verdadeiro — nada de fogueira nem de aviso
// vermelho.
func TestEsgotamentoComEfeitoPromoveOParcial(t *testing.T) {
	var chamadas atomic.Int32
	server := stagingProvider(t, []route{
		// A chamada de relato é a única que carrega a instrução de encerramento.
		{trigger: "AS RODADAS DESTE TURNO ACABARAM",
			answer: "gravei o index.html; ficou faltando a folha de estilos"},
		// Gatilho vazio casa com TUDO: é o delegado teimoso, que grava e nunca
		// fecha — precisa vir por último na lista.
		{trigger: "", answer: "gravando\n\n" + fenceWrite("index.html", "<html>parcial</html>")},
	}, func(string) { chamadas.Add(1) })
	fixture := newStagingTurnFixture(t, server, true, "")

	if err := fixture.supervisor.Prompt(motorContext(t), fixture.session,
		protocol.Prompt{Text: pedidoDeTrabalho}); err != nil {
		t.Fatalf("prompt: %v", err)
	}

	// O trabalho legítimo foi ENTREGUE — cada fs.write passou pela jaula e a
	// promoção é a mesma do sucesso; o staging não sobra.
	if leEm(t, fixture.projeto, "index.html") != "<html>parcial</html>" {
		t.Error("o parcial não promoveu o staging — o esgotamento voltou a queimar trabalho")
	}
	if entries := stagingEntries(t, fixture.store); len(entries) != 0 {
		t.Errorf("o staging tinha de sumir na promoção do parcial, sobraram %d entrada(s)", len(entries))
	}
	if got := chamadas.Load(); got != int32(maxToolRounds+1) {
		t.Errorf("esperava %d chamadas (8 rodadas + relato), obtive %d", maxToolRounds+1, got)
	}

	// O espelho da raiz fecha como PARCIAL com o motivo verdadeiro e o relato.
	delegations := delegateEnvelopes(t, fixture.store, fixture.session)
	if len(delegations) != 2 || !delegations[1].Done {
		t.Fatalf("esperava o par abre/fecha na raiz, obtive %+v", delegations)
	}
	for _, want := range []string{"RESULTADO PARCIAL", "8 rodadas", "fs.write", "faltando a folha"} {
		if !strings.Contains(delegations[1].Result, want) {
			t.Errorf("o fechamento não carrega %q: %q", want, delegations[1].Result)
		}
	}
	// A filha recebe o parcial na VOZ do bot — resultado, não silêncio.
	filhoID := store.ChildSessionID(fixture.session, "code")
	falas := messageTexts(t, fixture.store, filhoID, "assistant")
	if len(falas) != 1 || !strings.Contains(falas[0], "RESULTADO PARCIAL") {
		t.Errorf("a filha tinha de receber o parcial como fala do bot: %v", falas)
	}
	// Parcial NÃO é falha: sem aviso vermelho na raiz e o turno fecha normal.
	if erros := envelopesByKind(t, fixture.store, fixture.session, protocol.KindError); len(erros) != 0 {
		t.Errorf("o parcial virou erro na raiz: %d", len(erros))
	}
	if avisos := messageTexts(t, fixture.store, fixture.session, "system"); len(avisos) != 0 {
		t.Errorf("o parcial virou aviso vermelho na raiz: %v", avisos)
	}
	if dones := envelopesByKind(t, fixture.store, fixture.session, protocol.KindDone); len(dones) != 1 {
		t.Errorf("o turno da raiz tinha de fechar com o done normal, obtive %d", len(dones))
	}
}

/* ---------------- 3. o portão de narração vale no relato -------------------- */

// Sem efeito nenhum, um relato que ENCENA ("criei os arquivos…") não pode virar
// o texto que a pessoa lê: o portão de narração vale no encerramento também, e
// o desfecho fica só com o motivo verdadeiro.
func TestRelatoNarradoSemEfeitoNaoLavaAFalha(t *testing.T) {
	answers := append(rodadasDeLeitura(maxDelegationRounds),
		"Criei os arquivos api/index.js e vercel.json com o conteúdo completo.")
	fixture := newEsgotamentoFixture(t, answers)

	texto, ok := fixture.supervisor.delegateWithRoute(motorContext(t), fixture.session, "t1",
		specialist.GetOrDefault("chat"),
		delegateRequest{Specialist: "data", Goal: "modele as tabelas de cobrança"},
		&delegationBudget{}, firstDelegationDepth, nil)

	if ok || !strings.Contains(texto, "NÃO DEU CERTO") {
		t.Fatalf("relato narrado sem efeito tinha de continuar falha: ok=%v %q", ok, texto)
	}
	if strings.Contains(texto, "Criei os arquivos") {
		t.Errorf("a cena narrada virou o texto do desfecho — o portão não valeu no relato: %q", texto)
	}
	if !strings.Contains(texto, "4 rodadas") {
		t.Errorf("o motivo verdadeiro sumiu do desfecho: %q", texto)
	}
}

/* -------------------- 4. o rótulo do orbe conta as rodadas ------------------- */

// O rótulo de etapa deixa de colapsar toda rodada > 0 em "trabalhando": ele
// CONTA — "rodada 3/8 · rodando ferramentas" — com o teto do laço que o chama
// (8 no turno principal e no sub-turno do master, 4 no bot-a-bot).
func TestThinkingLabelContaAsRodadasComOTetoDoLaco(t *testing.T) {
	code := specialist.GetOrDefault("code")
	if got := thinkingLabel(code, 0, maxToolRounds); got != "lendo o código" {
		t.Errorf("a rodada 0 tinha de falar do ofício, veio %q", got)
	}
	if got := thinkingLabel(code, 2, maxToolRounds); got != "rodada 3/8 · rodando ferramentas" {
		t.Errorf("o rótulo não conta: %q", got)
	}
	data := specialist.GetOrDefault("data")
	if got := thinkingLabel(data, 1, maxDelegationRounds); got != "rodada 2/4 · rodando ferramentas" {
		t.Errorf("o teto do bot-a-bot não aparece no rótulo: %q", got)
	}
	if got := thinkingLabel(data, 0, maxDelegationRounds); got != "modelando" {
		t.Errorf("a rodada 0 do dados tinha de ser %q, veio %q", "modelando", got)
	}
}

// O teto por papel, direto na régua: master usa o teto do turno principal;
// qualquer especialista delegando usa o teto pontual do bot-a-bot.
func TestTetoDeRodadasEPorPapel(t *testing.T) {
	if got := tetoDeRodadas(specialist.Master); got != maxToolRounds {
		t.Errorf("o sub-turno do master tinha de usar %d rodadas, veio %d", maxToolRounds, got)
	}
	if got := tetoDeRodadas(specialist.GetOrDefault("code")); got != maxDelegationRounds {
		t.Errorf("o bot-a-bot tinha de manter %d rodadas, veio %d", maxDelegationRounds, got)
	}
}
