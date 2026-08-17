/**
 * Lógica pura de conversas: projetos (pastas), exportação (.md/.json) e
 * busca global entre todas as abas. Sem React e sem store — 100% testável.
 */
import { UI_MODES, type UiMode } from "@orchestrator/contracts";
import { normalizeSearchText, searchSnippet, type ChatLikeMessage } from "./chatUtils";

/** Pasta de organização — global, compartilhada por todas as abas. */
export interface Project {
  id: string;
  name: string;
  createdAt: number;
}

export type ExportMessage = ChatLikeMessage;

/** Forma mínima usada pelas funções puras (a Conversation do store a satisfaz). */
export interface ExportConversation {
  id: string;
  title: string;
  messages: ExportMessage[];
  updatedAt: number;
  projectId?: string;
}

/* ------------------------------- exportar ------------------------------ */

const roleLabels: Record<ExportMessage["role"], string> = {
  user: "Você",
  assistant: "Assistente",
  system: "Sistema"
};

/**
 * Markdown legível: título, papel de cada mensagem e conteúdo verbatim —
 * emitir o conteúdo sem reencaixar preserva as cercas de código originais.
 */
export function toMarkdown(conversation: ExportConversation): string {
  const title = conversation.title.trim() || "Conversa sem título";
  const lines = [`# ${title}`];
  if (Number.isFinite(conversation.updatedAt)) {
    lines.push("", `_Exportado do AI-Orchestrator — atualizado em ${new Date(conversation.updatedAt).toISOString()}_`);
  }
  for (const message of conversation.messages) {
    const content = message.content.trim();
    if (!content) continue;
    lines.push("", `## ${roleLabels[message.role] ?? message.role}`, "", content);
  }
  return `${lines.join("\n")}\n`;
}

/** JSON fiel (inclui metadados das mensagens) para reimportar sem perda. */
export function toJson(conversation: ExportConversation): string {
  return JSON.stringify(conversation, null, 2);
}

const SLUG_MAX = 48;

/** Nome de arquivo seguro derivado do título. */
export function exportFileName(conversation: ExportConversation, extension: "md" | "json"): string {
  const slug = normalizeSearchText(conversation.title)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, "");
  return `${slug || "conversa"}.${extension}`;
}

/* -------------------------------- busca -------------------------------- */

export interface ConversationSearchResult {
  /** Aba de origem — o resultado global precisa dizer de onde veio. */
  mode: UiMode;
  conversationId: string;
  title: string;
  snippet: string;
  matchCount: number;
}

/** Ocorrências não sobrepostas de `needle` em `haystack` (ambos já dobrados). */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * Corpo da conversa já dobrado, memorizado pela IDENTIDADE do array de
 * mensagens.
 *
 * A busca roda a cada tecla e refazia a normalização do histórico inteiro
 * toda vez — texto que não mudou entre uma letra e a seguinte. Medido com
 * 300 conversas de 40 mensagens (~6 MChar): 43 ms por tecla, dos quais 36 ms
 * eram só redobrar. Com a memória, 4 ms.
 *
 * A chave é `messages` e não a conversa: o store troca o array quando uma
 * mensagem entra, então a entrada velha morre sozinha — e o `WeakMap` solta
 * a memória quando a conversa sai da tela. O título fica de fora de
 * propósito: renomear NÃO troca o array de mensagens, e dobrar um título é
 * barato.
 */
const corposDobrados = new WeakMap<ExportMessage[], string>();

function corpoDobrado(messages: ExportMessage[]): string {
  const memorizado = corposDobrados.get(messages);
  if (memorizado !== undefined) return memorizado;
  const dobrado = normalizeSearchText(messages.map((message) => message.content).join("\n"));
  corposDobrados.set(messages, dobrado);
  return dobrado;
}

/**
 * Busca nas conversas, ignorando caixa e acentos. Ordena por relevância
 * (mais ocorrências primeiro) e desempata pela conversa mais recente.
 *
 * `escopo` limita a UMA aba. É o padrão desde que a busca subiu para a barra
 * superior: de lá ela é um campo só, sempre visível, e trazer resultado de
 * outro módulo obrigaria a trocar de aba para abrir — um resultado que a
 * pessoa não pediu, num lugar que ela não estava olhando. Sem `escopo`, varre
 * tudo (é o que a exportação e os testes usam).
 *
 * `limite` corta ANTES de montar os trechos. Quem chama mostra oito linhas e
 * jogava fora o resto — mas o trecho é a parte cara da busca (`searchSnippet`
 * dobra caractere a caractere para saber onde o acerto cai no texto ORIGINAL,
 * e varre mensagem por mensagem até achar). Com 300 conversas em que o termo
 * só aparece na última mensagem, montar 300 trechos para exibir 8 custava
 * 472 ms; recortando antes, oito. Sem `limite` o comportamento é o de antes.
 */
