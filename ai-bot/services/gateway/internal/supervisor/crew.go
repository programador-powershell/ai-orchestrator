// A equipe: o especialista `agent` decompõe o objetivo em tarefas e o gateway
// as executa.
//
// O vocabulário veio do Orca (MIT, levantamento funcional — nenhum código
// copiado; ver docs/creditos-inspiracao.md): despacho de tarefa para
// trabalhador, espera por `worker.done` OU `escalate`, DAG com dependências,
// portão de decisão entre ondas e — o que mais importa — cada trabalhador que
// escreve no repositório trabalha na PRÓPRIA cópia do git.
//
// O isolamento por worktree não é preciosismo. Dois agentes editando o mesmo
// arquivo em paralelo produzem um resultado que compila, parece certo e perdeu
// metade de uma das duas mudanças. É o modo de falha mais caro da orquestração,
// porque não avisa.
package supervisor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"aibot/gateway/internal/modelrouter"
	"aibot/gateway/internal/protocol"
	"aibot/gateway/internal/specialist"
)

// workerMaxRounds limita o vaivém de UM trabalhador.
const workerMaxRounds = 6

// InstallCrewTools registra as ferramentas que só o supervisor pode oferecer,
// porque elas reentram nele.
func (s *Supervisor) InstallCrewTools(registry *Registry) {
	registry.Register("task.dispatch",
		"monta e executa uma equipe. args: {tasks:[{id,title,specialist,goal,dependsOn?,worktree?}], maxConcurrency?}",
		s.toolDispatch)
	registry.Register("task.gate",
		"decide o que fazer depois de uma onda. args: {gateId, decision:proceed|retry|abort, reason?}",
		s.toolGate)
}

// crewRequest é o que o especialista `agent` emite.
type crewRequest struct {
	Tasks          []protocol.Task `json:"tasks"`
	MaxConcurrency int             `json:"maxConcurrency"`
}

func (s *Supervisor) toolDispatch(ctx context.Context, sessionID string, raw json.RawMessage) (string, error) {
	var request crewRequest
	if err := decodeArgs(raw, &request); err != nil {
		return "", err
	}
	if request.MaxConcurrency <= 0 {
		request.MaxConcurrency = 4
	}
	plan, err := PlanTasks(request.Tasks, request.MaxConcurrency)
	if err != nil {
		// O erro de plano volta como TEXTO para o modelo, não como exceção: ele
		// precisa ler "a tarefa t3 depende de t9, que não existe" para corrigir
		// o próprio plano em vez de reemitir o mesmo grafo quebrado.
		return "", err
	}
	return s.runCrew(ctx, sessionID, request.Tasks, plan)
}

// toolGate registra a decisão de um portão. Portão é assíncrono por natureza —
// a decisão pode vir do modelo orquestrador ou de uma pessoa —, então a
// ferramenta apenas publica; quem espera é o laço de ondas.
func (s *Supervisor) toolGate(_ context.Context, _ string, raw json.RawMessage) (string, error) {
	var gate protocol.Gate
	if err := decodeArgs(raw, &gate); err != nil {
		return "", err
	}
	if err := s.DecideGate(gate); err != nil {
		return "", err
	}
	return fmt.Sprintf("portão %s: %s", gate.GateID, gate.Decision), nil
}

// DecideGate registra o veredito de um portão.
//
// Exportada porque a decisão pode vir de DUAS origens — o modelo orquestrador
// (pela ferramenta `task.gate`) e a pessoa (pelo botão na tela, via HTTP). As
// duas passam por aqui de propósito: dois caminhos de decisão divergem, e o que
// diverge é o que decide errado na hora que importa.
func (s *Supervisor) DecideGate(gate protocol.Gate) error {
	if gate.GateID == "" {
		return errors.New("informe o gateId")
	}
	switch gate.Decision {
	case protocol.GateProceed, protocol.GateRetry, protocol.GateAbort:
	default:
		return fmt.Errorf("decisão inválida: %q (use proceed, retry ou abort)", gate.Decision)
	}
	s.mu.Lock()
	channel := s.gates[gate.GateID]
	s.mu.Unlock()
	if channel == nil {
		return fmt.Errorf("nenhum portão aberto com id %s", gate.GateID)
	}
	select {
	case channel <- gate:
	default:
		// Já decidido — dois cliques, ou o modelo e a pessoa ao mesmo tempo.
	}
	return nil
}

