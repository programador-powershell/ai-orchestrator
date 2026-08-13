/**
 * Montagem do contexto — quem entra no prompt, e o registro disso.
 *
 * O composer juntava oito fontes em `system[]` sem filtro e sem rastro. Aqui
 * elas passam por um lugar só, que faz três coisas: aplica o **modo do
 * harness**, **registra na trilha** cada injeção com a origem, e devolve as
 * mensagens prontas.
 *
 * ## Por que existe um modo mínimo
 *
 * Com oito injeções, uma resposta ruim tem duas explicações possíveis — o
 * modelo é ruim naquilo, ou o nosso contexto atrapalhou — e não havia como
 * separar. O modo mínimo corta as injeções de conveniência e deixa o modelo
 * trabalhar quase cru. Ele é instrumento de medida, não modo de uso.
 *
 * ## A armadilha que ele quase abriu
 *
 * Um modo que "tira as injeções" tiraria também o **prompt master do admin** —
 * e aí o usuário teria descoberto um jeito de escapar da instrução corporativa
 * escolhendo um modo na interface. Isso é exatamente o furo do gating
 * cosmético que a edição gerenciada existe para fechar. Por isso o prompt
 * master é **inegociável**: nenhum modo o remove. O mínimo corta o que é
 * conveniência do usuário, não o que é política da empresa.
 *
 * Módulo puro: sem rede, sem DOM. Coberto por contextAssembly.test.ts.
 */

import type { ChatMessage } from "./gateway";
import { recordContext, type ContextSource, type Trajectory } from "./trajectory";

export type HarnessMode = "standard" | "minimal";

export const HARNESS_MODE_LABEL: Record<HarnessMode, string> = {
  standard: "Padrão",
  minimal: "Mínimo"
};

export const HARNESS_MODE_HINT: Record<HarnessMode, string> = {
  standard: "Todas as fontes de contexto entram no prompt.",
  minimal:
    "Só a política da empresa e a sua mensagem. Serve para descobrir se um resultado ruim é do modelo ou do contexto que injetamos."
};

/**
 * Fontes que NENHUM modo remove.
 *
 * O prompt master é a instrução do admin; deixá-lo cair por escolha de modo na
 * interface devolveria ao usuário o poder de sair da política.
 */
const INEGOCIAVEIS: ContextSource[] = ["prompt-master"];

/** Conveniências do usuário — é o que o modo mínimo corta. */
const CONVENIENCIAS: ContextSource[] = [
  "project-rules",
  "design-contract",
  "memory",
  "ops-catalog",
  "office-context",
  "ship-context",
  "mentions",
  "plugins"
];

export function allowedSources(mode: HarnessMode): ContextSource[] {
  return mode === "minimal" ? [...INEGOCIAVEIS] : [...INEGOCIAVEIS, ...CONVENIENCIAS];
}

export interface Injection {
  source: ContextSource;
  content: string;
}

export interface AssembleOptions {
  mode: HarnessMode;
  trajectory: Trajectory;
  now: number;
}

export interface AssembleResult {
  messages: ChatMessage[];
  trajectory: Trajectory;
  /** Fontes que existiam e o modo barrou — a UI diz o que ficou de fora. */
  skipped: ContextSource[];
}

/**
 * Monta as mensagens de sistema e registra cada uma na trilha.
 *
 * Injeção vazia não vira mensagem nem evento: um bloco em branco no prompt só
 * gasta contexto, e um evento sem conteúdo suja a trilha sem informar nada.
 */
export function assembleContext(candidates: Injection[], options: AssembleOptions): AssembleResult {
  const permitidas = new Set(allowedSources(options.mode));
  const messages: ChatMessage[] = [];
  const skipped: ContextSource[] = [];
  let trajectory = options.trajectory;

  for (const candidate of candidates) {
    const conteudo = candidate.content?.trim();
    if (!conteudo) continue;
    if (!permitidas.has(candidate.source)) {
      if (!skipped.includes(candidate.source)) skipped.push(candidate.source);
      continue;
    }
    messages.push({ role: "system", content: candidate.content });
    trajectory = recordContext(trajectory, candidate.source, candidate.content, options.now);
  }

  return { messages, trajectory, skipped };
}

/**
 * O modo mínimo consegue remover isto?
 *
 * Existe para a UI poder dizer a verdade ao explicar o modo — e para o teste
 * travar a regra: se alguém mover o prompt master para as conveniências, a
 * asserção quebra antes de virar furo.
 */
export function isNegotiable(source: ContextSource): boolean {
  return !INEGOCIAVEIS.includes(source);
}
