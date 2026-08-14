/**
 * Ícones do app — um traço só para o produto inteiro.
 *
 * O projeto usa `lucide-react` desde o começo e continua usando: trocar 500
 * chamadas de `<X/>` e `<Plus/>` por outro pacote seria risco sem ganho. Estes
 * glifos entram onde o lucide não tem equivalente — MCP, gateway, chaveiro,
 * política, sandbox, ERD, fusão, BYOK — e nas abas, onde o desenho próprio faz
 * a barra de módulos parecer de um app só, e não uma colagem.
 *
 * Todos são 24×24 com `currentColor` e traço 1.5, igual ao lucide: herdam cor e
 * tamanho do contexto sem ajuste.
 */

import type { ReactNode, SVGProps } from "react";

import { FILLED_GLYPHS, glyphs, type GlyphName } from "./glyphs";

export type { GlyphName };
export { glyphs, FILLED_GLYPHS };

/**
 * Como um ícone é usado no app: recebe tamanho e classe, devolve o desenho.
 *
 * Existe para os mapas que misturam glifo próprio e lucide (a navegação das
 * Configurações, por exemplo). Tipar por `typeof AlgumIconeDoLucide` amarrava
 * a lista ao `ForwardRefExoticComponent` da biblioteca, e um componente
 * simples deixava de servir — sem que houvesse diferença nenhuma no uso.
 */
export type IconComponent = (props: { size?: number; className?: string }) => ReactNode;

export interface GlyphProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: GlyphName;
  size?: number;
  strokeWidth?: number;
}

/**
 * Renderiza um glifo pelo caminho no pacote (`"features/mcp"`).
 *
 * O pacote tem DUAS famílias e elas pedem tratamento oposto: o glifo de
 * contorno é `fill="none" stroke="currentColor"`; o de SILHUETA é
 * `fill="currentColor"` e nenhum contorno — os filhos dele não repetem o
 * `fill`, herdam da raiz. Desenhar silhueta com `fill="none"` traça o
 * contorno da silhueta, que parece ícone quebrado e não ícone errado.
 *
 * `FILLED_GLYPHS` é gerado a partir da tag raiz de cada asset, então a
 * classificação não pode divergir do desenho.
 *
 * Nome desconhecido devolve nada em vez de quebrar a tela: um ícone ausente é
 * um detalhe, e derrubar a aba inteira por causa dele seria desproporcional.
 */
export function Glyph({ name, size = 16, strokeWidth = 1.5, ...rest }: GlyphProps) {
  const conteudo = glyphs[name];
  if (!conteudo) return null;
  const silhueta = FILLED_GLYPHS.has(name);
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={silhueta ? "currentColor" : "none"}
      stroke={silhueta ? "none" : "currentColor"}
      strokeWidth={silhueta ? undefined : strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      /* O nome vai para o DOM: é o que deixa o CSS animar UM glifo em
         particular (o nó do MCP piscando, a chave girando) sem que o
         componente precise saber que existe animação. */
      data-glyph={name}
      {...rest}
    >
      {conteudo}
    </svg>
  );
}

/** Fábrica para usar um glifo como componente fixo: `const Mcp = glyph("features/mcp")`. */
export function glyph(name: GlyphName) {
  function Icone(props: Omit<GlyphProps, "name">) {
    return <Glyph name={name} {...props} />;
  }
  Icone.displayName = `Glyph(${name})`;
  return Icone;
}

/**
 * Ícone de cada aba.
 *
 * `fluxo` usa o glifo de DAG: o pacote não traz um ícone de fluxo, e o grafo de
 * três nós é literalmente o que a aba desenha.
 */
export const modeIcons = {
  chat: glyph("tabs/chat"),
  code: glyph("tabs/code"),
  design: glyph("tabs/design"),
  data: glyph("tabs/data"),
  work: glyph("tabs/work"),
  security: glyph("tabs/security"),
  agent: glyph("tabs/agent"),
  fluxo: glyph("features/dag"),
  office: glyph("tabs/office"),
  tune: glyph("tabs/tune")
} as const;

/** Variante preenchida da aba ativa, quando existe no pacote. */
export const modeIconsFilled = {
  chat: glyph("filled/tabs/chat"),
  code: glyph("filled/tabs/code"),
  design: glyph("filled/tabs/design"),
  data: glyph("filled/tabs/data"),
  work: glyph("filled/tabs/work"),
  security: glyph("filled/tabs/security"),
  agent: glyph("filled/tabs/agent"),
  fluxo: glyph("features/dag"),
  office: glyph("filled/tabs/office"),
  tune: glyph("filled/tabs/tune")
} as const;
