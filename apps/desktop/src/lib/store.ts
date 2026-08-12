import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  UI_MODES,
  type EngineSelection,
  type ExecutionPlan,
  type FusionPreset,
  type ResearchReport,
  type RuntimeStatus,
  type UiMode
} from "@ai-orchestrator/contracts";
import type { ChatMessage, GatewaySession } from "./gateway";
import type { ToolCard } from "./toolcard";
import type { ApprovalPolicy } from "./approval";

export interface ThreadMessage extends ChatMessage {
  /** Anexos estruturados produzidos pelo motor (plano, pesquisa, ops, tools). */
  meta?: {
    kind?: "text" | "plan" | "research" | "ops" | "tools";
    planTitle?: string;
    /** Grupo de ferramentas executadas (cartão recolhível estilo Studio). */
    tools?: ToolCard[];
    /** Raciocínio do modelo — bloco "Pensando" recolhível, antes da resposta. */
    reasoning?: string;
  };
}

export interface ThreadState {
  messages: ThreadMessage[];
  sending: boolean;
}

/** Conversa persistida — o rail lista conversas reais, não itens estáticos. */
export interface Conversation {
  id: string;
  title: string;
  messages: ThreadMessage[];
  updatedAt: number;
}

const newConversationId = () =>
  crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

function conversationTitle(messages: ThreadMessage[]): string {
  const firstUser = messages.find((message) => message.role === "user");
  const raw = firstUser?.content.trim().replace(/\s+/g, " ") ?? "Nova conversa";
  return raw.length > 44 ? `${raw.slice(0, 43)}…` : raw;
}

export interface GatewayConfig {
  baseUrl: string;
  workspaceId: string;
}

export interface CatalogModel {
  providerId: string;
  model: string;
  label?: string;
}

export interface AppSettings {
  gateway: GatewayConfig;
  /** Seleção de motor por aba — "papel" do fusion. */
  engines: Record<UiMode, EngineSelection>;
  fusionPresets: FusionPreset[];
  /** Catálogo de modelos gerenciado pelo admin — alimenta o seletor e o fusion. */
  modelCatalog: CatalogModel[];
  memoryEnabled: boolean;
  /** Política de aprovação de ferramentas do agente (definida pela TI). */
  approvalPolicy: ApprovalPolicy;
  memoryRecallK: number;
  /** Nível de esforço 0–4 (Baixo…Máximo) — injeta diretiva real no motor. */
  effort: number;
  /** Base URLs custom por provedor (compatíveis/self-hosted). */
  providerBaseOverrides: Record<string, string>;
  /** Versão do seed do catálogo — permite somar novos defaults sem ressuscitar removidos. */
  catalogSeed: number;
  /** Abas visíveis — o admin/usuário oculta/exibe pelo Settings (mínimo 1). */
  visibleModes: UiMode[];
  /** Abas que este perfil já conheceu — permite exibir abas NOVAS sem ressuscitar ocultadas. */
  modesSeen: UiMode[];
  /** Servidores MCP externos (nome + URL JSON-RPC + token opcional). */
  mcpServers: Array<{ name: string; url: string; token?: string }>;
}

export const effortLevels = ["Baixo", "Médio", "Alto", "Extra", "Máximo"] as const;

/** Diretiva de sistema por nível — comportamento real, independente do provedor. */
export function effortDirective(effort: number): string {
  const directives = [
    "Esforço: BAIXO. Responda de forma direta e curta, sem raciocínio extenso; priorize velocidade.",
    "Esforço: MÉDIO. Equilibre profundidade e velocidade; raciocine apenas o necessário.",
    "Esforço: ALTO. Raciocine com cuidado, considere alternativas e verifique a resposta antes de concluir.",
    "Esforço: EXTRA. Raciocine em profundidade, enumere hipóteses, cheque casos de borda e valide cada conclusão.",
    "Esforço: MÁXIMO. Use o máximo de raciocínio: decomponha o problema, explore alternativas, critique a própria resposta e refine antes de entregar."
  ];
  return directives[Math.max(0, Math.min(4, Math.round(effort)))];
}

