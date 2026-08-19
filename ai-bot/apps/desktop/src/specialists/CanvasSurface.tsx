/**
 * Superfície do especialista de DESIGN — o estúdio EDITÁVEL.
 *
 * Três faixas: os TOKENS à esquerda (da réplica e do HTML/CSS colado), o
 * canvas editável no centro (criar/mover/redimensionar por arrasto, pan e
 * zoom), o Inspect e a conversa compacta à direita. No topo da superfície, as
 * abas de estúdio Canvas/Vídeo/Site — Vídeo e Site ainda desabilitadas, com a
 * dica honesta de quando chegam.
 *
 * Duas verdades convivem aqui, cada uma com um dono:
 *
 * - o SNAPSHOT da réplica continua sendo a leitura do último `tool.result` de
 *   `design.replicate` (memo em duas etapas, como antes). Guardar uma cópia
 *   criaria uma segunda verdade que envelhece sozinha ao replicar outra URL.
 * - o DOCUMENTO do canvas é estado PRÓPRIO, num store zustand de módulo
 *   (padrão do lib/schemaFoco.ts), porque ele não deriva de conversa nenhuma:
 *   é o trabalho da pessoa, persiste em localStorage e sobrevive a reload.
 *
 * O store mora NESTE arquivo, e não num lib/ próprio, pelo mesmo motivo do
 * orquestrador (modes/DesignView.tsx: useDesign + DesignRail + DesignView num
 * arquivo só): superfície e rail compartilham o mesmo singleton, e o dono do
 * documento é a superfície — o LayersRail importa daqui e só lê/aciona.
 *
 * A lógica pura (operações do doc, histórico, presets, stencils, tokens) vive
 * em ../lib/canvas e é coberta por testes de Node; aqui fica só o que precisa
 * de DOM: ponteiro, teclado, rasterização de PNG e download.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { create } from "zustand";
import {
  Braces,
  Check,
  ChevronDown,
  ChevronsDown,
  ChevronsUp,
  ChevronUp,
  Circle,
  Clapperboard,
  Copy,
  Download,
  Frame,
  Globe,
  Globe2,
  Image as ImageIcon,
  Import,
  Link2,
  Maximize2,
  MousePointer2,
  Palette,
  Redo2,
  Ruler,
  ShieldCheck,
  Square,
  Trash2,
  Type,
  Undo2,
  Wand2,
  X,
  ZoomIn,
  ZoomOut
} from "lucide-react";
import type { ConversationLine, ToolResult } from "@aibot/contracts";
import {
  addNode,
  applyDevicePreset,
  boundsOf,
  buildStencil,
  canRedo,
  canUndo,
  createDoc,
  createHistory,
  createNode,
  DEFAULT_SIZES,
  DEVICES,
  exportSvg,
  extractTokens,
  MIN_NODE_SIZE,
  parseDoc,
  pushHistory,
  pushHistoryCoalesced,
  redo,
  removeNode,
  reorder,
  serializeDoc,
  undo,
  updateNode
} from "../lib/canvas";
import type {
  CanvasDoc,
  CanvasNode,
  CanvasNodeType,
  DevicePreset,
  DocHistory,
  ExtractedTokens,
  StencilId
} from "../lib/canvas";
import { useApp } from "../lib/store";
import { TopbarActions } from "../shell/TopbarActions";
import { ConversationSurface } from "./ConversationSurface";

/* --------------------------- leitura do tool.result ---------------------- */

interface DesignColor {
  /** Nome do token quando a ferramenta deu um; senão o próprio valor. */
  name: string;
  value: string;
  note: string;
}

interface DesignVariable {
  name: string;
  value: string;
}

interface DesignFont {
  family: string;
  note: string;
}

export interface DesignSnapshot {
  url: string;
  title: string;
  colors: DesignColor[];
  variables: DesignVariable[];
  fonts: DesignFont[];
  html: string;
}

const EMPTY: DesignSnapshot = { url: "", title: "", colors: [], variables: [], fonts: [], html: "" };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function safeJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

/** Cor chega como "#aabbcc" ou como objeto com nome e uso. */
function readColors(value: unknown): DesignColor[] {
  if (!Array.isArray(value)) return [];
  const out: DesignColor[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      out.push({ name: item, value: item, note: "" });
      continue;
    }
    const record = asRecord(item);
    if (!record) continue;
    const raw = asText(record.value) || asText(record.hex) || asText(record.color);
    if (raw === "") continue;
    out.push({
      name: asText(record.name) || asText(record.token) || raw,
      value: raw,
      note: asText(record.role) || asText(record.usage) || asText(record.note)
    });
  }
  return out;
}

/** Variáveis chegam como lista de objetos ou como mapa nome→valor. */
function readVariables(value: unknown): DesignVariable[] {
  const out: DesignVariable[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      const record = asRecord(item);
      if (!record) continue;
      const name = asText(record.name) || asText(record.property);
      const raw = asText(record.value);
      if (name !== "" && raw !== "") out.push({ name, value: raw });
    }
    return out;
  }
  const record = asRecord(value);
  if (!record) return out;
  for (const [name, raw] of Object.entries(record)) {
    if (typeof raw === "string") out.push({ name, value: raw });
  }
  return out;
}

function readFonts(value: unknown): DesignFont[] {
  if (!Array.isArray(value)) return [];
  const out: DesignFont[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      out.push({ family: item, note: "" });
      continue;
    }
    const record = asRecord(item);
    if (!record) continue;
    const family = asText(record.family) || asText(record.name) || asText(record.value);
    if (family === "") continue;
    out.push({ family, note: asText(record.role) || asText(record.usage) || asText(record.weight) });
  }
  return out;
}

function dedupe(colors: DesignColor[]): DesignColor[] {
  const seen = new Set<string>();
  const out: DesignColor[] = [];
  for (const color of colors) {
    const key = color.value.trim().toLowerCase();
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    out.push(color);
  }
  return out;
}

/**
 * Quando o `output` não é JSON ainda dá para aproveitar: CSS cru tem cor, tem
 * custom property e tem font-family. Melhor mostrar o que deu para ler do que um
 * painel vazio ao lado de uma resposta que claramente trouxe tokens.
 */
function fromText(text: string): DesignSnapshot {
  const colors = dedupe(
    [...text.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]{3,60}\)|hsla?\([^)]{3,60}\)/g)].map((match) => ({
      name: match[0],
      value: match[0],
      note: ""
    }))
  );

  const variables: DesignVariable[] = [];
  for (const match of text.matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*([^;\n}]{1,120})/g)) {
    const name = match[1];
    const value = match[2];
    if (name === undefined || value === undefined) continue;
    variables.push({ name, value: value.trim() });
  }

  const fonts: DesignFont[] = [];
  for (const match of text.matchAll(/font-family\s*:\s*([^;\n}]{1,120})/gi)) {
    const family = match[1];
    if (family === undefined) continue;
    fonts.push({ family: family.trim(), note: "" });
  }

  return {
    ...EMPTY,
    colors,
    variables: variables.slice(0, 60),
    fonts,
    html: /^\s*(<!doctype|<html|<div|<section|<body|<main)/i.test(text) ? text : ""
  };
}

