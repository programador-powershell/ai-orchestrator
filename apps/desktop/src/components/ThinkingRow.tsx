/**
 * Indicador de progresso INLINE — fica na última linha da conversa enquanto o
 * modelo trabalha, como no Studio. Substitui o popup flutuante, que cobria o
 * conteúdo e não parecia parte do fluxo.
 *
 * O orbe muda com a etapa ("Pesquisa · planejando consultas" vira um globo
 * varrendo, "Elaborando plano…" vira os fios se entrelaçando). Três pontos
 * iguais em qualquer etapa diziam só que havia alguém do outro lado; a forma
 * diz o que essa pessoa está fazendo.
 */
import { memo } from "react";

import { ThinkingOrb } from "./ThinkingOrb";

export const ThinkingRow = memo(function ThinkingRow({ stage }: { stage: string }) {
  return (
    <article className="chatx-row assistant thinking-row" aria-live="polite">
      <span className="chatx-avatar" aria-hidden="true">
        {/* 20px é o desenho tunado da biblioteca para escala de texto, e cabe
            nos 26px úteis do avatar — abaixo disso viraria o glifo simples. */}
        <ThinkingOrb label={stage} size={20} className="orb--avatar" />
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
