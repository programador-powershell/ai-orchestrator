/**
 * O estado da tela única.
 *
 * O CORAÇÃO deste arquivo é `applyEnvelope`: uma função PURA que recebe o
 * estado e um envelope do gateway e devolve o estado seguinte. O store só a
 * chama. Essa separação não é purismo — é o que torna a regra testável sem
 * WebSocket, sem React e sem relógio, e a regra aqui é justamente a que este
 * produto não pode errar: cada LINHA guarda o especialista que a atendeu, e uma
 * conversa mistura especialistas.
 *
 * Persistência: só `theme`, `railOpen` e `avatars`. As linhas e as sessões NÃO
 * são persistidas de propósito — a fonte é o log do gateway, e um cache local
 * divergiria em silêncio no primeiro replay (a pessoa veria uma conversa que o
 * servidor não tem, e ninguém saberia qual das duas está certa).
 */

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { invoke } from "@tauri-apps/api/core";
import {
  SURFACES,
  type ApprovalDecision,
  type ApprovalRequest,
  type Ask,
  type Attachment,
  type Avatar,
  type ConversationLine,
  type Delegate,
  type Delta,
  type Done,
  type Envelope,
  type Environment,
  type EnvironmentInfo,
  type Escalate,
  type Gate,
  type GateDecision,
  type Hello,
  type Message,
  type ModelInfo,
  type Notice,
  type Prompt,
  type ProtocolError,
  type Ready,
  type Reply,
  type Route,
  type SessionMeta,
  type SessionSummary,
  type SpecialistDefinition,
  type State,
  type Surface,
  type Task,
  type TaskDispatch,
  type TaskProgress,
  type Thinking,
  type ToolCall,
  type ToolResult,
  type UpdateTrack,
  type WorkerDone
} from "@aibot/contracts";
import { DEFAULT_ENVIRONMENT, FALLBACK_ENVIRONMENTS } from "./environments";
import { preferenceStorage } from "./persistStorage";
import { FALLBACK_SPECIALISTS, specialistById } from "./specialists";
import { CLIENT_NAME, CLIENT_VERSION, createTransport, type Transport } from "./transport";

/* ------------------------------- o formato ------------------------------ */

export interface CrewState {
  tasks: Record<string, Task>;
  dispatches: TaskDispatch[];
  progress: Record<string, TaskProgress>;
  done: Record<string, WorkerDone>;
  escalations: Escalate[];
  gate: Gate | null;
}

/** Os dados. Separados das ações para `applyEnvelope` poder ser pura e testável. */
export interface AppData {
  status: "connecting" | "ready" | "offline";
  /**
   * O endereço em uso, para as configurações poderem mostrá-lo. Só o endereço:
   * o TOKEN que viaja junto dele nunca entra no estado — estado é serializado,
   * inspecionado por devtools e impresso em log de erro, e o segredo do gateway
   * não pode aparecer em nenhum dos três.
   */
  gatewayUrl: string;
  session: string | null;
  specialists: SpecialistDefinition[];
  models: ModelInfo[];
  sessions: SessionMeta[];
  lines: ConversationLine[];
  /** "" antes de o master decidir na primeira linha. */
  activeSpecialist: string;
  /** "conversation" enquanto não houver rota. */
  activeSurface: Surface;
  activeModel: string;
  /** "" = deixar o master decidir (padrão). */
  specialistOverride: string;
  busy: boolean;
  /** Rótulo do orbe; "" quando parado. */
  thinking: string;
  pendingApproval: ApprovalRequest | null;
  /**
   * A pergunta que o supervisor fez e está esperando responder. Enquanto ela
   * existe o turno está PARADO do outro lado — sem mostrá-la, o orbe gira até o
   * timeout e a pessoa nunca fica sabendo que foi ela quem travou a resposta.
   */
  pendingAsk: Ask | null;
  crew: CrewState;
  /**
   * Onde o PRÓXIMO comando roda. Vem do gateway (é ele quem executa) e é o que
   * o rodapé mostra — a tela nunca decide isto sozinha.
   */
  environment: Environment;
  /** O catálogo medido nesta máquina; começa com a reserva local. */
  environments: EnvironmentInfo[];
  /**
   * As delegações do turno, em ordem de chegada.
   *
   * Lista, e não um único "em curso": um delegado pode delegar de novo
   * (`depth` conta os níveis), e guardar só o último apagaria de quem partiu a
   * cadeia. Quem desenha o popup lê a última em aberto.
   */
  delegations: Delegate[];
  /**
   * Os avisos de execução do turno (KindNotice), em ordem de chegada — "este
   * passo vai rodar num container", o downgrade para o ai-jail da VPS.
   *
   * Fila só de acréscimo, como as delegações: o store é PURO e não tem relógio
   * — quem faz o aviso sumir (~4 s) é o timer do componente NoticePopup, que
   * guarda qual índice já foi dispensado. Remover daqui exigiria um relógio no
   * redutor, e o redutor com relógio deixa de ser testável.
   */
  notices: Notice[];
  /**
   * A atualização que já foi baixada e verificada e está esperando alguma coisa
   * acontecer (ver `docs/atualizacao.md`).
   *
   * Fica no estado e não numa fila de notificação porque ela não é um evento —
   * é uma CONDIÇÃO, que continua verdadeira até o app reabrir ou o instalador
   * rodar. O gateway a anuncia a cada verificação (de seis em seis horas, por
   * padrão), então uma janela aberta depois do anúncio só fica sabendo na
   * verificação seguinte — e é por isso que o campo ausente PRESERVA o que já
   * estava, em vez de zerar.
   */
  updateAvailable: boolean;
  updateVersion: string;
  updateTracks: UpdateTrack[];
  theme: "light" | "dark";
  railOpen: boolean;
  avatarLabOpen: boolean;
  settingsOpen: boolean;
  /** Personalizações do laboratório; chave = id do especialista. */
  avatars: Record<string, Avatar>;
  input: string;
  /**
   * Anexos aguardando envio. São REFERÊNCIAS (nome, mime, tamanho), não
   * conteúdo: o app é desktop e o arquivo já está no disco — o especialista o
   * lê pela pasta do projeto. O nome é o que o roteador usa para decidir o dono
   * (.docx → documentos, .sql → dados).
   */
  attachments: Attachment[];
  error: string;
}

