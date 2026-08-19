/**
 * Superfície do especialista de SEGURANÇA — a lista de achados.
 *
 * A tela não roda scanner nenhum. Ela LÊ o que as ferramentas devolveram
 * (`secrets.scan`, `osv.query`) nas linhas da conversa: o achado nasce no
 * gateway, viaja como `tool.result` — relatório legível + bloco ```json
 * demarcado no fim (lib/toolJson) — e aqui vira cartão. Por isso o parsing é
 * deliberadamente tolerante — o formato exato é do host, e um campo com outro
 * nome não pode derrubar a superfície inteira; no pior caso o achado aparece
 * com menos detalhe.
 *
 * REGRA DE OURO desta tela: o valor do segredo NUNCA é lido nem renderizado.
 * Campos como `secret`, `match` e `value` são ignorados de propósito — a tela de
 * segurança que ecoa a chave encontrada acabou de vazar a chave para o histórico
 * da conversa, para o log e para o screenshot que vai anexado no chamado.
 */

import { useMemo, useState } from "react";
import { ArrowRight, ExternalLink, ShieldCheck, Wand2 } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { ConversationLine, ToolResult } from "@aibot/contracts";
import { useApp } from "../lib/store";
import { structuredJson } from "../lib/toolJson";
import { SurfaceStatus } from "../shell/StatusBar";

/* ------------------------------ severidade ------------------------------ */

const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
type Severity = (typeof SEVERITIES)[number];

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "Crítico",
  high: "Alto",
  medium: "Médio",
  low: "Baixo",
  info: "Info"
};

/**
 * O `data-risk` do `.badge-risk` já tem cor definida no CSS (read=ok,
 * write=warn, execute/secret=danger, network=info). Reaproveitar esse gancho
 * evita uma segunda paleta para dizer a mesma coisa; a severidade continua
 * viajando em `data-severity`, que é o dado de verdade.
 */
const SEVERITY_RISK: Record<Severity, string | undefined> = {
  critical: "secret",
  high: "execute",
  medium: "write",
  low: "network",
  info: undefined
};

/** Cada scanner escreve a severidade do seu jeito; a tela fala uma língua só. */
const SEVERITY_ALIAS: Record<string, Severity> = {
  critical: "critical",
  crit: "critical",
  critico: "critical",
  crítico: "critical",
  critica: "critical",
  crítica: "critical",
  blocker: "critical",
  high: "high",
  alto: "high",
  alta: "high",
  major: "high",
  error: "high",
  erro: "high",
  medium: "medium",
  moderate: "medium",
  medio: "medium",
  médio: "medium",
  media: "medium",
  média: "medium",
  warning: "medium",
  warn: "medium",
  aviso: "medium",
  low: "low",
  baixo: "low",
  baixa: "low",
  minor: "low",
  info: "info",
  informational: "info",
  informativo: "info",
  note: "info",
  none: "info",
  unknown: "info"
};

/** As duas ferramentas que alimentam esta tela. */
const SOURCE_TOOLS = ["secrets.scan", "osv.query"] as const;

/**
 * A CATEGORIA é derivada da ferramenta de origem, não de um campo do payload:
 * um achado de secrets.scan é sempre um segredo, um de osv.query é sempre uma
 * dependência — pedir isso ao payload seria uma segunda fonte para o mesmo
 * dado, que um dia discordaria da primeira.
 */
const CATEGORIES = ["segredos", "dependências"] as const;
type Category = (typeof CATEGORIES)[number];

function categoryOf(tool: string): Category {
  return tool === "osv.query" ? "dependências" : "segredos";
}

interface Finding {
  key: string;
  tool: string;
  category: Category;
  severity: Severity;
  title: string;
  /** Arquivo ou pacote — o "onde". */
  file: string;
  line?: number;
  detail: string;
  /** Entrada → sink: o caminho até o dano, passo a passo. */
  path: string[];
  patch: string;
  /** CVE/GHSA/regra — o identificador estável, quando existe. */
  reference: string;
  /** Link do advisory (osv.dev) — só quando a origem o tem. */
  url: string;
}

