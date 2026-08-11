/**
 * Núcleo puro do canvas do modo Design — documento editável com nós
 * (frame/retângulo/elipse/texto), operações imutáveis, hit-test e export
 * SVG real. Sem DOM: roda em Node e é coberto por vitest (canvasDoc.test.ts).
 */

export type CanvasNodeType = "frame" | "rect" | "ellipse" | "text";

export interface CanvasNode {
  id: string;
  type: CanvasNodeType;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Cor concreta (hex/rgb/hsl) — precisa sobreviver ao export SVG/PNG. */
  fill: string;
  radius?: number;
  text?: string;
  fontSize?: number;
}

export interface CanvasDoc {
  name: string;
  nodes: CanvasNode[];
}

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const MIN_NODE_SIZE = 8;

/** Fills padrão concretos (como no Figma) — exportáveis sem depender do tema. */
export const DEFAULT_FILLS: Record<CanvasNodeType, string> = {
  frame: "#ffffff",
  rect: "#d9d9d9",
  ellipse: "#d9d9d9",
  text: "#111827"
};

/** Tamanho usado quando a ferramenta é aplicada com clique (sem arrasto). */
export const DEFAULT_SIZES: Record<CanvasNodeType, { w: number; h: number }> = {
  frame: { w: 320, h: 240 },
  rect: { w: 120, h: 80 },
  ellipse: { w: 96, h: 96 },
  text: { w: 160, h: 24 }
};

/* ------------------------------ Helpers ------------------------------ */

function clampSize(value: number): number {
  return Math.max(MIN_NODE_SIZE, Math.round(value));
}

/** Normaliza um nó: coordenadas inteiras, tamanho mínimo, raio/fonte válidos. */
export function normalizeNode(node: CanvasNode): CanvasNode {
  const clean: CanvasNode = {
    ...node,
    x: Math.round(node.x),
    y: Math.round(node.y),
    w: clampSize(node.w),
    h: clampSize(node.h)
  };
  if (clean.radius !== undefined) clean.radius = Math.max(0, Math.round(clean.radius));
  if (clean.fontSize !== undefined) clean.fontSize = Math.max(4, Math.round(clean.fontSize));
  return clean;
}

/** Próximo id livre no padrão `tipo-n` (rect-1, rect-2, …). */
export function nextId(doc: CanvasDoc, type: CanvasNodeType): string {
  const ids = new Set(doc.nodes.map((node) => node.id));
  let n = 1;
  while (ids.has(`${type}-${n}`)) n += 1;
  return `${type}-${n}`;
}

/* --------------------------- Documento base --------------------------- */

/** Documento inicial mínimo: um frame vazio "Frame 1". Nada decorativo. */
export function createDoc(name = "Sem título"): CanvasDoc {
  return {
    name,
    nodes: [
      { id: "frame-1", type: "frame", x: 0, y: 0, w: 480, h: 320, fill: DEFAULT_FILLS.frame, radius: 0, text: "Frame 1" }
    ]
  };
}

/** Cria um nó novo com id único e defaults por tipo (não insere no doc). */
export function createNode(doc: CanvasDoc, type: CanvasNodeType, rect: Bounds): CanvasNode {
  const id = nextId(doc, type);
  const base: CanvasNode = { id, type, x: rect.x, y: rect.y, w: rect.w, h: rect.h, fill: DEFAULT_FILLS[type] };
  if (type === "frame") return normalizeNode({ ...base, radius: 0, text: `Frame ${id.split("-")[1]}` });
  if (type === "rect") return normalizeNode({ ...base, radius: 0 });
  if (type === "text") return normalizeNode({ ...base, text: "Texto", fontSize: 16 });
  return normalizeNode(base);
}

/* ------------------------- Operações imutáveis ------------------------ */

export function addNode(doc: CanvasDoc, node: CanvasNode): CanvasDoc {
  return { ...doc, nodes: [...doc.nodes, normalizeNode(node)] };
}

export function updateNode(
  doc: CanvasDoc,
  id: string,
  patch: Partial<Omit<CanvasNode, "id" | "type">>
): CanvasDoc {
  let changed = false;
  const nodes = doc.nodes.map((node) => {
    if (node.id !== id) return node;
    changed = true;
    return normalizeNode({ ...node, ...patch, id: node.id, type: node.type });
  });
  return changed ? { ...doc, nodes } : doc;
}