function parse(result: ToolResult): DesignSnapshot {
  const raw = result.output ?? "";
  const root = asRecord(safeJson(raw));
  if (!root) return fromText(raw);

  // A ferramenta pode aninhar tudo em `tokens` ou espalhar na raiz; os dois
  // formatos aparecem na prática porque o host que responde é outro programa.
  const source = asRecord(root.tokens) ?? root;
  return {
    url: asText(root.url) || asText(root.source),
    title: asText(root.title),
    colors: dedupe(readColors(source.colors ?? source.palette)),
    variables: readVariables(source.variables ?? source.cssVariables ?? source.custom),
    fonts: readFonts(source.fonts ?? source.typography ?? source.families),
    html: asText(root.html) || asText(root.markup) || asText(root.preview)
  };
}

/** O último resultado vence: replicar de novo troca a tela inteira. */
function latestReplicate(lines: ConversationLine[]): ToolResult | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const results = lines[index]?.toolResults;
    if (results === undefined) continue;
    for (let inner = results.length - 1; inner >= 0; inner -= 1) {
      const result = results[inner];
      if (result === undefined) continue;
      if (result.tool === "design.replicate" && result.ok) return result;
    }
  }
  return null;
}

function readDesign(result: ToolResult | null): DesignSnapshot {
  return result === null ? EMPTY : parse(result);
}

function countTokens(snapshot: DesignSnapshot): number {
  return snapshot.colors.length + snapshot.variables.length + snapshot.fonts.length;
}

/** O texto que a ação "Exportar tokens" entrega. */
function toCss(snapshot: DesignSnapshot): string {
  const head = snapshot.url
    ? `/* tokens extraídos de ${snapshot.url} — AI-BOT */`
    : "/* tokens extraídos — AI-BOT */";
  const body: string[] = [];
  snapshot.colors.forEach((color, index) => {
    body.push(`  ${color.name.startsWith("--") ? color.name : `--color-${index + 1}`}: ${color.value};`);
  });
  snapshot.variables.forEach((variable) => {
    body.push(`  ${variable.name.startsWith("--") ? variable.name : `--${variable.name}`}: ${variable.value};`);
  });
  snapshot.fonts.forEach((font, index) => {
    body.push(`  --font-${index + 1}: ${font.family};`);
  });
  return `${head}\n:root {\n${body.join("\n")}\n}\n`;
}

/* ----------------------- o store do estúdio (módulo) --------------------- */

export type CanvasTool = "select" | CanvasNodeType;

/**
 * Prefixo do documento no localStorage — versionado como no orquestrador
 * (DOC_STORAGE_KEY): se o shape do doc mudar, a chave muda junto e o parseDoc
 * não precisa adivinhar formato velho.
 *
 * A chave completa é POR SESSÃO: o desenho pertence à conversa em que nasceu.
 * A chave global da primeira versão fazia todas as conversas dividirem o mesmo
 * doc — abrir o Design em outra conversa mostrava (e sobrescrevia) o desenho
 * da anterior, em silêncio.
 */
export const DOC_STORAGE_KEY = "aibot.design.canvas.v1";

export function chaveDoDoc(sessao: string | null): string {
  return sessao ? DOC_STORAGE_KEY + "." + sessao : DOC_STORAGE_KEY;
}

function loadStoredDoc(sessao: string | null): CanvasDoc {
  try {
    const stored = window.localStorage.getItem(chaveDoDoc(sessao));
    if (stored) {
      const doc = parseDoc(stored);
      if (doc) return doc;
    }
  } catch {
    // storage indisponível → doc inicial mínimo
  }
  return createDoc();
}

/**
 * O contador de série dos stencils. O orquestrador semeava só com Date.now(),
 * e dois cliques no mesmo milissegundo — o caso normal num teste, e possível
 * num clique duplo — produziam ids duplicados; updateNode/removeNode casam por
 * id e passariam a mexer nas duas peças ao mesmo tempo. O contador garante a
 * unicidade na sessão; o Date cobre o doc persistido de sessões anteriores.
 */
let serieDoStencil = 0;

interface CanvasStudioState {
  doc: CanvasDoc;
  history: DocHistory;
  selectedId: string | null;
  /** Aplica um doc novo SEM registrar histórico — é o passo contínuo do
   *  arrasto, que registra uma vez no pointerdown e nunca por movimento. */
  aplicar(next: CanvasDoc | ((atual: CanvasDoc) => CanvasDoc)): void;
  /** Registra o estado ATUAL antes de uma edição (contrato do history.ts:
   *  pushHistory primeiro, operação depois). */
  registrar(): void;
  /** Idem, mas coalescido — para as edições digitadas do Inspect. */
  registrarDigitacao(): void;
  selecionar(id: string | null): void;
  excluirNo(id: string): void;
  desfazer(): void;
  refazer(): void;
  reordenar(id: string, to: number): void;
  aplicarPreset(preset: Pick<DevicePreset, "w" | "h">): void;
  inserirStencil(id: StencilId): void;
  /** Troca o documento para o da SESSÃO — histórico e seleção zeram junto:
   *  desfazer através de uma troca de conversa restauraria o desenho alheio. */
  carregarSessao(sessao: string | null): void;
}

export const useCanvasStudio = create<CanvasStudioState>((set) => ({
  doc: createDoc(),
  history: createHistory(),
  selectedId: null,
  aplicar: (next) => set((state) => ({ doc: typeof next === "function" ? next(state.doc) : next })),
  registrar: () => set((state) => ({ history: pushHistory(state.history, state.doc) })),
  carregarSessao: (sessao) =>
    set({ doc: loadStoredDoc(sessao), history: createHistory(), selectedId: null }),
  registrarDigitacao: () => set((state) => ({ history: pushHistoryCoalesced(state.history, state.doc) })),
  selecionar: (selectedId) => set({ selectedId }),
  excluirNo: (id) =>
    set((state) => ({
      history: pushHistory(state.history, state.doc),
      doc: removeNode(state.doc, id),
      selectedId: state.selectedId === id ? null : state.selectedId
    })),
  desfazer: () =>
    set((state) => {
      const passo = undo(state.history, state.doc);
      // Seleção limpa de propósito: o nó selecionado pode não existir no doc
      // restaurado, e um Inspect apontando para o nada é pior que nenhum.
      return passo ? { history: passo.history, doc: passo.doc, selectedId: null } : {};
    }),
  refazer: () =>
    set((state) => {
      const passo = redo(state.history, state.doc);
      return passo ? { history: passo.history, doc: passo.doc, selectedId: null } : {};
    }),
  reordenar: (id, to) =>
    set((state) => ({
      history: pushHistory(state.history, state.doc),
      doc: reorder(state.doc, id, to)
    })),
  aplicarPreset: (preset) =>
    set((state) => {
      const resultado = applyDevicePreset(state.doc, state.selectedId, preset);
      return {
        history: pushHistory(state.history, state.doc),
        doc: resultado.doc,
        selectedId: resultado.selectedId
      };
    }),
  inserirStencil: (id) =>
    set((state) => {
      // Cascata do módulo: dois cliques seguidos produzem duas peças VISÍVEIS,
      // não uma pilha exata que parece inserção falhada.
      const passo = state.doc.nodes.length % 6;
      const seed = `st${(serieDoStencil += 1).toString(36)}-${Date.now().toString(36)}`;
      const novos = buildStencil(id, 60 + passo * 24, 60 + passo * 24, seed);
      const primeiro = novos[0];
      return {
        history: pushHistory(state.history, state.doc),
        doc: { ...state.doc, nodes: [...state.doc.nodes, ...novos] },
        // Seleciona o primeiro nó — quem inseriu quer mexer no que acabou de
        // entrar, não caçá-lo na lista.
        selectedId: primeiro ? primeiro.id : state.selectedId
      };
    })
}));

