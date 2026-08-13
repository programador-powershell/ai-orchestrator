/**
 * Execução da equipe — contrata onda a onda e demite ao terminar.
 *
 * O `agentCrew.ts` decide QUEM entra; aqui os agentes são de fato acionados.
 * Duas regras estruturam tudo:
 *
 * - **Onda a onda, paralelo dentro da onda.** Os dois `code` de uma tarefa
 *   média rodam ao mesmo tempo; a revisão só começa quando os DOIS acabam.
 *   Liberar a revisão no primeiro que termina revisaria metade do trabalho.
 * - **Contratado aparece, demitido é marcado.** Cada entrada e cada saída vira
 *   um evento, e é isso que faz o nó surgir na tela e a linha aparecer na
 *   barra lateral no momento certo — não um plano desenhado de antemão.
 *
 * Cada papel recebe o objetivo e o que as ondas anteriores produziram; nunca a
 * conversa dos outros agentes. É o mesmo isolamento de contexto do
 * acionamento livre, e pela mesma razão: contexto pequeno é o que mantém a
 * execução barata e reproduzível.
 *
 * Coberto por agentCrewRun.test.ts.
 */

import {
  planCrew,
  roleStageLabel,
  ROLE_STAGE,
  type CrewMember,
  type CrewPlan,
  type CrewRole,
  type CrewSlot,
  type ComplexityVerdict,
  type ModelsByRole
} from "./agentCrew";
import { runWithLimit } from "./pool";
import type { StageId } from "./specKit";

export interface CrewHooks {
  /** Agente entrou: a UI cria o nó e a linha na barra lateral. */
  onHire: (member: CrewMember) => void;
  /** Progresso do agente (texto parcial). */
  onActivity: (id: string, activity: string) => void;
  /** Agente saiu — com o que ele produziu, ou o motivo da falha. */
  onFire: (id: string, status: CrewMember["status"], output: string) => void;
  /** Onda inteira concluída; entrega o que ela produziu. */
  onWave?: (wave: number, outputs: string[]) => void;
}

/** Uma chamada de modelo. Injetada para o teste não tocar a rede. */
export type CrewCall = (input: {
  member: CrewMember;
  system: string;
  user: string;
  signal: AbortSignal;
}) => Promise<string>;

export interface CrewRunOptions {
  goal: string;
  /** Correções que a pessoa escreveu no prompt depois da primeira volta. */
  corrections?: string;
  models: ModelsByRole;
  call: CrewCall;
  hooks: CrewHooks;
  signal: AbortSignal;
  /** Complexidade forçada pela pessoa; ausente = classificada pelo objetivo. */
  verdict?: ComplexityVerdict;
  now?: () => number;
  /** Teto de agentes simultâneos dentro de uma onda. */
  maxParallel?: number;
}

export interface CrewRunResult {
  plan: CrewPlan;
  crew: CrewMember[];
  /** Entregas por papel, na ordem em que as ondas terminaram. */
  outputs: Array<{ role: CrewRole; stage: StageId | null; text: string }>;
  cancelled: boolean;
}

const SYSTEM_BASE = [
  "Você faz parte de uma equipe de agentes com papéis fixos.",
  "Responda APENAS com a entrega do seu papel — sem saudação, sem plano de ação, sem perguntar.",
  "Se faltar informação, assuma o mais razoável e declare a suposição em uma linha."
].join(" ");

const ROLE_BRIEF: Record<CrewRole, string> = {
  idea: "Escreva a CONSTITUIÇÃO: os princípios inegociáveis que valem para todas as etapas seguintes (padrões, limites, o que não pode ser tocado). Não escolha tecnologia.",
  scope:
    "Escreva a ESPECIFICAÇÃO: o QUE será construído e por quê, com critérios de aceite verificáveis. Não escolha tecnologia nem escreva código.",
  plan: "Escreva o PLANO TÉCNICO: arquitetura, arquivos afetados, decisões e riscos. Ainda sem escrever código final.",
  code: "Execute a sua fatia das TAREFAS e entregue o resultado (código ou mudança concreta), com o caminho de cada arquivo.",
  review:
    "REVISE as entregas anteriores contra a constituição e os critérios de aceite. Aponte defeitos concretos; se estiver correto, diga o que verificou.",
  ci: "Descreva os passos de INTEGRAÇÃO (build, testes, publicação) que a esteira deve rodar para esta entrega."
};

