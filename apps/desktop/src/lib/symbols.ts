/**
 * Índice de símbolos do repositório — sem LSP, sem servidor de linguagem.
 *
 * Não há um LSP homologado para embarcar (instrução nº 4: dependência nova vai
 * a TI/SI antes de entrar), então o índice é escrito aqui. Ele não substitui um
 * analisador semântico — não resolve tipos nem referências — mas responde as
 * duas perguntas que o editor precisa fazer o tempo todo:
 *
 * - **onde está `X`?** (ir para símbolo, em qualquer arquivo aberto)
 * - **o que existe em volta do cursor?** (contexto para o completar por modelo)
 *
 * O escaneamento é por LINHA, de propósito: expressão regular multilinha até
 * casaria mais construções, mas perderia o número da linha — e um "ir para
 * símbolo" que cai na linha errada é pior que não ter.
 *
 * Coberto por symbols.test.ts.
 */

export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "struct"
  | "trait"
  | "impl"
  | "constant"
  | "variable"
  | "table"
  | "view"
  | "heading";

export interface CodeSymbol {
  name: string;
  kind: SymbolKind;
  /** Caminho do arquivo, como veio da árvore do projeto. */
  file: string;
  /** 1-based, para casar com o `revealLine` do editor. */
  line: number;
  /** Recuo em espaços — usado para aninhar o outline. */
  indent: number;
  /** Símbolo que contém este (classe do método, impl do método Rust). */
  container?: string;
  /** True quando o símbolo é exportado/público. */
  exported: boolean;
}

/* --------------------------- Detecção por linha --------------------------- */

/** Largura de tabulação usada para medir recuo — só precisa ser consistente. */
const TAB_WIDTH = 4;

export function indentOf(line: string): number {
  let width = 0;
  for (const char of line) {
    if (char === " ") width += 1;
    else if (char === "\t") width += TAB_WIDTH;
    else break;
  }
  return width;
}

interface Rule {
  re: RegExp;
  kind: SymbolKind;
  /** Índice do grupo com o nome; 1 quando omitido. */
  group?: number;
}

/**
 * TypeScript/JavaScript.
 *
 * A ordem importa: `export default function` precisa casar antes da regra
 * genérica de `function`, senão o nome sairia como "default".
 */
