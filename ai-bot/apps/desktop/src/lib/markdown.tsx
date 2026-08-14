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

export function renderMarkdown(text: string): ReactNode {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let k = 0;

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

  return <>{blocks}</>;
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