/**
 * Fatia o trabalho entre os programadores da mesma onda.
 *
 * Sem isso, dois `code` em paralelo receberiam a mesma instrução e
 * entregariam a mesma coisa duas vezes — paralelo que só dobra o custo.
 */
function coderBrief(index: number, total: number): string {
  if (total <= 1) return "";
  return ` Você é o programador ${index + 1} de ${total}: pegue a ${
    index + 1
  }ª fatia das tarefas do plano e NÃO faça as fatias dos outros.`;
}

export async function runCrew(options: CrewRunOptions): Promise<CrewRunResult> {
  const now = options.now ?? (() => Date.now());
  const plan = planCrew(options.verdict ?? options.goal, options.models);
  const crew: CrewMember[] = [];
  const outputs: CrewRunResult["outputs"] = [];

  const ondas = [...new Set(plan.slots.map((slot) => slot.wave))].sort((a, b) => a - b);

  for (const onda of ondas) {
    if (options.signal.aborted) break;
    const doTurno = plan.slots.filter((slot) => slot.wave === onda);
    const tarefas = doTurno.map((slot, index) => () => runSlot(slot, index, doTurno.length));
    const resultados = await runWithLimit(tarefas, options.maxParallel ?? 4);

    const daOnda: string[] = [];
    for (let i = 0; i < resultados.length; i += 1) {
      const resultado = resultados[i];
      if (resultado.ok && typeof resultado.value === "string") {
        daOnda.push(resultado.value);
        outputs.push({
          role: doTurno[i].role,
          stage: ROLE_STAGE[doTurno[i].role],
          text: resultado.value
        });
      }
    }
    options.hooks.onWave?.(onda, daOnda);

    // Onda inteira falhou: seguir para a próxima só produziria entregas
    // construídas sobre o vazio.
    if (daOnda.length === 0 && doTurno.length > 0) break;
  }

  return { plan, crew, outputs, cancelled: options.signal.aborted };

  async function runSlot(slot: CrewSlot, index: number, total: number): Promise<string> {
    const member: CrewMember = {
      ...slot,
      status: "hired",
      activity: roleStageLabel(slot.role),
      startedAt: now()
    };
    crew.push(member);
    options.hooks.onHire(member);

    if (options.signal.aborted) {
      finish(member, "cancelled", "");
      return "";
    }

    member.status = "working";
    options.hooks.onActivity(member.id, roleStageLabel(slot.role));

    const anteriores = outputs
      .map((entry) => `### ${roleStageLabel(entry.role)}\n${entry.text}`)
      .join("\n\n");
    const system = `${SYSTEM_BASE}\n\nSeu papel: ${ROLE_BRIEF[slot.role]}${
      slot.role === "code" ? coderBrief(index, total) : ""
    }`;
    const partes = [`OBJETIVO:\n${options.goal.trim()}`];
    if (options.corrections?.trim()) partes.push(`CORREÇÕES DA PESSOA:\n${options.corrections.trim()}`);
    if (anteriores) partes.push(`ENTREGAS ANTERIORES:\n${anteriores}`);

    try {
      const text = await options.call({
        member,
        system,
        user: partes.join("\n\n"),
        signal: options.signal
      });
      const limpo = text.trim();
      finish(member, limpo ? "done" : "failed", limpo || "o agente não devolveu conteúdo");
      return limpo;
    } catch (cause) {
      const motivo = cause instanceof Error ? cause.message : String(cause);
      finish(member, options.signal.aborted ? "cancelled" : "failed", motivo);
      throw cause;
    }
  }

  function finish(member: CrewMember, status: CrewMember["status"], output: string) {
    member.status = status;
    member.finishedAt = now();
    member.activity = "";
    options.hooks.onFire(member.id, status, output);
  }
}
