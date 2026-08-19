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
import {
  baixarArquivo,
  coletarEventos,
  eventosParaJson,
  eventosParaMarkdown,
  nomeDoArquivo
} from "./sessionExport";
import { expandSlashCommand } from "./slashCommands";
import { FALLBACK_SPECIALISTS, specialistById } from "./specialists";
import { createTransport, type Transport } from "./transport";

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
  busy: boolean;
  /** Rótulo do orbe; "" quando parado. */
  thinking: string;
  /**
   * Os pedidos de aprovação ABERTOS, em ordem de chegada.
   *
   * Fila, e não um slot só: uma onda de equipe com quatro trabalhadores dispara
   * quatro pedidos ao mesmo tempo, e o slot único fazia o segundo SOBRESCREVER o
   * primeiro. A pessoa via um cartão, decidia um, e os outros ficavam presos até
   * o prazo de dez minutos — recusados por silêncio, segurando a onda inteira,
   * o despacho e o turno do dono da conversa junto. Com `maxConcurrency` até 32,
   * 31 pedidos podiam morrer sem nunca aparecer na tela.
   */
  pendingApprovals: ApprovalRequest[];
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
  /**
   * O que cada conversa de bot está fazendo AGORA, para a barra sinalizar sem
   * abrir: "trabalhando" enquanto a delegação roda, "naoLida" quando o
   * resultado chegou e a pessoa estava em outra conversa. Abrir a conversa
   * limpa. Vive só nesta janela (não persiste, não vem no ready): é sinal de
   * atenção, não histórico — perder no reinício é aceitável, inventar não.
   */
  atividadeDasConversas: Record<string, "trabalhando" | "naoLida">;
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
  /**
   * Conversa nova. Sem argumento é a volta ao começo (o master decide quem
   * atende). Com `botId` é o "novo schema" da tela de Dados: a conversa nasce
   * DAQUELE bot e a pessoa FICA na tela dele — mudar para o chat no meio do
   * gesto confunde quem só queria recomeçar o trabalho ali.
   */
  newSession(botId?: string): void;
  openSession(id: string): void;
  forkSession(id: string): void;
  /** Apaga a conversa no gateway (DELETE) e tira a linha da barra na hora. */
  deleteSession(id: string): void;
  /**
   * Baixa a conversa como arquivo: `.md` legível (só as falas) ou `.json` com
   * os envelopes crus. Serialização em lib/sessionExport; a rota de eventos é
   * a mesma do replay (GET /events), paginada até o fim.
   */
  exportSession(id: string, format: "md" | "json"): void;
  /**
   * Regenera a última resposta: trunca o log até ANTES da última pergunta
   * (rota /truncate) e reenvia o mesmo texto. Sem o corte durável, o reenvio
   * só acrescentaria — e a pergunta duplicaria para sempre no histórico que o
   * modelo lê.
   */
  regenerateLastTurn(): void;
  /** Mesmo corte do regenerar, mas devolve o texto ao composer para editar. */
  editLastTurn(): void;
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
    busy: false,
    thinking: "",
    pendingApprovals: [],
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
    atividadeDasConversas: {},
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
/**
 * A linha ABERTA do turno **daquele falante**.
 *
 * O falante entra na chave porque o turno sozinho não identifica uma bolha. Dois
 * casos provavam isso:
 *
 * - numa onda de equipe, dois trabalhadores streamam no mesmo turno (`crew-…`) e
 *   o segundo não abria linha nova — o texto dele era concatenado na do primeiro,
 *   token a token, sob o avatar do primeiro;
 * - depois de uma delegação, o delegado deixava uma bolha aberta e a resposta
 *   FINAL de quem delegou caía dentro dela, assinada pelo bot errado.
 */
function openLineIndex(
  lines: ConversationLine[],
  turn: string | undefined,
  speakerId?: string
): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line) continue;
    if (line.role !== "assistant" || line.turn !== turn || line.streaming !== true) continue;
    if (speakerId !== undefined && line.speakerId !== speakerId) continue;
    return index;
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
    speakerId: envelope.from.id,
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
    turns: summary.turns,
    botId: summary.botId,
    parentId: summary.parentId,
    lastGoal: summary.lastGoal
  };
}

