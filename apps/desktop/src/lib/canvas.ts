/**
 * Canvas editável — promove trechos grandes da resposta a artefatos.
 *
 * Bloco de código longo (>= ARTIFACT_MIN_LINES linhas) e bloco marcado com
 * ```artifact deixam de ser markdown somente-leitura e viram um documento que
 * o usuário edita no painel lateral. Blocos curtos continuam inline.
 *
 * O par extract/replace é a garantia do round-trip: a extração guarda a
 * POSIÇÃO de cada bloco no texto original e a regravação só troca o miolo,
 * preservando cercas, indentação e o resto da mensagem byte a byte.
 */

export type ArtifactKind = "code" | "document";

export interface Artifact {
  id: string;
  kind: ArtifactKind;
  /** Linguagem da cerca ("" quando o modelo não declarou). Só em 'code'. */
  language?: string;
  title: string;
  content: string;
}

/** A partir daqui um bloco de código deixa de caber inline na conversa. */
export const ARTIFACT_MIN_LINES = 20;

const DOCUMENT_TAG = "artifact";

/* ------------------------------ Varredura ------------------------------ */

interface Fence {
  marker: string;
  /** Info da cerca sem as crases, já sem espaços nas pontas ("ts title=..."). */
  info: string;
  /** Índice do início da linha de abertura no markdown original. */
  start: number;
  /** Índice logo após o bloco inteiro (fim da linha de fechamento). */
  end: number;
  /** Linha de abertura crua — reusada quando nada muda (preserva \r). */
  openLine: string;
  /** Quebra após a abertura ("" quando o texto termina na cerca). */
  eol: string;
  content: string;
  /** Quebra final removida do corpo, devolvida na regravação. */
  trailer: string;
  /** Linha de fechamento crua; null enquanto o bloco está aberto (streaming). */
  closeLine: string | null;
}

const OPEN_FENCE = /^(`{3,})[ \t]*(.*?)[ \t]*\r?$/;
const CLOSE_FENCE = /^(`{3,})[ \t]*\r?$/;

const lineEnd = (source: string, from: number) => {
  const index = source.indexOf("\n", from);
  return index < 0 ? source.length : index;
};

const isClosing = (line: string, marker: string) => {
  const match = CLOSE_FENCE.exec(line);
  return !!match && match[1].length >= marker.length;
};

/**
 * Lista as cercas de topo. Blocos aninhados (cerca de 4+ crases contendo uma
 * de 3) são pulados inteiros — o que está dentro pertence ao artefato de fora.
 */
function scanFences(source: string): Fence[] {
  const fences: Fence[] = [];
  let cursor = 0;

  while (cursor < source.length) {
    const openEnd = lineEnd(source, cursor);
    const openLine = source.slice(cursor, openEnd);
    const open = OPEN_FENCE.exec(openLine);
    if (!open) {
      cursor = openEnd + 1;
      continue;
    }

    const marker = open[1];
    const bodyStart = Math.min(openEnd + 1, source.length);
    let closeStart = -1;
    let scan = bodyStart;
    while (scan < source.length) {
      const stop = lineEnd(source, scan);
      if (isClosing(source.slice(scan, stop), marker)) {
        closeStart = scan;
        break;
      }
      scan = stop + 1;
    }

    const body = source.slice(bodyStart, closeStart < 0 ? source.length : closeStart);
    const trailer = /\r?\n$/.exec(body)?.[0] ?? "";
    const closeLine = closeStart < 0 ? null : source.slice(closeStart, lineEnd(source, closeStart));
    const end = closeLine === null ? source.length : closeStart + closeLine.length;

    fences.push({
      marker,
      info: open[2],
      start: cursor,
      end,
      openLine,
      eol: source.slice(openEnd, bodyStart),
      content: trailer ? body.slice(0, -trailer.length) : body,
      trailer,
      closeLine
    });
    cursor = end + 1;
  }

  return fences;
}

/* -------------------------------- Títulos -------------------------------- */

