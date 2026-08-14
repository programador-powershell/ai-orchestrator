/**
 * BotAvatar — o retrato PROCEDURAL dos bots do AI-BOT.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ORIGEM E LIMITE (clean-room)
 *
 * A lista de recursos nasceu de um LEVANTAMENTO FUNCIONAL do "Bible Strong
 * Avatar Lab": um estúdio de avatar 2D PROCEDURAL, no qual o retrato é composto
 * por PARTES escolhidas por PARÂMETRO (forma, olhos, boca, acessório), recebe
 * EXPRESSÃO e ANIMAÇÃO, e pode ser EXPORTADO como SVG.
 *
 * Foi levantado O QUE aquele produto faz — nunca COMO. Nenhuma linha de código,
 * nenhum asset, nenhum caminho de path, nenhuma curva e nenhum parâmetro veio de
 * lá. Toda a geometria, a paleta, o PRNG e as animações abaixo foram escritos do
 * zero para este projeto. Se algum dia surgir dúvida de procedência, a resposta
 * está aqui: implementação limpa a partir da descrição do comportamento.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Por que SVG procedural e não arquivo de imagem: o avatar precisa existir em
 * 20px (toda linha da conversa) e em 96px (o laboratório) com o mesmo desenho,
 * precisa ser exportável como texto, e precisa caber no `Avatar` do contrato —
 * oito números e strings — para viajar no protocolo e persistir no store sem
 * binário nenhum.
 *
 * Este arquivo é o MOTOR: geometria, paleta, PRNG e CSS. O `params.ts` importa
 * daqui para serializar o mesmo desenho como string (`avatarToSvg`) — o desenho
 * é escrito UMA vez só.
 */

import { createElement, useId, useMemo, type ReactElement, type SVGProps } from "react";
import type { Avatar } from "@aibot/contracts";

/* ------------------------------ modelo de nó ----------------------------- */

/**
 * Um nó de SVG neutro: nem JSX nem string.
 *
 * É a peça que permite o desenho existir uma vez e sair em dois formatos — o
 * componente React converte em elemento, o exportador converte em texto. As
 * chaves de `attrs` são camelCase (o dialeto do React); quem serializa para
 * arquivo traduz para o dialeto XML.
 */
export interface SvgNode {
  tag: string;
  attrs: Record<string, string | number>;
  children?: SvgNode[];
  text?: string;
}

/* ---------------------------------- PRNG --------------------------------- */

/**
 * mulberry32 — gerador determinístico de 32 bits, escrito aqui para não
 * depender de biblioteca e, principalmente, para não haver `Math.random` no
 * desenho: mesma semente, mesmo retrato, hoje e no próximo boot. Um avatar que
 * muda sozinho entre execuções deixaria de identificar o especialista, que é a
 * única função dele.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Detalhes pequenos sorteados pela semente — sempre na MESMA ordem de consumo. */
export interface AvatarTraits {
  /** Inclinação da antena, em unidades do viewBox. */
  tilt: number;
  /** Ângulo inicial do ponto em órbita, em graus. */
  orbitStart: number;
}

/**
 * A ordem das chamadas ao PRNG é parte do contrato: trocar a ordem muda o
 * desenho de todo mundo. Por isso os dois valores são sempre sorteados, mesmo
 * quando o acessório ou o movimento não os usam.
 */
export function avatarTraits(avatar: Avatar): AvatarTraits {
  const rnd = mulberry32(avatar.seed >>> 0);
  const tilt = -6 + rnd() * 12;
  const orbitStart = Math.floor(rnd() * 360);
  return { tilt, orbitStart };
}

/* --------------------------------- paleta -------------------------------- */

/** As três paradas do retrato, mais o brilho derivado delas. */
export interface AvatarPalette {
  /** Fundo: a base do corpo. */
  back: string;
  /** Meio: o realce, o topo do gradiente e o miolo dos acessórios. */
  mid: string;
  /** Traço: olhos, boca e contorno. */
  line: string;
  /** Derivado do meio, só para halo e pulso. */
  glow: string;
}

