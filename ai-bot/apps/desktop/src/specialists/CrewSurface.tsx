/**
 * Superfície do especialista de EQUIPE — o orquestrador e seus trabalhadores.
 *
 * O grafo é SVG escrito à mão (política da casa: nenhuma biblioteca de grafo é
 * aprovada). O layout é por ONDA — coluna = onda, linha = posição dentro da
 * onda — porque é exatamente assim que o gateway executa: a onda inteira roda em
 * paralelo e a próxima só começa quando a anterior fecha. Um layout de força,
 * mais "orgânico", espalharia os nós de um jeito que esconde o único fato que
 * importa numa olhada: o que roda AGORA e o que ainda está esperando.
 */

import { useMemo, useState } from "react";
import {
  Ban,
  Bot,
  Check,
  CornerDownLeft,
  GitBranch,
  Hand,
  Play,
  RotateCcw,
  Users,
  X
} from "lucide-react";
import type {
  Escalate,
  GateDecision,
  Task,
  TaskDispatch,
  TaskProgress,
  WorkerDone
} from "@aibot/contracts";
import { useApp } from "../lib/store";
import { SPECIALIST_ICON, specialistById } from "../lib/specialists";

/* ------------------------------- geometria ------------------------------ */

const NODE_W = 186;
const NODE_H = 62;
const GAP_X = 74;
const GAP_Y = 18;
const PAD = 20;

type NodeState = "idle" | "running" | "done" | "failed";

const STATE_LABEL: Record<NodeState, string> = {
  idle: "não começou",
  running: "rodando",
  done: "concluído",
  failed: "falhou"
};

/**
 * A cor do estado sai daqui, e não só do CSS, porque ela pinta também o ícone e
 * a aresta — atributos de SVG que o `.dag-node[data-state]` não alcança. O
 * `data-state` continua no retângulo: é ele que traz a borda e a transição já
 * definidas em surfaces.css.
 */
const STATE_INK: Record<NodeState, string> = {
  idle: "var(--faint)",
  running: "var(--accent)",
  done: "var(--ok)",
  failed: "var(--danger)"
};

interface CrewNode {
  task: Task;
  wave: number;
  x: number;
  y: number;
  state: NodeState;
  workerId: string;
  escalated: boolean;
}

interface CrewEdge {
  key: string;
  path: string;
  state: NodeState;
}

