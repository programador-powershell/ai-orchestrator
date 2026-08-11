/**
 * Export de imagem do ERD como SVG puro (string building, sem DOM nem
 * dependência externa). Layout em grade determinística de 3 colunas: um
 * retângulo por tabela (cabeçalho com o nome + lista de campos) e uma linha
 * ligando as tabelas de cada relação/FK. Coberto por erdSvg.test.ts.
 */
import type { SchemaDocExt } from "./schema";

const COLS = 3;
const MARGIN = 24;
const CARD_W = 210;
const GAP_X = 46;
const GAP_Y = 40;
const HEADER_H = 26;
const ROW_H = 20;

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

/** Posiciona as tabelas numa grade de 3 colunas; cada linha usa a altura do card mais alto. */
function placeTables(doc: SchemaDocExt): Placed[] {
  const placed: Placed[] = [];
  let rowTop = MARGIN;
  for (let start = 0; start < doc.tables.length; start += COLS) {
    const row = doc.tables.slice(start, start + COLS);
    let rowHeight = 0;
    row.forEach((table, col) => {
      const h = cardHeight(table.fields.length);
      const x = MARGIN + col * (CARD_W + GAP_X);
      placed.push({ name: table.name, x, y: rowTop, w: CARD_W, h, cx: x + CARD_W / 2, cy: rowTop + h / 2 });
      rowHeight = Math.max(rowHeight, h);
    });
    rowTop += rowHeight + GAP_Y;
  }
  return placed;
}

/** Renderiza o documento de schema como um SVG string autocontido. */
export function renderErdSvg(doc: SchemaDocExt): string {
  const placed = placeTables(doc);
  const byName = new Map(placed.map((p) => [p.name, p]));

  const usedCols = Math.min(COLS, Math.max(1, doc.tables.length));
  const width = MARGIN * 2 + usedCols * CARD_W + (usedCols - 1) * GAP_X;
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
