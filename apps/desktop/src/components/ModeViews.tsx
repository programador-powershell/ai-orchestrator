import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type { DesignReplicationResult, Mode, OrchestrationGraph, OrchestrationPlan, TerminalResult } from "@multiplike/contracts";
import type { ChatMessage } from "../lib/gateway";
import {
  ArrowRight,
  ArrowUpRight,
  Blocks,
  Bot,
  Box,
  Bug,
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock3,
  Code2,
  Component,
  Database,
  Download,
  Eye,
  FileWarning,
  FileCode2,
  FilePlus2,
  GitBranch,
  Globe2,
  Gamepad2,
  Grid3X3,
  KeyRound,
  Layers3,
  Link2,
  ListTree,
  LockKeyhole,
  Maximize,
  Merge,
  MessageCircle,
  Monitor,
  MoreHorizontal,
  MousePointer2,
  Network,
  Palette,
  PackageCheck,
  PanelRight,
  Play,
  Plus,
  Redo2,
  RefreshCw,
  Rows3,
  ScanLine,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Table2,
  TerminalSquare,
  Undo2,
  Upload,
  UserCheck,
  Users,
  WandSparkles,
  Workflow,
  Zap,
  SlidersHorizontal
} from "lucide-react";

interface ModeViewProps {
  mode: Mode;
  messages: ChatMessage[];
  sending: boolean;
  processingLabel: string;
  onPrompt: (prompt: string) => void;
  onReplicate?: (sourceUrl: string) => Promise<DesignReplicationResult>;
  onValidateGraph?: (graph: OrchestrationGraph) => Promise<OrchestrationPlan>;
  onTerminalRun: (command: string, cwd?: string) => Promise<TerminalResult>;
  onOpenExternal: (url: string) => Promise<void>;
}

function ProcessPulse({ label, detail }: { label: string; detail: string }) {
  return (
    <div className="process-pulse" role="status" aria-live="polite">
      <span className="particle-sphere" aria-hidden="true">
        <i className="particle-core" />
        {Array.from({ length: 28 }, (_, index) => (
          <i
            className="burst-particle"
            key={index}
            style={{
              "--angle": `${index * 12.86}deg`,
              "--distance": `${19 + (index % 7) * 3}px`,
              "--delay": `${-(index % 9) * 90}ms`
            } as CSSProperties}
          />
        ))}
      </span>
      <span className="process-copy"><strong>{label}<i /><i /><i /></strong><small>{detail}</small></span>
    </div>
  );
}

function SurfaceHeader({ eyebrow, title, detail, action, onAction }: { eyebrow: string; title: string; detail: string; action?: string; onAction?: () => void }) {
  return (
    <header className="surface-header">
      <div><span>{eyebrow}</span><h1>{title}</h1><p>{detail}</p></div>
      {action && <button className="liquid-button compact" onClick={onAction}><Sparkles size={14} />{action}</button>}
    </header>
  );
}

function ChatView({ messages, sending, processingLabel, onPrompt }: Pick<ModeViewProps, "messages" | "sending" | "processingLabel" | "onPrompt">) {
  if (messages.length) {
    return (
      <section className="mode-surface chat-surface">
        <div className="chat-thread">
          {messages.map((message, index) => (
            <article className={`chat-message ${message.role}`} key={`${message.role}-${index}`}>
              <span>{message.role === "user" ? "Você" : <Sparkles size={14} />}</span>
              {message.content ? <p>{message.content}</p> : sending && index === messages.length - 1 ? <ProcessPulse label={processingLabel} detail="Raciocinando sobre contexto, rotas e ferramentas" /> : null}
            </article>
          ))}
        </div>
      </section>
    );
  }
  return (
    <section className="mode-surface chat-surface chat-empty">
      <div className="hero-lens"><MessageCircle size={28} /><i /></div>
      <span className="surface-kicker">CONVERSA ADAPTATIVA</span>
      <h1>O que vamos explorar?</h1>
      <p>Pesquise, pense e transforme contexto em decisões claras.</p>
      <div className="prompt-cards">
        {["Estruture uma ideia complexa", "Compare caminhos possíveis", "Prepare uma decisão executiva"].map((prompt, index) => (
          <button onClick={() => onPrompt(prompt)} key={prompt}><span>0{index + 1}</span><strong>{prompt}</strong><ArrowUpRight size={15} /></button>
        ))}
      </div>
    </section>
  );
}

function WorkView({ onPrompt, sending, processingLabel }: Pick<ModeViewProps, "onPrompt" | "sending" | "processingLabel">) {
  return (
    <section className="mode-surface work-surface">
      {sending && <ProcessPulse label={processingLabel} detail="Decompondo objetivo em entregas verificáveis" />}
      <SurfaceHeader eyebrow="WORKSPACE / LANÇAMENTO" title="Mission control" detail="Objetivos, entregas e decisões num único fluxo." action="Planejar sprint" onAction={() => onPrompt("Planeje o próximo sprint com dependências e critérios de aceite")} />
      <div className="work-layout">
        <article className="glass-panel objective-card">
          <div className="panel-title"><span><Workflow size={16} /> Objetivo ativo</span><small>72%</small></div>
          <h2>Lançar a primeira versão pública</h2>
          <p>Produto, documentação, distribuição, segurança e operação inicial.</p>
          <div className="objective-progress"><i /></div>
          <div className="milestone-list">
            <div className="complete"><span><Check size={13} /></span><div><strong>Arquitetura aprovada</strong><small>Concluído hoje</small></div></div>
            <div className="active"><span>02</span><div><strong>Validar experiência desktop</strong><small>3 tarefas em andamento</small></div></div>
            <div><span>03</span><div><strong>Preparar release assinado</strong><small>Aguardando gates</small></div></div>
          </div>
        </article>
        <div className="work-side">
          <article className="glass-panel artifact-panel">
            <div className="panel-title"><span>Entregas</span><button><FilePlus2 size={14} /></button></div>
            {["Release checklist", "Guia de onboarding", "Plano de observabilidade"].map((item, index) => <button className="artifact-row" key={item} onClick={() => onPrompt(`Continue a entrega: ${item}`)}><span className={`artifact-icon a${index}`}><FileCode2 size={15} /></span><div><strong>{item}</strong><small>{index === 0 ? "Atualizado há 4 min" : "Rascunho"}</small></div><ChevronRight size={14} /></button>)}
          </article>
          <article className="glass-panel team-strip"><div><Users size={16} /><span><strong>3 agentes colaborando</strong><small>Produto · Código · Pesquisa</small></span></div><div className="avatar-stack"><i>P</i><i>C</i><i>R</i></div></article>
        </div>
      </div>
    </section>
  );
}

