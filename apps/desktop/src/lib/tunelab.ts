/**
 * Laboratório de dataset do Fine-Tuning — conversores de formato, validação
 * DPO e estimativa de custo. Tudo puro (sem IO), espelhando a semântica do
 * harness no gateway.
 */

export interface ConversionResult {
  jsonl: string;
  converted: number;
  skipped: number;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

const toChatLine = (messages: ChatMessage[]) => JSON.stringify({ messages });

/** Alpaca ({instruction, input?, output}) → chat JSONL (user+assistant). */
export function convertAlpacaJsonl(text: string): ConversionResult {
  const lines: string[] = [];
  let skipped = 0;
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const parsed = JSON.parse(raw) as { instruction?: string; input?: string; output?: string };
      const instruction = parsed.instruction?.trim();
      const output = parsed.output?.trim();
      if (!instruction || !output) {
        skipped += 1;
        continue;
      }
      const input = parsed.input?.trim();
      lines.push(
        toChatLine([
          { role: "user", content: input ? `${instruction}\n\n${input}` : instruction },
          { role: "assistant", content: output }
        ])
      );
    } catch {
      skipped += 1;
    }
  }
  return { jsonl: lines.join("\n"), converted: lines.length, skipped };
}

const SHAREGPT_ROLES: Record<string, ChatMessage["role"]> = {
  system: "system",
  human: "user",
  user: "user",
  gpt: "assistant",
  assistant: "assistant"
};

/** ShareGPT ({conversations: [{from, value}]}) → chat JSONL. */
export function convertShareGptJsonl(text: string): ConversionResult {
  const lines: string[] = [];
  let skipped = 0;
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const parsed = JSON.parse(raw) as { conversations?: Array<{ from?: string; value?: string }> };
      const messages = (parsed.conversations ?? [])
        .map((turn): ChatMessage | null => {
          const role = SHAREGPT_ROLES[turn.from ?? ""];
          const content = turn.value?.trim();
          return role && content ? { role, content } : null;
        })
        .filter((message): message is ChatMessage => message !== null);
      const hasUser = messages.some((message) => message.role === "user");
      const hasAssistant = messages.some((message) => message.role === "assistant");
      if (!hasUser || !hasAssistant) {
        skipped += 1;
        continue;
      }
      lines.push(toChatLine(messages));
    } catch {
      skipped += 1;
    }
  }
  return { jsonl: lines.join("\n"), converted: lines.length, skipped };
}

export interface DpoValidation {
  ok: boolean;
  examples: number;
  issues: string[];
}

/** Formato de preferência da API ({input.messages, preferred/non_preferred_output}). */
export function validateDpoJsonl(jsonl: string): DpoValidation {
  const issues: string[] = [];
  let examples = 0;
  const lines = jsonl.split("\n").filter((line) => line.trim());
  for (const [index, line] of lines.entries()) {
    try {
      const parsed = JSON.parse(line) as {
        input?: { messages?: Array<{ role?: string; content?: string }> };
        preferred_output?: Array<{ content?: string }>;
        non_preferred_output?: Array<{ content?: string }>;
      };
      const hasInput = Boolean(parsed.input?.messages?.some((message) => message.role === "user" && message.content?.trim()));
      const hasPreferred = Boolean(parsed.preferred_output?.some((message) => message.content?.trim()));
      const hasRejected = Boolean(parsed.non_preferred_output?.some((message) => message.content?.trim()));
      if (!hasInput || !hasPreferred || !hasRejected) {
        issues.push(`linha ${index + 1}: precisa de input.messages (user), preferred_output e non_preferred_output`);
        continue;
      }
      examples += 1;
    } catch {
      issues.push(`linha ${index + 1}: JSON inválido`);
    }
  }
  if (examples < 10) issues.push(`a API exige no mínimo 10 exemplos válidos (há ${examples})`);
  return { ok: issues.length === 0, examples, issues };
}

/** USD por 1M de tokens de TREINO — revisar contra a tabela do provedor. */
const TRAINING_PRICE_PER_MTOK: Record<string, number> = {
  "gpt-4o-mini": 3.0,
  "gpt-4.1-mini": 5.0,
  "gpt-4.1": 25.0
};

const CHARS_PER_TOKEN = 4;

export interface CostEstimate {
  tokens: number;
  costUsd: number | null;
}

/** Estimativa pré-upload: ~4 chars/token × épocas × preço de treino. */
export function estimateTrainingCost(jsonl: string, model: string, epochs: number): CostEstimate {
  const tokens = Math.ceil(jsonl.length / CHARS_PER_TOKEN);
  const price = TRAINING_PRICE_PER_MTOK[model];
  if (price === undefined) return { tokens, costUsd: null };
  return { tokens, costUsd: (tokens / 1_000_000) * price * epochs };
}
