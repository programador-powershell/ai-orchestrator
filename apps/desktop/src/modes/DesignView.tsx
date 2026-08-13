/**
 * DESIGN — estúdio visual: canvas EDITÁVEL (frames/formas/texto com export
 * SVG/PNG reais), tokens extraídos de HTML/CSS colado (local, sem rede),
 * clonagem de sites via gateway (botão "Site" na toolbar) e editor de vídeo
 * com atalhos reais e export via ffmpeg local (requer o app desktop).
 * Rail lateral (DesignRail) mostra páginas/camadas (canvas) ou mídia/clipes
 * (vídeo); o estado é compartilhado com a view via store zustand de módulo.
 * Sem input próprio de chat: o composer é global.
 */
import "../styles/modes/design.css";
import { useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { create } from "zustand";
import {
  Check,
  ChevronDown,
  ChevronsDown,
  ChevronsUp,
  ChevronUp,
  Circle,
  Clapperboard,
  Download,
  FileText,
  FileVideo,
  Frame,
  Globe2,
  Image as ImageIcon,
  Maximize2,
  MousePointer2,
  Palette,
  Pause,
  Play,
  Plus,
  Ruler,
  Scissors,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  Terminal as TerminalIcon,
  Trash2,
  Type,
  Undo2,
  Wand2,
  ZoomIn,
  ZoomOut
} from "lucide-react";
import type { DesignReplicationResult } from "@ai-orchestrator/contracts";
import { replicateDesign } from "../lib/gateway";
import { terminal } from "../lib/terminal";
import { buildFfmpegExport } from "../lib/videoExport";
import { useApp } from "../lib/store";
import { composerBus } from "../lib/ops";
import {
  addNode,
  boundsOf,
  createDoc,
  createNode,
  DEFAULT_SIZES,
  exportSvg,
  MIN_NODE_SIZE,
  parseDoc,
  removeNode,
  reorder,
  updateNode
} from "../lib/canvasDoc";
import type { CanvasDoc, CanvasNode, CanvasNodeType } from "../lib/canvasDoc";
import { captureSite } from "../lib/siteCapture";
import { STENCILS, buildStencil, type StencilId } from "../lib/stencils";
import { DesignSystemPanel } from "../components/DesignSystemPanel";
import { extractTokens } from "../lib/htmlTokens";
import type { ExtractedTokens } from "../lib/htmlTokens";
import {
  EmptyHero,
  FloatingPulse,
  PanelScroll,
  PanelTitle,
  RowItem,
  Surface,
  VBody,
  VCenter,
  VRight,
  VStatus,
  TopbarActions } from "../components/Primitives";
import { RailConversations } from "../components/RailConversations";

/* ------------------------------ Tipos ------------------------------ */

type StudioTab = "canvas" | "video" | "site";
type SideTab = "inspect" | "tokens" | "system";
type Tool = "select" | CanvasNodeType;

type DragState =
  | { kind: "pan"; originX: number; originY: number; baseX: number; baseY: number }
  | { kind: "move"; id: string; originX: number; originY: number; baseX: number; baseY: number }
  | {
      kind: "resize";
      id: string;
      handle: string;
      originX: number;
      originY: number;
      base: { x: number; y: number; w: number; h: number };
    }
  | { kind: "create"; id: string; type: CanvasNodeType; worldX: number; worldY: number; moved: boolean };

interface MediaItem {
  id: string;
  name: string;
  url: string;
  duration: number;
}

interface TimelineClip {
  id: string;
  mediaId: string;
  name: string;
  /** Entrada/saída em segundos dentro da mídia de origem. */
  start: number;
  end: number;
}

interface FfmpegState {
  status: "idle" | "checking" | "ok" | "missing" | "rendering";
  note: string;
}

/* ----------------------------- Constantes -------------------------- */

const isTauriHost = "__TAURI_INTERNALS__" in window;
const DOC_STORAGE_KEY = "aio.design.canvas.v1";
const HANDLES = ["nw", "ne", "sw", "se"] as const;

const uid = () => Math.random().toString(36).slice(2, 10);

const TOOL_SHORTCUTS: Record<string, Tool> = {
  v: "select",
  f: "frame",
  r: "rect",
  o: "ellipse",
  t: "text"
};

function nodeIcon(type: CanvasNodeType) {
  switch (type) {
    case "frame":
      return <Frame size={13} />;
    case "rect":
      return <Square size={13} />;
    case "ellipse":
      return <Circle size={13} />;
    case "text":
      return <Type size={13} />;
  }
}

function nodeLabel(node: CanvasNode): string {
  if (node.type === "text" || node.type === "frame") return node.text?.trim() || node.id;
  return node.id;
}

function nodeStyle(node: CanvasNode): CSSProperties {
  const base: CSSProperties = { left: node.x, top: node.y, width: node.w, height: node.h };
  if (node.type === "text") return { ...base, color: node.fill, fontSize: node.fontSize ?? 16, lineHeight: 1.25 };
  if (node.type === "ellipse") return { ...base, background: node.fill, borderRadius: "50%" };
  return { ...base, background: node.fill, borderRadius: node.radius ?? 0 };
}

const isHex6 = (value: string) => /^#[0-9a-f]{6}$/i.test(value);

function slugName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "canvas";
}

function loadStoredDoc(): CanvasDoc {
  try {
    const stored = window.localStorage.getItem(DOC_STORAGE_KEY);
    if (stored) {
      const doc = parseDoc(stored);
      if (doc) return doc;
    }
  } catch {
    // storage indisponível → doc inicial mínimo
  }
  return createDoc();
}

function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* --------------------------- Utilitários de vídeo ------------------- */

function formatTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  return `${minutes}:${rest.toFixed(1).padStart(4, "0")}`;
}

const clipLength = (clip: TimelineClip) => clip.end - clip.start;
const totalOf = (clips: TimelineClip[]) => clips.reduce((sum, clip) => sum + clipLength(clip), 0);

function offsetsOf(clips: TimelineClip[]): number[] {
  let acc = 0;
  return clips.map((clip) => {
    const offset = acc;
    acc += clipLength(clip);
    return offset;
  });
}

function tickStep(total: number): number {
  for (const step of [0.5, 1, 2, 5, 10, 15, 30, 60, 120]) {
    if (total / step <= 10) return step;
  }
  return 300;
}

function buildTicks(total: number): number[] {
  if (total <= 0) return [];
  const step = tickStep(total);
  const ticks: number[] = [];
  for (let t = 0; t <= total + 0.001; t += step) ticks.push(Math.round(t * 10) / 10);
  return ticks;
}

/* -------------------- Store do estúdio (rail ⇄ view) ---------------- */

interface DesignStudioState {
  tab: StudioTab;
  doc: CanvasDoc;
  selectedId: string | null;
  sideTab: SideTab;
  repResult: DesignReplicationResult | null;
  pageIndex: number;
  media: MediaItem[];
  clips: TimelineClip[];
  selectedClipId: string | null;
  /** Incrementado a cada remoção de clipe — o player reseta o transporte. */
  playbackEpoch: number;
  setTab: (tab: StudioTab) => void;
  setDoc: (next: CanvasDoc | ((previous: CanvasDoc) => CanvasDoc)) => void;
  /** Seleciona um nó (e abre o Inspect); null limpa a seleção. */
  selectNode: (id: string | null) => void;
  setSideTab: (tab: SideTab) => void;
  deleteNode: (id: string) => void;
  undo: () => void;
  /** Resultado real da clonagem: páginas no rail + tokens na aba Tokens. */
  applyReplication: (result: DesignReplicationResult) => void;
  setPageIndex: (index: number) => void;
  addMediaFile: (file: File) => void;
  addClipFromMedia: (item: MediaItem) => void;
  setClips: (next: TimelineClip[] | ((previous: TimelineClip[]) => TimelineClip[])) => void;
  selectClip: (id: string | null) => void;
  deleteClip: (id: string) => void;
}

/* Histórico de undo fora do React — rail e view compartilham a pilha. */
const undoStack: CanvasDoc[] = [];
let lastPushAt = 0;

function pushHistory() {
  undoStack.push(useDesign.getState().doc);
  if (undoStack.length > 50) undoStack.shift();
  lastPushAt = Date.now();
}

/* ---- Device switcher (Desktop/Tablet/Mobile) — redimensiona o frame ---- */

