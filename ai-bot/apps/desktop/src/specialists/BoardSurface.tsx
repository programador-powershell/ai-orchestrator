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
  CalendarClock,
  CircleAlert,
  CircleCheckBig,
  CircleDashed,
  CornerDownRight,
  GitBranch,
  LoaderCircle,
  TriangleAlert
} from "lucide-react";
import type { ConversationLine, Escalate, Task, TaskProgress, WorkerDone } from "@aibot/contracts";
import { outcomeOf } from "../lib/crew";
import { SPECIALIST_ICON } from "../lib/specialists";
import { useApp } from "../lib/store";
import { BoardTopbarActions, TopbarActions } from "../shell/TopbarActions";
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

/* ------------------------------- automações ------------------------------ */

/**
 * Uma automação AGENDADA DE VERDADE — derivada das chamadas `schedule.*` que
 * deram certo nas linhas da conversa, nunca de estado próprio da tela.
 *
 * Este é o conserto anti-casca da janela de Trabalho: o quadro de colunas é
 * alimentado por `crew` (task.dispatch/progress/done), eventos que o bot de
 * TRABALHO não emite — quem os emite é a Equipe. Na sessão do próprio bot, a
 * entrega dele é o gatilho (`schedule.create/list/remove` — ver
 * specialist.go), e sem esta seção a tela ficava no "Nenhuma tarefa ainda"
 * enquanto o bot agendava automações que ninguém via.
 */
export interface Automacao {
  id: string;
  /** O prompt que o gatilho dispara — o "o quê" da automação. */
  prompt: string;
  /** "a cada 1h" / "às 07:30" — a redação do próprio gateway. */
  agenda: string;
  nota: string;
  /** "20/08/2026 15:04" quando o texto do resultado a traz; "" sem ela. */
  proximo: string;
  disparos: number;
  desligada: boolean;
}

function argTexto(args: unknown, chave: string): string {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return "";
  const valor = (args as Record<string, unknown>)[chave];
  return typeof valor === "string" ? valor.trim() : "";
}

/**
 * O recibo do `schedule.create`: "gatilho <id> criado (<agenda>). primeiro
 * disparo em <dd/mm/aaaa hh:mm>…" (tools_flow.go). O id e a agenda saem do
 * RESULTADO — é ele que prova que o gatilho existe; o prompt e a nota saem dos
 * argumentos da chamada, porque o recibo não os repete.
 */
const RECIBO_DE_CRIACAO = /^gatilho (\S+) criado \(([^)]*)\)/;
const PRIMEIRO_DISPARO = /primeiro disparo em ([\d/]+ [\d:]+)/;

/**
 * Uma entrada do relatório do `schedule.list`:
 * `- <id>[ [desligado]] — <agenda> — próximo <data> — <N> disparo(s)`.
 */
const LINHA_DA_LISTA = /^- (\S+?)( \[desligado\])? — (.+?) — próximo (.+?) — (\d+) disparo/;

/** O relatório de lista vazia, nas duas redações do gateway. */
function listaVazia(saida: string): boolean {
  return saida.startsWith("não há nenhum gatilho") || saida.startsWith("nenhum gatilho agendado");
}

/**
 * O quadro de automações desta sessão, reconstruído dos `tool.result` na ordem
 * em que aconteceram: `create` acrescenta, `remove` tira, e `list` SUBSTITUI o
 * quadro inteiro — a lista é a fotografia mais recente da agenda, e somar por
 * cima dela deixaria na tela um gatilho que o disco já não tem.
 *
 * Recusa (ok:false) fica de fora em todos os verbos: agendamento que não
 * aconteceu não vira linha — o mesmo princípio das gravações do editor.
 */
export function collectAutomacoes(lines: ConversationLine[]): Automacao[] {
  // Os argumentos por callId, do log inteiro: o result só carrega o recibo.
  const argsPorCall = new Map<string, unknown>();
  for (const line of lines) {
    for (const call of line.toolCalls ?? []) {
      if (call.tool.startsWith("schedule.")) argsPorCall.set(call.callId, call.args);
    }
  }

  const ferramentaPorCall = new Map<string, string>();
  for (const line of lines) {
    for (const call of line.toolCalls ?? []) ferramentaPorCall.set(call.callId, call.tool);
  }

  let quadro: Automacao[] = [];

  for (const line of lines) {
    for (const result of line.toolResults ?? []) {
      if (!result.ok) continue;
      const ferramenta = result.tool || ferramentaPorCall.get(result.callId) || "";
      const saida = result.output ?? "";

      if (ferramenta === "schedule.create") {
        const recibo = RECIBO_DE_CRIACAO.exec(saida);
        // Sem o recibo não há id — e uma linha sem id não tem como sair do
        // quadro quando o remove chegar. Melhor não inventar.
        if (!recibo) continue;
        const args = argsPorCall.get(result.callId);
        const nova: Automacao = {
          id: recibo[1] ?? "",
          prompt: argTexto(args, "prompt"),
          agenda: recibo[2] ?? "",
          nota: argTexto(args, "note"),
          proximo: PRIMEIRO_DISPARO.exec(saida)?.[1] ?? "",
          disparos: 0,
          desligada: false
        };
        // O mesmo id criado de novo (replay tolerante) não duplica a linha.
        quadro = [...quadro.filter((item) => item.id !== nova.id), nova];
        continue;
      }

      if (ferramenta === "schedule.remove") {
        // O id sai do recibo ("gatilho X apagado") ou dos argumentos.
        const id = /^gatilho (\S+) apagado/.exec(saida)?.[1] ?? argTexto(argsPorCall.get(result.callId), "id");
        if (id !== "") quadro = quadro.filter((item) => item.id !== id);
        continue;
      }

      if (ferramenta === "schedule.list") {
        if (listaVazia(saida)) {
          quadro = [];
          continue;
        }
        const itens: Automacao[] = [];
        const linhas = saida.split("\n");
        for (let i = 0; i < linhas.length; i += 1) {
          const casada = LINHA_DA_LISTA.exec((linhas[i] ?? "").trim());
          if (!casada) continue;
          // As linhas indentadas logo abaixo: a primeira é o prompt, e a que
          // começa com "nota:" é a nota (truncadas pelo gateway, e tudo bem).
          let prompt = "";
          let nota = "";
          for (let j = i + 1; j < linhas.length; j += 1) {
            const corpo = linhas[j] ?? "";
            if (!corpo.startsWith("  ")) break;
            const texto = corpo.trim();
            if (texto.startsWith("nota:")) nota = texto.slice(5).trim();
            else if (prompt === "") prompt = texto;
          }
          itens.push({
            id: casada[1] ?? "",
            prompt,
            agenda: casada[3] ?? "",
            nota,
            proximo: (casada[4] ?? "").trim(),
            disparos: Number.parseInt(casada[5] ?? "0", 10) || 0,
            desligada: casada[2] !== undefined
          });
        }
        // Relatório com formato irreconhecível preserva o quadro que já havia:
        // apagar a tela por causa de uma redação nova esconderia trabalho real.
        if (itens.length > 0) quadro = itens;
      }
    }
  }

  return quadro;
}

