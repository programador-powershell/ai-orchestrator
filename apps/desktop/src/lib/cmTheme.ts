/**
 * Tema de sintaxe do editor da aba Code.
 *
 * O editor rodava só com `basicSetup`, que embute o `defaultHighlightStyle` do
 * CodeMirror — uma paleta desenhada para fundo CLARO (`#219` em palavra-chave,
 * `#164` em nome, `#a11` em texto). Sobre o painel do tema escuro (`#1f1f1f`)
 * isso fica praticamente ilegível: azul-marinho quase preto sobre quase preto.
 * Ninguém tinha escolhido essa paleta; ela era o que vinha de fábrica.
 *
 * Aqui as cores saem dos tokens `--term-syn-*`, que trocam com o tema do app —
 * então o mesmo `HighlightStyle` serve claro e escuro, sem recriar a view.
 *
 * `basicSetup` registra o estilo padrão como `fallback`, e um `HighlightStyle`
 * não-fallback tem precedência sobre ele: basta ACRESCENTAR este depois.
 */
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

/** Papel → token do tema. Nenhuma cor literal mora aqui. */
const syntaxStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword], color: "var(--term-syn-keyword)" },
  { tag: [tags.operatorKeyword, tags.definitionKeyword], color: "var(--term-syn-keyword)" },
  { tag: [tags.string, tags.special(tags.string), tags.character], color: "var(--term-syn-string)" },
  { tag: [tags.number, tags.integer, tags.float, tags.bool, tags.null], color: "var(--term-syn-number)" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "var(--term-syn-comment)", fontStyle: "italic" },
  { tag: tags.docComment, color: "var(--term-syn-comment)" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "var(--term-syn-func)" },
  { tag: [tags.definition(tags.variableName), tags.definition(tags.function(tags.variableName))], color: "var(--term-syn-func)" },
  { tag: [tags.typeName, tags.className, tags.namespace], color: "var(--term-syn-type)" },
  { tag: [tags.propertyName, tags.labelName], color: "var(--term-syn-prop)" },
  { tag: [tags.operator, tags.compareOperator, tags.logicOperator, tags.arithmeticOperator], color: "var(--term-syn-operator)" },
  { tag: [tags.punctuation, tags.separator, tags.bracket], color: "var(--term-syn-punct)" },
  { tag: [tags.tagName, tags.angleBracket], color: "var(--term-syn-tag)" },
  { tag: [tags.attributeName], color: "var(--term-syn-attr)" },
  { tag: [tags.attributeValue], color: "var(--term-syn-string)" },
  { tag: [tags.variableName, tags.name], color: "var(--term-syn-var)" },
  { tag: [tags.constant(tags.variableName), tags.standard(tags.variableName)], color: "var(--term-syn-number)" },
  { tag: [tags.meta, tags.annotation, tags.processingInstruction], color: "var(--term-syn-meta)" },
  { tag: [tags.regexp, tags.escape], color: "var(--term-syn-meta)" },
  { tag: tags.link, color: "var(--term-link)", textDecoration: "underline" },
  { tag: tags.url, color: "var(--term-link)" },
  { tag: tags.invalid, color: "var(--term-syn-invalid)" },
  { tag: tags.deleted, color: "var(--term-diff-del-fg)" },
  { tag: tags.inserted, color: "var(--term-diff-add-fg)" },
  { tag: tags.changed, color: "var(--term-command)" },
  /* Markdown — o app abre muito .md */
  { tag: [tags.heading, tags.heading1, tags.heading2], color: "var(--term-model)", fontWeight: "600" },
  { tag: [tags.heading3, tags.heading4], color: "var(--term-system)", fontWeight: "600" },
  { tag: [tags.heading5, tags.heading6], color: "var(--term-gray-bright)", fontWeight: "600" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "650" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: [tags.monospace, tags.contentSeparator], color: "var(--term-syn-type)" },
  { tag: [tags.list, tags.quote], color: "var(--term-fg-dim)" }
]);

/** Extensão pronta para entrar na lista do EditorView. */
export const codeSyntaxTheme = syntaxHighlighting(syntaxStyle);