export interface AppActions {
  connect(): void;
  send(text?: string): void;
  stop(): void;
  decide(callId: string, allow: boolean, scope?: "once" | "digest" | "session"): void;
  decideGate(gateId: string, decision: GateDecision): void;
  answerAsk(answer: string): void;
  setInput(text: string): void;
  attach(files: Array<{ name: string; mime: string; bytes: number }>): void;
  detach(name: string): void;
  setModel(id: string): void;
  setEnvironment(id: Environment): void;
  setSpecialistOverride(id: string): void;
  newSession(): void;
  openSession(id: string): void;
  forkSession(id: string): void;
  setTheme(theme: "light" | "dark"): void;
  toggleRail(): void;
  setAvatarLabOpen(open: boolean): void;
  setSettingsOpen(open: boolean): void;
  setAvatar(specialist: string, avatar: Avatar): void;
  resetAvatar(specialist: string): void;
}

export type AppState = AppData & AppActions;

export function emptyCrew(): CrewState {
  return { tasks: {}, dispatches: [], progress: {}, done: {}, escalations: [], gate: null };
}

export function initialAppData(): AppData {
  return {
    status: "connecting",
    // Só é conhecido depois que o Rust responde de onde o gateway subiu.
    gatewayUrl: "",
    session: null,
    // Começa com o catálogo local: a tela precisa de matiz e placeholder antes
    // de o `ready` chegar, e abrir cinza por meio segundo parece defeito.
    specialists: FALLBACK_SPECIALISTS,
    models: [],
    sessions: [],
    lines: [],
    activeSpecialist: "",
    activeSurface: "conversation",
    activeModel: "",
    specialistOverride: "",
    busy: false,
    thinking: "",
    pendingApproval: null,
    pendingAsk: null,
    crew: emptyCrew(),
    environment: DEFAULT_ENVIRONMENT,
    environments: FALLBACK_ENVIRONMENTS,
    delegations: [],
    notices: [],
    updateAvailable: false,
    updateVersion: "",
    updateTracks: [],
    theme: "light",
    railOpen: true,
    avatarLabOpen: false,
    settingsOpen: false,
    avatars: {},
    input: "",
    attachments: [],
    error: ""
  };
}

/* ------------------------------ os ajudantes ----------------------------- */

/**
 * O payload chega como `unknown`. A conferência aqui é ESTRUTURAL (é um
 * objeto?), não campo a campo: o dono do contrato é o Go, e revalidar cada
 * campo no cliente criaria uma segunda verdade para manter sincronizada.
 */
function payloadOf<P>(envelope: Envelope): P | null {
  const payload: unknown = envelope.payload;
  if (typeof payload !== "object" || payload === null) return null;
  return payload as P;
}

function isSurface(value: string): value is Surface {
  return (SURFACES as readonly string[]).includes(value);
}

/**
 * Última linha do assistente do turno que AINDA está aberta.
 *
 * "Aberta" (streaming) e não simplesmente "última" porque um turno pode ter
 * mais de uma resposta: fechada a primeira, o delta seguinte tem de abrir linha
 * nova em vez de reescrever a que a pessoa já leu.
 */
function openLineIndex(lines: ConversationLine[], turn: string | undefined): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line) continue;
    if (line.role === "assistant" && line.turn === turn && line.streaming === true) return index;
  }
  return -1;
}

