/**
 * Superfície do especialista de TRABALHO.
 *
 * Quadro de três colunas alimentado por `crew` — nada aqui é estado próprio da
 * tela.
 *
 * Não existe arrastar. Quem move a tarefa é o especialista, porque mover de
 * verdade significa despachar, escalar ou concluir trabalho do outro lado. Um
 * cartão que anda na tela sem isso acontecer no gateway é uma mentira bonita: a
 * tela volta a mostrar a verdade no próximo `task.progress`, com a pessoa
 * jurando que já tinha movido. Por isso o botão é “pedir para mover” — ele
 * escreve a frase no campo de texto e deixa o pedido ser conversa.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Bot,
  CircleAlert,
  CircleCheckBig,
  CircleDashed,
  CornerDownRight,
  GitBranch,
  LoaderCircle,
  TriangleAlert
} from "lucide-react";
import type { Escalate, Task, TaskProgress, WorkerDone } from "@aibot/contracts";
import { outcomeOf } from "../lib/crew";
import { SPECIALIST_ICON } from "../lib/specialists";
import { useApp } from "../lib/store";
import { ConversationSurface, hueStyle, resolveSpecialist } from "./ConversationSurface";

/* --------------------------------- colunas ------------------------------ */

type Lane = "todo" | "doing" | "done";

const LANES: { id: Lane; title: string; hint: string }[] = [
  { id: "todo", title: "A fazer", hint: "planejadas, ainda sem worker" },
  { id: "doing", title: "Fazendo", hint: "despachadas — há um worker nelas" },
  { id: "done", title: "Feito", hint: "o worker terminou, com ou sem sucesso" }
];

const LANE_TITLE: Record<Lane, string> = { todo: "A fazer", doing: "Fazendo", done: "Feito" };

/** Para onde faz sentido pedir que a tarefa vá a seguir. */
const NEXT_LANE: Record<Lane, Lane> = { todo: "doing", doing: "done", done: "todo" };

interface CardModel {
  task: Task;
  lane: Lane;
  workerId: string;
  wave: number;
  progress: TaskProgress | null;
  done: WorkerDone | null;
  escalation: Escalate | null;
}

function percent(fraction: number): number {
  return Math.round(Math.min(1, Math.max(0, fraction)) * 100);
}

/* --------------------------------- cartão ------------------------------- */

