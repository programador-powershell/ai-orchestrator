/**
 * Markdown mínimo, escrito à mão.
 *
 * Por que não uma biblioteca: a política de TI/SI da casa fixa a lista de
 * dependências permitidas, e nenhum renderizador de markdown está nela. O
 * subconjunto que o modelo realmente usa em respostas de chat é pequeno —
 * parágrafo, ênfase, código, lista e título — e cabe em um arquivo auditável.
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
 * `**isto**` dentro de código continue literal; depois `**forte**`; por último
 * `*ênfase*`, que é o padrão mais frouxo.
 */
const INLINE_SOURCE = "`([^`]+)`|\\*\\*([\\s\\S]+?)\\*\\*|\\*([^*\\n]+)\\*";

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
    const strong = match[2];
    const emphasis = match[3];

    if (code !== undefined) {
      out.push(
        <code className="md-code" key={`${key}-c${n}`}>
          {code}
        </code>
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

/* --------------------------------- blocos -------------------------------- */

const RE_FENCE = /^\s*(`{3,})(.*)$/;
const RE_FENCE_END = /^\s*`{3,}\s*$/;
const RE_HEADING = /^(#{1,3})\s+(.+)$/;
const RE_BULLET = /^\s*[-*]\s+(.+)$/;
const RE_ORDERED = /^\s*(\d{1,9})[.)]\s+(.+)$/;

function startsBlock(line: string): boolean {
  return RE_FENCE.test(line) || RE_HEADING.test(line) || RE_BULLET.test(line) || RE_ORDERED.test(line);
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
 * Invariante que o parse incremental depende: cada volta do laço empurra
 * EXATAMENTE um nó e incrementa a chave uma vez, então `nodes.length` é quantas
 * chaves o trecho consumiu.
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
      if (current.trim() === "" || startsBlock(current)) break;
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

/** O último bloco cercado de um texto — o editor usa para "aplicar sugestão". */
export function lastFencedBlock(text: string): string {
  const re = /```[^\n]*\n([\s\S]*?)```/g;
  let found = "";
  let match = re.exec(text);
  while (match !== null) {
    found = match[1] ?? "";
    match = re.exec(text);
  }
  return found;
}
