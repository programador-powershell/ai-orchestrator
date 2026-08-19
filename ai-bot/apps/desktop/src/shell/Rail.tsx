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
  FileText,
  FolderOpen,
  GitBranch,
  Hand,
  KanbanSquare,
  Loader2,
  MessagesSquare,
  Plus,
  ShieldCheck,
  Workflow,
  type LucideIcon
} from "lucide-react";
import type { RailKind, Task } from "@aibot/contracts";
import { outcomeOf } from "../lib/crew";
import { useApp } from "../lib/store";
import { MASTER, specialistById } from "../lib/specialists";
import { GrokAvatar, grokSpecialistOf, type GrokSpecialistState } from "../avatar/GrokAvatar";
import { TablesRail } from "./rails/TablesRail";
import { LayersRail } from "./rails/LayersRail";

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

/* ------------------------------- conversas ------------------------------- */

/**
 * Agrupa as conversas: a do dono primeiro, as dos bots que ela acionou logo
 * abaixo.
 *
 * É a forma do Grok Bot, e ela existe porque a unidade da conversa mudou. Antes
 * o especialista chamado respondia dentro da conversa de quem o chamou e sumia;
 * agora ele tem conversa própria, e a barra precisa mostrar o vínculo — senão
 * viram duas linhas soltas sem relação visível, que é o "ficou misturado".
 *
 * Filha órfã (o pai foi apagado, ou ainda não chegou na lista) sobe para a raiz
 * em vez de sumir: esconder conversa por causa de um vínculo quebrado é perder
 * trabalho da pessoa por um detalhe de arrumação.
 */
export function agruparConversas<T extends { id: string; parentId?: string }>(
  visiveis: readonly T[]
): Array<{ dona: T; filhas: T[] }> {
  const existe = new Set(visiveis.map((item) => item.id));
  const filhasPor = new Map<string, T[]>();
  for (const item of visiveis) {
    const pai = item.parentId ?? "";
    if (pai === "" || !existe.has(pai)) continue;
    const lista = filhasPor.get(pai) ?? [];
    lista.push(item);
    filhasPor.set(pai, lista);
  }
  return visiveis
    .filter((item) => {
      const pai = item.parentId ?? "";
      return pai === "" || !existe.has(pai);
    })
    .map((dona) => ({ dona, filhas: filhasPor.get(dona.id) ?? [] }));
}

/**
 * Quais conversas entram na barra.
 *
 * Conversa sem nada dentro NÃO é conversa. A sessão nasce no aperto de mão do
 * WebSocket, não no primeiro pedido — quem abre a janela já ganha uma. Com isso,
 * reconexão, recarga da página e reinício do app geravam, cada um, mais uma
 * linha vazia.
 *
 * A ATIVA fica visível mesmo vazia: é para onde o próximo texto vai, e sumir com
 * ela faria a pessoa achar que perdeu o lugar.
 */
export function conversasVisiveis<T extends { id: string; turns: number; lastSeq?: number; title?: string }>(
  todas: readonly T[],
  ativa: string | null
): T[] {
  return todas.filter(
    (item) =>
      // `lastSeq` é o sinal CONFIÁVEL de que houve conversa: ele é reconstruído
      // lendo o fim do log quando a sessão reabre. `turns` não é — ele é cache
      // do cabeçalho, gravado com atraso, e volta ZERADO quando o gateway morre
      // antes da descarga. Filtrar por ele escondia conversa de verdade, que foi
      // exatamente o defeito: clicar em "nova conversa" fazia a anterior sumir.
      (item.lastSeq ?? 0) > 0 ||
      item.turns > 0 ||
      // Título é conteúdo: só ganha um quem já falou alguma coisa.
      (item.title ?? "") !== "" ||
      item.id === ativa
  );
}

