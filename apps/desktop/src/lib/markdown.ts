/**
 * Parser Markdown próprio e seguro — produz tokens, nunca HTML bruto.
 * Cobre o que respostas de modelo usam: títulos, parágrafos, listas,
 * código (inline e cercado), negrito/itálico, links, citações, tabelas e hr.
 */

export type InlineToken =
  | { kind: "text"; text: string }
  | { kind: "bold"; children: InlineToken[] }
  | { kind: "italic"; children: InlineToken[] }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string };

export type BlockToken =
  | { kind: "heading"; level: number; children: InlineToken[] }
  | { kind: "paragraph"; children: InlineToken[] }
  | { kind: "code"; language: string; text: string }
  | { kind: "list"; ordered: boolean; items: InlineToken[][] }
  | { kind: "quote"; children: InlineToken[] }
  | { kind: "table"; header: InlineToken[][]; rows: InlineToken[][][] }
  | { kind: "hr" };

const INLINE_PATTERN = /(\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))/;

export function parseInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let rest = text;
  while (rest.length) {
    const match = INLINE_PATTERN.exec(rest);
    if (!match || match.index === undefined) {
      tokens.push({ kind: "text", text: rest });
      break;
    }
    if (match.index > 0) tokens.push({ kind: "text", text: rest.slice(0, match.index) });
    if (match[2] !== undefined) tokens.push({ kind: "bold", children: parseInline(match[2]) });
    else if (match[3] !== undefined) tokens.push({ kind: "italic", children: parseInline(match[3]) });
    else if (match[4] !== undefined) tokens.push({ kind: "code", text: match[4] });
    else if (match[5] !== undefined && match[6] !== undefined)
      tokens.push({ kind: "link", text: match[5], href: match[6] });
    rest = rest.slice(match.index + match[0].length);
  }
  return tokens;
}

function parseTableRow(line: string): InlineToken[][] {
  return line
    .replace(/^\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((cell) => parseInline(cell.trim()));
}

const isTableDivider = (line: string) => /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

export function parseMarkdown(source: string): BlockToken[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: BlockToken[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const language = fence[1] ?? "";
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1; // fecha a cerca
      blocks.push({ kind: "code", language, text: body.join("\n") });
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length, children: parseInline(heading[2]) });
      index += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push({ kind: "hr" });
      index += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const body: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        body.push(lines[index].replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push({ kind: "quote", children: parseInline(body.join(" ")) });
      continue;
    }

    const listMatch = /^(\s*)([-*]|\d+[.)])\s+/.exec(line);
    if (listMatch) {
      const ordered = /\d/.test(listMatch[2]);
      const items: InlineToken[][] = [];
      while (index < lines.length) {
        const item = /^(\s*)([-*]|\d+[.)])\s+(.*)$/.exec(lines[index]);
        if (!item) break;
        items.push(parseInline(item[3]));
        index += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    if (line.includes("|") && index + 1 < lines.length && isTableDivider(lines[index + 1])) {
      const header = parseTableRow(line);
      index += 2;
      const rows: InlineToken[][][] = [];
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        rows.push(parseTableRow(lines[index]));
        index += 1;
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }

    // Parágrafo: agrega linhas até a próxima em branco ou início de outro bloco.
    const body: string[] = [line];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^(#{1,4})\s/.test(lines[index]) &&
      !/^```/.test(lines[index]) &&
      !/^>\s?/.test(lines[index]) &&
      !/^(\s*)([-*]|\d+[.)])\s+/.test(lines[index])
    ) {
      body.push(lines[index]);
      index += 1;
    }
    blocks.push({ kind: "paragraph", children: parseInline(body.join("\n")) });
  }

  return blocks;
}
