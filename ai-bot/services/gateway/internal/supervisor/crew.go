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
	"aibot/gateway/internal/permissions"
	"aibot/gateway/internal/protocol"
	"aibot/gateway/internal/specialist"
	"aibot/gateway/internal/worktree"
)

// workerMaxRounds limita o vaivém de UM trabalhador.
const workerMaxRounds = 6

// maxWaveAttempts é quantas vezes uma onda pode ser executada — a primeira mais
// os "refazer" do portão. Sem teto, um modelo que responde `retry` toda vez
// (ou dois cliques por engano) prende a equipe num laço que só o cancelamento
// interrompe.
const maxWaveAttempts = 3

/* ---------------------------- teto da árvore ----------------------------- */

// Uma equipe pode montar OUTRA equipe: o especialista `agent` tem `task.dispatch`
// no catálogo, e um trabalhador é um especialista rodando com as ferramentas
// dele. Sem teto isso é recursão com fan-out, e cada nível multiplica por até
// 128 tarefas — o custo explode antes de qualquer pessoa perceber, porque nada
// no caminho parece errado.
//
// Os tetos não são constantes novas: são os três campos que a política JÁ
// declarava, que o administrador já podia configurar por JSON e que nenhuma
// linha do gateway lia. Limite que se configura e não se aplica é pior que
// limite nenhum — quem o configurou passa a acreditar que está protegido.
type crewDepthKey struct{}

type crewBudgetKey struct{}

// crewBudget conta os trabalhadores do TURNO INTEIRO, sub-equipes inclusive. É
// compartilhado por ponteiro justamente para que a árvore não ganhe orçamento
// novo a cada galho.
type crewBudget struct {
	mu      sync.Mutex
	spawned int
}

func (b *crewBudget) take(count, limit int) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if limit > 0 && b.spawned+count > limit {
		return fmt.Errorf("este turno já usou %d trabalhador(es) e o teto da política é %d — "+
			"junte tarefas ou resolva o que falta sem montar outra equipe", b.spawned, limit)
	}
	b.spawned += count
	return nil
}

func withCrewBudget(ctx context.Context) context.Context {
	return context.WithValue(ctx, crewBudgetKey{}, &crewBudget{})
}

// crewBudgetOf devolve o orçamento do turno. Sem orçamento no contexto — uma
// ferramenta chamada fora de um turno — devolve um novo: degradar para "sem teto
// compartilhado" é melhor que estourar nil, e o teto de PROFUNDIDADE, que é o
// que segura a recursão, continua valendo.
func crewBudgetOf(ctx context.Context) *crewBudget {
	if budget, ok := ctx.Value(crewBudgetKey{}).(*crewBudget); ok && budget != nil {
		return budget
	}
	return &crewBudget{}
}

func crewDepthOf(ctx context.Context) int {
	depth, _ := ctx.Value(crewDepthKey{}).(int)
	return depth
}

func withCrewDepth(ctx context.Context, depth int) context.Context {
	return context.WithValue(ctx, crewDepthKey{}, depth)
}

