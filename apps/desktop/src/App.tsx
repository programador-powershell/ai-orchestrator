import {
  Component,
  Suspense,
  lazy,
  useEffect,
  useState,
  type CSSProperties,
  type ErrorInfo,
  type ReactNode
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { exit } from "@tauri-apps/plugin-process";
import { UI_MODES, type UiMode } from "@ai-orchestrator/contracts";
import {
  Bot,
  Boxes,
  Braces,
  ChartNoAxesCombined,
  FlaskConical,
  Gamepad2,
  LoaderCircle,
  Maximize2,
  MessageCircle,
  Minus,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings,
  ShieldCheck,
  Sparkles,
  Sun,
  WandSparkles,
  X
} from "lucide-react";
import { listWorkspaces } from "./lib/gateway";
import { runtime } from "./lib/runtime";
import { useApp } from "./lib/store";
import { GlassFilters } from "./components/GlassFilters";
import { Composer } from "./components/Composer";

/**
 * Views carregadas sob demanda (code-split) e pré-aquecidas em idle:
 * partida rápida sem sacrificar a troca instantânea de aba.
 */
const viewLoaders: Record<UiMode, () => Promise<{ [key: string]: unknown }>> = {
  chat: () => import("./modes/ChatView"),
  code: () => import("./modes/CodeView"),
  design: () => import("./modes/DesignView"),
  data: () => import("./modes/DataView"),
  work: () => import("./modes/WorkView"),
  security: () => import("./modes/SecurityView"),
  agent: () => import("./modes/AgentView"),
  game: () => import("./modes/GameView"),
  tune: () => import("./modes/TuneView")
};
const ChatView = lazy(() => import("./modes/ChatView").then((m) => ({ default: m.ChatView })));
const CodeView = lazy(() => import("./modes/CodeView").then((m) => ({ default: m.CodeView })));
const DesignView = lazy(() => import("./modes/DesignView").then((m) => ({ default: m.DesignView })));
const DataView = lazy(() => import("./modes/DataView").then((m) => ({ default: m.DataView })));
const WorkView = lazy(() => import("./modes/WorkView").then((m) => ({ default: m.WorkView })));
const SecurityView = lazy(() => import("./modes/SecurityView").then((m) => ({ default: m.SecurityView })));
const AgentView = lazy(() => import("./modes/AgentView").then((m) => ({ default: m.AgentView })));
const GameView = lazy(() => import("./modes/GameView").then((m) => ({ default: m.GameView })));
const TuneView = lazy(() => import("./modes/TuneView").then((m) => ({ default: m.TuneView })));
const SettingsPanel = lazy(() => import("./components/Settings").then((m) => ({ default: m.SettingsPanel })));

const isTauriHost = "__TAURI_INTERNALS__" in window;
const appWindow = isTauriHost ? getCurrentWindow() : null;

const modeMeta: Record<UiMode, { label: string; icon: typeof MessageCircle }> = {
  chat: { label: "Chat", icon: MessageCircle },
  code: { label: "Code", icon: Braces },
  design: { label: "Design", icon: WandSparkles },
  data: { label: "Data", icon: ChartNoAxesCombined },
  work: { label: "Work", icon: Boxes },
  security: { label: "Security", icon: ShieldCheck },
  agent: { label: "Agent", icon: Bot },
  game: { label: "Game", icon: Gamepad2 },
  tune: { label: "Tuning", icon: FlaskConical }
};

const railAction: Record<UiMode, string> = {
  chat: "Nova conversa",
  code: "Nova sessão",
  design: "Nova sessão",
  data: "Nova sessão",
  work: "Nova sessão",
  security: "Nova revisão",
  agent: "Novo fluxo",
  game: "Nova cena",
  tune: "Novo treino"
};

/**
 * Rail modular: cada aba fornece seu próprio painel lateral (arquivos no Code,
 * layers no Design, schema no Data…). Export ausente → rail vazio, sem quebrar.
 */
const railViews: Record<UiMode, ReturnType<typeof lazy>> = {
  chat: lazy(() =>
    import("./modes/ChatView").then((m) => ({ default: (m as { ChatRail?: () => ReactNode }).ChatRail ?? (() => null) }))
  ),
  code: lazy(() =>
    import("./modes/CodeView").then((m) => ({ default: (m as { CodeRail?: () => ReactNode }).CodeRail ?? (() => null) }))
  ),
  design: lazy(() =>
    import("./modes/DesignView").then((m) => ({
      default: (m as { DesignRail?: () => ReactNode }).DesignRail ?? (() => null)
    }))
  ),
  data: lazy(() =>
    import("./modes/DataView").then((m) => ({ default: (m as { DataRail?: () => ReactNode }).DataRail ?? (() => null) }))
  ),
  work: lazy(() =>
    import("./modes/WorkView").then((m) => ({ default: (m as { WorkRail?: () => ReactNode }).WorkRail ?? (() => null) }))
  ),
  security: lazy(() =>
    import("./modes/SecurityView").then((m) => ({
      default: (m as { SecurityRail?: () => ReactNode }).SecurityRail ?? (() => null)
    }))
  ),
  agent: lazy(() =>
    import("./modes/AgentView").then((m) => ({
      default: (m as { AgentRail?: () => ReactNode }).AgentRail ?? (() => null)
    }))
  ),
  game: lazy(() =>
    import("./modes/GameView").then((m) => ({ default: (m as { GameRail?: () => ReactNode }).GameRail ?? (() => null) }))
  ),
  tune: lazy(() =>
    import("./modes/TuneView").then((m) => ({ default: (m as { TuneRail?: () => ReactNode }).TuneRail ?? (() => null) }))
  )
};

const modeViews: Record<UiMode, () => ReactNode> = {
  chat: () => <ChatView />,
  code: () => <CodeView />,
  design: () => <DesignView />,
  data: () => <DataView />,
  work: () => <WorkView />,
  security: () => <SecurityView />,
  agent: () => <AgentView />,
  game: () => <GameView />,
  tune: () => <TuneView />
};

class ModeErrorBoundary extends Component<{ children: ReactNode; mode: UiMode }, { error?: string }> {
  state: { error?: string } = {};
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`Mode ${this.props.mode} failed`, error, info);
  }
  componentDidUpdate(previous: { mode: UiMode }) {
    if (previous.mode !== this.props.mode && this.state.error) this.setState({ error: undefined });
  }
  render() {
    if (this.state.error) {
      return (
        <div className="mode-render-error">
          <ShieldCheck size={20} />
          <strong>Não foi possível renderizar {this.props.mode}</strong>
          <small>{this.state.error}</small>
        </div>
      );
    }
    return this.props.children;
  }
}

