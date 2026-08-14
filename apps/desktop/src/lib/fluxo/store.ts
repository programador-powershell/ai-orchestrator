"use client";

/**
 * Estado da aba Fluxo.
 *
 * Store de módulo (não do `useApp`) pelo mesmo motivo da equipe de agentes: a
 * view desmonta a cada troca de aba, e uma montagem em andamento não pode
 * morrer porque alguém foi ver o Chat.
 *
 * A definição em edição vive AQUI, e não dentro do canvas, porque três coisas
 * mexem nela — o arraste do usuário, o painel de detalhes e o stream do
 * assistente. Com o estado dentro do React Flow, a última a escrever ganhava.
 */

import { create } from "zustand";

import { autoLayout, pin } from "./layout";
import { applyOp, clearFresh, type FlowOp } from "./ops";
import { emptyDefinition, type FlowDefinition, type SavedFlow } from "./types";

const STORAGE_KEY = "aio.fluxo.v1";
/** Preferência de tela, separada dos fluxos: some junto se o usuário limpar. */
const ASSISTENTE_KEY = "aio.fluxo.assistente";
/** Teto de fluxos guardados — a lista é para trabalhar, não para arquivar. */
const MAX_FLOWS = 60;

function carregar(): SavedFlow[] {
  if (typeof window === "undefined") return [];
  try {
    const bruto = window.localStorage.getItem(STORAGE_KEY);
    if (!bruto) return [];
    const lido = JSON.parse(bruto) as unknown;
    if (!Array.isArray(lido)) return [];
    return lido.filter((item): item is SavedFlow => {
      const flow = item as Partial<SavedFlow>;
      return Boolean(flow?.id && flow?.name && flow?.definition);
    });
  } catch {
    return [];
  }
}

function guardar(flows: SavedFlow[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(flows.slice(0, MAX_FLOWS)));
  } catch {
    // Storage cheio: o fluxo segue em memória nesta sessão.
  }
}

const novoId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `flow-${Date.now()}`;

function assistenteAberto(): boolean {
  if (typeof window === "undefined") return false;
  // Fechado por padrão: o pedido é que a coluna só apareça quando alguém a
  // chamar. O canvas ocupa a tela inteira até lá.
  return window.localStorage.getItem(ASSISTENTE_KEY) === "1";
}

export interface FluxoState {
  flows: SavedFlow[];
  activeId: string | null;
  /** Definição em edição — sempre a do fluxo ativo. */
  draft: FlowDefinition;
  selectedNode: string | null;
  /** O assistente está montando agora? */
  building: boolean;
  /** Última frase enviada ao assistente, para a UI mostrar o que ele fez. */
  lastPrompt: string;
  note: string;
  /**
   * O que a montagem fez, linha a linha. Vive no store e não no painel porque
   * a coluna do assistente é opcional: abrir depois de montar precisa mostrar
   * o que aconteceu, não uma lista vazia.
   */
  passos: string[];
  erro: string;
  /** Coluna do assistente visível — só quando o usuário pede. */
  assistantOpen: boolean;
  /** Montagem em curso, para o botão Parar alcançar a chamada de fora dela. */
  abort: AbortController | null;

  newFlow: () => void;
  selectFlow: (id: string) => void;
  rename: (id: string, name: string) => void;
  toggle: (id: string) => void;
  remove: (id: string) => void;

  select: (nodeId: string | null) => void;
  setDraft: (definition: FlowDefinition) => void;
  patchNode: (nodeId: string, data: Record<string, unknown>) => void;
  moveNode: (nodeId: string, position: { x: number; y: number }) => void;
  apply: (op: FlowOp) => void;
  beginBuild: (prompt: string) => void;
  endBuild: (note?: string) => void;
  setNote: (note: string) => void;
  pushPasso: (passo: string) => void;
  setErro: (erro: string) => void;
  setAbort: (controller: AbortController | null) => void;
  stopBuild: () => void;
  toggleAssistant: () => void;
  save: () => void;
}

