// Testes do validador de fluxo.
//
// O relatório é lido por gente e por modelo, e ele acusa o que impede o fluxo de
// rodar. Por isso cada erro e cada aviso tem teste próprio: um validador que
// deixa passar o ciclo sem parada entrega uma automação que roda para sempre na
// máquina de alguém. O teste de determinismo fecha a lista porque relatório que
// muda sozinho entre execuções parece defeito do produto.
package supervisor

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

/* ------------------------------ auxiliares ------------------------------ */

func flowNode(id, kind string, next ...string) FlowNode {
	return FlowNode{ID: id, Kind: kind, Label: "nó " + id, Next: next}
}

func withOnError(node FlowNode, target string) FlowNode {
	node.OnError = target
	return node
}

// okFlow é o fluxo sem erro E sem aviso: entrada, ação com caminho de erro e
// duas saídas. Os testes partem dele e quebram UMA coisa por vez.
func okFlow() FlowDoc {
	return FlowDoc{
		Name: "atendimento",
		Nodes: []FlowNode{
			flowNode("start", flowInput, "work"),
			withOnError(flowNode("work", flowAction, "done"), "fail"),
			flowNode("done", flowOutput),
			flowNode("fail", flowOutput),
		},
	}
}

func hasMessage(list []string, substring string) bool {
	for _, item := range list {
		if strings.Contains(item, substring) {
			return true
		}
	}
	return false
}

func requireError(t *testing.T, report FlowReport, substring string) {
	t.Helper()
	if report.Valid {
		t.Fatalf("esperava fluxo RECUSADO, veio válido:\n%s", report)
	}
	if !hasMessage(report.Errors, substring) {
		t.Fatalf("esperava erro contendo %q, obtive:\n%s", substring, report)
	}
}

func requireWarning(t *testing.T, report FlowReport, substring string) {
	t.Helper()
	if !hasMessage(report.Warnings, substring) {
		t.Fatalf("esperava aviso contendo %q, obtive:\n%s", substring, report)
	}
}

/* -------------------------------- válido -------------------------------- */

func TestValidateFlowAcceptsCompleteFlow(t *testing.T) {
	report := ValidateFlow(okFlow())

	if !report.Valid {
		t.Fatalf("esperava fluxo válido, obtive:\n%s", report)
	}
	if len(report.Errors) != 0 || len(report.Warnings) != 0 {
		t.Fatalf("esperava relatório limpo, obtive %d erro(s) e %d aviso(s):\n%s",
			len(report.Errors), len(report.Warnings), report)
	}
	text := report.String()
	if !strings.Contains(text, "VÁLIDO") || !strings.Contains(text, "4 nó(s)") {
		t.Fatalf("o veredito não aparece no relatório:\n%s", text)
	}
}

// O caminho de erro é ligação de verdade: o nó só alcançado por onError conta
// como alcançável, senão todo tratamento de falha viraria "nó inalcançável".
func TestValidateFlowTreatsOnErrorAsReachablePath(t *testing.T) {
	doc := okFlow()
	doc.Nodes[1].Next = nil // "work" só sai pelo caminho de erro

	report := ValidateFlow(doc)
	if hasMessage(report.Errors, `"fail"`) {
		t.Fatalf("o alvo de onError foi tratado como inalcançável:\n%s", report)
	}
}

/* -------------------------------- erros --------------------------------- */

func TestValidateFlowRejectsEmptyDocument(t *testing.T) {
	requireError(t, ValidateFlow(FlowDoc{Name: "vazio"}), "não tem nó nenhum")
}

func TestValidateFlowRejectsOversizedDocument(t *testing.T) {
	doc := FlowDoc{Name: "grande"}
	for index := 0; index <= maxFlowNodes; index++ {
		doc.Nodes = append(doc.Nodes, flowNode(fmt.Sprintf("n%d", index), flowAction))
	}
	requireError(t, ValidateFlow(doc), "o limite é 256")
}

func TestValidateFlowRejectsEmptyID(t *testing.T) {
	doc := okFlow()
	doc.Nodes[2].ID = "   " // só espaço também é sem id

	requireError(t, ValidateFlow(doc), "na posição 2 está sem id")
}

func TestValidateFlowRejectsRepeatedID(t *testing.T) {
	doc := okFlow()
	doc.Nodes[3].ID = "done"

	report := ValidateFlow(doc)
	requireError(t, report, `id de nó repetido: "done"`)
	// Com id repetido a análise PARA: seguir daria diagnóstico errado, porque a
	// ligação para "done" apontaria para um dos dois nós por sorteio.
	if hasMessage(report.Errors, "não é alcançável") {
		t.Fatalf("a análise seguiu com id repetido e acusou alcance:\n%s", report)
	}
}

func TestValidateFlowRejectsUnknownKind(t *testing.T) {
	doc := okFlow()
	doc.Nodes[1].Kind = "webhook"

	requireError(t, ValidateFlow(doc), `tem kind "webhook", que não existe`)
}

