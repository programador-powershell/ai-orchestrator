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
 *
 * NO MEIO, a equipe. Ela mora AQUI, e não na CrewSurface, de propósito: os
 * trabalhadores continuam rodando enquanto a pessoa olha outra superfície, e o
 * rodapé é o único pedaço da tela que sobrevive à troca. O slot não serve — ele
 * é da superfície ativa, e a equipe não é de nenhuma superfície.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, Users } from "lucide-react";
import type { Delegate, Environment } from "@aibot/contracts";
import { ENVIRONMENT_ICON, environmentInfo, environmentTitle } from "../lib/environments";
import { useApp, type CrewState } from "../lib/store";

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

/* -------------------------------- a equipe ------------------------------- */

/** O que o rodapé fixa enquanto a orquestração anda. */
export interface Orchestration {
  /** O objetivo em curso — a frase que fica presa no rodapé. */
  goal: string;
  /** Onde o plano está: onda e contagem, portão, ou o bot delegado. */
  detail: string;
}

function clampText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * Deriva o "orquestrando…" das linhas de tarefa e delegação que o store JÁ
 * acumula — nada novo viaja para cá.
 *
 * O casamento despacho↔desfecho é por `workerId`, não por `taskId`: um refazer
 * reexecuta a MESMA tarefa com outro trabalhador (w-1-t1-r2), e `crew.done` é um
 * mapa por tarefa — casar por tarefa faria a reexecução nascer "concluída"
 * porque a tentativa anterior deixou desfecho lá.
 */
export function orchestrationOf(crew: CrewState, delegations: Delegate[]): Orchestration | null {
  const finishedWorkers = new Set<string>();
  for (const done of Object.values(crew.done)) finishedWorkers.add(done.workerId);

  const running = crew.dispatches.filter((dispatch) => !finishedWorkers.has(dispatch.workerId));
  if (running.length > 0) {
    // O objetivo fixado é o do despacho MAIS RECENTE ainda rodando: numa onda
    // paralela é o último que saiu, e é o que melhor responde "o que a equipe
    // está fazendo agora".
    const current = running[running.length - 1];
    const wave = running.reduce((top, dispatch) => Math.max(top, dispatch.wave), 0);
    const total = new Set(crew.dispatches.map((dispatch) => dispatch.task.id)).size;
    return {
      goal: current?.task.goal || current?.task.title || "",
      detail: `onda ${wave} · ${running.length} de ${total} tarefa(s) em curso`
    };
  }

  // Onda fechada e portão aberto: o plano continua em curso, parado esperando
  // a decisão — sumir do rodapé aqui diria "acabou" para quem precisa decidir.
  if (crew.gate) {
    return { goal: crew.gate.reason ?? "", detail: "portão aberto — esperando decisão" };
  }

  for (let i = delegations.length - 1; i >= 0; i -= 1) {
    const delegation = delegations[i];
    if (!delegation || delegation.done === true) continue;
    return { goal: delegation.goal, detail: `com ${delegation.to}` };
  }

  return null;
}

/** O estado da orquestração, fixado no rodapé enquanto houver plano em curso. */
export function CrewBadge() {
  const crew = useApp((state) => state.crew);
  const delegations = useApp((state) => state.delegations);
  const current = useMemo(() => orchestrationOf(crew, delegations), [crew, delegations]);

  if (!current) return null;
  return (
    <div className="statusbar-items statusbar-crew" role="status" title={current.goal}>
      <span className="statusbar-item">
        <Users size={12} aria-hidden />
        <b>orquestrando…</b>
      </span>
      {current.goal !== "" ? <span className="statusbar-item">{clampText(current.goal, 80)}</span> : null}
      <span className="statusbar-item">{current.detail}</span>
    </div>
  );
}

/* ------------------------------- o ambiente ------------------------------ */

export function EnvBadge() {
  const environment = useApp((state) => state.environment);
  const environments = useApp((state) => state.environments);
  const environmentChosen = useApp((state) => state.environmentChosen);
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

  /*
   * O RODAPÉ HONESTO da jaula: sem escolha explícita e com o sandbox são, o
   * turno de TRABALHO roda no container por padrão (a regra é do gateway —
   * ver turnEnvironment em tools_process.go). Mostrar "Local" nessa condição
   * era o rodapé prometendo a estação enquanto o proc.run ia para a jaula —
   * exatamente o silêncio de execução que o seletor existe para acabar. O
   * rótulo "auto (sandbox)" só some quando a pessoa FIXA um ambiente, e aí o
   * fixado volta a mandar (inclusive sobre o padrão da jaula).
   */
  const dockerDisponivel = environments.some((item) => item.id === "docker" && item.available);
  const autoSandbox = !environmentChosen && dockerDisponivel;
  const Icon = autoSandbox
    ? ENVIRONMENT_ICON.docker
    : ENVIRONMENT_ICON[current.id] ?? ENVIRONMENT_ICON.local;

  function choose(id: Environment) {
    setEnvironment(id);
    setOpen(false);
  }

  return (
    <div className="envbadge" ref={root}>
      <button
        type="button"
        className="envbadge-button"
        data-auto={autoSandbox ? "sandbox" : undefined}
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="listbox"
        aria-expanded={open}
        // O motivo entra junto: o "indisponível" ao lado do rótulo diz QUE não
        // dá, e só o `detail` diz o que fazer para passar a dar.
        title={
          autoSandbox
            ? `turno de trabalho roda no sandbox (Docker), agindo na cópia do turno; ` +
              `conversa segue em ${current.label} — fixe um ambiente no menu para mandar sempre`
            : environmentTitle(current)
        }
      >
        <Icon size={12} aria-hidden />
        <span>{autoSandbox ? "auto (sandbox)" : current.label}</span>
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
            {autoSandbox ? (
              <>
                {" "}
                Sem escolha fixa, o <strong>turno de trabalho</strong> roda no sandbox (Docker);
                escolher abaixo fixa o ambiente e desliga o automático.
              </>
            ) : null}
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
      <CrewBadge />
      <StatusSlot />
    </footer>
  );
}

export default StatusBar;
