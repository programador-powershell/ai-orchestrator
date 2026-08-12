"use client";

/**
 * Janela "Conectar" — galeria de apps (MCP) + seletor de ambiente.
 *
 * Aberta pelo indicador de conexão da barra superior (antes ele abria as
 * Configurações inteiras). O usuário conecta os apps DELE e escolhe onde o
 * trabalho roda; a lista aprovada e a configuração de cada ambiente são do
 * admin. Autenticação de conector pela conta corporativa — regra da empresa.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Search, ServerCog, ShieldCheck, X } from "lucide-react";
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  CONNECTOR_ACCENT,
  CONNECTOR_CATALOG,
  ENVIRONMENTS,
  connectorState,
  filterConnectors,
  type Connector,
  type ConnectorCategory,
  type Environment
} from "../lib/connectors";
import { useApp } from "../lib/store";

const AUTH_HINT: Record<Connector["auth"], string> = {
  microsoft: "Autenticação pela conta corporativa Microsoft, liberada pela TI.",
  oauth: "Conexão via endpoint MCP aprovado pela TI.",
  endpoint: "Servidor MCP self-hosted — informe o endpoint."
};

function monogram(name: string): string {
  const parts = name.replace(/[^\p{L}\p{N} ]/gu, "").split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

export function ConnectModal({ onClose }: { onClose: () => void }) {
  const settings = useApp((state) => state.settings);
  const updateSettings = useApp((state) => state.updateSettings);
  const setSettingsOpen = useApp((state) => state.setSettingsOpen);
  const runtimeStatus = useApp((state) => state.runtimeStatus);
  const session = useApp((state) => state.session);

  const [category, setCategory] = useState<ConnectorCategory | "todos">("todos");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Connector | null>(null);
  const [endpoint, setEndpoint] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const mcpServers = settings.mcpServers ?? [];
  const connected = useMemo(() => mcpServers.map((server) => ({ name: server.name })), [mcpServers]);
  const shown = useMemo(() => filterConnectors(CONNECTOR_CATALOG, { category, query }), [category, query]);

  const stateOf = (connector: Connector) => connectorState(connector, connected, null);

  function connect(connector: Connector, url: string) {
    if (!url.trim()) return;
    updateSettings({ mcpServers: [...mcpServers, { name: connector.name, url: url.trim() }] });
    setSelected(null);
    setEndpoint("");
  }

  function disconnect(connector: Connector) {
    updateSettings({
      mcpServers: mcpServers.filter(
        (server) => server.name.toLowerCase() !== connector.name.toLowerCase()
      )
    });
    setSelected(null);
  }

  return (
    <div className="connx-backdrop" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="connx glass-strong" role="dialog" aria-label="Conectar aplicativos">
        <header className="connx__head">
          <div className="connx__title">
            <h2>Conectar Apps</h2>
            <p>Conecte seus aplicativos e escolha onde o trabalho roda.</p>
          </div>
          <label className="connx__search">
            <Search size={14} />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar aplicativos…"
              aria-label="Buscar aplicativos"
            />
          </label>
          <button className="icon-button" onClick={onClose} aria-label="Fechar">
            <X size={16} />
          </button>
        </header>

        {/* Ambiente: onde o trabalho roda. O usuário escolhe, a TI configura. */}
        <section className="connx__envs" aria-label="Ambiente de execução">
          {ENVIRONMENTS.map((env) => (
            <button
              key={env.id}
              className={`connx__env${settings.environment === env.id ? " is-active" : ""}`}
              onClick={() => updateSettings({ environment: env.id as Environment })}
              aria-pressed={settings.environment === env.id}
            >
              <strong>{env.label}</strong>
              <small>{env.detail}</small>
            </button>
          ))}
        </section>

        <nav className="connx__cats" aria-label="Categorias">
          {CATEGORY_ORDER.map((cat) => (
            <button
              key={cat}
              className={`connx__cat${category === cat ? " is-active" : ""}`}
              onClick={() => setCategory(cat)}
            >
              {CATEGORY_LABELS[cat]}
            </button>
          ))}
        </nav>

        <div className="connx__grid">
          {shown.map((connector) => {
            const state = stateOf(connector);
            return (
              <button
                key={connector.id}
                className={`connx__card${selected?.id === connector.id ? " is-selected" : ""}`}
                onClick={() => {
                  setSelected(connector);
                  setEndpoint("");
                }}
              >
                <span className="connx__logo" style={{ background: CONNECTOR_ACCENT[connector.id] ?? "var(--accent)" }}>
                  {monogram(connector.name)}
                </span>
                <span className="connx__body">
                  <span className="connx__name">{connector.name}</span>
                  <span className="connx__desc">{connector.description}</span>
                </span>
                <span className={`connx__badge is-${state}`}>
                  {state === "connected" ? "Conectado" : connector.isNew ? "Novo" : "Disponível"}
                </span>
              </button>
            );
          })}
          {!shown.length ? <p className="connx__empty">Nenhum aplicativo encontrado.</p> : null}
        </div>

        {selected ? (
          <div className="connx__detail">
            <div className="connx__detail-head">
              <strong>{selected.name}</strong>
              <small>{AUTH_HINT[selected.auth]}</small>
            </div>
            {stateOf(selected) === "connected" ? (
              <button className="lg-button danger" onClick={() => disconnect(selected)}>
                Desconectar
              </button>
            ) : (
              <div className="connx__connect">
                <input
                  className="connx__endpoint"
                  value={endpoint}
                  onChange={(event) => setEndpoint(event.target.value)}
                  placeholder="Endpoint MCP aprovado (https://…)"
                  spellCheck={false}
                  onKeyDown={(event) => event.key === "Enter" && connect(selected, endpoint)}
                />
                <button className="lg-button primary" disabled={!endpoint.trim()} onClick={() => connect(selected, endpoint)}>
                  Conectar
                </button>
              </div>
            )}
          </div>
        ) : null}

        <footer className="connx__foot">
          <span className="connx__sys">
            <ShieldCheck size={13} />
            Conexões seguras via MCP — seus dados permanecem sob seu controle.
          </span>
          <span className="connx__status">
            <span className={`connx__dot${session ? " on" : ""}`} />
            Gateway {session ? "conectado" : "desconectado"}
            <span className={`connx__dot${runtimeStatus.running ? " on" : ""}`} />
            Runtime {runtimeStatus.running ? "ativo" : "parado"}
            <button className="connx__manage" onClick={() => { setSettingsOpen(true); onClose(); }}>
              <ServerCog size={12} />
              Servidores &amp; runtime
            </button>
          </span>
        </footer>
      </section>
    </div>
  );
}
