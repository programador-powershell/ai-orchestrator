/**
 * Utilitários puros do modo Chat — métricas reais por mensagem, busca
 * acento/caixa-insensível no histórico persistido e payloads de
 * regenerar/editar. Sem React, sem store: 100% testável em vitest.
 */

export interface ChatLikeMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/** Contagem real de palavras (sequências não-brancas). */
export function wordCount(text: string): number {
  const matches = text.match(/\S+/g);
  return matches ? matches.length : 0;
}

/** Contagem real de caracteres por code point (emoji conta 1). */
export function charCount(text: string): number {
  return Array.from(text).length;
}

/** Duração legível em pt-BR: "0,9 s", "12,3 s", "1 min 5 s". */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, ms) / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1).replace(".", ",")} s`;
  let minutes = Math.floor(totalSeconds / 60);
  let seconds = Math.round(totalSeconds % 60);
  if (seconds === 60) {
    minutes += 1;
    seconds = 0;
  }
  return `${minutes} min ${seconds} s`;
}

const COMBINING_MARKS = /[\u0300-\u036f]/g;

interface FoldedText {
  /** Texto minúsculo e sem acentos. */
  text: string;
  /** map[i] = índice no texto original do i-ésimo caractere dobrado. */
  map: number[];
}

/**
 * Dobra o texto (minúsculas + sem diacríticos) mantendo o mapa de índices.
 *
 * Percorre caractere a caractere porque o MAPA exige isso: para destacar o
 * trecho encontrado é preciso saber de qual posição do texto original veio
 * cada posição do texto dobrado, e uma normalização em bloco perde essa
 * correspondência (um caractere acentuado vira dois e volta a virar um).
 *
 * É caro — uma chamada a `normalize` por caractere. Só use quando o mapa for
 * necessário de verdade; para comparar texto, `normalizeSearchText` faz o
 * mesmo em bloco e é ~20x mais rápido.
 */
function foldText(source: string): FoldedText {
  let text = "";
  const map: number[] = [];
  let index = 0;
  for (const char of source) {
    const folded = char.normalize("NFD").replace(COMBINING_MARKS, "").toLowerCase();
    for (const piece of folded) {
      text += piece;
      map.push(index);
    }
    index += char.length;
  }
  return { text, map };
}

/**
 * Normalização usada na busca: minúsculas, sem acentos.
 *
 * Dobra a string INTEIRA de uma vez. Antes isto chamava `foldText` e jogava o
 * mapa fora — pagava a normalização caractere a caractere para descartar
 * justamente a parte que a torna cara. A busca refaz esta conta para cada
 * mensagem de cada conversa a CADA tecla digitada: medido, eram 244 ms por
 * tecla com 50 conversas de 30 mensagens, e 958 ms com 120 conversas.
 * Digitar "deploy" travava a interface por segundos.
 */
export function normalizeSearchText(text: string): string {
  return text.normalize("NFD").replace(COMBINING_MARKS, "").toLowerCase();
}

/**
 * Filtra conversas pelo texto REAL (título ou conteúdo das mensagens),
 * ignorando caixa e acentos. Query vazia devolve a lista intacta.
 */
export function filterConversations<T extends { title: string; messages: ChatLikeMessage[] }>(
  list: T[],
  query: string
): T[] {
  const needle = normalizeSearchText(query.trim());
  if (!needle) return list;
  return list.filter(
    (conversation) =>
      normalizeSearchText(conversation.title).includes(needle) ||
      conversation.messages.some((message) => normalizeSearchText(message.content).includes(needle))
  );
}

/**
 * Trecho original (com acentos) ao redor da primeira ocorrência da query
 * nas mensagens. "" quando não há ocorrência.
 */
export function searchSnippet(messages: ChatLikeMessage[], query: string, radius = 42): string {
  const needle = normalizeSearchText(query.trim());
  if (!needle) return "";
  for (const message of messages) {
    const folded = foldText(message.content);
    const hit = folded.text.indexOf(needle);
    if (hit < 0) continue;
    const start = folded.map[hit];
    const lastMapIndex = hit + needle.length - 1;
    const end = lastMapIndex < folded.map.length ? folded.map[lastMapIndex] + 1 : message.content.length;
    const from = Math.max(0, start - radius);
    const to = Math.min(message.content.length, end + radius);
    const prefix = from > 0 ? "…" : "";
    const suffix = to < message.content.length ? "…" : "";
    return `${prefix}${message.content.slice(from, to).replace(/\s+/g, " ").trim()}${suffix}`;
  }
  return "";
}

export interface ThreadEditPayload<M extends ChatLikeMessage> {
  /** Texto da última pergunta do usuário envolvida na operação. */
  lastUserText: string;
  /** Thread resultante após remover as mensagens da operação. */
  trimmedMessages: M[];
}

/**
 * Regenerar: remove o par pergunta→resposta do fim do thread (a pergunta,
 * a última resposta do assistente e o que vier depois dela) e devolve o
 * texto da pergunta para reenvio. O composer ecoa a pergunta de volta ao
 * thread — por isso ela também sai do trimmed, senão o pedido ao motor
 * conteria a pergunta duplicada. null quando não existe par.
 */
export function buildRegeneratePayload<M extends ChatLikeMessage>(messages: M[]): ThreadEditPayload<M> | null {
  let assistantIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "assistant") {
      assistantIndex = i;
      break;
    }
  }
  if (assistantIndex < 0) return null;
  for (let i = assistantIndex - 1; i >= 0; i -= 1) {
    if (messages[i].role === "user") {
      return { lastUserText: messages[i].content, trimmedMessages: messages.slice(0, i) };
    }
  }
  return null;
}

/**
 * Editar: remove a última pergunta do usuário E tudo que veio depois dela
 * (a resposta do par) e devolve o texto para recarregar no composer.
 * null quando não há mensagem de usuário.
 */
export function buildEditPayload<M extends ChatLikeMessage>(messages: M[]): ThreadEditPayload<M> | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "user") {
      return { lastUserText: messages[i].content, trimmedMessages: messages.slice(0, i) };
    }
  }
  return null;
}
