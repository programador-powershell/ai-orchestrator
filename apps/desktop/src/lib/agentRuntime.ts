/**
 * Runtime do ACIONAMENTO de agentes — executa a árvore de delegação.
 *
 * O flow builder (dag.ts) executa um grafo desenhado à mão: quem divide o
 * trabalho é o usuário, antes de rodar. Aqui existe um objetivo e um agente
 * raiz, e quem decide dividir é o **modelo**, chamando `delegate` durante a
 * execução. Cada subordinado abre a própria conversa, roda o mesmo loop
 * (podendo delegar de novo até o teto) e devolve um relatório ao superior.
 *
 * Regras que este arquivo faz valer:
 *
 * - **Contexto isolado.** O subordinado recebe a instrução dele e a linhagem,
 *   nunca o histórico do superior. É isso que mantém cada contexto pequeno —
 *   e é a razão de `delegate` exigir instrução autocontida.
 * - **Tetos checados no núcleo.** A recusa volta para o modelo como resultado
 *   de ferramenta, com o motivo, para ele se adaptar em vez de insistir.
 * - **Cancelamento desce a árvore inteira** por um único AbortSignal.
 * - **Ferramentas mutantes continuam pedindo aprovação.** Delegar não é uma
 *   porta lateral para escrever arquivo sem gate: o subordinado passa pelo
 *   mesmo `needsApproval` do superior.
 */
import {
  agentSystemInstruction,
  dispatchTool,
  formatToolResult,
  needsApproval,
  parseToolCalls,
  type ToolCall
} from "./agent";
import {
  canSpawn,
  cancelPending,
  createTree,
  finishTask,
  patchTask,
  spawnTask,
  type AgentTask,
  type DelegationLimits,
  type TreeState
} from "./agentTree";
import {
  DELEGATE_TOOL,
  goalTitle,
  parseDelegateArgs,
  reportsMessage,
  rootSystemPrompt,
  subordinateSystemPrompt
} from "./delegation";
import type { EngineSelection } from "@ai-orchestrator/contracts";
import { recordAgentAction } from "./agentAudit";
import {
  closeSession,
  computerUseInstruction,
  COMPUTER_TOOL_NAMES,
  dispatchComputerTool,
  openSession
} from "./computerUse";
import { codeModeInstruction, runProgram } from "./codeMode";
import { chatOnce, type EngineContext } from "./engine";
import type { ChatMessage } from "./gateway";

/** Voltas de ferramenta por agente — impede um agente de girar sozinho. */
const MAX_TURNS = 8;

export interface RunHooks {
  /** Estado novo da árvore após cada mudança (a UI só reflete). */
  onTree: (state: TreeState) => void;
  /** Aprovação de ferramenta mutante; false cancela a chamada. */
  approve: (task: AgentTask, call: ToolCall) => Promise<boolean>;
  /** Nota de progresso para a barra de status. */
  onStage?: (text: string) => void;
}

export interface RunOptions {
  goal: string;
  selection: EngineSelection;
  ctx: EngineContext;
  limits: DelegationLimits;
  /** Raiz do projeto para as ferramentas de arquivo. */
  root: string;
  signal: AbortSignal;
  hooks: RunHooks;
  /**
   * Liga a área de trabalho isolada (computer use). Desligado por padrão:
   * é a diferença entre um agente que lê e explica e um que executa comando
   * na máquina — quem escolhe é o chamador, não o modelo.
   */
  computerUse?: boolean;
  /**
   * Liga o code mode. Quem abre é a política do grupo; `false` (o padrão)
   * desliga.
   *
   * As ferramentas do programa NÃO vêm daqui de propósito — elas são
   * derivadas da sessão em `codeModeTools()`. Deixar o chamador escolher a
   * lista foi um erro na primeira versão: a view passava as ferramentas de
   * projeto mesmo com a área isolada aberta, então o programa gravava fora do
   * sandbox.
   */
  codeMode?: boolean;
}

/** Roda o objetivo inteiro. Devolve a árvore final. */
export async function runAgentGoal(options: RunOptions): Promise<TreeState> {
  const now = () => Date.now();
  let tree = createTree(goalTitle(options.goal), options.goal, now());
  const publish = () => options.hooks.onTree(tree);
  publish();

  // A sessão isolada nasce e morre COM a execução: o diretório não pode
  // sobreviver ao objetivo que o justificou.
  let session = "";
  if (options.computerUse) {
    try {
      session = (await openSession()).id;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      options.hooks.onStage?.(`sem área isolada: ${message}`);
    }
  }

  const runner = new TreeRunner(options, {
    get: () => tree,
    set: (next) => {
      tree = next;
      publish();
    }
  }, session);

  try {
    const report = await runner.runTask(tree.rootId, rootSystemPrompt(options.goal, options.limits));
    tree = finishTask(tree, tree.rootId, "done", report, now());
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    tree = options.signal.aborted
      ? cancelPending(tree, now())
      : finishTask(tree, tree.rootId, "failed", message, now());
  } finally {
    // Fecha mesmo em erro ou cancelamento — senão o diretório fica no %TEMP%.
    if (session) await closeSession(session).catch(() => undefined);
  }
  publish();
  return tree;
}

