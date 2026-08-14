// Testes do planejador do DAG.
//
// O plano é CONGELADO quando o run nasce: se o mesmo pedido gerasse ondas
// diferentes a cada chamada, o replay divergiria do que foi executado. Por isso
// há teste de determinismo junto com os de validação.
package supervisor

import (
	"fmt"
	"strings"
	"testing"

	"aibot/gateway/internal/protocol"
)

/* ------------------------------ auxiliares ------------------------------ */

// planTask monta uma tarefa válida com o especialista "chat", que NÃO tem
// fs.write — assim os testes de topologia não colhem o aviso de checkout
// compartilhado, que tem teste próprio.
func planTask(id string, dependsOn ...string) protocol.Task {
	return protocol.Task{
		ID:         id,
		Title:      "tarefa " + id,
		Specialist: "chat",
		Goal:       "objetivo de " + id,
		DependsOn:  dependsOn,
	}
}

// diamondPlan é o grafo a -> b,c -> d.
func diamondPlan() []protocol.Task {
	return []protocol.Task{
		planTask("a"),
		planTask("b", "a"),
		planTask("c", "a"),
		planTask("d", "b", "c"),
	}
}

func formatWaves(waves [][]string) string {
	parts := make([]string, 0, len(waves))
	for _, wave := range waves {
		parts = append(parts, "["+strings.Join(wave, " ")+"]")
	}
	if len(parts) == 0 {
		return "(nenhuma onda)"
	}
	return strings.Join(parts, " -> ")
}

func mustPlan(t *testing.T, tasks []protocol.Task, maxConcurrency int) Plan {
	t.Helper()
	plan, err := PlanTasks(tasks, maxConcurrency)
	if err != nil {
		t.Fatalf("PlanTasks com concorrência %d: esperava sucesso, obteve erro: %v", maxConcurrency, err)
	}
	if !plan.Valid {
		t.Fatalf("PlanTasks: esperava Valid=true no plano aceito, obteve false")
	}
	return plan
}

/* ------------------------------- validação ------------------------------ */

func TestPlanTasksRejectsMalformedPlans(t *testing.T) {
	tooManyDependencies := make([]string, maxDependencies+1)
	for index := range tooManyDependencies {
		tooManyDependencies[index] = fmt.Sprintf("d%d", index)
	}
	deep := planTask("x")
	deep.DependsOn = tooManyDependencies

	overflow := make([]protocol.Task, 0, maxTasks+1)
	for index := 0; index <= maxTasks; index++ {
		overflow = append(overflow, planTask(fmt.Sprintf("t%d", index)))
	}

	noSpecialist := planTask("a")
	noSpecialist.Specialist = "inexistente"

	noTitle := planTask("a")
	noTitle.Title = "   "

	noID := planTask("a")
	noID.ID = "   "

	cases := []struct {
		name           string
		tasks          []protocol.Task
		maxConcurrency int
		wantMessage    string
	}{
		{"plano vazio", nil, 4, "pelo menos uma tarefa"},
		{"plano grande demais", overflow, 4, "no máximo 128 tarefas"},
		{"concorrência zero", []protocol.Task{planTask("a")}, 0, "entre 1 e 32"},
		{"concorrência acima do teto", []protocol.Task{planTask("a")}, concurrencyCeil + 1, "entre 1 e 32"},
		{"tarefa sem id", []protocol.Task{noID}, 4, "na posição 0 está sem id"},
		{"tarefa sem título", []protocol.Task{noTitle}, 4, `a tarefa "a" está sem título`},
		{"id repetido", []protocol.Task{planTask("a"), planTask("a")}, 4, `id de tarefa repetido: "a"`},
		{"dependências demais", []protocol.Task{deep}, 4, "o limite é 32"},
		{"dependência inexistente", []protocol.Task{planTask("a", "z")}, 4, `depende de "z", que não existe no plano`},
		{"autodependência", []protocol.Task{planTask("a", "a")}, 4, `a tarefa "a" depende de si mesma`},
		{"dependência repetida", []protocol.Task{planTask("a"), planTask("b", "a", "a")}, 4, `repete a dependência "a"`},
		{"especialista inexistente", []protocol.Task{noSpecialist}, 4, `pede o especialista "inexistente"`},
		{"ciclo", []protocol.Task{planTask("a", "b"), planTask("b", "a")}, 4, "ciclo de dependências entre: a, b"},
	}

	for _, each := range cases {
		t.Run(each.name, func(t *testing.T) {
			plan, err := PlanTasks(each.tasks, each.maxConcurrency)
			if err == nil {
				t.Fatalf("PlanTasks: esperava erro contendo %q, obteve sucesso com as ondas %s",
					each.wantMessage, formatWaves(plan.Waves))
			}
			if !strings.Contains(err.Error(), each.wantMessage) {
				t.Errorf("PlanTasks: esperava erro contendo %q, obteve %q", each.wantMessage, err.Error())
			}
			if plan.Valid || plan.Waves != nil || plan.CriticalPath != nil {
				t.Errorf("PlanTasks com erro: esperava o plano zerado, obteve Valid=%v ondas=%s caminho=%v",
					plan.Valid, formatWaves(plan.Waves), plan.CriticalPath)
			}
		})
	}
}

/* -------------------------------- ondas --------------------------------- */

