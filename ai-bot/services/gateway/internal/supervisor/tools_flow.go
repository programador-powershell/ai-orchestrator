// Validação do fluxo visual e agenda local.
//
// As duas estavam registradas como "de HOST" e recusavam sempre, por herança do
// aplicativo anterior — onde a tela do fluxo e o agendador moravam no Rust.
// Nenhuma das duas precisa da máquina: validar fluxo é percorrer grafo e
// agendar é guardar horário num arquivo. Nada de ConPTY, Job Object nem cofre
// do sistema. O comentário de pacote está em tools.go; aqui só o porquê deste
// arquivo.
//
// A decisão que manda no resto: o relatório do fluxo é DETERMINÍSTICO. Toda
// ordem sai do índice original do nó, nunca da iteração de um mapa (que Go
// embaralha de propósito). Mapa aqui só serve para consultar id → índice. Sem
// isso, validar o mesmo fluxo duas vezes devolveria dois relatórios diferentes,
// e a pessoa leria isso como defeito — não como aleatoriedade de mapa.

package supervisor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"aibot/gateway/internal/schedule"
)

/* ------------------------------ flow.validate ----------------------------- */

// Kinds do fluxo. Lista fechada: kind desconhecido é erro, não extensão — um
// nó que a interface não sabe desenhar não vai rodar melhor por ser aceito aqui.
const (
	flowInput     = "input"
	flowAction    = "action"
	flowCondition = "condition"
	flowGate      = "gate"
	flowOutput    = "output"
)

// maxFlowNodes é teto de sanidade, não de capacidade. Fluxo com mais que isso
// quase sempre é modelo alucinando lista, e nenhuma pessoa monta 256 nós na mão.
const maxFlowNodes = 256

// FlowNode é um nó do fluxo montado na tela.
type FlowNode struct {
	ID    string   `json:"id"`
	Kind  string   `json:"kind"`
	Label string   `json:"label"`
	Next  []string `json:"next"`
	// OnError é para onde o fluxo vai quando o nó falha.
	OnError string `json:"onError"`
}

// FlowDoc é o fluxo inteiro.
type FlowDoc struct {
	Name  string     `json:"name"`
	Nodes []FlowNode `json:"nodes"`
}

// FlowReport é o resultado da validação.
//
// Erros e avisos são LISTAS e não um erro só: quem monta fluxo quer ver tudo o
// que está torto de uma vez. Parar no primeiro problema faz a pessoa consertar
// um item por rodada de conversa, e cada rodada custa um turno de modelo.
type FlowReport struct {
	Name     string   `json:"name"`
	Nodes    int      `json:"nodes"`
	Valid    bool     `json:"valid"`
	Errors   []string `json:"errors"`
	Warnings []string `json:"warnings"`
}

// String monta o relatório em texto — é ele que vai para o modelo e para a tela.
func (r FlowReport) String() string {
	verdict := "RECUSADO"
	if r.Valid {
		verdict = "VÁLIDO"
	}
	var out strings.Builder
	fmt.Fprintf(&out, "fluxo %q — %d nó(s) — %s\n", orDefault(r.Name, "sem nome"), r.Nodes, verdict)
	if len(r.Errors) > 0 {
		fmt.Fprintf(&out, "\n%d erro(s) — o fluxo não roda assim:\n", len(r.Errors))
		for _, item := range r.Errors {
			fmt.Fprintf(&out, "- %s\n", item)
		}
	}
	if len(r.Warnings) > 0 {
		fmt.Fprintf(&out, "\n%d aviso(s) — o fluxo roda, mas:\n", len(r.Warnings))
		for _, item := range r.Warnings {
			fmt.Fprintf(&out, "- %s\n", item)
		}
	}
	if len(r.Errors) == 0 && len(r.Warnings) == 0 {
		out.WriteString("\nnenhum erro e nenhum aviso\n")
	}
	return out.String()
}

