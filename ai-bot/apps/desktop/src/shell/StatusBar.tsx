/**
 * O rodapé.
 *
 * Duas metades, e as duas existem pelo mesmo motivo: dizer o que a tela sozinha
 * não diz.
 *
 * À ESQUERDA, o seletor de ambiente. Ele não é enfeite — é a diferença entre
 * saber e supor em qual máquina o próximo comando vai rodar. Quem executa é o
 * gateway, então o catálogo (o que existe nesta máquina) e o ambiente em vigor
 * vêm de lá; a tela só desenha e pede a troca.
 *
 * À DIREITA, um slot: a superfície ativa injeta o próprio status por portal, do
 * mesmo jeito que injeta os botões na barra superior (ver `TopbarActions`). É o
 * que sustenta a tela única — trocar de especialista muda o conteúdo do rodapé
 * em vez de empilhar uma segunda barra embaixo da primeira.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";
import type { Environment } from "@aibot/contracts";
import { ENVIRONMENT_ICON, environmentInfo, environmentTitle } from "../lib/environments";
import { useApp } from "../lib/store";

/* --------------------------------- o slot -------------------------------- */

/** Um id, um host. Quem renderizar dois `StatusSlot` quebra o portal em silêncio. */
const SLOT_ID = "statusbar-slot";

/** O host. Vive dentro da `StatusBar`, e só lá. */
export function StatusSlot() {
  return <div id={SLOT_ID} className="statusbar-slot" />;
}

export function SurfaceStatus({ children }: { children: ReactNode }) {
  // O host é procurado num efeito, e não no corpo do render, porque no primeiro
  // render da superfície o div do slot ainda não foi comitado no DOM. Guardar em
  // estado força o segundo render — que é quando o portal tem para onde ir.
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setHost(document.getElementById(SLOT_ID));
  }, []);

  if (!host) return null;
  return createPortal(<div className="statusbar-items">{children}</div>, host);
}

/* ------------------------------- o ambiente ------------------------------ */

export function EnvBadge() {
  const environment = useApp((state) => state.environment);
  const environments = useApp((state) => state.environments);
  const setEnvironment = useApp((state) => state.setEnvironment);

  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    // `pointerdown` e não `click`: com `click` o menu só fecharia depois que o
    // botão de baixo já tivesse recebido o evento inteiro.
    function onPointerDown(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const current = environmentInfo(environments, environment);
  const Icon = ENVIRONMENT_ICON[current.id] ?? ENVIRONMENT_ICON.local;

  function choose(id: Environment) {
    setEnvironment(id);
    setOpen(false);
  }

  return (
    <div className="envbadge" ref={root}>
      <button
        type="button"
        className="envbadge-button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="listbox"
        aria-expanded={open}
        // O motivo entra junto: o "indisponível" ao lado do rótulo diz QUE não
        // dá, e só o `detail` diz o que fazer para passar a dar.
        title={environmentTitle(current)}
      >
        <Icon size={12} aria-hidden />
        <span>{current.label}</span>
        {/* O ambiente em vigor pode ter deixado de existir (a VPS saiu do ar, o
            Docker foi desligado). O aviso é mais honesto que o rótulo sozinho. */}
        {current.available ? null : <em className="envbadge-warn">indisponível</em>}
      </button>

      {open ? (
        <div className="envbadge-menu" role="listbox" aria-label="Ambiente de execução">
          {/* A escolha vale para o PRÓXIMO comando, não para o que já rodou —
              dizer isso aqui evita a leitura de que o botão migra a sessão. */}
          <p className="envbadge-note">
            Vale para o <strong>próximo comando</strong>. O que já rodou continua onde rodou.
          </p>

          {environments.map((item) => {
            const RowIcon = ENVIRONMENT_ICON[item.id] ?? ENVIRONMENT_ICON.local;
            const isActive = item.id === environment;
            return (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={isActive}
                className="envbadge-option"
                data-active={isActive ? "true" : "false"}
                disabled={!item.available}
                // O motivo no `title` é a diferença entre um item apagado sem
                // explicação e um item que diz o que falta para existir.
                title={item.available ? item.hint : item.detail ?? "indisponível nesta máquina"}
                onClick={() => choose(item.id)}
              >
                <span className="envbadge-mark">{isActive ? <Check size={12} aria-hidden /> : null}</span>
                <RowIcon size={13} aria-hidden />
                <span className="envbadge-text">
                  <strong>{item.label}</strong>
                  <small>{item.available ? item.hint : item.detail ?? item.hint}</small>
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/* -------------------------------- o rodapé ------------------------------- */

export function StatusBar() {
  return (
    <footer className="statusbar">
      <EnvBadge />
      <StatusSlot />
    </footer>
  );
}

export default StatusBar;
