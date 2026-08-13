"use client";

/**
 * Badge de ambiente no rodapé — estilo status bar do VS Code.
 *
 * ATENÇÃO, e está dito na tela: hoje esta escolha **não roteia execução**.
 * Ferramenta, terminal e code mode rodam todos na ESTAÇÃO, qualquer que seja o
 * item marcado aqui. Rodar de fato em WSL, VPS ou nuvem depende do cliente SSH
 * que ainda não existe no binário (ver a linha "Deploy na VPS" no README).
 *
 * Deixar o seletor prometendo roteamento seria o mesmo gating cosmético que o
 * resto do produto passou a sessão eliminando — quem lê "VPS" no rodapé
 * assumiria que o comando não toca a máquina dele, e tocaria.
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
        title="Ambiente pretendido. A execução ainda acontece na estação — falta o cliente SSH."
      >
        <Icon size={12} />
        {current.label}
        {environment !== "local" ? <em className="envbadge__warn">local</em> : null}
      </button>
      {open ? (
        <div className="envbadge__menu glass-strong" role="listbox" aria-label="Ambiente">
          {/* A ressalva vem PRIMEIRO: quem abre a lista para escolher "VPS"
              precisa saber, antes de clicar, que o comando vai rodar aqui. */}
          <p className="envbadge__note">
            Por enquanto tudo roda <strong>na sua estação</strong>. Esta escolha registra a intenção; o
            roteamento depende do cliente SSH, que ainda não existe no binário.
          </p>
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