// ValidateFlow confere o fluxo inteiro. Função pura: sem rede, sem disco, sem
// relógio — o mesmo documento devolve o mesmo relatório em qualquer máquina.
func ValidateFlow(doc FlowDoc) FlowReport {
	report := FlowReport{
		Name:  strings.TrimSpace(doc.Name),
		Nodes: len(doc.Nodes),
		// Slices não-nil para o JSON sair como [] e não como null: a tela itera
		// direto, sem checar nulo antes.
		Errors:   make([]string, 0, 4),
		Warnings: make([]string, 0, 4),
	}

	if len(doc.Nodes) == 0 {
		report.Errors = append(report.Errors, "o fluxo não tem nó nenhum")
		return report
	}
	if len(doc.Nodes) > maxFlowNodes {
		report.Errors = append(report.Errors,
			fmt.Sprintf("o fluxo tem %d nós; o limite é %d", len(doc.Nodes), maxFlowNodes))
		return report
	}

	// Primeira passada: identidade. Precisa terminar antes da segunda porque a
	// checagem de ligação depende do índice COMPLETO — senão "a aponta para b"
	// acusaria falta de b só por b vir declarado depois.
	indexByID := make(map[string]int, len(doc.Nodes))
	brokenIdentity := false
	for index, node := range doc.Nodes {
		// TrimSpace porque id só de espaço passa em `!= ""` e depois não casa
		// com ligação nenhuma: viraria nó órfão em vez de erro.
		id := strings.TrimSpace(node.ID)
		if id == "" {
			report.Errors = append(report.Errors, fmt.Sprintf("o nó na posição %d está sem id", index))
			brokenIdentity = true
			continue
		}
		if _, repeated := indexByID[id]; repeated {
			report.Errors = append(report.Errors, fmt.Sprintf("id de nó repetido: %q", id))
			brokenIdentity = true
			continue
		}
		indexByID[id] = index
	}
	if brokenIdentity {
		// Sem id único toda checagem seguinte mentiria: a ligação para um id
		// repetido apontaria para o nó errado, e o nó sem id sairia como
		// "inalcançável" quando o problema é outro. Melhor devolver só o que dá
		// para afirmar.
		report.Errors = append(report.Errors,
			"corrija os ids antes: sem id único não dá para conferir ligação, ciclo nem alcance")
		return report
	}

	// Kind normalizado uma vez só. Comparar sempre pelo campo cru faria "Input"
	// vindo da tela cair em kind desconhecido, que é pedantismo, não validação.
	kinds := make([]string, len(doc.Nodes))
	for index, node := range doc.Nodes {
		kinds[index] = strings.ToLower(strings.TrimSpace(node.Kind))
		if !knownFlowKind(kinds[index]) {
			report.Errors = append(report.Errors, fmt.Sprintf(
				"o nó %s tem kind %q, que não existe (use input, action, condition, gate ou output)",
				describeFlowNode(node), node.Kind))
		}
	}

	// Segunda passada: ligações. `next` e `onError` entram na MESMA lista de
	// arestas porque as duas são caminho por onde o fluxo anda de verdade — um
	// laço fechado pelo caminho de erro (A falha para B, B falha para A) roda
	// para sempre igual a um laço fechado pelo caminho feliz.
	edges := make([][]int, len(doc.Nodes))
	for index, node := range doc.Nodes {
		id := strings.TrimSpace(node.ID)
		for _, raw := range node.Next {
			if target, ok := resolveFlowTarget(&report, indexByID, node, id, raw, "next"); ok {
				edges[index] = append(edges[index], target)
			}
		}
		if strings.TrimSpace(node.OnError) != "" {
			if target, ok := resolveFlowTarget(&report, indexByID, node, id, node.OnError, "onError"); ok {
				edges[index] = append(edges[index], target)
			}
		}
	}

	// Entradas em ordem de declaração — é por elas que o alcance começa.
	inputs := make([]int, 0, 2)
	for index := range doc.Nodes {
		if kinds[index] == flowInput {
			inputs = append(inputs, index)
		}
	}
	if len(inputs) == 0 {
		report.Errors = append(report.Errors, `nenhum nó de kind "input" — o fluxo não tem por onde começar`)
	} else {
		reachable := reachableFrom(edges, inputs)
		for index := range doc.Nodes {
			if !reachable[index] {
				report.Errors = append(report.Errors, fmt.Sprintf(
					`o nó %s não é alcançável a partir de nenhum "input" — ele nunca vai rodar`,
					describeFlowNode(doc.Nodes[index])))
			}
		}
	}

	// Ciclos. A pergunta não é "tem volta?", é "a volta tem como parar?".
	//
	// Um DFS com pilha acha UMA volta por aresta de retorno, não todas as voltas
	// elementares (enumerar todas é exponencial e não serviria para nada aqui —
	// a pessoa quer saber onde está o laço, não a combinatória dele). Para a
	// resposta continuar correta mesmo assim, a busca do ERRO roda sobre o
	// subgrafo SEM condition e SEM gate: se sobrar qualquer volta ali, ela é por
	// construção uma volta sem condição de parada, e o DFS garantidamente acha
	// pelo menos uma. Se o subgrafo restrito for acíclico, toda volta do grafo
	// cheio passa por condition ou gate — e aí é aviso, não erro.
	stoppable := make([]bool, len(doc.Nodes))
	for index := range doc.Nodes {
		stoppable[index] = kinds[index] == flowCondition || kinds[index] == flowGate
	}
	running := make([]bool, len(doc.Nodes))
	for index := range running {
		running[index] = !stoppable[index]
	}

	endless := findFlowCycles(edges, running)
	if len(endless) > 0 {
		for _, cycle := range endless {
			report.Errors = append(report.Errors, fmt.Sprintf(
				"ciclo sem condição de parada: %s — nenhum nó desse caminho é \"condition\" ou \"gate\", então ele nunca termina",
				renderFlowCycle(doc.Nodes, cycle)))
		}
	} else {
		everywhere := make([]bool, len(doc.Nodes))
		for index := range everywhere {
			everywhere[index] = true
		}
		for _, cycle := range findFlowCycles(edges, everywhere) {
			report.Warnings = append(report.Warnings, fmt.Sprintf(
				"ciclo com condição de parada: %s (quem pode sair do laço: %s) — confira se a condição realmente sai",
				renderFlowCycle(doc.Nodes, cycle), strings.Join(flowCycleStops(doc.Nodes, cycle, stoppable), ", ")))
		}
	}

	// Avisos de forma. Vêm depois dos de ciclo porque ciclo é o que quebra o
	// fluxo em produção; falta de caminho de erro é o que quebra na primeira
	// exceção.
	for index, node := range doc.Nodes {
		if kinds[index] == flowAction && strings.TrimSpace(node.OnError) == "" {
			report.Warnings = append(report.Warnings, fmt.Sprintf(
				"o nó %s não diz o que acontece quando falha — fluxo sem caminho de erro só funciona no exemplo",
				describeFlowNode(node)))
		}
	}
	hasOutput := false
	for index := range doc.Nodes {
		if kinds[index] == flowOutput {
			hasOutput = true
			break
		}
	}
	if !hasOutput {
		report.Warnings = append(report.Warnings,
			`nenhum nó de kind "output" — o fluxo faz o trabalho e não entrega em lugar nenhum`)
	}

	report.Valid = len(report.Errors) == 0
	return report
}