interface TreeAccess {
  get: () => TreeState;
  set: (next: TreeState) => void;
}

class TreeRunner {
  constructor(
    private readonly options: RunOptions,
    private readonly tree: TreeAccess,
    /** Id da área isolada; vazio quando computer use está desligado. */
    private readonly session: string
  ) {}

  /**
   * Executa UM agente até ele responder sem chamar ferramenta.
   * Devolve o texto final — que é o relatório entregue ao superior.
   */
  async runTask(taskId: string, systemPrompt: string): Promise<string> {
    const instrucoes = [systemPrompt, agentSystemInstruction()];
    if (this.session) instrucoes.push(computerUseInstruction());
    // Só oferece o code mode quando há ferramenta liberada para ele: descrever
    // um modo que não pode fazer nada gasta contexto e produz programa
    // recusado.
    const codeTools = this.codeModeTools();
    if (codeTools.length) instrucoes.push(codeModeInstruction(codeTools));
    const messages: ChatMessage[] = [
      { role: "system", content: instrucoes.join("\n\n") },
      { role: "user", content: this.tree.get().tasks[taskId]?.prompt ?? "" }
    ];

    for (let turn = 0; turn < MAX_TURNS; turn += 1) {
      if (this.options.signal.aborted) throw new Error("execução interrompida");
      const answer = await this.callModel(taskId, messages);
      messages.push({ role: "assistant", content: answer });

      const calls = parseToolCalls(answer);
      const delegations = calls.filter((call) => call.tool === DELEGATE_TOOL);
      const plain = calls.filter((call) => call.tool !== DELEGATE_TOOL);

      // Sem ferramenta nenhuma: este é o texto final do agente.
      if (!calls.length) {
        this.patch(taskId, { status: "running", output: answer });
        return answer;
      }

      const results: string[] = [];
      for (const call of plain) {
        results.push(await this.runTool(taskId, call));
      }
      if (delegations.length) {
        results.push(await this.runDelegations(taskId, delegations));
      }
      messages.push({ role: "user", content: results.join("\n\n") });
    }

    // Estourou as voltas: o que já existe vale mais que um erro seco.
    const partial = this.tree.get().tasks[taskId]?.output ?? "";
    return (
      partial ||
      `o agente atingiu o limite de ${MAX_TURNS} rodadas de ferramenta sem concluir a tarefa`
    );
  }

  /** Chamada ao modelo com streaming refletido na árvore. */
  private async callModel(taskId: string, messages: ChatMessage[]): Promise<string> {
    this.patch(taskId, { output: "" });
    let buffer = "";
    return chatOnce(
      this.options.selection,
      "agent",
      messages,
      this.options.ctx,
      {
        onDelta: (delta) => {
          buffer += delta;
          this.patch(taskId, { output: buffer });
        },
        onStage: (stage) => this.options.hooks.onStage?.(stage)
      },
      this.options.signal
    );
  }

  /**
   * Code mode: o modelo entrega UM programa que combina várias ferramentas.
   *
   * O ganho é a ida e volta: oito passos deixam de custar oito chamadas de
   * modelo. O programa é interpretado por `codeMode.ts` — não é `eval`, e o
   * interpretador não tem caminho até nada do app.
   *
   * O ponto que NÃO se negocia: cada ferramenta chamada lá dentro passa pelo
   * mesmo `runTool` de uma chamada avulsa, com a mesma aprovação. Se não
   * passasse, escrever um programa seria a forma barata de driblar o gate.
   */
  /**
   * Ferramentas que o programa pode citar — **derivadas da sessão**.
   *
   * Com a área isolada aberta, o programa usa as ferramentas do SANDBOX: elas
   * escrevem no diretório efêmero e a execução nasce dentro do Job Object. Sem
   * ela, usa as do projeto, que é o que o agente já fazia avulso.
   *
   * Misturar as duas seria o pior dos mundos: o usuário liga a área isolada
   * esperando confinamento e o programa grava no projeto real assim mesmo.
   */
  private codeModeTools(): string[] {
    if (!this.options.codeMode) return [];
    if (this.options.computerUse) {
      // Pediu confinamento. Se a sessão NÃO abriu, o programa não recebe
      // ferramenta nenhuma — cair para as do projeto rodaria justamente sem o
      // confinamento que a pessoa ligou, que é o oposto do pedido. Falhar
      // fechado é a única leitura honesta de "ligue a área isolada".
      return this.session ? ["computer_read", "computer_list", "computer_write", "computer_exec"] : [];
    }
    return ["fs_read", "fs_list", "search", "fs_write"];
  }

