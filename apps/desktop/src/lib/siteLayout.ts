/**
 * Clone de site com LAYOUT REAL — o que faltava para a aba Design deixar de
 * só "semear tokens".
 *
 * ## Por que isto não é adivinhação
 *
 * Calcular onde cada elemento fica exige um motor de layout. O app **roda num
 * webview** — ou seja, tem um motor de layout de verdade à disposição. O HTML
 * é renderizado num iframe oculto e a geometria sai de `getBoundingClientRect`
 * e `getComputedStyle`: são os números que o navegador de fato usou, não uma
 * estimativa a partir do CSS.
 *
 * ## Por que o HTML precisa vir do Rust
 *
 * Buscar de outra origem pelo `fetch` do webview esbarra no CORS na LEITURA —
 * o HTML nunca chegaria ao JS. O `page_fetch` no Rust passa pelas mesmas
 * guardas de rede pública e blocklist do admin.
 *
 * ## Limites, ditos antes de alguém descobrir
 *
 * - **SPA não aparece.** O que depende de JS para montar a tela não é
 *   executado (o iframe entra com `sandbox` sem scripts, de propósito).
 * - Fontes e imagens externas podem não carregar; o layout ainda é calculado.
 * - É um retrato **estático** de uma largura só.
 *
 * A parte pura (absolutizar URLs e mapear o retrato em nós) mora aqui e é
 * testada; o passeio pelo DOM precisa do navegador.
 */
import type { CanvasDoc, CanvasNode } from "./canvasDoc";

/** Teto de nós importados — uma home real tem milhares; o canvas não. */
export const MAX_NODES = 400;
/** Abaixo disto o elemento é ruído visual (divisor, sombra, pixel de rastreio). */
const MIN_SIDE = 6;

/**
 * Reescreve caminhos relativos para absolutos.
 *
 * Sem isto o CSS e as imagens do site não carregam dentro do iframe (a base
 * passa a ser a nossa origem), e o layout calculado sairia sem estilo — o
 * clone viraria uma pilha de blocos empilhados.
 */
export function absolutizeHtml(html: string, baseUrl: string): string {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return html;
  }
  const resolve = (value: string): string => {
    const clean = value.trim();
    // Já absoluto, âncora, dado embutido ou protocolo especial: não mexer.
    if (!clean || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(clean)) return clean;
    try {
      return new URL(clean, base).toString();
    } catch {
      return clean;
    }
  };
  return html
    .replace(/\b(href|src)\s*=\s*"([^"]*)"/gi, (_m, attr: string, value: string) => `${attr}="${resolve(value)}"`)
    .replace(/\b(href|src)\s*=\s*'([^']*)'/gi, (_m, attr: string, value: string) => `${attr}='${resolve(value)}'`)
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (_m, quote: string, value: string) => `url(${quote}${resolve(value)}${quote})`);
}

/**
 * Remove o que não pode rodar dentro do iframe.
 *
 * `<script>` sai porque o iframe entra sem permissão de script — deixar a tag
 * só engordaria o HTML. `<base>` sai porque sobrescreveria a resolução que
 * acabamos de fazer.
 */
export function sanitizeForPreview(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<base\b[^>]*>/gi, "");
}

/** Retrato de UM elemento renderizado, colhido do DOM real. */
export interface ElementSnapshot {
  tag: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Cor de fundo já resolvida pelo navegador (`rgb(...)`). */
  background: string;
  color: string;
  fontSize: number;
  /** Texto direto do elemento, sem o dos filhos. */
  text: string;
  radius: number;
  /** Profundidade na árvore — usada para ordenar o empilhamento. */
  depth: number;
}

/** `rgba(0, 0, 0, 0)` e afins: transparente não vira retângulo. */
export function isTransparent(color: string): boolean {
  const clean = color.trim().toLowerCase();
  if (!clean || clean === "transparent" || clean === "none") return true;
  const match = clean.match(/^rgba?\(([^)]+)\)$/);
  if (!match) return false;
  const parts = match[1].split(",").map((part) => Number(part.trim()));
  return parts.length === 4 && parts[3] === 0;
}

/** `rgb(17, 24, 39)` → `#111827`. O export SVG precisa de cor concreta. */
export function toHex(color: string): string {
  const match = color.trim().match(/^rgba?\(([^)]+)\)$/i);
  if (!match) return color.trim() || "#000000";
  const parts = match[1].split(",").map((part) => Number(part.trim()));
  const [r, g, b] = parts;
  if ([r, g, b].some((value) => !Number.isFinite(value))) return "#000000";
  const hex = (value: number) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/**
 * O retrato vira um nó do canvas — ou `null` quando não deve virar nada.
 *
 * Descarta o invisível e o minúsculo: sem esse filtro o canvas recebe milhares
 * de `<div>` de layout sem pixel algum, e fica impossível de editar.
 */
export function snapshotToNode(snapshot: ElementSnapshot, id: string): CanvasNode | null {
  if (snapshot.w < MIN_SIDE || snapshot.h < MIN_SIDE) return null;
  const texto = snapshot.text.trim();
  if (texto) {
    return {
      id,
      type: "text",
      x: Math.round(snapshot.x),
      y: Math.round(snapshot.y),
      w: Math.round(snapshot.w),
      h: Math.round(snapshot.h),
      fill: toHex(snapshot.color),
      text: texto.slice(0, 240),
      fontSize: Math.max(8, Math.round(snapshot.fontSize) || 14)
    };
  }
  // Sem texto e sem fundo, o elemento não desenha nada.
  if (isTransparent(snapshot.background)) return null;
  return {
    id,
    type: "rect",
    x: Math.round(snapshot.x),
    y: Math.round(snapshot.y),
    w: Math.round(snapshot.w),
    h: Math.round(snapshot.h),
    fill: toHex(snapshot.background),
    ...(snapshot.radius > 0 ? { radius: Math.round(snapshot.radius) } : {})
  };
}

/**
 * Monta o documento do canvas a partir dos retratos.
 *
 * A ordem importa: elementos mais rasos primeiro, para o fundo ficar atrás do
 * conteúdo — é o mesmo empilhamento que o navegador usou.
 */
export function docFromSnapshots(name: string, snapshots: readonly ElementSnapshot[]): CanvasDoc {
  const ordenados = [...snapshots].sort((a, b) => a.depth - b.depth);
  const nodes: CanvasNode[] = [];
  for (const snapshot of ordenados) {
    if (nodes.length >= MAX_NODES) break;
    const node = snapshotToNode(snapshot, `n${nodes.length + 1}`);
    if (node) nodes.push(node);
  }
  return { name, nodes };
}

/** Quantos elementos ficaram de fora — dito na UI, não escondido. */
export function droppedCount(snapshots: readonly ElementSnapshot[], doc: CanvasDoc): number {
  return Math.max(0, snapshots.length - doc.nodes.length);
}