const TS_RULES: Rule[] = [
  { re: /^\s*(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
  { re: /^\s*(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: "interface" },
  { re: /^\s*(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/, kind: "type" },
  { re: /^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: "enum" },
  {
    re: /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
    kind: "function"
  },
  // `const nome = (…) =>` e `const nome = function(…)` — o padrão do projeto.
  {
    re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/,
    kind: "function"
  },
  { re: /^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=/, kind: "constant" },
  { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/, kind: "variable" }
];

/**
 * Método de classe. Roda só quando há um container aberto, porque o padrão
 * `nome(args) {` também casa com uma chamada de função seguida de bloco.
 */
const TS_METHOD =
  /^\s*(?:public\s+|private\s+|protected\s+|readonly\s+|static\s+|abstract\s+|override\s+|async\s+|get\s+|set\s+|\*)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^;]*$/;

const PY_RULES: Rule[] = [
  { re: /^\s*class\s+([A-Za-z_][\w]*)/, kind: "class" },
  { re: /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)/, kind: "function" },
  { re: /^([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=/, kind: "constant" }
];

const RS_RULES: Rule[] = [
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:const\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_][\w]*)/, kind: "function" },
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_][\w]*)/, kind: "struct" },
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_][\w]*)/, kind: "enum" },
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_][\w]*)/, kind: "trait" },
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?type\s+([A-Za-z_][\w]*)/, kind: "type" },
  // `impl Trait for Tipo` e `impl Tipo` — o nome útil é sempre o do TIPO.
  { re: /^\s*impl(?:\s*<[^>]*>)?\s+(?:[\w:<>, ']+\s+for\s+)?([A-Za-z_][\w]*)/, kind: "impl" },
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+([A-Z][A-Z0-9_]*)/, kind: "constant" }
];

const SQL_RULES: Rule[] = [
  { re: /^\s*create\s+(?:or\s+replace\s+)?table\s+(?:if\s+not\s+exists\s+)?"?([\w.]+)"?/i, kind: "table" },
  { re: /^\s*create\s+(?:or\s+replace\s+)?view\s+(?:if\s+not\s+exists\s+)?"?([\w.]+)"?/i, kind: "view" },
  { re: /^\s*create\s+(?:or\s+replace\s+)?function\s+"?([\w.]+)"?/i, kind: "function" }
];

const MD_RULE: Rule = { re: /^(#{1,6})\s+(.+?)\s*#*$/, kind: "heading", group: 2 };

type Dialect = "ts" | "py" | "rs" | "sql" | "md" | "none";

export function dialectOf(fileName: string): Dialect {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"].includes(ext)) return "ts";
  if (ext === "py") return "py";
  if (ext === "rs") return "rs";
  if (ext === "sql") return "sql";
  if (ext === "md" || ext === "markdown") return "md";
  return "none";
}

/**
 * Remove os comentários de bloco que ABREM E FECHAM na mesma linha.
 *
 * Sem isto, `/* nota *\/ export function real() {}` seria descartada inteira —
 * a linha começa com `/*` — e a declaração sumiria do índice.
 */
function stripInlineBlock(line: string): string {
  return line.replace(/\/\*[^]*?\*\//g, " ");
}

/** Linha que só tem comentário — nomes ali não são símbolos. */
function isComment(line: string, dialect: Dialect): boolean {
  const trimmed = line.trimStart();
  if (dialect === "py") return trimmed.startsWith("#");
  if (dialect === "sql") return trimmed.startsWith("--");
  if (dialect === "md") return false;
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

/**
 * Extrai os símbolos de um arquivo.
 *
 * Ignora o interior de blocos de comentário `/* … *\/` e de docstrings Python:
 * exemplo em comentário é a fonte clássica de símbolo fantasma no índice.
 */
export function extractSymbols(file: string, text: string): CodeSymbol[] {
  const dialect = dialectOf(file);
  if (dialect === "none") return [];
  const rules =
    dialect === "ts" ? TS_RULES : dialect === "py" ? PY_RULES : dialect === "rs" ? RS_RULES : dialect === "sql" ? SQL_RULES : [MD_RULE];

  const found: CodeSymbol[] = [];
  /** Pilha de containers abertos: [nome, recuo]. */
  const stack: Array<{ name: string; indent: number }> = [];
  let inBlockComment = false;
  let docstring: string | null = null;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    // Comentário de bloco fechado na própria linha sai antes de tudo; o que
    // sobra é código de verdade.
    const line = dialect === "ts" || dialect === "rs" ? stripInlineBlock(lines[i]) : lines[i];

    // Docstring Python: tudo dentro dela é texto, não código.
    if (dialect === "py") {
      if (docstring) {
        if (line.includes(docstring)) docstring = null;
        continue;
      }
      const opener = /(?:^|\s)("""|''')/.exec(line);
      if (opener) {
        const mark = opener[1];
        const rest = line.slice(line.indexOf(mark) + mark.length);
        if (!rest.includes(mark)) {
          docstring = mark;
          continue;
        }
      }
    }

    if (dialect === "ts" || dialect === "rs") {
      if (inBlockComment) {
        if (line.includes("*/")) inBlockComment = false;
        continue;
      }
      const open = line.indexOf("/*");
      if (open >= 0 && !line.includes("*/", open)) {
        inBlockComment = true;
        continue;
      }
    }

    if (isComment(line, dialect)) continue;

    const indent = dialect === "md" ? (MD_RULE.re.exec(line)?.[1].length ?? 1) - 1 : indentOf(line);
    // Fecha os containers cujo bloco terminou (o recuo voltou).
    while (stack.length && indent <= stack[stack.length - 1].indent) stack.pop();

    let matched = false;
    for (const rule of rules) {
      const hit = rule.re.exec(line);
      if (!hit) continue;
      const name = hit[rule.group ?? 1];
      if (!name) continue;
      const container = stack.length ? stack[stack.length - 1].name : undefined;
      // Função dentro de classe é método — o rótulo muda a leitura do outline.
      const kind: SymbolKind = container && rule.kind === "function" ? "method" : rule.kind;
      found.push({
        name,
        kind,
        file,
        line: i + 1,
        indent,
        container,
        exported: /^\s*(?:export\b|pub\b)/.test(line) || dialect === "py" || dialect === "sql" || dialect === "md"
      });
      if (opensBlock(kind)) stack.push({ name, indent });
      matched = true;
      break;
    }

    // Método de classe só é procurado dentro de um container aberto: fora
    // dele, `algumaCoisa(...) {` é chamada de função, não declaração.
    if (!matched && dialect === "ts" && stack.length) {
      const hit = TS_METHOD.exec(line);
      const name = hit?.[1];
      // `if (…)` e afins casam com o padrão; a lista de palavras reservadas é
      // o que separa um método de um bloco de controle.
      if (name && !TS_KEYWORDS.has(name)) {
        found.push({
          name,
          kind: "method",
          file,
          line: i + 1,
          indent,
          container: stack[stack.length - 1].name,
          exported: false
        });
      }
    }
  }
  return found;
}

const TS_KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "function",
  "constructor",
  "do",
  "else",
  "typeof",
  "await",
  "new",
  "super",
  "this",
  "import",
  "require"
]);

/** Só estes tipos abrem escopo para os símbolos seguintes. */
function opensBlock(kind: SymbolKind): boolean {
  return kind === "class" || kind === "impl" || kind === "trait" || kind === "interface" || kind === "heading";
}

/* ------------------------------ Índice ------------------------------ */

export interface SymbolIndex {
  symbols: CodeSymbol[];
  /** Arquivos que entraram no índice, para saber o que já foi visto. */
  files: string[];
}

export const EMPTY_INDEX: SymbolIndex = { symbols: [], files: [] };

export function buildIndex(files: Array<{ path: string; text: string }>): SymbolIndex {
  const symbols: CodeSymbol[] = [];
  const seen: string[] = [];
  for (const entry of files) {
    symbols.push(...extractSymbols(entry.path, entry.text));
    seen.push(entry.path);
  }
  return { symbols, files: seen };
}

/**
 * Substitui um arquivo no índice sem reindexar o resto.
 *
 * Reindexar o projeto a cada tecla é o que faz um índice virar travamento;
 * trocar só o arquivo editado mantém o custo proporcional ao arquivo.
 */
export function reindexFile(index: SymbolIndex, path: string, text: string): SymbolIndex {
  const symbols = index.symbols.filter((symbol) => symbol.file !== path).concat(extractSymbols(path, text));
  const files = index.files.includes(path) ? index.files : [...index.files, path];
  return { symbols, files };
}

export function removeFile(index: SymbolIndex, path: string): SymbolIndex {
  if (!index.files.includes(path)) return index;
  return {
    symbols: index.symbols.filter((symbol) => symbol.file !== path),
    files: index.files.filter((entry) => entry !== path)
  };
}

/* ------------------------------ Consulta ------------------------------ */

/**
 * Pontua um símbolo para a busca.
 *
 * Prefixo exato ganha de subsequência: quem digita `useD` quer `useDesign`,
 * não `useIsDarkMode` só porque as letras aparecem na ordem.
 */
export function scoreSymbol(symbol: CodeSymbol, query: string): number {
  const name = symbol.name.toLowerCase();
  const needle = query.toLowerCase();
  if (!needle) return 0;
  let score = 0;
  if (name === needle) score = 1000;
  else if (name.startsWith(needle)) score = 700 - name.length;
  else if (name.includes(needle)) score = 400 - name.length;
  else if (subsequence(name, needle)) score = 150 - name.length;
  else return -1;
  // Exportado aparece antes: é o que o resto do projeto consegue usar.
  if (symbol.exported) score += 40;
  // Declaração de topo antes de método aninhado.
  if (!symbol.container) score += 20;
  return score;
}

function subsequence(haystack: string, needle: string): boolean {
  let at = 0;
  for (const char of haystack) {
    if (char === needle[at]) at += 1;
    if (at === needle.length) return true;
  }
  return at === needle.length;
}

export function searchSymbols(index: SymbolIndex, query: string, limit = 30): CodeSymbol[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  return index.symbols
    .map((symbol) => ({ symbol, score: scoreSymbol(symbol, trimmed) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score || a.symbol.name.localeCompare(b.symbol.name))
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.symbol);
}

/**
 * Símbolo que contém a linha informada.
 *
 * Percorre de trás para frente procurando a última declaração ANTES do cursor
 * — a de menor recuo entre as candidatas é a mais externa.
 */
export function enclosingSymbol(index: SymbolIndex, file: string, line: number): CodeSymbol | null {
  const doArquivo = index.symbols.filter((symbol) => symbol.file === file && symbol.line <= line);
  if (!doArquivo.length) return null;
  return doArquivo.reduce((melhor, atual) => (atual.line > melhor.line ? atual : melhor));
}

/** Outline com aninhamento por container, na ordem em que aparecem. */
export interface OutlineEntry {
  symbol: CodeSymbol;
  depth: number;
}

export function outlineOf(index: SymbolIndex, file: string): OutlineEntry[] {
  return index.symbols
    .filter((symbol) => symbol.file === file)
    .sort((a, b) => a.line - b.line)
    .map((symbol) => ({ symbol, depth: symbol.container ? 1 : 0 }));
}
