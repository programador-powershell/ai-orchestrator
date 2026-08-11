/**
 * osv.ts — auditoria REAL de dependências via OSV.dev (https://osv.dev).
 *
 * Parsers puros de lockfiles (package-lock.json v1/v2/v3 e pnpm-lock.yaml
 * v5/v6/v9) e cliente da API OSV (POST /v1/querybatch em lotes de 100 +
 * GET /v1/vulns/{id} para enriquecer os primeiros achados) com fetch
 * injetável — 100% testável em vitest sem rede.
 *
 * Severidade derivada de forma verificável: vetor CVSS 3.x (cálculo oficial
 * do base score) com fallback para database_specific.severity (GHSA).
 */

export interface PackageRef {
  name: string;
  version: string;
  ecosystem: "npm";
}

export type OsvSeverity = "critical" | "high" | "medium" | "low" | "unknown";

export interface OsvVuln {
  id: string;
  /** Resumo do advisory; vazio enquanto não enriquecido via GET /v1/vulns. */
  summary: string;
  severity: OsvSeverity;
  /** Base score CVSS 3.x quando derivável do vetor publicado. */
  score?: number;
  /** Link externo real para o advisory. */
  link: string;
  /** Primeira versão corrigida publicada no advisory (quando houver). */
  fixed?: string;
  /** Aliases (CVE-…, GHSA-…). */
  aliases: string[];
  /** true quando os detalhes foram carregados de GET /v1/vulns/{id}. */
  enriched: boolean;
}

export interface PackageAudit extends PackageRef {
  vulns: OsvVuln[];
}

export const OSV_SEVERITY_RANK: Record<OsvSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  unknown: 4
};

/* ------------------------------------------------------------------ */
/* Parsers de lockfile                                                  */
/* ------------------------------------------------------------------ */

/** Versão concreta instalada (não range): começa com dígito, semver-like. */
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/;

function isConcreteVersion(version: string): boolean {
  return VERSION_PATTERN.test(version);
}