function TaskCard({ card }: { card: CardModel }): ReactNode {
  const specialists = useApp((state) => state.specialists);
  const setInput = useApp((state) => state.setInput);
  const [asked, setAsked] = useState(false);

  useEffect(() => {
    if (!asked) return;
    const timer = window.setTimeout(() => setAsked(false), 2200);
    return () => window.clearTimeout(timer);
  }, [asked]);

  const spec = resolveSpecialist(specialists, card.task.specialist);
  const Icon = SPECIALIST_ICON[spec.id] ?? Bot;
  const target = NEXT_LANE[card.lane];
  // O desfecho do trabalhador vem da mesma regra que o grafo da Equipe usa. Aqui
  // ele era `!card.done.ok`, e por isso o cartão de quem só fez uma pergunta
  // dizia "falhou" com triângulo de alerta.
  const outcome = card.done !== null ? outcomeOf(card.done) : null;

  function askToMove(): void {
    // Preenche o composer em vez de enviar: o texto é um PEDIDO, e pedido a
    // gente lê antes de mandar. Enviar sozinho tiraria da pessoa a chance de
    // dizer por que está movendo — que é justamente o que o especialista usa
    // para decidir se move, se pergunta antes ou se recusa.
    setInput(`Mover a tarefa "${card.task.title}" (${card.task.id}) para ${LANE_TITLE[target]} porque `);
    setAsked(true);
  }

  return (
    // `data-hue` não é enfeite: é o gancho que refaz --accent a partir da matiz
    // local (tokens.css). Só escrever --accent-h inline não muda cor nenhuma —
    // o --accent já veio calculado do shell e desce herdado como cor pronta.
    <article className="card task-card" data-state={card.lane} data-hue={spec.id} style={hueStyle(spec.hue)}>
      <div className="card-head">
        <span className="line-avatar" title={`${spec.name} — ${spec.tagline}`}>
          <Icon size={13} aria-hidden="true" />
        </span>
        <span className="card-title" title={card.task.goal || card.task.title}>
          {card.task.title}
        </span>
      </div>

      <div className="task-chips">
        <span className="chip" title={LANES.find((lane) => lane.id === card.lane)?.hint}>
          {card.lane === "done" ? (
            outcome === "escalated" ? (
              <>
                <CircleAlert size={12} aria-hidden="true" /> escalou
              </>
            ) : outcome === "failed" ? (
              <>
                <TriangleAlert size={12} aria-hidden="true" /> falhou
              </>
            ) : (
              <>
                <CircleCheckBig size={12} aria-hidden="true" /> feito
              </>
            )
          ) : card.lane === "doing" ? (
            <>
              <LoaderCircle size={12} aria-hidden="true" /> fazendo
            </>
          ) : (
            <>
              <CircleDashed size={12} aria-hidden="true" /> a fazer
            </>
          )}
        </span>
        <span className="chip" title="especialista dono da tarefa">
          <Icon size={12} aria-hidden="true" />
          {spec.name}
        </span>
        {card.wave > 0 ? (
          <span className="chip" title="onda do plano: tarefas da mesma onda rodam juntas">
            onda {card.wave}
          </span>
        ) : null}
        {card.task.dependsOn && card.task.dependsOn.length > 0 ? (
          <span className="chip" title={`depende de: ${card.task.dependsOn.join(", ")}`}>
            {card.task.dependsOn.length} dep.
          </span>
        ) : null}
        {card.task.worktree ? (
          <span className="chip" title="roda numa cópia isolada do repositório">
            <GitBranch size={12} aria-hidden="true" />
            worktree
          </span>
        ) : null}
      </div>

      {card.progress !== null && card.lane !== "done" ? (
        <div className="card-body" title={card.workerId !== "" ? `worker ${card.workerId}` : undefined}>
          {card.progress.note}
          {typeof card.progress.fraction === "number" ? (
            <span className="task-bar" aria-hidden="true">
              {/* A largura é dado que só existe em tempo de execução; não há
                  classe possível para 37%. */}
              <span style={{ width: `${percent(card.progress.fraction)}%` }} />
            </span>
          ) : null}
        </div>
      ) : null}

      {/*
        Escalação não repete o corpo: o `error` de quem escalou é "escalado: <a
        pergunta>", e o bloco de baixo já mostra a pergunta. Imprimir os dois
        colocava a mesma frase duas vezes no mesmo cartão.

        A condição olha `card.escalation`, e não só o desfecho, porque os dois
        eventos são independentes: se o `escalate` se perder e o `worker.done`
        chegar, suprimir aqui deixaria o cartão com o chip "escalou" e NENHUM
        texto — a pergunta só existe no `error`.
      */}
      {card.done !== null && !(outcome === "escalated" && card.escalation !== null) ? (
        <div className="card-body">{card.done.ok ? card.done.result || "concluída" : card.done.error || "falhou"}</div>
      ) : null}

      {card.escalation !== null ? (
        // "perguntou", e não "está esperando resposta": quem sabe se a pergunta já
        // foi respondida é a tela da Equipe, onde a resposta é digitada, e essa
        // marca não sai de lá (é estado local, não do protocolo). Afirmar espera
        // aqui deixava o cartão pedindo para sempre algo que já foi feito.
        <div className="card-body" title={card.escalation.question}>
          <CircleAlert size={12} aria-hidden="true" /> o worker parou e perguntou:{" "}
          {card.escalation.question}
        </div>
      ) : null}

      <div className="card-foot">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={askToMove}
          title={`escreve no campo de texto o pedido para mover para ${LANE_TITLE[target]} — quem move é o especialista`}
        >
          <CornerDownRight size={12} aria-hidden="true" />
          {asked ? "está no campo de texto" : "pedir para mover"}
        </button>
      </div>
    </article>
  );
}

/* -------------------------------- superfície ---------------------------- */

