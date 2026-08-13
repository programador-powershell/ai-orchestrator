/**
 * Sistema de design — o "contrato de marca" que governa toda saída visual.
 *
 * É o mesmo padrão da **constituição** do fluxo spec-driven, aplicado ao
 * Design: um documento de princípios inegociáveis que entra no prompt de TODA
 * geração, em vez de o modelo redecidir a identidade a cada pedido — que é o
 * motivo de duas telas geradas na mesma semana nunca saírem parecidas.
 *
 * ## O que separa isto de um documento decorativo
 *
 * Um contrato que ninguém verifica é enfeite. Por isso existe
 * `checkConformance`: ele aponta, nó a nó, o que no canvas está **fora** da
 * paleta e da tipografia declaradas. E `applySystem` corrige, aproximando cada
 * cor solta do token mais próximo — em vez de só reclamar.
 *
 * ## A ponte com o clone
 *
 * `systemFromTokens` semeia um sistema a partir dos tokens extraídos de um
 * site. Clonar a identidade de um site e passar a **cobrar** conformidade com
 * ela é o caminho natural de quem está padronizando uma marca.
 *
 * Módulo puro: sem DOM, sem rede. Coberto por designSystem.test.ts.
 */
import type { CanvasDoc, CanvasNode } from "./canvasDoc";

export interface DesignToken {
  /** Nome que o time usa ("primária", "fundo"), não o valor. */
  name: string;
  value: string;
}

export interface DesignSystem {
  schemaVersion: 1;
  name: string;
  /** Paleta autorizada. Vazia = não cobra cor. */
  colors: DesignToken[];
  /** Famílias tipográficas autorizadas. */
  fonts: string[];
  /** Escala tipográfica em px. Fora dela vira apontamento. */
  fontSizes: number[];
  /** Raios de borda autorizados. */
  radii: number[];
  /** Princípios em texto livre — o que não vira número. */
  principles: string;
  updatedAt: number;
}

export const DESIGN_SYSTEM_KEY = "aio.design.system.v1";

export function emptySystem(name = "Sistema da marca"): DesignSystem {
  return {
    schemaVersion: 1,
    name,
    colors: [],
    fonts: [],
    fontSizes: [],
    radii: [],
    principles: "",
    updatedAt: 0
  };
}

/** Um sistema sem nenhuma regra não cobra nada — e a UI precisa dizer isso. */
export function isEmpty(system: DesignSystem): boolean {
  return (
    !system.colors.length &&
    !system.fonts.length &&
    !system.fontSizes.length &&
    !system.radii.length &&
    !system.principles.trim()
  );
}

/* ------------------------------- cores -------------------------------- */

