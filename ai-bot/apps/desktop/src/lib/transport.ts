/**
 * O fio entre a tela e o gateway.
 *
 * Três decisões deste arquivo não são detalhe de implementação:
 *
 * 1. O TOKEN VIAJA NO PRIMEIRO FRAME, nunca na URL. `new WebSocket(url)` não
 *    aceita cabeçalho, então a tentação é `?token=…` — e aí o segredo entra no
 *    log de acesso, no histórico do WebView, no `Referer` e em qualquer captura
 *    de tela da barra de endereço. O frame de `hello` não vai para nenhum
 *    desses lugares. O token também não é lido daqui: quem o conhece é o Rust,
 *    que leu o arquivo do DataDir do gateway e passa em `options.token`.
 *
 * 2. RECONECTAR CONTINUA A RESPOSTA, não a recomeça. O envelope é numerado por
 *    sessão (`seq`), então guardamos o último `seq` visto e mandamos
 *    `resumeFrom` no `hello` da reconexão: o gateway repete só o que faltou.
 *    Sem isso, uma queda de dois segundos no meio de uma resposta longa faria a
 *    pessoa ver o texto ser reescrito do zero — ou, pior, sumir.
 *
 * 3. O RELÓGIO DE RECONEXÃO É ÚNICO e morre no `stop()`. Timer solto é o vazamento
 *    clássico daqui: o socket cai, agenda a volta, a janela fecha, e o timer
 *    acorda contra um transporte que já não existe.
 */

import { PROTOCOL_VERSION, type Envelope, type EnvelopeKind, type Hello, type Ready } from "@aibot/contracts";

export type Status = "connecting" | "ready" | "offline";

export interface Transport {
  start(): void;
  stop(): void;
  send<P>(kind: EnvelopeKind, payload: P): void;
  resumeFrom(seq: number): void;
}

export interface TransportOptions {
  /** ws://127.0.0.1:8799/v1/stream */
  url: string;
  /** Segredo do gateway. Vai no `hello`; nunca na URL, nunca em log. */
  token: string;
  onEnvelope: (envelope: Envelope) => void;
  onStatus: (status: Status) => void;
}

/** Quem está do outro lado. O gateway usa isto para separar app de CLI no log. */
export const CLIENT_NAME = "aibot-desktop";

/** Versão do app (acompanha o `tauri.conf.json`), reportada para diagnóstico. */
export const CLIENT_VERSION = "0.1.0";

/** Primeiro atraso da reconexão. */
const BACKOFF_BASE_MS = 500;

/** Teto do atraso: acima disso a espera passa a parecer app travado. */
const BACKOFF_MAX_MS = 15_000;

/**
 * Atraso da próxima tentativa: exponencial com jitter de metade a inteiro.
 *
 * O jitter existe porque o gateway costuma cair para TODAS as janelas ao mesmo
 * tempo (ele reinicia). Sem jitter, todas voltam no mesmo milissegundo e
 * derrubam de novo o processo que acabou de subir.
 */
function backoffDelay(attempt: number): number {
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
}

/** O `hello` carrega o token junto — ver decisão 1 no topo do arquivo. */
type HelloFrame = Hello & { token: string };

/**
 * Conferência estrutural do que chegou do fio.
 *
 * Não valida campo a campo de propósito: o dono do contrato é o Go, e repetir a
 * validação aqui criaria uma segunda verdade que diverge em silêncio. O que
 * importa é não deixar passar `null`, texto solto ou JSON de outro protocolo.
 */
function isEnvelope(value: unknown): value is Envelope {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Envelope>;
  return (
    typeof candidate.kind === "string" &&
    typeof candidate.seq === "number" &&
    typeof candidate.session === "string" &&
    typeof candidate.from === "object" &&
    candidate.from !== null
  );
}

