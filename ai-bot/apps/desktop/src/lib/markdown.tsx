/**
 * Markdown mínimo, escrito à mão.
 *
 * Por que não uma biblioteca: a política de TI/SI da casa fixa a lista de
 * dependências permitidas, e nenhum renderizador de markdown está nela. O
 * subconjunto que o modelo realmente usa em respostas de chat é pequeno —
 * parágrafo, ênfase, código, lista, título, link, tabela GFM, citação e régua
 * — e cabe em um arquivo auditável. O que fica FORA, de propósito: HTML cru
 * (nunca), imagem, nota de rodapé e escape de `\|` dentro de tabela.
 *
 * Por que NUNCA `dangerouslySetInnerHTML`: o texto vem de um modelo de
 * linguagem e pode conter markup (inclusive `<script>` vindo de um arquivo que
 * o especialista leu). Montando elementos React, o escape é do próprio React e
 * não depende de sanitizador nenhum. Esta é uma regra, não uma preferência.
 */

import { useEffect, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";

/* --------------------------------- inline -------------------------------- */

/**
 * A ordem da alternação é a precedência: crase primeiro, para que
 * `**isto**` dentro de código continue literal; depois o link; depois
 * `**forte**`; por último `*ênfase*`, que é o padrão mais frouxo.
 *
 * O ESQUEMA do link mora NA REGEX de propósito: só `https?://` e `mailto:`
 * viram `<a>`. Um `[x](javascript:...)` simplesmente não casa e fica como
 * texto — esta é a sanitização, e ela não depende de nenhuma checagem depois.
 */
const INLINE_SOURCE =
  "`([^`]+)`|\\[([^\\]\\n]+)\\]\\((https?://[^\\s)]+|mailto:[^\\s)]+)\\)|\\*\\*([\\s\\S]+?)\\*\\*|\\*([^*\\n]+)\\*";

/**
 * A regex é criada a cada chamada de propósito. Uma constante com a flag `g`
 * compartilhada quebraria a recursão: a chamada de dentro (para o conteúdo do
 * negrito) mexeria no `lastIndex` do laço de fora e o texto sairia picotado.
 */
function renderInline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = new RegExp(INLINE_SOURCE, "g");
  let last = 0;
  let n = 0;

  let match = re.exec(text);
  while (match !== null) {
    if (match.index > last) out.push(text.slice(last, match.index));

    const code = match[1];
    const linkLabel = match[2];
    const linkHref = match[3];
    const strong = match[4];
    const emphasis = match[5];

    if (code !== undefined) {
      out.push(
        <code className="md-code" key={`${key}-c${n}`}>
          {code}
        </code>
      );
    } else if (linkLabel !== undefined && linkHref !== undefined) {
      // target _blank + noopener: o app é uma WebView — navegar a própria
      // janela para um site trocaria o AI-BOT inteiro pela página do link.
      out.push(
        <a
          className="md-link"
          key={`${key}-a${n}`}
          href={linkHref}
          target="_blank"
          rel="noopener noreferrer"
        >
          {renderInline(linkLabel, `${key}-a${n}`)}
        </a>
      );
    } else if (strong !== undefined) {
      out.push(<strong key={`${key}-s${n}`}>{renderInline(strong, `${key}-s${n}`)}</strong>);
    } else if (emphasis !== undefined) {
      out.push(<em key={`${key}-e${n}`}>{renderInline(emphasis, `${key}-e${n}`)}</em>);
    }

    last = match.index + match[0].length;
    n += 1;
    match = re.exec(text);
  }

  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * Quebra simples dentro do parágrafo vira `<br>`.
 *
 * O markdown clássico juntaria as linhas num parágrafo só, mas resposta de
 * modelo usa a quebra simples com intenção (endereço, verso, item solto). Colar
 * tudo numa linha corrompe o sentido do texto com mais frequência do que
 * respeitar a quebra atrapalha.
 */
function softBreaks(lines: string[], key: string): ReactNode[] {
  const out: ReactNode[] = [];
  lines.forEach((line, index) => {
    if (index > 0) out.push(<br key={`${key}-br${index}`} />);
    out.push(...renderInline(line, `${key}-l${index}`));
  });
  return out;
}

/* ------------------------------ bloco de código --------------------------- */

function CodeBlock({ code, lang }: { code: string; lang: string }): ReactNode {
  const [copied, setCopied] = useState(false);

  // O "copiado" se apaga sozinho; o efeito existe só para limpar o timer se o
  // bloco sair da tela antes (a conversa rola e desmonta linhas o tempo todo).
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(timer);
  }, [copied]);

  function copy(): void {
    // Em contexto não seguro o clipboard não existe; aí o botão simplesmente
    // não confirma, em vez de estourar dentro do render da conversa.
    void navigator.clipboard?.writeText(code).then(
      () => setCopied(true),
      () => setCopied(false)
    );
  }

  return (
    <div className="md-fence">
      <div className="md-fence-bar">
        <span className="md-fence-lang">{lang || "texto"}</span>
        <button
          type="button"
          className="md-fence-copy"
          onClick={copy}
          title={copied ? "copiado" : "copiar o bloco"}
          aria-label={copied ? "copiado" : "copiar o bloco"}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          <span>{copied ? "copiado" : "copiar"}</span>
        </button>
      </div>
      <pre className="md-pre">
        <code>{code}</code>
      </pre>
    </div>
  );
}

