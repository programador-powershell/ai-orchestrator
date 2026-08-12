/**
 * Export de imagem do ERD como SVG puro (string building, sem DOM nem
 * dependência externa).
 *
 * O layout é o DESENHADO pelo usuário: usa `table.x`/`table.y` e a mesma
 * geometria do canvas (TABLE_GEOMETRY), então a imagem sai igual à tela.
 * Antes havia uma grade própria de 3 colunas que descartava as posições — o
 * usuário arrastava as tabelas e o export ignorava. A grade sobrou só como
 * fallback para documento sem posições (tudo em 0,0).
 *
 * Coberto por erdSvg.test.ts.
 */
import { TABLE_GEOMETRY, tableHeight, type SchemaDocExt } from "./schema";

const COLS = 3;
const MARGIN = 24;
/** Mesma geometria do canvas — a imagem tem de bater com o desenho. */
const CARD_W = TABLE_GEOMETRY.width;
const GAP_X = 46;
const GAP_Y = 40;
const HEADER_H = TABLE_GEOMETRY.headerHeight;
const ROW_H = TABLE_GEOMETRY.rowHeight;

/** Escapa os caracteres reservados de XML no conteúdo textual. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface Placed {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
}

function cardHeight(fieldCount: number): number {
  return HEADER_H + fieldCount * ROW_H;
}

const place = (name: string, x: number, y: number, h: number): Placed => ({
  name,
  x,
  y,
  w: CARD_W,
  h,
  cx: x + CARD_W / 2,
  cy: y + h / 2
});

/** Documento sem nenhuma posição (todas em 0,0) — nunca foi desenhado. */
function hasLayout(doc: SchemaDocExt): boolean {
  return doc.tables.some((table) => table.x !== 0 || table.y !== 0);
}

/** Fallback para documento sem layout: grade determinística de 3 colunas. */
function gridFallback(doc: SchemaDocExt): Placed[] {
  const placed: Placed[] = [];
  let rowTop = MARGIN;
  for (let start = 0; start < doc.tables.length; start += COLS) {
    const row = doc.tables.slice(start, start + COLS);
    let rowHeight = 0;
    row.forEach((table, col) => {
      const h = cardHeight(table.fields.length);
      placed.push(place(table.name, MARGIN + col * (CARD_W + GAP_X), rowTop, h));
      rowHeight = Math.max(rowHeight, h);
    });
    rowTop += rowHeight + GAP_Y;
  }
  return placed;
}

/**
 * Posições REAIS do canvas, normalizadas para a origem: o usuário pode ter
 * arrastado tabelas para coordenadas negativas ou distantes, e o SVG precisa
 * de um viewBox que comece em 0 com margem.
 */
function placeTables(doc: SchemaDocExt): Placed[] {
  if (!hasLayout(doc)) return gridFallback(doc);
  const minX = Math.min(...doc.tables.map((table) => table.x));
  const minY = Math.min(...doc.tables.map((table) => table.y));
  return doc.tables.map((table) =>
    place(table.name, table.x - minX + MARGIN, table.y - minY + MARGIN, tableHeight(table))
  );
}

/** Renderiza o documento de schema como um SVG string autocontido. */
export function renderErdSvg(doc: SchemaDocExt): string {
  const placed = placeTables(doc);
  const byName = new Map(placed.map((p) => [p.name, p]));

  // Dimensão pela extensão real do que foi colocado (o layout do usuário não
  // cabe numa fórmula de grade).
  const width = placed.length ? Math.max(...placed.map((p) => p.x + p.w)) + MARGIN : MARGIN * 2;
  const height = placed.length ? Math.max(...placed.map((p) => p.y + p.h)) + MARGIN : MARGIN * 2;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" ` +
      `width="${width}" height="${height}" font-family="sans-serif" font-size="12">`
  );

  // Linhas de relação/FK primeiro, para ficarem atrás dos cards.
  for (const relation of doc.relations) {
    const from = byName.get(relation.fromTable);
    const to = byName.get(relation.toTable);
    if (!from || !to) continue;
    parts.push(`<line x1="${from.cx}" y1="${from.cy}" x2="${to.cx}" y2="${to.cy}" stroke="#94a3b8" stroke-width="1.5" />`);
  }

  placed.forEach((p, i) => {
    const table = doc.tables[i];
    parts.push(
      `<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="6" fill="#ffffff" stroke="#334155" stroke-width="1.5" />`
    );
    parts.push(`<text x="${p.x + 10}" y="${p.y + 17}" font-weight="700" fill="#0f172a">${escapeXml(p.name)}</text>`);
    table.fields.forEach((field, row) => {
      const y = p.y + HEADER_H + row * ROW_H + 14;
      const marker = field.primaryKey ? " (PK)" : field.references ? " (FK)" : "";
      parts.push(`<text x="${p.x + 10}" y="${y}" fill="#334155">${escapeXml(field.name)}</text>`);
      parts.push(
        `<text x="${p.x + p.w - 10}" y="${y}" text-anchor="end" fill="#64748b">${escapeXml(field.type + marker)}</text>`
      );
    });
  });

  parts.push("</svg>");
  return parts.join("\n");
}