function pushUnique(out: Map<string, PackageRef>, name: string, version: string): void {
  const clean = version.replace(/\(.*$/, "").trim();
  if (!name || !isConcreteVersion(clean)) return;
  out.set(`${name}@${clean}`, { name, version: clean, ecosystem: "npm" });
}

/**
 * package-lock.json v2/v3: packages{} com chaves "node_modules/<nome>"
 * (aninhamentos inclusos). Fallback v1: árvore dependencies{}.
 */
export function parsePackageLock(jsonText: string): PackageRef[] {
  let doc: unknown;
  try {
    doc = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (!doc || typeof doc !== "object") return [];
  const rec = doc as Record<string, unknown>;
  const out = new Map<string, PackageRef>();

  const packages = rec.packages;
  if (packages && typeof packages === "object") {
    for (const [key, value] of Object.entries(packages as Record<string, unknown>)) {
      if (!key || !value || typeof value !== "object") continue; // "" é o projeto raiz
      const entry = value as Record<string, unknown>;
      if (entry.link === true) continue; // workspace link, não é pacote do registry
      const marker = key.lastIndexOf("node_modules/");
      if (marker === -1) continue;
      const name = key.slice(marker + "node_modules/".length);
      pushUnique(out, name, typeof entry.version === "string" ? entry.version : "");
    }
    return [...out.values()];
  }

  // lockfileVersion 1: dependencies aninhadas { nome: { version, dependencies } }
  const walk = (deps: unknown): void => {
    if (!deps || typeof deps !== "object") return;
    for (const [name, value] of Object.entries(deps as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const entry = value as Record<string, unknown>;
      pushUnique(out, name, typeof entry.version === "string" ? entry.version : "");
      walk(entry.dependencies);
    }
  };
  walk(rec.dependencies);
  return [...out.values()];
}

/** Chaves YAML que nunca são nomes de pacote em linhas "chave: valor". */
const PNPM_RESERVED_KEYS = new Set([
  "lockfileVersion",
  "settings",
  "importers",
  "packages",
  "snapshots",
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "transitivePeerDependencies",
  "specifier",
  "version",
  "resolution",
  "integrity",
  "engines",
  "node",
  "npm",
  "pnpm",
  "hasBin",
  "deprecated",
  "os",
  "cpu",
  "dev",
  "optional",
  "requiresBuild",
  "bundledDependencies",
  "patchedDependencies",
  "overrides",
  "autoInstallPeers",
  "excludeLinksFromLockfile"
]);

/**
 * pnpm-lock.yaml — parser leve por regex, sem lib de YAML. Cobre:
 *  - v9 (formato deste repo): chaves "  'nome@versão':" / "  nome@versão(peers):"
 *    em packages:/snapshots:, e dependências de importer em duas linhas
 *    ("  'nome':" seguido de "    version: x.y.z").
 *  - v6: chaves "  /nome@versão(peers):".
 *  - v5: chaves "  /nome/1.2.3:".
 *  - dependências em linha única "  'nome': 1.2.3(peers)" (snapshots).
 */
export function parsePnpmLock(text: string): PackageRef[] {
  const out = new Map<string, PackageRef>();
  let pendingDep = "";
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;

    // 1) chave de pacote resolvido: "  '@scope/nome@1.2.3':" | "  nome@1.2.3:"
    //    | "  nome@1.2.3: {}" | "  /nome@1.2.3(peer)':" (v6) — peers ignorados.
    let match = /^ {2}'?\/?((?:@[\w.-]+\/)?[\w.-]+)@(\d[\w.+-]*)(?:\(.*\))?'?:\s*(?:\{\})?\s*$/.exec(raw);
    if (match) {
      pushUnique(out, match[1], match[2]);
      pendingDep = "";
      continue;
    }

    // 1b) v5: "  /nome/1.2.3:"
    match = /^ {2}\/((?:@[\w.-]+\/)?[\w.-]+)\/(\d[\w.+-]*)(?:_[\w.@+-]+)?:\s*$/.exec(raw);
    if (match) {
      pushUnique(out, match[1], match[2]);
      pendingDep = "";
      continue;
    }

    // 2) dependência em linha única: "      'nome': 1.2.3(peers)"
    match = /^ {4,}'?((?:@[\w.-]+\/)?[\w.-]+)'?: (\d[\w.+-]*)(?:\(.*\))?\s*$/.exec(raw);
    if (match && !PNPM_RESERVED_KEYS.has(match[1])) {
      pushUnique(out, match[1], match[2]);
      pendingDep = "";
      continue;
    }

    // 3) dependência de importer em duas linhas: "      'nome':" → "        version: 1.2.3"
    match = /^ {4,}'?((?:@[\w.-]+\/)?[\w.-]+)'?:\s*$/.exec(raw);
    if (match && !PNPM_RESERVED_KEYS.has(match[1])) {
      pendingDep = match[1];
      continue;
    }
    match = /^ {6,}version: '?(\d[\w.+-]*)(?:\(.*\))?'?\s*$/.exec(raw);
    if (match && pendingDep) {
      pushUnique(out, pendingDep, match[1]);
      pendingDep = "";
      continue;
    }
    // "specifier:" fica entre o nome e o "version:" no importer — preserva o pendente.
    if (!/^ {6,}specifier:/.test(raw)) pendingDep = "";
  }
  return [...out.values()];
}

export type LockfileKind = "package-lock" | "pnpm-lock" | "unknown";

/** Detecta o formato do lockfile pelo conteúdo (não pelo nome do arquivo). */
export function detectLockfile(text: string): LockfileKind {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{")) {
    try {
      const doc = JSON.parse(text) as Record<string, unknown>;
      if (doc && typeof doc === "object" && ("lockfileVersion" in doc || "packages" in doc || "dependencies" in doc)) {
        return "package-lock";
      }
    } catch {
      return "unknown";
    }
    return "unknown";
  }
  if (/^lockfileVersion:/m.test(text) || /^packages:/m.test(text) || /^importers:/m.test(text)) {
    return "pnpm-lock";
  }
  return "unknown";
}

/** Dispatch: detecta o formato e devolve os pacotes resolvidos. */
export function parseLockfile(text: string): { kind: LockfileKind; packages: PackageRef[] } {
  const kind = detectLockfile(text);
  if (kind === "package-lock") return { kind, packages: parsePackageLock(text) };
  if (kind === "pnpm-lock") return { kind, packages: parsePnpmLock(text) };
  return { kind, packages: [] };
}

/* ------------------------------------------------------------------ */
/* CVSS 3.x — base score oficial (spec first.org), puro e testável      */
/* ------------------------------------------------------------------ */

const AV_WEIGHT: Record<string, number> = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 };
const AC_WEIGHT: Record<string, number> = { L: 0.77, H: 0.44 };
const UI_WEIGHT: Record<string, number> = { N: 0.85, R: 0.62 };
const PR_UNCHANGED: Record<string, number> = { N: 0.85, L: 0.62, H: 0.27 };
const PR_CHANGED: Record<string, number> = { N: 0.85, L: 0.68, H: 0.5 };
const CIA_WEIGHT: Record<string, number> = { H: 0.56, L: 0.22, N: 0 };

/** Roundup oficial do CVSS 3.1 (uma casa decimal, sempre para cima). */
function roundUp1(value: number): number {
  const scaled = Math.round(value * 100000);
  return scaled % 10000 === 0 ? scaled / 100000 : (Math.floor(scaled / 10000) + 1) / 10;
}

/** Base score de um vetor CVSS:3.0/3.1. Retorna null para vetor inválido. */
export function cvssBaseScore(vector: string): number | null {
  if (!/^CVSS:3\.[01]\//.test(vector)) return null;
  const metrics = new Map<string, string>();
  for (const part of vector.split("/").slice(1)) {
    const [key, value] = part.split(":");
    if (key && value) metrics.set(key, value);
  }
  const scopeChanged = metrics.get("S") === "C";
  const av = AV_WEIGHT[metrics.get("AV") ?? ""];
  const ac = AC_WEIGHT[metrics.get("AC") ?? ""];
  const pr = (scopeChanged ? PR_CHANGED : PR_UNCHANGED)[metrics.get("PR") ?? ""];
  const ui = UI_WEIGHT[metrics.get("UI") ?? ""];
  const c = CIA_WEIGHT[metrics.get("C") ?? ""];
  const i = CIA_WEIGHT[metrics.get("I") ?? ""];
  const a = CIA_WEIGHT[metrics.get("A") ?? ""];
  if ([av, ac, pr, ui, c, i, a].some((weight) => weight === undefined) || !metrics.has("S")) return null;

  const iss = 1 - (1 - c) * (1 - i) * (1 - a);
  const impact = scopeChanged ? 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15) : 6.42 * iss;
  if (impact <= 0) return 0;
  const exploitability = 8.22 * av * ac * pr * ui;
  const raw = scopeChanged
    ? Math.min(1.08 * (impact + exploitability), 10)
    : Math.min(impact + exploitability, 10);
  return roundUp1(raw);
}

export function severityFromScore(score: number): OsvSeverity {
  if (score >= 9) return "critical";
  if (score >= 7) return "high";
  if (score >= 4) return "medium";
  return "low";
}

/* ------------------------------------------------------------------ */
/* Cliente OSV.dev                                                      */
/* ------------------------------------------------------------------ */

const OSV_QUERYBATCH_URL = "https://api.osv.dev/v1/querybatch";
const OSV_VULN_URL = "https://api.osv.dev/v1/vulns/";

interface OsvDetailRaw {
  id?: string;
  summary?: string;
  details?: string;
  aliases?: unknown;
  severity?: Array<{ type?: string; score?: string }>;
  database_specific?: { severity?: string };
  affected?: Array<{
    package?: { ecosystem?: string; name?: string };
    ranges?: Array<{ events?: Array<{ fixed?: string }> }>;
  }>;
}

/** Deriva severidade de um advisory OSV: vetor CVSS 3.x → fallback GHSA. */
export function deriveSeverity(entry: {
  severity?: Array<{ type?: string; score?: string }>;
  database_specific?: { severity?: string };
}): { severity: OsvSeverity; score?: number } {
  for (const item of entry.severity ?? []) {
    if (typeof item?.score === "string" && item.score.startsWith("CVSS:3")) {
      const score = cvssBaseScore(item.score);
      if (score !== null) return { severity: severityFromScore(score), score };
    }
  }
  const label = (entry.database_specific?.severity ?? "").toUpperCase();
  if (label === "CRITICAL") return { severity: "critical" };
  if (label === "HIGH") return { severity: "high" };
  if (label === "MODERATE" || label === "MEDIUM") return { severity: "medium" };
  if (label === "LOW") return { severity: "low" };
  return { severity: "unknown" };
}

function extractFixed(detail: OsvDetailRaw, packageName: string): string | undefined {
  for (const affected of detail.affected ?? []) {
    if (affected?.package?.ecosystem !== "npm" || affected.package.name !== packageName) continue;
    for (const range of affected.ranges ?? []) {
      for (const event of range?.events ?? []) {
        if (typeof event?.fixed === "string" && event.fixed) return event.fixed;
      }
    }
  }
  return undefined;
}

/** Pior severidade de um pacote auditado (para ordenação e chips). */
export function worstSeverity(audit: PackageAudit): OsvSeverity {
  let worst: OsvSeverity = "unknown";
  for (const vuln of audit.vulns) {
    if (OSV_SEVERITY_RANK[vuln.severity] < OSV_SEVERITY_RANK[worst]) worst = vuln.severity;
  }
  return worst;
}

export interface QueryOsvOptions {
  /** Tamanho do lote do querybatch (máximo aceito: 1000; padrão 100). */
  batchSize?: number;
  /** Quantos advisories enriquecer via GET /v1/vulns/{id} (padrão 20). */
  detailLimit?: number;
  onProgress?: (message: string) => void;
}

/**
 * Consulta a API pública OSV.dev em lotes de 100 pacotes e devolve os
 * pacotes vulneráveis, com os primeiros advisories enriquecidos (resumo,
 * severidade derivada, versão corrigida). Sem chave de API; CORS liberado.
 */
export async function queryOsv(
  packages: PackageRef[],
  fetchImpl: typeof fetch,
  options: QueryOsvOptions = {}
): Promise<PackageAudit[]> {
  const batchSize = Math.max(1, options.batchSize ?? 100);
  const detailLimit = Math.max(0, options.detailLimit ?? 20);

  const unique = new Map<string, PackageRef>();
  for (const pkg of packages) unique.set(`${pkg.name}@${pkg.version}`, pkg);
  const list = [...unique.values()];
  const audits: PackageAudit[] = [];

  for (let offset = 0; offset < list.length; offset += batchSize) {
    const batch = list.slice(offset, offset + batchSize);
    const response = await fetchImpl(OSV_QUERYBATCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        queries: batch.map((pkg) => ({
          package: { name: pkg.name, ecosystem: pkg.ecosystem },
          version: pkg.version
        }))
      })
    });
    if (!response.ok) throw new Error(`OSV querybatch falhou: HTTP ${response.status}`);
    const data = (await response.json()) as { results?: Array<{ vulns?: Array<{ id?: string }> }> };
    const results = Array.isArray(data.results) ? data.results : [];
    batch.forEach((pkg, index) => {
      const ids = (results[index]?.vulns ?? [])
        .map((vuln) => (typeof vuln?.id === "string" ? vuln.id : ""))
        .filter(Boolean);
      if (!ids.length) return;
      audits.push({
        ...pkg,
        vulns: [...new Set(ids)].map((id) => ({
          id,
          summary: "",
          severity: "unknown",
          link: `https://osv.dev/vulnerability/${id}`,
          aliases: [],
          enriched: false
        }))
      });
    });
    options.onProgress?.(
      `OSV: ${Math.min(offset + batchSize, list.length)}/${list.length} pacotes consultados`
    );
  }

  // Enriquecimento: GET /v1/vulns/{id} para os primeiros advisories distintos.
  const pendingIds: string[] = [];
  for (const audit of audits) {
    for (const vuln of audit.vulns) {
      if (!pendingIds.includes(vuln.id)) pendingIds.push(vuln.id);
    }
  }
  const toEnrich = pendingIds.slice(0, detailLimit);
  if (toEnrich.length) {
    options.onProgress?.(`OSV: carregando detalhes de ${toEnrich.length} advisories`);
    const details = await Promise.all(
      toEnrich.map(async (id) => {
        try {
          const response = await fetchImpl(`${OSV_VULN_URL}${encodeURIComponent(id)}`);
          if (!response.ok) return null;
          return (await response.json()) as OsvDetailRaw;
        } catch {
          return null; // detalhe indisponível não invalida a auditoria
        }
      })
    );
    const byId = new Map<string, OsvDetailRaw>();
    details.forEach((detail, index) => {
      if (detail) byId.set(toEnrich[index], detail);
    });
    for (const audit of audits) {
      audit.vulns = audit.vulns.map((vuln) => {
        const detail = byId.get(vuln.id);
        if (!detail) return vuln;
        const { severity, score } = deriveSeverity(detail);
        const aliases = Array.isArray(detail.aliases)
          ? detail.aliases.filter((alias): alias is string => typeof alias === "string")
          : [];
        return {
          ...vuln,
          summary:
            typeof detail.summary === "string" && detail.summary.trim()
              ? detail.summary.trim()
              : typeof detail.details === "string"
                ? detail.details.trim().split("\n")[0]
                : "",
          severity,
          score,
          fixed: extractFixed(detail, audit.name),
          aliases,
          enriched: true
        };
      });
    }
  }

  return audits.sort((a, b) => {
    const rank = OSV_SEVERITY_RANK[worstSeverity(a)] - OSV_SEVERITY_RANK[worstSeverity(b)];
    return rank !== 0 ? rank : b.vulns.length - a.vulns.length;
  });
}