/* ------------------------------ parsing cru ----------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function firstText(source: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const found = text(source[key]);
    if (found) return found;
  }
  return "";
}

function integer(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * Acha a lista dentro do envelope. Aceita a raiz sendo o próprio array e um
 * nível de aninhamento (`{results:{vulns:[…]}}`), que é o formato que a maioria
 * dos scanners devolve quando embrulha a resposta.
 */
function listOf(value: unknown, keys: string[]): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  for (const key of keys) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate;
  }
  for (const key of keys) {
    const candidate = value[key];
    if (!isRecord(candidate)) continue;
    for (const inner of keys) {
      const nested = candidate[inner];
      if (Array.isArray(nested)) return nested;
    }
  }
  return [];
}

/** CVSS numérico vira faixa; é o que o `osv.query` costuma trazer. */
function severityFromScore(score: number): Severity {
  if (score >= 9) return "critical";
  if (score >= 7) return "high";
  if (score >= 4) return "medium";
  if (score > 0) return "low";
  return "info";
}

function severityOf(raw: Record<string, unknown>): Severity {
  for (const key of ["severity", "level", "risk", "impact", "criticality"]) {
    const value = raw[key];
    if (typeof value === "number" && Number.isFinite(value)) return severityFromScore(value);
    const label = text(value).toLowerCase();
    const alias = SEVERITY_ALIAS[label];
    if (alias) return alias;
  }
  for (const key of ["score", "cvss", "cvssScore"]) {
    const value = raw[key];
    if (typeof value === "number" && Number.isFinite(value)) return severityFromScore(value);
    const parsed = Number.parseFloat(text(value));
    if (Number.isFinite(parsed)) return severityFromScore(parsed);
  }
  return "info";
}

/** A cadeia entrada → sink em texto legível. */
function traceOf(raw: Record<string, unknown>): string[] {
  const candidates = [raw["path"], raw["trace"], raw["flow"], raw["chain"], raw["steps"], raw["dataflow"]];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const steps: string[] = [];
    for (const item of candidate) {
      if (typeof item === "string") {
        const trimmed = item.trim();
        if (trimmed) steps.push(trimmed);
        continue;
      }
      if (!isRecord(item)) continue;
      const label = firstText(item, ["label", "step", "note", "description", "name", "symbol", "function"]);
      const where = firstText(item, ["file", "location", "source"]);
      const line = integer(item["line"]);
      const place = where && line !== undefined ? `${where}:${line}` : where;
      const joined = [label, place].filter(Boolean).join(" · ");
      if (joined) steps.push(joined);
    }
    if (steps.length > 0) return steps;
  }
  return [];
}

/** Monta `ecossistema:nome@versão` a partir de qualquer um dos formatos usuais. */
function packageLabel(raw: Record<string, unknown>): string {
  const pkg = raw["package"];
  let name = "";
  let ecosystem = "";
  if (typeof pkg === "string") name = pkg.trim();
  else if (isRecord(pkg)) {
    name = firstText(pkg, ["name", "package", "purl"]);
    ecosystem = firstText(pkg, ["ecosystem", "type"]);
  }
  if (!name) name = firstText(raw, ["dependency", "module", "artifact", "library"]);
  if (!ecosystem) ecosystem = firstText(raw, ["ecosystem"]);
  const version = firstText(raw, ["version", "installed", "installedVersion", "current"]);
  // `name` solto só conta como pacote quando vem acompanhado de versão ou
  // ecossistema. Num achado de segredo `name` é o nome da REGRA, e deixá-lo
  // virar o "onde" do cartão seria apontar um arquivo que não existe.
  if (!name && (version || ecosystem)) name = firstText(raw, ["name"]);
  if (!name) return "";
  const base = version ? `${name}@${version}` : name;
  return ecosystem ? `${ecosystem}:${base}` : base;
}

