import {
  Component,
  Suspense,
  lazy,
  useEffect,
  useState,
  type ErrorInfo,
  type ReactNode
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { exit } from "@tauri-apps/plugin-process";
import { UI_MODES, type UiMode } from "@orchestrator/contracts";
import {
  LoaderCircle,
  Maximize2,
  Minus,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Rocket,
  Settings,
  Sparkles,
  Sun,
  X
} from "lucide-react";
import { Glyph, modeIcons, modeIconsFilled } from "./components/icons";
import { listWorkspaces } from "./lib/gateway";
import { runtime } from "./lib/runtime";
import { effectiveModes, safeMode } from "./lib/policy";
import { restorePolicy, syncPolicy } from "./lib/policySync";
import { isSettingsShortcut, modeForDigitKey } from "./lib/shortcuts";
import { useApp } from "./lib/store";
import { startWorkEngine } from "./lib/workEngine";
import { configureBackgroundUpdater } from "./lib/updater";
import { GlassFilters } from "./components/GlassFilters";
import { Composer } from "./components/Composer";
import { ConnectionsPopover } from "./components/ConnectionsPopover";
import { ShipModal } from "./components/ShipModal";
import { ContextMeter } from "./components/ContextMeter";
import { TopbarSearch } from "./components/TopbarSearch";
import { EnvironmentBadge } from "./components/EnvironmentBadge";

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
  fluxo: () => import("./modes/FluxoView"),
  office: () => import("./modes/OfficeView"),
  tune: () => import("./modes/TuneView")
};
const ChatView = lazy(() => import("./modes/ChatView").then((m) => ({ default: m.ChatView })));
const CodeView = lazy(() => import("./modes/CodeView").then((m) => ({ default: m.CodeView })));
const DesignView = lazy(() => import("./modes/DesignView").then((m) => ({ default: m.DesignView })));
const DataView = lazy(() => import("./modes/DataView").then((m) => ({ default: m.DataView })));
const WorkView = lazy(() => import("./modes/WorkView").then((m) => ({ default: m.WorkView })));
const SecurityView = lazy(() => import("./modes/SecurityView").then((m) => ({ default: m.SecurityView })));
const AgentView = lazy(() => import("./modes/AgentView").then((m) => ({ default: m.AgentView })));
const FluxoView = lazy(() => import("./modes/FluxoView").then((m) => ({ default: m.FluxoView })));
const OfficeView = lazy(() => import("./modes/OfficeView").then((m) => ({ default: m.OfficeView })));
const TuneView = lazy(() => import("./modes/TuneView").then((m) => ({ default: m.TuneView })));
const SettingsPanel = lazy(() => import("./components/Settings").then((m) => ({ default: m.SettingsPanel })));

const isTauriHost = "__TAURI_INTERNALS__" in window;
const appWindow = isTauriHost ? getCurrentWindow() : null;

/**
 * Rótulo de cada aba. O ícone vem do pacote próprio (`modeIcons`): dez glifos
 * desenhados juntos deixam a barra de módulos com cara de um produto só, e não
 * de dez escolhas avulsas feitas em dias diferentes.
 */
const modeMeta: Record<UiMode, { label: string }> = {
  chat: { label: "Chat" },
  code: { label: "Code" },
  design: { label: "Design" },
  data: { label: "Data" },
  work: { label: "Work" },
  security: { label: "Security" },
  agent: { label: "Agent" },
  fluxo: { label: "Fluxo" },
  office: { label: "Office" },
  tune: { label: "Tuning" }
};