const DEVICES = [
  { id: "desktop", label: "Desktop", w: 1440, h: 1024 },
  { id: "tablet", label: "Tablet", w: 768, h: 1024 },
  { id: "mobile", label: "Mobile", w: 375, h: 812 }
] as const;

/** Aplica o preset ao frame selecionado (ou 1º frame; cria um se não houver). */
function applyDevice(width: number, height: number) {
  const { doc, selectedId, setDoc, selectNode } = useDesign.getState();
  pushHistory();
  const target =
    doc.nodes.find((node) => node.id === selectedId && node.type === "frame") ??
    doc.nodes.find((node) => node.type === "frame");
  if (target) {
    setDoc((current) => updateNode(current, target.id, { w: width, h: height }));
    selectNode(target.id);
    return;
  }
  const frame = createNode(doc, "frame", { x: 40, y: 40, w: width, h: height });
  setDoc((current) => addNode(current, frame));
  selectNode(frame.id);
}

/** Igual a pushHistory, mas agrupa edições digitadas em sequência. */
function pushHistoryCoalesced() {
  if (Date.now() - lastPushAt < 800) return;
  pushHistory();
}

const useDesign = create<DesignStudioState>((set) => ({
  tab: "canvas",
  doc: loadStoredDoc(),
  selectedId: null,
  sideTab: "inspect",
  repResult: null,
  pageIndex: 0,
  media: [],
  clips: [],
  selectedClipId: null,
  playbackEpoch: 0,
  setTab: (tab) => set({ tab }),
  setDoc: (next) => set((state) => ({ doc: typeof next === "function" ? next(state.doc) : next })),
  selectNode: (id) => set(id ? { selectedId: id, sideTab: "inspect" } : { selectedId: null }),
  setSideTab: (sideTab) => set({ sideTab }),
  deleteNode: (id) => {
    pushHistory();
    set((state) => ({
      doc: removeNode(state.doc, id),
      selectedId: state.selectedId === id ? null : state.selectedId
    }));
  },
  undo: () => {
    const previous = undoStack.pop();
    if (previous) set({ doc: previous, selectedId: null });
  },
  applyReplication: (result) => set({ repResult: result, pageIndex: 0, sideTab: "tokens" }),
  setPageIndex: (pageIndex) => set({ pageIndex }),
  addMediaFile: (file) => {
    const url = URL.createObjectURL(file);
    const id = uid();
    const commit = (duration: number) =>
      set((state) => ({
        media: [...state.media, { id, name: file.name, url, duration }],
        clips: [
          ...state.clips,
          { id: uid(), mediaId: id, name: file.name.replace(/\.[^.]+$/, ""), start: 0, end: duration }
        ]
      }));
    const probe = document.createElement("video");
    probe.preload = "metadata";
    probe.onloadedmetadata = () => {
      commit(Number.isFinite(probe.duration) && probe.duration > 0 ? probe.duration : 10);
      probe.removeAttribute("src");
    };
    probe.onerror = () => commit(10);
    probe.src = url;
  },
  addClipFromMedia: (item) =>
    set((state) => ({
      clips: [
        ...state.clips,
        { id: uid(), mediaId: item.id, name: item.name.replace(/\.[^.]+$/, ""), start: 0, end: item.duration }
      ]
    })),
  setClips: (next) => set((state) => ({ clips: typeof next === "function" ? next(state.clips) : next })),
  selectClip: (selectedClipId) => set({ selectedClipId }),
  deleteClip: (id) =>
    set((state) => ({
      clips: state.clips.filter((clip) => clip.id !== id),
      selectedClipId: state.selectedClipId === id ? null : state.selectedClipId,
      playbackEpoch: state.playbackEpoch + 1
    }))
}));

/* Persistência real do documento (sobrevive a reload), onde quer que a
   edição aconteça — rail ou view. */
useDesign.subscribe((state, previous) => {
  if (state.doc === previous.doc) return;
  try {
    window.localStorage.setItem(DOC_STORAGE_KEY, JSON.stringify(state.doc));
  } catch {
    // storage cheio/indisponível — o doc segue em memória
  }
});

/* Projeto de vídeo: persiste as DECISÕES (mídia por nome + cortes), não os
   blob URLs — eles morrem entre sessões. Ao reabrir, a timeline e o export
   voltam; só o preview pede reimportar o arquivo. Antes nada persistia. */
const VIDEO_STORAGE_KEY = "design.video";
useDesign.subscribe((state, previous) => {
  if (state.media === previous.media && state.clips === previous.clips) return;
  try {
    window.localStorage.setItem(
      VIDEO_STORAGE_KEY,
      JSON.stringify({
        media: state.media.map(({ id, name, duration }) => ({ id, name, duration })),
        clips: state.clips
      })
    );
  } catch {
    // storage indisponível — o projeto segue em memória
  }
});

// Carga inicial do projeto de vídeo (fora do create para não competir com o
// probe de duração do addMediaFile).
try {
  const raw = window.localStorage.getItem(VIDEO_STORAGE_KEY);
  if (raw) {
    const saved = JSON.parse(raw) as { media?: Array<{ id: string; name: string; duration: number }>; clips?: TimelineClip[] };
    if (saved.clips?.length) {
      useDesign.setState({
        media: (saved.media ?? []).map((item) => ({ ...item, url: "" })),
        clips: saved.clips
      });
    }
  }
} catch {
  // projeto corrompido — começa vazio
}

/* -------------------------------- Rail ------------------------------ */

/** Rail dinâmico da aba Design: páginas/camadas (canvas) ou mídia/clipes
 *  (vídeo), mais as sessões persistidas. Mesmo store da view. */
/**
 * Insere um stencil no canvas, em cascata para não empilhar tudo no mesmo
 * ponto — dois cliques seguidos precisam produzir duas peças visíveis.
 */
function insertStencil(id: StencilId) {
  const state = useDesign.getState();
  const existentes = state.doc.nodes.length;
  const x = 60 + (existentes % 6) * 24;
  const y = 60 + (existentes % 6) * 24;
  const seed = `st${Date.now().toString(36)}`;
  const novos = buildStencil(id, x, y, seed);
  state.setDoc((current) => ({ ...current, nodes: [...current.nodes, ...novos] }));
  // Seleciona o primeiro nó — o usuário quer mexer no que acabou de inserir.
  if (novos[0]) state.selectNode(novos[0].id);
}

