/**
 * Stencils e conectores — prototipagem de interface no canvas do Design.
 *
 * O canvas já tinha as primitivas (retângulo, elipse, texto). O que faltava
 * para prototipar de verdade era o vocabulário: um botão não é "um retângulo
 * mais um texto que você posiciona na mão", é **um item** que nasce pronto e
 * consistente. Sem isso, montar uma tela é trabalho manual de alinhamento, e
 * duas telas nunca saem iguais.
 *
 * Cada stencil é uma função pura que devolve os nós já posicionados em relação
 * a um ponto. Nada de DOM, nada de estado — dá para testar a geometria toda.
 *
 * Os conectores resolvem a outra metade (fluxogramas): ligar duas formas com
 * uma linha que **acompanha** as formas quando elas se movem, em vez de uma
 * linha solta que fica para trás.
 */
import type { CanvasDoc, CanvasNode } from "./canvasDoc";

/* ------------------------------ stencils ------------------------------ */

export type StencilId =
  | "button"
  | "input"
  | "checkbox"
  | "card"
  | "navbar"
  | "browser"
  | "phone"
  | "process"
  | "decision"
  | "terminator";

export interface StencilSpec {
  id: StencilId;
  label: string;
  /** Agrupamento na paleta. */
  group: "Formulário" | "Layout" | "Fluxograma";
  w: number;
  h: number;
}

/** Paleta de stencils, na ordem em que aparece. */
export const STENCILS: StencilSpec[] = [
  { id: "button", label: "Botão", group: "Formulário", w: 120, h: 36 },
  { id: "input", label: "Campo", group: "Formulário", w: 220, h: 38 },
  { id: "checkbox", label: "Caixa de seleção", group: "Formulário", w: 160, h: 20 },
  { id: "card", label: "Cartão", group: "Layout", w: 240, h: 140 },
  { id: "navbar", label: "Barra de navegação", group: "Layout", w: 480, h: 48 },
  { id: "browser", label: "Janela do navegador", group: "Layout", w: 560, h: 360 },
  { id: "phone", label: "Celular", group: "Layout", w: 260, h: 520 },
  { id: "process", label: "Processo", group: "Fluxograma", w: 160, h: 64 },
  { id: "decision", label: "Decisão", group: "Fluxograma", w: 150, h: 90 },
  { id: "terminator", label: "Início / fim", group: "Fluxograma", w: 150, h: 52 }
];

/** Paleta neutra de wireframe — cinza legível, não decisão de marca. */
const INK = "#111827";
const MUTED = "#6b7280";
const LINE = "#d1d5db";
const SURFACE = "#ffffff";
const PANEL = "#f3f4f6";
const ACCENT = "#2563eb";

/**
 * Monta os nós de um stencil na posição dada.
 *
 * Os ids saem prefixados por `seed` para não colidirem com o que já existe no
 * documento — dois botões inseridos não podem compartilhar id.
 */
