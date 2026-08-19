/**
 * Presets de dispositivo (Desktop/Tablet/Mobile) — dados + a regra de
 * aplicação, portados do AI-Orchestrator (modes/DesignView.tsx: DEVICES e
 * applyDevice).
 *
 * Lá a aplicação mexia direto no store; aqui ela é FUNÇÃO PURA que devolve o
 * doc novo e o id do frame afetado — a superfície decide onde pendurar o
 * resultado e é ela quem chama pushHistory ANTES (mesma ordem do
 * orquestrador: registrar o estado, depois aplicar).
 *
 * As medidas são as de viewport consagradas (1440×1024 / 768×1024 / 375×812 —
 * iPhone X e o que todo figma de mercado usa). Não são tokens de tema: são o
 * TAMANHO DO FRAME que o usuário está desenhando.
 */
import { addNode, createNode, updateNode, type CanvasDoc } from "./canvasDoc";

export type DeviceId = "desktop" | "tablet" | "mobile";

export interface DevicePreset {
  id: DeviceId;
  label: string;
  w: number;
  h: number;
}

export const DEVICES: readonly DevicePreset[] = [
  { id: "desktop", label: "Desktop", w: 1440, h: 1024 },
  { id: "tablet", label: "Tablet", w: 768, h: 1024 },
  { id: "mobile", label: "Mobile", w: 375, h: 812 }
];

export interface DevicePresetResult {
  doc: CanvasDoc;
  /** O frame redimensionado (ou recém-criado) — a superfície o seleciona. */
  selectedId: string;
}

/**
 * Aplica o preset ao frame selecionado (ou ao 1º frame; cria um se não
 * houver). A cascata de fallbacks vem do orquestrador e existe porque o botão
 * precisa SEMPRE produzir efeito visível: preset que silenciosamente não faz
 * nada parece botão quebrado.
 */
export function applyDevicePreset(
  doc: CanvasDoc,
  selectedId: string | null,
  preset: Pick<DevicePreset, "w" | "h">
): DevicePresetResult {
  const target =
    doc.nodes.find((node) => node.id === selectedId && node.type === "frame") ??
    doc.nodes.find((node) => node.type === "frame");
  if (target) {
    return { doc: updateNode(doc, target.id, { w: preset.w, h: preset.h }), selectedId: target.id };
  }
  // Sem frame nenhum: nasce um em (40, 40) — afastado da origem para as alças
  // de resize não colarem na borda do viewport.
  const frame = createNode(doc, "frame", { x: 40, y: 40, w: preset.w, h: preset.h });
  return { doc: addNode(doc, frame), selectedId: frame.id };
}