/* Persistência real do documento (sobrevive a reload), onde quer que a edição
   aconteça — superfície ou rail. Portada do orquestrador: o subscribe compara
   por identidade porque as operações do canvasDoc são imutáveis — doc igual é
   a MESMA referência, e seleção/histórico não disparam escrita nenhuma. */
useCanvasStudio.subscribe((state, previous) => {
  if (state.doc === previous.doc) return;
  try {
    window.localStorage.setItem(chaveDoDoc(useApp.getState().session), serializeDoc(state.doc));
  } catch {
    // storage cheio/indisponível — o doc segue em memória
  }
});

/**
 * Importa o snapshot da réplica como NÓS editáveis: um frame com o título,
 * a paleta como retângulos e a tipografia como amostras de texto — tudo nó
 * comum (mover, redimensionar, recolorir). Adaptação do
 * importReplicationToCanvas do orquestrador para o snapshot do AI-BOT, que
 * não tem páginas: aqui a unidade é um frame só.
 */
export function importarPreviaComoNos(snapshot: DesignSnapshot): void {
  const estado = useCanvasStudio.getState();
  estado.registrar();
  let next = estado.doc;
  // Entra ao lado do que já existe, para não sobrescrever o trabalho atual.
  const offsetX = next.nodes.reduce((max, node) => Math.max(max, node.x + node.w), 0) + 80;
  const frame = createNode(next, "frame", { x: offsetX, y: 40, w: 960, h: 640 });
  next = updateNode(addNode(next, frame), frame.id, { text: snapshot.title || snapshot.url || "Réplica" });
  const titulo = createNode(next, "text", { x: offsetX + 48, y: 88, w: 720, h: 48 });
  next = updateNode(addNode(next, titulo), titulo.id, {
    text: snapshot.title || snapshot.url || "Réplica",
    fontSize: 32
  });
  snapshot.colors.slice(0, 8).forEach((cor, index) => {
    const amostra = createNode(next, "rect", { x: offsetX + 48 + index * 108, y: 168, w: 92, h: 92 });
    next = updateNode(addNode(next, amostra), amostra.id, { fill: cor.value, radius: 14 });
  });
  snapshot.fonts.slice(0, 4).forEach((fonte, index) => {
    const amostra = createNode(next, "text", { x: offsetX + 48, y: 300 + index * 56, w: 820, h: 40 });
    next = updateNode(addNode(next, amostra), amostra.id, { text: `Aa — ${fonte.family}`, fontSize: 24 });
  });
  estado.aplicar(() => next);
  estado.selecionar(frame.id);
}

/* --------------------------- desenho de um nó ---------------------------- */

export function nodeIcon(type: CanvasNodeType): ReactNode {
  switch (type) {
    case "frame":
      return <Frame size={13} aria-hidden="true" />;
    case "rect":
      return <Square size={13} aria-hidden="true" />;
    case "ellipse":
      return <Circle size={13} aria-hidden="true" />;
    case "text":
      return <Type size={13} aria-hidden="true" />;
  }
}

export function nodeLabel(node: CanvasNode): string {
  if (node.type === "text" || node.type === "frame") return node.text?.trim() || node.id;
  return node.id;
}

/**
 * O estilo do nó é INLINE de propósito: posição, tamanho e fill nascem em
 * tempo de execução — não existe classe possível para eles. E os fills são
 * cores concretas (hex do documento), nunca custom property de tema: cor que
 * troca por tema aqui cairia na armadilha conhecida do projeto (transition
 * sobre custom property encalha) e quebraria o export, que roda fora do DOM.
 */
function nodeStyle(node: CanvasNode): CSSProperties {
  const base: CSSProperties = { left: node.x, top: node.y, width: node.w, height: node.h };
  if (node.type === "text") return { ...base, color: node.fill, fontSize: node.fontSize ?? 16, lineHeight: 1.25 };
  if (node.type === "ellipse") return { ...base, background: node.fill, borderRadius: "50%" };
  return { ...base, background: node.fill, borderRadius: node.radius ?? 0 };
}

const HANDLES = ["nw", "ne", "sw", "se"] as const;

const TOOL_SHORTCUTS: Record<string, CanvasTool> = {
  v: "select",
  f: "frame",
  r: "rect",
  o: "ellipse",
  t: "text"
};

const TOOL_LIST: Array<{ id: CanvasTool; label: string }> = [
  { id: "select", label: "Selecionar (V)" },
  { id: "frame", label: "Frame (F)" },
  { id: "rect", label: "Retângulo (R)" },
  { id: "ellipse", label: "Elipse (O)" },
  { id: "text", label: "Texto (T)" }
];

function toolIcon(tool: CanvasTool): ReactNode {
  switch (tool) {
    case "select":
      return <MousePointer2 size={13} aria-hidden="true" />;
    case "frame":
      return <Frame size={13} aria-hidden="true" />;
    case "rect":
      return <Square size={13} aria-hidden="true" />;
    case "ellipse":
      return <Circle size={13} aria-hidden="true" />;
    case "text":
      return <Type size={13} aria-hidden="true" />;
  }
}

type DragState =
  | { kind: "pan"; originX: number; originY: number; baseX: number; baseY: number }
  | {
      kind: "move";
      id: string;
      originX: number;
      originY: number;
      baseX: number;
      baseY: number;
      registered: boolean;
    }
  | {
      kind: "resize";
      id: string;
      handle: string;
      originX: number;
      originY: number;
      base: { x: number; y: number; w: number; h: number };
      registered: boolean;
    }
  | { kind: "create"; id: string; type: CanvasNodeType; worldX: number; worldY: number; moved: boolean };

const isHex6 = (value: string) => /^#[0-9a-f]{6}$/i.test(value);

function slugName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "canvas";
}

function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* -------------------------------- copiar -------------------------------- */

type CopyState = "idle" | "done" | "fail";

function useCopy(): [CopyState, (text: string) => void] {
  const [state, setState] = useState<CopyState>("idle");

  // O aviso volta a ser botão sozinho; sem isto ele trava no visto e a segunda
  // cópia não dá sinal nenhum de que aconteceu.
  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), 1400);
    return () => window.clearTimeout(timer);
  }, [state]);

  function copy(text: string): void {
    navigator.clipboard.writeText(text).then(
      () => setState("done"),
      () => setState("fail")
    );
  }

  return [state, copy];
}