// "Input" com maiúscula vem da tela e não é kind desconhecido — recusar isso
// seria pedantismo, não validação.
func TestValidateFlowAcceptsKindInAnyCase(t *testing.T) {
	doc := okFlow()
	doc.Nodes[0].Kind = "INPUT"
	doc.Nodes[1].Kind = " Action "

	if report := ValidateFlow(doc); !report.Valid {
		t.Fatalf("kind com caixa diferente foi recusado:\n%s", report)
	}
}

func TestValidateFlowRejectsDanglingNext(t *testing.T) {
	doc := okFlow()
	doc.Nodes[1].Next = []string{"inexistente"}

	requireError(t, ValidateFlow(doc), `aponta em "next" para "inexistente", que não existe`)
}

func TestValidateFlowRejectsDanglingOnError(t *testing.T) {
	doc := okFlow()
	doc.Nodes[1].OnError = "sumiu"

	requireError(t, ValidateFlow(doc), `aponta em "onError" para "sumiu", que não existe`)
}

func TestValidateFlowRejectsSelfReference(t *testing.T) {
	doc := okFlow()
	doc.Nodes[1].Next = []string{"work", "done"}

	report := ValidateFlow(doc)
	requireError(t, report, `aponta para si mesmo em "next"`)
	// A aresta descartada não pode reaparecer como ciclo: dois erros para o
	// mesmo defeito mandam a pessoa procurar dois problemas.
	if hasMessage(report.Errors, "ciclo") {
		t.Fatalf("o auto-laço virou ciclo no relatório:\n%s", report)
	}
}

func TestValidateFlowRejectsSelfReferenceOnError(t *testing.T) {
	doc := okFlow()
	doc.Nodes[1].OnError = "work"

	requireError(t, ValidateFlow(doc), `aponta para si mesmo em "onError"`)
}

func TestValidateFlowRejectsFlowWithoutInput(t *testing.T) {
	doc := okFlow()
	doc.Nodes[0].Kind = flowAction

	requireError(t, ValidateFlow(doc), "não tem por onde começar")
}

func TestValidateFlowRejectsUnreachableNode(t *testing.T) {
	doc := okFlow()
	doc.Nodes = append(doc.Nodes, flowNode("orfao", flowOutput))

	requireError(t, ValidateFlow(doc), `o nó "orfao" (nó orfao) não é alcançável`)
}

// O caso que motiva o validador: um laço que não passa por condition nem gate
// nunca termina, e ele precisa sair no relatório COM os nós que o formam.
func TestValidateFlowRejectsEndlessCycle(t *testing.T) {
	doc := FlowDoc{
		Name: "laço",
		Nodes: []FlowNode{
			flowNode("start", flowInput, "a"),
			withOnError(flowNode("a", flowAction, "b", "done"), "fail"),
			withOnError(flowNode("b", flowAction, "a"), "fail"),
			flowNode("done", flowOutput),
			flowNode("fail", flowOutput),
		},
	}

	report := ValidateFlow(doc)
	requireError(t, report, "ciclo sem condição de parada")
	requireError(t, report, "a → b → a")
}

// Laço fechado pelo caminho de ERRO roda para sempre igual ao do caminho feliz:
// A falha para B, B falha para A.
func TestValidateFlowRejectsEndlessCycleThroughOnError(t *testing.T) {
	doc := FlowDoc{
		Name: "retentativa cega",
		Nodes: []FlowNode{
			flowNode("start", flowInput, "a"),
			withOnError(flowNode("a", flowAction, "done"), "b"),
			withOnError(flowNode("b", flowAction, "done"), "a"),
			flowNode("done", flowOutput),
		},
	}

	requireError(t, ValidateFlow(doc), "ciclo sem condição de parada")
}

// Um laço com condição junto de outro sem condição na MESMA região do grafo: o
// sem parada não pode ser encoberto pelo com parada.
func TestValidateFlowFindsEndlessCycleHiddenBesideStoppableOne(t *testing.T) {
	doc := FlowDoc{
		Name: "dois laços",
		Nodes: []FlowNode{
			flowNode("start", flowInput, "a"),
			withOnError(flowNode("a", flowAction, "check", "c"), "fail"),
			flowNode("check", flowCondition, "a", "done"),
			withOnError(flowNode("c", flowAction, "a"), "fail"),
			flowNode("done", flowOutput),
			flowNode("fail", flowOutput),
		},
	}

	report := ValidateFlow(doc)
	requireError(t, report, "ciclo sem condição de parada")
	if !hasMessage(report.Errors, "a → c → a") && !hasMessage(report.Errors, "c → a → c") {
		t.Fatalf("o ciclo sem parada não foi citado pelos nós:\n%s", report)
	}
}

/* -------------------------------- avisos -------------------------------- */