// runCrew executa o plano onda por onda.
func (s *Supervisor) runCrew(
	ctx context.Context,
	sessionID string,
	tasks []protocol.Task,
	plan Plan,
) (string, error) {
	byID := make(map[string]protocol.Task, len(tasks))
	for _, task := range tasks {
		byID[task.ID] = task
	}

	orchestrator := protocol.Actor{
		Kind:       protocol.ActorSupervisor,
		ID:         "agent",
		Specialist: "agent",
	}
	turn := s.nextID("crew")

	var report strings.Builder
	fmt.Fprintf(&report, "plano: %d tarefas em %d ondas (paralelismo %d)\n",
		len(tasks), len(plan.Waves), plan.MaxParallelism)
	for _, warning := range plan.Warnings {
		fmt.Fprintf(&report, "aviso: %s\n", warning)
	}

	// Resultado de tarefa concluída, para alimentar as dependentes. Uma tarefa
	// que não vê a saída de quem ela depende refaz o trabalho — ou pior, decide
	// diferente e o conjunto fica incoerente.
	results := make(map[string]string, len(tasks))

	for waveIndex, wave := range plan.Waves {
		if err := ctx.Err(); err != nil {
			return report.String(), err
		}

		type outcome struct {
			taskID string
			done   protocol.WorkerDone
		}
		outcomes := make([]outcome, len(wave))

		var group sync.WaitGroup
		for position, taskID := range wave {
			task, ok := byID[taskID]
			if !ok {
				continue
			}
			workerID := fmt.Sprintf("w-%d-%s", waveIndex+1, task.ID)

			_ = s.emit(sessionID, turn, protocol.KindTaskDispatch, orchestrator, protocol.TaskDispatch{
				Task:     task,
				WorkerID: workerID,
				Wave:     waveIndex + 1,
			})

			group.Add(1)
			go func(position int, task protocol.Task, workerID string) {
				defer group.Done()
				done := s.runWorker(ctx, sessionID, turn, task, workerID, waveIndex+1, results)
				outcomes[position] = outcome{taskID: task.ID, done: done}
			}(position, task, workerID)
		}
		group.Wait()

		failures := 0
		for _, entry := range outcomes {
			if entry.taskID == "" {
				continue
			}
			_ = s.emit(sessionID, turn, protocol.KindWorkerDone, orchestrator, entry.done)
			if entry.done.OK {
				results[entry.taskID] = entry.done.Result
				fmt.Fprintf(&report, "✓ %s: %s\n", entry.taskID, truncate(entry.done.Result, 400))
				continue
			}
			failures++
			fmt.Fprintf(&report, "✗ %s: %s\n", entry.taskID, entry.done.Error)
		}

		// Portão entre ondas: uma onda que falhou não pode seguir em silêncio,
		// porque as tarefas seguintes dependem do que ela deveria ter produzido.
		if failures > 0 && waveIndex+1 < len(plan.Waves) {
			decision := s.openGate(ctx, sessionID, turn, orchestrator, waveIndex+1, failures)
			fmt.Fprintf(&report, "portão da onda %d: %s\n", waveIndex+1, decision)
			if decision == protocol.GateAbort {
				report.WriteString("execução abortada no portão\n")
				return report.String(), nil
			}
		}
	}

	return report.String(), nil
}

// runWorker executa UMA tarefa.
func (s *Supervisor) runWorker(
	ctx context.Context,
	sessionID, turn string,
	task protocol.Task,
	workerID string,
	wave int,
	upstream map[string]string,
) protocol.WorkerDone {
	definition := specialist.GetOrDefault(task.Specialist)
	actor := protocol.Actor{
		Kind:       protocol.ActorWorker,
		ID:         workerID,
		Specialist: definition.ID,
	}
	done := protocol.WorkerDone{TaskID: task.ID, WorkerID: workerID}

	entry, _, err := s.deps.Models.Resolve(definition.ID, task.Model)
	if err != nil {
		done.Error = err.Error()
		return done
	}

	// Cópia isolada quando a tarefa pediu — e o descarte é garantido aqui, não
	// deixado para o modelo lembrar de chamar `worktree.remove`.
	if task.Worktree && s.deps.Tools != nil {
		if created, err := s.createWorktree(ctx, task.ID); err == nil {
			done.Worktree = created.path
			done.Branch = created.branch
			defer s.dropWorktree(task.ID)
		} else {
			done.Error = fmt.Sprintf("não foi possível isolar a tarefa: %v", err)
			return done
		}
	}

	var briefing strings.Builder
	briefing.WriteString("Você é um trabalhador de uma equipe. Execute SOMENTE a tarefa abaixo e pare.\n\n")
	fmt.Fprintf(&briefing, "Tarefa %s (onda %d): %s\n\nObjetivo:\n%s\n", task.ID, wave, task.Title, task.Goal)
	if done.Worktree != "" {
		fmt.Fprintf(&briefing, "\nVocê está numa cópia isolada do repositório em %s (ramo %s). "+
			"Trabalhe só nela.\n", done.Worktree, done.Branch)
	}
	if len(task.DependsOn) > 0 {
		briefing.WriteString("\nResultado das tarefas de que você depende:\n")
		for _, dependency := range task.DependsOn {
			fmt.Fprintf(&briefing, "\n[%s]\n%s\n", dependency, truncate(upstream[dependency], 4000))
		}
	}
	briefing.WriteString("\nAo terminar, responda com o resultado — o que você fez e o que a próxima " +
		"tarefa precisa saber. Se você NÃO conseguir decidir algo sozinho, escreva " +
		"exatamente ESCALAR: <a pergunta> e pare.")

	messages := []modelrouter.ChatMessage{
		{Role: "system", Content: definition.System},
	}
	if contract := s.toolContract(definition); contract != "" {
		messages = append(messages, modelrouter.ChatMessage{Role: "system", Content: contract})
	}
	messages = append(messages, modelrouter.ChatMessage{Role: "user", Content: briefing.String()})

	for round := 0; round < workerMaxRounds; round++ {
		if err := ctx.Err(); err != nil {
			done.Error = "cancelado"
			return done
		}
		_ = s.emit(sessionID, turn, protocol.KindTaskProgress, actor, protocol.TaskProgress{
			TaskID:   task.ID,
			WorkerID: workerID,
			Note:     fmt.Sprintf("rodada %d", round+1),
			Fraction: float64(round) / float64(workerMaxRounds),
		})

		answer, _, err := s.runModel(ctx, sessionID, turn, actor, entry.Model.ID, messages)
		if err != nil {
			done.Error = err.Error()
			return done
		}

		if question, escalated := escalation(answer); escalated {
			_ = s.emit(sessionID, turn, protocol.KindEscalate, actor, protocol.Escalate{
				TaskID:   task.ID,
				WorkerID: workerID,
				Question: question,
			})
			// Escalar NÃO é falha: é o trabalhador se recusando a adivinhar. O
			// orquestrador (ou a pessoa) responde, e o plano segue.
			done.OK = false
			done.Error = "escalado: " + question
			return done
		}

		calls := parseToolCalls(answer)
		if len(calls) == 0 {
			done.OK = true
			done.Result = stripToolBlocks(answer)
			return done
		}

		messages = append(messages, modelrouter.ChatMessage{Role: "assistant", Content: answer})
		toolResults := make([]string, 0, len(calls))
		for _, call := range calls {
			toolResults = append(toolResults, s.executeTool(ctx, sessionID, turn, actor, definition, call))
		}
		messages = append(messages, modelrouter.ChatMessage{
			Role:    "user",
			Content: "Resultado das ferramentas:\n\n" + strings.Join(toolResults, "\n\n"),
		})
	}

	done.Error = fmt.Sprintf("o trabalhador não concluiu em %d rodadas", workerMaxRounds)
	return done
}