export function DesignRail() {
  const tab = useDesign((state) => state.tab);
  const doc = useDesign((state) => state.doc);
  const selectedId = useDesign((state) => state.selectedId);
  const selectNode = useDesign((state) => state.selectNode);
  const deleteNode = useDesign((state) => state.deleteNode);
  const repResult = useDesign((state) => state.repResult);
  const pageIndex = useDesign((state) => state.pageIndex);
  const setPageIndex = useDesign((state) => state.setPageIndex);
  const media = useDesign((state) => state.media);
  const clips = useDesign((state) => state.clips);
  const selectedClipId = useDesign((state) => state.selectedClipId);
  const selectClip = useDesign((state) => state.selectClip);
  const deleteClip = useDesign((state) => state.deleteClip);
  const addMediaFile = useDesign((state) => state.addMediaFile);
  const addClipFromMedia = useDesign((state) => state.addClipFromMedia);
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <>
      {tab === "canvas" && (
        <>
          <span className="eyebrow">STENCILS</span>
          {/* Um botão não é "retângulo + texto que você alinha na mão": é um
              item que nasce pronto e sempre igual. É isso que torna a
              prototipagem repetível. */}
          {["Formulário", "Layout", "Fluxograma"].map((grupo) => (
            <div className="desx-stencil-group" key={grupo}>
              <small>{grupo}</small>
              <div className="desx-stencils">
                {STENCILS.filter((spec) => spec.group === grupo).map((spec) => (
                  <button
                    key={spec.id}
                    className="desx-stencil"
                    title={`Inserir ${spec.label} (${spec.w}×${spec.h})`}
                    onClick={() => insertStencil(spec.id)}
                  >
                    {spec.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </>
      )}
      {tab !== "video" ? (
        <>
          {repResult && (
            <>
              <span className="eyebrow">PÁGINAS · {repResult.pages.length}</span>
              <div className="desx-rail-group">
                {repResult.pages.map((page, index) => (
                  <RowItem
                    key={page.path}
                    icon={<FileText size={13} />}
                    label={page.title}
                    meta={page.path}
                    active={index === pageIndex}
                    onClick={() => setPageIndex(index)}
                  />
                ))}
              </div>
            </>
          )}
          <span className="eyebrow">CAMADAS · {doc.nodes.length}</span>
          <div className="desx-rail-group">
            {!doc.nodes.length && (
              <span className="rail-empty">
                Canvas vazio — escolha uma ferramenta (F frame · R retângulo · O elipse · T texto) e arraste no canvas.
              </span>
            )}
            {[...doc.nodes].reverse().map((node) => (
              <RowItem
                key={node.id}
                icon={nodeIcon(node.type)}
                label={nodeLabel(node)}
                meta={node.type}
                active={selectedId === node.id}
                onClick={() => selectNode(node.id)}
                trailing={
                  <span
                    className="desx-x"
                    role="button"
                    aria-label={`Excluir ${nodeLabel(node)}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      deleteNode(node.id);
                    }}
                  >
                    <Trash2 size={12} />
                  </span>
                }
              />
            ))}
          </div>
        </>
      ) : (
        <>
          <span className="eyebrow">MÍDIA · {media.length}</span>
          <div className="desx-rail-group">
            <button className="lg-button" onClick={() => fileRef.current?.click()}>
              <Plus size={13} />
              Adicionar vídeo
            </button>
            <input
              ref={fileRef}
              className="desx-hidden"
              type="file"
              accept="video/*"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) addMediaFile(file);
                event.target.value = "";
              }}
              aria-label="Selecionar arquivo de vídeo"
            />
            {!media.length && (
              <span className="rail-empty">Importe um vídeo local; clique numa mídia para adicioná-la como clipe.</span>
            )}
            {media.map((item) => (
              <RowItem
                key={item.id}
                icon={<FileVideo size={13} />}
                label={item.name}
                meta={formatTime(item.duration)}
                onClick={() => addClipFromMedia(item)}
              />
            ))}
          </div>
          <span className="eyebrow">CLIPES · {clips.length}</span>
          <div className="desx-rail-group">
            {!clips.length && <span className="rail-empty">Nenhum clipe na timeline ainda.</span>}
            {clips.map((clip) => (
              <RowItem
                key={clip.id}
                icon={<Clapperboard size={13} />}
                label={clip.name}
                meta={formatTime(clipLength(clip))}
                active={selectedClipId === clip.id}
                onClick={() => selectClip(clip.id)}
                trailing={
                  <span
                    className="desx-x"
                    role="button"
                    aria-label={`Excluir clipe ${clip.name}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      deleteClip(clip.id);
                    }}
                  >
                    <Trash2 size={12} />
                  </span>
                }
              />
            ))}
          </div>
        </>
      )}
      <span className="eyebrow">SESSÕES</span>
      <RailConversations mode="design" />
    </>
  );
}

/* -------------------------------- View ----------------------------- */

export function DesignView() {
  const sending = useApp((state) => state.threads.design.sending);
  const stage = useApp((state) => state.stage);
  const session = useApp((state) => state.session);

  const tab = useDesign((state) => state.tab);
  const setTab = useDesign((state) => state.setTab);

  /* ------------------------- Canvas editável ------------------------ */
  const doc = useDesign((state) => state.doc);
  const setDoc = useDesign((state) => state.setDoc);
  const selectedId = useDesign((state) => state.selectedId);
  const selectNode = useDesign((state) => state.selectNode);
  const sideTab = useDesign((state) => state.sideTab);
  const setSideTab = useDesign((state) => state.setSideTab);
  const deleteNode = useDesign((state) => state.deleteNode);
  const undo = useDesign((state) => state.undo);

  const [tool, setTool] = useState<Tool>("select");
  const [view, setView] = useState({ x: 0, y: 0, zoom: 1 });
  const [panning, setPanning] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [canvasNote, setCanvasNote] = useState("");

  const dragRef = useRef<DragState | null>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const noteTimerRef = useRef(0);

  function flashNote(text: string) {
    setCanvasNote(text);
    window.clearTimeout(noteTimerRef.current);
    noteTimerRef.current = window.setTimeout(() => setCanvasNote(""), 2400);
  }

  function patchSelected(patch: Partial<Omit<CanvasNode, "id" | "type">>) {
    if (!selectedId) return;
    pushHistoryCoalesced();
    setDoc((previous) => updateNode(previous, selectedId, patch));
  }

  function reorderSelected(to: number) {
    if (!selectedId) return;
    pushHistory();
    setDoc((previous) => reorder(previous, selectedId, to));
  }

  const selectedNode = doc.nodes.find((node) => node.id === selectedId) ?? null;
  const selectedIndex = selectedId ? doc.nodes.findIndex((node) => node.id === selectedId) : -1;

  /* -------------------- Ponteiro: criar/mover/redimensionar ---------- */

  function toWorld(clientX: number, clientY: number) {
    const el = worldRef.current;
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    return { x: (clientX - rect.left) / view.zoom, y: (clientY - rect.top) / view.zoom };
  }

  function onCanvasPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, input, textarea")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);

    if (tool === "select") {
      const handleEl = target.closest<HTMLElement>("[data-handle]");
      if (handleEl && selectedNode) {
        pushHistory();
        dragRef.current = {
          kind: "resize",
          id: selectedNode.id,
          handle: handleEl.dataset.handle ?? "se",
          originX: event.clientX,
          originY: event.clientY,
          base: { x: selectedNode.x, y: selectedNode.y, w: selectedNode.w, h: selectedNode.h }
        };
        return;
      }
      const nodeEl = target.closest<HTMLElement>("[data-node-id]");
      if (nodeEl) {
        const id = nodeEl.dataset.nodeId ?? "";
        const node = doc.nodes.find((entry) => entry.id === id);
        selectNode(id);
        if (node) {
          pushHistory();
          dragRef.current = {
            kind: "move",
            id,
            originX: event.clientX,
            originY: event.clientY,
            baseX: node.x,
            baseY: node.y
          };
        }
        return;
      }
      selectNode(null);
      dragRef.current = { kind: "pan", originX: event.clientX, originY: event.clientY, baseX: view.x, baseY: view.y };
      setPanning(true);
      return;
    }

    /* Ferramenta de forma: clique-arraste cria o nó de verdade. */
    const point = toWorld(event.clientX, event.clientY);
    pushHistory();
    const node = createNode(doc, tool, { x: point.x, y: point.y, w: MIN_NODE_SIZE, h: MIN_NODE_SIZE });
    setDoc((previous) => addNode(previous, { ...node, x: point.x, y: point.y }));
    selectNode(node.id);
    dragRef.current = { kind: "create", id: node.id, type: tool, worldX: point.x, worldY: point.y, moved: false };
  }

  function onCanvasPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.kind === "pan") {
      setView((previous) => ({
        ...previous,
        x: drag.baseX + event.clientX - drag.originX,
        y: drag.baseY + event.clientY - drag.originY
      }));
      return;
    }
    if (drag.kind === "move") {
      const dx = (event.clientX - drag.originX) / view.zoom;
      const dy = (event.clientY - drag.originY) / view.zoom;
      setDoc((previous) => updateNode(previous, drag.id, { x: drag.baseX + dx, y: drag.baseY + dy }));
    } else if (drag.kind === "resize") {
      const dx = (event.clientX - drag.originX) / view.zoom;
      const dy = (event.clientY - drag.originY) / view.zoom;
      const b = drag.base;
      const patch: Partial<Pick<CanvasNode, "x" | "y" | "w" | "h">> = {};
      if (drag.handle.includes("e")) patch.w = b.w + dx;
      if (drag.handle.includes("s")) patch.h = b.h + dy;
      if (drag.handle.includes("w")) {
        patch.x = b.x + Math.min(dx, b.w - MIN_NODE_SIZE);
        patch.w = b.w - dx;
      }
      if (drag.handle.includes("n")) {
        patch.y = b.y + Math.min(dy, b.h - MIN_NODE_SIZE);
        patch.h = b.h - dy;
      }
      setDoc((previous) => updateNode(previous, drag.id, patch));
    } else {
      const point = toWorld(event.clientX, event.clientY);
      const x = Math.min(drag.worldX, point.x);
      const y = Math.min(drag.worldY, point.y);
      const w = Math.abs(point.x - drag.worldX);
      const h = Math.abs(point.y - drag.worldY);
      if (w > 3 || h > 3) drag.moved = true;
      setDoc((previous) => updateNode(previous, drag.id, { x, y, w, h }));
    }
  }

  function onCanvasPointerUp() {
    const drag = dragRef.current;
    dragRef.current = null;
    setPanning(false);
    setDragging(false);
    if (drag?.kind === "create") {
      if (!drag.moved) {
        const size = DEFAULT_SIZES[drag.type];
        setDoc((previous) => updateNode(previous, drag.id, { w: size.w, h: size.h }));
      }
      setTool("select");
      setSideTab("inspect");
    }
  }

  function zoomBy(delta: number) {
    setView((previous) => ({
      ...previous,
      zoom: Math.min(2, Math.max(0.25, Math.round((previous.zoom + delta) * 100) / 100))
    }));
  }

  /* Atalhos do canvas: V/F/R/O/T, Delete, Ctrl+Z, Esc. */
  useEffect(() => {
    if (tab !== "canvas") return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable=true]")) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        undo();
        return;
      }
      if ((event.key === "Delete" || event.key === "Backspace") && selectedId) {
        event.preventDefault();
        deleteNode(selectedId);
        return;
      }
      if (event.key === "Escape") {
        setTool("select");
        selectNode(null);
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const next = TOOL_SHORTCUTS[event.key.toLowerCase()];
      if (next) setTool(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, selectedId]);

  /* --------------------------- Export SVG/PNG ------------------------ */

  function handleExportSvg() {
    downloadBlob(`${slugName(doc.name)}.svg`, new Blob([exportSvg(doc)], { type: "image/svg+xml;charset=utf-8" }));
    flashNote("SVG exportado");
  }

  function handleExportPng() {
    const b = boundsOf(doc);
    const svg = exportSvg(doc);
    const image = new Image();
    image.onload = () => {
      const scale = 2;
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(b.w * scale));
      canvas.height = Math.max(1, Math.round(b.h * scale));
      const context = canvas.getContext("2d");
      if (!context) {
        flashNote("Canvas 2D indisponível");
        return;
      }
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => {
        if (blob) {
          downloadBlob(`${slugName(doc.name)}@2x.png`, blob);
          flashNote("PNG exportado (2x)");
        } else {
          flashNote("Falha ao gerar o PNG");
        }
      }, "image/png");
    };
    image.onerror = () => flashNote("Falha ao rasterizar o SVG");
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }

  /* ------------------ Tokens: extração local de HTML/CSS ------------- */

  const [pasteSource, setPasteSource] = useState("");
  const [extracted, setExtracted] = useState<ExtractedTokens | null>(null);
  const [copiedValue, setCopiedValue] = useState<string | null>(null);
  const copyTimerRef = useRef(0);

  function handleExtract() {
    setExtracted(extractTokens(pasteSource));
  }

  async function copySwatch(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedValue(value);
    } catch {
      setCopiedValue(null);
    }
    window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopiedValue(null), 1800);
  }

  /* ------------- Clonar site (botão "Site" — só gateway) ------------- */

  const repResult = useDesign((state) => state.repResult);
  const applyReplication = useDesign((state) => state.applyReplication);
  const [repUrl, setRepUrl] = useState("");
  const [replicating, setReplicating] = useState(false);
  const [repNote, setRepNote] = useState("");

  /**
   * "Editar": transforma o design clonado em elementos EDITÁVEIS no canvas —
   * um frame por página (com título), paleta de cores real e tipografia,
   * tudo como nós normais (mover, redimensionar, recolorir) — e troca para
   * a aba Canvas para edição direta.
   */
  function importReplicationToCanvas(result: DesignReplicationResult) {
    pushHistory();
    const state = useDesign.getState();
    let next = state.doc;
    const offsetX = next.nodes.reduce((max, node) => Math.max(max, node.x + node.w), 0) + 80;
    let firstFrameId = "";
    result.pages.slice(0, 3).forEach((page, index) => {
      const frame = createNode(next, "frame", { x: offsetX + index * 1520, y: 40, w: 1440, h: 1024 });
      next = updateNode(addNode(next, frame), frame.id, { text: page.title || page.path });
      if (!index) firstFrameId = frame.id;
      const title = createNode(next, "text", { x: offsetX + index * 1520 + 64, y: 120, w: 900, h: 64 });
      next = updateNode(addNode(next, title), title.id, { text: page.title || result.title, fontSize: 40 });
    });
    result.tokens.colors.slice(0, 8).forEach((color, index) => {
      const swatch = createNode(next, "rect", { x: offsetX + 64 + index * 132, y: 240, w: 112, h: 112 });
      next = updateNode(addNode(next, swatch), swatch.id, { fill: color, radius: 18 });
    });
    result.tokens.fonts.slice(0, 4).forEach((font, index) => {
      const sample = createNode(next, "text", { x: offsetX + 64, y: 410 + index * 72, w: 1000, h: 56 });
      next = updateNode(addNode(next, sample), sample.id, { text: `Aa — ${font}`, fontSize: 28 });
    });
    state.setDoc(() => next);
    if (firstFrameId) state.selectNode(firstFrameId);
    state.setTab("canvas");
  }

  const [capturing, setCapturing] = useState(false);

  /**
   * Clona o LAYOUT REAL: busca o HTML pelo Rust (anti-SSRF + blocklist),
   * renderiza num iframe sem script e lê a geometria que o navegador calculou.
   *
   * Diferente do "só tokens": ali saía paleta e fonte; aqui saem os elementos
   * nas posições em que aparecem de verdade, prontos para editar.
   */
  async function handleCaptureLayout() {
    const sourceUrl = repUrl.trim();
    if (!sourceUrl || capturing) return;
    setCapturing(true);
    setRepNote("");
    try {
      const capture = await captureSite(sourceUrl);
      if (!capture.doc.nodes.length) {
        setRepNote("nada visível foi capturado — a página pode montar a tela por JavaScript");
        return;
      }
      pushHistory();
      const state = useDesign.getState();
      // Entra ao lado do que já existe, para não sobrescrever o trabalho atual.
      const offsetX = state.doc.nodes.reduce((max, node) => Math.max(max, node.x + node.w), 0) + 80;
      const deslocados = capture.doc.nodes.map((node) => ({
        ...node,
        id: `cap-${node.id}`,
        x: node.x + offsetX
      }));
      state.setDoc((current) => ({ ...current, nodes: [...current.nodes, ...deslocados] }));
      state.setTab("canvas");
      flashNote(
        `Layout clonado: ${deslocados.length} elemento(s)` +
          (capture.dropped > 0 ? ` · ${capture.dropped} ignorado(s) (invisível ou minúsculo)` : "")
      );
    } catch (cause) {
      setRepNote(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCapturing(false);
    }
  }

  async function handleReplicate() {
    const sourceUrl = repUrl.trim();
    if (!sourceUrl || replicating || !session) return;
    setReplicating(true);
    setRepNote("");
    try {
      const result = await replicateDesign(session, { sourceUrl, mode: "static", maxPages: 8 });
      applyReplication(result);
      importReplicationToCanvas(result);
      flashNote(`Clonado para o canvas: ${result.title} · ${result.pages.length} pág. · ${result.tokens.colors.length} cores`);
    } catch (cause) {
      setRepNote(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setReplicating(false);
    }
  }

  /* ------------------------------ Vídeo ----------------------------- */
  const media = useDesign((state) => state.media);
  const clips = useDesign((state) => state.clips);
  const setClips = useDesign((state) => state.setClips);
  const selectedClipId = useDesign((state) => state.selectedClipId);
  const selectClip = useDesign((state) => state.selectClip);
  const deleteClip = useDesign((state) => state.deleteClip);
  const playbackEpoch = useDesign((state) => state.playbackEpoch);
  const [playing, setPlaying] = useState(false);
  const [ffmpeg, setFfmpeg] = useState<FfmpegState>({ status: "idle", note: "" });
  const [mediaFolder, setMediaFolder] = useState(() => window.localStorage.getItem("design.mediaFolder") ?? "");
  const [outputName, setOutputName] = useState("corte-final.mp4");
  const [withAudio, setWithAudio] = useState(true);
  const exportTimerRef = useRef(0);

  const fileRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const scrubRef = useRef<HTMLInputElement>(null);
  const activeIndexRef = useRef(0);
  const tlTimeRef = useRef(0);
  const clipsRef = useRef<TimelineClip[]>([]);
  const mediaRef = useRef<MediaItem[]>([]);
  const playingRef = useRef(false);

  useEffect(() => {
    clipsRef.current = clips;
  }, [clips]);
  useEffect(() => {
    mediaRef.current = media;
  }, [media]);
  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);

  /* Clipe removido (view ou rail): pausa e reseta o transporte.
     As object URLs vivem no store de módulo — não são revogadas aqui. */
  useEffect(() => {
    if (!playbackEpoch) return;
    activeIndexRef.current = 0;
    tlTimeRef.current = 0;
    videoRef.current?.pause();
    setPlaying(false);
  }, [playbackEpoch]);

  /* Limpeza: timers locais ao desmontar. */
  useEffect(
    () => () => {
      window.clearTimeout(copyTimerRef.current);
      window.clearTimeout(exportTimerRef.current);
      window.clearTimeout(noteTimerRef.current);
    },
    []
  );

  function paintTransport(time: number, total: number) {
    const fraction = total > 0 ? Math.min(1, time / total) : 0;
    if (playheadRef.current) playheadRef.current.style.left = `${fraction * 100}%`;
    if (timeRef.current) timeRef.current.textContent = `${formatTime(time)} / ${formatTime(total)}`;
    if (scrubRef.current && document.activeElement !== scrubRef.current) {
      scrubRef.current.value = String(Math.round(fraction * 1000));
    }
  }

  function loadClip(index: number, innerTime: number, autoplay: boolean) {
    const list = clipsRef.current;
    const clip = list[index];
    const video = videoRef.current;
    if (!clip || !video) return;
    const source = mediaRef.current.find((item) => item.id === clip.mediaId);
    if (!source) return;
    activeIndexRef.current = index;
    const apply = () => {
      video.currentTime = clip.start + innerTime;
      if (autoplay) void video.play().catch(() => undefined);
    };
    if (video.src === source.url && video.readyState >= 1) {
      apply();
    } else {
      video.src = source.url;
      video.addEventListener("loadedmetadata", apply, { once: true });
      video.load();
    }
  }

  function seekTimeline(time: number) {
    const list = clipsRef.current;
    if (!list.length) return;
    const total = totalOf(list);
    const clamped = Math.max(0, Math.min(time, Math.max(0, total - 0.01)));
    const offsets = offsetsOf(list);
    let index = list.length - 1;
    for (let i = 0; i < list.length; i += 1) {
      if (clamped < offsets[i] + clipLength(list[i])) {
        index = i;
        break;
      }
    }
    tlTimeRef.current = clamped;
    loadClip(index, clamped - offsets[index], playingRef.current);
    paintTransport(clamped, total);
  }

  function togglePlay() {
    const video = videoRef.current;
    const list = clipsRef.current;
    if (!video || !list.length) return;
    if (playingRef.current) {
      video.pause();
      setPlaying(false);
      return;
    }
    const total = totalOf(list);
    if (tlTimeRef.current >= total - 0.05) loadClip(0, 0, true);
    else if (!video.src) loadClip(activeIndexRef.current, 0, true);
    else void video.play().catch(() => undefined);
    setPlaying(true);
  }

  function handleEnded() {
    const list = clipsRef.current;
    const index = activeIndexRef.current;
    if (index + 1 < list.length) {
      loadClip(index + 1, 0, true);
    } else {
      setPlaying(false);
      tlTimeRef.current = totalOf(list);
      paintTransport(tlTimeRef.current, totalOf(list));
    }
  }

  /* Playhead sincronizado ao currentTime via requestAnimationFrame. */
  useEffect(() => {
    if (tab !== "video") return;
    let raf = 0;
    const step = () => {
      const video = videoRef.current;
      const list = clipsRef.current;
      if (video && list.length) {
        const total = totalOf(list);
        const offsets = offsetsOf(list);
        const index = Math.min(activeIndexRef.current, list.length - 1);
        const clip = list[index];
        let time = offsets[index] + Math.max(0, video.currentTime - clip.start);
        if (!video.paused && video.currentTime >= clip.end - 0.05) {
          if (index + 1 < list.length) {
            loadClip(index + 1, 0, true);
            time = offsets[index] + clipLength(clip);
          } else {
            video.pause();
            setPlaying(false);
            time = total;
          }
        }
        tlTimeRef.current = Math.min(time, total);
        paintTransport(tlTimeRef.current, total);
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  /* Carrega o primeiro clipe no player assim que existir. */
  useEffect(() => {
    const video = videoRef.current;
    if (tab === "video" && video && !video.src && clips.length) loadClip(0, 0, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, clips]);

  /* Atalhos reais do editor: espaço play/pause, setas ±1s. */
  useEffect(() => {
    if (tab !== "video") return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable=true]")) return;
      if (event.code === "Space") {
        event.preventDefault();
        togglePlay();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        seekTimeline(tlTimeRef.current - 1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        seekTimeline(tlTimeRef.current + 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  function splitAtPlayhead() {
    const time = tlTimeRef.current;
    setClips((previous) => {
      const offsets = offsetsOf(previous);
      for (let i = 0; i < previous.length; i += 1) {
        const clip = previous[i];
        const inner = time - offsets[i];
        if (inner > 0.15 && inner < clipLength(clip) - 0.15) {
          const cut = clip.start + inner;
          const left: TimelineClip = { ...clip, end: cut, name: `${clip.name} · A` };
          const right: TimelineClip = { ...clip, id: uid(), start: cut, name: `${clip.name} · B` };
          return [...previous.slice(0, i), left, right, ...previous.slice(i + 1)];
        }
      }
      return previous;
    });
  }

  function onRulerPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    seekTimeline(fraction * totalOf(clipsRef.current));
  }

  /* ---------------------------- ffmpeg local ------------------------- */

  async function detectFfmpeg() {
    if (!isTauriHost) {
      setFfmpeg({
        status: "missing",
        note: "A detecção real do ffmpeg requer o app desktop (Tauri). No navegador não há acesso ao terminal."
      });
      return;
    }
    setFfmpeg({ status: "checking", note: "" });
    try {
      const result = await terminal.execute("ffmpeg -version");
      const firstLine = (result.stdout || result.stderr).split("\n")[0]?.trim() ?? "";
      if (result.exitCode === 0 && firstLine) setFfmpeg({ status: "ok", note: firstLine });
      else setFfmpeg({ status: "missing", note: firstLine || "ffmpeg não encontrado no PATH." });
    } catch (cause) {
      setFfmpeg({ status: "missing", note: cause instanceof Error ? cause.message : String(cause) });
    }
  }

  /**
   * Renderiza o corte DE VERDADE: monta o comando (puro/validado) e roda o
   * ffmpeg com o cwd na pasta da mídia — os nomes dos arquivos resolvem ali e
   * o arquivo de saída é gravado na mesma pasta. Antes isto só copiava o texto.
   */
  async function runExport() {
    const plan = buildFfmpegExport(clipsRef.current, mediaRef.current, {
      output: outputName.trim() || "corte-final.mp4",
      withAudio
    });
    if (!plan.ok) {
      setFfmpeg((previous) => ({ ...previous, note: plan.reason ?? "não foi possível montar o export" }));
      return;
    }
    if (!isTauriHost) {
      // No navegador não há terminal; entrega o comando para rodar à mão.
      await navigator.clipboard.writeText(plan.command).catch(() => undefined);
      setFfmpeg((previous) => ({ ...previous, note: "Sem app desktop: comando copiado para você rodar na máquina." }));
      return;
    }
    const folder = mediaFolder.trim();
    if (!folder) {
      setFfmpeg((previous) => ({ ...previous, note: "Informe a pasta onde estão os vídeos importados." }));
      return;
    }
    setFfmpeg({ status: "rendering", note: `Renderizando ${plan.output}…` });
    try {
      const result = await terminal.execute(plan.command, folder);
      if ((result.exitCode ?? 0) === 0) {
        setFfmpeg({ status: "ok", note: `Pronto: ${plan.output} gravado em ${folder}` });
      } else {
        setFfmpeg({ status: "ok", note: `ffmpeg falhou (código ${result.exitCode}): ${(result.stderr || result.stdout).slice(-600)}` });
      }
    } catch (cause) {
      setFfmpeg({ status: "ok", note: cause instanceof Error ? cause.message : String(cause) });
    }
  }

  /* ------------------------------ Render ----------------------------- */

  const totalDuration = totalOf(clips);
  const ticks = buildTicks(totalDuration);
  const selectedClip = clips.find((clip) => clip.id === selectedClipId) ?? null;
  const selectedClipMedia = selectedClip
    ? media.find((item) => item.id === selectedClip.mediaId) ?? null
    : null;

  return (
    <Surface className="desx-studio">
      <TopbarActions>
        {tab === "site" && (
          <>
            <label className="desx-url-top" title={session ? "URL do site para clonar" : "Requer gateway conectado"}>
              <Globe2 size={13} />
              <input
                autoFocus
                value={repUrl}
                onChange={(event) => setRepUrl(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void handleReplicate();
                }}
                placeholder="https://site-para-clonar.com"
                aria-label="URL do site para clonar"
                disabled={!session}
              />
            </label>
            {/* Reconstrói o LAYOUT de verdade: renderiza a página e lê a
                geometria do motor do navegador. Não depende do gateway. */}
            <button
              className="desx-editar"
              disabled={capturing || !repUrl.trim()}
              title="Reconstrói o layout real da página em nós editáveis do canvas"
              onClick={() => void handleCaptureLayout()}
            >
              <Wand2 size={13} />
              {capturing ? "Capturando…" : "Clonar layout"}
            </button>
            <button
              className="lg-button"
              disabled={replicating || !repUrl.trim() || !session}
              title={session ? "Só a paleta e as fontes, pelo gateway" : "Requer gateway conectado"}
              onClick={() => void handleReplicate()}
            >
              {replicating ? "Extraindo…" : "Só tokens"}
            </button>
            {repNote && <span className="chip danger">{repNote.slice(0, 60)}</span>}
          </>
        )}
        <div className="segmented">
          <button className={tab === "canvas" ? "active" : ""} onClick={() => setTab("canvas")}>
            <Frame size={12} />
            Canvas
          </button>
          <button className={tab === "video" ? "active" : ""} onClick={() => setTab("video")}>
            <Clapperboard size={12} />
            Vídeo
          </button>
          <button className={tab === "site" ? "active" : ""} onClick={() => setTab("site")}>
            <Globe2 size={12} />
            Site
          </button>
        </div>
        {tab === "canvas" ? (
          <>
            <div className="segmented desx-tools" role="toolbar" aria-label="Ferramentas do canvas">
              <button
                className={tool === "select" ? "active" : ""}
                title="Selecionar (V)"
                aria-label="Selecionar (V)"
                onClick={() => setTool("select")}
              >
                <MousePointer2 size={12} />
              </button>
              <button
                className={tool === "frame" ? "active" : ""}
                title="Frame (F)"
                aria-label="Frame (F)"
                onClick={() => setTool("frame")}
              >
                <Frame size={12} />
              </button>
              <button
                className={tool === "rect" ? "active" : ""}
                title="Retângulo (R)"
                aria-label="Retângulo (R)"
                onClick={() => setTool("rect")}
              >
                <Square size={12} />
              </button>
              <button
                className={tool === "ellipse" ? "active" : ""}
                title="Elipse (O)"
                aria-label="Elipse (O)"
                onClick={() => setTool("ellipse")}
              >
                <Circle size={12} />
              </button>
              <button
                className={tool === "text" ? "active" : ""}
                title="Texto (T)"
                aria-label="Texto (T)"
                onClick={() => setTool("text")}
              >
                <Type size={12} />
              </button>
            </div>
            <div className="segmented" role="toolbar" aria-label="Tamanho do frame por dispositivo">
              {DEVICES.map((device) => {
                const selectedFrame =
                  doc.nodes.find((node) => node.id === selectedId && node.type === "frame") ??
                  doc.nodes.find((node) => node.type === "frame");
                const active = selectedFrame ? selectedFrame.w === device.w && selectedFrame.h === device.h : false;
                return (
                  <button
                    key={device.id}
                    className={active ? "active" : ""}
                    title={`${device.label} · ${device.w}×${device.h}`}
                    onClick={() => applyDevice(device.w, device.h)}
                  >
                    {device.label}
                  </button>
                );
              })}
            </div>
            <button className="icon-button" onClick={undo} title="Desfazer (Ctrl+Z)" aria-label="Desfazer">
              <Undo2 size={14} />
            </button>
            <button className="lg-button" disabled={!doc.nodes.length} onClick={handleExportSvg}>
              <Download size={13} />
              SVG
            </button>
            <button className="lg-button" disabled={!doc.nodes.length} onClick={handleExportPng}>
              <ImageIcon size={13} />
              PNG
            </button>
            {canvasNote && <span className="chip accent desx-note">{canvasNote}</span>}
          </>
        ) : tab === "site" ? (
          repResult && (
            <span className="chip accent" title={repResult.sourceUrl}>
              {repResult.title} · {repResult.pages.length} pág. · {repResult.tokens.colors.length} cores
            </span>
          )
        ) : (
          <>
            <span className="chip">{formatTime(totalDuration)} total</span>
            <button className="lg-button" onClick={() => fileRef.current?.click()}>
              <Plus size={13} />
              Adicionar vídeo
            </button>
            <input
              ref={fileRef}
              className="desx-hidden"
              type="file"
              accept="video/*"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) useDesign.getState().addMediaFile(file);
                event.target.value = "";
              }}
              aria-label="Selecionar arquivo de vídeo"
            />
          </>
        )}
      </TopbarActions>

      <VBody>
        <VCenter>
          {sending && <FloatingPulse label={stage || "Processando"} detail="O motor está trabalhando na sua instrução" />}
          {tab === "site" ? (
            <EmptyHero
              icon={<Globe2 size={26} />}
              kicker="CLONAR SITE"
              title="Copie o design inteiro. Edite direto."
              detail={
                session
                  ? "Digite a URL na barra superior e clique em Editar: páginas, cores e tipografia do site viram elementos editáveis no canvas."
                  : "Requer gateway conectado (Configurações → Conexão). Sem gateway não há clonagem — nada é simulado."
              }
            >
              {repResult && (
                <span className="chip accent" title={repResult.sourceUrl}>
                  último clone: {repResult.title} · {repResult.pages.length} pág. · {repResult.tokens.colors.length} cores
                </span>
              )}
            </EmptyHero>
          ) : tab === "canvas" ? (
            <div
              className={`infinite-canvas desx-canvas ${panning ? "desx-grabbing" : ""} ${
                tool !== "select" ? "desx-draw" : ""
              }`}
              onPointerDown={onCanvasPointerDown}
              onPointerMove={onCanvasPointerMove}
              onPointerUp={onCanvasPointerUp}
              onPointerCancel={onCanvasPointerUp}
            >
              <div className="canvas-dots" />
              <div className="desx-stage">
                <div
                  className={`desx-pan ${dragging ? "desx-dragging" : ""}`}
                  style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}
                >
                  <div className="desx-world" ref={worldRef}>
                    {doc.nodes.map((node) => (
                      <div
                        key={node.id}
                        data-node-id={node.id}
                        className={`desx-node desx-node-${node.type} ${selectedId === node.id ? "desx-sel" : ""}`}
                        style={nodeStyle(node)}
                      >
                        {node.type === "frame" && <span className="desx-node-tag">{nodeLabel(node)}</span>}
                        {node.type === "text" ? node.text ?? "" : null}
                        {selectedId === node.id &&
                          tool === "select" &&
                          HANDLES.map((handle) => (
                            <i
                              key={handle}
                              data-handle={handle}
                              className={`desx-handle desx-h-${handle}`}
                              style={{ transform: `scale(${1 / view.zoom})` }}
                            />
                          ))}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              {replicating && (
                <div className="desx-scan" aria-hidden="true">
                  <i />
                  <span>Clonando site…</span>
                </div>
              )}
              <div className="canvas-controls">
                <button onClick={() => zoomBy(-0.25)} aria-label="Reduzir zoom">
                  <ZoomOut size={14} />
                </button>
                <span className="zoom-label">{Math.round(view.zoom * 100)}%</span>
                <button onClick={() => zoomBy(0.25)} aria-label="Ampliar zoom">
                  <ZoomIn size={14} />
                </button>
                <i />
                <button onClick={() => setView({ x: 0, y: 0, zoom: 1 })} aria-label="Recentralizar canvas">
                  <Maximize2 size={14} />
                </button>
              </div>
              <button
                className="canvas-ask"
                disabled={!doc.nodes.length}
                onClick={() =>
                  composerBus.send(
                    "Analise este layout de canvas (nós em JSON) e sugira melhorias objetivas de hierarquia, alinhamento, espaçamento e cor:\n```json\n" +
                      JSON.stringify(doc.nodes) +
                      "\n```"
                  )
                }
              >
                <Wand2 size={12} />
                Analisar layout com o agente
              </button>
            </div>
          ) : clips.length ? (
            <div className="desx-video-col">
              <div className="desx-player">
                <video
                  ref={videoRef}
                  playsInline
                  onEnded={handleEnded}
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                />
              </div>
              <div className="desx-transport">
                <button className="icon-button" onClick={togglePlay} aria-label={playing ? "Pausar" : "Reproduzir"}>
                  {playing ? <Pause size={15} /> : <Play size={15} />}
                </button>
                <span className="desx-time" ref={timeRef}>
                  0:00.0 / {formatTime(totalDuration)}
                </span>
                <span className="desx-keys">espaço play · ←/→ ±1s</span>
                <input
                  ref={scrubRef}
                  className="desx-scrub"
                  type="range"
                  min={0}
                  max={1000}
                  defaultValue={0}
                  onChange={(event) =>
                    seekTimeline((Number(event.target.value) / 1000) * totalOf(clipsRef.current))
                  }
                  onPointerUp={(event) => event.currentTarget.blur()}
                  aria-label="Posição na timeline"
                />
                <button className="lg-button" onClick={splitAtPlayhead} disabled={!clips.length}>
                  <Scissors size={13} />
                  Dividir no playhead
                </button>
                <button
                  className="lg-button"
                  onClick={() => selectedClipId && deleteClip(selectedClipId)}
                  disabled={!selectedClipId}
                >
                  <Trash2 size={13} />
                  Excluir
                </button>
              </div>
              <div className="desx-timeline">
                <div className="desx-timeline-head">
                  <Clapperboard size={12} />
                  Timeline
                  <small>
                    {clips.length} clipes · {formatTime(totalDuration)}
                  </small>
                </div>
                <div className="desx-track-area">
                  <div className="desx-ruler" onPointerDown={onRulerPointerDown}>
                    {ticks.map((tick) => (
                      <span
                        key={tick}
                        className="desx-tick"
                        style={{ left: `${totalDuration ? (tick / totalDuration) * 100 : 0}%` }}
                      >
                        {formatTime(tick)}
                      </span>
                    ))}
                  </div>
                  <div className="desx-track">
                    {clips.map((clip) => (
                      <button
                        key={clip.id}
                        className={`desx-clip ${selectedClipId === clip.id ? "active" : ""}`}
                        style={{ width: `${totalDuration ? (clipLength(clip) / totalDuration) * 100 : 0}%` }}
                        onClick={() => selectClip(clip.id)}
                        title={clip.name}
                      >
                        <strong>{clip.name}</strong>
                        <small>{formatTime(clipLength(clip))}</small>
                      </button>
                    ))}
                  </div>
                  <div ref={playheadRef} className="desx-playhead" />
                </div>
              </div>
            </div>
          ) : (
            <EmptyHero
              icon={<Clapperboard size={30} />}
              kicker="EDITOR DE VÍDEO"
              title="Monte cortes sem sair do estúdio"
              detail="Importe vídeos locais, divida clipes no playhead (espaço play/pause, setas ±1s) e gere o comando ffmpeg do corte final — tudo processado na sua máquina."
            >
              <button className="lg-button primary" onClick={() => fileRef.current?.click()}>
                <Plus size={13} />
                Adicionar vídeo
              </button>
            </EmptyHero>
          )}
        </VCenter>

        {tab !== "video" ? (
          <VRight>
            <div className="desx-side-tabs">
              <div className="segmented">
                <button className={sideTab === "inspect" ? "active" : ""} onClick={() => setSideTab("inspect")}>
                  <SlidersHorizontal size={12} />
                  Inspect
                </button>
                <button className={sideTab === "tokens" ? "active" : ""} onClick={() => setSideTab("tokens")}>
                  <Palette size={12} />
                  Tokens
                </button>
                <button
                  className={sideTab === "system" ? "active" : ""}
                  onClick={() => setSideTab("system")}
                  title="Contrato de marca: governa o canvas e entra nos prompts"
                >
                  <ShieldCheck size={12} />
                  Sistema
                </button>
              </div>
            </div>
            {sideTab === "system" ? (
              <PanelScroll>
                <DesignSystemPanel
                  doc={doc}
                  onApply={(next) => {
                    pushHistory();
                    setDoc(next);
                  }}
                  onSelect={selectNode}
                  seedColors={repResult?.tokens.colors ?? []}
                  seedFonts={repResult?.tokens.fonts ?? []}
                />
              </PanelScroll>
            ) : sideTab === "inspect" ? (
              <PanelScroll>
                {selectedNode ? (
                  <>
                    <PanelTitle icon={nodeIcon(selectedNode.type)} label={selectedNode.id} meta={selectedNode.type} />
                    <div className="desx-inputs">
                      <NumField label="X" value={selectedNode.x} onCommit={(x) => patchSelected({ x })} />
                      <NumField label="Y" value={selectedNode.y} onCommit={(y) => patchSelected({ y })} />
                      <NumField label="Largura" value={selectedNode.w} onCommit={(w) => patchSelected({ w })} />
                      <NumField label="Altura" value={selectedNode.h} onCommit={(h) => patchSelected({ h })} />
                      {(selectedNode.type === "frame" || selectedNode.type === "rect") && (
                        <NumField
                          label="Raio"
                          value={selectedNode.radius ?? 0}
                          onCommit={(radius) => patchSelected({ radius })}
                        />
                      )}
                      {selectedNode.type === "text" && (
                        <NumField
                          label="Fonte (px)"
                          value={selectedNode.fontSize ?? 16}
                          onCommit={(fontSize) => patchSelected({ fontSize })}
                        />
                      )}
                      <label className="desx-field desx-span2">
                        <small>Fill</small>
                        <span className="desx-fill-row">
                          {isHex6(selectedNode.fill) ? (
                            <input
                              type="color"
                              value={selectedNode.fill}
                              onChange={(event) => patchSelected({ fill: event.target.value })}
                              aria-label="Cor do preenchimento"
                            />
                          ) : (
                            <i className="desx-mini-swatch" style={{ background: selectedNode.fill }} />
                          )}
                          <input
                            value={selectedNode.fill}
                            onChange={(event) => patchSelected({ fill: event.target.value })}
                            aria-label="Valor do preenchimento"
                          />
                        </span>
                      </label>
                      {(selectedNode.type === "text" || selectedNode.type === "frame") && (
                        <label className="desx-field desx-span2">
                          <small>{selectedNode.type === "text" ? "Texto" : "Nome do frame"}</small>
                          <input
                            value={selectedNode.text ?? ""}
                            onChange={(event) => patchSelected({ text: event.target.value })}
                            aria-label={selectedNode.type === "text" ? "Conteúdo do texto" : "Nome do frame"}
                          />
                        </label>
                      )}
                    </div>
                    <div className="desx-order">
                      <button
                        className="lg-button"
                        title="Trazer para frente"
                        aria-label="Trazer para frente"
                        onClick={() => reorderSelected(doc.nodes.length - 1)}
                      >
                        <ChevronsUp size={13} />
                      </button>
                      <button
                        className="lg-button"
                        title="Subir uma camada"
                        aria-label="Subir uma camada"
                        onClick={() => reorderSelected(selectedIndex + 1)}
                      >
                        <ChevronUp size={13} />
                      </button>
                      <button
                        className="lg-button"
                        title="Descer uma camada"
                        aria-label="Descer uma camada"
                        onClick={() => reorderSelected(selectedIndex - 1)}
                      >
                        <ChevronDown size={13} />
                      </button>
                      <button
                        className="lg-button"
                        title="Enviar para trás"
                        aria-label="Enviar para trás"
                        onClick={() => reorderSelected(0)}
                      >
                        <ChevronsDown size={13} />
                      </button>
                      <button
                        className="lg-button"
                        title="Excluir nó (Delete)"
                        aria-label="Excluir nó"
                        onClick={() => deleteNode(selectedNode.id)}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="desx-inputs">
                      <label className="desx-field desx-span2">
                        <small>Documento</small>
                        <input
                          value={doc.name}
                          onChange={(event) => setDoc((previous) => ({ ...previous, name: event.target.value }))}
                          aria-label="Nome do documento"
                        />
                      </label>
                    </div>
                    <p className="desx-hint">
                      Selecione um nó no canvas ou nas camadas do rail para editar posição, tamanho, cor e texto.
                    </p>
                  </>
                )}
              </PanelScroll>
            ) : (
              <PanelScroll>
                <PanelTitle icon={<Wand2 size={13} />} label="Colar HTML/CSS" meta="extração local" />
                <div className="desx-paste">
                  <textarea
                    value={pasteSource}
                    onChange={(event) => setPasteSource(event.target.value)}
                    placeholder="Cole aqui HTML ou CSS de um site real (view-source, DevTools, arquivo .css) — a extração roda 100% local."
                    aria-label="Fonte HTML/CSS para extrair tokens"
                  />
                  <button className="lg-button primary" disabled={!pasteSource.trim()} onClick={handleExtract}>
                    <Wand2 size={13} />
                    Extrair tokens
                  </button>
                </div>
                {extracted && (
                  <>
                    <PanelTitle icon={<Palette size={13} />} label="Cores" meta={`${extracted.colors.length} · por frequência`} />
                    {extracted.colors.length ? (
                      <div className="desx-swatches">
                        {extracted.colors.slice(0, 24).map(({ value, count }) => (
                          <button
                            key={value}
                            className="desx-swatch"
                            style={{ background: value }}
                            title={`${value} · ${count}× — clique para copiar`}
                            aria-label={`Copiar cor ${value}`}
                            onClick={() => void copySwatch(value)}
                          >
                            <small>{count}×</small>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="desx-hint">Nenhuma cor hex/rgb/hsl na fonte colada.</p>
                    )}
                    <PanelTitle icon={<Type size={13} />} label="Tipografia" meta={String(extracted.fonts.length)} />
                    {extracted.fonts.length ? (
                      <div className="desx-props">
                        {extracted.fonts.slice(0, 10).map((font) => (
                          <div key={font} className="desx-prop">
                            <small>fonte</small>
                            <code>
                              <Type size={11} />
                              {font}
                            </code>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="desx-hint">Nenhum font-family na fonte colada.</p>
                    )}
                    <PanelTitle icon={<Ruler size={13} />} label="Espaçamento" meta={`${extracted.spacing.length} · px/rem`} />
                    {extracted.spacing.length ? (
                      <div className="desx-chips">
                        {extracted.spacing.slice(0, 12).map(({ value, count }) => (
                          <span key={value} className="chip">
                            {value} · {count}×
                          </span>
                        ))}
                      </div>
                    ) : (
                      <p className="desx-hint">Nenhum valor px/rem na fonte colada.</p>
                    )}
                  </>
                )}
                {copiedValue && (
                  <span className="chip ok desx-copied">
                    <Check size={11} />
                    copiado
                  </span>
                )}
                {repResult && (
                  <>
                    <PanelTitle icon={<Palette size={13} />} label="Cores do site" meta="via gateway" />
                    <div className="desx-swatches">
                      {repResult.tokens.colors.map((color) => (
                        <button
                          key={color}
                          className="desx-swatch"
                          style={{ background: color }}
                          title={color}
                          aria-label={`Copiar cor ${color}`}
                          onClick={() => void copySwatch(color)}
                        />
                      ))}
                    </div>
                    <PanelTitle icon={<Type size={13} />} label="Fontes do site" meta={String(repResult.tokens.fonts.length)} />
                    <div className="desx-props">
                      {repResult.tokens.fonts.map((font) => (
                        <div key={font} className="desx-prop">
                          <small>fonte</small>
                          <code>
                            <Type size={11} />
                            {font}
                          </code>
                        </div>
                      ))}
                    </div>
                    <PanelTitle icon={<Frame size={13} />} label="Análise" meta="via gateway" />
                    <div className="desx-props">
                      <PropRow label="Fingerprints" value={repResult.analysis.componentFingerprints} />
                      <PropRow label="Stylesheets" value={repResult.analysis.stylesheets} />
                      <PropRow label="Páginas" value={repResult.pages.length} />
                      <PropRow label="Animações" value={repResult.analysis.animations.length} />
                    </div>
                  </>
                )}
              </PanelScroll>
            )}
          </VRight>
        ) : (
          <VRight>
            <PanelTitle icon={<SlidersHorizontal size={13} />} label="Clipe" meta={selectedClip ? "selecionado" : "—"} />
            {selectedClip ? (
              <div className="desx-props">
                <PropRow label="Nome" value={selectedClip.name} />
                <PropRow label="Origem" value={selectedClipMedia?.name ?? "—"} />
                <PropRow label="Entrada (in)" value={formatTime(selectedClip.start)} />
                <PropRow label="Saída (out)" value={formatTime(selectedClip.end)} />
                <PropRow label="Duração" value={formatTime(clipLength(selectedClip))} />
              </div>
            ) : (
              <p className="desx-hint">Selecione um clipe na timeline para ver as propriedades.</p>
            )}
            <PanelTitle
              icon={<TerminalIcon size={13} />}
              label="Exportar"
              meta={isTauriHost ? "ffmpeg local" : "requer app desktop"}
            />
            <div className="desx-export">
              <p>
                O corte é renderizado pelo <strong>ffmpeg da sua máquina</strong> — nada sobe para a nuvem. Coloque os
                vídeos importados numa pasta, aponte-a abaixo e renderize; o arquivo final é gravado lá.
              </p>
              <label className="lg-field">
                Pasta dos vídeos (e da saída)
                <input
                  value={mediaFolder}
                  onChange={(event) => {
                    setMediaFolder(event.target.value);
                    window.localStorage.setItem("design.mediaFolder", event.target.value);
                  }}
                  placeholder="C:\\Users\\voce\\Videos\\projeto"
                  spellCheck={false}
                />
              </label>
              <label className="lg-field">
                Arquivo de saída
                <input value={outputName} onChange={(event) => setOutputName(event.target.value)} spellCheck={false} />
              </label>
              <button
                className={`lg-toggle ${withAudio ? "on" : ""}`}
                onClick={() => setWithAudio((value) => !value)}
                title="Desligue para clipes sem faixa de áudio"
              >
                <i />
                Incluir áudio
              </button>
              <div className="desx-export-actions">
                <button className="lg-button" onClick={() => void detectFfmpeg()} disabled={ffmpeg.status === "checking"}>
                  <TerminalIcon size={13} />
                  {ffmpeg.status === "checking" ? "Detectando…" : "Detectar ffmpeg"}
                </button>
                <button
                  className="lg-button primary"
                  disabled={!clips.length || ffmpeg.status === "rendering"}
                  onClick={() => void runExport()}
                >
                  <FileVideo size={13} />
                  {ffmpeg.status === "rendering" ? "Renderizando…" : "Renderizar corte"}
                </button>
              </div>
              {ffmpeg.note && <div className="desx-term">{ffmpeg.note}</div>}
              {ffmpeg.status === "missing" && (
                <span className="chip danger">{isTauriHost ? "ffmpeg não detectado" : "requer o app desktop"}</span>
              )}
            </div>
          </VRight>
        )}
      </VBody>

      <VStatus>
        <span>
          <Palette size={11} />
          Design · {tab === "canvas" ? "Canvas" : tab === "site" ? "Site" : "Vídeo"}
        </span>
        <span>{tab === "video" ? `${clips.length} clipes` : `${doc.nodes.length} nós`}</span>
        <span>
          {tab === "canvas" ? `zoom ${Math.round(view.zoom * 100)}%` : `duração ${formatTime(totalDuration)}`}
        </span>
        {tab === "canvas" && selectedNode && <span>{selectedNode.id} selecionado</span>}
        <span className="spacer" />
        {tab === "canvas" && <span>doc salvo localmente</span>}
        <span>{session ? "gateway conectado" : "gateway desconectado"}</span>
      </VStatus>
    </Surface>
  );
}

/* Linha de propriedade somente-leitura (Tokens / Clipe). */
function PropRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="desx-prop">
      <small>{label}</small>
      <code>{value}</code>
    </div>
  );
}

/* Campo numérico controlado do Inspect — aplica updateNode a cada mudança. */
function NumField({
  label,
  value,
  onCommit
}: {
  label: string;
  value: number;
  onCommit: (value: number) => void;
}) {
  return (
    <label className="desx-field">
      <small>{label}</small>
      <input
        type="number"
        value={value}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) onCommit(next);
        }}
      />
    </label>
  );
}
