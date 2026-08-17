/**
 * Fusion de produção — papéis cooperativos SEM sobreposição.
 *
 * Regra de ouro: quem orquestra NUNCA produz o entregável final; quem executa
 * NUNCA planeja nem muda o escopo. Cada aba define a política de divisão:
 *
 *  - security  → política de SALVAGUARDA: o modelo menos restrito ORQUESTRA
 *                (explora hipóteses de ataque, decide escopo); o modelo mais
 *                restrito apenas EXECUTA (implementa correções e entrega).
 *  - code      → política de CUSTO/INTELIGÊNCIA: o modelo mais inteligente
 *                ORQUESTRA (especifica, divide, revisa); o modelo mais barato
 *                apenas EXECUTA (escreve o código conforme a spec).
 *  - demais    → política de CAPACIDADE: orquestrador planeja e integra;
 *                executores produzem.
 *
 * O merge não repete a mesma pergunta para N modelos (sobreposição): o
 * orquestrador DECOMPÕE a tarefa em focos complementares, um por executor.
 * Módulo 100% puro — testável sem rede.
 */
import type { Mode, UiMode } from "@ai-bot/contracts";
import type { ChatMessage } from "./gateway";

export type AnyMode = Mode | UiMode;

export interface RolePolicy {
  /** Identificador da política (exibível na UI/logs). */
  policy: "safeguard" | "cost" | "capability";
  orchestratorRole: string;
  executorRole: string;
}

export function fusionRolePolicy(mode: AnyMode): RolePolicy {
  if (mode === "security") {
    return {
      policy: "safeguard",
      orchestratorRole:
        "Você é o ORQUESTRADOR de segurança (modelo com menos salvaguardas, escolhido para explorar sem autocensura). " +
        "Seu papel: levantar hipóteses de ataque, vetores, abusos e casos de borda que um modelo restrito evitaria mencionar; " +
        "definir o escopo exato do trabalho e os critérios de aceitação. " +
        "PROIBIDO: escrever o entregável final, código de correção ou texto para o usuário — isso é papel do executor.",
      executorRole:
        "Você é o EXECUTOR de segurança (modelo restrito). Seu papel: seguir ESTRITAMENTE o escopo definido pelo orquestrador, " +
        "implementar as verificações/correções e produzir o entregável final, claro e responsável. " +
        "PROIBIDO: ampliar o escopo, adicionar hipóteses novas ou reescrever o plano — se o escopo parecer incompleto, execute o definido e liste a lacuna ao final."
    };
  }
  if (mode === "code") {
    return {
      policy: "cost",
      orchestratorRole:
        "Você é o ARQUITETO (modelo mais inteligente do par). Seu papel: transformar o pedido numa especificação técnica curta e inequívoca — " +
        "interfaces, casos de borda, critérios de aceite e o que NÃO fazer — e depois revisar o diff do executor apontando correções pontuais. " +
        "PROIBIDO: escrever o código de produção você mesmo; especificação e revisão apenas.",
      executorRole:
        "Você é o IMPLEMENTADOR (modelo mais barato do par). Seu papel: escrever o código EXATAMENTE conforme a especificação recebida, sem inventar requisitos, " +
        "sem refatorar fora do escopo e sem decisões de arquitetura próprias. " +
        "PROIBIDO: mudar a spec; dúvidas viram comentário `// DÚVIDA:` no ponto exato."
    };
  }
  return {
    policy: "capability",
    orchestratorRole:
      "Você é o ORQUESTRADOR. Seu papel: planejar a resposta (estrutura, critérios de qualidade, armadilhas) e depois integrar/revisar o material produzido. " +
      "PROIBIDO: produzir o conteúdo final você mesmo na fase de planejamento.",
    executorRole:
      "Você é o EXECUTOR. Seu papel: produzir o conteúdo seguindo o briefing recebido, sem alterar estrutura nem escopo. " +
      "PROIBIDO: replanejar; lacunas do briefing são apontadas ao final, não resolvidas por conta própria."
  };
}

/* ------------------------- orchestrate (par) ------------------------- */

export function buildBriefRequest(mode: AnyMode, question: string): ChatMessage[] {
  const role = fusionRolePolicy(mode);
  return [
    {
      role: "system",
      content:
        `${role.orchestratorRole}\n\n` +
        "Produza AGORA apenas o briefing/especificação (máx. 12 linhas): objetivo, estrutura esperada do entregável, " +
        "critérios de aceite e armadilhas. Não responda a pergunta."
    },
    { role: "user", content: question }
  ];
}