/** Última linha do assistente do turno, aberta ou fechada — onde as ferramentas se penduram. */
function currentLineIndex(lines: ConversationLine[], turn: string | undefined): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line) continue;
    if (line.role === "assistant" && line.turn === turn) return index;
  }
  return -1;
}

function newLine(envelope: Envelope, patch: Partial<ConversationLine>): ConversationLine {
  return {
    id: envelope.id,
    seq: envelope.seq,
    turn: envelope.turn,
    role: "assistant",
    text: "",
    ts: envelope.ts,
    ...patch
  };
}

function patchLine(
  lines: ConversationLine[],
  index: number,
  patch: Partial<ConversationLine>
): ConversationLine[] {
  const next = lines.slice();
  const line = next[index];
  if (!line) return lines;
  next[index] = { ...line, ...patch };
  return next;
}

/** Fecha o que ficou em aberto no turno: cursor piscando para sempre é mentira. */
function closeTurn(lines: ConversationLine[], turn: string | undefined): ConversationLine[] {
  let touched = false;
  const next = lines.map((line) => {
    if (line.turn !== turn || line.streaming !== true) return line;
    touched = true;
    return { ...line, streaming: false };
  });
  return touched ? next : lines;
}

/**
 * O resumo da lista vira o `SessionMeta` que a barra lateral e a barra superior
 * consomem.
 *
 * Os campos que o resumo NÃO carrega recebem valor neutro, e isso é uma decisão:
 * `lastSeq`/`syncedSeq` ficam em 0 porque ninguém mediu o log dessa conversa
 * daqui (elas só valem para a sessão aberta, que é a que recebe replay), e
 * `createdAt` recebe `updatedAt` porque é a única data que veio — chutar uma
 * data de criação faria a lista exibir um número que não corresponde a nada.
 */
function sessionMetaOf(summary: SessionSummary): SessionMeta {
  return {
    id: summary.id,
    title: summary.title,
    specialist: summary.specialist,
    model: summary.model,
    createdAt: summary.updatedAt,
    updatedAt: summary.updatedAt,
    lastSeq: 0,
    syncedSeq: 0,
    turns: summary.turns
  };
}

/**
 * A última delegação AINDA aberta com o mesmo par de bots e o mesmo objetivo.
 *
 * A delegação não tem id — é o que o contrato diz —, então a identidade é o
 * trio `from`+`to`+`goal`. "Ainda aberta" é a parte que importa: o mesmo
 * especialista pode ser chamado duas vezes para o mesmo objetivo no mesmo
 * turno, e o `done` da segunda não pode reescrever a primeira, que já fechou.
 */
function openDelegationIndex(list: Delegate[], incoming: Delegate): number {
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const entry = list[index];
    if (!entry || entry.done === true) continue;
    if (entry.from === incoming.from && entry.to === incoming.to && entry.goal === incoming.goal) {
      return index;
    }
  }
  return -1;
}

/**
 * O especialista de quem falou. `from.specialist` vem no envelope justamente
 * para a UI não ter de deduzir do estado da tela — deduzir dá certo até a
 * conversa trocar de especialista no meio, que aqui é o caso normal.
 */
function speakerOf(envelope: Envelope, fallback: string): string {
  const specialist = envelope.from.specialist;
  if (typeof specialist === "string" && specialist !== "") return specialist;
  return fallback;
}

/* ------------------------------ a redução ------------------------------- */

/**
 * Estado + envelope → estado. Pura: sem relógio, sem rede, sem `Math.random`.
 * Exportada porque é ela que os testes cobrem; o store apenas a chama.
 */