function ConversationsRail() {
  const todas = useApp((state) => state.sessions);
  const session = useApp((state) => state.session);
  const openSession = useApp((state) => state.openSession);
  const forkSession = useApp((state) => state.forkSession);
  const atividade = useApp((state) => state.atividadeDasConversas);

  const sessions = conversasVisiveis(todas, session);

  if (sessions.length === 0) {
    return (
      <RailEmpty
        icon={MessagesSquare}
        hint="As conversas salvas aparecem aqui, cada uma com o avatar do especialista que atendeu por último."
      />
    );
  }

  /**
   * Uma linha da barra.
   *
   * O retrato é o do bot: numa conversa comum, o especialista que atendeu por
   * último; numa conversa de bot, o dono dela. O ícone genérico de antes dizia
   * "isto é uma conversa", que a lista inteira já diz — o retrato diz DE QUEM
   * ela é, que é o que a pessoa procura ao correr o olho.
   */
  const linha = (item: (typeof sessions)[number], filha: boolean) => {
    const especialista = grokSpecialistOf(item.botId ?? item.specialist ?? "");
    // O sinal da linha: o retrato TRABALHA enquanto a delegação roda (o mesmo
    // estado visual do bot em ação — nada de anel novo inventado), e o ponto
    // marca resultado que chegou com a pessoa em outra conversa. Abrir limpa.
    const sinal = atividade[item.id];
    const estado =
      sinal === "trabalhando" ? "working" : item.id === session ? "active" : "waiting";
    const objetivo = (item.lastGoal ?? "").trim();
    return (
      // O botão de ramificar é IRMÃO do botão da conversa, não filho:
      // botão dentro de botão é HTML inválido e o clique dos dois brigaria.
      <li key={item.id} className="rail-item-row" data-child={filha}>
        <button
          type="button"
          className="rail-item"
          data-active={item.id === session}
          data-atividade={sinal}
          onClick={() => openSession(item.id)}
          title={
            filha
              ? objetivo === ""
                ? `Falar direto com ${item.title}`
                : `${item.title} — ${objetivo}`
              : item.title
          }
        >
          <GrokAvatar specialist={especialista} state={estado} size={filha ? 18 : 22} />
          <span className="rail-item-text">
            <span className="rail-item-label">
              {item.title === "" ? "Conversa sem título" : item.title}
            </span>
            {/* O subtítulo é O QUE o bot está fazendo — o título já diz de
                quem a conversa é. Sem ele, duas filhas do mesmo bot em
                conversas diferentes eram linhas idênticas. */}
            {filha && objetivo !== "" ? (
              <span className="rail-item-sub">{objetivo}</span>
            ) : null}
          </span>
          {sinal === "naoLida" ? (
            <span className="rail-item-dot" aria-label="Atividade não lida" />
          ) : null}
          <span className="rail-item-meta">{item.turns}</span>
        </button>
        {/*
          Ramificar é da conversa RAIZ. A conversa de um bot é o registro do que
          aquele bot fez nesta conversa; copiá-la para uma sessão solta criaria
          um bot órfão, sem o pedido que o chamou.
        */}
        {!filha && (
          <button
            type="button"
            className="rail-item-fork"
            onClick={() => forkSession(item.id)}
            title="Ramificar esta conversa — o histórico é copiado para uma sessão nova"
            aria-label={`Ramificar a conversa ${item.title}`}
          >
            <GitBranch size={13} aria-hidden />
          </button>
        )}
      </li>
    );
  };

  return (
    <ul className="rail-list">
      {agruparConversas(sessions).map((grupo) => (
        <li key={grupo.dona.id} className="rail-group">
          <ul className="rail-list">
            {linha(grupo.dona, false)}
            {grupo.filhas.map((filha) => linha(filha, true))}
          </ul>
        </li>
      ))}
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

// O LayersRail de verdade mora em ./rails/LayersRail (camadas, seleção e
// stencils) — o placeholder daqui morreu com a Onda 2 da paridade.

// O TablesRail de verdade mora em ./rails/TablesRail (abas, busca e foco no
// diagrama) — o placeholder daqui morreu com a Onda 1 da paridade.

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
  const toggleRail = useApp((state) => state.toggleRail);
  const newSession = useApp((state) => state.newSession);

  const active = activeSpecialist ? specialistById(specialists, activeSpecialist) : MASTER;

  return (
    <aside className="rail" data-collapsed={!railOpen} data-rail={active.rail} aria-label="Barra lateral">
      <div className="rail-top">
        {/* "Nova conversa" SUBIU para a barra superior (sempre visível, até com
            a barra lateral colapsada). Aqui ficam o colapso e, abaixo, o gesto
            do ofício — que é da tela, não do app. */}
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

      {/* O gesto do OFÍCIO: "Novo schema" abre uma conversa nova que já nasce
          do bot ativo e PERMANECE nesta tela — mudar para o chat no meio do
          gesto confundia quem só queria recomeçar o trabalho ali. */}
      {railOpen && active.rail !== "conversations" ? (
        <button
          type="button"
          className="rail-new rail-new-bot"
          onClick={() => newSession(active.id)}
          title={`${active.newLabel} — conversa nova com ${active.name}, nesta tela`}
          aria-label={`${active.newLabel} — conversa nova com ${active.name}`}
        >
          <Plus size={14} aria-hidden />
          <span>{active.newLabel}</span>
        </button>
      ) : null}

      {railOpen ? (
        <div className="rail-body">
          {/* As CONVERSAS vêm sempre, antes do trilho do ofício. A versão
              anterior trocava a lista inteira pelo trilho do especialista
              ativo — quem caía numa conversa de Design via "Camadas" no lugar
              das conversas e ficava PRESO: sem lista, não há como abrir outra
              conversa nem ver a atual na barra. A lista é a navegação do app;
              o trilho do ofício é conteúdo daquela tela, e mora abaixo. */}
          <p className="rail-kind">{RAIL_TITLE.conversations}</p>
          <ConversationsRail />
          {active.rail !== "conversations" ? (
            <>
              <p className="rail-kind">{RAIL_TITLE[active.rail] ?? active.rail}</p>
              {renderRail(active.rail)}
            </>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}

export default Rail;
