"use client";

/**
 * Badge de ambiente no rodapé — estilo status bar do VS Code.
 *
 * A escolha **roteia execução de verdade** no ambiente VPS: o comando sai pelo
 * cliente SSH para o servidor cadastrado, e o badge mostra o destino real
 * (`usuário@host`). WSL e nuvem ainda não têm executor próprio e continuam na
 * estação — o badge diz isso em vez de deixar supor.
 *
 * O destino aparecer no rodapé não é enfeite: é a diferença entre saber e
 * supor em qual máquina o próximo comando vai rodar.
 */

import { useEffect, useRef, useState } from "react";
import { Check, Cloud, Monitor, ServerCog, SquareTerminal } from "lucide-react";
import { ENVIRONMENTS, type Environment } from "../lib/connectors";
import { resolveRoute, routeLabel } from "../lib/ssh";
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
  // O destino REAL do próximo comando — não a intenção.
  const servers = useApp((state) => state.settings.deployServers);
  const route = resolveRoute(environment, servers ?? []);

  return (
    <div className="envbadge" ref={rootRef}>
      <button
        className="envbadge__btn"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={`Próximo comando roda em: ${routeLabel(route)}`}
      >
        <Icon size={12} />
        {current.label}
        {/* O destino, quando não é a estação — ou o aviso, quando não há rota. */}
        {route.kind === "ssh" ? <em className="envbadge__dest">{route.server.host}</em> : null}
        {route.kind === "blocked" ? <em className="envbadge__warn">sem rota</em> : null}
        {route.kind === "local" && environment !== "local" ? (
          <em className="envbadge__warn">estação</em>
        ) : null}
      </button>
      {open ? (
        <div className="envbadge__menu glass-strong" role="listbox" aria-label="Ambiente">
          {/* Onde o comando cai HOJE, com a configuração atual — antes de a
              pessoa escolher, não depois de o comando rodar no lugar errado. */}
          <p className="envbadge__note">
            {route.kind === "ssh" ? (
              <>
                Comandos vão para <strong>{routeLabel(route)}</strong> pelo cliente SSH do sistema.
              </>
            ) : route.kind === "blocked" ? (
              <>Nada roda: {route.reason}.</>
            ) : (
              <>
                Comandos rodam <strong>na sua estação</strong>. WSL e nuvem ainda não têm executor próprio;
                só o VPS roteia, e ele exige um servidor habilitado.
              </>
            )}
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
