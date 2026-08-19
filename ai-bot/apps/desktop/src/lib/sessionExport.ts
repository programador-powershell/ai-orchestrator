/**
 * Exportação de conversa — a serialização pura do que o gateway devolve em
 * GET /v1/sessions/{id}/events.
 *
 * Duas formas de propósito:
 *  - `.md` é para GENTE: só as falas, legíveis, com quem disse o quê. Verbos de
 *    máquina (rota, ferramenta, aprovação) ficam de fora — quem exporta em
 *    markdown quer reler a conversa, não auditar o protocolo;
 *  - `.json` é para MÁQUINA: os envelopes crus, inteiros, exatamente como o
 *    log os guarda. É o formato de quem vai reprocessar.
 *
 * Este arquivo não toca DOM nem rede: a coleta pagina por um `get` injetado e o
 * download (blob + clique) mora em quem tem documento — é o que deixa tudo
 * daqui testável sem navegador de verdade.
 */

import type { Envelope, Message } from "@aibot/contracts";

/** O mesmo teto de página do gateway (store.MaxEventBatch). */
const PAGE_SIZE = 500;

/**
 * Coleta o log INTEIRO paginando: a rota devolve no máximo uma página por
 * chamada, e uma conversa longa passa disso — exportar só a primeira página
 * seria perder o fim da conversa em silêncio.
 */
export async function coletarEventos(
  get: (path: string) => Promise<unknown>,
  sessionId: string
): Promise<Envelope[]> {
  const out: Envelope[] = [];
  let from = 0;
  for (;;) {
    const body = await get(
      `/v1/sessions/${encodeURIComponent(sessionId)}/events?from=${from}&limit=${PAGE_SIZE}`
    );
    if (!Array.isArray(body) || body.length === 0) return out;
    for (const item of body as Envelope[]) {
      out.push(item);
      if (typeof item.seq === "number" && item.seq > from) from = item.seq;
    }
    if (body.length < PAGE_SIZE) return out;
  }
}

/** Quem fala em cada linha do markdown. */
function autorDe(envelope: Envelope, message: Message): string {
  if (message.role === "user") return "Você";
  if (message.role === "system") return "Sistema";
  const specialist = message.specialist ?? envelope.from.specialist ?? "";
  return specialist === "" ? "Assistente" : `Assistente (${specialist})`;
}

/** A conversa em markdown legível. */
export function eventosParaMarkdown(events: readonly Envelope[], title: string): string {
  const parts: string[] = [];
  parts.push(`# ${title.trim() === "" ? "Conversa" : title.trim()}`);
  const first = events[0];
  if (first?.ts) parts.push(`\n> exportada do AI-BOT — primeira mensagem em ${first.ts}`);

  for (const envelope of events) {
    if (envelope.kind !== "message") continue;
    const payload = envelope.payload as Message | undefined;
    if (!payload || typeof payload.text !== "string" || payload.text.trim() === "") continue;
    parts.push(`\n## ${autorDe(envelope, payload)}\n`);
    parts.push(payload.text.trim());
  }
  return `${parts.join("\n")}\n`;
}

/** Os envelopes crus, identados — o formato de reprocessamento. */
export function eventosParaJson(events: readonly Envelope[]): string {
  return `${JSON.stringify(events, null, 2)}\n`;
}

/**
 * Dispara o download de um texto como arquivo — o único pedaço com DOM deste
 * módulo. Blob + âncora porque o app é uma WebView sem rota de servidor para
 * servir o arquivo; o revoke fica para DEPOIS do clique, senão o WebView
 * cancela o download que acabou de começar.
 */
export function baixarArquivo(nome: string, mime: string, conteudo: string): void {
  const blob = new Blob([conteudo], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = nome;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * O nome do arquivo baixado. Deriva do título (legível no Downloads) com o id
 * como reserva — e só caracteres seguros, porque o título vem de texto livre e
 * `/` num nome de arquivo vira caminho.
 */
export function nomeDoArquivo(title: string, sessionId: string, ext: "md" | "json"): string {
  const base = title
    .trim()
    .toLowerCase()
    .normalize("NFD")
    // A faixa dos diacríticos combinantes: "título" → "titulo" sem tabela.
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${base === "" ? sessionId : base}.${ext}`;
}
