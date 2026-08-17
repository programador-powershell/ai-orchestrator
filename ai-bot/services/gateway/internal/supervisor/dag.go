// Planejador do DAG de tarefas do especialista "agent" (a equipe).
//
// Porte das regras do validador do gateway anterior (services/gateway/src/routes.rs,
// plan_orchestration) para protocol.Task. O comentário de pacote mora em router.go;
// aqui só o porquê deste arquivo.
//
// A razão de o planejamento ser uma função pura, separada da execução: o plano é
// CONGELADO quando o run nasce. Se o mesmo pedido gerasse um plano diferente a cada
// chamada, o replay do run divergiria do que foi executado — e a pessoa veria um
// grafo que nunca aconteceu. Por isso não há mapa no caminho da decisão: toda ordem
// sai do índice original da tarefa.
//
// Sem dependência de terceiro: Kahn e a maior profundidade acumulada são vinte
// linhas cada, e trazer um pacote de grafo para isso custaria mais em revisão de
// TI/SI do que custa escrever.

package supervisor

import (
	"errors"
	"fmt"
	"sort"
	"strings"

	"aibot/gateway/internal/protocol"
	"aibot/gateway/internal/specialist"
)

const (
	// maxTasks e maxDependencies são teto de sanidade, não de capacidade: um plano
	// com mais que isso quase sempre é modelo alucinando lista, e o custo de
	// descobrir isso rodando é alto (cada tarefa é um processo de trabalhador).
	maxTasks        = 128
	maxDependencies = 32

	concurrencyFloor = 1
	concurrencyCeil  = 32

	// writeTool é a ferramenta que decide se a tarefa disputa arquivo com as outras.
	writeTool = "fs.write"
)

// Plan é o resultado do planejamento: o mesmo formato que a tela do modo agente
// desenha e que o run durável guarda.
type Plan struct {
	Valid          bool       `json:"valid"`
	Waves          [][]string `json:"waves"`
	CriticalPath   []string   `json:"criticalPath"`
	MaxParallelism int        `json:"maxParallelism"`
	Warnings       []string   `json:"warnings"`
}