func knownFlowKind(kind string) bool {
	switch kind {
	case flowInput, flowAction, flowCondition, flowGate, flowOutput:
		return true
	}
	return false
}

// resolveFlowTarget traduz o id citado numa aresta para índice, registrando o
// erro quando ele não dá. Devolve false quando a aresta deve ser DESCARTADA —
// aresta para nó inexistente ou para si mesmo não pode entrar no grafo: ela
// viraria um ciclo falso e o relatório acusaria o problema errado.
func resolveFlowTarget(report *FlowReport, indexByID map[string]int, node FlowNode, id, raw, field string) (int, bool) {
	target := strings.TrimSpace(raw)
	if target == id {
		report.Errors = append(report.Errors, fmt.Sprintf(
			"o nó %s aponta para si mesmo em %q", describeFlowNode(node), field))
		return 0, false
	}
	index, known := indexByID[target]
	if !known {
		report.Errors = append(report.Errors, fmt.Sprintf(
			"o nó %s aponta em %q para %q, que não existe no fluxo", describeFlowNode(node), field, target))
		return 0, false
	}
	return index, true
}

// reachableFrom marca quem o fluxo alcança partindo das entradas. Fila em vez de
// recursão para não depender do tamanho da pilha do Go num fluxo de 256 nós, e
// índices em vez de ids para a ordem não depender de mapa.
func reachableFrom(edges [][]int, inputs []int) []bool {
	seen := make([]bool, len(edges))
	queue := make([]int, 0, len(edges))
	for _, input := range inputs {
		if !seen[input] {
			seen[input] = true
			queue = append(queue, input)
		}
	}
	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]
		for _, next := range edges[current] {
			if !seen[next] {
				seen[next] = true
				queue = append(queue, next)
			}
		}
	}
	return seen
}

