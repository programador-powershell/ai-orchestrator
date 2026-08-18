/**
 * A barra lateral esquerda.
 *
 * O topo é fixo (o bot, a conversa nova, o colapso) e o corpo muda com o
 * especialista ativo. Cada `RailKind` tem um componente próprio, e cada um lê o
 * store por conta — assim a barra não recebe dez props opcionais das quais nove
 * são sempre `undefined`.
 *
 * Regra desta tela: rail sem dado próprio mostra um vazio HONESTO dizendo o que
 * vai aparecer ali. Nada de arquivo de exemplo, tabela fictícia ou execução
 * inventada só para a coluna não ficar vazia.
 */
import {
  Activity,
  AlertTriangle,
  Bot,
  Check,
  ChevronsLeft,
  ChevronsRight,
  Database,
  FileText,
  FolderOpen,
  GitBranch,
  Hand,
  KanbanSquare,
  Layers,
  Loader2,
  MessagesSquare,
  Plus,
  ShieldCheck,
  Workflow,
  type LucideIcon
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { RailKind, Task } from "@ai-bot/contracts";
import { outcomeOf } from "../lib/crew";
import { useApp } from "../lib/store";
import { MASTER, SPECIALIST_ICON, specialistById } from "../lib/specialists";
import { BotAvatar } from "../avatar/BotAvatar";
import {
  GROK_STATE_LABELS,
  GrokAvatar,
  grokSpecialistOf,
  type GrokSpecialistState
} from "../avatar/GrokAvatar";

/** O recorte do store que os componentes do crew leem. Deriva do próprio store
 *  para não virar uma segunda declaração do contrato, que envelheceria sozinha. */
type Crew = ReturnType<typeof useApp.getState>["crew"];

const RAIL_TITLE: Record<RailKind, string> = {
  conversations: "Conversas",
  files: "Arquivos",
  document: "Documento",
  layers: "Camadas",
  tables: "Tabelas",
  tasks: "Tarefas",
  findings: "Achados",
  crew: "Equipe",
  nodes: "Nós",
  runs: "Execuções"
};

/* ------------------------------ vazio honesto ---------------------------- */

function RailEmpty({ icon: Icon, hint }: { icon: LucideIcon; hint: string }) {
  return (
    <div className="rail-empty">
      <Icon size={18} aria-hidden />
      <p className="rail-empty-title">Nada aqui ainda.</p>
      <p className="rail-empty-hint">{hint}</p>
    </div>
  );
}

/* --------------------------- presença do bot ------------------------------ */

/** Quanto tempo o bot comemora depois que a resposta chega. */
const CELEBRACAO_MS = 4000;

/**
 * O CARTÃO DE PRESENÇA: o bot da vez, grande o bastante para o campo do ofício
 * ser legível, fazendo a animação do estado. É a resposta direta ao pedido
 * "quando fizer a chamada, o especialista aparece na barra lateral animando":
 * dono da conversa em repouso (roteamento sticky), trabalhando durante o turno,
 * concluído por alguns segundos quando a resposta chega — e o master quando a
 * conversa ainda não tem dono.
 */
function PresenceCard() {
  const specialists = useApp((state) => state.specialists);
  const activeSpecialist = useApp((state) => state.activeSpecialist);
  const busy = useApp((state) => state.busy);

  const [celebrando, setCelebrando] = useState(false);
  const antes = useRef(busy);
  useEffect(() => {
    const estava = antes.current;
    antes.current = busy;
    if (!estava || busy) return;
    setCelebrando(true);
    const timer = setTimeout(() => setCelebrando(false), CELEBRACAO_MS);
    return () => clearTimeout(timer);
  }, [busy]);

  const state: GrokSpecialistState = busy ? "working" : celebrando ? "completed" : activeSpecialist ? "owner" : "active";
  const quem = activeSpecialist ? specialistById(specialists, activeSpecialist) : MASTER;

  return (
    <div className="rail-presence" data-state={state}>
      <GrokAvatar specialist={grokSpecialistOf(quem.id)} state={state} size={124} title={`${quem.name} — ${GROK_STATE_LABELS[state]}`} />
      <p className="rail-presence-name">{quem.name}</p>
      <p className="rail-presence-state">{GROK_STATE_LABELS[state]}</p>
    </div>
  );
}

/* ------------------------------- conversas ------------------------------- */

function ConversationsRail() {
  const sessions = useApp((state) => state.sessions);
  const session = useApp((state) => state.session);
  const openSession = useApp((state) => state.openSession);
  const forkSession = useApp((state) => state.forkSession);

  if (sessions.length === 0) {
    return (
      <RailEmpty
        icon={MessagesSquare}
        hint="As conversas salvas aparecem aqui, cada uma com o ícone do especialista que atendeu por último."
      />
    );
  }

  return (
    <ul className="rail-list">
      {sessions.map((item) => {
        // O ícone é o do especialista da sessão — é ele que diz, de relance, que
        // tipo de trabalho está guardado ali dentro.
        const Icon = SPECIALIST_ICON[item.specialist ?? ""] ?? Bot;
        return (
          // O botão de ramificar é IRMÃO do botão da conversa, não filho:
          // botão dentro de botão é HTML inválido e o clique dos dois brigaria.
          <li key={item.id} className="rail-item-row">
            <button
              type="button"
              className="rail-item"
              data-active={item.id === session}
              onClick={() => openSession(item.id)}
              title={item.title}
            >
              <Icon size={14} aria-hidden />
              <span className="rail-item-label">{item.title}</span>
              <span className="rail-item-meta">{item.turns}</span>
            </button>
            <button
              type="button"
              className="rail-item-fork"
              onClick={() => forkSession(item.id)}
              title="Ramificar esta conversa — o histórico é copiado para uma sessão nova"
              aria-label={`Ramificar a conversa ${item.title}`}
            >
              <GitBranch size={13} aria-hidden />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/* --------------------------------- crew ---------------------------------- */

type TaskTone = "idle" | "run" | "ok" | "fail" | "ask";

/** O estado de uma tarefa é derivado dos eventos que chegaram, e não guardado
 *  num campo à parte: o gateway manda dispatch/progress/done, e o último que
 *  chegou é a verdade. */
function taskState(id: string, crew: Crew): { label: string; tone: TaskTone } {
  // O `done` decide PRIMEIRO, e é ele que diz se houve escalação (`outcomeOf`).
  //
  // A ordem estava invertida: a lista de escalações vinha antes e vencia o
  // `worker.done`. Como aquela lista só cresce enquanto a conversa vive, uma
  // tarefa que escalou, foi respondida e depois falhou de verdade ficava para
  // sempre em "aguardando resposta" — o trilho escondendo a falha que o resto da
  // tela mostrava.
  const done = crew.done[id];
  if (done) {
    const outcome = outcomeOf(done);
    if (outcome === "done") {
      return { label: done.result ? `concluída — ${done.result}` : "concluída", tone: "ok" };
    }
    // Rótulo CURTO, e não `done.error`. O trilho tem 236px e `.rail-task-state` é
    // caixa-alta com letter-spacing e sem truncamento (ao contrário de
    // `.rail-item-label`): a pergunta inteira viraria quatro linhas espaçadas
    // empurrando as outras tarefas para fora da tela. E `done.error` traz o
    // prefixo "escalado: " montado no Go — texto de máquina não é rótulo de UI. A
    // pergunta inteira está na faixa da tela de Equipe, que é onde se responde.
    if (outcome === "escalated") {
      return { label: "escalou", tone: "ask" };
    }
    return { label: done.error ? `falhou — ${done.error}` : "falhou", tone: "fail" };
  }
  // Antes do `done` chegar ainda vale a lista: o `escalate` sai de dentro do
  // trabalhador e o `worker.done` só sai quando a onda inteira fecha, então há
  // uma janela real em que a pergunta já existe e o desfecho não.
  if (crew.escalations.some((item) => item.taskId === id)) {
    return { label: "aguardando resposta", tone: "ask" };
  }
  const progress = crew.progress[id];
  if (progress) {
    const pct = progress.fraction === undefined ? "" : `${Math.round(progress.fraction * 100)}% · `;
    return { label: `${pct}${progress.note}`, tone: "run" };
  }
  if (crew.dispatches.some((item) => item.task.id === id)) {
    return { label: "despachada", tone: "run" };
  }
  return { label: "planejada", tone: "idle" };
}

function ToneIcon({ tone }: { tone: TaskTone }) {
  if (tone === "ok") return <Check size={13} aria-hidden />;
  if (tone === "fail") return <AlertTriangle size={13} aria-hidden />;
  // Mão levantada, não triângulo de alerta: quem escalou fez uma pergunta. Com o
  // mesmo ícone de falha, a distinção que `taskState` calcula certo se perdia no
  // desenho — e é o desenho que a pessoa lê.
  if (tone === "ask") return <Hand size={13} aria-hidden />;
  if (tone === "run") return <Loader2 size={13} className="spin" aria-hidden />;
  return <Activity size={13} aria-hidden />;
}

/**
 * O tom da tarefa É um estado do bot: planejada espera, despachada trabalha,
 * concluída celebra — e quem escalou fez uma pergunta e está PARADO até a
 * resposta: espera, não falha. A falha não tem estado no vocabulário do
 * wrapper (cinco estados, por decisão da especificação): o bot dorme em
 * espera e quem diz "falhou" é o ícone e o rótulo da própria linha.
 */
const TONE_STATE: Record<TaskTone, GrokSpecialistState> = {
  idle: "waiting",
  run: "working",
  ok: "completed",
  fail: "waiting",
  ask: "waiting"
};

function TaskList({ tasks, crew }: { tasks: Task[]; crew: Crew }) {
  return (
    <ul className="rail-list">
      {tasks.map((task) => {
        const state = taskState(task.id, crew);
        return (
          <li key={task.id}>
            <div className="rail-task" data-tone={state.tone} title={task.goal}>
              <span className="rail-task-head">
                {/* O bot do trabalhador no estado da tarefa: os olhos dizem o
                    estado (fechados = espera, sorrindo = concluída) e o campo
                    ao redor diz o ofício, mesmo neste tamanho. */}
                <GrokAvatar specialist={grokSpecialistOf(task.specialist)} state={TONE_STATE[state.tone]} size={26} />
                <span className="rail-item-label">{task.title}</span>
              </span>
              <span className="rail-task-state">
                <ToneIcon tone={state.tone} />
                <span>{state.label}</span>
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function CrewRail() {
  const crew = useApp((state) => state.crew);
  const tasks = Object.values(crew.tasks);

  if (tasks.length === 0) {
    return (
      <RailEmpty
        icon={KanbanSquare}
        hint="As tarefas da equipe aparecem aqui quando o master planejar e despachar os trabalhadores."
      />
    );
  }

  return (
    <>
      {crew.gate ? (
        <p className="rail-gate" data-decision={crew.gate.decision} title={crew.gate.reason ?? undefined}>
          portão: {crew.gate.decision}
          {crew.gate.reason ? ` — ${crew.gate.reason}` : ""}
        </p>
      ) : null}
      <TaskList tasks={tasks} crew={crew} />
    </>
  );
}

/** O quadro ainda não tem tarefas próprias; as que existem são as da equipe, e o
 *  rótulo diz isso em vez de fingir que o quadro já tem dado. */
function TasksRail() {
  const crew = useApp((state) => state.crew);
  const tasks = Object.values(crew.tasks);

  if (tasks.length === 0) {
    return (
      <RailEmpty
        icon={KanbanSquare}
        hint="As tarefas do quadro aparecem aqui quando houver um plano. Por enquanto só existem as tarefas despachadas pela equipe."
      />
    );
  }

  return (
    <>
      <p className="rail-note">Vindas da equipe — o quadro ainda não guarda tarefas próprias.</p>
      <TaskList tasks={tasks} crew={crew} />
    </>
  );
}

/* -------------------------------- achados -------------------------------- */

function FindingsRail() {
  const lines = useApp((state) => state.lines);
  // O que existe de verdade hoje são as linhas que o especialista Segurança
  // respondeu nesta conversa. É pouco, mas é real — e serve para pular até elas.
  const reviews = lines.filter((line) => line.role === "assistant" && line.specialist === "security");

  if (reviews.length === 0) {
    return (
      <RailEmpty
        icon={ShieldCheck}
        hint="Os achados da revisão aparecem aqui, com severidade e arquivo, depois que o especialista Segurança revisar alguma coisa."
      />
    );
  }

  return (
    <ul className="rail-list">
      {reviews.map((line) => (
        <li key={line.id}>
          <a className="rail-item" href={`#line-${line.id}`} title={line.text}>
            <ShieldCheck size={14} aria-hidden />
            <span className="rail-item-label">{line.text.slice(0, 80) || "revisão sem texto"}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------- rails ainda sem dado -------------------------- */

function FilesRail() {
  return (
    <RailEmpty
      icon={FolderOpen}
      hint="A árvore do projeto aparece aqui quando o especialista Código abrir um diretório."
    />
  );
}

function DocumentRail() {
  return (
    <RailEmpty
      icon={FileText}
      hint="O sumário do documento — títulos e seções — aparece aqui quando um arquivo for aberto."
    />
  );
}

function LayersRail() {
  return (
    <RailEmpty icon={Layers} hint="As camadas do desenho aparecem aqui quando houver algo na tela do Design." />
  );
}

function TablesRail() {
  return (
    <RailEmpty
      icon={Database}
      hint="As tabelas e colunas aparecem aqui quando o especialista Dados ler um banco ou um arquivo de schema."
    />
  );
}

function NodesRail() {
  return <RailEmpty icon={Workflow} hint="Os nós do fluxo aparecem aqui quando houver um fluxo montado." />;
}

function RunsRail() {
  return (
    <RailEmpty icon={Activity} hint="As execuções de treino aparecem aqui, com perda e passo, quando um treino começar." />
  );
}

/* -------------------------------- a barra -------------------------------- */

function renderRail(kind: RailKind) {
  switch (kind) {
    case "conversations":
      return <ConversationsRail />;
    case "files":
      return <FilesRail />;
    case "document":
      return <DocumentRail />;
    case "layers":
      return <LayersRail />;
    case "tables":
      return <TablesRail />;
    case "tasks":
      return <TasksRail />;
    case "findings":
      return <FindingsRail />;
    case "crew":
      return <CrewRail />;
    case "nodes":
      return <NodesRail />;
    case "runs":
      return <RunsRail />;
    default:
      // Rail fora do contrato é bug de versão entre cliente e gateway; dizer isso
      // é mais útil do que devolver a lista de conversas como se nada tivesse
      // acontecido.
      return <RailEmpty icon={Bot} hint={`Este cliente ainda não conhece a barra “${String(kind)}”.`} />;
  }
}

export function Rail() {
  const specialists = useApp((state) => state.specialists);
  const activeSpecialist = useApp((state) => state.activeSpecialist);
  const railOpen = useApp((state) => state.railOpen);
  const avatars = useApp((state) => state.avatars);
  const toggleRail = useApp((state) => state.toggleRail);
  const newSession = useApp((state) => state.newSession);
  const setAvatarLabOpen = useApp((state) => state.setAvatarLabOpen);

  const active = activeSpecialist ? specialistById(specialists, activeSpecialist) : MASTER;
  // A personalização ganha do catálogo: se a pessoa mexeu no retrato do master no
  // laboratório, é o retrato dela que fica no topo da barra.
  const masterAvatar = avatars[MASTER.id] ?? MASTER.avatar;

  /**
   * No aplicativo nativo o laboratório abre em JANELA PRÓPRIA — dá para
   * comparar os bots lado a lado com a conversa ainda visível, que é o ponto de
   * personalizar o retrato de cada um. No navegador (dev, ou o app aberto pelo
   * Vite) não existe janela para abrir, e aí ele cai no modal dentro da tela.
   *
   * O `catch` é silencioso de propósito: se o comando nativo falhar, o modal
   * ainda abre. Um erro no console é melhor que um botão que não faz nada.
   */
  async function openAvatarLab() {
    if (!("__TAURI_INTERNALS__" in window)) {
      setAvatarLabOpen(true);
      return;
    }
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("open_avatar_lab");
    } catch (error) {
      console.error("não foi possível abrir a janela do laboratório", error);
      setAvatarLabOpen(true);
    }
  }

  return (
    <aside className="rail" data-collapsed={!railOpen} data-rail={active.rail} aria-label="Barra lateral">
      <div className="rail-top">
        <button
          type="button"
          className="rail-bot"
          onClick={() => void openAvatarLab()}
          title="Personalizar os bots"
          aria-label="Personalizar os bots"
        >
          <BotAvatar avatar={masterAvatar} size={railOpen ? 34 : 30} />
          {railOpen ? <span className="rail-bot-name">{MASTER.name}</span> : null}
        </button>

        <button
          type="button"
          className="rail-new"
          onClick={() => newSession()}
          title={`${active.newLabel} (Ctrl+N)`}
          aria-label={active.newLabel}
        >
          <Plus size={16} aria-hidden />
          {railOpen ? <span>{active.newLabel}</span> : null}
        </button>

        <button
          type="button"
          className="rail-collapse icon-button"
          onClick={toggleRail}
          title={railOpen ? "Recolher a barra" : "Expandir a barra"}
          aria-label={railOpen ? "Recolher a barra" : "Expandir a barra"}
          aria-expanded={railOpen}
        >
          {railOpen ? <ChevronsLeft size={16} aria-hidden /> : <ChevronsRight size={16} aria-hidden />}
        </button>
      </div>

      {railOpen ? (
        <div className="rail-body">
          <PresenceCard />
          <p className="rail-kind">{RAIL_TITLE[active.rail] ?? active.rail}</p>
          {renderRail(active.rail)}
        </div>
      ) : null}
    </aside>
  );
}

export default Rail;