export function removeNode(doc: CanvasDoc, id: string): CanvasDoc {
  const nodes = doc.nodes.filter((node) => node.id !== id);
  return nodes.length === doc.nodes.length ? doc : { ...doc, nodes };
}

/** Move o nó para o índice `to` (clamp). Índices maiores ficam por cima. */
export function reorder(doc: CanvasDoc, id: string, to: number): CanvasDoc {
  const from = doc.nodes.findIndex((node) => node.id === id);
  if (from < 0) return doc;
  const target = Math.max(0, Math.min(doc.nodes.length - 1, Math.round(to)));
  if (target === from) return doc;
  const nodes = [...doc.nodes];
  const [node] = nodes.splice(from, 1);
  nodes.splice(target, 0, node);
  return { ...doc, nodes };
}

/* ------------------------------ Hit-test ------------------------------ */

/** Nó mais ao topo (fim do array) sob o ponto (x, y) do mundo, ou null. */
export function hitTest(doc: CanvasDoc, x: number, y: number): CanvasNode | null {
  for (let i = doc.nodes.length - 1; i >= 0; i -= 1) {
    const node = doc.nodes[i];
    if (node.type === "ellipse") {
      const rx = node.w / 2;
      const ry = node.h / 2;
      const dx = (x - (node.x + rx)) / rx;
      const dy = (y - (node.y + ry)) / ry;
      if (dx * dx + dy * dy <= 1) return node;
    } else if (x >= node.x && x <= node.x + node.w && y >= node.y && y <= node.y + node.h) {
      return node;
    }
  }
  return null;
}

/* ----------------------------- Export SVG ----------------------------- */

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Caixa envolvente de todos os nós (mínimo 1×1 para docs vazios). */
export function boundsOf(doc: CanvasDoc): Bounds {
  if (!doc.nodes.length) return { x: 0, y: 0, w: 1, h: 1 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of doc.nodes) {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x + node.w);
    maxY = Math.max(maxY, node.y + node.h);
  }
  return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
}

function nodeToSvg(node: CanvasNode): string {
  const fill = escapeXml(node.fill);
  switch (node.type) {
    case "frame":
    case "rect": {
      const rx = node.radius ? ` rx="${node.radius}"` : "";
      return `<rect x="${node.x}" y="${node.y}" width="${node.w}" height="${node.h}" fill="${fill}"${rx}/>`;
    }
    case "ellipse": {
      const rx = node.w / 2;
      const ry = node.h / 2;
      return `<ellipse cx="${node.x + rx}" cy="${node.y + ry}" rx="${rx}" ry="${ry}" fill="${fill}"/>`;
    }
    case "text": {
      const size = node.fontSize ?? 16;
      const content = escapeXml(node.text ?? "");
      return (
        `<text x="${node.x}" y="${node.y + size}" font-family="Segoe UI, Arial, sans-serif" ` +
        `font-size="${size}" fill="${fill}">${content}</text>`
      );
    }
  }
}

/** SVG completo e válido do documento — dimensões cobrindo todos os nós. */
export function exportSvg(doc: CanvasDoc): string {
  const b = boundsOf(doc);
  const body = doc.nodes.map(nodeToSvg).join("\n");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${b.w}" height="${b.h}" ` +
    `viewBox="${b.x} ${b.y} ${b.w} ${b.h}">\n${body}\n</svg>`
  );
}

/* ---------------------------- Persistência ---------------------------- */

const NODE_TYPES: CanvasNodeType[] = ["frame", "rect", "ellipse", "text"];

/** Valida e restaura um doc serializado (localStorage). null se inválido. */
export function parseDoc(json: string): CanvasDoc | null {
  try {
    const raw = JSON.parse(json) as unknown;
    if (!raw || typeof raw !== "object") return null;
    const doc = raw as { name?: unknown; nodes?: unknown };
    if (typeof doc.name !== "string" || !Array.isArray(doc.nodes)) return null;
    const nodes: CanvasNode[] = [];
    for (const entry of doc.nodes) {
      const node = entry as Partial<CanvasNode>;
      if (
        !node ||
        typeof node.id !== "string" ||
        !NODE_TYPES.includes(node.type as CanvasNodeType) ||
        typeof node.x !== "number" ||
        typeof node.y !== "number" ||
        typeof node.w !== "number" ||
        typeof node.h !== "number" ||
        typeof node.fill !== "string"
      ) {
        return null;
      }
      nodes.push(normalizeNode(node as CanvasNode));
    }
    return { name: doc.name, nodes };
  } catch {
    return null;
  }
}