// escalation detecta o pedido de escalação na resposta.
func escalation(answer string) (string, bool) {
	for _, line := range strings.Split(answer, "\n") {
		trimmed := strings.TrimSpace(line)
		if question, found := strings.CutPrefix(trimmed, "ESCALAR:"); found {
			return strings.TrimSpace(question), true
		}
	}
	return "", false
}

// gateTimeout é quanto o portão espera por decisão. Passado isso ele SEGUE — ao
// contrário da aprovação de ferramenta, que recusa. A diferença é o que está em
// jogo: aprovar ferramenta sem ninguém olhando executa algo irreversível;
// continuar um plano apenas gasta tokens, e travar a equipe por dez minutos
// porque uma tarefa de três falhou é pior que seguir com o aviso registrado.
const gateTimeout = 2 * time.Minute

func (s *Supervisor) openGate(
	ctx context.Context,
	sessionID, turn string,
	actor protocol.Actor,
	wave, failures int,
) protocol.GateDecision {
	gateID := s.nextID("g")
	channel := make(chan protocol.Gate, 1)

	s.mu.Lock()
	s.gates[gateID] = channel
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.gates, gateID)
		s.mu.Unlock()
	}()

	_ = s.emit(sessionID, turn, protocol.KindGate, actor, protocol.Gate{
		GateID: gateID,
		Reason: fmt.Sprintf("%d tarefa(s) da onda %d falharam — seguir, refazer ou abortar?", failures, wave),
	})

	timer := time.NewTimer(gateTimeout)
	defer timer.Stop()

	select {
	case decision := <-channel:
		return decision.Decision
	case <-timer.C:
		return protocol.GateProceed
	case <-ctx.Done():
		return protocol.GateAbort
	}
}

/* ------------------------------- worktree ------------------------------- */

type worktreeRef struct {
	path   string
	branch string
}

func (s *Supervisor) createWorktree(ctx context.Context, id string) (worktreeRef, error) {
	raw, err := json.Marshal(map[string]string{"id": id})
	if err != nil {
		return worktreeRef{}, err
	}
	output, err := s.deps.Tools.Call(ctx, "worktree.create", "", raw)
	if err != nil {
		return worktreeRef{}, err
	}
	// A ferramenta devolve texto para o modelo; aqui só precisamos saber que
	// deu certo e guardar o rótulo para o relatório.
	return worktreeRef{path: output, branch: "aibot/" + id}, nil
}

func (s *Supervisor) dropWorktree(id string) {
	raw, err := json.Marshal(map[string]any{"id": id, "force": true})
	if err != nil {
		return
	}
	// Contexto próprio: o descarte precisa acontecer mesmo quando o turno foi
	// cancelado — senão cada cancelamento deixa uma cópia do repositório no
	// disco, e elas se acumulam sem ninguém perceber.
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	_, _ = s.deps.Tools.Call(ctx, "worktree.remove", "", raw)
}