// findFlowCycles roda um DFS iterativo com pilha explícita sobre os nós
// permitidos e devolve os ciclos achados por aresta de retorno.
//
// Pilha explícita e não recursão pelo mesmo motivo do alcance: 256 nós em cadeia
// não podem depender do crescimento da pilha da goroutine. `allowed` é o que
// permite rodar a mesma busca duas vezes — uma sem os nós que param o laço
// (onde qualquer volta é erro) e outra com o grafo inteiro (onde toda volta que
// sobrar passa por um deles).
func findFlowCycles(edges [][]int, allowed []bool) [][]int {
	const (
		white = 0 // não visitado
		gray  = 1 // no caminho atual
		black = 2 // fechado
	)
	type frame struct {
		node int
		edge int
	}

	color := make([]int, len(edges))
	// depth diz em que posição do caminho atual o nó cinza está, para recortar o
	// ciclo direto em vez de varrer a pilha a cada aresta de retorno.
	depth := make([]int, len(edges))
	for index := range depth {
		depth[index] = -1
	}

	cycles := make([][]int, 0, 2)
	seen := make(map[string]bool)
	stack := make([]frame, 0, len(edges))
	path := make([]int, 0, len(edges))

	// Início em ordem de declaração: é o que mantém o relatório igual entre
	// execuções.
	for start := range edges {
		if !allowed[start] || color[start] != white {
			continue
		}
		color[start] = gray
		depth[start] = len(path)
		stack = append(stack, frame{node: start})
		path = append(path, start)

		for len(stack) > 0 {
			top := &stack[len(stack)-1]
			if top.edge >= len(edges[top.node]) {
				color[top.node] = black
				depth[top.node] = -1
				stack = stack[:len(stack)-1]
				path = path[:len(path)-1]
				continue
			}
			next := edges[top.node][top.edge]
			top.edge++
			if !allowed[next] {
				continue
			}
			switch color[next] {
			case white:
				color[next] = gray
				depth[next] = len(path)
				stack = append(stack, frame{node: next})
				path = append(path, next)
			case gray:
				// Aresta de retorno: o pedaço do caminho que começa no nó cinza
				// É o ciclo.
				cycle := append([]int(nil), path[depth[next]:]...)
				key := flowCycleKey(cycle)
				if !seen[key] {
					seen[key] = true
					cycles = append(cycles, cycle)
				}
			}
		}
	}
	return cycles
}