/**
 * A cor sai de `hue`/`saturation` do PRÓPRIO avatar, nunca de `var(--accent)`.
 *
 * O acento do app é do especialista ATIVO; se o retrato herdasse dele, dez bots
 * diferentes apareceriam da mesma cor na mesma conversa e o ícone antes da linha
 * perderia a serventia. As luminosidades foram escolhidas para funcionar contra
 * o claro (#fbfbf9) e contra o escuro (#181818) sem troca de tema.
 */
export function avatarPalette(avatar: Avatar): AvatarPalette {
  const h = ((Math.round(avatar.hue) % 360) + 360) % 360;
  const s = clamp(Math.round(avatar.saturation), 0, 100);
  return {
    back: `hsl(${h} ${s}% 47%)`,
    mid: `hsl(${h} ${Math.min(s + 10, 100)}% 74%)`,
    line: `hsl(${h} ${Math.min(s + 14, 100)}% 16%)`,
    glow: `hsl(${h} ${s}% 62%)`
  };
}

/* -------------------------------- geometria ------------------------------ */

/** Todo o desenho vive num quadrado de 64 — o `size` é só escala do SVG. */
const VIEW = 64;

/** Onde o topo de cada silhueta cai, para pendurar antena, halo e coroa. */
const SHAPE_TOP: Record<Avatar["shape"], number> = {
  orb: 6,
  squircle: 7,
  hex: 4,
  shield: 5,
  bloom: 4,
  chip: 13
};

/** Centro e escala do rosto por silhueta: o rosto se ajusta ao espaço interno. */
const FACE: Record<Avatar["shape"], { cx: number; cy: number; s: number }> = {
  orb: { cx: 32, cy: 31, s: 1 },
  squircle: { cx: 32, cy: 31, s: 0.98 },
  hex: { cx: 32, cy: 33, s: 0.94 },
  shield: { cx: 32, cy: 29, s: 0.9 },
  bloom: { cx: 32, cy: 32, s: 0.72 },
  chip: { cx: 32, cy: 32, s: 0.8 }
};

/** Acessórios que precisam de céu: o corpo encolhe para não estourar o viewBox. */
const NEEDS_HEADROOM = new Set<Avatar["accessory"]>(["antenna", "halo", "crown"]);

const SHIELD_PATH =
  "M32 5 L57 14 L57 32 C57 46 46 55.5 32 59.5 C18 55.5 7 46 7 32 L7 14 Z";

function clamp(n: number, min: number, max: number): number {
  return n < min ? min : n > max ? max : n;
}

/** Três casas bastam e mantêm o SVG exportado legível. */
function r3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function polar(cx: number, cy: number, angleDeg: number, radius: number): string {
  const a = (angleDeg * Math.PI) / 180;
  return `${r3(cx + Math.cos(a) * radius)} ${r3(cy + Math.sin(a) * radius)}`;
}

/** Escala em torno do centro do viewBox, com deslocamento vertical opcional. */
function boxTransform(k: number, dy: number): string {
  if (k === 1 && dy === 0) return "";
  const off = (VIEW / 2) * (1 - k);
  return `translate(${r3(off)} ${r3(off + dy)}) scale(${r3(k)})`;
}

/**
 * A SILHUETA, sem pintura nenhuma.
 *
 * Sai crua de propósito: a mesma geometria vira corpo pintado, vira contorno do
 * brilho de pulso e vira `<clipPath>` da faixa de varredura. Desenhar a silhueta
 * três vezes seria três lugares para desalinhar.
 */