export function applyEnvelope(state: AppData, envelope: Envelope): AppData {
  switch (envelope.kind) {
    case "ready": {
      const ready = payloadOf<Ready>(envelope);
      if (!ready) return state;
      // O gateway manda IDS; a definição visual mora no cliente. Um id que o
      // app ainda não conhece cai no "chat" — aparece, mas não quebra a tela.
      const specialists =
        Array.isArray(ready.specialists) && ready.specialists.length > 0
          ? ready.specialists.map((id) => specialistById(FALLBACK_SPECIALISTS, id))
          : FALLBACK_SPECIALISTS;
      const activeSpecialist = ready.activeSpecialist ?? "";
      return {
        ...state,
        status: "ready",
        session: ready.session,
        specialists,
        models: Array.isArray(ready.models) ? ready.models : [],
        // A lista de conversas é do `ready` ou não é de ninguém: sem isto,
        // `sessions` nunca era escrito e a barra lateral ficava permanentemente
        // no vazio. Gateway antigo (sem o campo) preserva o que já estava lá —
        // trocar por lista vazia apagaria a lista visível a cada reconexão.
        sessions: Array.isArray(ready.sessions)
          ? ready.sessions.map(sessionMetaOf)
          : state.sessions,
        activeSpecialist,
        activeSurface:
          activeSpecialist === ""
            ? "conversation"
            : specialistById(specialists, activeSpecialist).surface,
        activeModel: ready.activeModel ?? state.activeModel,
        // Quem executa é o gateway, então é ele quem diz onde o próximo comando
        // cai e quais ambientes existem NESTA máquina. Gateway antigo (sem os
        // campos) preserva o que já estava: trocar por uma lista vazia deixaria
        // o rodapé sem menu nenhum.
        environment: ready.environment ?? state.environment,
        environments:
          Array.isArray(ready.environments) && ready.environments.length > 0
            ? ready.environments
            : state.environments,
        error: ""
      };
    }

    case "route": {
      const route = payloadOf<Route>(envelope);
      if (!route) return state;
      const definition = specialistById(state.specialists, route.specialist);
      // A rota ABRE a linha. É esta linha que desenha a faixa de "agora é
      // <Especialista>", com o motivo (route.reason) no title: uma troca de
      // especialista que a pessoa não entende parece defeito.
      const line = newLine(envelope, {
        role: "assistant",
        specialist: route.specialist,
        model: route.model,
        streaming: true,
        route
      });
      return {
        ...state,
        activeSpecialist: route.specialist,
        activeSurface: isSurface(route.surface) ? route.surface : definition.surface,
        activeModel: route.model !== "" ? route.model : state.activeModel,
        lines: [...state.lines, line]
      };
    }

    case "delta": {
      const delta = payloadOf<Delta>(envelope);
      if (!delta || delta.text === "") return state;
      const index = openLineIndex(state.lines, envelope.turn);
      if (index < 0) {
        // Delta sem rota antes (transporte sem stream, replay parcial): abre a
        // linha com o especialista corrente em vez de perder o texto.
        return {
          ...state,
          lines: [
            ...state.lines,
            newLine(envelope, {
              specialist: speakerOf(envelope, state.activeSpecialist),
              model: state.activeModel,
              text: delta.text,
              streaming: true
            })
          ]
        };
      }
      const line = state.lines[index];
      if (!line) return state;
      return { ...state, lines: patchLine(state.lines, index, { text: line.text + delta.text }) };
    }

    case "message": {
      const message = payloadOf<Message>(envelope);
      if (!message) return state;

      if (message.role === "user") {
        // A linha do usuário NÃO é criada no `send`: o gateway ecoa este
        // envelope como primeiro do turno (é o que garante que a pergunta
        // sobreviva a uma falha de roteamento). Criar dos dois lados duplicaria.
        return {
          ...state,
          lines: [
            ...state.lines,
            newLine(envelope, { role: "user", text: message.text, streaming: false })
          ]
        };
      }

      if (message.role === "system") {
        return {
          ...state,
          lines: [
            ...state.lines,
            newLine(envelope, { role: "system", text: message.text, streaming: false })
          ]
        };
      }

      const index = openLineIndex(state.lines, envelope.turn);
      const specialist = speakerOf(envelope, message.specialist ?? state.activeSpecialist);
      if (index < 0) {
        return {
          ...state,
          lines: [
            ...state.lines,
            newLine(envelope, {
              specialist,
              model: message.model ?? state.activeModel,
              text: message.text,
              streaming: false
            })
          ]
        };
      }
      const line = state.lines[index];
      if (!line) return state;
      // O texto final SUBSTITUI o acumulado dos deltas: o delta é prévia, a
      // mensagem é a fonte. Concatenar aqui duplicaria a resposta inteira.
      return {
        ...state,
        lines: patchLine(state.lines, index, {
          text: message.text,
          streaming: false,
          specialist: line.specialist ?? specialist,
          model: line.model ?? message.model
        })
      };
    }

    case "thinking": {
      const thinking = payloadOf<Thinking>(envelope);
      if (!thinking) return state;
      return { ...state, thinking: thinking.done === true ? "" : thinking.label };
    }

    case "tool.call": {
      const call = payloadOf<ToolCall>(envelope);
      if (!call) return state;
      const index = currentLineIndex(state.lines, envelope.turn);
      if (index < 0) {
        return {
          ...state,
          lines: [
            ...state.lines,
            newLine(envelope, {
              specialist: speakerOf(envelope, state.activeSpecialist),
              streaming: true,
              toolCalls: [call]
            })
          ]
        };
      }
      const line = state.lines[index];
      if (!line) return state;
      return {
        ...state,
        lines: patchLine(state.lines, index, { toolCalls: [...(line.toolCalls ?? []), call] })
      };
    }

    case "tool.result": {
      const result = payloadOf<ToolResult>(envelope);
      if (!result) return state;
      // A ferramenta executou (ou falhou): o pedido de aprovação dela morreu.
      // Sem isto, o modal ficaria de pé sobre uma decisão que já aconteceu.
      const pendingApproval =
        state.pendingApproval && state.pendingApproval.callId === result.callId
          ? null
          : state.pendingApproval;
      const index = currentLineIndex(state.lines, envelope.turn);
      if (index < 0) {
        return {
          ...state,
          pendingApproval,
          lines: [
            ...state.lines,
            newLine(envelope, {
              specialist: speakerOf(envelope, state.activeSpecialist),
              streaming: true,
              toolResults: [result]
            })
          ]
        };
      }
      const line = state.lines[index];
      if (!line) return state;
      return {
        ...state,
        pendingApproval,
        lines: patchLine(state.lines, index, { toolResults: [...(line.toolResults ?? []), result] })
      };
    }

    case "approval.request": {
      const request = payloadOf<ApprovalRequest>(envelope);
      if (!request) return state;
      return { ...state, pendingApproval: request };
    }

    case "approval.decision": {
      const decision = payloadOf<ApprovalDecision>(envelope);
      if (!decision) return state;
      // Eco da decisão (outra janela, ou a nossa de volta pelo log).
      if (state.pendingApproval && state.pendingApproval.callId === decision.callId) {
        return { ...state, pendingApproval: null };
      }
      return state;
    }

    case "ask": {
      const ask = payloadOf<Ask>(envelope);
      if (!ask) return state;
      // O supervisor manda `ask` e PARA, esperando o `reply`. Cair no `default`
      // (era o que acontecia) fazia a pergunta sumir e o turno ficar preso com o
      // orbe girando até o timeout do outro lado.
      return { ...state, pendingAsk: ask };
    }

    case "reply": {
      const reply = payloadOf<Reply>(envelope);
      if (!reply) return state;
      // Eco da própria resposta pelo log, ou resposta dada em outra janela: em
      // qualquer dos casos a pergunta já foi respondida e o cartão tem de sair.
      if (state.pendingAsk && state.pendingAsk.askId === reply.askId) {
        return { ...state, pendingAsk: null };
      }
      return state;
    }

    case "task.dispatch": {
      const dispatch = payloadOf<TaskDispatch>(envelope);
      if (!dispatch) return state;
      return {
        ...state,
        crew: {
          ...state.crew,
          tasks: { ...state.crew.tasks, [dispatch.task.id]: dispatch.task },
          dispatches: [...state.crew.dispatches, dispatch]
        }
      };
    }

    case "task.progress": {
      const progress = payloadOf<TaskProgress>(envelope);
      if (!progress) return state;
      return {
        ...state,
        crew: { ...state.crew, progress: { ...state.crew.progress, [progress.taskId]: progress } }
      };
    }

    case "worker.done": {
      const done = payloadOf<WorkerDone>(envelope);
      if (!done) return state;
      return {
        ...state,
        crew: { ...state.crew, done: { ...state.crew.done, [done.taskId]: done } }
      };
    }

    case "escalate": {
      const escalation = payloadOf<Escalate>(envelope);
      if (!escalation) return state;
      return { ...state, crew: { ...state.crew, escalations: [...state.crew.escalations, escalation] } };
    }

    case "gate": {
      const gate = payloadOf<Gate>(envelope);
      if (!gate) return state;
      return { ...state, crew: { ...state.crew, gate } };
    }

    case "delegate": {
      const delegation = payloadOf<Delegate>(envelope);
      if (!delegation) return state;

      /*
       * A delegação NÃO passa por aprovação, e isso é decisão de produto, não
       * esquecimento: escolher de quem é o assunto é trabalho do bot. O portão
       * continua valendo para o que o delegado FAZ — cada ferramenta dele emite
       * `approval.request` como qualquer outra.
       */
      if (delegation.done !== true) {
        return { ...state, delegations: [...state.delegations, delegation] };
      }

      const index = openDelegationIndex(state.delegations, delegation);
      if (index < 0) {
        // Conclusão sem abertura à vista (replay parcial, janela aberta no meio
        // do turno): entra como concluída em vez de sumir. Perder o evento
        // apagaria a única prova de que a troca de bot aconteceu.
        return { ...state, delegations: [...state.delegations, delegation] };
      }

      const next = state.delegations.slice();
      const open = next[index];
      if (!open) return state;
      // A entrada aberta é MARCADA, não duplicada: são o mesmo acontecimento, e
      // duas linhas na lista fariam o popup reabrir uma delegação já encerrada.
      next[index] = { ...open, ...delegation, done: true };
      return { ...state, delegations: next };
    }

    case "notice": {
      const notice = payloadOf<Notice>(envelope);
      if (!notice || typeof notice.title !== "string" || notice.title === "") return state;
      // Fila SÓ de acréscimo: quem tira o aviso da tela é o componente, com o
      // timer dele (~4 s) — este redutor é puro e não tem relógio para decidir
      // que "já passou". A fila zera com a conversa, em conversationReset.
      return { ...state, notices: [...state.notices, notice] };
    }

    case "done": {
      return { ...state, busy: false, thinking: "", lines: closeTurn(state.lines, envelope.turn) };
    }

    case "error": {
      const failure = payloadOf<ProtocolError>(envelope);
      return {
        ...state,
        // O texto que já chegou fica: metade de uma resposta ainda é melhor que
        // uma tela em branco com um aviso vermelho.
        lines: closeTurn(state.lines, envelope.turn),
        error: failure?.message ?? "Falha no gateway.",
        busy: false,
        thinking: ""
      };
    }

    case "state": {
      const published = payloadOf<State>(envelope);
      if (!published) return state;
      // Só `busy` e o ambiente. Especialista, modelo e superfície chegam pela
      // ROTA, que é a única que também abre a linha e desenha a faixa de troca:
      // aplicá-los aqui trocaria a tela sem a pessoa ver por quê. O ambiente é
      // diferente — é um rótulo no rodapé, e ele PODE mudar de fora (outra
      // janela escolheu, ou o gateway caiu para local ao perder a VPS). Não
      // mostrar seria o rodapé prometer uma máquina que não é a da execução.
      //
      // A atualização entra pelo mesmo caminho e pelo mesmo motivo: ela é uma
      // condição do PROCESSO, não desta janela, e quem sabe dela é o gateway.
      //
      // O campo ausente PRESERVA o que já estava, e isso não é cautela genérica:
      // o gateway só anuncia a pendência (`update.Service.announce` sai fora
      // quando não há nenhuma), então todo `state` de outra origem — uma troca
      // de ambiente, por exemplo — chega sem esses campos. Zerar aqui faria o
      // aviso piscar e sumir no primeiro clique do rodapé. O aviso termina
      // quando o app reabre, que é exatamente o que ele pede.
      return {
        ...state,
        busy: published.busy,
        environment: published.environment ?? state.environment,
        updateAvailable: published.updateAvailable ?? state.updateAvailable,
        updateVersion: published.updateVersion ?? state.updateVersion,
        updateTracks: Array.isArray(published.updateTracks)
          ? published.updateTracks
          : state.updateTracks
      };
    }

    default:
      return state;
  }
}

