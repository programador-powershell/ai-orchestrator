"use client";

/**
 * Renderiza uma linha COM as cores que o programa pediu.
 *
 * A aba "Assistido" da Code mostrava a saída como texto cru: `parseAnsi` e
 * `cor256` existiam em `lib/ansi.ts`, com testes, e não eram chamados por
 * ninguém. Na prática, `git status`, `npm`, `cargo`, `docker` — qualquer
 * ferramenta que colore — despejavam `ESC[32m` visível no meio da frase, e a
 * cor semântica da linha (`k-output`, `k-stderr`) era tudo o que existia.
 *
 * Aqui cada trecho vira um `<span>` com o estilo do próprio programa. A cor
 * dos 16 tons básicos sai como `var(--ansi-N)`, resolvida pela paleta do
 * terminal — a mesma que o emulador da aba Shell usa —, então trocar entre
 * claro e escuro não passa por este componente.
 */

import { memo, type CSSProperties } from "react";

import { parseAnsi, type AnsiStyle } from "../lib/ansi";

function estilo(style: AnsiStyle): CSSProperties | undefined {
  const css: CSSProperties = {};
  /*
   * Vídeo reverso troca frente e fundo AQUI, e não no CSS.
   *
   * Sem a troca, `ESC[7m` (o destaque que `grep --color` e o `less` usam para
   * o termo encontrado) não aparecia de jeito nenhum: a regra `filter:
   * invert()` inverteria também a cor herdada quando o programa só definiu
   * uma das duas.
   */
  const fg = style.inverse ? (style.bg ?? "var(--term-bg)") : style.fg;
  const bg = style.inverse ? (style.fg ?? "var(--term-fg)") : style.bg;
  if (fg) css.color = fg;
  if (bg) css.background = bg;
  if (style.bold) css.fontWeight = 600;
  if (style.dim) css.opacity = 0.65;
  if (style.italic) css.fontStyle = "italic";
  // `underline` e `strike` podem vir juntos — `textDecoration` aceita os dois.
  const decoracao = [style.underline ? "underline" : "", style.strike ? "line-through" : ""]
    .filter(Boolean)
    .join(" ");
  if (decoracao) css.textDecoration = decoracao;
  return Object.keys(css).length ? css : undefined;
}

/**
 * O byte que abre toda sequência (0x1B), escrito como ESCAPE.
 *
 * Literal, ele some ao passar por editor, shell ou copiar-e-colar — e sumindo,
 * a comparação vira `includes("")`, que é verdadeira para qualquer texto: o
 * atalho pegaria SEMPRE, nenhuma cor seria interpretada, e não haveria erro
 * nenhum para denunciar.
 */
const ESC = "\u001b";

export const AnsiText = memo(function AnsiText({ text }: { text: string }) {
  // Linha sem escape nenhum é o caso comum: sai como texto, sem `<span>` a
  // mais para o React reconciliar a cada linha do scrollback.
  if (!text.includes(ESC)) return <>{text}</>;

  const { spans } = parseAnsi(text);
  return (
    <>
      {spans.map((span, indice) => {
        const css = estilo(span.style);
        return css ? (
          <span key={indice} style={css}>
            {span.text}
          </span>
        ) : (
          <span key={indice}>{span.text}</span>
        );
      })}
    </>
  );
});