type OrchestratorVariant = "design" | "data" | "code";

const orchestratorDefaults: Record<OrchestratorVariant, Array<[string, string]>> = {
  design: [["Capture", "Playwright"], ["Tokens", "Vision"], ["Compose", "Design agent"], ["QA", "Pixel diff"]],
  data: [["Intake", "SQL parser"], ["Profile", "Data agent"], ["Model", "Schema planner"], ["Validate", "Migration gate"]],
  code: [["Tickets", "Linear"], ["Implement", "Code agents"], ["Review", "CI + reviewer"], ["Merge", "Human gate"]]
};

function OrchestratorPanel({ variant, onPrompt, onValidateGraph }: { variant: OrchestratorVariant; onPrompt: (prompt: string) => void; onValidateGraph?: ModeViewProps["onValidateGraph"] }) {
  const [stages, setStages] = useState(orchestratorDefaults[variant]);
  const [validation, setValidation] = useState("Pronto para validar");
  const [validating, setValidating] = useState(false);

  async function validate() {
    if (!onValidateGraph) {
      setValidation("Conecte o gateway para validar");
      return;
    }
    const graph: OrchestrationGraph = {
      schemaVersion: 1,
      name: `${variant}-pipeline`,
      maxConcurrency: 4,
      nodes: stages.map(([name, engine], index) => ({
        id: `${variant}-${index + 1}`,
        name,
        kind: index === 0 ? "input" : engine.toLowerCase().includes("human") ? "human" : index === stages.length - 1 ? "gate" : "agent",
        mode: variant,
        dependsOn: index ? [`${variant}-${index}`] : [],
        config: { model: engine, retries: 2, timeoutMs: 1_200_000 }
      }))
    };
    setValidating(true);
    setValidation("Calculando dependências…");
    try {
      const plan = await onValidateGraph(graph);
      setValidation(`${plan.waves.length} ondas · paralelo ${plan.maxParallelism} · crítico ${plan.criticalPath.length}`);
      onPrompt(`Execute o DAG validado ${graph.name} em ${plan.waves.length} ondas, com os gates e fallbacks configurados`);
    } catch (cause) {
      setValidation(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setValidating(false);
    }
  }

  return (
    <aside className={`orchestrator-panel ${variant}`}>
      <header><div><Network size={15} /><span><strong>Orchestrator</strong><small>{stages.length} estágios · DAG editável</small></span></div><button><MoreHorizontal size={15} /></button></header>
      <div className="orchestrator-flow">
        {stages.map(([name, engine], index) => (
          <div className="orchestrator-stage" key={`${name}-${index}`}>
            <span className={`stage-index s${index % 4}`}>{String(index + 1).padStart(2, "0")}</span>
            <div><strong>{name}</strong><small>{engine}</small></div>
            {index < stages.length - 1 && <i className="stage-connector" />}
          </div>
        ))}
      </div>
      <button className="add-stage" onClick={() => setStages((items) => [...items, [`Gate ${items.length + 1}`, "Human approval"]])}><Plus size={13} />Adicionar estágio</button>
      <div className="orchestrator-constraints"><span><Zap size={12} />Concorrência <strong>4</strong></span><span><ShieldCheck size={12} />Retries <strong>2</strong></span></div>
      <small className="orchestrator-validation"><ShieldCheck size={11}/>{validation}</small>
      <button className="run-orchestrator" onClick={() => void validate()} disabled={validating}><Play size={13} />{validating ? "Validando…" : "Validar e preparar"}</button>
    </aside>
  );
}

function DesignView({ onPrompt, onReplicate, onValidateGraph, sending, processingLabel }: Pick<ModeViewProps, "onPrompt" | "onReplicate" | "onValidateGraph" | "sending" | "processingLabel">) {
  const [sourceUrl, setSourceUrl] = useState("https://linear.app");
  const [captureState, setCaptureState] = useState<"idle" | "extracting" | "ready" | "error">("idle");
  const [captureResult, setCaptureResult] = useState<DesignReplicationResult>();
  const [captureError, setCaptureError] = useState("");
  const [rightMode, setRightMode] = useState<"inspect" | "orchestrate">("orchestrate");

  async function replicate() {
    if (!sourceUrl.trim() || captureState === "extracting") return;
    setCaptureState("extracting");
    setCaptureError("");
    try {
      if (onReplicate) setCaptureResult(await onReplicate(sourceUrl.trim()));
      else await new Promise((resolve) => window.setTimeout(resolve, 1450));
      setCaptureState("ready");
    } catch (cause) {
      setCaptureError(cause instanceof Error ? cause.message : String(cause));
      setCaptureState("error");
    }
  }

  return (
    <section className="mode-surface immersive-surface design-surface">
      {sending && <ProcessPulse label={processingLabel} detail="Gerando direções, componentes e código de produção" />}
      <header className="immersive-toolbar design-toolbar">
        <div className="document-identity"><span><WandSparkles size={14} /></span><strong>site-replica.pen</strong><small>Saved now</small></div>
        <div className="replicate-input"><Globe2 size={14} /><input aria-label="URL para replicar" value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void replicate(); }} /><button className={captureState} onClick={() => void replicate()}><ScanLine size={13} />{captureState === "extracting" ? "Mapeando…" : captureState === "ready" ? "Capturado" : captureState === "error" ? "Retry" : "Replicar"}</button></div>
        <div className="device-switcher"><button className="active"><Monitor size={13} />Desktop</button><button>Tablet</button><button>Mobile</button></div>
        <button className="toolbar-primary" onClick={() => onPrompt("Gere três direções visuais mantendo o design system capturado")}><Sparkles size={13} />Gerar</button>
      </header>
      <div className="design-studio">
        <aside className="studio-left surface-panel">
          <div className="panel-title"><span><Layers3 size={14} /> Páginas</span><button><Plus size={13} /></button></div>
          <button className="page-row active"><Grid3X3 size={13} /><span>Homepage<small>1440 × 1024</small></span></button>
          <button className="page-row"><Grid3X3 size={13} /><span>Pricing<small>1440 × 1180</small></span></button>
          <div className="layers-title"><span>LAYERS</span><small>8</small></div>
          {[['Hero / Main',Box],['Navigation',Component],['Headline',Component],['CTA group',Component],['Visual field',Palette]].map(([label, Icon], index) => { const LayerIcon = Icon as typeof Box; return <button className={`layer ${index === 0 ? "active" : index > 0 && index < 4 ? "nested" : ""}`} key={label as string}><LayerIcon size={13} />{label as string}<Eye size={12} /></button>; })}
          <div className="asset-library"><span>COMPONENTS</span><div><i /><i /><i /><i /></div><button><Plus size={12} />Library</button></div>
        </aside>
        <main className="infinite-canvas design-canvas">
          <div className="canvas-dots" />
          <div className="canvas-toolbar"><button className="active"><MousePointer2 size={13} /></button><button><Box size={13} /></button><button><Palette size={13} /></button><i /><span>68%</span><button><Maximize size={13} /></button></div>
          <div className={`artboard ${captureState}`}>
            <div className="selection-outline"><span>Hero / Main</span><i className="handle nw" /><i className="handle ne" /><i className="handle sw" /><i className="handle se" /></div>
            <nav><span className="mini-logo"><Sparkles size={13} /></span><div>Product&nbsp;&nbsp;&nbsp;Solutions&nbsp;&nbsp;&nbsp;Company</div><button>Start building</button></nav>
            <div className="artboard-hero"><span>ORCHESTRATE WHAT'S NEXT</span><h2>Dream on canvas.<br />Land in code.</h2><p>Replicate visual language, refine it with agents and ship production-ready components.</p><button><WandSparkles size={12} /> Explore the canvas</button></div>
            <div className="artboard-cards"><i /><i /><i /></div>
            {captureState === "extracting" && <div className="capture-scan"><span /></div>}
          </div>
          <div className="canvas-agent-cursors"><span className="cursor-a"><MousePointer2 size={11} />Layout agent</span><span className="cursor-b"><MousePointer2 size={11} />Visual agent</span></div>
        </main>
        <aside className="studio-right surface-panel">
          <div className="right-tabs"><button className={rightMode === "inspect" ? "active" : ""} onClick={() => setRightMode("inspect")}><Settings2 size={12} />Inspect</button><button className={rightMode === "orchestrate" ? "active" : ""} onClick={() => setRightMode("orchestrate")}><Network size={12} />DAG</button></div>
          {rightMode === "orchestrate" ? <OrchestratorPanel variant="design" onPrompt={onPrompt} onValidateGraph={onValidateGraph} /> : <div className="design-inspector"><div className="panel-title"><span>Design intelligence</span><small>{captureState === "ready" ? "READY" : "LIVE"}</small></div>{[['Tokens',captureResult ? `${captureResult.tokens.colors.length} cores` : '42 cores · 8 escalas'],['Typography',captureResult ? `${captureResult.tokens.fonts.length} famílias` : '3 famílias · 12 estilos'],['Layout','Grid · flex · responsive'],['Components',captureResult ? `${captureResult.analysis.componentFingerprints} fingerprints` : '18 fingerprints'],['Motion',captureResult ? `${captureResult.analysis.animations.length} keyframes` : '7 keyframes']].map(([label,detail]) => <div className="inspect-row" key={label}><Check size={11}/><span><strong>{label}</strong><small>{detail}</small></span></div>)}<p className="capture-error">{captureError}</p></div>}
        </aside>
      </div>
      <footer className="immersive-status"><span><GitBranch size={12} />design/site-replica.pen</span><span><Users size={12} />3 agents</span><span><Code2 size={12} />React + CSS synchronized</span></footer>
    </section>
  );
}

