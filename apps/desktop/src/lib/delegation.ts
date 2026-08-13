/**
 * A ferramenta `delegate` e os prompts do acionamento de agentes.
 *
 * Separado de `agent.ts` de propósito: lá as ferramentas são folhas (leem um
 * arquivo, rodam um comando). `delegate` é diferente — ela **cria outro
 * agente**, e quem a executa é o runtime da árvore, não o dispatch de
 * ferramentas. Misturar as duas coisas faria `dispatchTool` precisar conhecer
 * a árvore inteira.
 *
 * Puro: só parsing e montagem de texto. Coberto por delegation.test.ts.
 */
import type { AgentTask, DelegationLimits, TreeState } from "./agentTree";
import { childFailures, childReports, lineage } from "./agentTree";

export const DELEGATE_TOOL = "delegate";

export interface DelegateArgs {
  title: string;
  task: string;
}

/**
 * Valida os argumentos vindos do modelo.
 *
 * `task` precisa ser AUTOCONTIDA porque o subordinado não recebe o histórico
 * do superior — é justamente isso que mantém o contexto de cada um focado.
 * Uma instrução do tipo "continue o que eu falei" chegaria sem referente.
 */
export function parseDelegateArgs(args: Record<string, unknown>): DelegateArgs | { error: string } {
  const title = typeof args.title === "string" ? args.title.trim() : "";
  const task = typeof args.task === "string" ? args.task.trim() : "";
  if (!task) {
    return { error: "argumento \"task\" é obrigatório e deve descrever a subtarefa por completo" };
  }
  if (task.length < 12) {
    return {
      error:
        "a subtarefa está curta demais para ser executada por outro agente — descreva o objetivo, o contexto necessário e o formato esperado da resposta"
    };
  }
  if (task.length > 8_000) {
    return { error: "a subtarefa excede 8.000 caracteres" };
  }
  return { title: title.slice(0, 80), task };
}

/**
 * Instrução que ensina o agente a DIVIDIR — e, principalmente, quando não
 * dividir. Sem a segunda metade o modelo delega por reflexo e cada subtarefa
 * trivial vira uma chamada paga a mais.
 */
export function delegationInstruction(limits: DelegationLimits, depth: number): string {
  const restante = Math.max(0, limits.maxDepth - depth);
  if (restante === 0) {
    return (
      "Você está no último nível de delegação permitido: NÃO pode acionar outros agentes. " +
      "Execute a tarefa você mesmo e responda com o resultado."
    );
  }
  return (
    `Você pode ACIONAR outros agentes para partes independentes do trabalho, com a ferramenta "${DELEGATE_TOOL}":\n` +
    `- ${DELEGATE_TOOL}: aciona um agente subordinado para uma subtarefa. ` +
    'args: {"title":"rótulo curto","task":"instrução COMPLETA e autocontida"}\n' +
    "O subordinado NÃO vê esta conversa: escreva a instrução como se ele não soubesse de nada — " +
    "objetivo, contexto necessário e o formato de resposta esperado.\n" +
    `Pode acionar até ${limits.maxChildren} agentes e descer mais ${restante} nível(is).\n` +
    "Delegue apenas quando a parte for substancial e independente. Tarefa pequena, ou que depende do que " +
    "você acabou de descobrir, sai mais rápido e mais barato se você fizer direto. " +
    "Depois de acionar, PARE e aguarde os relatórios; eles voltam como mensagem."
  );
}

/** Prompt de sistema do agente RAIZ. */
export function rootSystemPrompt(goal: string, limits: DelegationLimits): string {
  return (
    "Você é o agente responsável por atingir o objetivo abaixo. Planeje, execute e responda com o " +
    "resultado final — não com um plano do que faria.\n\n" +
    `OBJETIVO: ${goal}\n\n` +
    delegationInstruction(limits, 0)
  );
}

/**
 * Prompt de sistema de um SUBORDINADO.
 *
 * Recebe a linhagem (só os títulos) para saber onde se encaixa, mas não o
 * histórico do superior: contexto próprio é o ponto do acionamento.
 */
export function subordinateSystemPrompt(
  state: TreeState,
  task: AgentTask,
  limits: DelegationLimits
): string {
  const caminho = lineage(state, task.id)
    .map((entry) => entry.title)
    .join(" → ");
  return (
    "Você é um agente subordinado dentro de uma execução maior. Faça SOMENTE a sua tarefa e responda com " +
    "o resultado dela, em texto direto — o seu texto final vira o relatório entregue ao seu superior, " +
    "então não peça confirmação nem descreva o que pretende fazer.\n\n" +
    `POSIÇÃO NA EXECUÇÃO: ${caminho}\n` +
    `SUA TAREFA: ${task.prompt}\n\n` +
    delegationInstruction(limits, task.depth)
  );
}

/**
 * Mensagem que devolve os relatórios ao superior.
 *
 * Sucesso e falha vêm SEPARADOS: misturar faria o superior tratar "o
 * provedor caiu" como se fosse um achado da investigação.
 */
export function reportsMessage(state: TreeState, parentId: string): string {
  const ok = childReports(state, parentId);
  const bad = childFailures(state, parentId);
  const partes: string[] = [];
  if (ok.length) {
    partes.push(
      "Relatórios dos agentes que você acionou:\n\n" +
        ok.map((item) => `### ${item.title}\n${item.report}`).join("\n\n")
    );
  }
  if (bad.length) {
    partes.push(
      "As subtarefas a seguir NÃO foram concluídas — considere isso como informação ausente, não como " +
        "resultado:\n" +
        bad.map((item) => `- ${item.title}: ${item.reason}`).join("\n")
    );
  }
  if (!partes.length) {
    return "Nenhum agente subordinado devolveu resultado. Conclua a tarefa você mesmo.";
  }
  partes.push("Sintetize o resultado final da SUA tarefa a partir disso. Não delegue de novo o que já foi feito.");
  return partes.join("\n\n");
}

/** Rótulo curto da árvore para o cabeçalho da execução. */
export function goalTitle(goal: string): string {
  const clean = goal.trim().replace(/\s+/g, " ");
  return clean.length > 60 ? `${clean.slice(0, 57)}…` : clean || "Objetivo";
}