const railAction: Record<UiMode, string> = {
  chat: "Nova conversa",
  code: "Nova sessão",
  design: "Nova sessão",
  data: "Nova sessão",
  work: "Nova sessão",
  security: "Nova revisão",
  agent: "Nova equipe",
  fluxo: "Novo fluxo",
  office: "Nova sessão",
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
  fluxo: lazy(() =>
    import("./modes/FluxoView").then((m) => ({
      default: (m as { FluxoRail?: () => ReactNode }).FluxoRail ?? (() => null)
    }))
  ),
  office: lazy(() =>
    import("./modes/OfficeView").then((m) => ({
      default: (m as { OfficeRail?: () => ReactNode }).OfficeRail ?? (() => null)
    }))
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
  fluxo: () => <FluxoView />,
  office: () => <OfficeView />,
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
          <Glyph name="status/warning" size={20} />
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
  const [shipOpen, setShipOpen] = useState(false);

  const policy = useApp((state) => state.policy);

  // Abas efetivas = política do servidor ∩ preferência local. O gate é no
  // RENDER: a view bloqueada nem monta (gate por useEffect deixava a view
  // proibida montar e rodar efeitos antes do redirect).
  const preferredModes = settings.visibleModes.length ? settings.visibleModes : [...UI_MODES];
  const visibleModes = effectiveModes(policy?.allowedModes ?? null, preferredModes);
  const activeMode = safeMode(mode, visibleModes);
  const RailPanel = activeMode ? railViews[activeMode] : null;

  // Mantém o estado coerente com o que está renderizado (a renderização já
  // usa activeMode, então isto é só sincronização de estado, não gate).
  useEffect(() => {
    if (activeMode && activeMode !== mode) setMode(activeMode);
  }, [activeMode, mode, setMode]);

  // Compatibilidade com o original: ?mode=<aba> abre direto na aba pedida.
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("mode") as UiMode | null;
    if (requested && (UI_MODES as readonly string[]).includes(requested)) setMode(requested);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const gatewayConnected = Boolean(session?.accessToken && session.workspaceId);
  const connected = gatewayConnected || runtimeStatus.running;

  // Motor de automações do Work: precisa valer em QUALQUER aba. Antes vivia
  // dentro do WorkView, que só é montado quando a aba está ativa — o timer de
  // due date parava e as ops:work emitidas por outra aba eram perdidas.
  useEffect(() => {
    startWorkEngine();
  }, []);

  useEffect(() => {
    /*
     * Atualização automática — a razão de não haver reinstalação manual.
     *
     * A pipeline publica uma versão assinada; o app a baixa em segundo plano
     * e aplica ao fechar. Estava escrito e sem chamador: o app só atualizava
     * se alguém abrisse Configurações e clicasse, e por isso cada correção
     * parecia exigir instalar de novo à mão.
     *
     * Falha aqui é SILENCIOSA de propósito. Sem rede, ou com o updater ainda
     * não configurado (chave no placeholder, o normal em desenvolvimento), o
     * plugin lança — e nada disso é problema de quem só quer usar o app. Quem
     * precisa do detalhe abre Configurações, onde a verificação manual mostra
     * o motivo por escrito.
     */
    void configureBackgroundUpdater();
  }, []);

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
    // Política em cache (assinada, reverificada no Rust) vale ANTES da rede:
    // o gating não espera o gateway responder.
    void restorePolicy();
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

  // Sessão viva → renova a política do servidor (perfil, módulos, prompt).
  useEffect(() => {
    if (!session?.accessToken) return;
    void syncPolicy(settings.gateway.baseUrl, session.accessToken);
  }, [session?.accessToken, settings.gateway.baseUrl]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.ctrlKey && !event.shiftKey && !event.altKey) {
        const visible = useApp.getState().settings.visibleModes;
        const list = visible.length ? visible : [...UI_MODES];
        const target = modeForDigitKey(event.key, list);
        if (target) {
          event.preventDefault();
          switchModeWithTransition(useApp.getState().mode, target, () => setMode(target));
        }
      }
      if (isSettingsShortcut(event)) {
        event.preventDefault();
        useApp.getState().setSettingsOpen(!useApp.getState().settingsOpen);
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
          {railOpen && <strong>AI-Orchestrator</strong>}
          <button
            className="icon-button rail-toggle"
            onClick={() => setRailOpen(!railOpen)}
            aria-label={railOpen ? "Recolher barra lateral" : "Expandir barra lateral"}
          >
            {railOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
          </button>
        </div>
        <button
          className="new-task glint"
          onClick={() => {
            // Cada aba tem a sua unidade de trabalho: no Fluxo o botao cria um
            // fluxo, e nao mais uma conversa que ninguem usaria ali.
            if (mode === "fluxo") void import("./lib/fluxo/store").then((m) => m.useFluxo.getState().newFlow());
            else newConversation(mode);
          }}
        >
          <Plus size={16} />
          {railOpen && railAction[mode]}
        </button>
        {railOpen && RailPanel && (
          <nav className="rail-panel" key={activeMode ?? "none"}>
            <Suspense fallback={<div className="mode-loading" style={{ height: 120 }} />}>
              <RailPanel />
            </Suspense>
          </nav>
        )}
        {!railOpen && <nav />}
        <div className="rail-footer">
          <button
            onClick={() => setTheme(theme === "light" ? "dark" : "light")}
            aria-label={theme === "light" ? "Ativar modo escuro" : "Ativar modo claro"}
          >
            {theme === "light" ? <Moon size={16} /> : <Sun size={16} />}
            {railOpen && (theme === "light" ? "Modo escuro" : "Modo claro")}
          </button>
          <button onClick={() => setSettingsOpen(true)} title="Configurações (Ctrl+,)">
            <Settings size={16} />
            {railOpen && "Configurações"}
          </button>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar glass" data-tauri-drag-region>
          {/* Abas de MÓDULO no topo; a barra esquerda serve o módulo ativo. */}
          <nav className="mode-tabs" aria-label="Módulos">
            {visibleModes.map((item) => {
              // Preenchido na aba ativa, contornado nas demais: a aba corrente
              // se distingue pelo PESO do ícone, não só pelo fundo do botão.
              const Icon = mode === item ? modeIconsFilled[item] : modeIcons[item];
              return (
                <button
                  key={item}
                  className={`mode-tab ${mode === item ? "active" : ""}`}
                  aria-pressed={mode === item}
                  title={modeMeta[item].label}
                  onClick={() => switchModeWithTransition(mode, item, () => setMode(item))}
                >
                  <Icon size={15} />
                  <span className="mode-tab-label">{modeMeta[item].label}</span>
                </button>
              );
            })}
          </nav>
          {/* A busca vive aqui, e não no rail: em cima ela existe uma vez só,
              vale para toda aba e devolve uma linha à coluna mais estreita. */}
          <TopbarSearch />
          <div className="topbar-actions" id="topbar-actions" />
          <div className="topbar-right">
            {/* Build & deploy vale para Code e Agent; vive aqui e não no rail,
                que já estava apertado com árvore de arquivos e sessões. */}
            {(mode === "code" || mode === "agent") && (
              <button className="topbar-ship" onClick={() => setShipOpen(true)} title="Build e deploy">
                <Rocket size={13} />
                <span className="topbar-ship__label">Build &amp; deploy</span>
              </button>
            )}
            <ContextMeter />
            <ConnectionsPopover />
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
          {activeMode ? (
            <div className="mode-stage" key={activeMode}>
              <ModeErrorBoundary mode={activeMode}>
                <Suspense fallback={<div className="mode-loading" aria-hidden="true" />}>
                  {modeViews[activeMode]()}
                </Suspense>
              </ModeErrorBoundary>
            </div>
          ) : (
            // Política sem nenhum módulo liberado para o grupo do usuário.
            <div className="mode-render-error">
              <Glyph name="features/policy" size={20} />
              <strong>Nenhum módulo liberado para o seu grupo</strong>
              <small>Fale com a administração para solicitar acesso.</small>
            </div>
          )}
        </div>

        {activeMode ? <Composer /> : null}
        {/* Rodapé fixo estilo status bar: o badge de ambiente sempre visível,
            e o slot que as views alimentam por portal ao lado. */}
        <footer className="statusbar">
          <EnvironmentBadge />
          <div className="statusbar__slot v-status" id="statusbar-slot" />
        </footer>
      </section>

      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsPanel />
        </Suspense>
      )}

      {shipOpen && (
        <ShipModal root={window.localStorage.getItem("code.root") ?? "."} onClose={() => setShipOpen(false)} />
      )}
    </main>
  );
}

export default App;
