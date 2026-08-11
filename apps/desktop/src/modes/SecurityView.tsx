/**
 * SECURITY — revisão multi-modelo com diff aplicável (estilo Cursor) e
 * auditoria REAL de dependências via OSV.dev (lib/osv.ts, pura). Scan local
 * de segredos (lib/scan.ts, puro) sobre pasta do projeto (desktop), código
 * colado ou arquivos enviados (funciona no navegador). Nada é simulado.
 * Layout: centro = achados/diff/audit · direita = escopo · rail = rota
 * ativa, atalhos e revisões. O comando sandbox_execute permanece no backend;
 * a UI não o expõe.
 */
import "../styles/modes/security.css";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { FsEntry, SecurityFinding } from "@ai-orchestrator/contracts";
import {
  Boxes,
  Check,
  ChevronRight,
  ExternalLink,
  Files,
  FolderOpen,
  KeyRound,
  ListFilter,
  LockKeyhole,
  Merge,
  MessageSquarePlus,
  Package,
  Radar,
  ScanLine,
  ShieldCheck,
  Upload,
  UserCheck,
  X
} from "lucide-react";
import {
  EmptyHero,
  FloatingPulse,
  PanelScroll,
  PanelTitle,
  PromptCards,
  RowItem,
  Surface,
  TopbarActions,
  VBody,
  VCenter,
  VRight,
  VStatus
} from "../components/Primitives";
import { RailConversations } from "../components/RailConversations";
import { chatOnce, describeSelection, type EngineContext } from "../lib/engine";
import {
  buildFixPrompt,
  parseLockfile,
  queryOsv,
  worstSeverity,
  type OsvSeverity,
  type PackageAudit
} from "../lib/osv";
import {
  applyUnifiedDiff,
  buildReviewPrompt,
  parseFindings,
  parseUnifiedDiff,
  scanTextForSecrets
} from "../lib/scan";
import { useApp } from "../lib/store";

const isTauriHost = "__TAURI_INTERNALS__" in window;

interface ScannedFile {
  path: string;
  content: string;
}

type Resolution = "applied" | "memory" | "rejected";

const CATEGORIES = ["Arquivos alterados", "Dependências", "Segredos", "Auth", "Supply chain"] as const;
type Category = (typeof CATEGORIES)[number];

const categoryIcons: Record<Category, typeof Files> = {
  "Arquivos alterados": Files,
  Dependências: Package,
  Segredos: KeyRound,
  Auth: UserCheck,
  "Supply chain": Boxes
};

function categorize(finding: SecurityFinding): Category {
  const text = `${finding.title} ${finding.detail}`.toLowerCase();
  const file = finding.file.toLowerCase();
  if (/package(-lock)?\.json|pnpm-lock|requirements|cargo\.(toml|lock)|pom\.xml|go\.(mod|sum)|gemfile/.test(file)) {
    return "Dependências";
  }
  if (/depend[êe]ncia|pacote|biblioteca|vers[ãa]o|\bpin\b/.test(text)) return "Dependências";
  if (/supply|pipeline|workflow|\bci\b|post-install|typosquat/.test(text) || /\.github|workflow/.test(file)) {
    return "Supply chain";
  }
  if (/segredo|senha|password|chave|token|credencial|secret|bearer|connection/.test(text)) return "Segredos";
  if (/auth|sess[ãa]o|login|permiss|rbac|oauth|jwt/.test(text)) return "Auth";
  return "Arquivos alterados";
}

const severityColor: Record<SecurityFinding["severity"], string> = {
  critical: "var(--danger)",
  high: "var(--danger)",
  medium: "var(--warn)",
  low: "var(--info)",
  info: "var(--info)"
};

const osvSeverityColor: Record<OsvSeverity, string> = {
  critical: "var(--danger)",
  high: "var(--danger)",
  medium: "var(--warn)",
  low: "var(--info)",
  unknown: "var(--faint)"
};

const severityRank: Record<SecurityFinding["severity"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4
};