function CopyIconButton({ value, title }: { value: string; title: string }): ReactNode {
  const [state, copy] = useCopy();
  return (
    <button
      type="button"
      className="btn icon-btn"
      title={state === "fail" ? "não deu para copiar" : title}
      onClick={() => copy(value)}
    >
      {state === "done" ? <Check size={13} /> : state === "fail" ? <X size={13} /> : <Copy size={13} />}
    </button>
  );
}

/* ------------------------- ações na barra superior ----------------------- */

function ReplicateAction(): ReactNode {
  const send = useApp((state) => state.send);
  const busy = useApp((state) => state.busy);
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [warn, setWarn] = useState("");
  const field = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) field.current?.focus();
  }, [open]);

  function submit(): void {
    const candidate = url.trim();
    // A recusa acontece aqui, e não no gateway, porque o aviso chega perto do
    // dedo: quem digitou ainda está olhando para o campo.
    if (!/^https?:\/\/\S+$/i.test(candidate)) {
      setWarn("precisa começar com http:// ou https://");
      return;
    }
    send(`/replicar ${candidate}`);
    setUrl("");
    setWarn("");
    setOpen(false);
  }

  if (!open) {
    return (
      <button type="button" className="btn" onClick={() => setOpen(true)} title="extrai a linguagem visual de uma página">
        <Globe size={13} aria-hidden="true" />
        Replicar URL
      </button>
    );
  }

  return (
    <span className="inline-prompt" title={warn}>
      <Link2 size={13} aria-hidden="true" />
      <input
        ref={field}
        type="url"
        className="inline-prompt-field"
        value={url}
        placeholder="https://exemplo.com"
        spellCheck={false}
        aria-label="endereço para replicar"
        aria-invalid={warn !== ""}
        onChange={(event) => {
          setUrl(event.target.value);
          if (warn !== "") setWarn("");
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") submit();
          if (event.key === "Escape") setOpen(false);
        }}
      />
      <button type="button" className="btn btn-primary" disabled={busy} onClick={submit}>
        Replicar
      </button>
      <button type="button" className="btn btn-ghost icon-btn" title="fechar" onClick={() => setOpen(false)}>
        <X size={13} />
      </button>
    </span>
  );
}

function ExportTokensAction({ snapshot }: { snapshot: DesignSnapshot }): ReactNode {
  const [state, copy] = useCopy();
  const total = countTokens(snapshot);
  return (
    <button
      type="button"
      className="btn"
      disabled={total === 0}
      title={
        total === 0
          ? "nenhum token extraído ainda"
          : "copia os tokens como um bloco :root pronto para colar no projeto"
      }
      onClick={() => copy(toCss(snapshot))}
    >
      {state === "done" ? <Check size={13} aria-hidden="true" /> : <Download size={13} aria-hidden="true" />}
      {state === "done" ? "copiado" : state === "fail" ? "não deu" : "Exportar tokens"}
    </button>
  );
}

/* -------------------------------- superfície ---------------------------- */