/* --------------------------- cercas de protocolo -------------------------- */

/**
 * As cercas de MÁQUINA do protocolo do gateway. O modelo emite
 * ```aibot:tool / ```aibot:delegate para chamar ferramenta e delegar; o
 * gateway as tira das mensagens duráveis (stripBlocks em delegate.go), mas os
 * DELTAS chegam crus — o texto streama token a token, cerca inclusa. Sem este
 * filtro do lado de cá, a bolha ao vivo mostrava o JSON do protocolo como
 * bloco de código: na raiz quando o modelo só chamou ferramenta (a mensagem
 * final com `visible == ""` nunca vem substituir o acumulado) e na janela da
 * filha durante o sub-turno delegado.
 *
 * `aibot:plan` fica FORA de propósito, espelhando o stripBlocks do gateway: o
 * plano é para a pessoa ler e aprovar — escondê-lo tiraria da tela exatamente
 * o que o cartão de aprovação pede para julgar.
 */
export function ehCercaDeProtocolo(lang: string): boolean {
  // Sensível a caixa DE PROPÓSITO, espelhando o parser do gateway: uma cerca
  // grafada errado (AIBOT:TOOL) nunca executa nem é limpa lá — escondê-la
  // aqui mascararia exatamente o erro do modelo que a pessoa precisa ver.
  const nome = lang.trim();
  return nome === "aibot:tool" || nome === "aibot:delegate";
}

/**
 * O texto SEM os blocos de protocolo — o gêmeo textual do filtro do parser,
 * para quem espelha texto fora do markdown (o composer cli, por exemplo).
 * Cerca ABERTA no fim (streaming interrompido, resposta truncada) também cai:
 * meio JSON de protocolo não é menos máquina que o JSON inteiro.
 */
export function semCercasDeProtocolo(text: string): string {
  const lines = normalize(text).split("\n");
  const out: string[] = [];
  let dentroDeProtocolo = false;
  let dentroDeCerca = false;
  for (const line of lines) {
    if (dentroDeProtocolo) {
      if (RE_FENCE_END.test(line)) dentroDeProtocolo = false;
      continue;
    }
    if (dentroDeCerca) {
      if (RE_FENCE_END.test(line)) dentroDeCerca = false;
      out.push(line);
      continue;
    }
    const fence = RE_FENCE.exec(line);
    if (fence) {
      if (ehCercaDeProtocolo(fence[2] ?? "")) {
        dentroDeProtocolo = true;
        continue;
      }
      dentroDeCerca = true;
    }
    out.push(line);
  }
  return out.join("\n");
}

