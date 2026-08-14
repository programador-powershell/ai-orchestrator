/**
 * Converte `assets/icons/**.svg` no módulo de glifos do app.
 *
 * A saída é VERSIONADA e o gerador não roda no build: SVG-como-componente
 * exigiria uma dependência nova (homologação de TI/SI) e uma regra de loader
 * no Next; JSX inline não precisa de nenhum dos dois e some no tree-shaking
 * quando o glifo não é usado.
 *
 * Uso: `node scripts/gen-icons.mjs`
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = process.argv[2] ?? resolve(AQUI, "..", "assets", "icons");
const SAIDA = process.argv[3] ?? resolve(AQUI, "..", "apps", "desktop", "src", "components", "icons", "glyphs.tsx");

/** Atributos SVG que mudam de nome em JSX. */
const ATRIBUTOS = {
  "stroke-width": "strokeWidth",
  "stroke-linecap": "strokeLinecap",
  "stroke-linejoin": "strokeLinejoin",
  "stroke-dasharray": "strokeDasharray",
  "stroke-dashoffset": "strokeDashoffset",
  "stroke-opacity": "strokeOpacity",
  "fill-opacity": "fillOpacity",
  "flood-color": "floodColor",
  "flood-opacity": "floodOpacity",
  "fill-rule": "fillRule",
  "clip-rule": "clipRule",
  "clip-path": "clipPath",
  "stop-color": "stopColor",
  "stop-opacity": "stopOpacity",
  "text-anchor": "textAnchor",
  "font-size": "fontSize",
  "font-family": "fontFamily"
};

function listar(dir) {
  const saida = [];
  for (const entrada of readdirSync(dir)) {
    const caminho = join(dir, entrada);
    if (statSync(caminho).isDirectory()) saida.push(...listar(caminho));
    else if (entrada.endsWith(".svg")) saida.push(caminho);
  }
  return saida;
}

function pascal(texto) {
  return texto
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((parte) => parte[0].toUpperCase() + parte.slice(1))
    .join("");
}

/**
 * Converte o miolo do SVG para JSX: renomeia atributos e autofecha as tags.
 *
 * Só serve para glifo achatado (uma camada de <path>/<circle>/<rect>), que é o
 * caso de todo o pacote 24×24. Marcação aninhada — <defs>, <g>, gradiente —
 * ficaria com a tag de fechamento estragada, então o app-icon fica de fora.
 */
function paraJsx(miolo) {
  return miolo
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s(?=[a-z-]+=)([a-z-]+)=/g, (todo, nome) => ` ${ATRIBUTOS[nome] ?? nome}=`)
    // `<tag ...>` vira `<tag ... />`; `</tag>` não casa (começa com barra).
    .replace(/<([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)\s*\/?>/g, "<$1$2 />")
    .split("\n")
    .map((linha) => linha.trim())
    .filter(Boolean)
    .join("\n      ");
}

/**
 * O ícone do APLICATIVO não é glifo: é 512×512, com gradiente e sombra, e o
 * lugar dele é em `assets/app-icon.svg` e `src-tauri/icons`. Fica de fora
 * também porque tem marcação aninhada, que este conversor não trata.
 */
const FORA = new Set(["app/app-icon"]);

const arquivos = listar(RAIZ).sort();
const glifos = [];

for (const arquivo of arquivos) {
  const rel = relative(RAIZ, arquivo).replace(/\\/g, "/").replace(/\.svg$/, "");
  if (FORA.has(rel)) continue;
  const bruto = readFileSync(arquivo, "utf8");
  const abre = bruto.indexOf(">");
  const fecha = bruto.lastIndexOf("</svg>");
  const miolo = bruto.slice(abre + 1, fecha).trim();
  glifos.push({ chave: rel, nome: pascal(rel), jsx: paraJsx(miolo) });
}

const linhas = [];
linhas.push('/* GERADO — não edite à mão. Fonte: pacote de ícones do AI Orchestrator. */');
linhas.push('/* eslint-disable */');
linhas.push("");
linhas.push('import type { ReactElement } from "react";');
linhas.push("");
linhas.push("/** Miolo de cada glifo, na chave `pasta/nome` do pacote. */");
linhas.push("export const glyphs: Record<string, ReactElement> = {");
for (const glifo of glifos) {
  linhas.push(`  "${glifo.chave}": (`);
  linhas.push("    <>");
  linhas.push(`      ${glifo.jsx}`);
  linhas.push("    </>");
  linhas.push("  ),");
}
linhas.push("};");
linhas.push("");
linhas.push("export type GlyphName = keyof typeof glyphs;");
linhas.push("");

writeFileSync(SAIDA, linhas.join("\n"), "utf8");
console.log(`${glifos.length} glifos -> ${SAIDA}`);
console.log(glifos.map((g) => g.chave).join("\n"));