export function shapeGeom(shape: Avatar["shape"]): SvgNode[] {
  switch (shape) {
    case "orb":
      return [{ tag: "circle", attrs: { cx: 32, cy: 32, r: 26 } }];
    case "squircle":
      return [{ tag: "rect", attrs: { x: 7, y: 7, width: 50, height: 50, rx: 17 } }];
    case "hex": {
      const pts: string[] = [];
      for (let i = 0; i < 6; i += 1) pts.push(polar(32, 32, -90 + i * 60, 28));
      return [{ tag: "polygon", attrs: { points: pts.join(" ") } }];
    }
    case "shield":
      return [{ tag: "path", attrs: { d: SHIELD_PATH } }];
    case "bloom": {
      const petals: SvgNode[] = [];
      for (let i = 0; i < 5; i += 1) {
        const a = -90 + i * 72;
        const d =
          `M32 32 C ${polar(32, 32, a - 32, 14)} ${polar(32, 32, a - 26, 26)} ${polar(32, 32, a, 28)}` +
          ` C ${polar(32, 32, a + 26, 26)} ${polar(32, 32, a + 32, 14)} 32 32 Z`;
        petals.push({ tag: "path", attrs: { d } });
      }
      petals.push({ tag: "circle", attrs: { cx: 32, cy: 32, r: 13.5 } });
      return petals;
    }
    case "chip": {
      const nodes: SvgNode[] = [
        { tag: "rect", attrs: { x: 13, y: 13, width: 38, height: 38, rx: 9 } }
      ];
      for (let i = 0; i < 3; i += 1) {
        const y = 19 + i * 11;
        nodes.push({ tag: "rect", attrs: { x: 4, y, width: 10, height: 6, rx: 2.4 } });
        nodes.push({ tag: "rect", attrs: { x: 50, y, width: 10, height: 6, rx: 2.4 } });
      }
      return nodes;
    }
  }
}

/** Estrela de 4 pontas, côncava — o `i` puxa os lados para dentro. */
function starPath(cx: number, cy: number, radius: number): string {
  const i = radius * 0.32;
  return (
    `M${r3(cx)} ${r3(cy - radius)}` +
    ` Q${r3(cx + i)} ${r3(cy - i)} ${r3(cx + radius)} ${r3(cy)}` +
    ` Q${r3(cx + i)} ${r3(cy + i)} ${r3(cx)} ${r3(cy + radius)}` +
    ` Q${r3(cx - i)} ${r3(cy + i)} ${r3(cx - radius)} ${r3(cy)}` +
    ` Q${r3(cx - i)} ${r3(cy - i)} ${r3(cx)} ${r3(cy - radius)} Z`
  );
}

/* ------------------------- rosto (coordenadas locais) -------------------- */
/* O grupo do rosto tem origem no CENTRO do rosto: olhos em y negativo, boca em
   y positivo. Assim cada silhueta só informa centro e escala, e nenhuma peça
   precisa saber em que corpo está desenhada. */

const EYE_Y = -6;
const EYE_DX = 10;

function eyesNodes(avatar: Avatar, p: AvatarPalette, cls: (name: string) => string): SvgNode[] {
  switch (avatar.eyes) {
    case "dot":
      return [
        { tag: "circle", attrs: { cx: -EYE_DX, cy: EYE_Y, r: 4, fill: p.line } },
        { tag: "circle", attrs: { cx: EYE_DX, cy: EYE_Y, r: 4, fill: p.line } },
        // O brilho custa dois círculos e é o que separa "olho" de "furo".
        { tag: "circle", attrs: { cx: -EYE_DX + 1.4, cy: EYE_Y - 1.5, r: 1.2, fill: p.mid, opacity: 0.9 } },
        { tag: "circle", attrs: { cx: EYE_DX + 1.4, cy: EYE_Y - 1.5, r: 1.2, fill: p.mid, opacity: 0.9 } }
      ];
    case "arc": {
      const arc = (cx: number): SvgNode => ({
        tag: "path",
        attrs: {
          d: `M${cx - 5} ${EYE_Y + 2.6} Q${cx} ${EYE_Y - 5.6} ${cx + 5} ${EYE_Y + 2.6}`,
          fill: "none",
          stroke: p.line,
          strokeWidth: 3,
          strokeLinecap: "round"
        }
      });
      return [arc(-EYE_DX), arc(EYE_DX)];
    }
    case "visor":
      return [
        { tag: "rect", attrs: { x: -19, y: EYE_Y - 6, width: 38, height: 12, rx: 6, fill: p.line } },
        { tag: "rect", attrs: { x: -15, y: EYE_Y - 1.2, width: 30, height: 2.4, rx: 1.2, fill: p.mid, opacity: 0.85 } }
      ];
    case "spark":
      return [
        { tag: "path", attrs: { d: starPath(-EYE_DX, EYE_Y, 6.4), fill: p.line } },
        { tag: "path", attrs: { d: starPath(EYE_DX, EYE_Y, 6.4), fill: p.line } }
      ];
    case "scan":
      return [
        { tag: "rect", attrs: { x: -18, y: EYE_Y - 2.5, width: 36, height: 5, rx: 2.5, fill: p.line, opacity: 0.3 } },
        // O traço só desliza quando o movimento é `scan`; fora disso fica parado
        // à esquerda, e a classe existe sem regra que a acione.
        {
          tag: "rect",
          attrs: { x: -18, y: EYE_Y - 2.5, width: 11, height: 5, rx: 2.5, fill: p.line, className: cls("scan") }
        }
      ];
    case "ring": {
      const ring = (cx: number): SvgNode[] => [
        { tag: "circle", attrs: { cx, cy: EYE_Y, r: 5, fill: "none", stroke: p.line, strokeWidth: 2.4 } },
        { tag: "circle", attrs: { cx, cy: EYE_Y, r: 1.7, fill: p.line } }
      ];
      return [...ring(-EYE_DX), ...ring(EYE_DX)];
    }
  }
}

