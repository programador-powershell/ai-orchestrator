/**
 * Vocabulário do laboratório de avatares: as listas de opções com rótulo em
 * português, o sorteio determinístico e o exportador para arquivo.
 *
 * A geometria NÃO mora aqui — mora no motor (`BotAvatar.tsx`). Este arquivo só
 * serializa o que aquele monta. Redesenhar o retrato numa segunda função seria
 * garantir que um dia o SVG baixado deixasse de ser o SVG da tela.
 */

import type { Avatar } from "@aibot/contracts";
import { avatarKey, buildAvatarCss, buildAvatarNodes, mulberry32, type SvgNode } from "./BotAvatar";

/* -------------------------------- as listas ------------------------------ */

/** Uma opção de parâmetro: o valor do contrato e como ela se chama na tela. */
export interface AvatarOption<T extends string> {
  value: T;
  label: string;
}

export const SHAPES: readonly AvatarOption<Avatar["shape"]>[] = [
  { value: "orb", label: "Orbe" },
  { value: "squircle", label: "Quadrado macio" },
  { value: "hex", label: "Hexágono" },
  { value: "shield", label: "Escudo" },
  { value: "bloom", label: "Flor" },
  { value: "chip", label: "Chip" }
];

export const EYES: readonly AvatarOption<Avatar["eyes"]>[] = [
  { value: "dot", label: "Pontos" },
  { value: "arc", label: "Arcos" },
  { value: "visor", label: "Viseira" },
  { value: "spark", label: "Faíscas" },
  { value: "scan", label: "Varredura" },
  { value: "ring", label: "Anéis" }
];

export const MOUTHS: readonly AvatarOption<Avatar["mouth"]>[] = [
  { value: "none", label: "Sem boca" },
  { value: "line", label: "Traço" },
  { value: "smile", label: "Sorriso" },
  { value: "wave", label: "Onda" },
  { value: "grid", label: "Grade" }
];

export const ACCESSORIES: readonly AvatarOption<Avatar["accessory"]>[] = [
  { value: "none", label: "Nenhum" },
  { value: "antenna", label: "Antena" },
  { value: "halo", label: "Halo" },
  { value: "bolt", label: "Raio" },
  { value: "glasses", label: "Óculos" },
  { value: "crown", label: "Coroa" },
  { value: "shield", label: "Escudo" }
];

export const MOTIONS: readonly AvatarOption<Avatar["motion"]>[] = [
  { value: "idle", label: "Parado" },
  { value: "breathe", label: "Respiração" },
  { value: "pulse", label: "Pulso" },
  { value: "scan", label: "Varredura" },
  { value: "orbit", label: "Órbita" }
];

/* -------------------------------- o sorteio ------------------------------ */

/**
 * Sorteia um retrato inteiro a partir da semente.
 *
 * O matiz entra por fora porque ele é IDENTIDADE do especialista, não enfeite:
 * sortear a cor faria o bot de segurança sair verde. A saturação varia numa
 * faixa estreita para nenhum resultado sair lavado nem fluorescente.
 */
export function randomAvatar(seed: number, hue: number): Avatar {
  const rnd = mulberry32(seed >>> 0);

  return {
    seed,
    // O sorteio consome o PRNG na ordem em que os campos aparecem — mudar a
    // ordem muda o resultado de toda semente já usada.
    shape: pick(SHAPES, rnd(), "orb"),
    eyes: pick(EYES, rnd(), "dot"),
    mouth: pick(MOUTHS, rnd(), "smile"),
    accessory: pick(ACCESSORIES, rnd(), "none"),
    motion: pick(MOTIONS, rnd(), "idle"),
    hue: ((Math.round(hue) % 360) + 360) % 360,
    saturation: 52 + Math.floor(rnd() * 26)
  };
}

/** O `fallback` existe só para o tipo: as listas acima nunca estão vazias. */
function pick<T extends string>(list: readonly AvatarOption<T>[], roll: number, fallback: T): T {
  return list[Math.floor(roll * list.length)]?.value ?? fallback;
}

/* ------------------------------ a exportação ----------------------------- */

/** Atributos que o XML escreve exatamente como estão (camelCase é o nome real). */
const PRESERVE = new Set([
  "viewBox",
  "gradientUnits",
  "gradientTransform",
  "clipPathUnits",
  "preserveAspectRatio"
]);

/** camelCase do React de volta ao dialeto do XML: strokeWidth -> stroke-width. */
function xmlAttrName(name: string): string {
  if (name === "className") return "class";
  if (PRESERVE.has(name)) return name;
  return name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function nodeToString(node: SvgNode): string {
  const attrs = Object.entries(node.attrs)
    .map(([name, value]) => ` ${xmlAttrName(name)}="${escapeAttr(String(value))}"`)
    .join("");
  const inner = node.text
    ? escapeText(node.text)
    : (node.children ?? []).map(nodeToString).join("");
  if (!inner) return `<${node.tag}${attrs}/>`;
  return `<${node.tag}${attrs}>${inner}</${node.tag}>`;
}

/**
 * O mesmo retrato da tela, como texto — para o botão "Baixar SVG".
 *
 * Sai autossuficiente: `xmlns` (senão o arquivo solto não renderiza fora do
 * HTML) e o `<style>` junto, para o avatar exportado continuar animando e
 * continuar respeitando `prefers-reduced-motion` em quem o abrir. Aqui a chave
 * de instância e a de parâmetros são a mesma: o arquivo tem um avatar só, e
 * assim dois downloads do mesmo retrato dão bytes idênticos.
 */
export function avatarToSvg(avatar: Avatar, size: number): string {
  const key = avatarKey(avatar);
  const body = buildAvatarNodes(avatar, key, key).map(nodeToString).join("");
  const css = buildAvatarCss(avatar, key);
  const style = css ? `<style>${css}</style>` : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"` +
    ` width="${Math.round(size)}" height="${Math.round(size)}" role="img">` +
    `${style}${body}</svg>`
  );
}