/* --------------------------------- blocos -------------------------------- */

const RE_FENCE = /^\s*(`{3,})(.*)$/;
const RE_FENCE_END = /^\s*`{3,}\s*$/;
const RE_HEADING = /^(#{1,3})\s+(.+)$/;
const RE_BULLET = /^\s*[-*]\s+(.+)$/;
const RE_ORDERED = /^\s*(\d{1,9})[.)]\s+(.+)$/;
/** Régua horizontal. Não colide com a lista: `- item` exige espaço e conteúdo. */
const RE_HR = /^\s*(?:-{3,}|_{3,}|\*{3,})\s*$/;
const RE_QUOTE = /^\s*>\s?(.*)$/;
/**
 * Linha que PODE ser de tabela: exige o pipe de abertura de propósito. O GFM
 * aceita tabela sem ele, mas aí qualquer frase com `|` no meio viraria
 * candidata — e o custo de exigir é zero, porque modelo escreve tabela com as
 * bordas.
 */
const RE_TABLE_LINE = /^\s*\|/;

/** Fatia uma linha de tabela em células. Sem escape de `\|` — subconjunto declarado. */
function splitRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|")) body = body.slice(0, -1);
  return body.split("|").map((cell) => cell.trim());
}

/** A linha separadora do cabeçalho: `| --- | :---: |`. É ela que faz tabela ser tabela. */
function isTableDelim(line: string): boolean {
  if (!RE_TABLE_LINE.test(line)) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

/** Uma tabela começa quando a linha é de tabela E a seguinte é o separador. */
function isTableStart(lines: string[], index: number): boolean {
  return RE_TABLE_LINE.test(lines[index] ?? "") && isTableDelim(lines[index + 1] ?? "");
}

/** O alinhamento que o separador pediu; `undefined` é a esquerda do CSS. */
function alignOf(cell: string): "center" | "right" | undefined {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  return undefined;
}

/**
 * O que interrompe um parágrafo. Espelha EXATAMENTE os desvios do laço de
 * blocos — se os dois divergirem, uma linha que o laço trata como bloco entra
 * no parágrafo anterior (ou o contrário) e o laço trava sem consumir nada. A
 * tabela precisa da linha SEGUINTE (só o separador a torna tabela), por isso a
 * assinatura recebe o índice e não a linha.
 */
function startsBlock(lines: string[], index: number): boolean {
  const line = lines[index] ?? "";
  return (
    RE_FENCE.test(line) ||
    RE_HEADING.test(line) ||
    RE_HR.test(line) ||
    RE_QUOTE.test(line) ||
    RE_BULLET.test(line) ||
    RE_ORDERED.test(line) ||
    isTableStart(lines, index)
  );
}

/** Título com nível variável sem `any`: o mapa fecha o tipo do elemento. */
function heading(level: number, content: ReactNode[], key: string): ReactNode {
  if (level === 1) {
    return (
      <h1 className="md-h1" key={key}>
        {content}
      </h1>
    );
  }
  if (level === 2) {
    return (
      <h2 className="md-h2" key={key}>
        {content}
      </h2>
    );
  }
  return (
    <h3 className="md-h3" key={key}>
      {content}
    </h3>
  );
}

/** CRLF e CR soltos viram LF antes de qualquer coisa; o resto do parser só vê `\n`. */
function normalize(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/**
 * O laço de blocos, com o contador de chave vindo de FORA.
 *
 * `firstKey` existe para o parse incremental: um trecho parseado depois, em
 * separado, precisa continuar a numeração de onde o anterior parou — senão as
 * chaves se repetem e o React remonta os blocos (perdendo, entre outras coisas,
 * o "copiado" do bloco de código) a cada token.
 *
 * Invariante que o parse incremental depende: nó empurrado e chave andam
 * SEMPRE juntos (um push, um incremento), então `nodes.length` é quantas
 * chaves o trecho consumiu. A cerca de protocolo respeita a invariante pelo
 * outro lado: não empurra nó E não anda a chave.
 */
function parseBlocks(lines: string[], firstKey: number): ReactNode[] {
  const blocks: ReactNode[] = [];
  let i = 0;
  let k = firstKey;

  while (i < lines.length) {
    const raw = lines[i] ?? "";

    const fence = RE_FENCE.exec(raw);
    if (fence) {
      const lang = (fence[2] ?? "").trim();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !RE_FENCE_END.test(lines[i] ?? "")) {
        body.push(lines[i] ?? "");
        i += 1;
      }
      // Passa da cerca de fechamento. Se ela não veio, o texto ainda está
      // chegando por streaming — renderiza o que há em vez de esperar, senão o
      // bloco só aparece quando a resposta termina.
      i += 1;
      // Cerca de PROTOCOLO não vira bloco nenhum: é máquina, não fala — o
      // registro visível da chamada é o ToolStrip/popup, alimentado pelos
      // envelopes. Pular sem incrementar a chave mantém a invariante do parse
      // incremental: `blocks.length` continua sendo quantas chaves o trecho
      // consumiu.
      if (ehCercaDeProtocolo(lang)) continue;
      blocks.push(<CodeBlock key={`b${k}`} code={body.join("\n")} lang={lang} />);
      k += 1;
      continue;
    }

    if (raw.trim() === "") {
      i += 1;
      continue;
    }

    const title = RE_HEADING.exec(raw);
    if (title) {
      const level = (title[1] ?? "#").length;
      blocks.push(heading(level, renderInline(title[2] ?? "", `b${k}`), `b${k}`));
      k += 1;
      i += 1;
      continue;
    }

    if (RE_HR.test(raw)) {
      blocks.push(<hr className="md-hr" key={`b${k}`} />);
      k += 1;
      i += 1;
      continue;
    }

    if (RE_QUOTE.test(raw)) {
      // Junta as linhas contíguas de `>` e reparseia o MIOLO: citação carrega
      // parágrafos, listas e até outra citação. As chaves internas recomeçam
      // do zero de propósito — elas são filhas do blockquote, um espaço de
      // irmãos próprio, e o contador de fora anda UMA vez (a invariante do
      // parse incremental é por nó empurrado aqui fora).
      const inner: string[] = [];
      while (i < lines.length) {
        const quoted = RE_QUOTE.exec(lines[i] ?? "");
        if (!quoted) break;
        inner.push(quoted[1] ?? "");
        i += 1;
      }
      blocks.push(
        <blockquote className="md-quote" key={`b${k}`}>
          {parseBlocks(inner, 0)}
        </blockquote>
      );
      k += 1;
      continue;
    }

    if (isTableStart(lines, i)) {
      const header = splitRow(raw);
      const aligns = splitRow(lines[i + 1] ?? "").map(alignOf);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && RE_TABLE_LINE.test(lines[i] ?? "") && !isTableDelim(lines[i] ?? "")) {
        rows.push(splitRow(lines[i] ?? ""));
        i += 1;
      }
      // As linhas do corpo são NORMALIZADAS à largura do cabeçalho (célula a
      // mais cai, a menos vira vazia), como no GFM: uma linha torta do modelo
      // não pode desalinhar as colunas da tabela inteira.
      blocks.push(
        <div className="md-table-wrap" key={`b${k}`}>
          <table className="md-table">
            <thead>
              <tr>
                {header.map((cell, column) => (
                  <th
                    key={`b${k}-h${column}`}
                    style={aligns[column] ? { textAlign: aligns[column] } : undefined}
                  >
                    {renderInline(cell, `b${k}-h${column}`)}
                  </th>
                ))}
              </tr>
            </thead>
            {rows.length > 0 ? (
              <tbody>
                {rows.map((row, index) => (
                  <tr key={`b${k}-r${index}`}>
                    {header.map((_, column) => (
                      <td
                        key={`b${k}-r${index}c${column}`}
                        style={aligns[column] ? { textAlign: aligns[column] } : undefined}
                      >
                        {renderInline(row[column] ?? "", `b${k}-r${index}c${column}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            ) : null}
          </table>
        </div>
      );
      k += 1;
      continue;
    }

    if (RE_BULLET.test(raw)) {
      const items: string[] = [];
      while (i < lines.length) {
        const item = RE_BULLET.exec(lines[i] ?? "");
        if (!item) break;
        items.push(item[1] ?? "");
        i += 1;
      }
      blocks.push(
        <ul className="md-ul" key={`b${k}`}>
          {items.map((item, index) => (
            <li key={`b${k}-i${index}`}>{renderInline(item, `b${k}-i${index}`)}</li>
          ))}
        </ul>
      );
      k += 1;
      continue;
    }

    const ordered = RE_ORDERED.exec(raw);
    if (ordered) {
      const start = Number.parseInt(ordered[1] ?? "1", 10);
      const items: string[] = [];
      while (i < lines.length) {
        const item = RE_ORDERED.exec(lines[i] ?? "");
        if (!item) break;
        items.push(item[2] ?? "");
        i += 1;
      }
      blocks.push(
        <ol className="md-ol" start={Number.isFinite(start) ? start : 1} key={`b${k}`}>
          {items.map((item, index) => (
            <li key={`b${k}-i${index}`}>{renderInline(item, `b${k}-i${index}`)}</li>
          ))}
        </ol>
      );
      k += 1;
      continue;
    }

    const paragraph: string[] = [];
    while (i < lines.length) {
      const current = lines[i] ?? "";
      if (current.trim() === "" || startsBlock(lines, i)) break;
      paragraph.push(current);
      i += 1;
    }
    blocks.push(
      <p className="md-p" key={`b${k}`}>
        {softBreaks(paragraph, `b${k}`)}
      </p>
    );
    k += 1;
  }

  return blocks;
}

export function renderMarkdown(text: string): ReactNode {
  return <>{parseBlocks(normalize(text).split("\n"), 0)}</>;
}

/* ------------------------------ parse incremental ------------------------- */

/**
 * Um parse que cresce com o texto, para o caminho de streaming.
 *
 * O PORQUÊ: chamar `renderMarkdown` sobre o acumulado a cada token é O(m²) no
 * tamanho da resposta — a última fatia reparseia os 8 KB inteiros, e o custo por
 * token cresce junto com a resposta, que é exatamente quando a interface precisa
 * ficar leve. Aqui o custo por token passa a depender só do bloco em curso.
 *
 * O truque: markdown é feito de BLOCOS, e um bloco já fechado não muda mais
 * quando chega texto novo. Os nós dos blocos fechados ficam guardados (as MESMAS
 * referências de elemento, então o React nem os revisita) e só a CAUDA — o bloco
 * ainda sendo escrito — é reparseada.
 *
 * A ARMADILHA DO FORMATO, e a razão de o selo ser uma máquina de estado em vez
 * de um `split("\n\n")`: uma cerca de código aberta ENGOLE linha em branco. Se
 * linha em branco valesse como fim de bloco dentro da cerca, um bloco de código
 * com parágrafos sairia partido em vários `<pre>` no meio do streaming e voltaria
 * a ser um só quando a cerca fechasse — o texto piscando enquanto o modelo
 * escreve. Por isso a cauda só fecha quando a cerca fecha.
 */
export interface MarkdownStream {
  /** Aplica mais um pedaço e devolve a árvore do acumulado. */
  push(chunk: string): ReactNode;
  /** O texto já entregue, como veio (sem normalizar) — o chamador compara com ele. */
  readonly text: string;
}

/**
 * Até onde a cauda pode ser considerada fechada, em caracteres.
 *
 * Só três lugares são fronteira segura, e cada um por um motivo diferente:
 *
 *  - linha em branco: todo bloco de texto (parágrafo, lista, item) PARA nela, então
 *    o que veio antes não muda mais, aconteça o que acontecer depois;
 *  - linha que fecha uma cerca: o bloco de código termina ali, por definição;
 *  - título: consome uma linha e só.
 *
 * O que NÃO é fronteira: uma linha comum. "A\nB" é um parágrafo só com quebra no
 * meio — selar depois de "A" partiria o parágrafo em dois e a árvore deixaria de
 * bater com a do parse de uma vez.
 *
 * Só linha TERMINADA (com o `\n` presente) conta: a última linha ainda pode
 * crescer e virar outra coisa.
 */
function sealPoint(tail: string): number {
  let cut = 0;
  let at = 0;
  let inFence = false;

  for (;;) {
    const eol = tail.indexOf("\n", at);
    if (eol < 0) break;
    const line = tail.slice(at, eol);
    at = eol + 1;

    // A ordem espelha a do parser: cerca antes de tudo. Uma linha só é título
    // ou linha em branco se não estiver dentro de uma cerca.
    if (inFence) {
      if (RE_FENCE_END.test(line)) {
        inFence = false;
        cut = at;
      }
      continue;
    }
    if (RE_FENCE.test(line)) {
      inFence = true;
      continue;
    }
    if (line.trim() === "" || RE_HEADING.test(line)) cut = at;
  }

  return cut;
}

export function createMarkdownStream(): MarkdownStream {
  /** O que foi entregue, cru — é o que o `text` devolve. */
  let raw = "";
  /** O mesmo texto com as quebras normalizadas; é sobre ele que o parse anda. */
  let normalized = "";
  /**
   * Um `\r` no fim do pedaço fica retido: ele pode ser a primeira metade de um
   * CRLF partido entre dois deltas, e normalizar cedo viraria DUAS quebras onde
   * o parse de uma vez só veria uma. Se o texto acabar num `\r` solto, ele se
   * perde — e não muda nada, porque quebra no fim do texto não gera bloco.
   */
  let heldCR = false;

  /** Os nós dos blocos já fechados, na ordem. */
  const sealed: ReactNode[] = [];
  /** Onde a cauda começa dentro de `normalized`. */
  let sealedAt = 0;
  /** Próxima chave livre — continua a numeração do parse de uma vez só. */
  let nextKey = 0;

  return {
    get text(): string {
      return raw;
    },

    push(chunk: string): ReactNode {
      if (chunk !== "") {
        raw += chunk;
        let piece = heldCR ? `\r${chunk}` : chunk;
        heldCR = piece.endsWith("\r");
        if (heldCR) piece = piece.slice(0, -1);
        normalized += normalize(piece);
      }

      const tail = normalized.slice(sealedAt);
      const cut = sealPoint(tail);
      if (cut > 0) {
        const closed = parseBlocks(tail.slice(0, cut).split("\n"), nextKey);
        for (const node of closed) sealed.push(node);
        nextKey += closed.length;
        sealedAt += cut;
      }

      const open = parseBlocks(normalized.slice(sealedAt).split("\n"), nextKey);
      // Os nós selados entram por REFERÊNCIA: elemento idêntico faz o React
      // pular a subárvore inteira na reconciliação, sem nem chamar o componente.
      return <>{[...sealed, ...open]}</>;
    }
  };
}

/**
 * O último bloco cercado de um texto — o editor usa para "aplicar sugestão".
 * Cerca de protocolo não conta: "aplicar" um `aibot:tool` colaria o JSON de
 * máquina no buffer da pessoa como se fosse a sugestão de código.
 */
export function lastFencedBlock(text: string): string {
  const re = /```([^\n]*)\n([\s\S]*?)```/g;
  let found = "";
  let match = re.exec(text);
  while (match !== null) {
    if (!ehCercaDeProtocolo(match[1] ?? "")) found = match[2] ?? "";
    match = re.exec(text);
  }
  return found;
}
