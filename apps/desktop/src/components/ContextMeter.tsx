/**
 * Medidor de contexto no topo — "1.4k / 131.1k" com barra, como no Studio.
 * Mostra quanto da janela do modelo a conversa já ocupa; fica em destaque
 * acima de 80%, antes de o auto-compact precisar entrar.
 */
import { useMemo } from "react";
import { contextUsage, formatTokens } from "../lib/contextMeter";
import { useApp } from "../lib/store";

/** Id do modelo que responde a aba — define a janela de contexto. */
function activeModelId(): string {
  const state = useApp.getState();
  const selection = state.settings.engines[state.mode];
  if (selection.kind === "model") return selection.target.model;
  if (selection.kind === "fusion") {
    const preset = state.settings.fusionPresets.find((item) => item.id === selection.presetId);
    return preset?.orchestrator.model ?? "";
  }
  return "";
}

export function ContextMeter() {
  const messages = useApp((state) => state.threads[state.mode].messages);
  const mode = useApp((state) => state.mode);
  const settings = useApp((state) => state.settings);

  const usage = useMemo(
    () => contextUsage(messages, activeModelId()),
    // Recalcula quando a conversa cresce ou o motor da aba muda.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [messages, mode, settings.engines]
  );

  if (!messages.length) return null;

  return (
    <div
      className={`ctx-meter ${usage.warning ? "warn" : ""}`}
      title={`Contexto usado nesta conversa: ${usage.used.toLocaleString("pt-BR")} de ${usage.total.toLocaleString("pt-BR")} tokens`}
    >
      <span className="ctx-label">
        {formatTokens(usage.used)} / {formatTokens(usage.total)}
      </span>
      <span className="ctx-track" aria-hidden="true">
        <span className="ctx-fill" style={{ width: `${Math.max(2, usage.ratio * 100)}%` }} />
      </span>
    </div>
  );
}