export function createTransport(options: TransportOptions): Transport {
  const { url, token, onEnvelope, onStatus } = options;

  let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let stopped = true;
  let status: Status = "offline";

  /** Sessão vinda do `ready`. É ela que vai no envelope de saída. */
  let session = "";

  /** Último `seq` visto — o marco do replay. */
  let lastSeq = 0;

  function setStatus(next: Status): void {
    if (status === next) return;
    status = next;
    onStatus(next);
  }

  function clearTimer(): void {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  }

  /**
   * Solta os manipuladores antes de descartar o socket.
   *
   * Sem isto, o `onclose` de um socket já abandonado ainda dispara e agenda uma
   * segunda reconexão — duas conexões vivas para a mesma sessão, cada uma
   * entregando os mesmos envelopes.
   */
  function detach(target: WebSocket): void {
    target.onopen = null;
    target.onmessage = null;
    target.onerror = null;
    target.onclose = null;
  }

  function scheduleReconnect(): void {
    if (stopped || timer !== null) return;
    const delay = backoffDelay(attempt);
    attempt += 1;
    timer = setTimeout(() => {
      timer = null;
      open();
    }, delay);
  }

  function writeEnvelope(target: WebSocket, kind: EnvelopeKind, payload: unknown): void {
    const envelope: Envelope = {
      v: PROTOCOL_VERSION,
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      // Quem numera é o servidor: `seq` é a ordem do log da sessão, e um cliente
      // que numerasse sozinho colidiria com outra janela na mesma sessão.
      seq: 0,
      session,
      kind,
      from: { kind: "user" },
      payload
    };
    target.send(JSON.stringify(envelope));
  }

  function sendHello(target: WebSocket): void {
    const hello: HelloFrame = {
      client: CLIENT_NAME,
      version: CLIENT_VERSION,
      token,
      // Zero = do começo. Depois de uma queda vale o último `seq` visto, e é
      // exatamente isso que faz a resposta continuar de onde parou.
      resumeFrom: lastSeq
    };
    // Só pede a sessão de volta quando já houve uma: sem dica, o gateway abre
    // uma nova, que é o caminho da primeira execução.
    if (session !== "") hello.sessionHint = session;
    writeEnvelope(target, "hello", hello);
  }

  function receive(data: unknown): void {
    // O protocolo é texto. Binário aqui é engano de quem escreveu do outro lado.
    if (typeof data !== "string") return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (!isEnvelope(parsed)) return;

    if (parsed.kind === "ready") {
      const ready = parsed.payload as Ready | undefined;
      if (ready && typeof ready.session === "string" && ready.session !== "") {
        // Trocou de sessão (nova conversa, ou o usuário abriu outra): o `seq` é
        // por sessão, então o marco antigo não vale mais. Mantê-lo faria a
        // próxima reconexão pedir replay a partir de um ponto que a sessão nova
        // ainda nem alcançou — e o começo da conversa nunca chegaria.
        //
        // Zera em vez de adotar o `seq` do `ready`: o marco tem de ser o que
        // REALMENTE chegou até aqui. Adotar o do servidor faria uma queda no
        // meio do replay pular o pedaço que ainda não tinha sido entregue.
        if (ready.session !== session) {
          session = ready.session;
          lastSeq = 0;
        }
      }
      // Só agora é "pronto": socket aberto com token recusado não é conexão útil.
      attempt = 0;
      setStatus("ready");
      // O `ready` é uma FOTOGRAFIA do estado, não uma entrada do log: o `seq`
      // dele é o do fim da sessão, e adotá-lo como marco pularia justamente o
      // replay que vem logo atrás.
      onEnvelope(parsed);
      return;
    }

    if (parsed.seq > lastSeq) lastSeq = parsed.seq;
    onEnvelope(parsed);
  }

  function open(): void {
    if (stopped) return;
    clearTimer();
    setStatus("connecting");

    let next: WebSocket;
    try {
      next = new WebSocket(url);
    } catch {
      // URL inválida ou WebView sem suporte: não adianta insistir rápido.
      setStatus("offline");
      scheduleReconnect();
      return;
    }
    socket = next;

    next.onopen = () => {
      if (socket !== next) return;
      sendHello(next);
    };

    next.onmessage = (event: MessageEvent) => {
      if (socket !== next) return;
      receive(event.data);
    };

    // `onerror` não recebe motivo útil no navegador e SEMPRE vem seguido de
    // `onclose` — reagendar aqui daria duas reconexões para a mesma queda.
    next.onerror = () => {};

    next.onclose = () => {
      if (socket !== next) return;
      detach(next);
      socket = null;
      setStatus("offline");
      scheduleReconnect();
    };
  }

  return {
    start(): void {
      if (!stopped && socket !== null) return;
      stopped = false;
      attempt = 0;
      open();
    },

    stop(): void {
      stopped = true;
      clearTimer();
      if (socket !== null) {
        const target = socket;
        socket = null;
        detach(target);
        // 1000 = fim normal. Sem o close explícito o gateway segura a sessão
        // até o timeout de leitura, e a próxima abertura conviveria com o
        // fantasma da anterior.
        target.close(1000, "encerrado pelo cliente");
      }
      setStatus("offline");
    },

    send<P>(kind: EnvelopeKind, payload: P): void {
      if (socket === null || socket.readyState !== WebSocket.OPEN) return;
      // Sem fila de saída de propósito: reenviar um prompt guardado depois da
      // reconexão faria a pessoa receber resposta para algo que ela já desistiu
      // de perguntar. Offline, o botão de enviar é que deve estar desligado.
      writeEnvelope(socket, kind, payload);
    },

    resumeFrom(seq: number): void {
      lastSeq = Number.isFinite(seq) && seq > 0 ? Math.floor(seq) : 0;
    }
  };
}
