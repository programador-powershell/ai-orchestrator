/**
 * Auto-compact de contexto — em conversas longas, resume as mensagens antigas
 * para não estourar a janela do modelo (e não cortar cego). O app faz isso
 * automaticamente e apenas AVISA o usuário ("contexto compactado"), sem pedir
 * confirmação. A decisão do que compactar é pura e testável aqui; o resumo em
 * si é um turno do modelo, feito por quem chama.
 */
export interface CompactMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

const CHARS_PER_TOKEN = 4;

/** Estimativa grosseira de tokens (~4 chars/token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function totalTokens(messages: CompactMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(message.content), 0);
}

export interface CompactionOptions {
  /** Orçamento de tokens acima do qual compacta. */
  maxTokens: number;
  /** Quantas mensagens recentes preservar intactas. */
  keepRecent: number;
}

export interface CompactionPlan {
  /** Mensagens antigas a resumir (nunca inclui system). */
  toSummarize: CompactMessage[];
  /** Mensagens recentes mantidas intactas. */
  keep: CompactMessage[];
}

/**
 * Decide se e como compactar. Retorna null se está dentro do orçamento ou se
 * não sobra nada resumível (as recentes já cobrem tudo, ou só há system).
 */
export function planCompaction(messages: CompactMessage[], options: CompactionOptions): CompactionPlan | null {
  if (totalTokens(messages) <= options.maxTokens) return null;
  const keep = messages.slice(-options.keepRecent);
  const older = messages.slice(0, Math.max(0, messages.length - options.keepRecent));
  const toSummarize = older.filter((message) => message.role !== "system");
  if (!toSummarize.length) return null;
  return { toSummarize, keep };
}

/** Aviso mostrado na conversa quando o contexto é compactado. */
export function compactionNotice(count: number): string {
  return `🗜️ Contexto compactado: ${count} mensage${count === 1 ? "m antiga foi resumida" : "ns antigas foram resumidas"} para caber na janela do modelo.`;
}

/** Monta o pedido de resumo das mensagens antigas para o modelo. */
export function buildSummaryRequest(toSummarize: CompactMessage[]): CompactMessage[] {
  const transcript = toSummarize.map((message) => `${message.role}: ${message.content}`).join("\n\n");
  return [
    {
      role: "user",
      content:
        "Resuma a conversa abaixo em até 8 linhas, preservando decisões, fatos e pendências " +
        "importantes (não invente). O resumo substituirá as mensagens originais.\n\n" +
        transcript
    }
  ];
}
