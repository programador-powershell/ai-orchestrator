/**
 * Personas — assistentes salvos com prompt de sistema próprio (equivalente aos
 * GPTs). Cada persona pode fixar o modo da UI em que costuma ser usada.
 * Validação e normalização são puras; a persistência fica com quem chama.
 */
import { UI_MODES, type UiMode } from "@ai-orchestrator/contracts";
import type { ChatMessage } from "./gateway";

export interface Persona {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  mode?: UiMode;
}

/** Entrada crua do formulário: id opcional, modo ainda não validado. */
export interface PersonaInput {
  id?: string;
  name?: string;
  description?: string;
  systemPrompt?: string;
  mode?: string;
}

export const PERSONA_NAME_MAX = 40;
export const PERSONA_PROMPT_MAX = 4000;

const COMBINING_MARKS = /[̀-ͯ]/g;

/** Slug estável usado como id quando o formulário não informa um. */
export function personaId(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "persona";
}

export interface PersonaValidation {
  ok: boolean;
  issues: string[];
  /** Persona normalizada — presente apenas quando não há problemas. */
  persona?: Persona;
}

export function validatePersona(input: PersonaInput): PersonaValidation {
  const name = (input.name ?? "").trim();
  const systemPrompt = (input.systemPrompt ?? "").trim();
  const description = (input.description ?? "").trim();
  const mode = (input.mode ?? "").trim();
  const issues: string[] = [];

  if (!name) issues.push("Informe um nome para a persona.");
  else if (name.length > PERSONA_NAME_MAX) {
    issues.push(`O nome deve ter no máximo ${PERSONA_NAME_MAX} caracteres (tem ${name.length}).`);
  }

  if (!systemPrompt) issues.push("Informe as instruções (prompt de sistema) da persona.");
  else if (systemPrompt.length > PERSONA_PROMPT_MAX) {
    issues.push(
      `As instruções devem ter no máximo ${PERSONA_PROMPT_MAX} caracteres (tem ${systemPrompt.length}).`
    );
  }

  if (mode && !(UI_MODES as readonly string[]).includes(mode)) {
    issues.push(`Modo desconhecido: ${mode}.`);
  }

  if (issues.length) return { ok: false, issues };

  return {
    ok: true,
    issues,
    persona: {
      id: personaId(input.id?.trim() || name),
      name,
      description,
      systemPrompt,
      ...(mode ? { mode: mode as UiMode } : {})
    }
  };
}

/** Prompt da persona como mensagem de sistema do turno. */
export function personaSystemMessage(persona: Persona): ChatMessage {
  const header = persona.description
    ? `Você está atuando como "${persona.name}" (${persona.description}).`
    : `Você está atuando como "${persona.name}".`;
  return { role: "system", content: `${header}\n\n${persona.systemPrompt}` };
}

export const DEFAULT_PERSONAS: Persona[] = [
  {
    id: "revisor-de-codigo",
    name: "Revisor de código",
    description: "Revisa diffs e PRs apontando risco antes de estilo",
    mode: "code",
    systemPrompt:
      "Você é um revisor de código sênior. Analise o trecho recebido e responda em três blocos: " +
      "Bugs e riscos (correção, concorrência, tratamento de erro, segurança), Manutenibilidade " +
      "(duplicação, acoplamento, nomes) e Testes (o que falta cobrir). Cite o arquivo e a linha " +
      "de cada apontamento, classifique como bloqueante ou sugestão e proponha o código corrigido. " +
      "Não comente formatação que o linter já resolve. Se faltar contexto, diga o que precisa ver."
  },
  {
    id: "analista-de-dados",
    name: "Analista de dados",
    description: "Traduz perguntas de negócio em consultas e leitura de números",
    mode: "data",
    systemPrompt:
      "Você é analista de dados. Antes de responder, deixe explícitas as premissas (período, " +
      "granularidade, filtros) e confirme o que for ambíguo. Ao escrever SQL, use CTEs nomeadas, " +
      "evite SELECT *, e explique o que cada etapa faz. Ao interpretar resultados, separe o que o " +
      "dado mostra do que é hipótese, aponte limitações da amostra e nunca invente números que não " +
      "estejam na fonte."
  },
  {
    id: "redator-tecnico",
    name: "Redator técnico",
    description: "Escreve documentação e comunicados internos claros",
    mode: "work",
    systemPrompt:
      "Você é redator técnico. Escreva em português do Brasil, na voz ativa, frases curtas e sem " +
      "jargão desnecessário. Comece pelo que o leitor precisa fazer, depois o porquê e só então os " +
      "detalhes. Use listas e tabelas quando organizarem melhor a informação, e títulos que " +
      "descrevam conteúdo. Marque como [confirmar] qualquer informação que você não tenha recebido " +
      "em vez de preencher com suposição."
  }
];