interface SchemaTable { id: string; name: string; x: number; y: number; tone: string; fields: Array<[string, string, string?]>; }

const initialTables: SchemaTable[] = [
  { id: "users", name: "users", x: 46, y: 48, tone: "cyan", fields: [["id","uuid","PK"],["email","varchar","UQ"],["name","varchar"],["created_at","timestamptz"]] },
  { id: "workspaces", name: "workspaces", x: 355, y: 36, tone: "violet", fields: [["id","uuid","PK"],["name","varchar"],["owner_id","uuid","FK"],["created_at","timestamptz"]] },
  { id: "members", name: "workspace_members", x: 330, y: 280, tone: "amber", fields: [["workspace_id","uuid","FK"],["user_id","uuid","FK"],["role","workspace_role"]] },
  { id: "runs", name: "orchestration_runs", x: 655, y: 175, tone: "mint", fields: [["id","uuid","PK"],["workspace_id","uuid","FK"],["status","run_status"],["graph","jsonb"]] }
];

function DataView({ onPrompt, onValidateGraph, sending, processingLabel }: Pick<ModeViewProps, "onPrompt" | "onValidateGraph" | "sending" | "processingLabel">) {
  const [tables, setTables] = useState(initialTables);
  const [activeTable, setActiveTable] = useState("workspaces");
  const [panel, setPanel] = useState<"structure" | "sql">("structure");
  function addTable() {
    const index = tables.length + 1;
    const id = `table_${index}`;
    setTables((items) => [...items, { id, name: id, x: 115 + (index * 97) % 520, y: 95 + (index * 83) % 300, tone: index % 2 ? "pink" : "blue", fields: [["id","uuid","PK"],["created_at","timestamptz"]] }]);
    setActiveTable(id);
  }
  return (
    <section className="mode-surface immersive-surface data-surface drawdb-shell">
      {sending && <ProcessPulse label={processingLabel} detail="Calculando relações, cardinalidade e plano de migração" />}
      <header className="immersive-toolbar data-toolbar">
        <div className="document-identity"><span><Database size={14} /></span><strong>Product Core</strong><small>PostgreSQL · saved</small></div>
        <nav><button>File</button><button>Edit</button><button>View</button><button>Schema</button><button>Help</button></nav>
        <span className="sync-state"><Circle size={7} />No changes</span>
        <button className="toolbar-button"><Upload size={13} />Import SQL</button><button className="toolbar-primary"><Download size={13} />Export</button>
      </header>
      <div className="data-editor">
        <aside className="schema-sidebar surface-panel">
          <div className="schema-tabs"><button className="active">Tables <span>{tables.length}</span></button><button>Relations <span>4</span></button></div>
          <label className="schema-search"><Search size={13} /><input placeholder="Search schema…" /></label>
          <button className="add-table-button" onClick={addTable}><Plus size={13} />Add table</button>
          <div className="schema-list">{tables.map((table) => <button className={activeTable === table.id ? "active" : ""} key={table.id} onClick={() => setActiveTable(table.id)}><Table2 size={13} /><span>{table.name}<small>{table.fields.length} fields</small></span><ChevronRight size={12} /></button>)}</div>
          <div className="schema-bottom-tabs"><button className={panel === "structure" ? "active" : ""} onClick={() => setPanel("structure")}><ListTree size={12}/>Structure</button><button className={panel === "sql" ? "active" : ""} onClick={() => setPanel("sql")}><Code2 size={12}/>SQL</button></div>
        </aside>
        <main className="infinite-canvas erd-canvas">
          <div className="canvas-dots" />
          <svg className="erd-relations" viewBox="0 0 950 560" preserveAspectRatio="none"><path d="M255 135 C310 135 310 120 355 120"/><path d="M455 205 C455 245 455 250 455 280"/><path d="M545 135 C650 135 600 225 655 225"/><path d="M255 175 C300 175 280 355 330 355"/></svg>
          {tables.map((table) => <article className={`database-table ${table.tone} ${activeTable === table.id ? "selected" : ""}`} key={table.id} style={{ left: table.x, top: table.y }} onClick={() => setActiveTable(table.id)}><header><Table2 size={12}/><strong>{table.name}</strong><MoreHorizontal size={12}/></header>{table.fields.map(([name,type,key]) => <div className="db-field" key={name}><span>{key === "PK" ? <KeyRound size={10}/> : key === "FK" ? <Link2 size={10}/> : <i/>}{name}</span><small>{type}</small></div>)}</article>)}
          <div className="erd-controls surface-panel"><button><Rows3 size={14}/></button><i/><button><Search size={14}/></button><span>84%</span><button><Undo2 size={14}/></button><button><Redo2 size={14}/></button><i/><button onClick={addTable}><Table2 size={14}/><Plus size={9}/></button><button><Link2 size={14}/></button><button><RefreshCw size={14}/></button></div>
          <button className="ask-data" onClick={() => onPrompt("Analise o schema, encontre riscos e proponha a próxima migração")}><Sparkles size={14}/>Ask data agent</button>
        </main>
        <OrchestratorPanel variant="data" onPrompt={onPrompt} onValidateGraph={onValidateGraph} />
      </div>
      <footer className="immersive-status"><span><Table2 size={12}/>{tables.length} tables</span><span><Link2 size={12}/>4 relationships</span><span><ShieldCheck size={12}/>0 problems</span></footer>
    </section>
  );
}