// crewPolicy lê os tetos da política com piso para o que veio zerado.
//
// Zero é "não configurado", não "proibido tudo": uma política parcial vinda do
// servidor do administrador não pode desligar a equipe inteira em silêncio. E o
// paralelismo ainda passa pelo teto do planejador, senão um `maxChildren` alto
// demais faria `PlanTasks` recusar o plano com erro de validação em vez de
// simplesmente montar ondas menores.
func (s *Supervisor) crewPolicy() permissions.Policy {
	policy := permissions.DefaultPolicy()
	if s.deps.Gate != nil {
		configured := s.deps.Gate.Policy()
		if configured.MaxDepth > 0 {
			policy.MaxDepth = configured.MaxDepth
		}
		if configured.MaxChildren > 0 {
			policy.MaxChildren = configured.MaxChildren
		}
		if configured.MaxTotal > 0 {
			policy.MaxTotal = configured.MaxTotal
		}
	}
	if policy.MaxChildren > concurrencyCeil {
		policy.MaxChildren = concurrencyCeil
	}
	return policy
}

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
	policy := s.crewPolicy()

	// A profundidade é conferida ANTES de validar o plano: recusar a geração
	// seguinte custa uma frase, montá-la custa até 128 modelos.
	if depth := crewDepthOf(ctx); depth >= policy.MaxDepth {
		return "", fmt.Errorf("esta equipe já está no nível %d e o teto da política é %d — "+
			"execute estas tarefas você mesmo em vez de montar mais uma equipe", depth+1, policy.MaxDepth)
	}

	if request.MaxConcurrency <= 0 || request.MaxConcurrency > policy.MaxChildren {
		request.MaxConcurrency = policy.MaxChildren
	}
	plan, err := PlanTasks(request.Tasks, request.MaxConcurrency)
	if err != nil {
		// O erro de plano volta como TEXTO para o modelo, não como exceção: ele
		// precisa ler "a tarefa t3 depende de t9, que não existe" para corrigir
		// o próprio plano em vez de reemitir o mesmo grafo quebrado.
		return "", err
	}
	// O orçamento é debitado depois do plano e antes da execução: um plano
	// inválido não deve gastar cota, e um plano válido não pode começar a rodar
	// para só então descobrir que não cabia.
	if err := crewBudgetOf(ctx).take(len(request.Tasks), policy.MaxTotal); err != nil {
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

	// Os trabalhadores nascem um nível ABAIXO desta equipe. É esse número que
	// `toolDispatch` compara com o teto quando um trabalhador `agent` tenta
	// montar a própria equipe.
	policy := s.crewPolicy()
	workerCtx := withCrewDepth(ctx, crewDepthOf(ctx)+1)

	for waveIndex, wave := range plan.Waves {
		if err := ctx.Err(); err != nil {
			return report.String(), err
		}

		// `pending` é quem ainda não produziu resultado nesta onda. Começa com a
		// onda inteira e, num "refazer", encolhe para só os que faltaram.
		pending := wave

		for attempt := 1; ; attempt++ {
			// Slot por posição: a tarefa que o plano citou e não existe deixa o slot
			// zerado, e `TaskID` vazio é como o laço de baixo o reconhece.
			outcomes := make([]protocol.WorkerDone, len(pending))

			var group sync.WaitGroup
			for position, taskID := range pending {
				task, ok := byID[taskID]
				if !ok {
					continue
				}
				// A tentativa entra no id do trabalhador: dois cartões com o mesmo id
				// fariam a tela sobrescrever a primeira tentativa com a segunda, e quem
				// olhasse depois não saberia que houve refação.
				workerID := fmt.Sprintf("w-%d-%s", waveIndex+1, task.ID)
				if attempt > 1 {
					workerID = fmt.Sprintf("%s-r%d", workerID, attempt)
				}

				_ = s.emit(sessionID, turn, protocol.KindTaskDispatch, orchestrator, protocol.TaskDispatch{
					Task:     task,
					WorkerID: workerID,
					Wave:     waveIndex + 1,
				})

				group.Add(1)
				go func(position int, task protocol.Task, workerID string) {
					defer group.Done()
					outcomes[position] = s.runWorker(workerCtx, sessionID, turn, task, workerID, waveIndex+1, results)
				}(position, task, workerID)
			}
			group.Wait()

			// Duas contagens, porque as duas perguntas são diferentes: `failures` é
			// quem ERROU (é o rótulo, o ✗ do relatório e o número que a tela mostra);
			// `escalations` é quem PAROU PARA PERGUNTAR. Nenhuma das duas produziu
			// resultado, e é a soma que decide o portão — ver abaixo.
			failures, escalations := 0, 0
			unfinished := make([]string, 0, len(pending))
			for _, entry := range outcomes {
				if entry.TaskID == "" {
					continue
				}
				_ = s.emit(sessionID, turn, protocol.KindWorkerDone, orchestrator, entry)
				if entry.OK {
					results[entry.TaskID] = entry.Result
					fmt.Fprintf(&report, "✓ %s: %s\n", entry.TaskID, truncate(entry.Result, 400))
					continue
				}
				unfinished = append(unfinished, entry.TaskID)
				// Escalação sai do relatório com marca própria e fora de `failures`: quem
				// lê o relatório (o modelo orquestrador, na volta) precisa distinguir a
				// tarefa que não deu certo da que está esperando resposta, senão ele
				// tenta refazer o trabalho em vez de responder a pergunta. A marca é
				// escrita por extenso porque o modelo não recebe legenda de glifo.
				if entry.Escalated {
					escalations++
					fmt.Fprintf(&report, "↑ %s (escalou e espera resposta): %s\n", entry.TaskID, entry.Error)
					continue
				}
				failures++
				fmt.Fprintf(&report, "✗ %s: %s\n", entry.TaskID, entry.Error)
			}

			// Portão entre ondas: a onda que deixou tarefa SEM RESULTADO não segue em
			// silêncio, porque as seguintes dependem do que ela deveria ter produzido.
			//
			// Escalação conta aqui, e só aqui. Ela não é falha — não entra em
			// `failures`, não sai com ✗ e não pinta a tela de vermelho —, mas é
			// igualmente uma tarefa sem resultado: `results` só é escrito no ramo OK,
			// então a dependente receberia o bloco do upstream VAZIO e adivinharia
			// exatamente o que o trabalhador se recusou a adivinhar. O plano terminaria
			// plausível, com metade do trabalho inventado, que é o modo de falha que o
			// cabeçalho deste arquivo existe para impedir. O que muda em relação à falha
			// é o TEXTO do portão, não a pausa.
			if failures+escalations == 0 || waveIndex+1 >= len(plan.Waves) {
				break
			}

			decision := s.openGate(ctx, sessionID, turn, orchestrator, waveIndex+1, failures, escalations)
			fmt.Fprintf(&report, "portão da onda %d: %s\n", waveIndex+1, decision)
			if decision == protocol.GateAbort {
				report.WriteString("execução abortada no portão\n")
				return report.String(), nil
			}
			if decision != protocol.GateRetry {
				break
			}

			// A partir daqui, REFAZER refaz. Antes esta decisão era aceita pela
			// ferramenta, publicada, escrita no relatório — e depois caía no mesmo
			// caminho de `proceed`: a onda nunca era reexecutada e quem clicou seguia
			// para a onda seguinte com a dependência vazia, achando que mandou refazer.
			if attempt >= maxWaveAttempts {
				fmt.Fprintf(&report, "refazer pedido %d vez(es) na onda %d — seguindo com o que há\n",
					attempt, waveIndex+1)
				break
			}
			// Só quem NÃO produziu resultado volta à fila. Reexecutar quem deu certo
			// gastaria modelo de novo e repetiria efeito colateral já aplicado — um
			// commit, um arquivo escrito, uma mensagem enviada.
			if err := crewBudgetOf(ctx).take(len(unfinished), policy.MaxTotal); err != nil {
				fmt.Fprintf(&report, "refazer negado: %v\n", err)
				break
			}
			pending = unfinished
			fmt.Fprintf(&report, "refazendo %d tarefa(s) da onda %d (tentativa %d)\n",
				len(pending), waveIndex+1, attempt+1)
		}
	}

	return report.String(), nil
}