/**
 * O `osv.query` responde por CONSULTA: o pacote consultado fica na raiz e cada
 * vulnerabilidade da lista só traz o id, a nota e a versão corrigida. Sem o alvo
 * da raiz o patch sairia como "atualizar para 1.3.0" — sem dizer o quê.
 */
function patchOf(raw: Record<string, unknown>, fallbackTarget: string): string {
  const direct = firstText(raw, ["patch", "fix", "diff", "remediation", "suggestion", "fixSuggestion"]);
  if (direct) return direct;
  const fixed = firstText(raw, ["fixedVersion", "fixed", "patchedVersion", "upgradeTo", "firstPatched"]);
  if (!fixed) return "";
  const target = packageLabel(raw) || fallbackTarget;
  return target ? `${target} → ${fixed}` : `atualizar para ${fixed}`;
}

/** O link do advisory: o que a origem mandou pronto, ou o do osv.dev montado
 *  a partir do id — a convenção pública de https://osv.dev/vulnerability/{id}. */
function advisoryUrl(raw: Record<string, unknown>, tool: string, reference: string): string {
  const direct = firstText(raw, ["url", "link", "advisoryUrl"]);
  // Só http(s) atravessa: um payload torto com javascript: aqui viraria um
  // clique que roda script — a tela de segurança não pode ser o vetor.
  if (/^https?:\/\//i.test(direct)) return direct;
  if (tool === "osv.query" && reference !== "") {
    return `https://osv.dev/vulnerability/${encodeURIComponent(reference)}`;
  }
  return "";
}

function toFinding(raw: unknown, tool: string, fallbackTarget: string, index: number): Finding | null {
  if (!isRecord(raw)) return null;

  const reference = firstText(raw, ["id", "cve", "ghsa", "advisory", "rule", "ruleId"]);
  const title =
    firstText(raw, ["title", "summary", "rule", "message", "name", "description"]) ||
    reference ||
    "Achado sem título";

  // `path` é ambíguo entre os scanners: string = arquivo, array = trilha.
  const pathValue = raw["path"];
  const file =
    firstText(raw, ["file", "filePath", "filename", "location"]) ||
    (typeof pathValue === "string" ? pathValue.trim() : "") ||
    packageLabel(raw) ||
    fallbackTarget;

  const detail = firstText(raw, ["detail", "description", "evidence", "why", "summary", "message"]);

  return {
    key: `${tool}:${reference || file || "achado"}:${index}`,
    tool,
    category: categoryOf(tool),
    severity: severityOf(raw),
    title,
    file,
    line: integer(raw["line"] ?? raw["lineNumber"] ?? raw["startLine"]),
    // Detalhe e referência não repetem o título quando a ferramenta preencheu
    // os campos com o mesmo texto — é o caso do achado que só tem `rule`.
    detail: detail === title ? "" : detail,
    path: traceOf(raw),
    patch: patchOf(raw, fallbackTarget),
    reference: reference === title ? "" : reference,
    url: advisoryUrl(raw, tool, reference)
  };
}

/**
 * O ÚLTIMO resultado de cada ferramenta, não a soma de todos.
 *
 * Um segundo `secrets.scan` é uma REVARREDURA: somar os dois deixaria na tela o
 * achado que a pessoa acabou de corrigir, e uma lista que só cresce é uma lista
 * em que ninguém confia.
 */
function latestResult(lines: ConversationLine[], tool: string): ToolResult | null {
  let latest: ToolResult | null = null;
  for (const line of lines) {
    for (const result of line.toolResults ?? []) {
      if (result.tool === tool && result.ok && result.output) latest = result;
    }
  }
  return latest;
}

function collectFindings(results: ReadonlyArray<ToolResult | null>): Finding[] {
  const findings: Finding[] = [];
  for (const result of results) {
    if (!result?.output) continue;
    // O gateway devolve o relatório legível + bloco ```json no fim; resultado
    // antigo, só texto, cai em null e a tela fica no vazio digno.
    const parsed = structuredJson(result.output);
    if (parsed === null) continue;
    const fallbackTarget = isRecord(parsed) ? packageLabel(parsed) : "";
    const items = listOf(parsed, [
      "findings",
      "vulns",
      "vulnerabilities",
      "advisories",
      "results",
      "issues",
      "secrets",
      "matches",
      "items"
    ]);
    items.forEach((item, index) => {
      const finding = toFinding(item, result.tool, fallbackTarget, index);
      if (finding) findings.push(finding);
    });
  }
  const rank: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  return findings.sort((a, b) => rank[a.severity] - rank[b.severity] || a.file.localeCompare(b.file));
}

/** O pedido que vai para o composer quando a pessoa clica em "aplicar". */
function applyRequest(finding: Finding): string {
  const where = finding.line !== undefined ? `${finding.file}:${finding.line}` : finding.file;
  const parts: string[] = [`Aplique a correção do achado "${finding.title}"${where ? ` em ${where}` : ""}.`];
  if (finding.reference) parts.push(`Referência: ${finding.reference}.`);
  if (finding.path.length > 0) parts.push(`Caminho até o dano: ${finding.path.join(" → ")}.`);
  if (finding.patch) parts.push("", "Patch proposto:", "```", finding.patch, "```");
  parts.push("", "Mostre o diff final e explique o que muda no comportamento.");
  return parts.join("\n");
}

/* ------------------------------ componente ------------------------------ */

/**
 * O advisory abre no NAVEGADOR da pessoa, nunca navega a janela do app: a
 * janela carrega a ponte nativa do Tauri, e apontá-la para um site de terceiro
 * entregaria a ponte junto (a mesma razão do sandbox vazio do CanvasSurface).
 * O plugin-opener já está na capability `default`; fora do Tauri (dev no
 * navegador) o fallback é a aba nova de sempre.
 */
function openAdvisory(url: string): void {
  openUrl(url).catch(() => {
    window.open(url, "_blank", "noopener,noreferrer");
  });
}

export function FindingsSurface() {
  const lines = useApp((state) => state.lines);
  const setInput = useApp((state) => state.setInput);
  const [filter, setFilter] = useState<Severity | "all">("all");
  const [category, setCategory] = useState<Category | "all">("all");

  // MEMO EM DUAS ETAPAS: a varredura por fonte é barata e roda por delta; o
  // PARSE dos achados só roda quando algum resultado troca de identidade — a
  // chave composta pelos callIds é o que detecta a troca sem depender da
  // identidade do array intermediário. Mesmo padrão do FlowSurface.
  const resultados = useMemo(() => SOURCE_TOOLS.map((tool) => latestResult(lines, tool)), [lines]);
  const chave = resultados.map((result) => result?.callId ?? "").join("|");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- a chave cobre os resultados
  const findings = useMemo(() => collectFindings(resultados), [chave]);

  const counts = useMemo(() => {
    const tally: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    for (const finding of findings) tally[finding.severity] += 1;
    return tally;
  }, [findings]);

  const categoryCounts = useMemo(() => {
    const tally: Record<Category, number> = { segredos: 0, dependências: 0 };
    for (const finding of findings) tally[finding.category] += 1;
    return tally;
  }, [findings]);

  // "N pacotes vulneráveis" conta PACOTES, não achados: o mesmo lodash com
  // quatro CVEs é UM pacote para atualizar — e é esse número que dimensiona o
  // trabalho.
  const vulnerablePackages = useMemo(() => {
    const packages = new Set<string>();
    for (const finding of findings) {
      if (finding.category === "dependências" && finding.file !== "") packages.add(finding.file);
    }
    return packages.size;
  }, [findings]);

  const groups = useMemo(() => {
    const bySeverity = filter === "all" ? findings : findings.filter((item) => item.severity === filter);
    const visible = category === "all" ? bySeverity : bySeverity.filter((item) => item.category === category);
    return SEVERITIES.map((severity) => ({
      severity,
      items: visible.filter((item) => item.severity === severity)
    })).filter((group) => group.items.length > 0);
  }, [findings, filter, category]);

  return (
    <section className="surface findings-surface">
      {/*
        O rodapé do app, por portal (ver shell/StatusBar).

        Sem achado nenhum o rodapé fica VAZIO de propósito. "0 achados" seria
        lido como "está limpo", e o que a tela sabe é outra coisa: que nenhuma
        varredura devolveu resultado ainda. As duas frases parecem iguais e só
        uma delas é verdade.
      */}
      {findings.length > 0 ? (
        <SurfaceStatus>
          <span className="statusbar-item">
            <ShieldCheck aria-hidden />
            <b>{findings.length}</b> {findings.length === 1 ? "achado" : "achados"}
          </span>
          {SEVERITIES.filter((severity) => counts[severity] > 0).map((severity) => (
            <span className="statusbar-item" key={severity}>
              {SEVERITY_LABEL[severity].toLowerCase()}: <b>{counts[severity]}</b>
            </span>
          ))}
        </SurfaceStatus>
      ) : null}

      <div className="surface-toolbar">
        <span className="surface-title">Achados</span>

        {/* Os dois números que resumem a mesa: o que queima (críticos/altos) e
            o tamanho do trabalho de dependência (pacotes, não CVEs). Só
            aparecem quando existem — zero aqui pareceria "está limpo", e o que
            a tela sabe é outra coisa. */}
        {counts.critical + counts.high > 0 ? (
          <span className="chip" data-active="true" title="achados de severidade crítica ou alta">
            {counts.critical + counts.high} críticos/altos
          </span>
        ) : null}
        {vulnerablePackages > 0 ? (
          <span className="chip" title="pacotes distintos com vulnerabilidade conhecida">
            {vulnerablePackages} {vulnerablePackages === 1 ? "pacote vulnerável" : "pacotes vulneráveis"}
          </span>
        ) : null}

        <span className="surface-toolbar-spacer" />

        {/* Filtro por CATEGORIA (a origem do achado)… */}
        {CATEGORIES.map((item) => (
          <button
            key={item}
            type="button"
            className="chip"
            data-active={category === item ? "true" : "false"}
            aria-pressed={category === item}
            disabled={categoryCounts[item] === 0}
            onClick={() => setCategory(category === item ? "all" : item)}
            title={
              item === "segredos"
                ? `${categoryCounts[item]} de secrets.scan`
                : `${categoryCounts[item]} de osv.query`
            }
          >
            {item}
            <span className="badge-risk">{categoryCounts[item]}</span>
          </button>
        ))}

        {/* …e por severidade: o contador vive no .badge-risk de cada chip. */}
        <button
          type="button"
          className="chip"
          data-active={filter === "all" ? "true" : "false"}
          aria-pressed={filter === "all"}
          onClick={() => setFilter("all")}
        >
          todos
          <span className="badge-risk">{findings.length}</span>
        </button>
        {SEVERITIES.map((severity) => (
          <button
            key={severity}
            type="button"
            className="chip"
            data-active={filter === severity ? "true" : "false"}
            aria-pressed={filter === severity}
            disabled={counts[severity] === 0}
            onClick={() => setFilter(severity)}
            title={`${counts[severity]} ${SEVERITY_LABEL[severity].toLowerCase()}`}
          >
            {SEVERITY_LABEL[severity].toLowerCase()}
            <span className="badge-risk" data-risk={SEVERITY_RISK[severity]} data-severity={severity}>
              {counts[severity]}
            </span>
          </button>
        ))}
      </div>

      <div className="surface-body">
        {findings.length === 0 ? (
          <div className="surface-empty">
            <ShieldCheck size={26} aria-hidden />
            <b>Nenhum achado na mesa</b>
            <span>
              Peça uma revisão na conversa: <code>/revisar</code> varre o projeto e <code>/deps</code>{" "}
              consulta as vulnerabilidades das dependências.
            </span>
          </div>
        ) : (
          groups.map((group) => (
            <section key={group.severity} className="findings-group">
              <h3 className="card-eyebrow">
                {SEVERITY_LABEL[group.severity]} · {group.items.length}
              </h3>

              {group.items.map((finding) => (
                <article key={finding.key} className="finding" data-severity={finding.severity}>
                  {/* `.finding` é grade de duas colunas: a barra colorida e ESTE bloco. */}
                  <div className="finding-main">
                    <div className="card-head">
                      <span className="finding-title">{finding.title}</span>
                      <span
                        className="badge-risk"
                        data-risk={SEVERITY_RISK[finding.severity]}
                        data-severity={finding.severity}
                      >
                        {SEVERITY_LABEL[finding.severity]}
                      </span>
                    </div>

                    <p className="finding-where">
                      {finding.file ? (
                        <span title={finding.file}>
                          {finding.file}
                          {finding.line !== undefined ? `:${finding.line}` : ""}
                        </span>
                      ) : null}
                      {finding.url ? (
                        // O href fica no <a> para hover/copiar; o clique é
                        // interceptado para abrir no navegador de fora (ver
                        // openAdvisory) em vez de navegar a janela do app.
                        <span>
                          {" · "}
                          <a
                            className="finding-advisory"
                            href={finding.url}
                            target="_blank"
                            rel="noreferrer"
                            title={`abrir ${finding.url} no navegador`}
                            onClick={(event) => {
                              event.preventDefault();
                              openAdvisory(finding.url);
                            }}
                          >
                            {finding.reference || "advisory"}
                            <ExternalLink size={11} aria-hidden />
                          </a>
                        </span>
                      ) : finding.reference ? (
                        <span> · {finding.reference}</span>
                      ) : null}
                      <span> · {finding.tool}</span>
                    </p>

                    {finding.detail ? <p className="finding-body">{finding.detail}</p> : null}

                    {finding.path.length > 0 ? (
                      <ol className="finding-path" aria-label="Caminho até o dano">
                        {finding.path.map((step, index) => (
                          <li key={`${finding.key}-step-${index}`}>
                            <span>{step}</span>
                            {index < finding.path.length - 1 ? <ArrowRight size={11} aria-hidden /> : null}
                          </li>
                        ))}
                      </ol>
                    ) : null}

                    {finding.patch ? (
                      <>
                        <pre className="finding-patch">
                          <code>{finding.patch}</code>
                        </pre>
                        <div className="card-foot">
                          {/*
                            "Aplicar" NÃO aplica: preenche o composer com o pedido.
                            Quem escreve no repositório é o especialista, com a
                            aprovação de ferramenta no caminho — um botão que edita
                            arquivo direto da lista de achados pula exatamente o
                            portão que existe para isso.
                          */}
                          <button
                            type="button"
                            className="btn btn-primary"
                            onClick={() => setInput(applyRequest(finding))}
                            title="Escreve o pedido no campo de texto; você revisa antes de enviar"
                          >
                            <Wand2 size={13} aria-hidden />
                            Aplicar
                          </button>
                          <span className="finding-hint">vai para o campo de texto</span>
                        </div>
                      </>
                    ) : null}
                  </div>
                </article>
              ))}
            </section>
          ))
        )}
      </div>

      <div className="surface-status">
        <span>
          <b>{findings.length}</b> achados
        </span>
        <span>
          crítico <b>{counts.critical}</b> · alto <b>{counts.high}</b> · médio <b>{counts.medium}</b> ·
          baixo <b>{counts.low}</b>
        </span>
        <span className="surface-toolbar-spacer" />
        <span>fonte: secrets.scan · osv.query</span>
      </div>
    </section>
  );
}

export default FindingsSurface;