export function buildStencil(id: StencilId, x: number, y: number, seed: string): CanvasNode[] {
  const nid = (suffix: string) => `${seed}-${suffix}`;
  const spec = STENCILS.find((entry) => entry.id === id);
  const w = spec?.w ?? 120;
  const h = spec?.h ?? 40;

  switch (id) {
    case "button":
      return [
        { id: nid("bg"), type: "rect", x, y, w, h, fill: ACCENT, radius: 6 },
        {
          id: nid("label"),
          type: "text",
          x: x + 12,
          y: y + h / 2 - 8,
          w: w - 24,
          h: 16,
          fill: SURFACE,
          text: "Botão",
          fontSize: 14
        }
      ];
    case "input":
      return [
        { id: nid("bg"), type: "rect", x, y, w, h, fill: SURFACE, radius: 6 },
        { id: nid("line"), type: "rect", x, y: y + h - 2, w, h: 2, fill: LINE },
        {
          id: nid("ph"),
          type: "text",
          x: x + 10,
          y: y + h / 2 - 8,
          w: w - 20,
          h: 16,
          fill: MUTED,
          text: "Digite aqui",
          fontSize: 14
        }
      ];
    case "checkbox":
      return [
        { id: nid("box"), type: "rect", x, y, w: 18, h: 18, fill: SURFACE, radius: 3 },
        { id: nid("edge"), type: "rect", x, y: y + 17, w: 18, h: 1, fill: LINE },
        {
          id: nid("label"),
          type: "text",
          x: x + 26,
          y: y + 1,
          w: w - 26,
          h: 16,
          fill: INK,
          text: "Opção",
          fontSize: 14
        }
      ];
    case "card":
      return [
        { id: nid("bg"), type: "rect", x, y, w, h, fill: SURFACE, radius: 10 },
        { id: nid("thumb"), type: "rect", x, y, w, h: 72, fill: PANEL, radius: 10 },
        {
          id: nid("title"),
          type: "text",
          x: x + 14,
          y: y + 86,
          w: w - 28,
          h: 18,
          fill: INK,
          text: "Título do cartão",
          fontSize: 15
        },
        {
          id: nid("body"),
          type: "text",
          x: x + 14,
          y: y + 108,
          w: w - 28,
          h: 16,
          fill: MUTED,
          text: "Descrição curta.",
          fontSize: 13
        }
      ];
    case "navbar":
      return [
        { id: nid("bg"), type: "rect", x, y, w, h, fill: SURFACE },
        { id: nid("edge"), type: "rect", x, y: y + h - 1, w, h: 1, fill: LINE },
        { id: nid("logo"), type: "rect", x: x + 16, y: y + 14, w: 88, h: 20, fill: PANEL, radius: 4 },
        {
          id: nid("menu"),
          type: "text",
          x: x + w - 220,
          y: y + h / 2 - 8,
          w: 200,
          h: 16,
          fill: INK,
          text: "Início   Produtos   Contato",
          fontSize: 13
        }
      ];
    case "browser":
      return [
        { id: nid("bg"), type: "rect", x, y, w, h, fill: SURFACE, radius: 8 },
        { id: nid("chrome"), type: "rect", x, y, w, h: 34, fill: PANEL, radius: 8 },
        { id: nid("d1"), type: "ellipse", x: x + 12, y: y + 12, w: 10, h: 10, fill: "#ef4444" },
        { id: nid("d2"), type: "ellipse", x: x + 28, y: y + 12, w: 10, h: 10, fill: "#f59e0b" },
        { id: nid("d3"), type: "ellipse", x: x + 44, y: y + 12, w: 10, h: 10, fill: "#10b981" },
        { id: nid("url"), type: "rect", x: x + 66, y: y + 9, w: w - 84, h: 17, fill: SURFACE, radius: 8 }
      ];
    case "phone":
      return [
        { id: nid("body"), type: "rect", x, y, w, h, fill: INK, radius: 28 },
        { id: nid("screen"), type: "rect", x: x + 10, y: y + 34, w: w - 20, h: h - 58, fill: SURFACE, radius: 4 },
        { id: nid("notch"), type: "rect", x: x + w / 2 - 34, y: y + 12, w: 68, h: 10, fill: "#374151", radius: 5 }
      ];
    case "process":
      return [
        { id: nid("bg"), type: "rect", x, y, w, h, fill: SURFACE, radius: 4 },
        { id: nid("edge"), type: "rect", x, y: y + h - 2, w, h: 2, fill: INK },
        {
          id: nid("label"),
          type: "text",
          x: x + 10,
          y: y + h / 2 - 8,
          w: w - 20,
          h: 16,
          fill: INK,
          text: "Processo",
          fontSize: 14
        }
      ];
    case "decision":
      // Losango não existe como primitiva; a elipse é a aproximação honesta —
      // e o rótulo diz o que é. Inventar um tipo novo só para isto custaria
      // mais que o ganho.
      return [
        { id: nid("bg"), type: "ellipse", x, y, w, h, fill: SURFACE },
        {
          id: nid("label"),
          type: "text",
          x: x + 12,
          y: y + h / 2 - 8,
          w: w - 24,
          h: 16,
          fill: INK,
          text: "Decisão?",
          fontSize: 13
        }
      ];
    case "terminator":
      return [
        { id: nid("bg"), type: "rect", x, y, w, h, fill: PANEL, radius: 26 },
        {
          id: nid("label"),
          type: "text",
          x: x + 14,
          y: y + h / 2 - 8,
          w: w - 28,
          h: 16,
          fill: INK,
          text: "Início",
          fontSize: 14
        }
      ];
  }
}