export const useFluxo = create<FluxoState>((set, get) => ({
  flows: carregar(),
  activeId: null,
  draft: emptyDefinition(),
  selectedNode: null,
  building: false,
  lastPrompt: "",
  note: "",
  passos: [],
  erro: "",
  assistantOpen: assistenteAberto(),
  abort: null,

  newFlow: () => {
    const flow: SavedFlow = {
      id: novoId(),
      name: "Novo fluxo",
      enabled: false,
      definition: emptyDefinition(),
      updatedAt: Date.now()
    };
    const flows = [flow, ...get().flows].slice(0, MAX_FLOWS);
    guardar(flows);
    set({ flows, activeId: flow.id, draft: flow.definition, selectedNode: null, note: "" });
  },

  selectFlow: (id) => {
    const flow = get().flows.find((item) => item.id === id);
    if (!flow) return;
    // Troca de fluxo NÃO salva o rascunho por cima: quem edita salva no botão.
    set({ activeId: id, draft: flow.definition, selectedNode: null, note: "" });
  },

  rename: (id, name) => {
    const flows = get().flows.map((flow) => (flow.id === id ? { ...flow, name, updatedAt: Date.now() } : flow));
    guardar(flows);
    set({ flows });
  },

  toggle: (id) => {
    const flows = get().flows.map((flow) => (flow.id === id ? { ...flow, enabled: !flow.enabled } : flow));
    guardar(flows);
    set({ flows });
  },

  remove: (id) => {
    const flows = get().flows.filter((flow) => flow.id !== id);
    guardar(flows);
    const proximo = get().activeId === id ? (flows[0] ?? null) : get().flows.find((f) => f.id === get().activeId);
    set({
      flows,
      activeId: proximo?.id ?? null,
      draft: proximo?.definition ?? emptyDefinition(),
      selectedNode: null
    });
  },

  select: (nodeId) => set({ selectedNode: nodeId }),

  setDraft: (definition) => set({ draft: definition }),

  patchNode: (nodeId, data) =>
    set((state) => ({
      draft: {
        ...state.draft,
        nodes: state.draft.nodes.map((node) =>
          node.id === nodeId ? { ...node, data: { ...node.data, ...data } } : node
        )
      }
    })),

  // Arrastar FIXA o nó: o layout automático passa a respeitar essa posição.
  moveNode: (nodeId, position) => set((state) => ({ draft: pin(state.draft, nodeId, position) })),

  apply: (op) =>
    set((state) => {
      const aplicado = applyOp(state.draft, op);
      if (op.op === "rename" && state.activeId) {
        const flows = state.flows.map((flow) =>
          flow.id === state.activeId ? { ...flow, name: op.name, updatedAt: Date.now() } : flow
        );
        guardar(flows);
        return { draft: aplicado, flows };
      }
      // Reposiciona a cada operação: é isso que faz a montagem "se arrumar"
      // na tela enquanto o modelo escreve, em vez de pular no fim.
      return { draft: autoLayout(aplicado) };
    }),

  beginBuild: (prompt) => set({ building: true, lastPrompt: prompt, note: "", passos: [], erro: "" }),

  endBuild: (note) =>
    set((state) => ({ building: false, draft: clearFresh(state.draft), note: note ?? state.note })),

  setNote: (note) => set({ note }),

  pushPasso: (passo) => set((state) => ({ passos: [...state.passos, passo] })),

  setErro: (erro) => set({ erro }),

  setAbort: (controller) => set({ abort: controller }),

  stopBuild: () => get().abort?.abort(),

  toggleAssistant: () =>
    set((state) => {
      const aberto = !state.assistantOpen;
      try {
        window.localStorage.setItem(ASSISTENTE_KEY, aberto ? "1" : "0");
      } catch {
        // Storage indisponível: a preferência vale só nesta sessão.
      }
      return { assistantOpen: aberto };
    }),

  save: () => {
    const { activeId, draft, flows } = get();
    if (!activeId) return;
    const atualizados = flows.map((flow) =>
      flow.id === activeId ? { ...flow, definition: draft, updatedAt: Date.now() } : flow
    );
    guardar(atualizados);
    set({ flows: atualizados, note: "Fluxo salvo." });
  }
}));