function mouthNodes(avatar: Avatar, p: AvatarPalette): SvgNode[] {
  const stroke = { fill: "none", stroke: p.line, strokeLinecap: "round" as const };
  switch (avatar.mouth) {
    case "none":
      return [];
    case "line":
      return [{ tag: "path", attrs: { d: "M-7 9 L7 9", ...stroke, strokeWidth: 3 } }];
    case "smile":
      return [{ tag: "path", attrs: { d: "M-8 6 Q0 14.5 8 6", ...stroke, strokeWidth: 3 } }];
    case "wave":
      return [{ tag: "path", attrs: { d: "M-9 9 q3 -4.5 6 0 t6 0 t6 0", ...stroke, strokeWidth: 2.6 } }];
    case "grid":
      return [-5, 0, 5].map((x) => ({
        tag: "path",
        attrs: { d: `M${x} 6 L${x} 12`, ...stroke, strokeWidth: 2.4 }
      }));
  }
}

/** Óculos moram no rosto (e não entre os acessórios soltos) para acompanhar os olhos. */
function glassesNodes(p: AvatarPalette): SvgNode[] {
  const frame = { fill: "none", stroke: p.line, strokeWidth: 2.2, strokeLinecap: "round" as const };
  return [
    { tag: "circle", attrs: { cx: -EYE_DX, cy: EYE_Y, r: 7.4, ...frame } },
    { tag: "circle", attrs: { cx: EYE_DX, cy: EYE_Y, r: 7.4, ...frame } },
    { tag: "path", attrs: { d: `M${-EYE_DX + 7.4} ${EYE_Y} L${EYE_DX - 7.4} ${EYE_Y}`, ...frame } },
    { tag: "path", attrs: { d: `M${-EYE_DX - 7.4} ${EYE_Y} L${-EYE_DX - 11} ${EYE_Y - 2}`, ...frame } },
    { tag: "path", attrs: { d: `M${EYE_DX + 7.4} ${EYE_Y} L${EYE_DX + 11} ${EYE_Y - 2}`, ...frame } }
  ];
}

/* ------------------------------ chave de estilo -------------------------- */

function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Chave derivada dos PARÂMETROS (não da instância).
 *
 * Nomes de `@keyframes` e de classe dentro de um `<style>` de SVG embutido valem
 * para o documento INTEIRO — não há escopo. Por isso tudo é prefixado. Usar a
 * chave dos parâmetros faz avatares idênticos gerarem regras idênticas, que se
 * sobrepõem sem efeito colateral; usar a identidade da instância multiplicaria
 * regras diferentes para o mesmo desenho.
 */
export function avatarKey(avatar: Avatar): string {
  const seed = `${avatar.shape}|${avatar.eyes}|${avatar.mouth}|${avatar.accessory}|${avatar.motion}|${avatar.seed}|${avatar.hue}|${avatar.saturation}`;
  return hash32(seed).toString(36);
}

/* -------------------------------- o desenho ------------------------------ */

/**
 * Monta o retrato inteiro.
 *
 * `uid` identifica a INSTÂNCIA (ids de gradiente e de recorte, que precisam ser
 * únicos no documento); `animKey` identifica os PARÂMETROS (classes e keyframes,
 * que podem — e devem — ser compartilhados).
 */