function clamp(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Identidade de uma escalação. A PERGUNTA entra na chave: o mesmo trabalhador
 *  pode escalar de novo, com outra dúvida, na mesma tarefa. */
function escalationKey(escalation: Escalate): string {
  return `${escalation.taskId}:${escalation.workerId}:${escalation.question}`;
}

/** Bézier horizontal: sai pela direita da origem, entra pela esquerda do destino. */
function curve(x1: number, y1: number, x2: number, y2: number): string {
  const reach = Math.max(30, (x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + reach} ${y1}, ${x2 - reach} ${y2}, ${x2} ${y2}`;
}

/* ------------------------------ componente ------------------------------ */

export function CrewSurface() {
  const crew = useApp((state) => state.crew);
  const specialists = useApp((state) => state.specialists);
  const send = useApp((state) => state.send);
  const decideGate = useApp((state) => state.decideGate);

  const [selected, setSelected] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  /**
   * Quais escalações já foram respondidas NESTA tela.
   *
   * O protocolo não tem "escalação resolvida": o gateway emite `escalate` e o
   * store só acumula. Sem esta marca a pergunta já respondida continuaria
   * ocupando o topo para sempre, e a faixa que existe para chamar atenção viraria
   * exatamente o que ninguém mais lê. A chave inclui a PERGUNTA porque o mesmo
   * trabalhador pode escalar de novo, com outra dúvida, na mesma tarefa.
   */
  const [answered, setAnswered] = useState<Record<string, true>>({});

  /**
   * Os índices são montados a partir dos VALORES, não das chaves.
   *
   * `progress` e `done` são `Record<string, …>` e o protocolo não promete se a
   * chave é o id da tarefa ou o do trabalhador. Ler o campo de dentro do objeto
   * funciona nos dois casos; assumir a chave errada deixaria a tela em branco
   * com os dados todos na memória.
   */
  const model = useMemo(() => {
    const tasks: Record<string, Task> = { ...crew.tasks };
    const dispatchByTask = new Map<string, TaskDispatch>();
    crew.dispatches.forEach((dispatch) => {
      if (!tasks[dispatch.task.id]) tasks[dispatch.task.id] = dispatch.task;
      dispatchByTask.set(dispatch.task.id, dispatch);
    });

    const doneByTask = new Map<string, WorkerDone>();
    for (const done of Object.values(crew.done)) doneByTask.set(done.taskId, done);

    const progressByTask = new Map<string, TaskProgress>();
    for (const progress of Object.values(crew.progress)) progressByTask.set(progress.taskId, progress);

    const escalationByTask = new Map<string, Escalate>();
    for (const escalation of crew.escalations) escalationByTask.set(escalation.taskId, escalation);

    // A onda vem do dispatch quando o trabalho já saiu; enquanto o plano só foi
    // desenhado, ela é deduzida da profundidade em dependsOn — a mesma conta que
    // o gateway faz. Sem isso a tarefa planejada não teria coluna nenhuma.
    const cache = new Map<string, number>();
    const waveOf = (id: string, stack: Set<string>): number => {
      const cached = cache.get(id);
      if (cached !== undefined) return cached;
      const dispatched = dispatchByTask.get(id);
      if (dispatched) {
        cache.set(id, dispatched.wave);
        return dispatched.wave;
      }
      // Ciclo é recusado lá no gateway; aqui ele só não pode travar o navegador.
      if (stack.has(id)) return 1;
      stack.add(id);
      let wave = 1;
      for (const dependency of tasks[id]?.dependsOn ?? []) {
        if (!tasks[dependency]) continue;
        wave = Math.max(wave, waveOf(dependency, stack) + 1);
      }
      stack.delete(id);
      cache.set(id, wave);
      return wave;
    };

    const stateOf = (id: string): NodeState => {
      const done = doneByTask.get(id);
      if (done) return done.ok ? "done" : "failed";
      return dispatchByTask.has(id) ? "running" : "idle";
    };

    const order = new Map<string, number>();
    crew.dispatches.forEach((dispatch, index) => order.set(dispatch.task.id, index));

    const byWave = new Map<number, Task[]>();
    for (const task of Object.values(tasks)) {
      const wave = waveOf(task.id, new Set<string>());
      byWave.set(wave, [...(byWave.get(wave) ?? []), task]);
    }

    const nodes: CrewNode[] = [];
    const positions = new Map<string, CrewNode>();
    for (const [wave, bucket] of [...byWave.entries()].sort((a, b) => a[0] - b[0])) {
      bucket
        .sort(
          (a, b) =>
            (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER) ||
            a.id.localeCompare(b.id)
        )
        .forEach((task, row) => {
          const node: CrewNode = {
            task,
            wave,
            x: PAD + (wave - 1) * (NODE_W + GAP_X),
            y: PAD + row * (NODE_H + GAP_Y),
            state: stateOf(task.id),
            workerId: dispatchByTask.get(task.id)?.workerId ?? "",
            escalated: escalationByTask.has(task.id)
          };
          nodes.push(node);
          positions.set(task.id, node);
        });
    }

    const edges: CrewEdge[] = [];
    for (const node of nodes) {
      for (const dependency of node.task.dependsOn ?? []) {
        const source = positions.get(dependency);
        if (!source) continue;
        edges.push({
          key: `${dependency}->${node.task.id}`,
          path: curve(source.x + NODE_W, source.y + NODE_H / 2, node.x, node.y + NODE_H / 2),
          state: source.state
        });
      }
    }

    const waves = byWave.size;
    const rows = byWave.size > 0 ? Math.max(...[...byWave.values()].map((bucket) => bucket.length)) : 0;

    return {
      nodes,
      edges,
      positions,
      doneByTask,
      progressByTask,
      running: nodes.filter((node) => node.state === "running").length,
      finished: nodes.filter((node) => node.state === "done").length,
      failed: nodes.filter((node) => node.state === "failed").length,
      currentWave: nodes.reduce((top, node) => (node.state === "running" ? Math.max(top, node.wave) : top), 0),
      width: waves > 0 ? PAD * 2 + waves * NODE_W + (waves - 1) * GAP_X : 0,
      height: rows > 0 ? PAD * 2 + rows * NODE_H + (rows - 1) * GAP_Y : 0
    };
  }, [crew]);

  // Pendentes primeiro: quem ainda trava o plano fica acima de quem já foi
  // respondido, sem que a resposta apague o registro da pergunta.
  const escalations = useMemo(() => {
    const pending = crew.escalations.filter((item) => !answered[escalationKey(item)]);
    const settled = crew.escalations.filter((item) => answered[escalationKey(item)]);
    return {
      pending,
      all: [...pending, ...settled],
      waiting: new Set(pending.map((item) => item.taskId))
    };
  }, [crew.escalations, answered]);

  // Sem escolha explícita a tela mostra o que precisa de atenção, nesta ordem:
  // quem escalou, quem falhou, quem está rodando. É a fila de quem trava o plano.
  const activeId = useMemo(() => {
    if (selected && model.positions.has(selected)) return selected;
    const escalated = model.nodes.find((node) => escalations.waiting.has(node.task.id));
    if (escalated) return escalated.task.id;
    for (const state of ["failed", "running", "done", "idle"] as NodeState[]) {
      const found = model.nodes.find((node) => node.state === state);
      if (found) return found.task.id;
    }
    return "";
  }, [selected, model, escalations]);

  const active = activeId ? model.positions.get(activeId) ?? null : null;
  const activeDone = activeId ? model.doneByTask.get(activeId) ?? null : null;
  const activeProgress = activeId ? model.progressByTask.get(activeId) ?? null : null;

  const answer = (escalation: Escalate) => {
    const key = escalationKey(escalation);
    const draft = (drafts[key] ?? "").trim();
    if (!draft) return;
    const task = model.positions.get(escalation.taskId)?.task;
    send(
      `Resposta para ${escalation.workerId} (tarefa ${escalation.taskId}${task ? ` — ${task.title}` : ""}):\n\n${draft}`
    );
    setDrafts((previous) => ({ ...previous, [key]: "" }));
    setAnswered((previous) => ({ ...previous, [key]: true }));
  };

  const gate = crew.gate;
  const decide = (decision: GateDecision) => {
    if (gate) decideGate(gate.gateId, decision);
  };

  const empty = model.nodes.length === 0 && crew.escalations.length === 0 && !gate;

  return (
    <section className="surface crew-surface">
      <div className="surface-toolbar">
        <span className="surface-title">Equipe</span>
        {model.currentWave > 0 ? <span className="chip">onda {model.currentWave}</span> : null}
        <span className="surface-toolbar-spacer" />
        {escalations.pending.length > 0 ? (
          <span className="chip" data-active="true">
            {escalations.pending.length} aguardando resposta
          </span>
        ) : null}
        <span className="chip">
          {model.finished}/{model.nodes.length} concluídas
        </span>
      </div>

      <div className="surface-body">
        {/*
          A ESCALAÇÃO FICA NO TOPO, e não como mais um item da lista de tarefas.

          Um trabalhador escalado é o único elemento desta tela que impede o
          plano inteiro de andar: ele não falhou nem terminou, ele PAROU para
          perguntar, e a onda seguinte não começa enquanto esta não fechar. Todo
          o resto aqui é observação — o nó verde já entregou, o cinza ainda vai
          começar, e nada que a pessoa faça com eles muda o ritmo. A pergunta do
          trabalhador é a única coisa que só destrava com uma ação humana, então
          ela ocupa o lugar onde os olhos batem primeiro. Enterrada no meio do
          grafo, vira o caso clássico da equipe parada por dez minutos porque
          ninguém viu que alguém tinha perguntado alguma coisa.
        */}
        {escalations.all.map((escalation) => {
          const key = escalationKey(escalation);
          const settled = answered[key] === true;
          const task = model.positions.get(escalation.taskId)?.task;
          return (
            <article
              key={key}
              className="card crew-escalation"
              data-answered={settled ? "true" : "false"}
              role={settled ? undefined : "alert"}
            >
              <div className="card-head">
                <Hand size={14} aria-hidden />
                <span className="card-title">{escalation.workerId} escalou</span>
                <span className="badge-risk" data-risk={settled ? "read" : "write"}>
                  {settled ? "respondida" : "aguardando"}
                </span>
              </div>
              <p className="card-eyebrow">
                tarefa {escalation.taskId}
                {task ? ` · ${task.title}` : ""}
              </p>
              <p className="card-body">{escalation.question}</p>

              {settled ? (
                <p className="card-body">
                  Resposta enviada como prompt — o orquestrador retoma a tarefa a partir dela.
                </p>
              ) : (
                <>
                  {escalation.options && escalation.options.length > 0 ? (
                    <div className="crew-escalation-options">
                      {escalation.options.map((option) => (
                        <button
                          key={option}
                          type="button"
                          className="chip"
                          data-active={(drafts[key] ?? "") === option ? "true" : "false"}
                          onClick={() => setDrafts((previous) => ({ ...previous, [key]: option }))}
                          title="Preenche a resposta; você ainda confirma no botão Responder"
                        >
                          {option}
                        </button>
                      ))}
                    </div>
                  ) : null}

                  <div className="card-foot">
                    <input
                      className="crew-reply"
                      value={drafts[key] ?? ""}
                      placeholder="Responda o trabalhador…"
                      aria-label={`Resposta para ${escalation.workerId}`}
                      onChange={(event) =>
                        setDrafts((previous) => ({ ...previous, [key]: event.target.value }))
                      }
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.shiftKey) {
                          event.preventDefault();
                          answer(escalation);
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={!(drafts[key] ?? "").trim()}
                      onClick={() => answer(escalation)}
                    >
                      <CornerDownLeft size={13} aria-hidden />
                      Responder
                    </button>
                  </div>
                </>
              )}
            </article>
          );
        })}

        {gate ? (
          <article className="card crew-gate" role="alertdialog" aria-label="Portão da onda">
            <div className="card-head">
              <span className="card-title">Portão aberto</span>
              <span className="badge-risk" data-risk="execute">
                decisão
              </span>
            </div>
            {gate.taskId ? <p className="card-eyebrow">tarefa {gate.taskId}</p> : null}
            <p className="card-body">
              {gate.reason ?? "A onda fechou com falha — decida como o plano segue."}
            </p>
            <div className="card-foot">
              <button type="button" className="btn btn-primary" onClick={() => decide("proceed")}>
                <Play size={13} aria-hidden />
                Seguir
              </button>
              <button type="button" className="btn" onClick={() => decide("retry")}>
                <RotateCcw size={13} aria-hidden />
                Refazer
              </button>
              <button type="button" className="btn btn-danger" onClick={() => decide("abort")}>
                <Ban size={13} aria-hidden />
                Abortar
              </button>
            </div>
          </article>
        ) : null}

        {empty ? (
          <div className="surface-empty">
            <Users size={26} aria-hidden />
            <b>Nenhuma equipe montada</b>
            <span>
              Descreva o objetivo na conversa. O orquestrador decide o tamanho da equipe, divide em
              tarefas e despacha em ondas — o grafo aparece aqui conforme os trabalhadores saem.
            </span>
          </div>
        ) : model.nodes.length > 0 ? (
          <div className="grid-2 crew-split">
            <div className="crew-graph">
              <svg
                className="dag"
                height={model.height}
                viewBox={`0 0 ${model.width} ${model.height}`}
                aria-label="Grafo das tarefas por onda"
              >
                {model.edges.map((edge) => (
                  <path
                    key={edge.key}
                    className="dag-edge"
                    d={edge.path}
                    stroke={STATE_INK[edge.state]}
                    strokeOpacity={edge.state === "idle" ? 0.5 : 0.85}
                  />
                ))}

                {model.nodes.map((node) => {
                  const definition = specialistById(specialists, node.task.specialist);
                  const Icon = SPECIALIST_ICON[node.task.specialist] ?? Bot;
                  const isActive = node.task.id === activeId;
                  const ink = STATE_INK[node.state];
                  return (
                    <g
                      key={node.task.id}
                      role="button"
                      tabIndex={0}
                      aria-label={`${node.task.title} — ${STATE_LABEL[node.state]}`}
                      onClick={() => setSelected(node.task.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setSelected(node.task.id);
                        }
                      }}
                    >
                      <title>{`${node.task.title} · onda ${node.wave} · ${STATE_LABEL[node.state]}`}</title>
                      <rect
                        className="dag-node"
                        data-state={node.state}
                        x={node.x}
                        y={node.y}
                        width={NODE_W}
                        height={NODE_H}
                        rx={14}
                        strokeWidth={isActive ? 2.5 : undefined}
                      >
                        {/* O pulso do "rodando" é SMIL e não CSS de propósito: fica
                            junto do nó que ele anima, e não depende de keyframe
                            declarado em outro arquivo para o estado ficar legível. */}
                        {node.state === "running" ? (
                          <animate
                            attributeName="stroke-opacity"
                            values="1;0.35;1"
                            dur="1.6s"
                            repeatCount="indefinite"
                          />
                        ) : null}
                      </rect>
                      <Icon x={node.x + 14} y={node.y + 13} width={15} height={15} color={ink} aria-hidden />
                      <text x={node.x + 38} y={node.y + 26}>
                        {clamp(node.task.title, 19)}
                      </text>
                      <text className="dag-label" x={node.x + 38} y={node.y + 44}>
                        {clamp(node.workerId || definition.name, 24)}
                      </text>
                      {node.escalated ? (
                        <circle
                          cx={node.x + NODE_W - 13}
                          cy={node.y + 13}
                          r={5}
                          fill={escalations.waiting.has(node.task.id) ? "var(--warn)" : "var(--faint)"}
                          stroke="var(--panel)"
                          strokeWidth={2}
                        >
                          <title>
                            {escalations.waiting.has(node.task.id)
                              ? "escalou e espera resposta"
                              : "escalou; já respondido"}
                          </title>
                        </circle>
                      ) : null}
                    </g>
                  );
                })}
              </svg>
            </div>

            <aside className="card crew-worker" aria-label="Trabalhador selecionado">
              {active ? (
                <>
                  <div className="card-head">
                    <span className="card-title">{active.task.title}</span>
                    <span
                      className="badge-risk"
                      data-risk={
                        active.state === "failed" ? "execute" : active.state === "done" ? "read" : "write"
                      }
                    >
                      {STATE_LABEL[active.state]}
                    </span>
                  </div>
                  <p className="card-eyebrow">
                    onda {active.wave} · {specialistById(specialists, active.task.specialist).name}
                    {active.workerId ? ` · ${active.workerId}` : ""}
                    {active.task.model ? ` · ${active.task.model}` : ""}
                  </p>

                  {active.task.goal ? <p className="card-body">{active.task.goal}</p> : null}

                  {active.task.dependsOn && active.task.dependsOn.length > 0 ? (
                    <p className="card-body">
                      <span className="card-eyebrow">depende de</span> {active.task.dependsOn.join(", ")}
                    </p>
                  ) : null}

                  {activeProgress ? (
                    <div className="card-body">
                      <span className="card-eyebrow">progresso</span>
                      <p>{activeProgress.note}</p>
                      {activeProgress.fraction !== undefined ? (
                        <div
                          className="progress-bar"
                          role="progressbar"
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={Math.round(activeProgress.fraction * 100)}
                        >
                          <span
                            style={{
                              width: `${Math.min(100, Math.max(0, activeProgress.fraction * 100))}%`
                            }}
                          />
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {activeDone ? (
                    <div className="card-body">
                      <span className="card-eyebrow">
                        {activeDone.ok ? <Check size={11} aria-hidden /> : <X size={11} aria-hidden />}{" "}
                        resultado
                      </span>
                      <pre className="crew-result" data-ok={activeDone.ok ? "true" : "false"}>
                        {activeDone.result || activeDone.error || "sem saída"}
                      </pre>
                    </div>
                  ) : null}

                  {activeDone?.worktree || activeDone?.branch || active.task.worktree ? (
                    <div className="card-foot">
                      <GitBranch size={13} aria-hidden />
                      <span className="crew-worktree" title={activeDone?.worktree ?? "cópia isolada"}>
                        {activeDone?.branch ?? "ramo ainda não informado"}
                        {activeDone?.worktree ? ` · ${activeDone.worktree}` : ""}
                      </span>
                    </div>
                  ) : null}
                </>
              ) : (
                <p className="card-body">Escolha um nó do grafo para ver o trabalhador.</p>
              )}
            </aside>
          </div>
        ) : null}
      </div>

      <div className="surface-status">
        <span>
          <b>{model.nodes.length}</b> tarefas
        </span>
        <span>
          rodando <b>{model.running}</b> · concluídas <b>{model.finished}</b> · falhas{" "}
          <b>{model.failed}</b>
        </span>
        <span className="surface-toolbar-spacer" />
        <span>
          {gate ? "portão aberto" : escalations.pending.length > 0 ? "aguardando resposta" : "—"}
        </span>
      </div>
    </section>
  );
}

export default CrewSurface;