/** `#abc` → `#aabbcc`; devolve null para o que não for hex reconhecível. */
export function normalizeHex(value: string): string | null {
  const clean = value.trim().toLowerCase();
  const curto = clean.match(/^#([0-9a-f]{3})$/);
  if (curto) {
    const [r, g, b] = curto[1].split("");
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  const longo = clean.match(/^#([0-9a-f]{6})$/);
  return longo ? `#${longo[1]}` : null;
}

function toRgb(hex: string): [number, number, number] | null {
  const norm = normalizeHex(hex);
  if (!norm) return null;
  return [
    Number.parseInt(norm.slice(1, 3), 16),
    Number.parseInt(norm.slice(3, 5), 16),
    Number.parseInt(norm.slice(5, 7), 16)
  ];
}

/**
 * Distância entre duas cores.
 *
 * Usa a aproximação ponderada de Rec. 601 (o verde pesa mais que o azul)
 * porque a distância euclidiana crua em RGB erra feio: ela considera um azul
 * e um verde de mesmo "tamanho" numérico igualmente distantes, quando o olho
 * não vê assim. Não é CIEDE2000, e não precisa ser — o objetivo é escolher o
 * token mais parecido, não medir diferença perceptual com rigor.
 */
export function colorDistance(a: string, b: string): number {
  const ra = toRgb(a);
  const rb = toRgb(b);
  if (!ra || !rb) return Number.POSITIVE_INFINITY;
  const dr = ra[0] - rb[0];
  const dg = ra[1] - rb[1];
  const db = ra[2] - rb[2];
  return Math.sqrt(2 * dr * dr + 4 * dg * dg + 3 * db * db);
}

/** Token de cor mais próximo, ou null se a paleta estiver vazia. */
export function nearestColor(system: DesignSystem, value: string): DesignToken | null {
  let melhor: DesignToken | null = null;
  let menor = Number.POSITIVE_INFINITY;
  for (const token of system.colors) {
    const distancia = colorDistance(token.value, value);
    if (distancia < menor) {
      menor = distancia;
      melhor = token;
    }
  }
  return melhor;
}

/** A cor está na paleta? Comparação por valor normalizado. */
export function isColorAllowed(system: DesignSystem, value: string): boolean {
  if (!system.colors.length) return true;
  const alvo = normalizeHex(value);
  if (!alvo) return true; // formato que não sabemos julgar não vira apontamento
  return system.colors.some((token) => normalizeHex(token.value) === alvo);
}

/**
 * Luminância relativa (0 = preto, 1 = branco), fórmula do WCAG.
 * Usada só para avisar sobre paleta sem amplitude — não para medir contraste
 * entre um par específico, que exigiria saber o que está sobre o quê.
 */
export function luminance(hex: string): number {
  const rgb = toRgb(hex);
  if (!rgb) return 0;
  const canal = (valor: number) => {
    const s = valor / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * canal(rgb[0]) + 0.7152 * canal(rgb[1]) + 0.0722 * canal(rgb[2]);
}

/**
 * Avisos sobre a própria paleta, antes de ela estragar o desenho.
 *
 * Motivo concreto: `applySystem` aproxima cada cor do token mais próximo. Numa
 * paleta só de tons escuros, o branco de um texto é "aproximado" para um
 * escuro — e o texto some sobre o fundo. O algoritmo está certo; a paleta é
 * que está incompleta, e quem precisa saber é quem a escreveu.
 */
export function paletteWarnings(system: DesignSystem): string[] {
  if (system.colors.length < 2) {
    return system.colors.length === 1
      ? ["a paleta tem uma cor só — corrigir o canvas deixaria tudo dela, sem contraste"]
      : [];
  }
  const luzes = system.colors.map((token) => luminance(token.value));
  const amplitude = Math.max(...luzes) - Math.min(...luzes);
  // 0.5 separa confortavelmente um tom claro de um escuro na escala do WCAG.
  return amplitude < 0.5
    ? ["a paleta não tem uma cor clara e uma escura — corrigir o canvas pode eliminar contraste de texto"]
    : [];
}

/* --------------------------- conformidade ----------------------------- */

export type ViolationKind = "cor" | "fonte" | "raio";

export interface Violation {
  nodeId: string;
  kind: ViolationKind;
  /** O valor que está no canvas. */
  found: string;
  /** O token mais próximo, quando existe — vira a sugestão de correção. */
  suggestion?: string;
  message: string;
}

/**
 * Aponta o que está fora do contrato.
 *
 * Regra deliberada: categoria **vazia no sistema não gera apontamento**. Um
 * sistema que só define cores não pode encher a tela de reclamação sobre
 * tipografia que o time nem padronizou.
 */
export function checkConformance(doc: CanvasDoc, system: DesignSystem): Violation[] {
  const violations: Violation[] = [];
  for (const node of doc.nodes) {
    if (system.colors.length && !isColorAllowed(system, node.fill)) {
      const perto = nearestColor(system, node.fill);
      violations.push({
        nodeId: node.id,
        kind: "cor",
        found: node.fill,
        ...(perto ? { suggestion: perto.value } : {}),
        // A mensagem NÃO repete a categoria: a UI já mostra a etiqueta ao
        // lado, e repetir produzia "cor cor #fff fora da paleta".
        message: perto
          ? `${node.fill} fora da paleta — mais próxima: ${perto.name} (${perto.value})`
          : `${node.fill} fora da paleta`
      });
    }
    if (system.fontSizes.length && node.type === "text" && node.fontSize) {
      if (!system.fontSizes.includes(node.fontSize)) {
        const perto = nearestNumber(system.fontSizes, node.fontSize);
        violations.push({
          nodeId: node.id,
          kind: "fonte",
          found: `${node.fontSize}px`,
          suggestion: `${perto}px`,
          message: `${node.fontSize}px fora da escala — mais próximo: ${perto}px`
        });
      }
    }
    if (system.radii.length && node.radius !== undefined && node.radius > 0) {
      if (!system.radii.includes(node.radius)) {
        const perto = nearestNumber(system.radii, node.radius);
        violations.push({
          nodeId: node.id,
          kind: "raio",
          found: `${node.radius}px`,
          suggestion: `${perto}px`,
          message: `${node.radius}px fora do sistema — mais próximo: ${perto}px`
        });
      }
    }
  }
  return violations;
}

function nearestNumber(list: readonly number[], value: number): number {
  return list.reduce((melhor, atual) =>
    Math.abs(atual - value) < Math.abs(melhor - value) ? atual : melhor
  );
}

/**
 * Corrige o documento para o contrato.
 *
 * Aproxima em vez de zerar: um retângulo com cor solta vira a cor de marca
 * mais parecida, não uma cor arbitrária — o desenho continua reconhecível.
 * Devolve o MESMO documento quando não há nada a corrigir, para o histórico de
 * desfazer não ganhar uma entrada vazia.
 */
export function applySystem(doc: CanvasDoc, system: DesignSystem): CanvasDoc {
  if (isEmpty(system)) return doc;
  let mudou = false;
  const nodes = doc.nodes.map((node) => {
    let next: CanvasNode = node;
    if (system.colors.length && !isColorAllowed(system, node.fill)) {
      const perto = nearestColor(system, node.fill);
      if (perto) {
        next = { ...next, fill: perto.value };
        mudou = true;
      }
    }
    if (system.fontSizes.length && next.type === "text" && next.fontSize && !system.fontSizes.includes(next.fontSize)) {
      next = { ...next, fontSize: nearestNumber(system.fontSizes, next.fontSize) };
      mudou = true;
    }
    if (system.radii.length && next.radius !== undefined && next.radius > 0 && !system.radii.includes(next.radius)) {
      next = { ...next, radius: nearestNumber(system.radii, next.radius) };
      mudou = true;
    }
    return next;
  });
  return mudou ? { ...doc, nodes } : doc;
}

/* ------------------------- semear a partir do site --------------------- */

export interface SeedTokens {
  colors: Array<{ value: string }>;
  fonts: string[];
  spacing?: Array<{ value: string }>;
}

/**
 * Semeia um sistema a partir dos tokens extraídos de um site.
 *
 * Só as cores em hex entram: `rgba()` com transparência e gradiente não são
 * token de marca, são uso pontual — e virariam ruído na paleta.
 */
export function systemFromTokens(name: string, tokens: SeedTokens, limit = 8): DesignSystem {
  const cores: DesignToken[] = [];
  const vistos = new Set<string>();
  for (const entry of tokens.colors) {
    const hex = normalizeHex(entry.value);
    if (!hex || vistos.has(hex)) continue;
    vistos.add(hex);
    cores.push({ name: `cor-${cores.length + 1}`, value: hex });
    if (cores.length >= limit) break;
  }
  return {
    ...emptySystem(name),
    colors: cores,
    fonts: tokens.fonts.slice(0, 4),
    updatedAt: 0
  };
}

/* ------------------------------ prompt -------------------------------- */

/**
 * Bloco injetado em TODA geração visual.
 *
 * Sem isto na frente de cada pedido, o modelo respeita a marca no primeiro
 * prompt e a esquece no terceiro, quando o contexto encheu — o mesmo problema
 * que a constituição resolve no fluxo spec-driven.
 */
export function designContract(system: DesignSystem): string {
  if (isEmpty(system)) return "";
  const partes = [
    `SISTEMA DE DESIGN "${system.name}" — regras INEGOCIÁVEIS da identidade visual.`,
    "Se o que você propuser conflitar com elas, a regra vence e você deve dizer qual foi o conflito."
  ];
  if (system.colors.length) {
    partes.push(
      "Paleta autorizada (use SOMENTE estas cores):\n" +
        system.colors.map((token) => `- ${token.name}: ${token.value}`).join("\n")
    );
  }
  if (system.fonts.length) partes.push(`Tipografia: ${system.fonts.join(", ")}`);
  if (system.fontSizes.length) {
    partes.push(`Escala tipográfica (px): ${[...system.fontSizes].sort((a, b) => a - b).join(", ")}`);
  }
  if (system.radii.length) partes.push(`Raios de borda (px): ${[...system.radii].sort((a, b) => a - b).join(", ")}`);
  if (system.principles.trim()) partes.push(`Princípios:\n${system.principles.trim()}`);
  return partes.join("\n\n");
}

/* --------------------------- persistência ----------------------------- */

export function serializeSystem(system: DesignSystem): string {
  return JSON.stringify(system);
}

/** Valida e restaura. `null` se ausente, corrompido ou de outra versão. */
export function parseSystem(json: string | null): DesignSystem | null {
  if (!json) return null;
  try {
    const raw = JSON.parse(json) as Partial<DesignSystem>;
    if (raw.schemaVersion !== 1) return null;
    const numeros = (value: unknown): number[] =>
      Array.isArray(value)
        ? value.filter((item): item is number => typeof item === "number" && Number.isFinite(item) && item >= 0)
        : [];
    return {
      schemaVersion: 1,
      name: typeof raw.name === "string" && raw.name.trim() ? raw.name : "Sistema da marca",
      colors: Array.isArray(raw.colors)
        ? raw.colors
            .filter(
              (token): token is DesignToken =>
                Boolean(token) && typeof token.name === "string" && typeof token.value === "string"
            )
            .map((token) => ({ name: token.name, value: token.value }))
        : [],
      fonts: Array.isArray(raw.fonts) ? raw.fonts.filter((font): font is string => typeof font === "string") : [],
      fontSizes: numeros(raw.fontSizes),
      radii: numeros(raw.radii),
      principles: typeof raw.principles === "string" ? raw.principles : "",
      updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0
    };
  } catch {
    return null;
  }
}

/** O contrato em Markdown, para versionar no repositório do time. */
export function toMarkdown(system: DesignSystem): string {
  const partes = [`# ${system.name}`];
  if (system.colors.length) {
    partes.push(
      "## Paleta\n\n" + system.colors.map((token) => `- **${token.name}** — \`${token.value}\``).join("\n")
    );
  }
  if (system.fonts.length) partes.push(`## Tipografia\n\n${system.fonts.map((font) => `- ${font}`).join("\n")}`);
  if (system.fontSizes.length) {
    partes.push(`## Escala\n\n${[...system.fontSizes].sort((a, b) => a - b).join(" · ")} px`);
  }
  if (system.radii.length) partes.push(`## Raios\n\n${[...system.radii].sort((a, b) => a - b).join(" · ")} px`);
  if (system.principles.trim()) partes.push(`## Princípios\n\n${system.principles.trim()}`);
  return partes.join("\n\n");
}
