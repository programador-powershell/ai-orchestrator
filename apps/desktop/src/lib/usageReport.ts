/**
 * Núcleo puro do relatório de uso — formatação e leitura honesta dos números.
 *
 * Fica separado do componente porque as decisões que importam aqui não são de
 * layout, são de **o que o número significa**:
 *
 * - custo vem do servidor como STRING (`numeric` do Postgres). Convertê-lo
 *   para `number` para formatar reintroduz o erro de ponto flutuante que o
 *   `numeric` existe para evitar;
 * - modelo sem preço cadastrado NÃO tem custo zero — tem custo desconhecido,
 *   e a diferença precisa aparecer na tela;
 * - a soma por grupo passa do total do workspace quando alguém está em duas
 *   áreas. Isso é correto e precisa ser dito, senão parece defeito.
 *
 * Coberto por usageReport.test.ts.
 */

export interface UsageTotals {
  calls: number;
  /** Quantas dessas chamadas têm contagem de token de verdade. */
  measuredCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** String decimal vinda do servidor — nunca `number`. */
  costUsd: string;
  /** > 0 significa que o custo mostrado está INCOMPLETO. */
  callsWithoutPrice: number;
}

export interface UserRow extends UsageTotals {
  userId: string;
  email: string | null;
  name: string | null;
}

export interface GroupRow extends UsageTotals {
  groupId: string;
  name: string;
}

export interface ModelRow extends UsageTotals {
  model: string;
  mode: string;
  hasPrice: boolean;
}

export interface DailyRow extends UsageTotals {
  day: string;
  activeUsers: number;
}

/** Quem é a pessoa na linha: e-mail é mais estável que nome de exibição. */
export function personLabel(row: UserRow): string {
  return row.email?.trim() || row.name?.trim() || row.userId.slice(0, 8);
}

/**
 * Formata dinheiro SEM passar por float.
 *
 * `Number("0.000123")` já perde precisão em somas grandes, e o servidor manda
 * `numeric` justamente para não perder. Aqui o corte é textual.
 */
export function formatUsd(value: string, decimals = 2): string {
  const clean = (value ?? "").trim();
  if (!clean) return "US$ 0,00";
  const negative = clean.startsWith("-");
  const digits = negative ? clean.slice(1) : clean;
  const [whole = "0", fraction = ""] = digits.split(".");
  const rounded = roundDecimalString(whole, fraction, decimals);
  const grouped = rounded.whole.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const cents = decimals > 0 ? `,${rounded.fraction.padEnd(decimals, "0")}` : "";
  return `${negative ? "-" : ""}US$ ${grouped}${cents}`;
}

/** Arredondamento meio-para-cima em cima das casas, sem aritmética de float. */
function roundDecimalString(
  whole: string,
  fraction: string,
  decimals: number
): { whole: string; fraction: string } {
  if (fraction.length <= decimals) return { whole, fraction };
  const kept = fraction.slice(0, decimals);
  const next = Number(fraction[decimals] ?? "0");
  if (next < 5) return { whole, fraction: kept };
  // Propaga o "vai um" da direita para a esquerda.
  const digits = (whole + kept).split("");
  let index = digits.length - 1;
  while (index >= 0) {
    const value = Number(digits[index]) + 1;
    digits[index] = String(value % 10);
    if (value < 10) break;
    index -= 1;
  }
  const carried = index < 0 ? ["1", ...digits] : digits;
  const cut = carried.length - decimals;
  return {
    whole: carried.slice(0, cut).join("") || "0",
    fraction: carried.slice(cut).join("")
  };
}

/** 1.234.567 → "1,23 M". Token é grandeza de ordem, não de precisão. */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 1_000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1).replace(".", ",")} k`;
  return `${(value / 1_000_000).toFixed(2).replace(".", ",")} M`;
}

export type Confidence = "completo" | "parcial" | "sem-medicao";

/**
 * Quanto dá para confiar no custo da linha.
 *
 * Existe porque um número de custo sozinho é indistinguível entre "gastou
 * pouco" e "não conseguimos medir". A UI precisa dizer qual dos dois é.
 */
export function confidenceOf(totals: UsageTotals): Confidence {
  if (totals.calls === 0) return "completo";
  if (totals.measuredCalls === 0) return "sem-medicao";
  if (totals.callsWithoutPrice > 0 || totals.measuredCalls < totals.calls) return "parcial";
  return "completo";
}

export function confidenceLabel(totals: UsageTotals): string {
  switch (confidenceOf(totals)) {
    case "sem-medicao":
      return "sem medição de token — custo desconhecido";
    case "parcial": {
      const semToken = totals.calls - totals.measuredCalls;
      const partes: string[] = [];
      if (semToken > 0) partes.push(`${semToken} chamada(s) sem contagem`);
      if (totals.callsWithoutPrice > 0) partes.push(`${totals.callsWithoutPrice} sem preço cadastrado`);
      return `custo parcial — ${partes.join(" e ")}`;
    }
    default:
      return "medição completa";
  }
}

/** Soma de strings decimais, dígito a dígito — sem float em ponto nenhum. */
export function sumUsd(values: readonly string[]): string {
  let totalCents = 0n;
  const SCALE = 6;
  for (const raw of values) {
    const clean = (raw ?? "").trim();
    if (!clean) continue;
    const negative = clean.startsWith("-");
    const [whole = "0", fraction = ""] = (negative ? clean.slice(1) : clean).split(".");
    const scaled = BigInt(`${whole}${fraction.slice(0, SCALE).padEnd(SCALE, "0")}` || "0");
    totalCents += negative ? -scaled : scaled;
  }
  const negative = totalCents < 0n;
  const digits = (negative ? -totalCents : totalCents).toString().padStart(SCALE + 1, "0");
  const cut = digits.length - SCALE;
  return `${negative ? "-" : ""}${digits.slice(0, cut)}.${digits.slice(cut)}`;
}

/** Fatia do total, para a barra da linha. 0 quando não há base de comparação. */
export function share(value: string, total: string): number {
  const asNumber = (text: string) => Number(text) || 0;
  const base = asNumber(total);
  if (base <= 0) return 0;
  return Math.max(0, Math.min(1, asNumber(value) / base));
}