func TestPlanTasksBuildsTopologicalWaves(t *testing.T) {
	plan := mustPlan(t, diamondPlan(), 4)

	const want = "[a] -> [b c] -> [d]"
	if got := formatWaves(plan.Waves); got != want {
		t.Fatalf("PlanTasks no diamante: esperava as ondas %s, obteve %s", want, got)
	}
	if plan.MaxParallelism != 2 {
		t.Errorf("PlanTasks no diamante: esperava MaxParallelism 2, obteve %d", plan.MaxParallelism)
	}
	if len(plan.Warnings) != 0 {
		t.Errorf("PlanTasks no diamante com especialista sem fs.write: esperava nenhum aviso, obteve %v", plan.Warnings)
	}
}

func TestPlanTasksTruncatesWaveAtMaxConcurrency(t *testing.T) {
	tasks := []protocol.Task{planTask("a"), planTask("b"), planTask("c")}

	plan := mustPlan(t, tasks, 2)

	const wantWaves = "[a b] -> [c]"
	if got := formatWaves(plan.Waves); got != wantWaves {
		t.Fatalf("PlanTasks com concorrência 2: esperava as ondas %s, obteve %s", wantWaves, got)
	}
	if plan.MaxParallelism != 2 {
		t.Errorf("PlanTasks com concorrência 2: esperava MaxParallelism 2, obteve %d", plan.MaxParallelism)
	}

	const wantWarning = "3 tarefas iniciais serão enfileiradas pela concorrência 2"
	if len(plan.Warnings) != 1 || plan.Warnings[0] != wantWarning {
		t.Errorf("PlanTasks com concorrência 2: esperava exatamente o aviso %q, obteve %v", wantWarning, plan.Warnings)
	}
}

// Duas tarefas que escrevem no mesmo checkout se sobrescrevem sem erro nenhum:
// o aviso é a única pista de que o trabalho de uma vai sumir.
func TestPlanTasksWarnsAboutSharedCheckout(t *testing.T) {
	writing := func(id string, isolated bool) protocol.Task {
		task := planTask(id)
		task.Specialist = "code" // "code" tem fs.write; "chat" não
		task.Worktree = isolated
		return task
	}

	shared := mustPlan(t, []protocol.Task{writing("a", false), writing("b", false)}, 4)
	if len(shared.Warnings) != 1 || !strings.Contains(shared.Warnings[0], "cópia isolada") {
		t.Errorf("PlanTasks com duas tarefas que escrevem no mesmo checkout: esperava o aviso de disputa de arquivo, obteve %v",
			shared.Warnings)
	}

	isolated := mustPlan(t, []protocol.Task{writing("a", true), writing("b", false)}, 4)
	if len(isolated.Warnings) != 0 {
		t.Errorf("PlanTasks com só uma tarefa no checkout compartilhado: esperava nenhum aviso, obteve %v",
			isolated.Warnings)
	}
}

func TestPlanTasksFindsCriticalPathOfDiamond(t *testing.T) {
	plan := mustPlan(t, diamondPlan(), 4)

	// Profundidade é do grafo: a -> b -> d tem 3 tarefas encadeadas. O empate
	// entre b e c fica com b, que foi declarado antes.
	want := []string{"a", "b", "d"}
	if strings.Join(plan.CriticalPath, ",") != strings.Join(want, ",") {
		t.Errorf("PlanTasks no diamante: esperava o caminho crítico %v, obteve %v", want, plan.CriticalPath)
	}
}

// A concorrência atrasa a onda, não encurta a corrente de dependências.
func TestPlanTasksKeepsCriticalPathUnderTightConcurrency(t *testing.T) {
	plan := mustPlan(t, diamondPlan(), 1)

	want := []string{"a", "b", "d"}
	if strings.Join(plan.CriticalPath, ",") != strings.Join(want, ",") {
		t.Errorf("PlanTasks no diamante com concorrência 1: esperava o mesmo caminho crítico %v, obteve %v",
			want, plan.CriticalPath)
	}
	if plan.MaxParallelism != 1 {
		t.Errorf("PlanTasks com concorrência 1: esperava MaxParallelism 1, obteve %d", plan.MaxParallelism)
	}
}

func TestPlanTasksIsDeterministic(t *testing.T) {
	first := mustPlan(t, diamondPlan(), 2)
	wantWaves := formatWaves(first.Waves)
	wantPath := strings.Join(first.CriticalPath, ",")

	for round := 0; round < 50; round++ {
		plan := mustPlan(t, diamondPlan(), 2)
		if got := formatWaves(plan.Waves); got != wantWaves {
			t.Fatalf("PlanTasks na execução %d: esperava as ondas %s, obteve %s", round, wantWaves, got)
		}
		if got := strings.Join(plan.CriticalPath, ","); got != wantPath {
			t.Fatalf("PlanTasks na execução %d: esperava o caminho crítico %s, obteve %s", round, wantPath, got)
		}
	}
}

/* --------------------------------- Wave --------------------------------- */

func TestPlanWaveReturnsMinusOneForUnknownTask(t *testing.T) {
	plan := mustPlan(t, diamondPlan(), 4)

	cases := []struct {
		taskID string
		want   int
	}{
		{"a", 0},
		{"b", 1},
		{"c", 1},
		{"d", 2},
		{"nao-existe", -1},
		{"", -1},
	}

	for _, each := range cases {
		if got := plan.Wave(each.taskID); got != each.want {
			t.Errorf("Wave(%q): esperava %d, obteve %d (ondas %s)", each.taskID, each.want, got, formatWaves(plan.Waves))
		}
	}

	if got := (Plan{}).Wave("a"); got != -1 {
		t.Errorf("Wave em plano vazio: esperava -1, obteve %d", got)
	}
}