/**
 * A lista de conversas com a entrada de `id` transformada.
 *
 * É o que mantém a BARRA viva durante a conversa: o resumo que veio no `ready`
 * é uma fotografia (título vazio, zero turnos), e sem estes retoques a linha da
 * conversa ativa ficava "Conversa sem título · 0" até a próxima reconexão —
 * mesmo com a pessoa já três pedidos adentro. O gateway continua sendo a fonte:
 * o próximo `ready` reescreve tudo isto com o valor canônico.
 */
function comMetaDaSessao(
  sessions: SessionMeta[],
  id: string,
  muda: (meta: SessionMeta) => SessionMeta
): SessionMeta[] {
  const index = sessions.findIndex((item) => item.id === id);
  const atual = index >= 0 ? sessions[index] : undefined;
  if (!atual) return sessions;
  const next = sessions.slice();
  next[index] = muda(atual);
  return next;
}

/**
 * O título provisório — o espelho do `titleFrom` do gateway (60 caracteres,
 * espaços colapsados). Provisório de verdade: o gateway grava o dele no meta da
 * sessão e o próximo `ready` traz o canônico; este só existe para a linha da
 * barra não dizer "sem título" durante a própria conversa que o batizou.
 */
function tituloDe(texto: string): string {
  const limpo = texto.split(/\s+/).filter(Boolean).join(" ");
  if (limpo.length <= 60) return limpo;
  return `${[...limpo].slice(0, 60).join("").trimEnd()}…`;
}

/**
 * A lista de conversas com a conversa DAQUELE bot dentro dela.
 *
 * Busca-ou-cria, e do lado de cá pelo mesmo motivo do gateway: um bot chamado
 * dez vezes na mesma conversa tem UMA conversa com dez trechos. O segundo
 * envelope da mesma delegação (o `done`) cai aqui de novo e não pode duplicar a
 * linha.
 *
 * O título é o NOME do especialista, não o objetivo: a linha responde "com quem
 * eu falo aqui", e o objetivo já está escrito dentro da conversa, como a
 * primeira fala.
 */
