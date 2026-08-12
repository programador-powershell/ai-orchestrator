/**
 * Indicador de progresso INLINE — fica na última linha da conversa enquanto o
 * modelo trabalha, como no Studio. Substitui o popup flutuante, que cobria o
 * conteúdo e não parecia parte do fluxo.
 *
 * Mostra a etapa atual ("Pesquisa · planejando consultas", "Fusion · …") ou o
 * estado neutro "Pensando", com três pontos animados.
 */
import { memo } from "react";
import { Sparkles } from "lucide-react";

export const ThinkingRow = memo(function ThinkingRow({ stage }: { stage: string }) {
  return (
    <article className="chatx-row assistant thinking-row" aria-live="polite">
      <span className="chatx-avatar" aria-hidden="true">
        <Sparkles size={13} />
      </span>
      <div className="chatx-col">
        <div className="thinking-inline">
          <span className="thinking-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="thinking-label">{stage || "Pensando"}</span>
        </div>
      </div>
    </article>
  );
});