/** Modelos habilitados por padrão — apenas IDs reais de API. */
export const CATALOG_SEED = 2;
export const defaultModelCatalog: CatalogModel[] = [
  { providerId: "anthropic", model: "claude-opus-5", label: "Claude Opus 5" },
  { providerId: "anthropic", model: "claude-sonnet-5", label: "Claude Sonnet 5" },
  { providerId: "anthropic", model: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
  { providerId: "openai", model: "gpt-5.1", label: "GPT-5.1" },
  { providerId: "openai", model: "gpt-5", label: "GPT-5" },
  { providerId: "openai", model: "gpt-5-mini", label: "GPT-5 mini" },
  { providerId: "deepseek", model: "deepseek-chat", label: "DeepSeek Chat" },
  { providerId: "deepseek", model: "deepseek-reasoner", label: "DeepSeek Reasoner" }
];

const emptyThread = (): ThreadState => ({ messages: [], sending: false });

export const defaultFusionPresets: FusionPreset[] = [
  {
    id: "deep-audit",
    name: "Deep Audit",
    strategy: "orchestrate",
    orchestrator: { providerId: "moonshot", model: "kimi-latest" },
    executors: [{ providerId: "openai", model: "gpt-5.1" }],
    notes:
      "Política de SALVAGUARDA (Security): o modelo com menos salvaguardas orquestra — explora hipóteses e define o escopo; o modelo mais restrito apenas executa e entrega. Sem sobreposição de papéis."
  },
  {
    id: "code-pair",
    name: "Code Pair",
    strategy: "orchestrate",
    orchestrator: { providerId: "anthropic", model: "claude-sonnet-5" },
    executors: [{ providerId: "openai", model: "gpt-5-mini" }],
    notes:
      "Política de CUSTO/INTELIGÊNCIA (Code): o modelo mais inteligente orquestra — especifica e revisa; o modelo mais barato apenas executa o código conforme a spec."
  },
  {
    id: "tri-merge",
    name: "Fusion",
    strategy: "merge",
    orchestrator: { providerId: "anthropic", model: "claude-sonnet-5" },
    executors: [
      { providerId: "openai", model: "gpt-5.1" },
      { providerId: "moonshot", model: "kimi-latest" },
      { providerId: "deepseek", model: "deepseek-chat" }
    ],
    notes:
      "Cooperação por DECOMPOSIÇÃO: o orquestrador divide a tarefa em focos complementares (um por executor, sem repetição) e integra as partes — os modelos trabalham em conjunto, nunca sobrepostos."
  }
];

const defaultEngines: Record<UiMode, EngineSelection> = {
  chat: { kind: "workspace" },
  code: { kind: "fusion", presetId: "code-pair" },
  design: { kind: "workspace" },
  data: { kind: "workspace" },
  work: { kind: "workspace" },
  security: { kind: "fusion", presetId: "deep-audit" },
  agent: { kind: "workspace" },
  game: { kind: "workspace" },
  tune: { kind: "workspace" }
};

interface AppState {
  mode: UiMode;
  theme: "light" | "dark";
  railOpen: boolean;
  settingsOpen: boolean;
  planMode: boolean;
  researchMode: boolean;
  /** Modo agente: o modelo executa ferramentas (fs/terminal) com aprovação. */
  toolsMode: boolean;
  input: string;
  error: string;
  threads: Record<UiMode, ThreadState>;
  /** Histórico real de conversas por aba (persistido). */
  conversations: Record<UiMode, Conversation[]>;
  activeConversation: Record<UiMode, string>;
  activePlan: ExecutionPlan | null;
  settings: AppSettings;
  /** Estado de runtime (não persistido). */
  session: GatewaySession | null;
  runtimeStatus: RuntimeStatus;
  stage: string;
  researchReport: ResearchReport | null;
  /** Anexos reais aguardando o próximo envio (nome + conteúdo lido do arquivo). */
  attachments: Array<{ name: string; content: string }>;

  setSession: (session: GatewaySession | null) => void;
  setRuntimeStatus: (status: RuntimeStatus) => void;
  setStage: (stage: string) => void;
  setResearchReport: (report: ResearchReport | null) => void;
  setAttachments: (attachments: Array<{ name: string; content: string }>) => void;
  setMode: (mode: UiMode) => void;
  setTheme: (theme: "light" | "dark") => void;
  setRailOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setPlanMode: (on: boolean) => void;
  setResearchMode: (on: boolean) => void;
  setToolsMode: (on: boolean) => void;
  setInput: (value: string) => void;
  setError: (message: string) => void;
  setActivePlan: (plan: ExecutionPlan | null) => void;
  updateSettings: (patch: Partial<AppSettings>) => void;
  setEngine: (mode: UiMode, selection: EngineSelection) => void;

  appendMessage: (mode: UiMode, message: ThreadMessage) => void;
  patchLastAssistant: (mode: UiMode, delta: string) => void;
  patchLastReasoning: (mode: UiMode, delta: string) => void;
  updateToolGroup: (mode: UiMode, update: (cards: ToolCard[]) => ToolCard[]) => void;
  replaceLastAssistant: (mode: UiMode, message: ThreadMessage) => void;
  setSending: (mode: UiMode, sending: boolean) => void;
  clearThread: (mode: UiMode) => void;
  newConversation: (mode: UiMode) => void;
  loadConversation: (mode: UiMode, id: string) => void;
  deleteConversation: (mode: UiMode, id: string) => void;
}

/** Espelha o thread ativo na lista de conversas persistidas. */
function syncConversation(state: {
  conversations: Record<UiMode, Conversation[]>;
  activeConversation: Record<UiMode, string>;
}, mode: UiMode, messages: ThreadMessage[]) {
  const id = state.activeConversation[mode];
  const list = state.conversations[mode] ?? [];
  const existing = list.find((item) => item.id === id);
  const entry: Conversation = {
    id,
    title: conversationTitle(messages),
    messages: messages.slice(-200),
    updatedAt: Date.now()
  };
  const next = existing ? list.map((item) => (item.id === id ? entry : item)) : [entry, ...list];
  next.sort((a, b) => b.updatedAt - a.updatedAt);
  return { ...state.conversations, [mode]: next.slice(0, 50) };
}

export const useApp = create<AppState>()(
  persist(
    (set) => ({
      mode: "chat",
      theme: "light",
      railOpen: true,
      settingsOpen: false,
      planMode: false,
      researchMode: false,
      toolsMode: false,
      input: "",
      error: "",
      threads: {
        chat: emptyThread(),
        code: emptyThread(),
        design: emptyThread(),
        data: emptyThread(),
        work: emptyThread(),
        security: emptyThread(),
        agent: emptyThread(),
        game: emptyThread(),
        tune: emptyThread()
      },
      conversations: { chat: [], code: [], design: [], data: [], work: [], security: [], agent: [], game: [], tune: [] },
      activeConversation: {
        chat: newConversationId(),
        code: newConversationId(),
        design: newConversationId(),
        data: newConversationId(),
        work: newConversationId(),
        security: newConversationId(),
        agent: newConversationId(),
        game: newConversationId(),
        tune: newConversationId()
      },
      activePlan: null,
      settings: {
        gateway: { baseUrl: "http://127.0.0.1:8787", workspaceId: "" },
        engines: defaultEngines,
        fusionPresets: defaultFusionPresets,
        modelCatalog: defaultModelCatalog,
        memoryEnabled: true,
        approvalPolicy: "ask",
        memoryRecallK: 6,
        effort: 1,
        providerBaseOverrides: {},
        catalogSeed: CATALOG_SEED,
        visibleModes: [...UI_MODES],
        modesSeen: [...UI_MODES],
        mcpServers: []
      },
      session: null,
      runtimeStatus: { installed: false, running: false, models: [] },
      stage: "",
      researchReport: null,
      attachments: [],

      setSession: (session) => set({ session }),
      setRuntimeStatus: (runtimeStatus) => set({ runtimeStatus }),
      setStage: (stage) => set({ stage }),
      setResearchReport: (researchReport) => set({ researchReport }),
      setAttachments: (attachments) => set({ attachments }),
      setMode: (mode) => set({ mode }),
      setTheme: (theme) => set({ theme }),
      setRailOpen: (railOpen) => set({ railOpen }),
      setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
      setPlanMode: (planMode) => set({ planMode }),
      setResearchMode: (researchMode) => set({ researchMode }),
      setToolsMode: (toolsMode) => set({ toolsMode }),
      setInput: (input) => set({ input }),
      setError: (error) => set({ error }),
      setActivePlan: (activePlan) => set({ activePlan }),
      updateSettings: (patch) => set((state) => ({ settings: { ...state.settings, ...patch } })),
      setEngine: (mode, selection) =>
        set((state) => ({
          settings: { ...state.settings, engines: { ...state.settings.engines, [mode]: selection } }
        })),

      appendMessage: (mode, message) =>
        set((state) => {
          const messages = [...state.threads[mode].messages, message];
          return {
            threads: { ...state.threads, [mode]: { ...state.threads[mode], messages } },
            conversations: syncConversation(state, mode, messages)
          };
        }),
      patchLastAssistant: (mode, delta) =>
        set((state) => {
          const thread = state.threads[mode];
          const messages = [...thread.messages];
          const last = messages.at(-1);
          if (last?.role === "assistant") {
            messages[messages.length - 1] = { ...last, content: last.content + delta };
          }
          return { threads: { ...state.threads, [mode]: { ...thread, messages } } };
        }),
      /** Acumula o raciocínio na mensagem corrente (bloco "Pensando"). */
      patchLastReasoning: (mode, delta) =>
        set((state) => {
          const thread = state.threads[mode];
          const messages = [...thread.messages];
          const last = messages.at(-1);
          if (last?.role === "assistant") {
            messages[messages.length - 1] = {
              ...last,
              meta: { ...last.meta, reasoning: (last.meta?.reasoning ?? "") + delta }
            };
          }
          return { threads: { ...state.threads, [mode]: { ...thread, messages } } };
        }),
      /** Atualiza o grupo de ferramentas da mensagem corrente (cartão Studio). */
      updateToolGroup: (mode, update) =>
        set((state) => {
          const thread = state.threads[mode];
          const messages = [...thread.messages];
          const index = messages.map((m) => m.meta?.kind).lastIndexOf("tools");
          if (index < 0) return {};
          const current = messages[index];
          const tools = update(current.meta?.tools ?? []);
          messages[index] = { ...current, meta: { ...current.meta, kind: "tools", tools } };
          return { threads: { ...state.threads, [mode]: { ...thread, messages } } };
        }),
      replaceLastAssistant: (mode, message) =>
        set((state) => {
          const thread = state.threads[mode];
          const messages = [...thread.messages];
          const last = messages.at(-1);
          if (last?.role === "assistant") messages[messages.length - 1] = message;
          else messages.push(message);
          return {
            threads: { ...state.threads, [mode]: { ...thread, messages } },
            conversations: syncConversation(state, mode, messages)
          };
        }),
      setSending: (mode, sending) =>
        set((state) => {
          const thread = state.threads[mode];
          const patch: Partial<AppState> = {
            threads: { ...state.threads, [mode]: { ...thread, sending } }
          };
          // Ao terminar um envio, consolida a conversa (título + timestamp reais).
          if (!sending && thread.messages.length) {
            patch.conversations = syncConversation(state, mode, thread.messages);
          }
          return patch;
        }),
      clearThread: (mode) =>
        set((state) => ({ threads: { ...state.threads, [mode]: emptyThread() } })),
      newConversation: (mode) =>
        set((state) => ({
          threads: { ...state.threads, [mode]: emptyThread() },
          activeConversation: { ...state.activeConversation, [mode]: newConversationId() }
        })),
      loadConversation: (mode, id) =>
        set((state) => {
          const found = state.conversations[mode]?.find((item) => item.id === id);
          if (!found) return {};
          return {
            threads: { ...state.threads, [mode]: { messages: found.messages, sending: false } },
            activeConversation: { ...state.activeConversation, [mode]: id }
          };
        }),
      deleteConversation: (mode, id) =>
        set((state) => {
          const remaining = (state.conversations[mode] ?? []).filter((item) => item.id !== id);
          const wasActive = state.activeConversation[mode] === id;
          return {
            conversations: { ...state.conversations, [mode]: remaining },
            ...(wasActive
              ? {
                  threads: { ...state.threads, [mode]: emptyThread() },
                  activeConversation: { ...state.activeConversation, [mode]: newConversationId() }
                }
              : {})
          };
        })
    }),
    {
      name: "orchestrator.v2",
      partialize: (state) => ({
        theme: state.theme,
        railOpen: state.railOpen,
        settings: state.settings,
        conversations: state.conversations,
        activeConversation: state.activeConversation
      }),
      // Storage antigo pode não ter campos novos — mescla com defaults e
      // aplica o seed do catálogo (soma novos modelos padrão sem ressuscitar
      // os que o admin removeu depois do seed atual).
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<AppState>;
        const savedCatalog = saved.settings?.modelCatalog ?? [];
        const savedSeed = saved.settings?.catalogSeed ?? 1;
        let modelCatalog = savedCatalog.length ? savedCatalog : current.settings.modelCatalog;
        if (savedCatalog.length && savedSeed < CATALOG_SEED) {
          const known = new Set(savedCatalog.map((entry) => `${entry.providerId}/${entry.model}`));
          modelCatalog = [
            ...savedCatalog,
            ...defaultModelCatalog.filter((entry) => !known.has(`${entry.providerId}/${entry.model}`))
          ];
        }
        // Estruturas por aba de storage antigo (sem "game") ganham as entradas novas.
        const mergedByMode = <T,>(savedMap: Partial<Record<UiMode, T>> | undefined, currentMap: Record<UiMode, T>) => {
          const result = { ...currentMap };
          for (const mode of UI_MODES) {
            const value = savedMap?.[mode];
            if (value !== undefined) result[mode] = value;
          }
          return result;
        };
        // Migrações de presets: renomeia "Tri Merge"→"Fusion" e semeia o
        // "Code Pair" (política custo/inteligência) em perfis antigos.
        let savedPresets = saved.settings?.fusionPresets?.map((preset) =>
          preset.id === "tri-merge" && preset.name === "Tri Merge" ? { ...preset, name: "Fusion" } : preset
        );
        if (savedPresets && !savedPresets.some((preset) => preset.id === "code-pair")) {
          const codePair = defaultFusionPresets.find((preset) => preset.id === "code-pair");
          if (codePair) savedPresets = [...savedPresets, codePair];
        }
        if (saved.settings && savedPresets) saved.settings = { ...saved.settings, fusionPresets: savedPresets };
        // Code no default antigo (workspace) sobe para a política de custo;
        // escolhas customizadas do usuário são respeitadas.
        if (saved.settings?.engines?.code?.kind === "workspace") {
          saved.settings = {
            ...saved.settings,
            engines: { ...saved.settings.engines, code: { kind: "fusion", presetId: "code-pair" } }
          };
        }
        return {
          ...current,
          ...saved,
          threads: mergedByMode(saved.threads, current.threads),
          conversations: mergedByMode(saved.conversations, current.conversations),
          activeConversation: mergedByMode(saved.activeConversation, current.activeConversation),
          settings: {
            ...current.settings,
            ...(saved.settings ?? {}),
            engines: mergedByMode(saved.settings?.engines, current.settings.engines),
            modelCatalog,
            catalogSeed: CATALOG_SEED,
            providerBaseOverrides: saved.settings?.providerBaseOverrides ?? {},
            effort: saved.settings?.effort ?? current.settings.effort,
            // Abas novas (que este perfil nunca viu) entram visíveis; ocultadas
            // pelo usuário permanecem ocultas.
            visibleModes: (() => {
              const saved_visible =
                saved.settings?.visibleModes?.filter((mode) => (UI_MODES as readonly string[]).includes(mode)) ??
                [...UI_MODES];
              const seen = saved.settings?.modesSeen ?? saved_visible;
              const withNew = UI_MODES.filter((mode) => saved_visible.includes(mode) || !seen.includes(mode));
              return withNew.length ? withNew : [...UI_MODES];
            })(),
            modesSeen: [...UI_MODES]
          }
        };
      }
    }
  )
);

export const modeAccent: Record<UiMode, string> = {
  chat: "195",
  code: "36",
  design: "258",
  data: "160",
  work: "214",
  security: "348",
  agent: "312",
  game: "24",
  tune: "96"
};