export function buildAvatarNodes(avatar: Avatar, uid: string, animKey: string = uid): SvgNode[] {
  const p = avatarPalette(avatar);
  const traits = avatarTraits(avatar);
  const cls = (name: string): string => `bt-${animKey}-${name}`;
  const gradId = `bt-${uid}-body`;
  const clipId = `bt-${uid}-clip`;

  // Quanto o corpo encolhe e desce para caber acessório e órbita.
  let k = 1;
  let dy = 0;
  if (NEEDS_HEADROOM.has(avatar.accessory)) {
    k = 0.82;
    dy = 6;
  } else if (avatar.accessory === "shield") {
    k = 0.84;
    dy = 1;
  }
  if (avatar.motion === "orbit") k = Math.min(k, 0.84);

  const bodyTransform = boxTransform(k, dy);
  const top = SHAPE_TOP[avatar.shape] * k + (VIEW / 2) * (1 - k) + dy;
  const geom = shapeGeom(avatar.shape);

  const defs: SvgNode[] = [
    {
      tag: "linearGradient",
      // userSpaceOnUse para que pétalas e pinos compartilhem UM gradiente: com o
      // padrão (objectBoundingBox) cada peça recomeçaria a rampa e a flor sairia
      // com cinco tons repetidos.
      attrs: { id: gradId, gradientUnits: "userSpaceOnUse", x1: 32, y1: 4, x2: 32, y2: 60 },
      children: [
        { tag: "stop", attrs: { offset: "0", stopColor: p.mid } },
        { tag: "stop", attrs: { offset: "1", stopColor: p.back } }
      ]
    }
  ];

  const layers: SvgNode[] = [];

  // Escudo do acessório: contorno ATRÁS do corpo (por isso o corpo encolheu).
  if (avatar.accessory === "shield") {
    layers.push({
      tag: "path",
      attrs: {
        d: SHIELD_PATH,
        fill: "none",
        stroke: p.back,
        strokeWidth: 2.6,
        strokeOpacity: 0.7,
        strokeLinejoin: "round"
      }
    });
  }

  // Pulso sem halo continua sendo pulso: um contorno da própria silhueta respira
  // no lugar. Um movimento escolhido que não mexe em nada é um bug de UI.
  if (avatar.motion === "pulse" && avatar.accessory !== "halo") {
    const kg = k * 1.1;
    layers.push({
      tag: "g",
      attrs: { transform: boxTransform(kg, dy), className: cls("pulse") },
      children: geom.map((g) => ({
        tag: g.tag,
        attrs: { ...g.attrs, fill: "none", stroke: p.glow, strokeWidth: r3(2.4 / kg), strokeLinejoin: "round" }
      }))
    });
  }

  const face = FACE[avatar.shape];
  const faceChildren = [...eyesNodes(avatar, p, cls), ...mouthNodes(avatar, p)];
  if (avatar.accessory === "glasses") faceChildren.push(...glassesNodes(p));

  const bodyChildren: SvgNode[] = geom.map((g) => ({
    tag: g.tag,
    attrs: {
      ...g.attrs,
      fill: `url(#${gradId})`,
      stroke: p.line,
      strokeWidth: 1.2,
      strokeOpacity: 0.2,
      strokeLinejoin: "round"
    }
  }));

  // A flor precisa de um miolo mais claro, senão o rosto se perde entre pétalas.
  if (avatar.shape === "bloom") {
    bodyChildren.push({
      tag: "circle",
      attrs: { cx: 32, cy: 32, r: 13.5, fill: p.mid, fillOpacity: 0.5 }
    });
  }

  bodyChildren.push({
    tag: "g",
    attrs: { transform: `translate(${face.cx} ${face.cy}) scale(${face.s})` },
    children: faceChildren
  });

  layers.push({
    tag: "g",
    attrs: bodyTransform ? { transform: bodyTransform } : {},
    children: bodyChildren
  });

  // Varredura sem olho de varredura: uma faixa recortada pela silhueta. O
  // `transform` vai em CADA forma do clipPath porque `<g>` não é filho válido de
  // `<clipPath>`.
  if (avatar.motion === "scan" && avatar.eyes !== "scan") {
    defs.push({
      tag: "clipPath",
      attrs: { id: clipId },
      children: geom.map((g) => ({
        tag: g.tag,
        attrs: bodyTransform ? { ...g.attrs, transform: bodyTransform } : { ...g.attrs }
      }))
    });
    layers.push({
      tag: "g",
      attrs: { clipPath: `url(#${clipId})` },
      children: [
        {
          tag: "rect",
          attrs: { x: 0, y: 0, width: VIEW, height: 4.5, rx: 2.2, fill: p.mid, className: cls("band") }
        }
      ]
    });
  }

  switch (avatar.accessory) {
    case "antenna": {
      const tipX = 32 + traits.tilt;
      const tipY = top - 9.5;
      layers.push({
        tag: "path",
        attrs: {
          d: `M32 ${r3(top)} L${r3(tipX)} ${r3(tipY)}`,
          fill: "none",
          stroke: p.line,
          strokeWidth: 2.2,
          strokeLinecap: "round"
        }
      });
      layers.push({
        tag: "circle",
        attrs: {
          cx: r3(32 + traits.tilt * 1.25),
          cy: r3(tipY - 2.6),
          r: 3.2,
          fill: p.mid,
          stroke: p.line,
          strokeWidth: 1.2
        }
      });
      break;
    }
    case "halo": {
      const attrs: Record<string, string | number> = {
        cx: 32,
        cy: r3(top - 6.5),
        rx: 15,
        ry: 4.6,
        fill: "none",
        stroke: p.glow,
        strokeWidth: 2.8
      };
      if (avatar.motion === "pulse") attrs.className = cls("pulse");
      layers.push({ tag: "ellipse", attrs });
      break;
    }
    case "bolt":
      layers.push({
        tag: "path",
        attrs: {
          d: "M50 4 L42 17 L47 17 L44 28 L54 14 L49 14 Z",
          fill: p.mid,
          stroke: p.line,
          strokeWidth: 1.4,
          strokeLinejoin: "round"
        }
      });
      break;
    case "crown":
      layers.push({
        tag: "path",
        attrs: {
          d:
            `M18 ${r3(top + 1)} L23 ${r3(top - 9)} L27.5 ${r3(top - 1)}` +
            ` L32 ${r3(top - 11)} L36.5 ${r3(top - 1)} L41 ${r3(top - 9)} L46 ${r3(top + 1)} Z`,
          fill: p.mid,
          stroke: p.line,
          strokeWidth: 1.4,
          strokeLinejoin: "round"
        }
      });
      break;
    default:
      break;
  }

  if (avatar.motion === "orbit") {
    // O ângulo inicial entra nos keyframes, e não num `transform` de atributo:
    // animação CSS de `transform` SOBRESCREVE o atributo, e o ponto começaria
    // sempre no mesmo lugar.
    layers.push({
      tag: "g",
      attrs: { className: cls("orbit") },
      children: [
        { tag: "circle", attrs: { cx: 32, cy: 3.6, r: 2.8, fill: p.mid, stroke: p.line, strokeWidth: 1 } }
      ]
    });
  }

  // A respiração embrulha TUDO num grupo sem `transform` de atributo — mesmo
  // motivo do parágrafo acima.
  const stage: SvgNode[] =
    avatar.motion === "breathe"
      ? [{ tag: "g", attrs: { className: cls("breathe") }, children: layers }]
      : layers;

  return [{ tag: "defs", attrs: {}, children: defs }, ...stage];
}

