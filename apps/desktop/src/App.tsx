import { Component, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { exit } from "@tauri-apps/plugin-process";
import { MODES, type ExtensionBundle, type Mode, type RuntimeStatus, type TerminalResult } from "@ai-orchestrator/contracts";
import {
  Bot,
  Boxes,
  Braces,
  ChartNoAxesCombined,
  Check,
  ChevronDown,
  CircleStop,
  Database,
  Download,
  ExternalLink,
  Gamepad2,
  Image,
  LoaderCircle,
  Maximize2,
  MessageCircle,
  Minus,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plus,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Sun,
  Trash2,
  WandSparkles,
  Wifi,
  X,
  Puzzle
} from "lucide-react";
import { listWorkspaces, replicateDesign, streamChat, validateOrchestration, type ChatMessage, type GatewaySession } from "./lib/gateway";
import { runtime } from "./lib/runtime";
import { extensions } from "./lib/extensions";
import { terminal } from "./lib/terminal";
import { ModeView } from "./components/ModeViews";

const modeMeta: Record<Mode, { label: string; hint: string; icon: typeof MessageCircle }> = {
  chat: { label: "Chat", hint: "Converse, pesquise e estruture ideias", icon: MessageCircle },
  work: { label: "Work", hint: "Transforme objetivos em entregas", icon: Boxes },
  design: { label: "Design", hint: "Crie interfaces e direção visual", icon: WandSparkles },
  data: { label: "Data", hint: "Explore dados e construa análises", icon: ChartNoAxesCombined },
  agent: { label: "Agent", hint: "Coordene agentes e ferramentas", icon: Bot },
  code: { label: "Code", hint: "Construa, teste e revise software", icon: Braces },
  security: { label: "Security", hint: "Revise ameaças, código e dependências", icon: ShieldCheck },
  game: { label: "Game Studio", hint: "Crie cenas, assets e gameplay", icon: Gamepad2 }
};

const sidebarContent: Record<Mode, { title: string; action: string; items: string[] }> = {
  chat: { title: "RECENTES", action: "Nova tarefa", items: ["Planejar lançamento", "Revisar arquitetura", "Explorar nova interface"] },
  work: { title: "WORKSPACES", action: "Novo trabalho", items: ["Lançamento público", "Sprint atual", "Decisões pendentes"] },
  design: { title: "DESIGN FILES", action: "Novo design", items: ["Website replica", "Design system", "Component library", "Pixel QA"] },
  data: { title: "DATA WORKSPACE", action: "Novo schema", items: ["Commerce ERD", "Migration plan", "Queries", "Data quality"] },
  agent: { title: "ACTIVE AGENTS", action: "Novo fluxo", items: ["Planner", "Code agent A", "Code agent B", "Reviewer", "Security"] },
  code: { title: "AGENT TASKS", action: "Novo workspace", items: ["Implement terminal bridge", "Review ModeViews diff", "Security pass", "Changed files"] },
  security: { title: "REVIEWS", action: "Nova revisão", items: ["Changed files", "Dependencies", "Secrets", "Auth & RBAC", "Supply chain"] },
  game: { title: "GAME PROJECT", action: "Nova cena", items: ["World hierarchy", "Assets", "Gameplay scripts", "Build targets", "Cinematics"] }
};

const initialRuntime: RuntimeStatus = { installed: false, running: false, models: [] };
const requestedMode = new URLSearchParams(window.location.search).get("mode");
const initialMode: Mode = MODES.includes(requestedMode as Mode) ? requestedMode as Mode : "chat";
const isTauriHost = "__TAURI_INTERNALS__" in window;
const appWindow = isTauriHost ? getCurrentWindow() : null;
const defaultSession: GatewaySession = {
  baseUrl: localStorage.getItem("gateway.url") ?? "http://127.0.0.1:8787",
  workspaceId: localStorage.getItem("gateway.workspace") ?? "",
  accessToken: ""
};

const processingSequences: Record<Mode, string[]> = {
  chat: ["Pensando", "Processando contexto", "Sintetizando"],
  work: ["Processando", "Planejando", "Priorizando"],
  design: ["Processando", "Gerando", "Refinando"],
  data: ["Processando", "Calculando", "Validando"],
  agent: ["Planejando", "Orquestrando", "Executando"],
  code: ["Pensando", "Gerando", "Verificando"],
  security: ["Analisando", "Modelando ameaças", "Verificando"],
  game: ["Gerando", "Compilando cena", "Simulando"]
};

class ModeErrorBoundary extends Component<{ children: ReactNode; mode: Mode }, { error?: string }> {
  state: { error?: string } = {};
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error(`Mode ${this.props.mode} failed`, error, info); }
  componentDidUpdate(previous: { mode: Mode }) { if (previous.mode !== this.props.mode && this.state.error) this.setState({ error: undefined }); }
  render() {
    if (this.state.error) return <div className="mode-render-error"><ShieldCheck size={18}/><strong>Não foi possível renderizar {this.props.mode}</strong><small>{this.state.error}</small></div>;
    return this.props.children;
  }
}

