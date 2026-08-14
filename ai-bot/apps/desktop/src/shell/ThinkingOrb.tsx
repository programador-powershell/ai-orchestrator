/**
 * ThinkingOrb — o indicador de raciocínio.
 *
 * SVG próprio: um anel de base com dois arcos girando em sentidos opostos. A cor
 * é sempre `var(--accent)`, que muda com o matiz do especialista ativo — assim o
 * orbe diz DE QUEM é o raciocínio sem precisar de texto extra.
 */

import { useEffect, useState } from "react";

export interface ThinkingOrbProps {
  /** Rótulo do que está acontecendo. String vazia = nada a mostrar. */
  label: string;
}

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * A animação é SMIL (`animateTransform`) e não CSS, então `prefers-reduced-motion`
 * do CSS não a alcança — precisa ser lida em JS e virar decisão de render.
 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => {
    // O jsdom do Vitest não implementa matchMedia; sem a guarda o teste quebra no primeiro render.
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia(REDUCED_MOTION_QUERY).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(REDUCED_MOTION_QUERY);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    // Relê no efeito: a preferência pode ter mudado entre o estado inicial e a montagem.
    setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return reduced;
}

export function ThinkingOrb({ label }: ThinkingOrbProps) {
  const reduced = usePrefersReducedMotion();

  // Sem rótulo não há raciocínio em curso: o componente some por inteiro em vez de
  // ficar um orbe parado na tela, que leria como "travado".
  if (!label) return null;

  return (
    <span className="thinking-orb" role="status" aria-live="polite" data-reduced={reduced ? "true" : "false"}>
      {reduced ? null : (
        <svg
          className="thinking-orb-svg"
          viewBox="0 0 24 24"
          width="16"
          height="16"
          aria-hidden="true"
          focusable="false"
        >
          {/* Anel de base: dá o círculo completo para os arcos correrem por cima. */}
          <circle cx="12" cy="12" r="9" fill="none" stroke="var(--accent)" strokeOpacity="0.18" strokeWidth="2" />

          {/* Arco externo, sentido horário. */}
          <g>
            <circle
              cx="12"
              cy="12"
              r="9"
              fill="none"
              stroke="var(--accent)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeDasharray="14 43"
            />
            <animateTransform
              attributeName="transform"
              attributeType="XML"
              type="rotate"
              from="0 12 12"
              to="360 12 12"
              dur="1.5s"
              repeatCount="indefinite"
            />
          </g>

          {/* Arco interno, sentido anti-horário e mais lento: o contraste de direção e
              de velocidade é o que faz o orbe parecer pensar em vez de carregar. */}
          <g>
            <circle
              cx="12"
              cy="12"
              r="5.5"
              fill="none"
              stroke="var(--accent)"
              strokeOpacity="0.62"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeDasharray="8 27"
            />
            <animateTransform
              attributeName="transform"
              attributeType="XML"
              type="rotate"
              from="360 12 12"
              to="0 12 12"
              dur="2.4s"
              repeatCount="indefinite"
            />
          </g>
        </svg>
      )}
      <span className="thinking-orb-label">{label}</span>
    </span>
  );
}

export default ThinkingOrb;