const TEXT_FILE_PATTERN =
  /\.(ts|tsx|js|jsx|mjs|cjs|json|jsonc|md|txt|yml|yaml|toml|ini|env|cfg|conf|py|rb|go|rs|java|kt|cs|php|sh|ps1|psm1|sql|html|css|scss|xml|properties|tf|lock)$/i;

function isTextLike(name: string): boolean {
  return TEXT_FILE_PATTERN.test(name) || /^\.?env(\..+)?$/i.test(name) || /^dockerfile$/i.test(name);
}

const PASTED_PATH = "colado/trecho";

function mergeFindings(current: SecurityFinding[], incoming: SecurityFinding[]): SecurityFinding[] {
  const seen = new Set(current.map((finding) => `${finding.file}::${finding.title}`));
  const usedIds = new Set(current.map((finding) => finding.id));
  const added: SecurityFinding[] = [];
  for (const finding of incoming) {
    const key = `${finding.file}::${finding.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Revisões sucessivas geram ids "ai-N" repetidos — remapeia para não
    // colidir chave de renderização nem estado de aplicar/rejeitar.
    let id = finding.id;
    for (let bump = 2; usedIds.has(id); bump += 1) id = `${finding.id}-${bump}`;
    usedIds.add(id);
    added.push(id === finding.id ? finding : { ...finding, id });
  }
  return [...current, ...added];
}

async function openLink(url: string) {
  if (isTauriHost) {
    try {
      await openUrl(url);
      return;
    } catch {
      // plugin indisponível: cai no navegador padrão do webview
    }
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/** Atalhos de revisão do rail — prompts reais enviados ao composer. */
const railShortcuts: { label: string; prompt: string; icon: typeof ScanLine }[] = [
  {
    label: "Revisar mudanças",
    prompt: "Revise as mudanças recentes e proponha patches em diff unificado",
    icon: ScanLine
  },
  {
    label: "Modelar ameaças STRIDE",
    prompt: "Modele ameaças STRIDE deste projeto e priorize as correções",
    icon: Radar
  }
];

/** Rail dinâmico da aba Security: rota de revisão ativa, atalhos e histórico. */
export function SecurityRail() {
  const engine = useApp((state) => state.settings.engines.security);
  const fusionPresets = useApp((state) => state.settings.fusionPresets);
  const modelCatalog = useApp((state) => state.settings.modelCatalog);
  const routeLabel = describeSelection(engine, fusionPresets, modelCatalog);
  const preset = engine.kind === "fusion" ? fusionPresets.find((item) => item.id === engine.presetId) : undefined;
  const routeTitle = preset
    ? `${preset.name} (${preset.strategy}): ${preset.orchestrator.model} → ${preset.executors
        .map((executor) => executor.model)
        .join(" + ")}`
    : routeLabel;
  return (
    <>
      <span className="eyebrow">ROTA ATIVA</span>
      <span className="secx-rail-route" title={routeTitle}>
        <Merge size={12} />
        <span>{routeLabel}</span>
      </span>
      <span className="eyebrow">ATALHOS</span>
      {railShortcuts.map(({ label, prompt, icon: Icon }) => (
        <button key={label} title={prompt} onClick={() => useApp.getState().setInput(prompt)}>
          <Icon size={14} />
          <span>{label}</span>
        </button>
      ))}
      <ReviewCascade />
      <span className="eyebrow">REVISÕES</span>
      <RailConversations mode="security" />
    </>
  );
}

/**
 * Cascata de revisão (do produto original, com estados REAIS):
 * 1º Kimi/runtime local → 2º gateway do workspace → 3º gate determinístico.
 */
function ReviewCascade() {
  const runtimeStatus = useApp((state) => state.runtimeStatus);
  const session = useApp((state) => state.session);
  const gatewayOk = Boolean(session?.accessToken && session.workspaceId);
  const steps: Array<{ order: string; label: string; state: string; on: boolean }> = [
    {
      order: "1",
      label: "Kimi / runtime local",
      state: runtimeStatus.running ? "ativo agora" : runtimeStatus.installed ? "instalado · parado" : "não instalado",
      on: runtimeStatus.running
    },
    {
      order: "2",
      label: "Gateway do workspace",
      state: gatewayOk ? "conectado" : "desconectado",
      on: gatewayOk
    },
    {
      order: "3",
      label: "Gate determinístico",
      state: "sempre ativo (segredos mascarados)",
      on: true
    }
  ];
  return (
    <>
      <span className="eyebrow">CASCATA DE REVISÃO</span>
      <div className="secx-cascade">
        {steps.map((step) => (
          <div className={`secx-cascade-step ${step.on ? "on" : ""}`} key={step.order}>
            <span>{step.order}</span>
            <div>
              <strong>{step.label}</strong>
              <small>{step.state}</small>
            </div>
            <i />
          </div>
        ))}
      </div>
    </>
  );
}

export function SecurityView() {
  const session = useApp((state) => state.session);
  const runtimeStatus = useApp((state) => state.runtimeStatus);
  const settings = useApp((state) => state.settings);
  const thread = useApp((state) => state.threads.security);
  const stage = useApp((state) => state.stage);
  const setStage = useApp((state) => state.setStage);

  const [root, setRoot] = useState(() => {
    try {
      return window.localStorage.getItem("security.root") ?? "";
    } catch {
      return "";
    }
  });
  const [files, setFiles] = useState<ScannedFile[]>([]);
  const [findings, setFindings] = useState<SecurityFinding[]>([]);
  const [category, setCategory] = useState<Category | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [resolutions, setResolutions] = useState<Record<string, Resolution>>({});
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [reviewNote, setReviewNote] = useState("");
  const [pasteCode, setPasteCode] = useState("");
  const [lockText, setLockText] = useState("");
  const [audits, setAudits] = useState<PackageAudit[] | null>(null);
  const [auditing, setAuditing] = useState(false);
  const [auditNote, setAuditNote] = useState("");
  const [auditSource, setAuditSource] = useState("");
  const [auditTotal, setAuditTotal] = useState(0);
  const [expandedPkg, setExpandedPkg] = useState("");
  const codeFileRef = useRef<HTMLInputElement>(null);
  const lockFileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem("security.root", root);
    } catch {
      // storage indisponível não bloqueia a view
    }
  }, [root]);

  const selection = settings.engines.security;

  const severityCount = useMemo(() => {
    const acc = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    for (const finding of findings) acc[finding.severity] += 1;
    return acc;
  }, [findings]);

  const categoryCount = useMemo(() => {
    const acc = new Map<Category, number>();
    for (const finding of findings) {
      const key = categorize(finding);
      acc.set(key, (acc.get(key) ?? 0) + 1);
    }
    return acc;
  }, [findings]);

  const visibleFindings = useMemo(() => {
    const filtered = category ? findings.filter((finding) => categorize(finding) === category) : findings;
    return [...filtered].sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);
  }, [findings, category]);

  const totalAdvisories = useMemo(
    () => (audits ?? []).reduce((acc, audit) => acc + audit.vulns.length, 0),
    [audits]
  );

  /** Substitui (ou insere) uma fonte no escopo e re-escaneia só ela. */
  function ingestSource(path: string, content: string): number {
    setFiles((current) => [...current.filter((file) => file.path !== path), { path, content }]);
    const incoming = scanTextForSecrets(path, content);
    setFindings((current) => [...current.filter((finding) => finding.file !== path), ...incoming]);
    // Ids locais são determinísticos (regra:arquivo:linha) — descarta o estado
    // aplicar/rejeitar da fonte re-escaneada para não herdar chip antigo.
    setResolutions((current) => {
      const next: Record<string, Resolution> = {};
      for (const [id, value] of Object.entries(current)) {
        if (!id.includes(`:${path}:`)) next[id] = value;
      }
      return next;
    });
    return incoming.length;
  }

  async function runScan() {
    if (!isTauriHost || scanning) return;
    setScanning(true);
    setScanNote("");
    setFindings([]);
    setResolutions({});
    setSelectedId("");
    setCategory(null);
    try {
      const entries = await invoke<FsEntry[]>("fs_list", { root: root.trim(), sub: "" });
      const textCandidates = entries.filter(
        (entry) => !entry.isDir && entry.size < 400_000 && isTextLike(entry.name)
      );
      const candidates = textCandidates.slice(0, 20);
      const reads = await Promise.all(
        candidates.map(async (entry) => {
          try {
            const content = await invoke<string>("fs_read", { root: root.trim(), path: entry.path });
            return { path: entry.path, content } satisfies ScannedFile;
          } catch {
            return null;
          }
        })
      );
      const sources = reads.filter((file): file is ScannedFile => file !== null);
      setFiles(sources);
      setFindings(sources.flatMap((file) => scanTextForSecrets(file.path, file.content)));
      setScanNote(
        `${sources.length} arquivo(s) de texto da raiz da pasta escaneados` +
          (textCandidates.length > candidates.length
            ? ` (limite de 20 — havia ${textCandidates.length}).`
            : ". Subpastas não são varridas.")
      );
    } catch (cause) {
      setScanNote(cause instanceof Error ? cause.message : String(cause));
      setFiles([]);
    } finally {
      setScanning(false);
    }
  }

  function scanPasted() {
    if (!pasteCode.trim()) return;
    const count = ingestSource(PASTED_PATH, pasteCode);
    setScanNote(`Trecho colado escaneado: ${count} achado(s) de segredo.`);
  }

  async function onCodeFiles(event: React.ChangeEvent<HTMLInputElement>) {
    const list = event.target.files;
    if (!list?.length) return;
    let total = 0;
    let read = 0;
    for (const file of Array.from(list).slice(0, 10)) {
      try {
        total += ingestSource(`upload/${file.name}`, await file.text());
        read += 1;
      } catch {
        // arquivo ilegível é ignorado
      }
    }
    setScanNote(`${read} arquivo(s) enviados e escaneados: ${total} achado(s) de segredo.`);
    event.target.value = "";
  }

  async function runDeepReview() {
    if (!files.length || reviewing) return;
    setReviewing(true);
    setReviewNote("");
    const ctx: EngineContext = {
      session,
      runtimeRunning: runtimeStatus.running,
      fusionPresets: settings.fusionPresets
    };
    try {
      const answer = await chatOnce(selection, "security", buildReviewPrompt(files), ctx, {
        onDelta: () => undefined,
        onStage: (value) => setStage(value)
      });
      const incoming = parseFindings(answer);
      if (!incoming.length && answer.includes("modo demonstração")) {
        setReviewNote(
          "Motor em modo demonstração — nenhum achado gerado. Conecte o gateway, um provedor (BYOK) ou o runtime local em Configurações."
        );
      } else if (!incoming.length) {
        setReviewNote("O revisor não retornou achados estruturados.");
      } else {
        setReviewNote(`Revisão profunda concluída: ${incoming.length} achado(s) do revisor.`);
      }
      setFindings((current) => mergeFindings(current, incoming));
    } catch (cause) {
      setReviewNote(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setReviewing(false);
      setStage("");
    }
  }

  async function runAudit(text: string, label: string) {
    if (auditing) return;
    setAuditing(true);
    setAuditNote("Interpretando lockfile…");
    try {
      const { kind, packages } = parseLockfile(text);
      if (kind === "unknown" || !packages.length) {
        setAudits(null);
        setAuditNote(
          kind === "unknown"
            ? "Formato não reconhecido — cole um package-lock.json (v1/v2/v3) ou pnpm-lock.yaml (v5/v6/v9)."
            : "Nenhum pacote com versão resolvida encontrado no lockfile."
        );
        return;
      }
      setAuditSource(label);
      setAuditTotal(packages.length);
      const result = await queryOsv(packages, window.fetch.bind(window), {
        detailLimit: 20,
        onProgress: (message) => setAuditNote(message)
      });
      setAudits(result);
      setExpandedPkg("");
      const advisories = result.reduce((acc, audit) => acc + audit.vulns.length, 0);
      setAuditNote(
        `${packages.length} pacote(s) consultados no OSV.dev — ${result.length} vulnerável(is), ${advisories} advisories.`
      );
    } catch (cause) {
      setAuditNote(cause instanceof Error ? `Falha na auditoria: ${cause.message}` : String(cause));
    } finally {
      setAuditing(false);
    }
  }

  async function readProjectLockfile() {
    if (!isTauriHost || auditing) return;
    for (const name of ["package-lock.json", "pnpm-lock.yaml"]) {
      try {
        const content = await invoke<string>("fs_read", { root: root.trim(), path: name });
        setLockText(content);
        await runAudit(content, `${name} (projeto)`);
        return;
      } catch {
        // tenta o próximo lockfile
      }
    }
    setAuditNote("Nenhum package-lock.json ou pnpm-lock.yaml encontrado na raiz configurada.");
  }

  async function onLockFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      setLockText(text);
      await runAudit(text, file.name);
    } catch (cause) {
      setAuditNote(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function askFixDeps(target?: PackageAudit) {
    if (!audits?.length) return;
    const prompt = buildFixPrompt(target ? [target] : audits, auditSource || "lockfile");
    useApp.getState().setInput(prompt);
  }

  async function applyPatch(finding: SecurityFinding) {
    if (!finding.patch) return;
    const source = files.find((file) => file.path === finding.file);
    const nextContent = source ? applyUnifiedDiff(source.content, finding.patch) : null;
    if (nextContent === null) {
      setReviewNote(`Patch não aplica ao conteúdo atual de ${finding.file} — o arquivo mudou desde o scan.`);
      return;
    }
    const inMemoryOnly = !isTauriHost || finding.file.startsWith("colado/") || finding.file.startsWith("upload/");
    if (!inMemoryOnly) {
      try {
        await invoke("fs_write", { root: root.trim(), path: finding.file, content: nextContent });
        setFiles((current) =>
          current.map((file) => (file.path === finding.file ? { ...file, content: nextContent } : file))
        );
        setResolutions((current) => ({ ...current, [finding.id]: "applied" }));
      } catch (cause) {
        setReviewNote(cause instanceof Error ? cause.message : String(cause));
      }
      return;
    }
    // Conteúdo colado/enviado (ou navegador): aplica no conteúdo em memória e rotula.
    setFiles((current) =>
      current.map((file) => (file.path === finding.file ? { ...file, content: nextContent } : file))
    );
    if (finding.file === PASTED_PATH) setPasteCode(nextContent);
    setResolutions((current) => ({ ...current, [finding.id]: "memory" }));
  }

  function askAboutFinding(finding: SecurityFinding) {
    const where = `${finding.file}${finding.line ? `:${finding.line}` : ""}`;
    useApp
      .getState()
      .setInput(`Explique e proponha um patch em diff unificado para: ${finding.title} em ${where}`);
  }

  const scanDisabled = scanning || !root.trim();
  const lowInfoCount = severityCount.low + severityCount.info;
  const showHero = visibleFindings.length === 0 && audits === null;

  return (
    <Surface>
      <TopbarActions>
        {severityCount.critical + severityCount.high > 0 && (
          <span className="chip danger">{severityCount.critical + severityCount.high} críticos/altos</span>
        )}
        {audits !== null && audits.length > 0 && (
          <span className="chip danger">
            <Package size={11} />
            {audits.length} pacotes vulneráveis
          </span>
        )}
      </TopbarActions>

      <VBody>
        <VCenter className="secx-center">
          {(thread.sending || reviewing || scanning || auditing) && (
            <FloatingPulse
              label={stage || (auditing ? "Auditoria OSV.dev" : reviewing ? "Revisão profunda" : "Escaneando")}
              detail="Arquivos, dependências e segredos sob revisão — valores nunca são logados"
            />
          )}
          <div className="secx-board">
            {audits !== null && (
              <section className="secx-deps">
                <header className="secx-deps-head">
                  <strong>
                    <Package size={13} />
                    Auditoria de dependências — OSV.dev
                  </strong>
                  <small>
                    {auditSource} · {auditTotal} pacotes consultados · {audits.length} vulneráveis ·{" "}
                    {totalAdvisories} advisories
                  </small>
                  {audits.length > 0 && (
                    <button className="lg-button ghost" onClick={() => askFixDeps()}>
                      <MessageSquarePlus size={13} />
                      Pedir correção ao agente
                    </button>
                  )}
                </header>
                {audits.length === 0 ? (
                  <p className="secx-deps-clean">
                    <ShieldCheck size={13} />
                    Nenhuma vulnerabilidade conhecida (OSV.dev) nos {auditTotal} pacotes consultados.
                  </p>
                ) : (
                  <div className="secx-deps-list">
                    {audits.map((audit, index) => {
                      const key = `${audit.name}@${audit.version}`;
                      const open = expandedPkg === key;
                      const worst = worstSeverity(audit);
                      return (
                        <article
                          className={`secx-dep ${open ? "selected" : ""}`}
                          key={key}
                          style={{ "--i": index } as CSSProperties}
                        >
                          <button className="secx-dep-head" onClick={() => setExpandedPkg(open ? "" : key)}>
                            <i className="secx-sev" style={{ background: osvSeverityColor[worst] }} />
                            <span className="secx-dep-copy">
                              <strong>{key}</strong>
                              <small>
                                {audit.vulns.length} advisories · pior severidade: {worst}
                              </small>
                            </span>
                            <ChevronRight size={13} style={{ transform: open ? "rotate(90deg)" : "none" }} />
                          </button>
                          {open && (
                            <div className="secx-dep-body">
                              {audit.vulns.map((vuln) => (
                                <div className="secx-vuln" key={vuln.id}>
                                  <span className="chip" style={{ color: osvSeverityColor[vuln.severity] }}>
                                    {vuln.severity}
                                    {typeof vuln.score === "number" ? ` ${vuln.score.toFixed(1)}` : ""}
                                  </span>
                                  <span className="secx-vuln-copy">
                                    <strong>{vuln.id}</strong>
                                    {vuln.summary && <small>{vuln.summary}</small>}
                                    {vuln.fixed && <small>corrigido em {vuln.fixed}</small>}
                                    {!vuln.enriched && (
                                      <small>detalhes não carregados — abra o advisory no OSV.dev</small>
                                    )}
                                  </span>
                                  <button
                                    className="lg-button ghost"
                                    onClick={() => void openLink(vuln.link)}
                                    title={vuln.link}
                                  >
                                    <ExternalLink size={12} />
                                    osv.dev
                                  </button>
                                </div>
                              ))}
                              <button className="lg-button ghost" onClick={() => askFixDeps(audit)}>
                                <MessageSquarePlus size={13} />
                                Pedir correção deste pacote
                              </button>
                            </div>
                          )}
                        </article>
                      );
                    })}
                  </div>
                )}
              </section>
            )}
            {showHero ? (
              <EmptyHero
                icon={<ShieldCheck size={28} />}
                kicker="REVISÃO MULTI-MODELO"
                title="Revise antes de publicar."
                detail={
                  isTauriHost
                    ? "Escaneie a pasta do projeto, cole código ou audite o lockfile no OSV.dev — heurísticas locais de segredos e revisão profunda com orquestrador e executor."
                    : "Cole código ou envie arquivos para o scan real de segredos, e audite um lockfile no OSV.dev — tudo funciona aqui; gravar patches requer o app desktop."
                }
              >
                <PromptCards
                  prompts={[
                    "Procure segredos e credenciais expostas",
                    "Revise as mudanças recentes e proponha patches",
                    "Avalie riscos de supply chain nas dependências"
                  ]}
                  onPrompt={(prompt) => useApp.getState().setInput(prompt)}
                />
              </EmptyHero>
            ) : visibleFindings.length === 0 ? (
              findings.length > 0 ? (
                <p className="secx-empty-note">Nenhum achado nesta categoria — escolha outra à direita.</p>
              ) : null
            ) : (
              <div className="secx-findings">
                {visibleFindings.map((finding, index) => {
                  const selected = selectedId === finding.id;
                  const resolution = resolutions[finding.id];
                  return (
                    <article
                      className={`secx-finding ${selected ? "selected" : ""}`}
                      key={finding.id}
                      style={{ "--i": index } as CSSProperties}
                    >
                      <button
                        className="secx-finding-head"
                        onClick={() => setSelectedId(selected ? "" : finding.id)}
                      >
                        <i className="secx-sev" style={{ background: severityColor[finding.severity] }} />
                        <span className="secx-finding-copy">
                          <strong>{finding.title}</strong>
                          <small>
                            {finding.file}
                            {finding.line ? `:${finding.line}` : ""} · {finding.severity} ·{" "}
                            {categorize(finding)}
                          </small>
                          <p>{finding.detail}</p>
                        </span>
                        <span className="secx-finding-side">
                          {resolution === "applied" && <span className="chip ok">patch aplicado</span>}
                          {resolution === "memory" && (
                            <span className="chip ok" title="Conteúdo atualizado em memória — gravar em disco requer o app desktop">
                              aplicado em memória
                            </span>
                          )}
                          {resolution === "rejected" && <span className="chip danger">rejeitado</span>}
                          {finding.patch && !resolution && <span className="chip accent">patch</span>}
                          <ChevronRight size={13} style={{ transform: selected ? "rotate(90deg)" : "none" }} />
                        </span>
                      </button>
                      {selected && (
                        <div className="secx-finding-body">
                          {finding.suggestion && (
                            <p className="secx-suggestion">
                              <ShieldCheck size={12} />
                              {finding.suggestion}
                            </p>
                          )}
                          {finding.patch ? (
                            <>
                              <div className="diff-block">
                                {parseUnifiedDiff(finding.patch).map((line, lineIndex) => (
                                  <div
                                    className={`diff-line ${
                                      line.type === "add" ? "add" : line.type === "remove" ? "remove" : ""
                                    }`}
                                    key={`${finding.id}-${lineIndex}`}
                                  >
                                    <span>
                                      {line.type === "add"
                                        ? "+"
                                        : line.type === "remove"
                                          ? "−"
                                          : line.type === "hunk"
                                            ? "@@"
                                            : ""}
                                    </span>
                                    <code>{line.text}</code>
                                  </div>
                                ))}
                              </div>
                              {!resolution && (
                                <div className="secx-patch-actions">
                                  <button className="lg-button primary" onClick={() => void applyPatch(finding)}>
                                    <Check size={13} />
                                    Aplicar patch
                                  </button>
                                  <button
                                    className="lg-button"
                                    onClick={() =>
                                      setResolutions((current) => ({ ...current, [finding.id]: "rejected" }))
                                    }
                                  >
                                    <X size={13} />
                                    Rejeitar
                                  </button>
                                </div>
                              )}
                            </>
                          ) : (
                            <div className="secx-patch-actions">
                              <button className="lg-button ghost" onClick={() => askAboutFinding(finding)}>
                                <MessageSquarePlus size={13} />
                                Pedir correção no chat
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        </VCenter>

        <VRight>
          <PanelTitle
            icon={<FolderOpen size={13} />}
            label="Escopo"
            meta={files.length ? `${files.length} arquivos` : undefined}
          />
          <div className="secx-scope">
            {isTauriHost ? (
              <>
                <label className="lg-field">
                  Pasta do projeto
                  <input
                    value={root}
                    onChange={(event) => setRoot(event.target.value)}
                    placeholder="C:\projetos\meu-app"
                  />
                </label>
                <button className="lg-button primary" disabled={scanDisabled} onClick={() => void runScan()}>
                  <ScanLine size={13} />
                  {scanning ? "Escaneando…" : "Escanear"}
                </button>
              </>
            ) : (
              <small className="secx-note">
                Cole ou envie código — o scan de segredos roda aqui; escanear pasta e gravar patches requerem o
                app desktop.
              </small>
            )}
            <label className="lg-field">
              Colar código
              <textarea
                className="secx-paste"
                rows={4}
                value={pasteCode}
                onChange={(event) => setPasteCode(event.target.value)}
                placeholder="cole um trecho, config ou .env suspeito…"
                aria-label="Código para escanear"
              />
            </label>
            <div className="secx-actions-row">
              <button className="lg-button" disabled={!pasteCode.trim()} onClick={scanPasted}>
                <ScanLine size={13} />
                Escanear colado
              </button>
              <button className="lg-button" onClick={() => codeFileRef.current?.click()}>
                <Upload size={13} />
                Enviar arquivos
              </button>
              <input ref={codeFileRef} type="file" multiple hidden onChange={(event) => void onCodeFiles(event)} />
            </div>
            <button className="lg-button" disabled={!files.length || reviewing} onClick={() => void runDeepReview()}>
              <Merge size={13} />
              {reviewing ? "Revisando…" : "Revisão profunda (multi-modelo)"}
            </button>
            {scanNote && <small className="secx-note">{scanNote}</small>}
            {reviewNote && <small className="secx-note">{reviewNote}</small>}
          </div>

          <PanelTitle
            icon={<Package size={13} />}
            label="Dependências"
            meta={audits !== null ? `${audits.length} vulneráveis` : undefined}
          />
          <div className="secx-scope">
            {isTauriHost && (
              <button
                className="lg-button"
                disabled={auditing || !root.trim()}
                onClick={() => void readProjectLockfile()}
              >
                <FolderOpen size={13} />
                Ler lockfile do projeto
              </button>
            )}
            <div className="secx-actions-row">
              <button className="lg-button" disabled={auditing} onClick={() => lockFileRef.current?.click()}>
                <Upload size={13} />
                Enviar lockfile
              </button>
              <input
                ref={lockFileRef}
                type="file"
                accept=".json,.yaml,.yml"
                hidden
                onChange={(event) => void onLockFile(event)}
              />
            </div>
            <label className="lg-field">
              Colar lockfile
              <textarea
                className="secx-paste"
                rows={3}
                value={lockText}
                onChange={(event) => setLockText(event.target.value)}
                placeholder="package-lock.json ou pnpm-lock.yaml…"
                aria-label="Lockfile para auditar"
              />
            </label>
            <button
              className="lg-button primary"
              disabled={auditing || !lockText.trim()}
              onClick={() => void runAudit(lockText, "lockfile colado")}
            >
              <Radar size={13} />
              {auditing ? "Auditando…" : "Auditar no OSV.dev"}
            </button>
            {auditNote && <small className="secx-note">{auditNote}</small>}
          </div>

          <PanelTitle label="Categorias" meta={String(findings.length)} />
          <PanelScroll>
            <RowItem
              icon={<ListFilter size={13} />}
              label="Tudo"
              meta={String(findings.length)}
              active={category === null}
              onClick={() => setCategory(null)}
            />
            {CATEGORIES.map((item) => {
              const Icon = categoryIcons[item];
              return (
                <RowItem
                  key={item}
                  icon={<Icon size={13} />}
                  label={item}
                  meta={String(categoryCount.get(item) ?? 0)}
                  active={category === item}
                  onClick={() => setCategory(category === item ? null : item)}
                />
              );
            })}
          </PanelScroll>
        </VRight>
      </VBody>

      <VStatus>
        <span>
          <ShieldCheck size={11} />
          {severityCount.critical} críticos · {severityCount.high} altos · {severityCount.medium} médios ·{" "}
          {lowInfoCount} baixos/info
        </span>
        <span>
          <Package size={11} />
          deps: {audits !== null ? `${audits.length} vulneráveis de ${auditTotal} (OSV.dev)` : "não auditadas"}
        </span>
        <div className="spacer" />
        <span>
          <LockKeyhole size={11} />
          segredos nunca são logados
        </span>
      </VStatus>
    </Surface>
  );
}