/* ------------------------------- o store -------------------------------- */

/** Endereço padrão do gateway quando o app roda fora do Tauri (dev no navegador). */
const DEFAULT_URL = "ws://127.0.0.1:8799/v1/stream";

interface GatewayInfo {
  url: string;
  token: string;
}

/**
 * De onde vêm endereço e token.
 *
 * Quem conhece o segredo é o processo Rust — ele subiu o `aibotd` e leu o token
 * do DataDir. O token NUNCA é embutido no bundle nem lido de variável de
 * ambiente do WebView: ali ele viraria string no JavaScript servido, e qualquer
 * página aberta no mesmo contexto poderia lê-lo.
 */
async function gatewayInfo(): Promise<GatewayInfo> {
  try {
    const info = await invoke<GatewayInfo>("gateway_info");
    if (info && typeof info.url === "string" && typeof info.token === "string") return info;
  } catch {
    // Fora do Tauri (dev no navegador) o comando não existe. Segue sem token: a
    // conexão será recusada, e o estado "offline" já diz isso na tela.
  }
  return { url: DEFAULT_URL, token: "" };
}

/**
 * O transporte é um recurso do PROCESSO, não do estado: guardá-lo dentro do
 * store faria cada leitura de estado carregar um socket junto, e o `persist`
 * tentaria serializá-lo.
 */
