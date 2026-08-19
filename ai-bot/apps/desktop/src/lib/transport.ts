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
  /**
   * Um POST autenticado no MESMO gateway.
   *
   * Mora aqui, e não no store, por causa do token: ele já vive nesta closure, e
   * uma segunda cópia (em estado, em variável de módulo, em prop) seria um
   * segundo lugar de onde o segredo pode vazar para devtools, log ou `persist`.
   * Rejeita com o MOTIVO que o gateway escreveu no corpo, e não só com o
   * status: quem chama repassa essa frase para a tela, e "409" sozinho não diz
   * a ninguém o que fazer.
   *
   * Resolve com o corpo JSON da resposta (ou `undefined` quando não há corpo):
   * as rotas de catálogo respondem coisas que a tela precisa ler — "a chave
   * foi gravada", o resultado do teste de conexão — e jogá-las fora obrigaria
   * um segundo fetch com uma segunda cópia do token.
   */
  post(path: string, body: unknown): Promise<unknown>;
  /** Um PATCH autenticado — usado para chave e estado de provedor existente. */
  patch(path: string, body: unknown): Promise<unknown>;
  /** Um GET autenticado — mesma regra de token e de erro do `post`. */
  get(path: string): Promise<unknown>;
  /** Um DELETE autenticado — idem. `del` porque `delete` é palavra reservada. */
  del(path: string): Promise<unknown>;
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
 * O endereço REST a partir do endereço do socket.
 *
 * `ws://127.0.0.1:8799/v1/stream` → `http://127.0.0.1:8799`. Derivar em vez de
 * configurar os dois separadamente é o que impede o app de falar WebSocket com
 * um gateway e REST com outro depois de alguém mudar a porta em um lugar só.
 */
export function httpBase(wsUrl: string): string {
  try {
    const parsed = new URL(wsUrl);
    parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
    parsed.pathname = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    // Endereço inválido é erro de configuração, e quem chama trata: devolver
    // uma base inventada faria o POST sair para um host qualquer.
    return "";
  }
}

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

/**
 * A frase acionável dentro do corpo de erro do gateway.
 *
 * O contrato é `{"error":{"code":…,"message":…}}` (ver `fail` em
 * `internal/transport/http.go`). É ali que mora o texto que a pessoa precisa
 * ler — "o Docker Sandboxes não está instalado — instale o Docker Desktop e o
 * sbx…" —, e ele não pode morrer no `response.status`: "409" não diz a ninguém
 * o que fazer a seguir.
 *
 * Devolve "" para corpo vazio, corpo que não é JSON ou JSON de outro formato:
 * inventar uma frase a partir de um corpo desconhecido seria pior que o status.
 */
export function gatewayReason(body: string): string {
  if (body === "") return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return "";
  }
  if (typeof parsed !== "object" || parsed === null) return "";
  const failure = (parsed as { error?: unknown }).error;
  if (typeof failure !== "object" || failure === null) return "";
  const message = (failure as { message?: unknown }).message;
  return typeof message === "string" ? message.trim() : "";
}

/** O que quem chamou o POST vai ler — e mostrar. O status vai junto para o log. */
export function failureMessage(path: string, status: number, body: string): string {
  const reason = gatewayReason(body);
  if (reason === "") return `o gateway recusou ${path} com ${status}`;
  return `${reason} (${status})`;
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

  /**
   * Entrega o envelope à tela e diz se ele foi mesmo APLICADO.
   *
   * `onEnvelope` é a redução do store, e uma exceção lá dentro (payload que a
   * redução não esperava, seletor que quebrou) subiria por `receive` e por
   * `onmessage`, onde ninguém a trata. O envelope então não é aplicado — e é
   * justamente por isso que o marco do replay não pode ter andado antes: com o
   * marco à frente, `resumeFrom` na reconexão pede a PARTIR de um ponto depois
   * do que se perdeu, e a linha some da conversa para sempre.
   *
   * Falhar aqui é anormal e vai para o console: perder o envelope de uma vez
   * seria trocar um defeito visível por um silencioso.
   */
  function deliver(envelope: Envelope): boolean {
    try {
      onEnvelope(envelope);
      return true;
    } catch (cause) {
      console.error(
        `[transport] envelope ${envelope.kind}#${envelope.seq} não pôde ser aplicado; ` +
          "o marco do replay fica onde estava para ele voltar na reconexão",
        cause
      );
      return false;
    }
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
      deliver(parsed);
      return;
    }

    // A ORDEM é a garantia do replay: aplica PRIMEIRO, avança o marco DEPOIS.
    // Invertido, um envelope que a redução recusa fica sem ser aplicado com o
    // marco já adiantado, e o `resumeFrom` da próxima reconexão nunca mais pede
    // aquele pedaço de volta.
    if (!deliver(parsed)) return;
    if (parsed.seq > lastSeq) lastSeq = parsed.seq;
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
    },

    post(path: string, body: unknown): Promise<unknown> {
      return request("POST", path, body);
    },

    patch(path: string, body: unknown): Promise<unknown> {
      return request("PATCH", path, body);
    },

    get(path: string): Promise<unknown> {
      return request("GET", path);
    },

    del(path: string): Promise<unknown> {
      return request("DELETE", path);
    }
  };

  /**
   * O fetch autenticado que os três verbos compartilham. Um só, para a regra
   * de erro (a frase acionável do gateway) e a regra de token valerem igual em
   * todos — três cópias divergiriam na primeira manutenção.
   */
  async function request(method: string, path: string, body?: unknown): Promise<unknown> {
    const base = httpBase(url);
    if (base === "") throw new Error("endereço do gateway inválido");

    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    const response = await fetch(`${base}${path}`, init);
    if (!response.ok) {
      // O corpo é lido ANTES de lançar: o gateway responde 409 com a frase
      // que diz o que falta na máquina, e descartá-la deixava a pessoa com um
      // número na tela e nenhuma ação possível.
      let failure = "";
      try {
        failure = await response.text();
      } catch {
        // Conexão cortada no meio do corpo: fica o status, que ainda é melhor
        // que transformar a recusa em sucesso.
      }
      throw new Error(failureMessage(path, response.status, failure));
    }

    let text = "";
    try {
      text = await response.text();
    } catch {
      // Sucesso sem corpo legível (conexão fechada depois do status): o status
      // já disse que deu certo, e é isso que importa a quem chamou.
      return undefined;
    }
    if (text === "") return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // Corpo que não é JSON não vira exceção: o contrato de sucesso do
      // gateway é JSON, e um proxy no meio devolvendo texto não pode
      // transformar um 200 em erro na tela.
      return undefined;
    }
  }
}