export function buildExecuteFusionRequest(mode: AnyMode, brief: string, history: ChatMessage[]): ChatMessage[] {
  const role = fusionRolePolicy(mode);
  return [
    { role: "system", content: `${role.executorRole}\n\nBriefing do orquestrador (siga à risca):\n${brief}` },
    ...history
  ];
}

export function buildReviewRequest(mode: AnyMode, question: string, draft: string): ChatMessage[] {
  const role = fusionRolePolicy(mode);
  return [
    {
      role: "system",
      content:
        `${role.orchestratorRole}\n\n` +
        "Fase de revisão: você recebeu o rascunho do executor. NÃO reescreva do zero (isso sobreporia o trabalho dele). " +
        "Se estiver conforme a especificação, devolva-o intacto com no máximo ajustes pontuais; " +
        "se houver não-conformidades, corrija SOMENTE os trechos afetados. Devolva apenas o entregável final."
    },
    { role: "user", content: `Pedido original:\n${question}\n\nRascunho do executor:\n${draft}` }
  ];
}

/* --------------------- merge (decompor e integrar) ------------------- */

export function buildDecomposeRequest(mode: AnyMode, question: string, executorCount: number): ChatMessage[] {
  const role = fusionRolePolicy(mode);
  return [
    {
      role: "system",
      content:
        `${role.orchestratorRole}\n\n` +
        `Decomponha a tarefa em EXATAMENTE ${executorCount} focos COMPLEMENTARES e MUTUAMENTE EXCLUSIVOS — ` +
        "cada executor trabalhará em um foco, sem repetir o trabalho dos outros. " +
        'Responda APENAS com um bloco ```json contendo um array de strings (um foco por executor), ' +
        "cada foco descrevendo claramente o recorte e o que fica de fora dele."
    },
    { role: "user", content: question }
  ];
}

/** Extrai os focos do orquestrador; null se malformado (chama o fallback). */
export function parseSubtasks(text: string, expected: number): string[] | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown;
    if (!Array.isArray(parsed)) return null;
    const tasks = parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    if (!tasks.length) return null;
    // Ajusta ao nº de executores: corta excesso; se faltar, o chamador replica o último recorte com aviso.
    return tasks.slice(0, expected);
  } catch {
    return null;
  }
}

/** Fallback determinístico quando o orquestrador não devolve JSON válido. */
export function fallbackSubtasks(question: string, executorCount: number): string[] {
  const lenses = [
    "núcleo da resposta: o essencial, direto e correto",
    "casos de borda, riscos e o que pode dar errado",
    "alternativas, comparações e trade-offs",
    "passos práticos de implementação/verificação"
  ];
  return Array.from({ length: executorCount }, (_, index) => `${question}\n\nSEU FOCO EXCLUSIVO: ${lenses[index % lenses.length]}.`);
}

export function buildSubtaskRequest(mode: AnyMode, question: string, subtask: string, index: number, total: number): ChatMessage[] {
  const role = fusionRolePolicy(mode);
  return [
    {
      role: "system",
      content:
        `${role.executorRole}\n\n` +
        `Você é o executor ${index + 1} de ${total}. Trabalhe SOMENTE no seu foco — os demais focos pertencem a outros executores; ` +
        "não os cubra nem os repita."
    },
    { role: "user", content: `Tarefa geral (contexto):\n${question}\n\nSEU FOCO:\n${subtask}` }
  ];
}

export function buildIntegrateRequest(
  mode: AnyMode,
  question: string,
  parts: Array<{ focus: string; content: string }>
): ChatMessage[] {
  const role = fusionRolePolicy(mode);
  const material = parts
    .map((part, index) => `### Parte ${index + 1} — foco: ${part.focus}\n${part.content}`)
    .join("\n\n");
  return [
    {
      role: "system",
      content:
        `${role.orchestratorRole}\n\n` +
        "Fase de integração: costure as partes num entregável único e coerente. NÃO reescreva o conteúdo das partes " +
        "(cada uma é trabalho exclusivo de um executor) — ordene, ligue, remova apenas redundância acidental de bordas " +
        "e resolva contradições explicitando a resolução. Não mencione o processo."
    },
    { role: "user", content: `Pedido original:\n${question}\n\nPartes produzidas:\n${material}` }
  ];
}