let transport: Transport | null = null;

/**
 * O transporte ativo, para telas que falam REST autenticado fora do fluxo de
 * envelopes — a seção de provedores das configurações usa o `get`/`post`/`del`
 * dele. É função (e não a variável exportada) porque `import` congelaria o
 * valor de agora: o painel ficaria com `null` para sempre se abrisse antes do
 * `connect` terminar. Nulo enquanto não há conexão — quem chama mostra isso.
 */
export function activeTransport(): Transport | null {
  return transport;
}

/** Trava da janela assíncrona entre pedir o token e ter o transporte. */
let opening = false;

/** Turno corrente, deduzido da última linha — é o que o `stop` precisa interromper. */
function currentTurn(lines: ConversationLine[]): string {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line?.turn) return line.turn;
  }
  return "";
}

/** Limpa o que pertence a UMA conversa, preservando preferências e catálogo. */
function conversationReset(): Partial<AppData> {
  return {
    lines: [],
    crew: emptyCrew(),
    // As delegações são do TURNO, e o turno morre com a conversa. Mantê-las
    // faria o popup da conversa anterior reaparecer sobre a nova.
    delegations: [],
    // Mesmo destino para os avisos de execução: um "vai rodar num container"
    // da conversa anterior não anuncia nada sobre esta.
    notices: [],
    busy: false,
    thinking: "",
    pendingApproval: null,
    // A pergunta pertencia ao turno da conversa anterior; mantê-la de pé sobre
    // outra conversa pediria resposta para algo que ninguém mais vai ler.
    pendingAsk: null,
    activeSpecialist: "",
    activeSurface: "conversation",
    input: "",
    attachments: [],
    error: ""
  };
}

