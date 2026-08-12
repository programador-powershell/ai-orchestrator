"use client";

/**
 * Painel de conexões do pill da barra superior.
 *
 * O pill antes só dizia "Desconectado" e abria as Configurações inteiras.
 * Agora ele responde a QUÊ o app está conectado — gateway, runtime, VPS,
 * repositório, WSL, MCP — e cada linha leva à tela que adiciona aquilo.
 */

import { useEffect, useRef, useState } from "react";
import { Cable, Cpu, GitBranch, Plug, Plus, ServerCog, Terminal } from "lucide-react";
import {
  CONNECTION_LABELS,
  STATE_LABELS,
  collectConnections,
  summarize,
  type Connection,
  type ConnectionKind
} from "../lib/connections";
import { runtime } from "../lib/runtime";
import { useApp } from "../lib/store";

const ICONS: Record<ConnectionKind, typeof Plug> = {
  gateway: Plug,
  runtime: Cpu,
  vps: ServerCog,
  git: GitBranch,
  wsl: Terminal,
  mcp: Cable
};

/** Cada tipo de conexão é adicionado numa seção específica das Configurações. */
const ADD_TARGETS: Array<{ kind: ConnectionKind; label: string }> = [
  { kind: "vps", label: "Servidor de deploy (VPS)" },
  { kind: "gateway", label: "Gateway" },
  { kind: "mcp", label: "Servidor MCP" },
  { kind: "runtime", label: "Runtime local" }
];

export function ConnectionsPopover() {
  const settings = useApp((state) => state.settings);
  const session = useApp((state) => state.session);
  const runtimeStatus = useApp((state) => state.runtimeStatus);
  const setSettingsOpen = useApp((state) => state.setSettingsOpen);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // O status do runtime só era lido uma vez no boot — o pill mostraria um
  // estado frio para sempre. Enquanto o painel está aberto, revalida.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const refresh = () =>
      void runtime
        .status()
        .then((status) => alive && useApp.setState({ runtimeStatus: status }))
        .catch(() => undefined);
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [open]);

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

  const connections = collectConnections({
    gateway: {
      configured: Boolean(settings.gateway?.baseUrl),
      connected: Boolean(session),
      baseUrl: settings.gateway?.baseUrl
    },
    runtime: { running: runtimeStatus.running, model: runtimeStatus.version },
    servers: (settings.deployServers ?? []).map((server) => ({
      name: server.name,
      host: server.host,
      enabled: server.enabled,
      lastTestOutcome: server.lastTestOutcome
    })),
    // Todo servidor MCP cadastrado conta como habilitado — o store nao tem flag.
    mcpServers: (settings.mcpServers ?? []).map((server) => ({ name: server.name, enabled: true }))
  });

  const summary = summarize(connections);

  return (
    <div className="conn" ref={rootRef}>
      <button className="status-pill" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-haspopup="dialog">
        <span className={`dot ${summary.online ? "online" : ""}`} />
        <span className="pill-label">{summary.label}</span>
      </button>
      {open ? (
        <div className="conn-menu glass-strong" role="dialog" aria-label="Conexões">
          {connections.length ? (
            <ul className="conn-list">
              {connections.map((connection, index) => (
                <ConnectionRow key={`${connection.kind}-${index}`} connection={connection} />
              ))}
            </ul>
          ) : (
            <p className="conn-empty">Nenhuma conexão ativa. Adicione uma abaixo.</p>
          )}
          <div className="conn-add">
            <span className="conn-add__title">Adicionar</span>
            {ADD_TARGETS.map((target) => {
              const Icon = ICONS[target.kind];
              return (
                <button
                  key={target.kind}
                  className="conn-add__item"
                  onClick={() => {
                    setSettingsOpen(true);
                    setOpen(false);
                  }}
                >
                  <Icon size={12} />
                  {target.label}
                  <Plus size={12} className="conn-add__plus" />
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ConnectionRow({ connection }: { connection: Connection }) {
  const Icon = ICONS[connection.kind];
  return (
    <li className={`conn-row is-${connection.state}`}>
      <span className="conn-row__icon">
        <Icon size={13} />
      </span>
      <span className="conn-row__text">
        <strong>{connection.label}</strong>
        <small>
          {CONNECTION_LABELS[connection.kind]}
          {connection.detail ? ` · ${connection.detail}` : ""}
        </small>
      </span>
      <span className="conn-row__state">{STATE_LABELS[connection.state]}</span>
    </li>
  );
}
