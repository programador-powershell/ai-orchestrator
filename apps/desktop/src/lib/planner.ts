/**
 * Modo planejamento — disponível em todas as abas.
 * O modelo devolve um plano JSON; o usuário aprova antes de executar.
 */
import type { ExecutionPlan, Mode, PlanStep, UiMode } from "@orchestrator/contracts";
import type { ChatMessage } from "./gateway";

const modeGoal: Record<string, string> = {
  chat: "responder com pesquisa e raciocínio estruturado",
  code: "implementar a mudança de código com verificação",
  design: "produzir a direção visual e os componentes",
  data: "modelar o schema e as migrações",
  work: "transformar o objetivo em entregas rastreáveis",
  security: "revisar riscos e propor correções verificáveis",
  agent: "orquestrar os agentes e ferramentas",
  fluxo: "desenhar a automação: gatilho, condições e ações",
  tune: "preparar o dataset e o treino de fine-tuning"
};

export function buildPlanRequest(mode: Mode | UiMode, userText: string): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        `Modo planejamento. Antes de executar, produza um plano para ${modeGoal[mode] ?? "executar a tarefa"}. ` +
        "Responda APENAS com um bloco de código JSON (```json … ```) no formato: " +
        `{"title": string, "summary": string, "steps": [{"title": string, "detail": string}], "risks": string[]}. ` +
        "Entre 3 e 8 passos, cada um verificável. Sem texto fora do bloco JSON."
    },
    { role: "user", content: userText }
  ];
}

/** Extrai e valida o plano do texto do modelo. Puro, testável. */
export function parsePlan(text: string): ExecutionPlan | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as {
      title?: unknown;
      summary?: unknown;
      steps?: Array<{ title?: unknown; detail?: unknown }>;
      risks?: unknown[];
    };
    if (!Array.isArray(parsed.steps) || !parsed.steps.length) return null;
    const steps: PlanStep[] = parsed.steps
      .filter((step) => typeof step?.title === "string")
      .map((step, index) => ({
        id: `step-${index + 1}`,
        title: String(step.title),
        detail: typeof step.detail === "string" ? step.detail : "",
        status: "pending"
      }));
    if (!steps.length) return null;
    return {
      title: typeof parsed.title === "string" ? parsed.title : "Plano de execução",
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      steps,
      risks: Array.isArray(parsed.risks) ? parsed.risks.filter((risk): risk is string => typeof risk === "string") : []
    };
  } catch {
    return null;
  }
}

export function buildExecuteRequest(plan: ExecutionPlan, originalText: string): ChatMessage[] {
  const steps = plan.steps.map((step, index) => `${index + 1}. ${step.title} — ${step.detail}`).join("\n");
  return [
    {
      role: "system",
      content:
        "O usuário aprovou o plano abaixo. Execute-o passo a passo, marcando cada passo concluído com uma linha `✔ Passo N`. Seja objetivo e verifique o resultado de cada passo antes de seguir.\n\n" +
        `Plano aprovado: ${plan.title}\n${steps}`
    },
    { role: "user", content: originalText }
  ];
}