/* ----------------------------- conectores ----------------------------- */

/**
 * Liga dois nós. Guarda os IDS, não coordenadas — é o que faz a linha
 * acompanhar as formas quando elas se movem. Uma linha com pontos fixos ficaria
 * para trás no primeiro arrasto, e o diagrama viraria mentira.
 */
export interface Connector {
  id: string;
  from: string;
  to: string;
  label?: string;
}

export interface ConnectorGeometry {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Meio da linha — onde o rótulo é desenhado. */
  mx: number;
  my: number;
  label: string;
}

const centerOf = (node: CanvasNode) => ({ x: node.x + node.w / 2, y: node.y + node.h / 2 });

/**
 * Ponto onde a linha encontra a borda do retângulo, na direção do alvo.
 *
 * Sem isto a linha entra até o centro e fica escondida atrás da forma —
 * visualmente a seta some.
 */
export function edgePoint(node: CanvasNode, towards: { x: number; y: number }): { x: number; y: number } {
  const center = centerOf(node);
  const dx = towards.x - center.x;
  const dy = towards.y - center.y;
  if (dx === 0 && dy === 0) return center;
  const halfW = node.w / 2;
  const halfH = node.h / 2;
  // Escala até tocar a borda mais próxima no eixo dominante.
  const scale = Math.min(
    dx === 0 ? Number.POSITIVE_INFINITY : halfW / Math.abs(dx),
    dy === 0 ? Number.POSITIVE_INFINITY : halfH / Math.abs(dy)
  );
  return { x: center.x + dx * scale, y: center.y + dy * scale };
}

/**
 * Calcula a geometria dos conectores a partir do documento.
 *
 * Conector cujo nó sumiu é **descartado** em silêncio: apagar uma forma não
 * pode deixar uma linha apontando para o nada.
 */
export function connectorGeometry(doc: CanvasDoc, connectors: readonly Connector[]): ConnectorGeometry[] {
  const byId = new Map(doc.nodes.map((node) => [node.id, node]));
  const out: ConnectorGeometry[] = [];
  for (const connector of connectors) {
    const from = byId.get(connector.from);
    const to = byId.get(connector.to);
    if (!from || !to || connector.from === connector.to) continue;
    const start = edgePoint(from, centerOf(to));
    const end = edgePoint(to, centerOf(from));
    out.push({
      id: connector.id,
      x1: Math.round(start.x),
      y1: Math.round(start.y),
      x2: Math.round(end.x),
      y2: Math.round(end.y),
      mx: Math.round((start.x + end.x) / 2),
      my: Math.round((start.y + end.y) / 2),
      label: connector.label ?? ""
    });
  }
  return out;
}

/** Remove os conectores que perderam alguma ponta. Chamar após apagar nós. */
export function pruneConnectors(doc: CanvasDoc, connectors: readonly Connector[]): Connector[] {
  const ids = new Set(doc.nodes.map((node) => node.id));
  return connectors.filter((connector) => ids.has(connector.from) && ids.has(connector.to));
}

/** Conectores como SVG, para entrar no export junto das formas. */
export function connectorsToSvg(geometry: readonly ConnectorGeometry[]): string {
  if (!geometry.length) return "";
  const marker =
    '<defs><marker id="aio-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#6b7280"/></marker></defs>';
  const linhas = geometry
    .map(
      (item) =>
        `<line x1="${item.x1}" y1="${item.y1}" x2="${item.x2}" y2="${item.y2}" stroke="#6b7280" stroke-width="1.5" marker-end="url(#aio-arrow)"/>` +
        (item.label
          ? `<text x="${item.mx}" y="${item.my - 6}" text-anchor="middle" fill="#6b7280" font-size="11">${escapeLabel(
              item.label
            )}</text>`
          : "")
    )
    .join("\n");
  return `${marker}\n${linhas}`;
}

function escapeLabel(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
