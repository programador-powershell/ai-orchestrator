/**
 * Barra de esforço — liquid glass, redonda, transparente e animada.
 * 5 níveis (Baixo → Máximo). O nível é persistido e injeta uma diretiva
 * REAL de esforço no motor a cada envio (independente do provedor).
 */
import { useRef, useState, type CSSProperties } from "react";
import { effortLevels, useApp } from "../lib/store";

export function EffortSlider() {
  const effort = useApp((state) => state.settings.effort);
  const updateSettings = useApp((state) => state.updateSettings);
  const [active, setActive] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);

  const level = Math.max(0, Math.min(4, Math.round(effort)));

  return (
    <div
      className={`effort-slider ${active ? "active" : ""}`}
      title={`Esforço: ${effortLevels[level]} — quanto maior, mais raciocínio antes da resposta`}
    >
      <span className="effort-caption fast">Rápido</span>
      <div className="effort-track" ref={trackRef}>
        <input
          type="range"
          min={0}
          max={4}
          step={1}
          value={level}
          aria-label={`Nível de esforço: ${effortLevels[level]}`}
          onChange={(event) => updateSettings({ effort: Number(event.target.value) })}
          onPointerDown={() => setActive(true)}
          onPointerUp={() => setActive(false)}
          onBlur={() => setActive(false)}
        />
        <i
          className="effort-fill"
          style={
            {
              width: `calc((100% - 30px) * ${level / 4} + 24px)`,
              /* acento da aba, ficando mais escuro/denso conforme o esforço */
              background: `linear-gradient(90deg,
                hsl(var(--accent-h) var(--accent-s) 62% / ${0.14 + (level / 4) * 0.3}),
                hsl(var(--accent-h) var(--accent-s) ${56 - level * 4}% / ${0.28 + (level / 4) * 0.52}))`
            } as CSSProperties
          }
          aria-hidden="true"
        />
        <span
          className="effort-thumb"
          style={{ left: `calc((100% - 32px) * ${level / 4} + 1px)` } as CSSProperties}
          aria-hidden="true"
        >
          <span className="effort-tooltip">{effortLevels[level]}</span>
        </span>
      </div>
      <span className="effort-caption smart">Inteligente</span>
    </div>
  );
}
