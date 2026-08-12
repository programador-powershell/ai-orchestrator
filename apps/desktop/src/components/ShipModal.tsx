"use client";

/**
 * Janela de Build & Deploy — acionada pelo botão da barra superior.
 *
 * Saiu do rail esquerdo: lá ele espremia a árvore de arquivos e as sessões
 * num espaço que já era apertado. Aqui tem largura para as duas metades que
 * o fluxo exige: o destino (local ou VPS) e o pipeline.
 */

import { useEffect } from "react";
import { HardDrive, Rocket, ServerCog, X } from "lucide-react";
import { ShipPanel } from "./ShipPanel";
import { useApp } from "../lib/store";
import { useShip } from "../lib/ship/session";

interface Props {
  root: string;
  onClose: () => void;
}

export function ShipModal({ root, onClose }: Props) {
  const settings = useApp((state) => state.settings);
  const setSettingsOpen = useApp((state) => state.setSettingsOpen);
  const { source, run } = useShip();
  const servers = (settings.deployServers ?? []).filter((server) => server.enabled);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="shipmodal-backdrop" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="shipmodal glass-strong" role="dialog" aria-label="Build e deploy">
        <header className="shipmodal__head">
          <h2>
            <Rocket size={15} />
            Build &amp; deploy
          </h2>
          <button className="icon-button" onClick={onClose} aria-label="Fechar">
            <X size={15} />
          </button>
        </header>

        <div className="shipmodal__body">
          <div className="shipmodal__col">
            <ShipPanel root={root} />
          </div>

          <aside className="shipmodal__col shipmodal__col--targets">
            <h3 className="shipmodal__title">Destino</h3>
            <p className="setx-hint">
              O build roda nesta máquina. O resultado fica local ou vai para um servidor cadastrado.
            </p>

            <div className={`shipmodal__target${servers.length ? "" : " is-active"}`}>
              <span className="shipmodal__target-icon">
                <HardDrive size={14} />
              </span>
              <span className="shipmodal__target-text">
                <strong>Local</strong>
                <small>Artefato fica na pasta do projeto</small>
              </span>
            </div>

            {servers.map((server) => (
              <div key={server.id} className="shipmodal__target">
                <span className="shipmodal__target-icon">
                  <ServerCog size={14} />
                </span>
                <span className="shipmodal__target-text">
                  <strong>{server.name}</strong>
                  <small>
                    {server.user}@{server.host} · {server.environment}
                  </small>
                </span>
              </div>
            ))}

            <button
              className="lg-button ghost"
              onClick={() => {
                setSettingsOpen(true);
                onClose();
              }}
            >
              <ServerCog size={13} />
              {servers.length ? "Gerenciar servidores" : "Conectar um servidor"}
            </button>

            <p className="setx-hint shipmodal__caveat">
              O envio para o servidor ainda não está implementado — depende de um cliente SSH, que é dependência nova e
              precisa de aval de TI/SI. Hoje o pipeline roda local e o cadastro guarda o destino.
            </p>

            {source ? (
              <p className="setx-hint">
                Carregado: <strong>{source.kind}</strong>
                {run ? ` · último build: ${run.status}` : ""}
              </p>
            ) : null}
          </aside>
        </div>
      </section>
    </div>
  );
}