export function CanvasSurface(): ReactNode {
  const lines = useApp((state) => state.lines);
  const setInput = useApp((state) => state.setInput);
  // MEMO EM DUAS ETAPAS: o array de linhas troca de identidade a cada delta do
  // streaming, e o memo único reparseava o JSON do resultado por token. A
  // identidade do ToolResult sobrevive aos deltas, então a etapa cara (parse)
  // só roda quando chega resultado novo. Mesmo padrão do FlowSurface.
  const resultado = useMemo(() => latestReplicate(lines), [lines]);
  const snapshot = useMemo(() => readDesign(resultado), [resultado]);
  const total = countTokens(snapshot);

  const doc = useCanvasStudio((state) => state.doc);
  const history = useCanvasStudio((state) => state.history);
  const selectedId = useCanvasStudio((state) => state.selectedId);
  const aplicar = useCanvasStudio((state) => state.aplicar);
  const registrar = useCanvasStudio((state) => state.registrar);
  const carregarSessao = useCanvasStudio((state) => state.carregarSessao);
  const sessaoAtiva = useApp((state) => state.session);

  // O desenho pertence à CONVERSA: trocar de sessão troca o documento (e zera
  // histórico/seleção — desfazer através da troca restauraria o desenho
  // alheio). Também é a carga inicial: o store nasce vazio de propósito.
  useEffect(() => {
    carregarSessao(sessaoAtiva);
  }, [sessaoAtiva, carregarSessao]);
  const registrarDigitacao = useCanvasStudio((state) => state.registrarDigitacao);
  const selecionar = useCanvasStudio((state) => state.selecionar);
  const excluirNo = useCanvasStudio((state) => state.excluirNo);
  const desfazer = useCanvasStudio((state) => state.desfazer);
  const refazer = useCanvasStudio((state) => state.refazer);
  const reordenar = useCanvasStudio((state) => state.reordenar);
  const aplicarPreset = useCanvasStudio((state) => state.aplicarPreset);

  const [tool, setTool] = useState<CanvasTool>("select");
  const [view, setView] = useState({ x: 0, y: 0, zoom: 1 });
  const [panning, setPanning] = useState(false);
  const [nota, setNota] = useState("");
  const [modo, setModo] = useState<"editar" | "previa">("editar");
  const [fonteColada, setFonteColada] = useState("");
  const [extraidos, setExtraidos] = useState<ExtractedTokens | null>(null);

  const dragRef = useRef<DragState | null>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const notaTimerRef = useRef(0);

  const selectedNode = doc.nodes.find((node) => node.id === selectedId) ?? null;
  const selectedIndex = selectedId ? doc.nodes.findIndex((node) => node.id === selectedId) : -1;

  function flashNote(texto: string): void {
    setNota(texto);
    window.clearTimeout(notaTimerRef.current);
    notaTimerRef.current = window.setTimeout(() => setNota(""), 2400);
  }

  useEffect(() => () => window.clearTimeout(notaTimerRef.current), []);

  /* A réplica NOVA abre a prévia sozinha — é o comportamento que a tela sempre
     teve, e quem pediu /replicar quer ver o resultado. A comparação é contra o
     resultado que existia NA MONTAGEM: sem isso, voltar para esta tela com uma
     réplica antiga na conversa arrancaria a pessoa do canvas que ela veio
     editar. */
  const previaVista = useRef(resultado);
  useEffect(() => {
    if (resultado === previaVista.current) return;
    previaVista.current = resultado;
    if (snapshot.html !== "") setModo("previa");
  }, [resultado, snapshot]);

  function patchSelected(patch: Partial<Omit<CanvasNode, "id" | "type">>): void {
    if (!selectedId) return;
    // Coalescido: digitar "320" no Inspect é UMA edição, não três.
    registrarDigitacao();
    aplicar((atual) => updateNode(atual, selectedId, patch));
  }

  function reorderSelected(to: number): void {
    if (!selectedId) return;
    reordenar(selectedId, to);
  }

  /* -------------------- ponteiro: criar/mover/redimensionar --------------- */

  function toWorld(clientX: number, clientY: number): { x: number; y: number } {
    const el = worldRef.current;
    if (!el) return { x: 0, y: 0 };
    // O rect do mundo já carrega o pan (o transform move o elemento); dividir
    // pelo zoom devolve a coordenada do documento, não a da tela.
    const rect = el.getBoundingClientRect();
    return { x: (clientX - rect.left) / view.zoom, y: (clientY - rect.top) / view.zoom };
  }

  function onCanvasPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    // Os controles flutuantes (zoom, analisar) moram DENTRO do editor: clicar
    // neles não pode virar pan nem criar forma.
    if (target.closest("button, input, textarea")) return;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // jsdom não implementa pointer capture; sem ela o arrasto só perde o
      // ponteiro se sair da janela — aceitável no teste, invisível no app.
    }

    if (tool === "select") {
      const handleEl = target.closest<HTMLElement>("[data-handle]");
      if (handleEl && selectedNode) {
        dragRef.current = {
          kind: "resize",
          id: selectedNode.id,
          handle: handleEl.dataset.handle ?? "se",
          originX: event.clientX,
          originY: event.clientY,
          base: { x: selectedNode.x, y: selectedNode.y, w: selectedNode.w, h: selectedNode.h },
          registered: false
        };
        return;
      }
      const nodeEl = target.closest<HTMLElement>("[data-node-id]");
      if (nodeEl) {
        const id = nodeEl.dataset.nodeId ?? "";
        const node = doc.nodes.find((entry) => entry.id === id);
        selecionar(id);
        if (node) {
          dragRef.current = {
            kind: "move",
            id,
            originX: event.clientX,
            originY: event.clientY,
            baseX: node.x,
            baseY: node.y,
            registered: false
          };
        }
        return;
      }
      // Vazio com a ferramenta de seleção: limpa e vira pan — é o gesto de
      // navegar o canvas sem trocar de ferramenta.
      selecionar(null);
      dragRef.current = { kind: "pan", originX: event.clientX, originY: event.clientY, baseX: view.x, baseY: view.y };
      setPanning(true);
      return;
    }

    /* Ferramenta de forma: clique-arraste cria o nó DE VERDADE, já no doc —
       o retângulo que cresce sob o ponteiro é o próprio nó, não um fantasma
       que vira nó depois. */
    const point = toWorld(event.clientX, event.clientY);
    registrar();
    const node = createNode(doc, tool, { x: point.x, y: point.y, w: MIN_NODE_SIZE, h: MIN_NODE_SIZE });
    aplicar((atual) => addNode(atual, node));
    selecionar(node.id);
    dragRef.current = { kind: "create", id: node.id, type: tool, worldX: point.x, worldY: point.y, moved: false };
  }

  function onCanvasPointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.kind === "pan") {
      setView((anterior) => ({
        ...anterior,
        x: drag.baseX + event.clientX - drag.originX,
        y: drag.baseY + event.clientY - drag.originY
      }));
      return;
    }
    if (drag.kind === "move" || drag.kind === "resize") {
      // O histórico registra no PRIMEIRO movimento de verdade, não no
      // pointerdown: clique de seleção sem arrasto empilhava um estado no-op —
      // consumia o teto de 50 e exigia Ctrl+Z extras que não mudavam nada.
      if (!drag.registered) {
        const distancia =
          Math.abs(event.clientX - drag.originX) + Math.abs(event.clientY - drag.originY);
        if (distancia < 2) return;
        registrar();
        drag.registered = true;
      }
    }
    if (drag.kind === "move") {
      // O delta é dividido pelo zoom: 10px de ponteiro a 200% são 5px de doc.
      const dx = (event.clientX - drag.originX) / view.zoom;
      const dy = (event.clientY - drag.originY) / view.zoom;
      aplicar((atual) => updateNode(atual, drag.id, { x: drag.baseX + dx, y: drag.baseY + dy }));
    } else if (drag.kind === "resize") {
      const dx = (event.clientX - drag.originX) / view.zoom;
      const dy = (event.clientY - drag.originY) / view.zoom;
      const b = drag.base;
      const patch: Partial<Pick<CanvasNode, "x" | "y" | "w" | "h">> = {};
      if (drag.handle.includes("e")) patch.w = b.w + dx;
      if (drag.handle.includes("s")) patch.h = b.h + dy;
      // As alças oeste/norte movem a ORIGEM junto — o clamp impede a alça de
      // atravessar o lado oposto e virar o nó do avesso.
      if (drag.handle.includes("w")) {
        patch.x = b.x + Math.min(dx, b.w - MIN_NODE_SIZE);
        patch.w = b.w - dx;
      }
      if (drag.handle.includes("n")) {
        patch.y = b.y + Math.min(dy, b.h - MIN_NODE_SIZE);
        patch.h = b.h - dy;
      }
      aplicar((atual) => updateNode(atual, drag.id, patch));
    } else {
      const point = toWorld(event.clientX, event.clientY);
      const x = Math.min(drag.worldX, point.x);
      const y = Math.min(drag.worldY, point.y);
      const w = Math.abs(point.x - drag.worldX);
      const h = Math.abs(point.y - drag.worldY);
      if (w > 3 || h > 3) drag.moved = true;
      aplicar((atual) => updateNode(atual, drag.id, { x, y, w, h }));
    }
  }

  function onCanvasPointerUp(): void {
    const drag = dragRef.current;
    dragRef.current = null;
    setPanning(false);
    if (drag?.kind === "create") {
      // Clique sem arrasto: a forma nasce no tamanho padrão do tipo, não num
      // pontinho de 8px que parece bug.
      if (!drag.moved) {
        const size = DEFAULT_SIZES[drag.type];
        aplicar((atual) => updateNode(atual, drag.id, { w: size.w, h: size.h }));
      }
      // Volta à seleção: quem desenhou quer ajustar o que desenhou; desenhar
      // dez formas seguidas é o caso raro, e o atalho (R/O/T) resolve.
      setTool("select");
    }
  }

  function zoomBy(delta: number): void {
    setView((anterior) => ({
      ...anterior,
      // 25%–200%: abaixo disso os nós viram ruído; acima, um pixel de arrasto
      // salta 4px de doc e o ajuste fino fica impossível.
      zoom: Math.min(2, Math.max(0.25, Math.round((anterior.zoom + delta) * 100) / 100))
    }));
  }

  /* Atalhos do canvas: V/F/R/O/T, Delete, Ctrl+Z / Ctrl+Shift+Z, Esc. Só no
     modo de edição — na prévia não há ferramenta para os atalhos acionarem, e
     um Delete "invisível" apagando nó fora da tela seria perda de trabalho. */
  useEffect(() => {
    if (modo !== "editar") return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // Quem digita num campo está escrevendo texto, não pedindo ferramenta.
      if (target?.closest("input, textarea, select, [contenteditable=true]")) return;
      const estudio = useCanvasStudio.getState();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) estudio.refazer();
        else estudio.desfazer();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        estudio.refazer();
        return;
      }
      if ((event.key === "Delete" || event.key === "Backspace") && estudio.selectedId) {
        event.preventDefault();
        estudio.excluirNo(estudio.selectedId);
        return;
      }
      if (event.key === "Escape") {
        setTool("select");
        estudio.selecionar(null);
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const proxima = TOOL_SHORTCUTS[event.key.toLowerCase()];
      if (proxima) setTool(proxima);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modo]);

  /* ----------------------------- export SVG/PNG --------------------------- */

  function handleExportSvg(): void {
    downloadBlob(`${slugName(doc.name)}.svg`, new Blob([exportSvg(doc)], { type: "image/svg+xml;charset=utf-8" }));
    flashNote("SVG exportado");
  }

  /** PNG@2x: o módulo entrega o SVG (puro, testável em Node) e a superfície
   *  rasteriza AQUI, porque <canvas> e Image só existem no DOM. */
  function handleExportPng(): void {
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

  /* --------------------------- tokens como fill --------------------------- */

  function aplicarFill(cor: string): void {
    const alvo = useCanvasStudio.getState().selectedId;
    if (!alvo) {
      flashNote("selecione um nó para aplicar a cor");
      return;
    }
    registrar();
    aplicar((atual) => updateNode(atual, alvo, { fill: cor }));
    flashNote(`fill ${cor} aplicado`);
  }

  function handleAnalisar(): void {
    // setInput, e não send: o pedido aparece no composer para a pessoa ler e
    // completar antes de mandar — crítica de layout é conversa, não comando.
    setInput(
      "Analise este layout de canvas (nós em JSON) e sugira melhorias objetivas de hierarquia, alinhamento, espaçamento e cor:\n```json\n" +
        JSON.stringify(doc.nodes) +
        "\n```"
    );
  }

  const emPrevia = modo === "previa" && snapshot.html !== "";

  return (
    <div className="surface canvas-surface">
      {/* A superfície não desenha barra própria: injeta os botões no slot da
          barra do app. É o que sustenta a promessa de tela única. */}
      <TopbarActions>
        <ReplicateAction />
        <ExportTokensAction snapshot={snapshot} />
      </TopbarActions>

      {/* As abas de ESTÚDIO moram na superfície, não na barra do app: elas
          trocam o conteúdo desta tela, e a barra de cima pertence ao app
          inteiro. Vídeo e Site nascem desabilitadas com a dica honesta — botão
          que finge funcionar ensina a não acreditar na tela. */}
      <div className="studio-tabs" role="tablist" aria-label="Estúdios do Design">
        <button type="button" role="tab" aria-selected="true" data-active="true" className="studio-tab">
          <Frame size={12} aria-hidden="true" />
          Canvas
        </button>
        <button
          type="button"
          role="tab"
          aria-selected="false"
          className="studio-tab"
          disabled
          title="Editor de vídeo — chega na Onda 3"
        >
          <Clapperboard size={12} aria-hidden="true" />
          Vídeo
          <span className="studio-tab-hint">Onda 3</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected="false"
          className="studio-tab"
          disabled
          title="Clonagem de site — chega na Onda 3"
        >
          <Globe2 size={12} aria-hidden="true" />
          Site
          <span className="studio-tab-hint">Onda 3</span>
        </button>
      </div>

      <div className="surface-toolbar canvas-toolbar">
        <div className="tool-group" role="toolbar" aria-label="Ferramentas do canvas">
          {TOOL_LIST.map((item) => (
            <button
              key={item.id}
              type="button"
              className="tool-btn"
              data-active={tool === item.id}
              title={item.label}
              aria-label={item.label}
              onClick={() => setTool(item.id)}
            >
              {toolIcon(item.id)}
            </button>
          ))}
        </div>
        <div className="tool-group" role="toolbar" aria-label="Tamanho do frame por dispositivo">
          {DEVICES.map((device) => {
            const alvo =
              doc.nodes.find((node) => node.id === selectedId && node.type === "frame") ??
              doc.nodes.find((node) => node.type === "frame");
            const ativo = alvo ? alvo.w === device.w && alvo.h === device.h : false;
            return (
              <button
                key={device.id}
                type="button"
                className="tool-btn tool-btn-text"
                data-active={ativo}
                title={`${device.label} · ${device.w}×${device.h}`}
                onClick={() => aplicarPreset(device)}
              >
                {device.label}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          className="btn icon-btn"
          disabled={!canUndo(history)}
          onClick={desfazer}
          title="Desfazer (Ctrl+Z)"
          aria-label="Desfazer"
        >
          <Undo2 size={13} />
        </button>
        <button
          type="button"
          className="btn icon-btn"
          disabled={!canRedo(history)}
          onClick={refazer}
          title="Refazer (Ctrl+Shift+Z)"
          aria-label="Refazer"
        >
          <Redo2 size={13} />
        </button>
        <button type="button" className="btn" disabled={!doc.nodes.length} onClick={handleExportSvg}>
          <Download size={13} aria-hidden="true" />
          SVG
        </button>
        <button type="button" className="btn" disabled={!doc.nodes.length} onClick={handleExportPng}>
          <ImageIcon size={13} aria-hidden="true" />
          PNG
        </button>
        <span className="surface-toolbar-spacer" />
        {nota !== "" ? <span className="chip">{nota}</span> : null}
        {snapshot.html !== "" ? (
          <button
            type="button"
            className="btn"
            data-active={emPrevia}
            onClick={() => setModo(emPrevia ? "editar" : "previa")}
            title={emPrevia ? "volta ao canvas editável" : "mostra o HTML replicado numa moldura isolada"}
          >
            {emPrevia ? <Frame size={13} aria-hidden="true" /> : <Globe size={13} aria-hidden="true" />}
            {emPrevia ? "Voltar ao canvas" : "Prévia replicada"}
          </button>
        ) : null}
        {emPrevia ? (
          <span className="chip" title="a prévia roda sem JavaScript, sem rede e sem acesso ao aplicativo">
            <ShieldCheck size={12} aria-hidden="true" />
            prévia sem scripts
          </span>
        ) : null}
      </div>

      <div className="surface-body canvas-studio">
        <aside className="canvas-tokens" aria-label="tokens de design">
          <section className="card">
            <div className="card-head">
              <Wand2 size={13} aria-hidden="true" />
              <span className="card-title">Colar HTML/CSS</span>
            </div>
            <div className="paste-tokens">
              <textarea
                value={fonteColada}
                onChange={(event) => setFonteColada(event.target.value)}
                placeholder="Cole HTML ou CSS de um site real — a extração roda 100% local, sem rede."
                aria-label="Fonte HTML/CSS para extrair tokens"
                spellCheck={false}
              />
              <button
                type="button"
                className="btn btn-primary"
                disabled={fonteColada.trim() === ""}
                onClick={() => setExtraidos(extractTokens(fonteColada))}
              >
                <Wand2 size={13} aria-hidden="true" />
                Extrair tokens
              </button>
            </div>
            {extraidos ? (
              <div className="card-body paste-result">
                <span className="eyebrow">Cores · {extraidos.colors.length} · por frequência</span>
                {extraidos.colors.length > 0 ? (
                  <div className="swatch-grid">
                    {extraidos.colors.slice(0, 24).map(({ value, count }) => (
                      <button
                        key={value}
                        type="button"
                        className="swatch"
                        style={{ background: value }}
                        title={`${value} · ${count}× — aplica como fill do nó selecionado`}
                        aria-label={`Aplicar cor ${value} como fill`}
                        onClick={() => aplicarFill(value)}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="hint">Nenhuma cor hex/rgb/hsl na fonte colada.</p>
                )}
                <span className="eyebrow">Tipografia · {extraidos.fonts.length}</span>
                {extraidos.fonts.slice(0, 8).map((fonte) => (
                  <code key={fonte} className="paste-font">
                    <Type size={11} aria-hidden="true" />
                    {fonte}
                  </code>
                ))}
                <span className="eyebrow">Espaçamento · {extraidos.spacing.length} · px/rem</span>
                <div className="paste-chips">
                  {extraidos.spacing.slice(0, 12).map(({ value, count }) => (
                    <span key={value} className="chip">
                      <Ruler size={11} aria-hidden="true" />
                      {value} · {count}×
                    </span>
                  ))}
                  {extraidos.spacing.length === 0 ? <p className="hint">Nenhum valor px/rem na fonte colada.</p> : null}
                </div>
              </div>
            ) : null}
          </section>

          {total === 0 && snapshot.html === "" ? (
            <div className="card">
              <div className="card-head">
                <Palette size={13} aria-hidden="true" />
                <span className="card-title">Réplica</span>
              </div>
              <div className="card-body">
                Nenhum token extraído ainda. Use “Replicar URL” na barra de cima: o que voltar de{" "}
                <code>design.replicate</code> — cores, variáveis e fontes — aparece aqui.
              </div>
            </div>
          ) : (
            <>
              <section className="card">
                <div className="card-head">
                  <Globe size={13} aria-hidden="true" />
                  <span className="card-title">{snapshot.title || "Réplica"}</span>
                  {snapshot.url ? (
                    <span className="chip" title={snapshot.url}>
                      {snapshot.url.replace(/^https?:\/\//, "")}
                    </span>
                  ) : null}
                </div>
                <div className="card-body">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      importarPreviaComoNos(snapshot);
                      setModo("editar");
                      flashNote("réplica importada como nós");
                    }}
                    title="transforma a réplica em nós editáveis: frame, paleta e tipografia"
                  >
                    <Import size={13} aria-hidden="true" />
                    Importar como nós
                  </button>
                </div>
              </section>

              {snapshot.colors.length > 0 ? (
                <section className="card">
                  <div className="card-head">
                    <Palette size={13} aria-hidden="true" />
                    <span className="card-title">Cores</span>
                    <span className="chip">{snapshot.colors.length}</span>
                  </div>
                  <ul className="token-list">
                    {snapshot.colors.map((color) => (
                      <li className="token-row" key={`${color.name}|${color.value}`}>
                        {/* A amostra é pintada com o valor lido — e agora é
                            BOTÃO: clicar aplica a cor como fill do nó
                            selecionado, que é o gesto que o estúdio pede. */}
                        <button
                          type="button"
                          className="token-swatch"
                          style={{ background: color.value }}
                          title={`aplicar ${color.value} como fill do nó selecionado`}
                          aria-label={`Aplicar cor ${color.value} como fill`}
                          onClick={() => aplicarFill(color.value)}
                        />
                        <span className="token-text">
                          <b title={color.note || undefined}>{color.name}</b>
                          <code>{color.value}</code>
                        </span>
                        <CopyIconButton value={color.value} title={`copiar ${color.value}`} />
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {snapshot.variables.length > 0 ? (
                <section className="card">
                  <div className="card-head">
                    <Braces size={13} aria-hidden="true" />
                    <span className="card-title">Variáveis CSS</span>
                    <span className="chip">{snapshot.variables.length}</span>
                  </div>
                  <ul className="token-list">
                    {snapshot.variables.map((variable) => (
                      <li className="token-row" key={variable.name}>
                        <span className="token-text">
                          <b>{variable.name}</b>
                          <code title={variable.value}>{variable.value}</code>
                        </span>
                        <CopyIconButton
                          value={`${variable.name}: ${variable.value};`}
                          title={`copiar ${variable.name}`}
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {snapshot.fonts.length > 0 ? (
                <section className="card">
                  <div className="card-head">
                    <Type size={13} aria-hidden="true" />
                    <span className="card-title">Tipografia</span>
                    <span className="chip">{snapshot.fonts.length}</span>
                  </div>
                  <ul className="token-list">
                    {snapshot.fonts.map((font) => (
                      <li className="token-row" key={font.family}>
                        {/* A amostra existe para julgar a fonte, então é escrita
                            na própria fonte. */}
                        <span className="token-sample" style={{ fontFamily: font.family }} aria-hidden="true">
                          Aa
                        </span>
                        <span className="token-text">
                          <b>{font.family}</b>
                          {font.note ? <code>{font.note}</code> : null}
                        </span>
                        <CopyIconButton value={font.family} title={`copiar ${font.family}`} />
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </>
          )}
        </aside>

        <div className="canvas-stage">
          {emPrevia ? (
            <div className="canvas-frame">
              {/*
               * sandbox="" — vazio DE PROPÓSITO, e em especial SEM allow-scripts.
               *
               * O HTML daqui veio de um site de terceiro (design.replicate lê a
               * página de outra pessoa) ou saiu de um modelo. Nos dois casos é
               * texto que ninguém revisou. Um iframe com allow-scripts roda esse
               * JavaScript DENTRO da janela do app: com allow-same-origin junto
               * ele alcança o DOM e o storage do AI-BOT; e mesmo sem ele ainda
               * navega a janela de cima, abre popup, chama a rede e escuta
               * tecla. Em Tauri o estrago passa da aba — a ponte para o sistema
               * de arquivos e para os comandos do host mora nesta mesma janela,
               * e entregar script de terceiro aqui é entregar a janela.
               *
               * O sandbox vazio nega tudo: script, formulário, mesma origem,
               * navegação do topo, popup, download, trava de ponteiro. Prévia de
               * layout não precisa de nada disso — cor, espaço e tipo são CSS.
               * Se um dia a prévia precisar de interação, o caminho é abrir num
               * navegador externo pelo plugin-opener, NÃO afrouxar este atributo.
               */}
              <iframe title="Prévia do HTML replicado" sandbox="" srcDoc={snapshot.html} />
              <span className="canvas-caption">sandbox="" · sem script, sem rede, sem acesso ao app</span>
            </div>
          ) : (
            <div
              className="cnv-editor"
              data-panning={panning}
              data-tool={tool}
              onPointerDown={onCanvasPointerDown}
              onPointerMove={onCanvasPointerMove}
              onPointerUp={onCanvasPointerUp}
              onPointerCancel={onCanvasPointerUp}
            >
              <div className="cnv-pan" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
                <div className="cnv-world" ref={worldRef}>
                  {doc.nodes.map((node) => (
                    <div
                      key={node.id}
                      data-node-id={node.id}
                      className={`cnv-node cnv-node-${node.type} ${selectedId === node.id ? "cnv-sel" : ""}`}
                      style={nodeStyle(node)}
                    >
                      {node.type === "frame" ? <span className="cnv-node-tag">{nodeLabel(node)}</span> : null}
                      {node.type === "text" ? node.text ?? "" : null}
                      {selectedId === node.id && tool === "select"
                        ? HANDLES.map((handle) => (
                            // A alça compensa o zoom (scale 1/zoom): ela é
                            // afford de TELA, não de documento — a 25% uma alça
                            // de 8px do doc viraria 2px inagarráveis.
                            <i
                              key={handle}
                              data-handle={handle}
                              className={`cnv-handle cnv-h-${handle}`}
                              style={{ transform: `scale(${1 / view.zoom})` }}
                            />
                          ))
                        : null}
                    </div>
                  ))}
                </div>
              </div>
              <div className="cnv-controls">
                <button type="button" className="btn icon-btn" onClick={() => zoomBy(-0.25)} aria-label="Reduzir zoom">
                  <ZoomOut size={13} />
                </button>
                <span className="cnv-zoom" aria-label="Zoom atual">
                  {Math.round(view.zoom * 100)}%
                </span>
                <button type="button" className="btn icon-btn" onClick={() => zoomBy(0.25)} aria-label="Ampliar zoom">
                  <ZoomIn size={13} />
                </button>
                <button
                  type="button"
                  className="btn icon-btn"
                  onClick={() => setView({ x: 0, y: 0, zoom: 1 })}
                  aria-label="Recentralizar canvas"
                  title="Recentralizar (100%)"
                >
                  <Maximize2 size={13} />
                </button>
              </div>
              <button type="button" className="btn cnv-ask" disabled={!doc.nodes.length} onClick={handleAnalisar}>
                <Wand2 size={12} aria-hidden="true" />
                Analisar layout com o agente
              </button>
            </div>
          )}
        </div>

        <aside className="canvas-side" aria-label="propriedades e conversa">
          <section className="card cnv-inspect">
            <div className="card-head">
              {selectedNode ? nodeIcon(selectedNode.type) : <Frame size={13} aria-hidden="true" />}
              <span className="card-title">Inspect</span>
              {selectedNode ? <span className="chip">{selectedNode.id}</span> : null}
            </div>
            {selectedNode ? (
              <div className="card-body">
                <div className="inspect-grid">
                  <NumField label="X" value={selectedNode.x} onCommit={(x) => patchSelected({ x })} />
                  <NumField label="Y" value={selectedNode.y} onCommit={(y) => patchSelected({ y })} />
                  <NumField label="Largura" value={selectedNode.w} onCommit={(w) => patchSelected({ w })} />
                  <NumField label="Altura" value={selectedNode.h} onCommit={(h) => patchSelected({ h })} />
                  {selectedNode.type === "frame" || selectedNode.type === "rect" ? (
                    <NumField
                      label="Raio"
                      value={selectedNode.radius ?? 0}
                      onCommit={(radius) => patchSelected({ radius })}
                    />
                  ) : null}
                  {selectedNode.type === "text" ? (
                    <NumField
                      label="Fonte (px)"
                      value={selectedNode.fontSize ?? 16}
                      onCommit={(fontSize) => patchSelected({ fontSize })}
                    />
                  ) : null}
                  <label className="inspect-field inspect-span2">
                    <small>Fill</small>
                    <span className="inspect-fill">
                      {isHex6(selectedNode.fill) ? (
                        // O input color nativo só entende #rrggbb; para rgb()/
                        // hsl() a amostra mostra e o campo de texto edita — um
                        // picker que "corrige" o formato da pessoa é pior.
                        <input
                          type="color"
                          value={selectedNode.fill}
                          onChange={(event) => patchSelected({ fill: event.target.value })}
                          aria-label="Cor do preenchimento"
                        />
                      ) : (
                        <i className="inspect-swatch" style={{ background: selectedNode.fill }} />
                      )}
                      <input
                        value={selectedNode.fill}
                        onChange={(event) => patchSelected({ fill: event.target.value })}
                        aria-label="Valor do preenchimento"
                      />
                    </span>
                  </label>
                  {selectedNode.type === "text" || selectedNode.type === "frame" ? (
                    <label className="inspect-field inspect-span2">
                      <small>{selectedNode.type === "text" ? "Texto" : "Nome do frame"}</small>
                      <input
                        value={selectedNode.text ?? ""}
                        onChange={(event) => patchSelected({ text: event.target.value })}
                        aria-label={selectedNode.type === "text" ? "Conteúdo do texto" : "Nome do frame"}
                      />
                    </label>
                  ) : null}
                </div>
                <div className="inspect-order">
                  <button
                    type="button"
                    className="btn icon-btn"
                    title="Trazer para frente"
                    aria-label="Trazer para frente"
                    onClick={() => reorderSelected(doc.nodes.length - 1)}
                  >
                    <ChevronsUp size={13} />
                  </button>
                  <button
                    type="button"
                    className="btn icon-btn"
                    title="Subir uma camada"
                    aria-label="Subir uma camada"
                    onClick={() => reorderSelected(selectedIndex + 1)}
                  >
                    <ChevronUp size={13} />
                  </button>
                  <button
                    type="button"
                    className="btn icon-btn"
                    title="Descer uma camada"
                    aria-label="Descer uma camada"
                    onClick={() => reorderSelected(selectedIndex - 1)}
                  >
                    <ChevronDown size={13} />
                  </button>
                  <button
                    type="button"
                    className="btn icon-btn"
                    title="Enviar para trás"
                    aria-label="Enviar para trás"
                    onClick={() => reorderSelected(0)}
                  >
                    <ChevronsDown size={13} />
                  </button>
                  <button
                    type="button"
                    className="btn icon-btn"
                    title="Excluir nó (Delete)"
                    aria-label="Excluir nó"
                    onClick={() => excluirNo(selectedNode.id)}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            ) : (
              <div className="card-body">
                <label className="inspect-field">
                  <small>Documento</small>
                  <input
                    value={doc.name}
                    onChange={(event) => {
                      registrarDigitacao();
                      aplicar((atual) => ({ ...atual, name: event.target.value }));
                    }}
                    aria-label="Nome do documento"
                  />
                </label>
                <p className="hint">
                  Selecione um nó no canvas ou nas camadas do rail para editar posição, tamanho, cor e texto.
                </p>
              </div>
            )}
          </section>

          <div className="canvas-talk" aria-label="conversa">
            <ConversationSurface compact />
          </div>
        </aside>
      </div>

      <div className="surface-status">
        <span>
          nós <b>{doc.nodes.length}</b>
        </span>
        <span>
          zoom <b>{Math.round(view.zoom * 100)}%</b>
        </span>
        {selectedNode ? <span>{selectedNode.id} selecionado</span> : null}
        <span>
          cores <b>{snapshot.colors.length}</b>
        </span>
        <span>
          fontes <b>{snapshot.fonts.length}</b>
        </span>
        <span>{emPrevia ? "prévia isolada, sem script" : "doc salvo localmente"}</span>
      </div>
    </div>
  );
}

/* Campo numérico controlado do Inspect — aplica o patch a cada mudança; a
   coalescência do histórico (COALESCE_WINDOW_MS) é quem agrupa a digitação. */
function NumField({
  label,
  value,
  onCommit
}: {
  label: string;
  value: number;
  onCommit: (value: number) => void;
}): ReactNode {
  return (
    <label className="inspect-field">
      <small>{label}</small>
      <input
        type="number"
        value={value}
        aria-label={label}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) onCommit(next);
        }}
      />
    </label>
  );
}

export default CanvasSurface;