// flowCycleKey normaliza o ciclo pela rotação que começa no menor índice, para o
// mesmo laço achado por dois caminhos não sair duas vezes no relatório.
func flowCycleKey(cycle []int) string {
	smallest := 0
	for position, node := range cycle {
		if node < cycle[smallest] {
			smallest = position
		}
	}
	parts := make([]string, 0, len(cycle))
	for offset := range cycle {
		parts = append(parts, fmt.Sprint(cycle[(smallest+offset)%len(cycle)]))
	}
	return strings.Join(parts, ",")
}

// renderFlowCycle desenha o laço fechado: o primeiro nó aparece de novo no fim,
// que é como a pessoa enxerga a volta na tela.
func renderFlowCycle(nodes []FlowNode, cycle []int) string {
	parts := make([]string, 0, len(cycle)+1)
	for _, index := range cycle {
		parts = append(parts, strings.TrimSpace(nodes[index].ID))
	}
	parts = append(parts, strings.TrimSpace(nodes[cycle[0]].ID))
	return strings.Join(parts, " → ")
}

// flowCycleStops lista os nós do laço que podem encerrá-lo.
func flowCycleStops(nodes []FlowNode, cycle []int, stoppable []bool) []string {
	stops := make([]string, 0, len(cycle))
	for _, index := range cycle {
		if stoppable[index] {
			stops = append(stops, fmt.Sprintf("%q", strings.TrimSpace(nodes[index].ID)))
		}
	}
	return stops
}

// describeFlowNode identifica o nó para a pessoa: o id é o que resolve o
// problema, o rótulo é o que ela reconhece na tela.
func describeFlowNode(node FlowNode) string {
	id := strings.TrimSpace(node.ID)
	label := strings.TrimSpace(node.Label)
	if label == "" || label == id {
		return fmt.Sprintf("%q", id)
	}
	return fmt.Sprintf("%q (%s)", id, label)
}

/* ------------------------------- ferramentas ------------------------------ */

// InstallFlowTools registra o validador de fluxo e a agenda.
func (t *Toolbox) InstallFlowTools(registry *Registry) {
	registry.Register("flow.validate",
		"valida o fluxo montado na tela. args: {flow}", t.flowValidate)
	registry.Register("schedule.create",
		`agenda um prompt nesta sessão. args: {prompt, every?, at?, note?}`, t.scheduleCreate)
	registry.Register("schedule.list",
		"lista os gatilhos agendados. args: {all?}", t.scheduleList)
	registry.Register("schedule.remove",
		"apaga um gatilho agendado. args: {id}", t.scheduleRemove)
}

func (t *Toolbox) flowValidate(_ context.Context, _ string, raw json.RawMessage) (string, error) {
	var args struct {
		Flow FlowDoc `json:"flow"`
	}
	if err := decodeArgs(raw, &args); err != nil {
		return "", err
	}
	// Fluxo ausente é erro de ARGUMENTO, não fluxo inválido: a recusa precisa
	// dizer o que faltou na chamada, senão o modelo tenta de novo igual.
	if len(args.Flow.Nodes) == 0 {
		return "", errors.New(`informe o fluxo em "flow" com a lista de nós (id, kind, next, onError)`)
	}
	return ValidateFlow(args.Flow).String(), nil
}

// scheduleStore devolve a agenda ou a recusa acionável. Sucesso vazio aqui seria
// pior que a recusa: o modelo trataria "ok" como agendado e diria à pessoa que a
// automação está de pé.
func (t *Toolbox) scheduleStore() (*schedule.Store, error) {
	if t.Schedule == nil {
		return nil, errors.New("a agenda local não está ligada neste gateway — " +
			"configure a pasta de dados em AIBOT_DATA_DIR e reinicie o gateway para ele abrir schedule.json")
	}
	return t.Schedule, nil
}