export const useApp = create<AppState>()(
  persist(
    (set, get) => ({
      ...initialAppData(),

      connect: () => {
        if (transport !== null || opening) return;
        opening = true;
        set({ status: "connecting" });
        void gatewayInfo()
          .then((info) => {
            opening = false;
            // `stop`/`connect` podem ter corrido enquanto o token era buscado.
            if (transport !== null) return;
            // Só a URL. O token fica na closure do transporte — ver `gatewayUrl`.
            set({ gatewayUrl: info.url });
            transport = createTransport({
              url: info.url,
              token: info.token,
              onEnvelope: (envelope) => set((state) => applyEnvelope(state, envelope)),
              onStatus: (status) => set({ status })
            });
            transport.start();
          })
          .catch(() => {
            opening = false;
            set({ status: "offline", error: "Não foi possível falar com o gateway." });
          });
      },

      send: (text) => {
        const state = get();
        const value = (text ?? state.input).trim();
        // Anexo sem texto vale como envio: "abre isso aqui" está implícito no
        // gesto de anexar — exigir uma frase junto seria cerimônia.
        if ((value === "" && state.attachments.length === 0) || transport === null) return;
        const prompt: Prompt = { text: value };
        // Vazio = o master decide, que é o caminho normal.
        if (state.specialistOverride !== "") prompt.specialist = state.specialistOverride;
        if (state.activeModel !== "") prompt.model = state.activeModel;
        if (state.attachments.length > 0) {
          // O anexo é REFERÊNCIA, não upload: o app é desktop e o arquivo já
          // está no disco — o especialista o lê pela pasta do projeto (fs.*,
          // office.*). O que viaja é o nome, que é o que o roteador usa para
          // decidir o dono (.docx → documentos, .sql → dados).
          prompt.attachments = state.attachments.map((item) => ({ ...item }));
        }
        transport.send<Prompt>("prompt", prompt);
        set({ input: "", attachments: [], busy: true, error: "", thinking: "" });
      },

      attach: (files) => {
        const current = get().attachments;
        const additions = files
          .filter((file) => file.name.trim() !== "")
          .filter((file) => !current.some((existing) => existing.name === file.name))
          .map((file) => ({
            name: file.name,
            mime: file.mime,
            bytes: file.bytes,
            // Sem upload não há referência de conteúdo; o campo existe no
            // protocolo para quando houver.
            ref: ""
          }));
        if (additions.length === 0) return;
        set({ attachments: [...current, ...additions] });
      },

      detach: (name) => {
        set({ attachments: get().attachments.filter((item) => item.name !== name) });
      },

      stop: () => {
        // O protocolo não tem verbo "cancelar": interromper é declarar o turno
        // encerrado por vontade da pessoa, e o supervisor cancela o contexto.
        transport?.send<Done>("done", { turn: currentTurn(get().lines), interrupted: true });
        // O botão responde na hora. Esperar o `done` do servidor deixaria o
        // orbe girando contra uma resposta que a pessoa já mandou parar.
        set({ busy: false, thinking: "" });
      },

      decide: (callId, allow, scope) => {
        transport?.send<ApprovalDecision>("approval.decision", { callId, allow, scope });
        set({ pendingApproval: null });
      },

      decideGate: (gateId, decision) => {
        transport?.send<Gate>("gate", { gateId, decision });
        set((state) => ({ crew: { ...state.crew, gate: null } }));
      },

      answerAsk: (answer) => {
        const ask = get().pendingAsk;
        // Sem pergunta aberta não há `askId` para carimbar, e um `reply` órfão
        // não é ignorado do outro lado: ele destravaria a pergunta errada.
        if (!ask) return;
        transport?.send<Reply>("reply", { askId: ask.askId, answer });
        // Fecha na hora, sem esperar o eco: o turno do outro lado só volta a
        // andar depois desta resposta, e o cartão de pé sugeriria o contrário.
        set({ pendingAsk: null });
      },

      setInput: (text) => set({ input: text }),

      setModel: (id) => set({ activeModel: id }),

      /**
       * Troca o ambiente do PRÓXIMO comando.
       *
       * Quem executa é o gateway, então a escolha só vale depois que ele
       * confirma — por isso o POST, e por isso o desfazer. Um rodapé que mostra
       * "Docker" enquanto o gateway continua em "local" não é um detalhe de
       * interface: é o comando caindo na estação da pessoa.
       */
      setEnvironment: (id) => {
        const { environment: previous, session } = get();
        if (id === previous) return;

        if (transport === null || session === null || session === "") {
          set({ error: `sem conexão com o gateway: o ambiente continua em ${previous}` });
          return;
        }

        // Otimista, porque o menu tem de fechar com a escolha aplicada — e
        // reversível, porque a confirmação é do outro lado.
        set({ environment: id, error: "" });

        void transport
          .post(`/v1/sessions/${encodeURIComponent(session)}/environment`, { environment: id })
          .catch((cause: unknown) => {
            const reason = cause instanceof Error ? cause.message : "falha ao falar com o gateway";
            set((current) =>
              // Outra escolha pode ter entrado enquanto o POST corria; desfazer
              // por cima dela devolveria o rodapé a um ambiente que ninguém
              // pediu. Só desfaz o que ainda é o nosso.
              current.environment === id
                ? { environment: previous, error: `o ambiente continua em ${previous}: ${reason}` }
                : {}
            );
          });
      },

      setSpecialistOverride: (id) => set({ specialistOverride: id }),

      newSession: () => {
        // Sessão nova é um `hello` novo na MESMA conexão: o token já foi aceito
        // no primeiro frame, e sem `sessionHint` o gateway abre uma sessão.
        transport?.resumeFrom(0);
        transport?.send<Hello>("hello", {
          client: CLIENT_NAME,
          version: CLIENT_VERSION,
          resumeFrom: 0
        });
        set({ ...conversationReset(), session: null });
      },

      openSession: (id) => {
        if (id === get().session) return;
        transport?.resumeFrom(0);
        transport?.send<Hello>("hello", {
          client: CLIENT_NAME,
          version: CLIENT_VERSION,
          sessionHint: id,
          resumeFrom: 0
        });
        // As linhas voltam pelo replay do gateway, não de um cache local.
        set({ ...conversationReset(), session: id });
      },

      /**
       * Ramifica uma conversa: o gateway copia o log até aqui para uma sessão
       * NOVA (POST /fork) e a tela abre o ramo na hora — dois futuros sobre o
       * mesmo passado, sem recontar a história.
       *
       * Quem cria é o gateway, então a lista da barra só ganha a linha nova no
       * próximo `ready`; abrir a sessão devolvida já basta para trabalhar nela.
       */
      forkSession: (id) => {
        if (transport === null) {
          set({ error: "sem conexão com o gateway — não deu para ramificar a conversa" });
          return;
        }
        void transport
          .post(`/v1/sessions/${encodeURIComponent(id)}/fork`, {})
          .then((body) => {
            const forked = body as { id?: unknown } | undefined;
            if (forked && typeof forked.id === "string" && forked.id !== "") {
              get().openSession(forked.id);
              return;
            }
            // 201 sem corpo legível: a sessão pode ter nascido, mas sem o id
            // não há o que abrir — e fingir sucesso deixaria a pessoa na
            // conversa antiga achando que está no ramo.
            set({ error: "o gateway ramificou sem devolver a sessão nova — abra a lista de conversas" });
          })
          .catch((cause: unknown) => {
            const reason = cause instanceof Error ? cause.message : "falha ao falar com o gateway";
            set({ error: `não deu para ramificar a conversa: ${reason}` });
          });
      },

      setTheme: (theme) => set({ theme }),

      toggleRail: () => set((state) => ({ railOpen: !state.railOpen })),

      setAvatarLabOpen: (open) => set({ avatarLabOpen: open }),

      setSettingsOpen: (open) => set({ settingsOpen: open }),

      setAvatar: (specialist, avatar) =>
        set((state) => ({
          // `custom` marca o que a pessoa mexeu — é o que o botão "restaurar"
          // usa para saber que há o que restaurar.
          avatars: { ...state.avatars, [specialist]: { ...avatar, custom: true } }
        })),

      resetAvatar: (specialist) =>
        set((state) => {
          const next = { ...state.avatars };
          delete next[specialist];
          return { avatars: next };
        })
    }),
    {
      name: "aibot.v1",
      version: 1,
      /*
       * O `localStorage` NÃO entra aqui cru.
       *
       * O `persist` grava a cada `setState`, e este store recebe um `set` por
       * TOKEN de resposta: sem freio, um turno de 800 tokens são 800
       * `JSON.stringify` mais 800 escritas síncronas na thread que desenha —
       * mesmo com o `partialize` abaixo deixando o payload minúsculo, porque o
       * custo é por `set` e não por byte. O armazenamento coalescido junta a
       * rajada numa gravação, pula o valor que não mudou e descarrega no
       * fechamento. Ver `persistStorage.ts`.
       */
      storage: createJSONStorage(() => preferenceStorage()),
      // Só preferência. Conversa e sessões vêm do gateway — ver o cabeçalho.
      partialize: (state) => ({
        theme: state.theme,
        railOpen: state.railOpen,
        avatars: state.avatars
      })
    }
  )
);