/* --------------------------------- o CSS --------------------------------- */

const EASE = "var(--swift,cubic-bezier(.4,0,.2,1))";

/**
 * As animações, todas em `@keyframes`, todas prefixadas pela chave dos
 * parâmetros e todas desligadas sob `prefers-reduced-motion`. A regra de
 * desligamento vem por último com a mesma especificidade — vence sem `!important`.
 */
export function buildAvatarCss(avatar: Avatar, animKey: string): string {
  if (avatar.motion === "idle") return "";
  const n = (name: string): string => `bt-${animKey}-${name}`;
  const traits = avatarTraits(avatar);
  const rules: string[] = [];

  switch (avatar.motion) {
    case "breathe":
      rules.push(
        `@keyframes ${n("breathe")}{0%,100%{transform:scale(1)}50%{transform:scale(1.04)}}`,
        // transform-box:view-box faz a origem valer no sistema do viewBox; sem
        // isso o grupo escalaria a partir do canto da própria caixa.
        `.${n("breathe")}{transform-box:view-box;transform-origin:32px 32px;animation:${n("breathe")} 3.6s ${EASE} infinite}`
      );
      break;
    case "pulse":
      rules.push(
        `@keyframes ${n("pulse")}{0%,100%{opacity:.26}50%{opacity:.9}}`,
        `.${n("pulse")}{animation:${n("pulse")} 2.4s ${EASE} infinite}`
      );
      break;
    case "scan":
      rules.push(
        `@keyframes ${n("scan")}{0%,100%{transform:translateX(0)}50%{transform:translateX(25px)}}`,
        `.${n("scan")}{animation:${n("scan")} 2.8s ${EASE} infinite}`,
        `@keyframes ${n("band")}{0%{transform:translateY(2px);opacity:0}15%{opacity:.5}85%{opacity:.5}100%{transform:translateY(58px);opacity:0}}`,
        `.${n("band")}{animation:${n("band")} 2.8s linear infinite}`
      );
      break;
    case "orbit":
      rules.push(
        `@keyframes ${n("orbit")}{from{transform:rotate(${traits.orbitStart}deg)}to{transform:rotate(${traits.orbitStart + 360}deg)}}`,
        `.${n("orbit")}{transform-box:view-box;transform-origin:32px 32px;animation:${n("orbit")} 6.5s linear infinite}`
      );
      break;
    default:
      break;
  }

  rules.push(
    `@media (prefers-reduced-motion:reduce){` +
      `.${n("breathe")},.${n("pulse")},.${n("scan")},.${n("band")},.${n("orbit")}{animation:none}}`
  );
  return rules.join("");
}