/** O cartão de UMA automação — id, agenda e o pedido que ela dispara. */
function AutomacaoRow({ item }: { item: Automacao }): ReactNode {
  const setInput = useApp((state) => state.setInput);
  return (
    <li className="board-automacao" data-desligada={item.desligada ? "true" : undefined}>
      <div className="card-head">
        <code className="board-automacao-id">{item.id}</code>
        <span className="chip" title="quando o gatilho dispara">
          {item.agenda || "sem agenda"}
        </span>
        {item.desligada ? <span className="chip">desligado</span> : null}
        {item.proximo !== "" ? (
          <span className="card-eyebrow" title="próximo disparo, hora local desta máquina">
            próximo {item.proximo}
          </span>
        ) : null}
        {item.disparos > 0 ? (
          <span className="card-eyebrow">
            {item.disparos} {item.disparos === 1 ? "disparo" : "disparos"}
          </span>
        ) : null}
      </div>
      {item.prompt !== "" ? <p className="card-body">{item.prompt}</p> : null}
      {item.nota !== "" ? <p className="card-eyebrow">nota: {item.nota}</p> : null}
      <div className="card-foot">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => setInput(`Remova o gatilho agendado ${item.id} porque `)}
          title="escreve o pedido no campo de texto — quem remove é o especialista, via schedule.remove"
        >
          <CornerDownRight size={12} aria-hidden="true" />
          pedir para remover
        </button>
      </div>
    </li>
  );
}

/* -------------------------------- superfície ---------------------------- */

export function BoardSurface(): ReactNode {
  const tasks = useApp((state) => state.crew.tasks);
  const dispatches = useApp((state) => state.crew.dispatches);
  const progress = useApp((state) => state.crew.progress);
  const done = useApp((state) => state.crew.done);
  const escalations = useApp((state) => state.crew.escalations);
  const lines = useApp((state) => state.lines);

  // A reação da tela ao trabalho do PRÓPRIO bot: os gatilhos que ele agendou
  // nesta sessão, derivados dos tool.result (ver collectAutomacoes).
  const automacoes = useMemo(() => collectAutomacoes(lines), [lines]);

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
      {/* Os botões desta superfície entram na barra do app por portal — o palco
          não desenha barra própria (ver shell/TopbarActions, que também define
          as ações). */}
      <TopbarActions>
        <BoardTopbarActions />
      </TopbarActions>

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
        <div className="board-main">
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

          {/*
            A ENTREGA do bot de Trabalho é o gatilho agendado, não a tarefa de
            equipe — e é aqui que ela aparece assim que o schedule.create
            confirma. Sempre visível, com vazio honesto: dizer o que vai
            aparecer é o padrão da casa, e esconder a seção deixaria a pessoa
            sem saber que o quadro TAMBÉM mostra a agenda.
          */}
          <section className="card board-automacoes" aria-label="automações agendadas">
            <div className="card-head">
              <CalendarClock size={14} aria-hidden="true" />
              <span className="card-title">Automações</span>
              <span className="chip">{automacoes.length}</span>
            </div>
            <p className="card-eyebrow">
              gatilhos agendados pelo bot nesta sessão — fonte: schedule.create · schedule.list
            </p>
            {automacoes.length === 0 ? (
              <p className="card-body">
                nenhuma automação agendada nesta sessão — <code>/automacao</code> descreve o gatilho e o
                especialista o agenda de verdade
              </p>
            ) : (
              <ul className="board-automacoes-lista">
                {automacoes.map((item) => (
                  <AutomacaoRow item={item} key={item.id} />
                ))}
              </ul>
            )}
          </section>
        </div>

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
        <span>
          automações <b>{automacoes.length}</b>
        </span>
        <span>estado muda pelo bot, não pelo mouse</span>
      </div>
    </div>
  );
}

export default BoardSurface;
