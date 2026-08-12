"use client";

/**
 * Badge de ambiente no rodapé — estilo status bar do VS Code.
 *
 * Mostra onde o trabalho roda e abre uma lista suspensa (para cima) para
 * trocar entre Local, WSL, VPS e Nuvem. O usuário escolhe; a TI configura
 * cada ambiente. A escolha persiste em settings.environment.
 */

import { useEffect, useRef, useState } from "react";
import { Check, Cloud, Monitor, ServerCog, SquareTerminal } from "lucide-react";
import { ENVIRONMENTS, type Environment } from "../lib/connectors";
import { useApp } from "../lib/store";

const ICONS: Record<Environment, typeof Monitor> = {
  local: Monitor,
  wsl: SquareTerminal,
  vps: ServerCog,
  cloud: Cloud
};

export function EnvironmentBadge() {
  const environment = useApp((state) => state.settings.environment ?? "local");
  const updateSettings = useApp((state) => state.updateSettings);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = ENVIRONMENTS.find((item) => item.id === environment) ?? ENVIRONMENTS[0];
  const Icon = ICONS[current.id];

  return (
    <div className="envbadge" ref={rootRef}>
      <button
        className="envbadge__btn"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Ambiente onde o trabalho roda"
      >
        <Icon size={12} />
        {current.label}
      </button>
      {open ? (
        <div className="envbadge__menu glass-strong" role="listbox" aria-label="Ambiente">
          {ENVIRONMENTS.map((env) => {
            const Row = ICONS[env.id];
            return (
              <button
                key={env.id}
                role="option"
                aria-selected={env.id === environment}
                className={`envbadge__opt${env.id === environment ? " is-active" : ""}`}
                onClick={() => {
                  updateSettings({ environment: env.id });
                  setOpen(false);
                }}
              >
                <span className="envbadge__mark">{env.id === environment ? <Check size={12} /> : null}</span>
                <Row size={13} />
                <span className="envbadge__text">
                  <strong>{env.label}</strong>
                  <small>{env.detail}</small>
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