// PlanTasks valida a lista e devolve as ondas de execução.
//
// Os erros não embrulham causa (%w) porque não há causa embaixo: é validação de
// dado, não I/O. A mensagem É o contrato — ela vai inteira para a tela.
func PlanTasks(tasks []protocol.Task, maxConcurrency int) (Plan, error) {
	if len(tasks) == 0 {
		return Plan{}, errors.New("o plano precisa de pelo menos uma tarefa")
	}
	if len(tasks) > maxTasks {
		return Plan{}, errors.New("o plano aceita no máximo 128 tarefas")
	}
	if maxConcurrency < concurrencyFloor || maxConcurrency > concurrencyCeil {
		return Plan{}, errors.New("a concorrência precisa estar entre 1 e 32")
	}

	// Primeira passada: identidade. Precisa terminar antes da segunda porque a
	// checagem de dependência inexistente depende do índice completo — senão
	// "b depende de c" acusaria falta de c só por c vir declarado depois.
	indexByID := make(map[string]int, len(tasks))
	for index, task := range tasks {
		// TrimSpace porque id só de espaço passa em `!= ""` e depois nunca casa
		// com dependência nenhuma: viraria tarefa órfã em vez de erro.
		if strings.TrimSpace(task.ID) == "" {
			return Plan{}, fmt.Errorf("a tarefa na posição %d está sem id", index)
		}
		if strings.TrimSpace(task.Title) == "" {
			return Plan{}, fmt.Errorf("a tarefa %q está sem título", task.ID)
		}
		if _, repeated := indexByID[task.ID]; repeated {
			return Plan{}, fmt.Errorf("id de tarefa repetido: %q", task.ID)
		}
		if len(task.DependsOn) > maxDependencies {
			return Plan{}, fmt.Errorf("a tarefa %q depende de %d outras; o limite é %d", task.ID, len(task.DependsOn), maxDependencies)
		}
		// O especialista da tarefa passa pelas MESMAS duas regras da delegação
		// (ver delegationRefusal): existir no catálogo e não ser o master.
		//
		// Sem elas o caminho da equipe é a porta dos fundos do que a delegação
		// fecha na porta da frente. Um id inexistente não falhava: `GetOrDefault`
		// devolvia o `chat` calado, e o relatório dizia que a tarefa de segurança
		// tinha sido feita — por outro especialista, com outro prompt e outras
		// ferramentas. E o master não executa nada: ele só decide quem atende.
		requested := strings.TrimSpace(task.Specialist)
		if requested == "" {
			return Plan{}, fmt.Errorf("a tarefa %q está sem especialista", task.ID)
		}
		if requested == specialist.MasterID {
			return Plan{}, fmt.Errorf("a tarefa %q pede o master, que só decide quem atende — "+
				"escolha uma especialidade que execute", task.ID)
		}
		if !specialist.Exists(requested) {
			return Plan{}, fmt.Errorf("a tarefa %q pede o especialista %q, que não existe", task.ID, requested)
		}
		indexByID[task.ID] = index
	}

	// Segunda passada: arestas. indegree conta quantas dependências faltam para a
	// tarefa poder rodar; outgoing lista quem ela libera ao terminar.
	indegree := make([]int, len(tasks))
	outgoing := make([][]int, len(tasks))
	for index, task := range tasks {
		seen := make(map[string]bool, len(task.DependsOn))
		for _, dependency := range task.DependsOn {
			if dependency == task.ID {
				return Plan{}, fmt.Errorf("a tarefa %q depende de si mesma", task.ID)
			}
			// Dependência repetida é erro e não deduplicação silenciosa: ela
			// somaria duas vezes no indegree e a tarefa nunca sairia da fila,
			// aparecendo como "ciclo" mais adiante — diagnóstico errado.
			if seen[dependency] {
				return Plan{}, fmt.Errorf("a tarefa %q repete a dependência %q", task.ID, dependency)
			}
			seen[dependency] = true

			parent, known := indexByID[dependency]
			if !known {
				return Plan{}, fmt.Errorf("a tarefa %q depende de %q, que não existe no plano", task.ID, dependency)
			}
			indegree[index]++
			outgoing[parent] = append(outgoing[parent], index)
		}
		if !specialist.Exists(task.Specialist) {
			return Plan{}, fmt.Errorf("a tarefa %q pede o especialista %q, que não existe", task.ID, task.Specialist)
		}
	}

	// Kahn. `ready` guarda ÍNDICES em ordem crescente, nunca ids vindos de mapa:
	// iteração de mapa em Go é aleatória de propósito, e sem ordem fixa o mesmo
	// pedido geraria ondas diferentes a cada execução — o que a pessoa lê como
	// defeito intermitente, não como concorrência.
	ready := make([]int, 0, len(tasks))
	for index, degree := range indegree {
		if degree == 0 {
			ready = append(ready, index)
		}
	}
	rootCount := len(ready)

	// depth começa em 1: toda tarefa é caminho de tamanho 1 até ela mesma.
	depth := make([]int, len(tasks))
	predecessor := make([]int, len(tasks))
	for index := range tasks {
		depth[index] = 1
		predecessor[index] = -1
	}

	waves := make([][]string, 0, len(tasks))
	processed := 0
	for len(ready) > 0 {
		size := len(ready)
		if size > maxConcurrency {
			size = maxConcurrency
		}
		selected := ready[:size]

		// O que sobrou da onda continua pronto e disputa a próxima com quem for
		// liberado agora. Cópia nova em vez de reaproveitar o array para não
		// escrever por cima de `selected`, que ainda está em uso abaixo.
		remaining := append([]int(nil), ready[size:]...)

		wave := make([]string, 0, size)
		for _, index := range selected {
			wave = append(wave, tasks[index].ID)
		}
		waves = append(waves, wave)
		processed += size

		for _, parent := range selected {
			for _, child := range outgoing[parent] {
				// Profundidade é do GRAFO, não do calendário: mede a corrente de
				// dependências, e por isso não muda quando a concorrência atrasa
				// uma onda. O caminho crítico continua sendo o mesmo trabalho.
				if depth[parent]+1 > depth[child] {
					depth[child] = depth[parent] + 1
					predecessor[child] = parent
				}
				indegree[child]--
				if indegree[child] == 0 {
					remaining = append(remaining, child)
				}
			}
		}

		sort.Ints(remaining)
		ready = remaining
	}

	if processed != len(tasks) {
		// Quem sobrou com indegree > 0 está no ciclo ou preso atrás dele. Ordem de
		// declaração, que é estável entre execuções.
		blocked := make([]string, 0, len(tasks)-processed)
		for index, degree := range indegree {
			if degree > 0 {
				blocked = append(blocked, tasks[index].ID)
			}
		}
		return Plan{}, fmt.Errorf("ciclo de dependências entre: %s", strings.Join(blocked, ", "))
	}

	// Maior profundidade vence; empate fica com o menor índice original porque o
	// `>` estrito nunca troca o campeão por outro de mesma altura.
	best := 0
	for index := 1; index < len(depth); index++ {
		if depth[index] > depth[best] {
			best = index
		}
	}
	criticalPath := []string{tasks[best].ID}
	for cursor := predecessor[best]; cursor >= 0; cursor = predecessor[cursor] {
		criticalPath = append(criticalPath, tasks[cursor].ID)
	}
	for left, right := 0, len(criticalPath)-1; left < right; left, right = left+1, right-1 {
		criticalPath[left], criticalPath[right] = criticalPath[right], criticalPath[left]
	}

	maxParallelism := 0
	for _, wave := range waves {
		if len(wave) > maxParallelism {
			maxParallelism = len(wave)
		}
	}

	// Slice não-nil para o JSON sair como [] e não como null: a tela itera direto.
	warnings := make([]string, 0, 2)
	shared := 0
	for _, task := range tasks {
		if !task.Worktree && specialist.GetOrDefault(task.Specialist).AllowsTool(writeTool) {
			shared++
		}
	}
	if shared > 1 {
		// Duas tarefas que escrevem no mesmo checkout se sobrescrevem sem erro
		// nenhum: o git aceita, o build passa, e o trabalho de uma some.
		warnings = append(warnings, "nenhuma tarefa escreve em cópia isolada — tarefas que tocam o repositório vão disputar os mesmos arquivos")
	}
	if rootCount > maxConcurrency {
		warnings = append(warnings, fmt.Sprintf("%d tarefas iniciais serão enfileiradas pela concorrência %d", rootCount, maxConcurrency))
	}

	return Plan{
		Valid:          true,
		Waves:          waves,
		CriticalPath:   criticalPath,
		MaxParallelism: maxParallelism,
		Warnings:       warnings,
	}, nil
}

// Wave devolve o índice da onda da tarefa (a primeira é 0) ou -1 se ela não está
// no plano. Busca linear de propósito: são no máximo 128 ids, e um mapa aqui
// duplicaria estado que teria de ser mantido em sincronia com Waves.
func (p Plan) Wave(taskID string) int {
	for index, wave := range p.Waves {
		for _, id := range wave {
			if id == taskID {
				return index
			}
		}
	}
	return -1
}