/* ------------------------------------------------------------------ */
/* Prompt de correção para o agente                                     */
/* ------------------------------------------------------------------ */

/** Monta o prompt real de correção com os achados da auditoria OSV. */
export function buildFixPrompt(audits: PackageAudit[], lockfileLabel: string): string {
  const shown = audits.slice(0, 15);
  const lines = shown.map((audit) => {
    const fixes = [...new Set(audit.vulns.map((vuln) => vuln.fixed).filter(Boolean))];
    const ids = audit.vulns.map((vuln) => vuln.id).join(", ");
    const worst = worstSeverity(audit);
    return (
      `- ${audit.name}@${audit.version} — ${audit.vulns.length} vulnerabilidade(s), pior severidade: ${worst}. ` +
      `Advisories: ${ids}${fixes.length ? `. Corrigido em: ${fixes.join(", ")}` : ""}`
    );
  });
  const omitted = audits.length - shown.length;
  return (
    `Auditoria OSV.dev do ${lockfileLabel} encontrou ${audits.length} pacote(s) npm vulnerável(is):\n` +
    lines.join("\n") +
    (omitted > 0 ? `\n(+${omitted} pacote(s) omitido(s))` : "") +
    "\n\nProponha o plano de atualização: versões-alvo respeitando semver e breaking changes, " +
    "comandos exatos (pnpm/npm) e quais testes rodar após atualizar. " +
    "Se alguma correção exigir major bump, aponte o risco e a alternativa."
  );
}