function buildReleaseGraph(lanes: string[]): OrchestrationGraph {
  const agentNodes = lanes.map((ticket, index) => ({
    id: `agent-${index + 1}`,
    name: `${ticket} · Code agent`,
    kind: "agent" as const,
    mode: "code" as const,
    dependsOn: ["planner"],
    config: { model: "GPT-Sol", tools: ["terminal", "git", "tests"], retries: 2 }
  }));
  const pullRequests = lanes.map((ticket, index) => ({
    id: `pr-${index + 1}`,
    name: `${ticket} · Pull request`,
    kind: "tool" as const,
    mode: "code" as const,
    dependsOn: [`agent-${index + 1}`],
    config: { tools: ["git", "github"] }
  }));
  return {
    schemaVersion: 1,
    name: "release-train",
    maxConcurrency: 4,
    nodes: [
      { id: "idea", name: "Idea", kind: "input", mode: "agent", dependsOn: [] },
      { id: "scope", name: "PM + Design", kind: "agent", mode: "work", dependsOn: ["idea"] },
      { id: "planner", name: "DAG planner", kind: "agent", mode: "agent", dependsOn: ["scope"], config: { retries: 2 } },
      ...agentNodes,
      ...pullRequests,
      { id: "ci", name: "Tests + CI + reviews", kind: "gate", mode: "code", dependsOn: pullRequests.map((node) => node.id) },
      { id: "human-merge", name: "Human merge", kind: "human", mode: "code", dependsOn: ["ci"] },
      { id: "rebase", name: "Update main + rebase", kind: "tool", mode: "code", dependsOn: ["human-merge"] },
      { id: "wave-2", name: "Next wave", kind: "agent", mode: "code", dependsOn: ["rebase"], config: { retries: 2 } }
    ]
  };
}