/* ------------------------------- o componente ---------------------------- */

function toElement(node: SvgNode, key: number): ReactElement {
  // Dois ajustes de tipo, ambos por causa da mesma escolha (nós genéricos):
  // o cast reconcilia o mapa de atributos com a tipagem nominal de SVGProps, e
  // os parâmetros explícitos fixam a sobrecarga de `createElement` para tag
  // dinâmica — sem eles o inferidor cai em `Element` e recusa os handlers de
  // SVG por contravariância.
  const props = node.attrs as unknown as SVGProps<SVGElement>;
  return createElement<SVGProps<SVGElement>, SVGElement>(
    node.tag,
    { key, ...props },
    node.text ?? (node.children ? node.children.map(toElement) : undefined)
  );
}

export function BotAvatar({
  avatar,
  size = 24,
  title
}: {
  avatar: Avatar;
  size?: number;
  title?: string;
}) {
  const rawId = useId();
  // useId devolve algo como ":r3:" — dois-pontos não vale em id de SVG nem em
  // seletor CSS.
  const uid = useMemo(() => rawId.replace(/[^a-zA-Z0-9_-]/g, ""), [rawId]);

  const { seed, shape, eyes, mouth, accessory, motion, hue, saturation } = avatar;
  const drawing = useMemo(() => {
    const model: Avatar = { seed, shape, eyes, mouth, accessory, motion, hue, saturation };
    const key = avatarKey(model);
    return { nodes: buildAvatarNodes(model, uid, key), css: buildAvatarCss(model, key) };
    // Depende dos CAMPOS, não do objeto: quem monta `{...def.avatar}` na
    // renderização criaria identidade nova a cada quadro.
  }, [seed, shape, eyes, mouth, accessory, motion, hue, saturation, uid]);

  return (
    <svg
      className="bot-avatar"
      viewBox={`0 0 ${VIEW} ${VIEW}`}
      width={size}
      height={size}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
      // Não é tema, é geometria: sem `display:block` o SVG deita na linha de base
      // e desalinha o ícone de 20px na frente do texto; sem `flex:none` ele
      // encolhe dentro da linha da conversa.
      style={{ display: "block", flex: "none" }}
    >
      {title ? <title>{title}</title> : null}
      {drawing.css ? <style>{drawing.css}</style> : null}
      {drawing.nodes.map(toElement)}
    </svg>
  );
}