function switchModeWithTransition(current: UiMode, next: UiMode, apply: () => void) {
  if (current === next) return;
  const direction = UI_MODES.indexOf(next) > UI_MODES.indexOf(current) ? 1 : -1;
  document.documentElement.style.setProperty("--vt-dir", String(direction));
  const doc = document as Document & {
    startViewTransition?: (callback: () => void) => { ready?: Promise<void>; finished?: Promise<void> } | undefined;
  };
  if (typeof doc.startViewTransition === "function" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    // Documento oculto ou trocas em rajada abortam a transição (InvalidStateError);
    // o callback ainda executa, então basta silenciar as promises.
    const transition = doc.startViewTransition(apply);
    transition?.ready?.catch(() => undefined);
    transition?.finished?.catch(() => undefined);
  } else {
    apply();
  }
}

function App() {
  const mode = useApp((state) => state.mode);
  const setMode = useApp((state) => state.setMode);
  const theme = useApp((state) => state.theme);
  const setTheme = useApp((state) => state.setTheme);
  const railOpen = useApp((state) => state.railOpen);
  const setRailOpen = useApp((state) => state.setRailOpen);
  const settingsOpen = useApp((state) => state.settingsOpen);
  const setSettingsOpen = useApp((state) => state.setSettingsOpen);
  const session = useApp((state) => state.session);
  const setSession = useApp((state) => state.setSession);
  const runtimeStatus = useApp((state) => state.runtimeStatus);
  const setRuntimeStatus = useApp((state) => state.setRuntimeStatus);
  const settings = useApp((state) => state.settings);
  const newConversation = useApp((state) => state.newConversation);
  const [closing, setClosing] = useState(false);

  const visibleModes = settings.visibleModes.length ? settings.visibleModes : [...UI_MODES];
  const RailPanel = railViews[mode];

  // Aba atual foi ocultada nas Configurações → vai para a primeira visível.
  useEffect(() => {
    if (!visibleModes.includes(mode)) setMode(visibleModes[0]);
  }, [visibleModes, mode, setMode]);

  // Compatibilidade com o original: ?mode=<aba> abre direto na aba pedida.
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("mode") as UiMode | null;
    if (requested && (UI_MODES as readonly string[]).includes(requested)) setMode(requested);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const gatewayConnected = Boolean(session?.accessToken && session.workspaceId);
  const connected = gatewayConnected || runtimeStatus.running;

  useEffect(() => {
    // Pré-aquece todas as views (e o Settings) fora do caminho crítico de boot.
    const warmup = window.setTimeout(() => {
      for (const loader of Object.values(viewLoaders)) void loader().catch(() => undefined);
      void import("./components/Settings").catch(() => undefined);
    }, 600);
    return () => window.clearTimeout(warmup);
  }, []);

  useEffect(() => {
    if (!isTauriHost) return;
    runtime.status().then(setRuntimeStatus).catch(() => undefined);
    invoke<{ accessToken: string } | null>("oidc_restore", { gatewayBaseUrl: settings.gateway.baseUrl })
      .then(async (saved) => {
        if (!saved) return;
        const base = { baseUrl: settings.gateway.baseUrl, accessToken: saved.accessToken };
        const workspaces = await listWorkspaces(base);
        const workspaceId = settings.gateway.workspaceId || workspaces[0]?.id || "";
        setSession({ ...base, workspaceId });
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.ctrlKey && !event.shiftKey && !event.altKey) {
        const index = Number(event.key) - 1;
        const visible = useApp.getState().settings.visibleModes;
        const list = visible.length ? visible : [...UI_MODES];
        if (index >= 0 && index < list.length) {
          event.preventDefault();
          switchModeWithTransition(useApp.getState().mode, list[index], () => setMode(list[index]));
        }
      }
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "p") {
        event.preventDefault();
        useApp.getState().setPlanMode(!useApp.getState().planMode);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setMode]);

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
      try {
        await exit(0);
      } catch {
        setClosing(false);
      }
    }
  }

  return (
    <main className="app-shell" data-theme={theme} data-mode={mode}>
      <GlassFilters />
      <div className="ambient" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>

      <aside className={`rail glass ${railOpen ? "" : "collapsed"}`}>
        <div className="brand">
          <span className="brand-mark">
            <Sparkles size={17} />
          </span>
          {railOpen && <strong>AI Orchestrator</strong>}
          <button
            className="icon-button rail-toggle"
            onClick={() => setRailOpen(!railOpen)}
            aria-label={railOpen ? "Recolher barra lateral" : "Expandir barra lateral"}
          >
            {railOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
          </button>
        </div>
        <button className="new-task glint" onClick={() => newConversation(mode)}>
          <Plus size={16} />
          {railOpen && railAction[mode]}
        </button>
        {railOpen && (
          <nav className="rail-panel" key={mode}>
            <Suspense fallback={<div className="mode-loading" style={{ height: 120 }} />}>
              <RailPanel />
            </Suspense>
          </nav>
        )}
        {!railOpen && <nav />}
        <div className="rail-footer">
          <button onClick={() => setSettingsOpen(true)}>
            <Settings size={16} />
            {railOpen && "Configurações"}
          </button>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar glass" data-tauri-drag-region>
          <div className="mode-tabs">
            <span className="tab-lens" style={{ "--tab": Math.max(0, visibleModes.indexOf(mode)) } as CSSProperties} />
            {visibleModes.map((item) => {
              const Icon = modeMeta[item].icon;
              return (
                <button
                  key={item}
                  aria-pressed={mode === item}
                  className={mode === item ? "selected" : ""}
                  onClick={() => switchModeWithTransition(mode, item, () => setMode(item))}
                >
                  <span className="mode-icon">
                    <Icon size={14} />
                  </span>
                  <span>{modeMeta[item].label}</span>
                </button>
              );
            })}
          </div>
          <div className="topbar-actions" id="topbar-actions" />
          <div className="topbar-right">
            <button className="status-pill" onClick={() => setSettingsOpen(true)}>
              <span className={`dot ${connected ? "online" : ""}`} />
              <span className="pill-label">
                {gatewayConnected ? "Gateway conectado" : runtimeStatus.running ? "Runtime local" : "Desconectado"}
              </span>
            </button>
            <button
              className="theme-toggle"
              onClick={() => setTheme(theme === "light" ? "dark" : "light")}
              aria-label={theme === "light" ? "Ativar modo escuro" : "Ativar modo claro"}
            >
              <span className="theme-thumb">{theme === "light" ? <Sun size={12} /> : <Moon size={12} />}</span>
            </button>
            <div className="window-controls">
              <button onClick={() => void appWindow?.minimize()} aria-label="Minimizar">
                <Minus size={15} />
              </button>
              <button onClick={() => void appWindow?.toggleMaximize()} aria-label="Maximizar">
                <Maximize2 size={13} />
              </button>
              <button className="window-close" onClick={() => void closeApplication()} aria-label="Fechar" disabled={closing}>
                {closing ? <LoaderCircle className="spin" size={14} /> : <X size={15} />}
              </button>
            </div>
          </div>
        </header>

        <div className="mode-viewport">
          <div className="mode-stage" key={mode}>
            <ModeErrorBoundary mode={mode}>
              <Suspense fallback={<div className="mode-loading" aria-hidden="true" />}>{modeViews[mode]()}</Suspense>
            </ModeErrorBoundary>
          </div>
        </div>

        <Composer />
        <footer className="statusbar v-status" id="statusbar-slot" />
      </section>

      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsPanel />
        </Suspense>
      )}
    </main>
  );
}

export default App;