function AgentView({ onPrompt, onValidateGraph, sending, processingLabel }: Pick<ModeViewProps, "onPrompt" | "onValidateGraph" | "sending" | "processingLabel">) {
  const [lanes, setLanes] = useState(["Ticket A", "Ticket B", "Ticket C"]);
  const [selected, setSelected] = useState("Code agent A");
  const [planState, setPlanState] = useState("DAG editável");
  const [runTick, setRunTick] = useState(-1);
  const agentRoster = [
    ["Planner", "context + routing"],
    ["Code agent A", "Ticket A"],
    ["Code agent B", "Ticket B"],
    ["Code agent C", "Ticket C"],
    ["Reviewer", "tests + CI"],
    ["Security", "policy gate"]
  ];

  useEffect(() => {
    if (!sending) {
      if (runTick >= agentRoster.length + 2) setRunTick(-1);
      return;
    }
    setRunTick(0);
    const timer = window.setInterval(() => setRunTick((value) => value + 1), 1250);
    return () => window.clearInterval(timer);
  }, [sending]);

  function agentStatus(index: number) {
    if (runTick < 0) return index === 0 ? "ready" : "queued";
    if (index < runTick - 1) return "done";
    if (index <= runTick) return "running";
    return "queued";
  }

  async function validateReleaseGraph() {
    if (!onValidateGraph) {
      setPlanState("Conecte o gateway");
      return;
    }
    setPlanState("Calculando…");
    try {
      const plan = await onValidateGraph(buildReleaseGraph(lanes));
      setPlanState(`${plan.waves.length} waves · critical ${plan.criticalPath.length}`);
    } catch (cause) {
      setPlanState(cause instanceof Error ? cause.message : String(cause));
    }
  }
  return (
    <section className="mode-surface immersive-surface agent-surface">
      {sending && <ProcessPulse label={processingLabel} detail="Executando ondas, tools, gates e fallbacks" />}
      <header className="immersive-toolbar agent-toolbar"><div className="document-identity"><span><Network size={14}/></span><strong>Release train</strong><small>{planState}</small></div><div className="run-metrics"><span><Circle size={7}/>Event-driven</span><span>Concurrency 4</span><span>Heartbeat 30s</span><span>Memory layered</span></div><button className="toolbar-button" onClick={() => void validateReleaseGraph()}><ShieldCheck size={13}/>Validate</button><button className="toolbar-primary" onClick={() => onPrompt("Execute o DAG Release train em ondas; despache cada subagente, publique postbacks e respeite gates humanos")}><Play size={13}/>Run graph</button></header>
      <div className="agent-builder">
        <aside className="node-palette agent-left surface-panel">
          <div className="panel-title"><span><Bot size={14}/>Active agents</span><small>{sending ? "live" : "idle"}</small></div>
          <div className="agent-roster">{agentRoster.map(([name, task], index) => { const status = agentStatus(index); return <button className={`agent-roster-item ${status}`} key={name} onClick={() => setSelected(name)}><span className="agent-avatar"><Bot size={12}/><i/></span><div><strong>{name}</strong><small>{task}</small></div><em>{status}</em></button>; })}</div>
          <div className="agent-capabilities"><span>ROUTING + TOOLS</span>{[["Agent",Bot],["Tool",Zap],["Gate",ShieldCheck],["Human",UserCheck]].map(([label,Icon]) => {const NodeIcon=Icon as typeof Bot; return <button key={label as string}><NodeIcon size={12}/>{label as string}</button>})}</div>
          <div className="node-palette-footer"><button onClick={() => setLanes((items) => [...items, `Ticket ${String.fromCharCode(65 + items.length)}`])}><Plus size={12}/>Add lane</button></div>
        </aside>
        <main className="infinite-canvas dag-canvas">
          <div className="canvas-dots" />
          <div className="dag-start-row"><DagNode tone="neutral" title="Idea" meta="Input"/><ArrowRight/><DagNode tone="violet" title="PM + Design" meta="Scope"/><ArrowRight/><DagNode tone="mint" title="Linear project" meta="Context + blockedBy"/><ArrowRight/><DagNode tone="blue" title="Planner" meta="Build DAG"/></div>
          <section className="dag-wave wave-one"><header>ORCA — WAVE 1 <span>{lanes.length} parallel lanes</span></header>{lanes.map((ticket,index)=><div className="dag-lane" key={ticket}><DagNode tone="orange" title={ticket} meta="Linear issue"/><ArrowRight/><button onClick={()=>setSelected(`Code agent ${String.fromCharCode(65+index)}`)}><DagNode tone="amber" title="Code agent" meta="GPT-Sol"/></button><ArrowRight/><DagNode tone="green" title="PR" meta={`#${142+index}`}/>{index===1 && <><ArrowRight/><DagNode tone="pink" title="Tests + CI" meta="reviews"/><ArrowRight/><DagNode tone="neutral" title="Human merge" meta="required"/></>}</div>)}</section>
          <div className="dag-rebase"><DagNode tone="blue" title="Update main" meta="Rebase + next wave"/></div>
          <section className="dag-wave wave-two"><header>ORCA — WAVE 2 <span>waits for main</span></header><div className="dag-lane"><DagNode tone="orange" title="Ticket D" meta="unblocked"/><ArrowRight/><DagNode tone="amber" title="Code agent" meta="GPT-Sol"/><ArrowRight/><DagNode tone="green" title="PR" meta="#146"/><ArrowRight/><DagNode tone="pink" title="Tests + CI" meta="gate"/><ArrowRight/><DagNode tone="neutral" title="Human merge" meta="required"/></div></section>
          <div className="dag-zoom surface-panel"><button><Search size={13}/></button><span>76%</span><button><Maximize size={13}/></button></div>
        </main>
        <aside className="agent-inspector surface-panel"><div className="panel-title"><span><Settings2 size={14}/>Configuration</span><button><MoreHorizontal size={13}/></button></div><div className="selected-node"><span><Bot size={15}/></span><div><strong>{selected}</strong><small>agent/code · postback enabled</small></div></div><label>Name<input value={selected} onChange={(event)=>setSelected(event.target.value)}/></label><label>Model<button>Workspace route <ChevronDown size={12}/></button></label><label>Tools<div className="tool-tags"><span>terminal</span><span>git</span><span>tests</span><button><Plus size={10}/></button></div></label><label>Dispatch<button>Event queue <ChevronDown size={12}/></button></label><div className="config-grid"><label>Timeout<input value="20m" readOnly/></label><label>Retries<input value="2" readOnly/></label></div><div className="policy-card"><LockKeyhole size={13}/><span><strong>OpenClaw-inspired loop</strong><small>hot skills · heartbeat · memory · post-message-back</small></span></div><button className="delete-node">Remove node</button></aside>
      </div>
      <footer className="immersive-status"><span><Network size={12}/>DAG valid</span><span><Bot size={12}/>{lanes.length + 3} agents</span><span><Clock3 size={12}/>ETA 18m</span></footer>
    </section>
  );
}