func (t *Toolbox) scheduleCreate(_ context.Context, sessionID string, raw json.RawMessage) (string, error) {
	store, err := t.scheduleStore()
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(sessionID) == "" {
		return "", errors.New("o gatilho dispara o prompt numa sessão e esta chamada não tem sessão")
	}
	var args struct {
		Prompt string `json:"prompt"`
		Every  string `json:"every"`
		At     string `json:"at"`
		Note   string `json:"note"`
	}
	if err := decodeArgs(raw, &args); err != nil {
		return "", err
	}

	// A sessão é a ATUAL, sempre: um gatilho que dispara na conversa de outro
	// assunto aparece do nada para quem estiver lendo aquela conversa.
	created, err := store.Add(schedule.Trigger{
		Session: sessionID,
		Prompt:  args.Prompt,
		Every:   args.Every,
		At:      args.At,
		Note:    args.Note,
	})
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("gatilho %s criado (%s). primeiro disparo em %s, hora local desta máquina. "+
		"o prompt vai rodar nesta mesma sessão sem ninguém olhando; use schedule.list para conferir e "+
		"schedule.remove para desfazer",
		created.ID, created.Schedule(), created.NextRun.Local().Format("02/01/2006 15:04")), nil
}

func (t *Toolbox) scheduleList(_ context.Context, sessionID string, raw json.RawMessage) (string, error) {
	store, err := t.scheduleStore()
	if err != nil {
		return "", err
	}
	var args struct {
		All bool `json:"all"`
	}
	if err := decodeArgs(raw, &args); err != nil {
		return "", err
	}

	// O padrão é só esta sessão. Despejar o prompt agendado nas outras conversas
	// aqui misturaria assunto que a pessoa separou de propósito ao abrir sessões
	// diferentes; quem quer o quadro inteiro pede `all`.
	triggers := store.List()
	var report strings.Builder
	shown := 0
	for _, trigger := range triggers {
		if !args.All && trigger.Session != sessionID {
			continue
		}
		shown++
		state := ""
		if !trigger.Enabled {
			state = " [desligado]"
		}
		fmt.Fprintf(&report, "- %s%s — %s — próximo %s — %d disparo(s)",
			trigger.ID, state, trigger.Schedule(),
			trigger.NextRun.Local().Format("02/01/2006 15:04"), trigger.Runs)
		if args.All && trigger.Session != sessionID {
			fmt.Fprintf(&report, " — sessão %s", trigger.Session)
		}
		fmt.Fprintf(&report, "\n  %s\n", truncate(trigger.Prompt, 160))
		if trigger.Note != "" {
			fmt.Fprintf(&report, "  nota: %s\n", truncate(trigger.Note, 160))
		}
	}

	if shown == 0 {
		if args.All {
			return "não há nenhum gatilho agendado", nil
		}
		if len(triggers) > 0 {
			return fmt.Sprintf("nenhum gatilho agendado nesta sessão (há %d em outras sessões; use {\"all\": true} para ver)",
				len(triggers)), nil
		}
		return "não há nenhum gatilho agendado nesta sessão", nil
	}
	return fmt.Sprintf("%d gatilho(s):\n%s", shown, report.String()), nil
}

func (t *Toolbox) scheduleRemove(_ context.Context, _ string, raw json.RawMessage) (string, error) {
	store, err := t.scheduleStore()
	if err != nil {
		return "", err
	}
	var args struct {
		ID string `json:"id"`
	}
	if err := decodeArgs(raw, &args); err != nil {
		return "", err
	}
	if strings.TrimSpace(args.ID) == "" {
		return "", errors.New(`informe o id do gatilho em "id" — schedule.list mostra os ids`)
	}
	if err := store.Remove(args.ID); err != nil {
		return "", err
	}
	return fmt.Sprintf("gatilho %s apagado; ele não dispara mais", strings.TrimSpace(args.ID)), nil
}