export function BoardSurface(): ReactNode {
  const tasks = useApp((state) => state.crew.tasks);
  const dispatches = useApp((state) => state.crew.dispatches);
  const progress = useApp((state) => state.crew.progress);
  const done = useApp((state) => state.crew.done);
  const escalations = useApp((state) => state.crew.escalations);

  const cards = useMemo<CardModel[]>(() => {
    const dispatchByTask = new Map<string, { workerId: string; wave: number }>();
    for (const dispatch of dispatches) {
      dispatchByTask.set(dispatch.task.id, { workerId: dispatch.workerId, wave: dispatch.wave });
    }
    const escalationByTask = new Map<string, Escalate>();
    for (const item of escalations) escalationByTask.set(item.taskId, item);

    return Object.values(tasks).map((task) => {
      const dispatch = dispatchByTask.get(task.id);
      const finished = done[task.id] ?? null;
      const running = progress[task.id] ?? null;
      // A coluna é DERIVADA dos eventos, nunca guardada: `worker.done` é o único
      // sinal de que acabou, despacho e progresso são os únicos sinais de que
      // começou. Guardar a coluna criaria um estado que discorda do gateway.
      const lane: Lane = finished !== null ? "done" : running !== null || dispatch !== undefined ? "doing" : "todo";
      return {
        task,
        lane,
        workerId: dispatch?.workerId ?? finished?.workerId ?? running?.workerId ?? "",
        wave: dispatch?.wave ?? 0,
        progress: running,
        done: finished,
        escalation: escalationByTask.get(task.id) ?? null
      };
    });
  }, [tasks, dispatches, progress, done, escalations]);

  // "Concluídas" conta quem CONCLUIU, e a coluna "Feito" não é isso: ela é "o
  // worker terminou, com ou sem sucesso" (ver o hint de LANES), então falha e
  // escalação moram lá também. Contar a coluna dizia que a tarefa que parou para
  // perguntar estava pronta — e é o mesmo número que a Equipe mostra, por
  // `state === "done"`, discordando deste.
  const finished = cards.filter((card) => card.done !== null && card.done.ok).length;

  return (
    <div className="surface board-surface">
      <div className="surface-toolbar">
        <span className="surface-title">Quadro</span>
        <span className="chip">
          {finished}/{cards.length} concluídas
        </span>
        <span className="surface-toolbar-spacer" />
        <span
          className="chip"
          title="A coluna vem de task.dispatch, task.progress e worker.done — eventos do gateway. A tela mostra; ela não decide."
        >
          sem arrastar: mover é conversa
        </span>
      </div>

      <div className="surface-body board-split">
        <section className="board" aria-label="quadro de tarefas">
          {cards.length === 0 ? (
            <div className="surface-empty">
              <p>Nenhuma tarefa ainda.</p>
              <p>
                Peça um plano ao especialista de trabalho. Cada tarefa despachada vira um cartão, e a coluna
                acompanha o que o worker relata.
              </p>
            </div>
          ) : (
            LANES.map((lane) => {
              const items = cards.filter((card) => card.lane === lane.id);
              return (
                <div className="board-column" key={lane.id} data-lane={lane.id}>
                  <div className="board-column-head" title={lane.hint}>
                    <span>{lane.title}</span>
                    <span className="board-column-count">{items.length}</span>
                  </div>
                  <div className="board-column-list">
                    {items.length === 0 ? (
                      <p className="board-column-empty">vazio</p>
                    ) : (
                      items.map((card) => <TaskCard card={card} key={card.task.id} />)
                    )}
                  </div>
                </div>
              );
            })
          )}
        </section>

        <aside className="board-talk" aria-label="conversa">
          <ConversationSurface compact />
        </aside>
      </div>

      <div className="surface-status">
        <span>
          tarefas <b>{cards.length}</b>
        </span>
        <span>
          fazendo <b>{cards.filter((card) => card.lane === "doing").length}</b>
        </span>
        {/*
          "Concluídas", e não "feitas": a palavra tem de ser a do NÚMERO. A coluna
          "Feito" conta quem o worker terminou, com ou sem sucesso — falha e
          escalação moram lá —, e este número conta só quem entregou. Com a mesma
          palavra nos dois, o rodapé passava a contradizer a coluna logo acima.
        */}
        <span>
          concluídas <b>{finished}</b>
        </span>
        <span>estado muda pelo bot, não pelo mouse</span>
      </div>
    </div>
  );
}

export default BoardSurface;