function DagNode({ tone, title, meta }: { tone: string; title: string; meta: string }) {
  return <div className={`dag-node ${tone}`}><strong>{title}</strong><small>{meta}</small></div>;
}

function CodeView({ onPrompt, onValidateGraph, onTerminalRun, sending, processingLabel }: Pick<ModeViewProps, "onPrompt" | "onValidateGraph" | "onTerminalRun" | "sending" | "processingLabel">) {
  const [activeFile, setActiveFile] = useState("ModeViews.tsx");
  const [command, setCommand] = useState("pnpm check");
  const [terminalOutput, setTerminalOutput] = useState("Ultra runtime ready · commands run in the active workspace\n$ ");
  const [terminalBusy, setTerminalBusy] = useState(false);
  const lines = useMemo(() => [
    ["context","118"," function DesignView({ onPrompt, onReplicate }) {"],
    ["remove","119","-  return <section className=\"mode-surface\">"],
    ["add","119","+  return <section className=\"immersive-surface\">"],
    ["add","120","+    <InfiniteCanvas engine={designEngine} />"],
    ["add","121","+    <OrchestratorPanel graph={designGraph} />"],
    ["context","122","   // input remains a floating command dock"],
    ["remove","123","-  <div className=\"nested-window glass-panel\">"],
    ["add","123","+  <WorkspaceSurface occupy=\"available\" />"],
    ["context","124"," }"],
  ], []);
  async function runCommand() {
    if (!command.trim() || terminalBusy) return;
    setTerminalBusy(true);
    setTerminalOutput((value) => `${value}${command}\n`);
    try {
      const result = await onTerminalRun(command);
      const missing = result.runtimeRequired ? `Runtime '${result.runtimeRequired}' ainda indisponível · o provisionamento automático usa somente o manifesto assinado.\n` : "";
      const output = `${result.stdout}${result.stderr}${missing}[exit ${result.exitCode ?? "n/a"} · ${result.durationMs} ms]\n$ `;
      setTerminalOutput((value) => value + output);
    } catch (cause) {
      setTerminalOutput((value) => `${value}${cause instanceof Error ? cause.message : String(cause)}\n$ `);
    } finally {
      setTerminalBusy(false);
    }
  }
  return (
    <section className="mode-surface immersive-surface code-surface">
      {sending && <ProcessPulse label={processingLabel} detail="Gerando patch, executando testes e preparando revisão" />}
      <header className="immersive-toolbar code-toolbar"><div className="document-identity"><span><Braces size={14}/></span><strong>multiplike-ai</strong><small>Agent IDE · feature/full-surface-modes</small></div><div className="code-breadcrumb"><GitBranch size={12}/>4 changed files <span>+312 −84</span></div><div className="runtime-strip"><span>Node</span><span>Python</span><span>Go</span><span>Rust</span><span>+6 on demand</span></div><button className="toolbar-button"><Eye size={13}/>Preview</button><button className="toolbar-primary" onClick={() => void runCommand()}><Play size={13}/>{terminalBusy ? "Running…" : "Run checks"}</button></header>
      <div className="code-studio">
        <aside className="code-explorer surface-panel"><div className="activity-strip"><button className="active"><FileCode2 size={15}/></button><button><Search size={15}/></button><button><GitBranch size={15}/></button><button><Blocks size={15}/></button></div><div className="cursor-agents"><div className="panel-title"><span>AGENT TASKS</span><small>3</small></div>{[["Implement terminal bridge","running"],["Review ModeViews diff","ready"],["Security pass","queued"]].map(([task,status])=><button className={status} key={task}><Bot size={12}/><span><strong>{task}</strong><small>{status}</small></span><i/></button>)}</div><div className="explorer-tree"><div className="panel-title"><span>EXPLORER</span><button><MoreHorizontal size={13}/></button></div><button className="folder"><ChevronDown size={11}/>AI-ORCHESTRATOR</button><button className="folder nested"><ChevronDown size={11}/>apps / desktop / src</button>{["App.tsx","ModeViews.tsx","styles.css","gateway.ts"].map((file,index)=><button className={`tree-file ${activeFile===file?"active":""}`} key={file} onClick={()=>setActiveFile(file)}><FileCode2 size={12}/><span>{file}</span><small>{index===1?"M":""}</small></button>)}<button className="folder"><ChevronRight size={11}/>services / gateway</button><button className="folder"><ChevronRight size={11}/>packages / contracts</button></div><div className="changes-list"><div className="panel-title"><span>CHANGES</span><small>4</small></div>{["App.tsx","ModeViews.tsx","styles.css","tauri.conf.json"].map(file=><button key={file}><span>M</span>{file}</button>)}</div></aside>
        <main className="code-editor">
          <div className="editor-tabs"><button className="active"><FileCode2 size={12}/>{activeFile}<i/></button><button><FileCode2 size={12}/>styles.css</button><span/><button><MoreHorizontal size={13}/></button></div>
          <div className="diff-toolbar"><span><Braces size={12}/>apps/desktop/src/components/{activeFile}</span><div><strong className="diff-add">+7</strong><strong className="diff-remove">−2</strong><button>Side by side <ChevronDown size={11}/></button></div></div>
          <div className="full-diff-code">{lines.map(([type,number,content],index)=><div className={`diff-line ${type}`} key={`${number}-${index}`}><span>{number}</span><span>{number}</span><code>{content}</code></div>)}</div>
          <div className="terminal-pane ultra-terminal"><header><div><button className="active">TERMINAL</button><button>RUNTIMES <span>10</span></button><button>PROBLEMS <span>0</span></button><button>OUTPUT</button></div><div><span className="terminal-security"><ShieldCheck size={11}/>isolated workspace</span><button><Plus size={12}/></button><button><MoreHorizontal size={12}/></button></div></header><pre>{terminalOutput}<span className="terminal-caret"/></pre><form onSubmit={(event)=>{event.preventDefault();void runCommand();}}><span>$</span><input aria-label="Comando do terminal" value={command} onChange={(event)=>setCommand(event.target.value)} placeholder="Execute Node, Python, Go, Rust, Java, .NET…"/><button disabled={terminalBusy}><Play size={11}/></button></form></div>
        </main>
        <OrchestratorPanel variant="code" onPrompt={onPrompt} onValidateGraph={onValidateGraph} />
      </div>
      <footer className="immersive-status"><span><GitBranch size={12}/>feature/full-surface-modes</span><span><ShieldCheck size={12}/>Checks passing</span><span><TerminalSquare size={12}/>PowerShell</span></footer>
    </section>
  );
}

