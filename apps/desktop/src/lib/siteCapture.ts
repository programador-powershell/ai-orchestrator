/**
 * Captura da geometria REAL de uma página, usando o motor de layout do próprio
 * webview.
 *
 * O HTML é renderizado num iframe oculto e a posição de cada elemento sai de
 * `getBoundingClientRect()` — o número que o navegador de fato calculou. É a
 * diferença entre reconstruir o layout e adivinhá-lo a partir do CSS.
 *
 * ## Decisões de segurança, e não de conveniência
 *
 * - O iframe entra com `sandbox` **sem `allow-scripts`**: estamos renderizando
 *   HTML de terceiro dentro do app. Deixar script rodar seria executar código
 *   arbitrário no mesmo processo do usuário.
 * - Por isso conteúdo de SPA **não aparece** — é o preço da trava, e está dito
 *   na UI em vez de escondido.
 * - O HTML chega pelo Rust (`page_fetch`), que aplica anti-SSRF e a blocklist
 *   do admin. O webview nunca busca a página sozinho.
 *
 * A lógica pura (absolutizar, mapear, filtrar) vive em `siteLayout.ts` e é
 * testada; aqui fica só o que exige DOM.
 */
import { invoke } from "@tauri-apps/api/core";
import {
  absolutizeHtml,
  docFromSnapshots,
  droppedCount,
  sanitizeForPreview,
  type ElementSnapshot
} from "./siteLayout";
import type { CanvasDoc } from "./canvasDoc";

/** Largura usada na captura — um retrato de desktop. */
const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 2400;
/** Teto de elementos percorridos, antes de qualquer filtro. */
const MAX_ELEMENTS = 4000;
/** Tempo máximo esperando o iframe carregar folhas de estilo e imagens. */
const LOAD_TIMEOUT_MS = 8000;

interface FetchedPage {
  title: string;
  /** Aqui vem o HTML BRUTO — ver `page_fetch` no Rust. */
  text: string;
  /** `links[0]` é a URL FINAL, depois de redirects. */
  links: string[];
}

export interface CaptureResult {
  doc: CanvasDoc;
  title: string;
  finalUrl: string;
  /** Elementos vistos na página (antes dos filtros). */
  seen: number;
  /** Quantos não viraram nó — dito na UI, não escondido. */
  dropped: number;
}

/** Texto só DESTE elemento, ignorando o dos filhos (senão tudo duplica). */
function ownText(element: Element): string {
  let out = "";
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) out += child.textContent ?? "";
  }
  return out.replace(/\s+/g, " ").trim();
}

/** Percorre o documento renderizado colhendo o retrato de cada elemento. */
function walk(root: Document): ElementSnapshot[] {
  const snapshots: ElementSnapshot[] = [];
  const origem = root.body?.getBoundingClientRect();
  const offsetX = origem?.left ?? 0;
  const offsetY = origem?.top ?? 0;

  const visit = (element: Element, depth: number) => {
    if (snapshots.length >= MAX_ELEMENTS) return;
    const view = root.defaultView;
    if (!view) return;
    const style = view.getComputedStyle(element);
    // Invisível não entra: economiza o filtro depois e evita nó fantasma.
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return;
    const rect = element.getBoundingClientRect();
    snapshots.push({
      tag: element.tagName.toLowerCase(),
      x: rect.left - offsetX,
      y: rect.top - offsetY,
      w: rect.width,
      h: rect.height,
      background: style.backgroundColor,
      color: style.color,
      fontSize: Number.parseFloat(style.fontSize) || 14,
      text: ownText(element),
      radius: Number.parseFloat(style.borderTopLeftRadius) || 0,
      depth
    });
    for (const child of Array.from(element.children)) visit(child, depth + 1);
  };

  if (root.body) visit(root.body, 0);
  return snapshots;
}

/** Espera o iframe carregar, com teto — site lento não trava a aba. */
function waitForLoad(frame: HTMLIFrameElement): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    frame.addEventListener("load", () => window.setTimeout(finish, 250), { once: true });
    window.setTimeout(finish, LOAD_TIMEOUT_MS);
  });
}

/**
 * Busca a página e reconstrói o layout em nós do canvas.
 *
 * O iframe é sempre removido no `finally`: deixar um nó oculto com HTML de
 * terceiro pendurado no documento seria vazamento de memória e de conteúdo.
 */
export async function captureSite(url: string): Promise<CaptureResult> {
  const page = await invoke<FetchedPage>("page_fetch", { url });
  const finalUrl = page.links[0] ?? url;
  const html = sanitizeForPreview(absolutizeHtml(page.text, finalUrl));

  const frame = document.createElement("iframe");
  // Sem `allow-scripts`: HTML de terceiro não executa código aqui.
  frame.setAttribute("sandbox", "allow-same-origin");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = `position:fixed;left:-10000px;top:0;width:${VIEWPORT_WIDTH}px;height:${VIEWPORT_HEIGHT}px;border:0;visibility:hidden;`;
  document.body.appendChild(frame);

  try {
    frame.srcdoc = html;
    await waitForLoad(frame);
    const inner = frame.contentDocument;
    if (!inner) {
      throw new Error("não foi possível ler a página renderizada");
    }
    const snapshots = walk(inner);
    const doc = docFromSnapshots(page.title || finalUrl, snapshots);
    return {
      doc,
      title: page.title || finalUrl,
      finalUrl,
      seen: snapshots.length,
      dropped: droppedCount(snapshots, doc)
    };
  } finally {
    frame.remove();
  }
}