  private async runCodeProgram(taskId: string, call: ToolCall): Promise<string> {
    const source = typeof call.args.program === "string" ? call.args.program : "";
    if (!source.trim()) return formatToolResult(call, "programa vazio");
    const result = await runProgram(source, {
      allowed: this.codeModeTools(),
      signal: this.options.signal,
      call: async (tool, args) => {
        const saida = await this.runTool(taskId, { tool, args: args as Record<string, unknown> });
        return saida;
      }
    });
    const linhas = [
      result.ok ? "programa concluído" : `programa interrompido: ${result.reason}`,
      `${result.calls.length} chamada(s) de ferramenta`
    ];
    if (result.logs.length) linhas.push(`log:\n${result.logs.join("\n")}`);
    if (result.value !== null) linhas.push(`retorno: ${JSON.stringify(result.value)}`);
    return formatToolResult(call, linhas.join("\n"));
  }

  /** Ferramenta comum — mesma aprovação do resto do app. */
  private async runTool(taskId: string, call: ToolCall): Promise<string> {
    if (call.tool === "run_program") return this.runCodeProgram(taskId, call);
    const task = this.tree.get().tasks[taskId];
    // Execução na estação é a única ação que vira trilha de auditoria: é a
    // que sai do app e toca a máquina de alguém.
    const auditable = call.tool === "computer_exec";
    if (task && needsApproval(call)) {
      const allowed = await this.options.hooks.approve(task, call);
      if (!allowed) {
        // Recusa TAMBÉM é auditada: saber o que a IA tentou rodar e alguém
        // barrou vale tanto quanto saber o que rodou.
        if (auditable) await this.audit(task?.title ?? "", call, false, null, 0, true);
        return formatToolResult(call, "recusada pelo usuário — siga sem esta ferramenta");
      }
    }
    // Computer use vai para a sessão isolada; o dispatch comum não conhece
    // sessão e escreveria na pasta do PROJETO — que é outra coisa.
    const started = performance.now();
    const result = COMPUTER_TOOL_NAMES.has(call.tool)
      ? await dispatchComputerTool(call.tool, call.args, this.session)
      : await dispatchTool(call, this.options.root);
    let aviso = "";
    if (auditable) {
      const outcome = await this.audit(
        task?.title ?? "",
        call,
        true,
        result.ok ? 0 : 1,
        performance.now() - started,
        !result.output.includes("SEM Job Object")
      );
      // Falha de auditoria NÃO derruba a execução, mas também não passa em
      // silêncio: o modelo e o usuário veem que aquela linha não foi gravada.
      if (!outcome.recorded) aviso = `\n\n[auditoria] ${outcome.reason ?? "não registrada"}`;
    }
    return formatToolResult(call, `${result.output}${aviso}`);
  }

  /** Manda a linha para a trilha do gateway. Nunca lança. */
  private audit(
    agent: string,
    call: ToolCall,
    approved: boolean,
    exitCode: number | null,
    durationMs: number,
    jailed: boolean
  ) {
    return recordAgentAction(this.options.ctx.session ?? null, {
      agent,
      goal: this.options.goal,
      command: typeof call.args.command === "string" ? call.args.command : JSON.stringify(call.args),
      approved,
      exitCode,
      durationMs,
      jailed
    });
  }

  /**
   * Aciona os subordinados pedidos nesta volta.
   *
   * Os irmãos rodam EM PARALELO: são independentes por definição (o superior
   * os criou como partes separadas), e serializar dobraria o tempo à toa.
   */
  private async runDelegations(taskId: string, calls: ToolCall[]): Promise<string> {
    const aceitos: Array<{ id: string; prompt: string }> = [];
    const recusas: string[] = [];

    for (const call of calls) {
      const parsed = parseDelegateArgs(call.args);
      if ("error" in parsed) {
        recusas.push(`- ${parsed.error}`);
        continue;
      }
      const check = canSpawn(this.tree.get(), taskId, this.options.limits);
      if (!check.ok) {
        recusas.push(`- "${parsed.title || parsed.task.slice(0, 40)}": ${check.message}`);
        continue;
      }
      const { state, child } = spawnTask(
        this.tree.get(),
        taskId,
        { title: parsed.title, prompt: parsed.task },
        Date.now()
      );
      this.tree.set(state);
      aceitos.push({ id: child.id, prompt: parsed.task });
    }

    await Promise.all(
      aceitos.map(async ({ id }) => {
        const task = this.tree.get().tasks[id];
        if (!task) return;
        try {
          const report = await this.runTask(id, subordinateSystemPrompt(this.tree.get(), task, this.options.limits));
          this.tree.set(finishTask(this.tree.get(), id, "done", report, Date.now()));
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          // Falha de um subordinado NÃO derruba os irmãos nem o superior:
          // ela vira informação ausente no relatório.
          this.tree.set(
            finishTask(
              this.tree.get(),
              id,
              this.options.signal.aborted ? "cancelled" : "failed",
              message,
              Date.now()
            )
          );
        }
      })
    );

    // O pai volta a "running" para a síntese.
    this.patch(taskId, { status: "running" });
    const relatorios = reportsMessage(this.tree.get(), taskId);
    return recusas.length
      ? `${relatorios}\n\nAcionamentos recusados:\n${recusas.join("\n")}`
      : relatorios;
  }

  private patch(taskId: string, patch: Partial<AgentTask>) {
    this.tree.set(patchTask(this.tree.get(), taskId, patch));
  }
}