func TestValidateFlowWarnsActionWithoutOnError(t *testing.T) {
	// Fluxo inteiro menos o caminho de erro — nada mais está torto nele.
	doc := FlowDoc{
		Name: "sem caminho de erro",
		Nodes: []FlowNode{
			flowNode("start", flowInput, "work"),
			flowNode("work", flowAction, "done"),
			flowNode("done", flowOutput),
		},
	}

	report := ValidateFlow(doc)
	if !report.Valid {
		t.Fatalf("falta de onError é aviso, não erro:\n%s", report)
	}
	requireWarning(t, report, "não diz o que acontece quando falha")
	requireWarning(t, report, "só funciona no exemplo")
}

func TestValidateFlowWarnsMissingOutput(t *testing.T) {
	doc := FlowDoc{
		Name: "sem saída",
		Nodes: []FlowNode{
			flowNode("start", flowInput, "work"),
			withOnError(flowNode("work", flowAction), "fail"),
			flowNode("fail", flowAction),
		},
	}

	report := ValidateFlow(doc)
	if !report.Valid {
		t.Fatalf("falta de output é aviso, não erro:\n%s", report)
	}
	requireWarning(t, report, `nenhum nó de kind "output"`)
}

func TestValidateFlowWarnsStoppableCycle(t *testing.T) {
	doc := FlowDoc{
		Name: "com condição",
		Nodes: []FlowNode{
			flowNode("start", flowInput, "check"),
			flowNode("check", flowCondition, "work", "done"),
			withOnError(flowNode("work", flowAction, "check"), "fail"),
			flowNode("done", flowOutput),
			flowNode("fail", flowOutput),
		},
	}

	report := ValidateFlow(doc)
	if !report.Valid {
		t.Fatalf("ciclo com condição de parada é aviso, não erro:\n%s", report)
	}
	requireWarning(t, report, "ciclo com condição de parada")
	requireWarning(t, report, "check → work → check")
	requireWarning(t, report, `quem pode sair do laço: "check"`)
}

// gate para o laço pelo mesmo motivo que condition: alguém decide se continua.
func TestValidateFlowAcceptsCycleThroughGate(t *testing.T) {
	doc := FlowDoc{
		Name: "com portão",
		Nodes: []FlowNode{
			flowNode("start", flowInput, "gate"),
			flowNode("gate", flowGate, "work", "done"),
			withOnError(flowNode("work", flowAction, "gate"), "fail"),
			flowNode("done", flowOutput),
			flowNode("fail", flowOutput),
		},
	}

	report := ValidateFlow(doc)
	if !report.Valid {
		t.Fatalf("ciclo por gate deveria ser aviso:\n%s", report)
	}
	requireWarning(t, report, "ciclo com condição de parada")
}

/* ----------------------------- determinismo ----------------------------- */

// O mesmo fluxo tem de gerar o MESMO relatório, sempre. A ordem sai do índice do
// nó; se algum trecho passar a iterar mapa, a iteração aleatória do Go embaralha
// erros e avisos e a pessoa vê o produto se contradizendo entre duas validações.
func TestValidateFlowIsDeterministic(t *testing.T) {
	doc := FlowDoc{
		Name: "fluxo grande",
		Nodes: []FlowNode{
			flowNode("start", flowInput, "a", "b"),
			withOnError(flowNode("a", flowAction, "c", "d"), "fail"),
			flowNode("b", flowAction, "d"),
			withOnError(flowNode("c", flowAction, "a"), "fail"),
			flowNode("d", flowCondition, "e", "out"),
			withOnError(flowNode("e", flowAction, "d", "f"), "fail"),
			flowNode("f", flowAction, "g"),
			withOnError(flowNode("g", flowAction, "f"), "fail"),
			flowNode("h", "desconhecido", "out"),
			flowNode("i", flowAction, "sumiu"),
			flowNode("out", flowOutput),
			flowNode("fail", flowOutput),
		},
	}

	first := ValidateFlow(doc).String()
	if !strings.Contains(first, "RECUSADO") {
		t.Fatalf("o fluxo do teste precisa reunir erros e avisos:\n%s", first)
	}
	for round := 0; round < 50; round++ {
		if again := ValidateFlow(doc).String(); again != first {
			t.Fatalf("execução %d divergiu.\nprimeira:\n%s\nagora:\n%s", round, first, again)
		}
	}
}

/* ------------------------------ ferramenta ------------------------------ */

func TestFlowValidateToolReportsAndRefuses(t *testing.T) {
	toolbox := &Toolbox{}

	// Sem o fluxo nos argumentos a recusa fala do ARGUMENTO: o modelo precisa
	// saber o que faltou na chamada, não receber um relatório de fluxo vazio.
	if _, err := toolbox.flowValidate(nil, "s1", json.RawMessage(`{}`)); err == nil {
		t.Fatal("esperava recusa quando \"flow\" não vem nos argumentos")
	}

	raw, err := json.Marshal(map[string]any{"flow": okFlow()})
	if err != nil {
		t.Fatalf("montar argumentos: %v", err)
	}
	out, err := toolbox.flowValidate(nil, "s1", raw)
	if err != nil {
		t.Fatalf("flow.validate: %v", err)
	}
	if !strings.Contains(out, "VÁLIDO") {
		t.Fatalf("o relatório não veio pela ferramenta:\n%s", out)
	}
}