const TITLE_ATTR = /\s*title\s*=\s*(?:"([^"]*)"|'([^']*)')/;
const FILE_NAME = /^[\w@./\\-]+\.[A-Za-z0-9]+$/;
const FILE_COMMENT = /^\s*(?:\/\/|#|--|;|\/\*|\*)\s*([\w@./\\-]+\.[A-Za-z0-9]+)/;
const HEADING = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/;

function parseInfo(info: string): { tag: string; title: string | null } {
  let rest = info.trim();
  let title: string | null = null;

  const attr = TITLE_ATTR.exec(rest);
  if (attr) {
    title = (attr[1] ?? attr[2] ?? "").trim() || null;
    rest = `${rest.slice(0, attr.index)} ${rest.slice(attr.index + attr[0].length)}`.trim();
  }

  const tokens = rest ? rest.split(/\s+/) : [];
  // "```ts src/lib/engine.ts" — o caminho depois da linguagem nomeia o artefato.
  if (!title) title = tokens.slice(1).find((token) => FILE_NAME.test(token)) ?? null;
  return { tag: tokens[0] ?? "", title };
}

function commentTitle(content: string): string | null {
  return FILE_COMMENT.exec(content.split("\n", 1)[0] ?? "")?.[1] ?? null;
}

function headingTitle(content: string): string | null {
  for (const line of content.split("\n")) {
    const heading = HEADING.exec(line);
    if (heading) return heading[1].trim();
  }
  return null;
}

const EXTENSIONS: Record<string, string> = {
  typescript: "ts",
  javascript: "js",
  python: "py",
  rust: "rs",
  csharp: "cs",
  golang: "go",
  ruby: "rb",
  kotlin: "kt",
  markdown: "md",
  yaml: "yml",
  bash: "sh",
  shell: "sh",
  zsh: "sh",
  powershell: "ps1",
  text: "txt",
  plaintext: "txt"
};

/** Extensão real de arquivo para a linguagem da cerca (para salvar/baixar). */
export function languageExtension(language: string | undefined): string {
  const key = (language ?? "").trim().toLowerCase();
  if (!key) return "txt";
  return EXTENSIONS[key] ?? (/^[a-z0-9+#]{1,10}$/.test(key) ? key : "txt");
}

const slug = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** Nome de arquivo sugerido ao salvar o artefato. */
export function artifactFileName(artifact: Artifact): string {
  const title = artifact.title.trim();
  if (artifact.kind === "document") return `${slug(title) || "documento"}.md`;
  if (FILE_NAME.test(title)) return title;
  return `${slug(title) || "codigo"}.${languageExtension(artifact.language)}`;
}

/* ------------------------------- Extração ------------------------------- */

const countLines = (content: string) => (content ? content.split("\n").length : 0);

interface Candidate {
  fence: Fence;
  artifact: Artifact;
}

function collect(markdown: string): Candidate[] {
  const candidates: Candidate[] = [];

  for (const fence of scanFences(markdown)) {
    const { tag, title } = parseInfo(fence.info);
    const isDocument = tag.toLowerCase() === DOCUMENT_TAG;
    if (!isDocument && countLines(fence.content) < ARTIFACT_MIN_LINES) continue;

    const id = `artifact-${candidates.length}`;
    const artifact: Artifact = isDocument
      ? {
          id,
          kind: "document",
          title: title ?? headingTitle(fence.content) ?? "Documento",
          content: fence.content
        }
      : {
          id,
          kind: "code",
          language: tag,
          title: title ?? commentTitle(fence.content) ?? `codigo.${languageExtension(tag)}`,
          content: fence.content
        };
    candidates.push({ fence, artifact });
  }

  return candidates;
}

/** Artefatos editáveis presentes na mensagem, na ordem em que aparecem. */
export function extractArtifacts(markdown: string): Artifact[] {
  return collect(markdown).map((candidate) => candidate.artifact);
}

/* ------------------------------ Regravação ------------------------------ */

/** Evita que uma cerca colada dentro do conteúdo feche o bloco antes da hora. */
function growMarker(marker: string, content: string): string {
  let longest = 0;
  for (const line of content.split("\n")) {
    const run = /^\s{0,3}(`{3,})/.exec(line)?.[1].length ?? 0;
    if (run > longest) longest = run;
  }
  return longest >= marker.length ? "`".repeat(longest + 1) : marker;
}

function withLanguage(info: string, language: string): string {
  const trimmed = info.trim();
  if (!trimmed) return language;
  if (!language) return trimmed.replace(/^\S+\s*/, "");
  return trimmed.replace(/^\S+/, () => language);
}

function renderFence(fence: Fence, artifact: Artifact): string {
  const marker = growMarker(fence.marker, artifact.content);
  const info = artifact.kind === "code" ? withLanguage(fence.info, artifact.language ?? "") : fence.info;
  const open = marker === fence.marker && info === fence.info ? fence.openLine : `${marker}${info}`;
  const close = fence.closeLine === null ? "" : marker === fence.marker ? fence.closeLine : marker;
  const body = artifact.content ? `${artifact.content}${fence.trailer}` : "";
  return `${open}${fence.eol}${body}${close}`;
}

/**
 * Devolve o markdown com o conteúdo atual dos artefatos. Ids desconhecidos são
 * ignorados; o casamento é posicional, então sempre regrave a partir do MESMO
 * markdown de onde os artefatos saíram.
 */
export function replaceArtifacts(markdown: string, artifacts: Artifact[]): string {
  if (!artifacts.length) return markdown;
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));

  let out = "";
  let cursor = 0;
  for (const { fence, artifact } of collect(markdown)) {
    const next = byId.get(artifact.id);
    if (!next) continue;
    out += markdown.slice(cursor, fence.start) + renderFence(fence, next);
    cursor = fence.end;
  }
  return out + markdown.slice(cursor);
}