function App() {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [theme, setTheme] = useState<"light" | "dark">(() => localStorage.getItem("ui.theme") === "dark" ? "dark" : "light");
  const [processStep, setProcessStep] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [session, setSession] = useState(defaultSession);
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus>(initialRuntime);
  const [authenticating, setAuthenticating] = useState(false);
  const [runtimeBusy, setRuntimeBusy] = useState(false);
  const [modelForm, setModelForm] = useState({ id: "", url: "", sha256: "" });
  const [extensionPath, setExtensionPath] = useState("");
  const [extensionResult, setExtensionResult] = useState<ExtensionBundle | null>(null);
  const [extensionBusy, setExtensionBusy] = useState(false);
  const [closing, setClosing] = useState(false);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const current = modeMeta[mode];
  const sidebar = sidebarContent[mode];
  const processingLabel = processingSequences[mode][processStep % processingSequences[mode].length];

  useEffect(() => {
    if (!isTauriHost) return;
    runtime.status().then(setRuntimeStatus).catch(() => undefined);
    invoke<{ accessToken: string } | null>("oidc_restore", { gatewayBaseUrl: defaultSession.baseUrl }).then(async (saved) => {
      if (!saved) return;
      const base = { baseUrl: defaultSession.baseUrl, accessToken: saved.accessToken };
      const workspaces = await listWorkspaces(base);
      const workspaceId = defaultSession.workspaceId || workspaces[0]?.id || "";
      setSession({ ...base, workspaceId });
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    localStorage.setItem("ui.theme", theme);
  }, [theme]);

  useEffect(() => {
    setProcessStep(0);
    if (!sending) return;
    const timer = window.setInterval(() => setProcessStep((value) => value + 1), 1550);
    return () => window.clearInterval(timer);
  }, [sending, mode]);

  const gatewayConnected = Boolean(session.accessToken && session.workspaceId);
  const connected = gatewayConnected || runtimeStatus.running;
  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    if (!connected) {
      setSettingsOpen(true);
      setError("Configure o gateway e autentique sua conta para continuar.");
      return;
    }
    const next = [...messages, { role: "user" as const, content: text }];
    setMessages([...next, { role: "assistant", content: "" }]);
    setInput("");
    setSending(true);
    setError("");
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      if (gatewayConnected) {
        await streamChat(session, mode, next, (delta) => {
          setMessages((items) => {
            const copy = [...items];
            const last = copy.at(-1);
            if (last?.role === "assistant") copy[copy.length - 1] = { ...last, content: last.content + delta };
            return copy;
          });
        }, abort.signal);
      } else {
        const response = await runtime.chat(next);
        const content = response.choices?.[0]?.message?.content ?? "O runtime não retornou conteúdo.";
        setMessages((items) => [...items.slice(0, -1), { role: "assistant", content }]);
      }
    } catch (cause) {
      if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  }

  async function connectGateway() {
    setAuthenticating(true);
    setError("");
    try {
      localStorage.setItem("gateway.url", session.baseUrl);
      const authenticated = await invoke<{ accessToken: string }>("oidc_login", { gatewayBaseUrl: session.baseUrl });
      const base = { baseUrl: session.baseUrl, accessToken: authenticated.accessToken };
      const workspaces = await listWorkspaces(base);
      const workspaceId = session.workspaceId || workspaces[0]?.id || "";
      localStorage.setItem("gateway.workspace", workspaceId);
      setSession({ ...base, workspaceId });
      if (!workspaceId) setError("Sua conta ainda não pertence a um workspace.");
      else setSettingsOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAuthenticating(false);
    }
  }

  async function runRuntimeAction(action: () => Promise<RuntimeStatus>) {
    setRuntimeBusy(true);
    setError("");
    try { setRuntimeStatus(await action()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setRuntimeBusy(false); }
  }

  async function addModel() {
    if (!modelForm.id || !modelForm.url || !modelForm.sha256) {
      setError("Informe nome, URL HTTPS e SHA-256 do modelo GGUF.");
      return;
    }
    await runRuntimeAction(() => runtime.downloadModel(modelForm.id, modelForm.url, modelForm.sha256));
    setModelForm({ id: "", url: "", sha256: "" });
  }

  async function openExternal(url: string) {
    if (isTauriHost) await openUrl(url);
    else window.open(url, "_blank", "noopener,noreferrer");
  }

  async function inspectExtension(importBundle = false) {
    if (!extensionPath.trim()) {
      setError("Informe a pasta do plugin, skill ou pacote de artifacts.");
      return;
    }
    if (!isTauriHost) {
      setExtensionResult({ name: "Pacote de demonstração", format: "agent-skill", sourcePath: extensionPath, skills: ["skills/reviewer/SKILL.md"], agents: [], artifacts: [], hasMcp: false, compatible: true, warnings: ["A importação real é habilitada no aplicativo desktop."] });
      return;
    }
    setExtensionBusy(true);
    setError("");
    try { setExtensionResult(await (importBundle ? extensions.import(extensionPath) : extensions.inspect(extensionPath))); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setExtensionBusy(false); }
  }

  async function runTerminal(command: string, cwd?: string): Promise<TerminalResult> {
    if (isTauriHost) return terminal.execute(command, cwd);
    return { command, exitCode: 0, stdout: "Preview web: a execução real fica no desktop sandboxed.\n", stderr: "", durationMs: 18 };
  }

  async function closeApplication() {
    if (closing) return;
    setClosing(true);

    if (!isTauriHost) {
      window.close();
      setClosing(false);
      return;
    }

    try {
      await invoke("app_shutdown");
    } catch {
      // If the command channel is unavailable, terminate through Tauri's native
      // process plugin instead of leaving an invisible process behind.
      try {
        await exit(0);
      } catch (cause) {
        setClosing(false);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    }
  }

  return (
    <main className={`app-shell mode-${mode}`} data-theme={theme}>
      <aside className={`sidebar glass ${sidebarOpen ? "" : "collapsed"}`}>
        <div className="brand">
          <span className="brand-mark"><Sparkles size={18} /></span>
          {sidebarOpen && <strong>AI Orchestrator</strong>}
          <button className="sidebar-toggle" onClick={() => setSidebarOpen((value) => !value)} aria-label={sidebarOpen ? "Recolher barra lateral" : "Expandir barra lateral"}>{sidebarOpen ? <PanelLeftClose size={16}/> : <PanelLeftOpen size={16}/>}</button>
        </div>
        <button className="new-task"><Plus size={17} />{sidebarOpen && sidebar.action}</button>
        <nav className="task-list">
          {sidebarOpen && <span className="eyebrow">{sidebar.title}</span>}
          {sidebar.items.map((task, index) => {
            const ItemIcon = modeMeta[mode].icon;
            const agentState = mode === "agent" ? sending ? index < processStep ? "done" : index === processStep ? "running" : "queued" : index === 0 ? "ready" : "queued" : undefined;
            return (
            <button className={index === 0 ? "active" : ""} key={task} title={task}>
              <ItemIcon size={15} />{sidebarOpen && <><span>{task}</span>{agentState && <small className={`sidebar-agent-state ${agentState}`}>{agentState}</small>}</>}
            </button>
          );})}
        </nav>
        <button className="sidebar-settings" onClick={() => setSettingsOpen(true)}>
          <Settings size={17} />{sidebarOpen && "Configurações"}
        </button>
      </aside>

      <section className="workspace">
        <header className="topbar glass" data-tauri-drag-region>
          <div className="mode-tabs" data-mode={mode}>
            <span className="tab-lens"><i /></span>
            {(Object.keys(modeMeta) as Mode[]).map((item) => {
              const Icon = modeMeta[item].icon;
              return <button key={item} aria-pressed={mode === item} className={mode === item ? "selected" : ""} onClick={() => setMode(item)}><span className="mode-icon"><Icon size={14} /></span><span>{modeMeta[item].label}</span></button>;
            })}
          </div>
          <button className="theme-toggle" onClick={() => setTheme((value) => value === "light" ? "dark" : "light")} aria-label={theme === "light" ? "Ativar modo escuro" : "Ativar modo claro"}>
            <span className="theme-thumb">{theme === "light" ? <Sun size={13}/> : <Moon size={13}/>}</span>
          </button>
          <div className="window-controls">
            <button onClick={() => void appWindow?.minimize()} aria-label="Minimizar"><Minus size={15} /></button>
            <button onClick={() => void appWindow?.toggleMaximize()} aria-label="Maximizar"><Maximize2 size={13} /></button>
            <button className="window-close" onClick={() => void closeApplication()} aria-label="Fechar aplicativo" disabled={closing}>
              {closing ? <LoaderCircle className="spin" size={14} /> : <X size={15} />}
            </button>
          </div>
        </header>

        <div className="mode-viewport">
          <div className="mode-stage" key={mode}>
            <ModeErrorBoundary mode={mode}><ModeView
              mode={mode}
              messages={messages}
              sending={sending}
              processingLabel={processingLabel}
              onPrompt={setInput}
              onReplicate={gatewayConnected ? (sourceUrl) => replicateDesign(session, { sourceUrl, mode: "static", maxPages: 8 }) : undefined}
              onValidateGraph={gatewayConnected ? (graph) => validateOrchestration(session, graph) : undefined}
              onTerminalRun={runTerminal}
              onOpenExternal={openExternal}
            /></ModeErrorBoundary>
          </div>
        </div>

        <footer className="composer-wrap">
          {error && <div className="error-banner"><span>{error}</span><button onClick={() => setError("")}><X size={14} /></button></div>}
          <div className="composer glass-strong">
            <textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); }
            }} placeholder={`Peça algo ao modo ${current.label}…`} />
            <div className="composer-actions">
              <button className="model-select"><Sparkles size={15} />Rota do workspace<ChevronDown size={14} /></button>
              {sending ? (
                <button className="send-button stop loading" onClick={() => abortRef.current?.abort()} aria-label="Parar resposta">
                  <span className="button-mitosis"><i /><i /><i /></span><CircleStop size={16} />
                </button>
              ) : (
                <button className="send-button" onClick={() => void send()} disabled={!input.trim()} aria-label="Enviar">
                  <span className="send-glint" /><Send size={17} />
                </button>
              )}
            </div>
          </div>
        </footer>
      </section>

      {settingsOpen && (
        <div className="modal-backdrop" onMouseDown={() => setSettingsOpen(false)}>
          <section className="settings-panel glass-strong" onMouseDown={(event) => event.stopPropagation()}>
            <header><div><span className="eyebrow">CONEXÕES</span><h2>Configurações</h2></div><button className="icon-button" onClick={() => setSettingsOpen(false)}><X size={18} /></button></header>
            <div className="settings-section">
              <div className="section-title"><Wifi size={18} /><div><strong>Gateway</strong><small>Seus provedores e rotas ficam protegidos no servidor.</small></div></div>
              <label>URL do gateway<input value={session.baseUrl} onChange={(event) => setSession({ ...session, baseUrl: event.target.value })} /></label>
              {gatewayConnected && <label>Workspace<input value={session.workspaceId} onChange={(event) => setSession({ ...session, workspaceId: event.target.value })} placeholder="UUID do workspace" /></label>}
              <button className="primary" onClick={() => void connectGateway()} disabled={authenticating}>
                {authenticating ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}{gatewayConnected ? "Reconectar" : "Entrar com OIDC"}
              </button>
            </div>
            <div className="settings-section">
              <div className="section-title"><Database size={18} /><div><strong>Runtime local</strong><small>Opcional. Nada é baixado ou iniciado automaticamente.</small></div></div>
              <div className="runtime-card">
                <span className={runtimeStatus.running ? "runtime-icon running" : "runtime-icon"}><Image size={19} /></span>
                <div><strong>{runtimeStatus.installed ? `Instalado · ${runtimeStatus.variant ?? "CPU"}` : "Não instalado"}</strong><small>{runtimeStatus.models.length} modelo(s) GGUF</small></div>
                {runtimeStatus.running ? <button disabled={runtimeBusy} onClick={() => void runRuntimeAction(runtime.stop)}><CircleStop size={15} />Parar</button> : runtimeStatus.installed && runtimeStatus.models[0] ? <button disabled={runtimeBusy} onClick={() => void runRuntimeAction(() => runtime.start(runtimeStatus.models[0].id))}><Play size={15} />Iniciar</button> : <button disabled={runtimeBusy || !runtimeStatus.installed} onClick={() => void runRuntimeAction(() => runtime.install("cpu"))}><Download size={15} />CPU</button>}
              </div>
              {!runtimeStatus.installed && <div className="runtime-choices">
                <button disabled={runtimeBusy} onClick={() => void runRuntimeAction(() => runtime.install("cpu"))}>Instalar CPU</button>
                <button disabled={runtimeBusy} onClick={() => void runRuntimeAction(() => runtime.install("vulkan"))}>Instalar Vulkan</button>
              </div>}
              {runtimeStatus.installed && <div className="model-manager">
                <span className="eyebrow">ADICIONAR MODELO GGUF</span>
                <div className="model-fields">
                  <input value={modelForm.id} onChange={(event) => setModelForm({ ...modelForm, id: event.target.value })} placeholder="Nome do modelo" />
                  <input value={modelForm.url} onChange={(event) => setModelForm({ ...modelForm, url: event.target.value })} placeholder="URL HTTPS do .gguf" />
                  <input value={modelForm.sha256} onChange={(event) => setModelForm({ ...modelForm, sha256: event.target.value })} placeholder="SHA-256" />
                  <button disabled={runtimeBusy} onClick={() => void addModel()}><Download size={15} />Baixar</button>
                </div>
                {runtimeStatus.models.map((model) => <div className="model-row" key={model.id}>
                  <div><strong>{model.id}</strong><small>{(model.size / 1024 / 1024 / 1024).toFixed(1)} GB</small></div>
                  <button disabled={runtimeBusy || runtimeStatus.running} onClick={() => void runRuntimeAction(() => runtime.start(model.id))}><Play size={14} /></button>
                  <button disabled={runtimeBusy || runtimeStatus.running} onClick={() => void runRuntimeAction(() => runtime.removeModel(model.id))}><Trash2 size={14} /></button>
                </div>)}
              </div>}
              <p className="privacy-note">O runtime escuta somente em 127.0.0.1, com porta dinâmica e token efêmero.</p>
            </div>
            <div className="settings-section">
              <div className="section-title"><ShieldCheck size={18} /><div><strong>Kimi K3 in C · experimental</strong><small>Modelo local avançado, opcional e nunca baixado automaticamente.</small></div></div>
              <div className="runtime-card kimi-card">
                <span className="runtime-icon"><Braces size={19} /></span>
                <div><strong>Não instalado · Linux x64 / WSL2</strong><small>AVX2 + FMA · ~1,7 TB livres · checkpoint base sem chat template</small></div>
                <button onClick={() => void openExternal("https://github.com/FareedKhan-dev/kimi-k3-in-c")}><ExternalLink size={14}/>Baixar por conta própria</button>
              </div>
              <p className="privacy-note">No Windows ele depende do WSL2. O AI Orchestrator apenas abre a fonte e não inicia o download de aproximadamente 1,56 TB.</p>
            </div>
            <div className="settings-section">
              <div className="section-title"><Puzzle size={18} /><div><strong>Plugins, Skills e Artifacts</strong><small>OpenAI/Codex, Anthropic/Claude e Agent Skills. A importação não executa scripts.</small></div></div>
              <label>Pasta do pacote<input value={extensionPath} onChange={(event) => setExtensionPath(event.target.value)} placeholder="C:\\workspace\\meu-plugin" /></label>
              <div className="extension-actions">
                <button disabled={extensionBusy} onClick={() => void inspectExtension(false)}>Inspecionar</button>
                <button className="primary" disabled={extensionBusy} onClick={() => void inspectExtension(true)}>{extensionBusy ? <LoaderCircle className="spin" size={14}/> : <Download size={14}/>}Importar cópia segura</button>
              </div>
              {extensionResult && <div className="extension-result">
                <span className="extension-compatible"><Check size={13}/>{extensionResult.name}</span>
                <small>{extensionResult.format} · {extensionResult.skills.length} skills · {extensionResult.agents.length} agents · {extensionResult.artifacts.length} artifacts{extensionResult.hasMcp ? " · MCP requer aprovação" : ""}</small>
                {extensionResult.warnings.map((warning) => <p key={warning}>{warning}</p>)}
              </div>}
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

export default App;