function SecurityView({ messages, sending, processingLabel, onPrompt, onOpenExternal }: Pick<ModeViewProps, "messages" | "sending" | "processingLabel" | "onPrompt" | "onOpenExternal">) {
  const findings = [
    ["critical", "Token exposed in process environment", "src/runtime/bridge.rs:84"],
    ["high", "Unpinned workflow dependency", ".github/workflows/release.yml:31"],
    ["medium", "Missing request size limit", "services/gateway/src/main.rs:42"]
  ];
  return (
    <section className="mode-surface immersive-surface security-surface">
      {sending && <ProcessPulse label={processingLabel} detail="Revisando código, dependências, segredos e fronteiras de confiança" />}
      <header className="immersive-toolbar security-toolbar"><div className="document-identity"><span><ShieldCheck size={14}/></span><strong>Security review</strong><small>workspace / full surface</small></div><div className="security-summary"><span>1 critical</span><span>1 high</span><span>1 medium</span></div><button className="toolbar-button" onClick={() => onPrompt("Crie um threat model STRIDE deste workspace e priorize as correções")}><ScanLine size={13}/>Threat model</button><button className="toolbar-primary" onClick={() => onPrompt("Revise todas as mudanças, dependências e possíveis segredos; gere correções verificáveis")}><Play size={13}/>Start review</button></header>
      <div className="security-studio">
        <aside className="security-scope surface-panel"><div className="panel-title"><span><ShieldCheck size={13}/>REVIEW SCOPE</span></div>{["Changed files","Dependencies","Secrets","Auth & RBAC","Supply chain"].map((item,index)=><button className={index===0?"active":""} key={item}><span>{index ? "○" : "●"}</span>{item}<small>{["24","7","0","3","12"][index]}</small></button>)}<div className="security-policy"><LockKeyhole size={14}/><div><strong>Safe review</strong><small>Read-only tools · no secret values in logs</small></div></div></aside>
        <main className="security-chat">
          <div className="security-chat-head"><div><strong>Repository review</strong><small>Ask follow-ups in the shared command dock</small></div><span><Sparkles size={12}/>preferred: Kimi</span></div>
          <div className="security-conversation">
            {!messages.length && <article className="security-intro"><span><ShieldCheck size={22}/></span><div><h2>Review before it ships.</h2><p>Security combines code context, threat modeling, dependency analysis and executable remediation.</p></div></article>}
            {messages.slice(-5).map((message,index)=><article className={`security-message ${message.role}`} key={`${message.role}-${index}`}><span>{message.role === "user" ? "You" : <ShieldCheck size={12}/>}</span><p>{message.content || "Analyzing…"}</p></article>)}
            <div className="finding-list">{findings.map(([severity,title,file])=><button key={title} onClick={() => onPrompt(`Explique e corrija: ${title} em ${file}`)}><i className={severity}/><div><strong>{title}</strong><small>{file}</small></div><span>{severity}</span><ChevronRight size={13}/></button>)}</div>
          </div>
        </main>
        <aside className="security-route surface-panel"><div className="panel-title"><span><SlidersHorizontal size={13}/>REVIEW ROUTE</span></div><div className="kimi-route"><span><Braces size={17}/></span><div><strong>Kimi K3 in C</strong><small>Preferred when locally available</small></div><em>optional</em></div><div className="route-flow"><span>1</span><div><strong>Local Kimi</strong><small>WSL2 · user managed</small></div><i/><span>2</span><div><strong>Workspace gateway</strong><small>Moonshot / configured fallback</small></div><i/><span>3</span><div><strong>Policy reviewer</strong><small>deterministic gate</small></div></div><button className="route-source" onClick={() => void onOpenExternal("https://github.com/FareedKhan-dev/kimi-k3-in-c")}><PackageCheck size={13}/>Kimi requirements</button><p>Prompts and source are not persisted by default.</p></aside>
      </div>
      <footer className="immersive-status"><span><ShieldCheck size={12}/>Policy active</span><span><Bug size={12}/>3 findings</span><span><LockKeyhole size={12}/>Secrets redacted</span></footer>
    </section>
  );
}

