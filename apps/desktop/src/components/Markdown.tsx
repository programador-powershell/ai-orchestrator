/**
 * Renderização Markdown segura (tokens → elementos React; nunca innerHTML).
 * Blocos de código têm rótulo de linguagem e botão copiar — paridade ChatGPT.
 */
import { memo, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { type BlockToken, type InlineToken } from "../lib/markdown";
import { createIncrementalMarkdown } from "../lib/markdownStream";

function renderInline(tokens: InlineToken[], keyPrefix = ""): ReactNode[] {
  return tokens.map((token, index) => {
    const key = `${keyPrefix}${index}`;
    switch (token.kind) {
      case "text":
        return <span key={key}>{token.text}</span>;
      case "bold":
        return <strong key={key}>{renderInline(token.children, `${key}-`)}</strong>;
      case "italic":
        return <em key={key}>{renderInline(token.children, `${key}-`)}</em>;
      case "code":
        return (
          <code className="md-inline-code" key={key}>
            {token.text}
          </code>
        );
      case "link":
        return (
          <a
            key={key}
            href={token.href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => {
              event.preventDefault();
              window.open(token.href, "_blank", "noopener,noreferrer");
            }}
          >
            {token.text}
          </a>
        );
    }
  });
}

function CodeBlock({ language, text }: { language: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="md-code">
      <header>
        <span>{language || "texto"}</span>
        <button
          onClick={() => {
            void navigator.clipboard?.writeText(text).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1600);
            });
          }}
          aria-label="Copiar código"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? "copiado" : "copiar"}
        </button>
      </header>
      <pre>{text}</pre>
    </div>
  );
}

function renderBlock(block: BlockToken, index: number): ReactNode {
  switch (block.kind) {
    case "heading": {
      const children = renderInline(block.children, `h${index}-`);
      if (block.level === 1) return <h2 key={index}>{children}</h2>;
      if (block.level === 2) return <h3 key={index}>{children}</h3>;
      return <h4 key={index}>{children}</h4>;
    }
    case "paragraph":
      return <p key={index}>{renderInline(block.children, `p${index}-`)}</p>;
    case "code":
      return <CodeBlock key={index} language={block.language} text={block.text} />;
    case "list": {
      const items = block.items.map((item, itemIndex) => (
        <li key={itemIndex}>{renderInline(item, `l${index}-${itemIndex}-`)}</li>
      ));
      return block.ordered ? <ol key={index}>{items}</ol> : <ul key={index}>{items}</ul>;
    }
    case "quote":
      return <blockquote key={index}>{renderInline(block.children, `q${index}-`)}</blockquote>;
    case "hr":
      return <hr key={index} />;
    case "table":
      return (
        <div className="md-table-wrap" key={index}>
          <table>
            <thead>
              <tr>
                {block.header.map((cell, cellIndex) => (
                  <th key={cellIndex}>{renderInline(cell, `th${index}-${cellIndex}-`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex}>{renderInline(cell, `td${index}-${rowIndex}-${cellIndex}-`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

/**
 * Memoizado por `source` (só a mensagem que cresce re-renderiza) E incremental:
 * os blocos já fechados ficam em cache e apenas a CAUDA é re-parseada a cada
 * delta. Sem as duas coisas, streaming de resposta longa vira O(n²) e trava.
 */
export const Markdown = memo(function Markdown({ source }: { source: string }) {
  const incremental = useRef(createIncrementalMarkdown());
  const blocks = useMemo(() => incremental.current.parse(source), [source]);
  return <div className="md-root">{blocks.map(renderBlock)}</div>;
});