function comConversaDoBot(state: AppData, parentId: string, delegation: Delegate): SessionMeta[] {
  const id = (delegation.session ?? "").trim();
  // Gateway antigo não manda o campo, e delegação com espelho falhado manda
  // vazio. Nos dois casos a delegação segue valendo — o que se perde é a linha
  // lateral, não a resposta.
  if (id === "" || parentId === "") {
    return state.sessions;
  }
  const objetivo = (delegation.goal ?? "").trim();
  if (state.sessions.some((item) => item.id === id)) {
    // A filha já existe: a chamada nova só troca o SUBTÍTULO — o pedido em
    // curso. É o que separa "Código · landing page" de "Código · agora o CSS".
    if (objetivo === "" || delegation.done === true) return state.sessions;
    return comMetaDaSessao(state.sessions, id, (meta) => ({ ...meta, lastGoal: objetivo }));
  }
  const bot = specialistById(state.specialists, delegation.to);
  const agora = new Date().toISOString();
  return [
    {
      id,
      title: bot.name,
      specialist: bot.id,
      botId: bot.id,
      parentId,
      createdAt: agora,
      updatedAt: agora,
      lastGoal: objetivo,
      // Já tem conteúdo de verdade: o gateway gravou o pedido ali antes de
      // publicar este envelope. Zero aqui faria o filtro da barra escondê-la
      // justamente na hora em que ela precisa aparecer.
      lastSeq: 1,
      syncedSeq: 0,
      turns: 1
    },
    ...state.sessions
  ];
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
/**
 * Tira UM pedido da fila pelo `callId`, devolvendo a MESMA fila quando não havia
 * o que tirar.
 *
 * A identidade importa: o redutor é comparado por referência lá em cima para
 * decidir se houve mudança, e devolver um array novo a cada `tool.result`
 * repintaria a tela inteira a cada resultado de ferramenta.
 */
function dropApproval(queue: ApprovalRequest[], callId: string): ApprovalRequest[] {
  if (!queue.some((item) => item.callId === callId)) return queue;
  return queue.filter((item) => item.callId !== callId);
}

/**
 * O índice da ÚLTIMA fala de assistente do turno, de quem quer que seja.
 *
 * Serve para uma pergunta só: "alguém falou depois de mim?". Os deltas de uma
 * equipe chegam intercalados e cada trabalhador acha a própria bolha pelo id;
 * já a MENSAGEM final de quem delegou não pode voltar para uma bolha antiga
 * quando outro bot falou no meio — a conclusão apareceria acima da consulta que
 * a produziu, e a conversa se leria de trás para a frente.
 */
function lastAssistantIndex(lines: ConversationLine[], turn: string | undefined): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line) continue;
    if (line.role === "assistant" && line.turn === turn) return index;
  }
  return -1;
}

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
        // A rota também assina a LINHA DA BARRA: é ela que troca o retrato da
        // conversa para o do especialista que assumiu — sem isto, a barra
        // mostrava o orbe genérico até a próxima reconexão ("não abriu bot de
        // dados, apenas alterou tela").
        sessions: comMetaDaSessao(state.sessions, envelope.session, (meta) => ({
          ...meta,
          specialist: route.specialist
        })),
        activeSpecialist: route.specialist,
        activeSurface: isSurface(route.surface) ? route.surface : definition.surface,
        activeModel: route.model !== "" ? route.model : state.activeModel,
        lines: [...state.lines, line]
      };
    }

    case "delta": {
      const delta = payloadOf<Delta>(envelope);
      if (!delta || delta.text === "") return state;
      const speaker = speakerOf(envelope, state.activeSpecialist);
      const index = openLineIndex(state.lines, envelope.turn, envelope.from.id);
      if (index < 0) {
        // Delta sem rota antes (transporte sem stream, replay parcial), ou o
        // primeiro delta de OUTRO falante no mesmo turno: abre linha própria em
        // vez de perder o texto — ou de colá-lo na bolha de quem não o disse.
        return {
          ...state,
          lines: [
            ...state.lines,
            newLine(envelope, {
              specialist: speaker,
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
          // A primeira fala BATIZA a linha da barra: o gateway grava o título
          // no meta da sessão mas não o transmite no meio da conversa, e sem
          // este provisório a conversa ativa ficava "sem título" até a próxima
          // reconexão.
          sessions: comMetaDaSessao(state.sessions, envelope.session, (meta) =>
            meta.title === "" && message.text.trim() !== ""
              ? { ...meta, title: tituloDe(message.text) }
              : meta
          ),
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

      const specialist = speakerOf(envelope, message.specialist ?? state.activeSpecialist);
      // A bolha só é reaproveitada se ainda for a ÚLTIMA do turno. Se outro bot
      // falou no meio — o delegado, um trabalhador —, a conclusão abre bolha
      // nova, no fim, que é onde quem lê espera encontrá-la.
      const aberta = openLineIndex(state.lines, envelope.turn, envelope.from.id);
      const index = aberta >= 0 && aberta === lastAssistantIndex(state.lines, envelope.turn) ? aberta : -1;
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
          // A AUTORIA DO ENVELOPE VENCE. Antes era `line.specialist ?? specialist`,
          // e `??` só cai no fallback com null/undefined — a bolha aberta pelo
          // delegado já vinha com `specialist` preenchido, então a conclusão de
          // quem delegou saía assinada pelo bot errado.
          specialist,
          model: line.model ?? message.model
        })
      };
    }

    case "thinking": {
      const thinking = payloadOf<Thinking>(envelope);
      if (!thinking) return state;
      /*
       * RACIOCÍNIO ≠ rótulo de etapa. O gateway sempre mandou os dois pelo
       * mesmo verbo; sem a marca `reasoning`, cada pedaço do raciocínio
       * piscava no orbe (substituindo o anterior) e o texto morria ali. Com a
       * marca, o texto ACUMULA na linha do falante — é o bloco recolhível que
       * a superfície desenha — e o orbe ganha um rótulo fixo. Gateway antigo
       * não manda o campo e cai no comportamento de sempre, logo abaixo.
       */
      if (thinking.reasoning === true && thinking.done !== true) {
        if (thinking.label === "") return state;
        const index = openLineIndex(state.lines, envelope.turn, envelope.from.id);
        if (index < 0) {
          // O raciocínio chega ANTES do primeiro delta: é ele que abre a linha
          // do falante — e é nela que os deltas seguintes vão se pendurar.
          return {
            ...state,
            thinking: "raciocinando",
            lines: [
              ...state.lines,
              newLine(envelope, {
                specialist: speakerOf(envelope, state.activeSpecialist),
                model: state.activeModel,
                reasoning: thinking.label,
                streaming: true
              })
            ]
          };
        }
        const line = state.lines[index];
        if (!line) return state;
        return {
          ...state,
          thinking: "raciocinando",
          lines: patchLine(state.lines, index, {
            reasoning: (line.reasoning ?? "") + thinking.label
          })
        };
      }
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
      const pendingApprovals = dropApproval(state.pendingApprovals, result.callId);
      const index = currentLineIndex(state.lines, envelope.turn);
      if (index < 0) {
        return {
          ...state,
          pendingApprovals,
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
        pendingApprovals,
        lines: patchLine(state.lines, index, { toolResults: [...(line.toolResults ?? []), result] })
      };
    }

    case "approval.request": {
      const request = payloadOf<ApprovalRequest>(envelope);
      if (!request) return state;
      // Reentrega do mesmo pedido (replay, reconexão) não duplica o cartão.
      if (state.pendingApprovals.some((item) => item.callId === request.callId)) return state;
      return { ...state, pendingApprovals: [...state.pendingApprovals, request] };
    }

    case "approval.decision": {
      const decision = payloadOf<ApprovalDecision>(envelope);
      if (!decision) return state;
      // Eco da decisão (outra janela, ou a nossa de volta pelo log).
      const restantes = dropApproval(state.pendingApprovals, decision.callId);
      if (restantes === state.pendingApprovals) return state;
      return { ...state, pendingApprovals: restantes };
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
      /*
       * Portão COM decisão é o ECO de algo já resolvido: ele FECHA o cartão em
       * vez de abrir outro. O pedido vem sem `decision`; a resposta vem com ela.
       *
       * Sem esta distinção, reabrir a conversa reencenava o log inteiro e o
       * pedido voltava à tela — convidando a pessoa a decidir uma onda que
       * terminou faz tempo. O cartão daqui é `alertdialog`: ele para o que a
       * pessoa está fazendo para perguntar algo que já foi respondido.
       */
      if (gate.decision) {
        return state.crew.gate?.gateId === gate.gateId
          ? { ...state, crew: { ...state.crew, gate: null } }
          : state;
      }
      return { ...state, crew: { ...state.crew, gate } };
    }

    case "delegate": {
      const delegation = payloadOf<Delegate>(envelope);
      if (!delegation) return state;

      // A conversa do bot entra na barra AGORA, junto com o popup — não na
      // próxima abertura do app. Ela existe no gateway desde este envelope; se
      // a lista só soubesse dela no `ready` seguinte, a pessoa veria o Código
      // trabalhar e não teria onde clicar para continuar com ele.
      const sessions = comConversaDoBot(state, envelope.session, delegation);

      // O SINAL da linha: trabalhando enquanto a delegação roda; quando fecha,
      // vira "não lida" — a menos que a pessoa esteja com ela aberta, caso em
      // que não há nada por ler que ela já não esteja vendo.
      let atividade = state.atividadeDasConversas;
      const filhaID = (delegation.session ?? "").trim();
      if (filhaID !== "") {
        atividade = { ...atividade };
        if (delegation.done !== true) {
          atividade[filhaID] = "trabalhando";
        } else if (state.session === filhaID) {
          delete atividade[filhaID];
        } else {
          atividade[filhaID] = "naoLida";
        }
      }
      state = { ...state, atividadeDasConversas: atividade };

      /*
       * A delegação NÃO passa por aprovação, e isso é decisão de produto, não
       * esquecimento: escolher de quem é o assunto é trabalho do bot. O portão
       * continua valendo para o que o delegado FAZ — cada ferramenta dele emite
       * `approval.request` como qualquer outra.
       */
      if (delegation.done !== true) {
        return { ...state, sessions, delegations: [...state.delegations, delegation] };
      }

      const index = openDelegationIndex(state.delegations, delegation);
      if (index < 0) {
        // Conclusão sem abertura à vista (replay parcial, janela aberta no meio
        // do turno): entra como concluída em vez de sumir. Perder o evento
        // apagaria a única prova de que a troca de bot aconteceu.
        return { ...state, sessions, delegations: [...state.delegations, delegation] };
      }

      const next = state.delegations.slice();
      const open = next[index];
      if (!open) return { ...state, sessions };
      // A entrada aberta é MARCADA, não duplicada: são o mesmo acontecimento, e
      // duas linhas na lista fariam o popup reabrir uma delegação já encerrada.
      next[index] = { ...open, ...delegation, done: true };
      return { ...state, sessions, delegations: next };
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
      const done = payloadOf<Done>(envelope);
      let lines = closeTurn(state.lines, envelope.turn);
      /*
       * AS MÉTRICAS DO TURNO ficam na última linha do assistente: o `done` já
       * traz os tokens de saída, e a duração sai dos TIMESTAMPS dos envelopes
       * (primeiro do turno → este), não do relógio da tela — o redutor é puro,
       * e é isso que faz os números sobreviverem ao replay: reabrir a conversa
       * mostra a mesma duração de quando ela aconteceu.
       */
      const index = lastAssistantIndex(lines, envelope.turn);
      if (index >= 0) {
        const primeira = lines.find((line) => line.turn === envelope.turn);
        const fim = Date.parse(envelope.ts);
        const inicio = primeira ? Date.parse(primeira.ts) : Number.NaN;
        const patch: Partial<ConversationLine> = {};
        if (Number.isFinite(fim) && Number.isFinite(inicio) && fim >= inicio) {
          patch.durationMs = fim - inicio;
        }
        if (typeof done?.outputTokens === "number" && done.outputTokens > 0) {
          patch.outputTokens = done.outputTokens;
        }
        if (Object.keys(patch).length > 0) {
          lines = patchLine(lines, index, patch);
        }
      }
      return {
        ...state,
        busy: false,
        thinking: "",
        // O contador da linha anda JUNTO com a conversa. É provisório como o
        // título: o próximo `ready` traz o valor canônico do gateway.
        sessions: comMetaDaSessao(state.sessions, envelope.session, (meta) => ({
          ...meta,
          turns: meta.turns + 1
        })),
        lines
      };
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

/** O alvo do regenerar/editar: a última pergunta que está DE VERDADE no log. */
export interface UltimoTurno {
  /** O id da linha do usuário — é nela que o botão "editar" se pendura. */
  lineId: string;
  /** O seq da pergunta: o ponto de corte do /truncate (inclusive). */
  seq: number;
  turn: string;
  text: string;
}

/**
 * A última fala do usuário com `seq` real. Linhas sem seq (efêmeras, eco local)
 * não servem de âncora: o corte é no LOG, e cortar por um número que o log não
 * tem apagaria a conversa no lugar errado.
 */
export function ultimoTurnoDoUsuario(lines: ConversationLine[]): UltimoTurno | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line || line.role !== "user") continue;
    if (line.seq <= 0 || !line.turn) return null;
    return { lineId: line.id, seq: line.seq, turn: line.turn, text: line.text };
  }
  return null;
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
    pendingApprovals: [],
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

/**
 * O miolo do regenerar/editar — um só, porque os dois gestos são o MESMO corte
 * com destinos diferentes para o texto (reenviar × devolver ao composer).
 *
 * A ordem importa e é esta: truncar no gateway (POST /truncate), REABRIR a
 * sessão pelo transporte (re-hello: o replay reconstrói as linhas do log já
 * cortado) e só então dispor do texto. Reenviar sem truncar era o defeito que
 * a rota existe para impedir — a pergunta duplicava para sempre no histórico.
 */
function cortarUltimoTurno(
  modo: "regenerar" | "editar",
  get: () => AppState,
  set: (partial: Partial<AppState>) => void
): void {
  const state = get();
  const gesto = modo === "regenerar" ? "regenerar a resposta" : "editar a pergunta";
  if (state.busy) {
    // O gateway recusa truncar turno em execução (409); recusar aqui poupa a
    // ida e diz o motivo com a palavra certa.
    set({ error: `há uma resposta em andamento — interrompa antes de ${gesto}` });
    return;
  }
  const alvo = ultimoTurnoDoUsuario(state.lines);
  if (!alvo) return;
  const sessao = state.session;
  if (transport === null || sessao === null || sessao === "" || state.status !== "ready") {
    set({ error: `sem conexão com o gateway — não deu para ${gesto}` });
    return;
  }
  void transport
    .post(`/v1/sessions/${encodeURIComponent(sessao)}/truncate`, { beforeSeq: alvo.seq })
    .then(() => {
      // Corte confirmado: a conversa reabre NA MESMA conexão e o replay traz o
      // log já sem o último turno — as linhas locais não são fonte de nada.
      transport?.switchSession(sessao);
      if (modo === "editar") {
        set({ ...conversationReset(), session: sessao, input: alvo.text });
        return;
      }
      set({ ...conversationReset(), session: sessao });
      get().send(alvo.text);
    })
    .catch((cause: unknown) => {
      const reason = cause instanceof Error ? cause.message : "falha ao falar com o gateway";
      set({ error: `não deu para ${gesto}: ${reason}` });
    });
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
            /*
             * O REPLAY entra em LOTE, o vivo entra na hora.
             *
             * Abrir uma conversa longa entrega centenas de envelopes em
             * rajada, e um set() do zustand por envelope é um render do React
             * por envelope — O(N) renders para desenhar um estado só. O
             * remédio NÃO pode ser adiar a REDUÇÃO: o transporte só avança o
             * marco de replay quando a aplicação deu certo ("aplica PRIMEIRO,
             * avança o marco DEPOIS"), então cada envelope é reduzido
             * SINCRONAMENTE aqui — uma exceção ainda sobe e segura o marco. O
             * que o lote adia é só o set(): os subscribers veem o acumulado
             * uma vez por quadro.
             *
             * O lote só arma DURANTE a rajada de replay (do `ready` até o seq
             * anunciado nele). No vivo, cada envelope vira set() imediato —
             * atrasar um delta de streaming em 16ms seria trocar abertura mais
             * rápida por digitação mais lenta.
             */
            let acumulado: AppData | null = null;
            let acumuladoSessao: string | null = null;
            let replayAte = 0;
            let flushAgendado = 0;
            const descartar = () => {
              if (flushAgendado !== 0) cancelAnimationFrame(flushAgendado);
              flushAgendado = 0;
              acumulado = null;
              acumuladoSessao = null;
            };
            const flush = () => {
              flushAgendado = 0;
              if (acumulado === null) return;
              // A pessoa trocou de conversa NO MEIO do replay: o acumulado é da
              // conversa que ela abandonou, e entregá-lo agora ressuscitaria as
              // linhas velhas por cima da tela recém-zerada. Descarta — a
              // conversa nova replaya do zero de qualquer jeito.
              if (get().session !== acumuladoSessao) {
                descartar();
                return;
              }
              const pronto = acumulado;
              acumulado = null;
              acumuladoSessao = null;
              set(pronto);
            };
            transport = createTransport({
              url: info.url,
              token: info.token,
              onEnvelope: (envelope) => {
                if (envelope.kind === "ready") {
                  // Um ready novo é OUTRA sessão (ou reconexão): o lote da
                  // anterior morreu com ela.
                  descartar();
                  const seq = (envelope.payload as Ready | undefined)?.seq;
                  replayAte = typeof seq === "number" ? seq : 0;
                  set((state) => applyEnvelope(state, envelope));
                  return;
                }
                const emReplay =
                  envelope.seq !== 0 && replayAte !== 0 && envelope.seq <= replayAte;
                if (!emReplay) {
                  flush();
                  set((state) => applyEnvelope(state, envelope));
                  return;
                }
                // Reduz JÁ (a exceção sobe e o marco não anda); só o set espera.
                if (acumulado === null) acumuladoSessao = get().session;
                acumulado = applyEnvelope(acumulado ?? get(), envelope);
                if (envelope.seq >= replayAte) {
                  // Última peça do replay: entrega tudo de uma vez.
                  flush();
                  return;
                }
                if (flushAgendado === 0) {
                  flushAgendado = requestAnimationFrame(flush);
                }
              },
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
        // Comando de barra vira prompt completo AQUI, antes do transporte:
        // `/review` literal deixava o modelo adivinhar o que fazer com uma
        // linha de comando solta. O `/mode` NÃO é expandido — ele é verbo do
        // gateway (ver slashCommands.ts).
        const value = expandSlashCommand((text ?? state.input).trim());
        // Anexo sem texto vale como envio: "abre isso aqui" está implícito no
        // gesto de anexar — exigir uma frase junto seria cerimônia.
        if (value === "" && state.attachments.length === 0) return;
        // Sem conexão, a falha é DITA — não engolida. O transporte descarta
        // envio com socket fechado em silêncio (decisão certa lá: fila de
        // saída reenviaria pergunta abandonada), então quem tem de avisar é
        // aqui: a pessoa apertou Enter e nada aconteceu, sem uma palavra —
        // "não estou conseguindo testar" foi exatamente este silêncio.
        if (transport === null || state.status !== "ready") {
          set({
            error:
              state.status === "connecting"
                ? "ainda conectando ao gateway — o pedido não foi enviado; tente de novo em instantes"
                : "sem conexão com o gateway — o pedido não foi enviado"
          });
          return;
        }
        const prompt: Prompt = { text: value };
        // Vazio = o master decide, que é o caminho normal.
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
        set((state) => ({ pendingApprovals: dropApproval(state.pendingApprovals, callId) }));
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


      newSession: (botId) => {
        // Sessão nova é um `hello` novo na MESMA conexão, e ele é do TRANSPORTE
        // (`switchSession`), não montado aqui: o hello de troca reapresenta o
        // token, e o token vive só na closure do transporte. A versão anterior
        // montava o frame aqui, sem token — e o gateway o descartava em
        // silêncio: "nova conversa" limpava a tela, mas todo pedido seguinte
        // caía na sessão antiga, cujo modo gravado respondia sempre com o
        // mesmo especialista.
        const bot = (botId ?? "").trim();
        transport?.switchSession(null, bot === "" ? undefined : bot);
        if (bot === "") {
          set({ ...conversationReset(), session: null });
          return;
        }
        // "Novo schema" na tela de Dados: a conversa nasce DO BOT e a pessoa
        // FICA na tela dele — o gateway grava o dono na criação e o `ready`
        // volta confirmando estes mesmos valores, então não há piscada nem
        // desvio pelo chat no meio do gesto.
        set({
          ...conversationReset(),
          session: null,
          activeSpecialist: bot,
          activeSurface: specialistById(get().specialists, bot).surface
        });
      },

      openSession: (id) => {
        if (id === get().session) return;
        // Mesma regra do newSession: a troca é do transporte, que tem o token.
        transport?.switchSession(id);
        // Abrir LÊ: o sinal de "não lida" (ou "trabalhando" — a pessoa está
        // olhando) desta conversa se apaga aqui.
        const atividade = { ...get().atividadeDasConversas };
        delete atividade[id];
        // As linhas voltam pelo replay do gateway, não de um cache local.
        set({ ...conversationReset(), session: id, atividadeDasConversas: atividade });
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

      deleteSession: (id) => {
        if (transport === null) {
          set({ error: "sem conexão com o gateway — não deu para apagar a conversa" });
          return;
        }
        void transport
          .del(`/v1/sessions/${encodeURIComponent(id)}`)
          .then(() => {
            const state = get();
            // A linha sai da barra na hora; o próximo `ready` confirma a lista
            // canônica (que já não tem a sessão — o gateway a apagou primeiro).
            set({ sessions: state.sessions.filter((item) => item.id !== id) });
            // Apagar a conversa ABERTA não pode deixar a tela escrevendo num
            // log que não existe: volta ao começo, como a conversa nova.
            if (state.session === id) get().newSession();
          })
          .catch((cause: unknown) => {
            const reason = cause instanceof Error ? cause.message : "falha ao falar com o gateway";
            set({ error: `não deu para apagar a conversa: ${reason}` });
          });
      },

      exportSession: (id, format) => {
        // Capturado na entrada: o transporte pode virar null no meio da
        // paginação (stop/reconexão), e o fio da exportação precisa ser UM só.
        const wire = transport;
        if (wire === null) {
          set({ error: "sem conexão com o gateway — não deu para exportar a conversa" });
          return;
        }
        const titulo = get().sessions.find((item) => item.id === id)?.title ?? "";
        void coletarEventos((path) => wire.get(path), id)
          .then((events) => {
            if (format === "json") {
              baixarArquivo(nomeDoArquivo(titulo, id, "json"), "application/json", eventosParaJson(events));
              return;
            }
            baixarArquivo(nomeDoArquivo(titulo, id, "md"), "text/markdown", eventosParaMarkdown(events, titulo));
          })
          .catch((cause: unknown) => {
            const reason = cause instanceof Error ? cause.message : "falha ao falar com o gateway";
            set({ error: `não deu para exportar a conversa: ${reason}` });
          });
      },

      regenerateLastTurn: () => cortarUltimoTurno("regenerar", get, set),

      editLastTurn: () => cortarUltimoTurno("editar", get, set),

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