export function searchConversations(
  all: Partial<Record<UiMode, ExportConversation[]>>,
  query: string,
  escopo?: UiMode,
  limite?: number
): ConversationSearchResult[] {
  const needle = normalizeSearchText(query.trim());
  if (!needle) return [];
  /*
   * O corpo vira UMA string por conversa, unida por "\n". Duas ocorrências
   * coladas por essa junção só existiriam se o termo contivesse "\n" — o
   * campo é um `<input>`, que não aceita quebra de linha. Chamada por
   * programa com termo multilinha cai na contagem por mensagem, que é exata.
   */
  const termoTemQuebra = needle.includes("\n");
  const parciais: Array<{
    mode: UiMode;
    conversation: ExportConversation;
    matchCount: number;
  }> = [];
  for (const mode of escopo ? [escopo] : UI_MODES) {
    for (const conversation of all[mode] ?? []) {
      const titleMatches = countOccurrences(normalizeSearchText(conversation.title), needle);
      const bodyMatches = termoTemQuebra
        ? conversation.messages.reduce(
            (total, message) => total + countOccurrences(normalizeSearchText(message.content), needle),
            0
          )
        : countOccurrences(corpoDobrado(conversation.messages), needle);
      const matchCount = titleMatches + bodyMatches;
      if (!matchCount) continue;
      parciais.push({ mode, conversation, matchCount });
    }
  }
  parciais.sort(
    (a, b) => b.matchCount - a.matchCount || b.conversation.updatedAt - a.conversation.updatedAt
  );
  const visiveis = limite === undefined ? parciais : parciais.slice(0, Math.max(0, limite));
  return visiveis.map(({ mode, conversation, matchCount }) => ({
    mode,
    conversationId: conversation.id,
    title: conversation.title,
    snippet: searchSnippet(conversation.messages, query) || conversation.title,
    matchCount
  }));
}

/* ------------------------------- projetos ------------------------------ */

export interface ConversationGroup<C> {
  /** null = conversas sem projeto (sempre o último grupo). */
  project: Project | null;
  conversations: C[];
}

/**
 * Agrupa na ordem dos projetos; sem-projeto (inclusive vínculos órfãos)
 * fecha a lista. Projeto vazio continua visível — foi criado de propósito.
 */
export function groupByProject<C extends { projectId?: string }>(
  list: C[],
  projects: Project[]
): Array<ConversationGroup<C>> {
  const known = new Set(projects.map((project) => project.id));
  const groups: Array<ConversationGroup<C>> = projects.map((project) => ({
    project,
    conversations: list.filter((item) => item.projectId === project.id)
  }));
  const loose = list.filter((item) => !item.projectId || !known.has(item.projectId));
  if (loose.length) groups.push({ project: null, conversations: loose });
  return groups;
}

export function addProject(projects: Project[], name: string, id: string, createdAt: number): Project[] {
  const clean = name.trim();
  if (!clean) return projects;
  return [...projects, { id, name: clean, createdAt }];
}

export function renameProject(projects: Project[], id: string, name: string): Project[] {
  const clean = name.trim();
  if (!clean) return projects;
  return projects.map((project) => (project.id === id ? { ...project, name: clean } : project));
}

export function removeProject(projects: Project[], id: string): Project[] {
  return projects.filter((project) => project.id !== id);
}

/** Move uma conversa para um projeto (ou para fora, com null). */
export function assignProject<C extends { id: string; projectId?: string }>(
  list: C[],
  conversationId: string,
  projectId: string | null
): C[] {
  if (!list.some((item) => item.id === conversationId)) return list;
  return list.map((item) => {
    if (item.id !== conversationId) return item;
    if (projectId) return { ...item, projectId };
    const { projectId: _dropped, ...rest } = item;
    return rest as C;
  });
}

/** Solta todas as conversas de um projeto — usado ao excluir a pasta. */
export function detachProject<C extends { projectId?: string }>(list: C[], projectId: string): C[] {
  return list.map((item) => {
    if (item.projectId !== projectId) return item;
    const { projectId: _dropped, ...rest } = item;
    return rest as C;
  });
}