// runWorker executa UMA tarefa.
//
// O `WorkerDone` devolvido é a resposta completa sobre o trabalhador, escalação
// inclusive (campo `Escalated`): é ele que vai para o log e para a tela, e ter um
// segundo canal interno dizendo a mesma coisa criaria duas versões do mesmo fato.
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
	//
	// Sem gerenciador de cópias a tarefa FALHA, em vez de rodar no diretório
	// compartilhado. Rodar sem isolamento é o modo de falha que este arquivo
	// existe para impedir, e ele não avisa: o trabalho sai plausível e metade
	// dele desaparece por cima do do vizinho.
	if task.Worktree {
		worktreeID := crewWorktreeID(turn, task.ID)
		if created, err := s.createWorktree(ctx, worktreeID); err == nil {
			done.Worktree = created.Path
			done.Branch = created.Branch
			defer s.dropWorktree(worktreeID)
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
			// orquestrador (ou a pessoa) responde, e o plano segue. `OK` fica falso
			// porque não há resultado para as dependentes lerem — quem separa uma
			// coisa da outra é o `Escalated`, que segue no evento até a tela.
			done.OK = false
			done.Escalated = true
			done.Error = "escalado: " + question
			return done
		}

		calls := parseToolCalls(answer)

		// O trabalhador JÁ é um bot chamado por outro, e delegar daqui reabriria a
		// árvore que os tetos deste arquivo fecham. O bloco é recusado — mas com
		// instrução, e não em silêncio: o trabalhador que pede ajuda e leva silêncio
		// repete o pedido até acabar as rodadas e a tarefa morre por esgotamento,
		// com "não concluiu em 6 rodadas" no lugar do motivo verdadeiro.
		if len(calls) == 0 && len(parseDelegations(answer)) > 0 {
			messages = append(messages,
				modelrouter.ChatMessage{Role: "assistant", Content: answer},
				modelrouter.ChatMessage{Role: "user", Content: "Dentro de uma equipe não se delega. " +
					"Resolva com as suas próprias ferramentas ou escreva exatamente " +
					"ESCALAR: <a pergunta> e pare."})
			continue
		}

		if len(calls) == 0 {
			done.OK = true
			// stripBlocks, e não stripToolBlocks: a cerca de delegação que o modelo
			// tenha emitido junto com o texto não pode sobrar no resultado. Ela iria
			// para o relatório e para o prompt das tarefas dependentes como se fosse
			// conteúdo — JSON cru servido de contexto para outro modelo.
			done.Result = stripBlocks(answer)
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

// crewWorktreeID compõe o id da cópia isolada de uma tarefa.
//
// O id da TAREFA sozinho não serve, e o motivo é que ele vem do MODELO: modelo
// gera "t1". Duas equipes rodando ao mesmo tempo — duas conversas abertas, ou
// uma sub-equipe ao lado da equipe que a criou — pediriam a mesma cópia, e
// `git worktree add` recusa a segunda porque o diretório e o ramo já existem. A
// tarefa falharia com "não foi possível isolar a tarefa", um erro que não tem
// nada a ver com o trabalho dela e que só aparece quando duas equipes coincidem
// no tempo — o tipo de defeito que não se reproduz na mesa de quem depura.
//
// O turno da equipe é único (`nextID` carimba milissegundo e contador), então
// prefixá-lo basta. O teto de 64 caracteres do `worktree.Manager` continua
// valendo e passa a ser alcançado mais cedo; quando for, o erro é explícito e
// atinge só tarefas que pediram isolamento.
func crewWorktreeID(turn, taskID string) string {
	return turn + "-" + taskID
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

// gateReason descreve a onda para quem vai decidir, separando o que errou do que
// perguntou.
//
// Pura e apartada porque é TEXTO DE DECISÃO: dizer "1 tarefa falhou" quando a
// tarefa fez uma pergunta empurra a pessoa (ou o modelo) para "refazer", que é a
// resposta errada — o que resolve escalação é responder. É o único pedaço deste
// arquivo que dá para testar sem um supervisor de mentira.
func gateReason(wave, failures, escalations int) string {
	switch {
	case escalations == 0:
		return fmt.Sprintf("%d tarefa(s) da onda %d falharam — seguir, refazer ou abortar?",
			failures, wave)
	case failures == 0:
		return fmt.Sprintf("%d tarefa(s) da onda %d escalaram e esperam resposta — seguir, refazer ou abortar?",
			escalations, wave)
	default:
		return fmt.Sprintf("na onda %d, %d tarefa(s) falharam e %d escalaram e esperam resposta — seguir, refazer ou abortar?",
			wave, failures, escalations)
	}
}

func (s *Supervisor) openGate(
	ctx context.Context,
	sessionID, turn string,
	actor protocol.Actor,
	wave, failures, escalations int,
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
		Reason: gateReason(wave, failures, escalations),
	})

	timer := time.NewTimer(gateTimeout)
	defer timer.Stop()

	// O ECO da decisão é o que fecha o cartão — e o que o mantém fechado.
	//
	// A tela fecha o portão na hora, sem esperar resposta, e por isso a falta do
	// eco não aparece enquanto a conversa está aberta. Ela aparece depois: o
	// `gate` gravado no log não tinha decisão nenhuma, então REABRIR a conversa
	// reencenava o pedido e convidava a pessoa a decidir uma onda que terminou
	// faz tempo. Uma segunda janela na mesma sessão também nunca ficava sabendo.
	//
	// O motivo vai junto porque o eco também é o registro de quem decidiu: sem
	// ele, "proceed" por escolha e "proceed" por esgotamento do prazo ficariam
	// idênticos no log.
	echo := func(decision protocol.GateDecision, reason string) protocol.GateDecision {
		_ = s.emit(sessionID, turn, protocol.KindGate, actor, protocol.Gate{
			GateID:   gateID,
			Decision: decision,
			Reason:   reason,
		})
		return decision
	}

	select {
	case decision := <-channel:
		return echo(decision.Decision, "decidido")
	case <-timer.C:
		return echo(protocol.GateProceed, fmt.Sprintf(
			"ninguém decidiu em %s — seguindo com o que há", gateTimeout))
	case <-ctx.Done():
		return echo(protocol.GateAbort, "o turno foi cancelado")
	}
}

/* ------------------------------- worktree ------------------------------- */

// O isolamento fala com o `worktree.Manager` DIRETO, sem passar pelo registro de
// ferramentas.
//
// Passar por lá seria pedir a uma ferramenta desenhada para o modelo um dado
// desenhado para código: `worktree.create` devolve a frase "cópia isolada criada
// em C:\… (ramo aibot/x)", que é o certo para o modelo ler e o errado para
// preencher `WorkerDone.Worktree`, documentado como O CAMINHO da cópia. Quem
// consumisse esse campo — a tela, um `cd`, um diff — receberia uma frase.
//
// A ferramenta continua existindo e continua devolvendo texto: ela é para quando
// o MODELO pede uma cópia. Este caminho é o do supervisor, que não lê texto.
func (s *Supervisor) createWorktree(ctx context.Context, id string) (worktree.Worktree, error) {
	if s.deps.Worktrees == nil {
		return worktree.Worktree{}, errors.New("o gerenciador de cópias isoladas não está disponível")
	}
	// Base vazia é HEAD. O ramo vem do Manager, não montado aqui: o prefixo é
	// dele (worktree.BranchPrefix), e remontá-lo na mão é a duplicata que sai do
	// lugar na primeira vez que o prefixo mudar.
	return s.deps.Worktrees.Create(ctx, id, "")
}

func (s *Supervisor) dropWorktree(id string) {
	if s.deps.Worktrees == nil {
		return
	}
	// Contexto próprio: o descarte precisa acontecer mesmo quando o turno foi
	// cancelado — senão cada cancelamento deixa uma cópia do repositório no
	// disco, e elas se acumulam sem ninguém perceber.
	ctx, cancel := context.WithTimeout(context.Background(), worktree.DefaultTimeout)
	defer cancel()
	_ = s.deps.Worktrees.Remove(ctx, id, true)
}