function GameStudioView({ onPrompt, onTerminalRun, sending, processingLabel }: Pick<ModeViewProps, "onPrompt" | "onTerminalRun" | "sending" | "processingLabel">) {
  const [engine, setEngine] = useState("Unreal Engine");
  const [probe, setProbe] = useState("Adapters ready");
  async function probeEngine() {
    setProbe("Detecting…");
    const command = engine === "Blender" ? "where blender.exe" : engine === "Unity" ? "where Unity.exe" : "where UnrealEditor.exe";
    try {
      const result = await onTerminalRun(command);
      setProbe(result.exitCode === 0 ? "Installed tool detected" : "Bridge ready · editor not detected");
    } catch {
      setProbe("Bridge ready · editor not detected");
    }
  }
  return (
    <section className="mode-surface immersive-surface game-surface">
      {sending && <ProcessPulse label={processingLabel} detail="Gerando assets, scripts, cenas e testes de gameplay" />}
      <header className="immersive-toolbar game-toolbar"><div className="document-identity"><span><Gamepad2 size={14}/></span><strong>Game Studio</strong><small>worlds/aurora-station</small></div><div className="engine-switch">{["Blender","Unreal Engine","Unity"].map((item)=><button className={engine===item?"active":""} onClick={()=>setEngine(item)} key={item}>{item}</button>)}</div><span className="probe-state"><Circle size={7}/>{probe}</span><button className="toolbar-button" onClick={() => void probeEngine()}><RefreshCw size={13}/>Detect</button><button className="toolbar-primary" onClick={() => onPrompt(`Build e execute a cena atual em ${engine}; valide scripts, assets e performance`)}><Play size={13}/>Play scene</button></header>
      <div className="game-studio">
        <aside className="scene-tree surface-panel"><div className="panel-title"><span><ListTree size={13}/>HIERARCHY</span><button><Plus size={12}/></button></div>{[["World","Box"],["Lighting","Sparkles"],["PlayerController","Code"],["CameraRig","Eye"],["Environment","Layers"],["UI_Canvas","Monitor"]].map(([name,type],index)=><button className={index===3?"active":""} key={name}><ChevronRight size={10}/><Box size={12}/><span>{name}</span><small>{type}</small></button>)}<div className="asset-bin"><div className="panel-title"><span>ASSETS</span><small>128</small></div><div>{["Hangar","Drone","Materials","Audio"].map((asset,index)=><button key={asset}><span className={`asset-preview a${index}`}><Box size={14}/></span><small>{asset}</small></button>)}</div></div></aside>
        <main className="game-viewport">
          <div className="viewport-toolbar"><button className="active">Perspective</button><button>Lit</button><button>60 FPS</button><span/><button><Grid3X3 size={12}/></button><button><Maximize size={12}/></button></div>
          <div className="world-sky"/><div className="world-grid"/><div className="scene-object tower"><i/><i/><i/></div><div className="scene-object portal"><i/></div><div className="scene-object player"><i/></div>
          <div className="viewport-axis"><i>X</i><i>Y</i><i>Z</i></div>
          <div className="game-ai-command"><Sparkles size={13}/><span>AI scene copilot</span><button onClick={() => onPrompt(`Em ${engine}, gere uma estação sci-fi modular com iluminação volumétrica e LODs`)}>Generate environment</button><button onClick={() => onPrompt("Crie a lógica de movimento do player e testes automatizados de gameplay")}>Create gameplay</button></div>
          <div className="game-timeline"><header><strong>Sequencer · Intro_Cinematic</strong><span>00:00:08:14</span><button><Play size={11}/></button></header>{["CameraRig","HangarDoor","Key Light"].map((track,index)=><div key={track}><span>{track}</span><i style={{"--track":index} as CSSProperties}/><b/><b/></div>)}</div>
        </main>
        <aside className="game-inspector surface-panel"><div className="panel-title"><span><SlidersHorizontal size={13}/>INSPECTOR</span><button><MoreHorizontal size={12}/></button></div><div className="selected-game-object"><span><Box size={18}/></span><div><strong>CameraRig</strong><small>Actor · synchronized</small></div></div>{["Transform","Camera","Post Processing","AI Behavior"].map((section,index)=><section key={section}><header>{section}<ChevronDown size={11}/></header>{index===0?<div className="vector-fields"><label>X<input value="12.40" readOnly/></label><label>Y<input value="4.00" readOnly/></label><label>Z<input value="8.25" readOnly/></label></div>:<p>{["35mm · f/2.8 · tracked","Bloom 0.4 · ACES","Director agent · live"][index-1]}</p>}</section>)}<button className="export-game" onClick={() => onPrompt(`Exporte o projeto preservando compatibilidade com Blender, Unreal Engine e Unity a partir do alvo ${engine}`)}><Upload size={13}/>Export project manifest</button></aside>
      </div>
      <footer className="immersive-status"><span><Gamepad2 size={12}/>{engine}</span><span><Box size={12}/>128 assets</span><span><TerminalSquare size={12}/>CLI bridge enabled</span><span><ShieldCheck size={12}/>Source controlled</span></footer>
    </section>
  );
}

export function ModeView(props: ModeViewProps) {
  switch (props.mode) {
    case "work": return <WorkView onPrompt={props.onPrompt} sending={props.sending} processingLabel={props.processingLabel} />;
    case "design": return <DesignView onPrompt={props.onPrompt} onReplicate={props.onReplicate} onValidateGraph={props.onValidateGraph} sending={props.sending} processingLabel={props.processingLabel} />;
    case "data": return <DataView onPrompt={props.onPrompt} onValidateGraph={props.onValidateGraph} sending={props.sending} processingLabel={props.processingLabel} />;
    case "agent": return <AgentView onPrompt={props.onPrompt} onValidateGraph={props.onValidateGraph} sending={props.sending} processingLabel={props.processingLabel} />;
    case "code": return <CodeView onPrompt={props.onPrompt} onValidateGraph={props.onValidateGraph} onTerminalRun={props.onTerminalRun} sending={props.sending} processingLabel={props.processingLabel} />;
    case "security": return <SecurityView messages={props.messages} sending={props.sending} processingLabel={props.processingLabel} onPrompt={props.onPrompt} onOpenExternal={props.onOpenExternal} />;
    default: return <ChatView messages={props.messages} sending={props.sending} processingLabel={props.processingLabel} onPrompt={props.onPrompt} />;
  }
}
