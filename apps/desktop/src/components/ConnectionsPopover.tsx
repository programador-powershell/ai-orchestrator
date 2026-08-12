"use client";

/**
 * Indicador de conexão da barra superior + janela de conectar apps.
 *
 * O pill mostra a QUÊ o app está conectado (gateway, runtime, VPS, MCP…) e,
 * ao clicar, abre a janela "Conectar Apps" — não as Configurações inteiras.
 * O estado do runtime é revalidado enquanto o pill está montado (antes só era
 * lido uma vez no boot).
 */

import { useEffect, useState } from "react";
import { collectConnections, summarize } from "../lib/connections";
import { runtime } from "../lib/runtime";
import { useApp } from "../lib/store";
import { ConnectModal } from "./ConnectModal";

export function ConnectionsPopover() {
  const settings = useApp((state) => state.settings);
  const session = useApp((state) => state.session);
  const runtimeStatus = useApp((state) => state.runtimeStatus);
  const [open, setOpen] = useState(false);

  // Sem polling o pill mostraria um estado frio: runtime.status() só rodava no
  // boot. Enquanto o app está vivo, revalida a cada 5s.
  useEffect(() => {
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
  }, []);

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
    mcpServers: (settings.mcpServers ?? []).map((server) => ({ name: server.name, enabled: true }))
  });

  const summary = summarize(connections);

  return (
    <>
      <button className="status-pill" onClick={() => setOpen(true)} aria-haspopup="dialog">
        <span className={`dot ${summary.online ? "online" : ""}`} />
        <span className="pill-label">{summary.label}</span>
      </button>
      {open ? <ConnectModal onClose={() => setOpen(false)} /> : null}
    </>
  );
}
