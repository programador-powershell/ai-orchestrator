/**
 * O armazenamento que o `persist` do zustand usa — com freio e sem estourar.
 *
 * ## Por que não o `localStorage` direto
 *
 * O `persist` assina o store e grava a CADA `setState`, sem comparar nada. Não
 * importa se o que mudou sequer é persistido: um token de resposta que chega
 * pelo WebSocket, uma tecla no composer, o rótulo do orbe — cada um deles é um
 * `JSON.stringify` mais uma escrita SÍNCRONA no disco, na mesma thread que
 * desenha. Um turno de 800 tokens são 800 gravações para um payload que não
 * mudou uma vírgula.
 *
 * O `partialize` do store atenua o TAMANHO (só tema, trilho e avatares vão para
 * o disco), mas o custo aqui é por `set`, não por byte. Por isso duas defesas:
 *
 * - COALESCE: o valor mais recente fica pendente e vai ao disco uma vez por
 *   janela, não uma vez por `set`.
 * - COMPARA: valor idêntico ao último gravado não vai. É o caso comum — quase
 *   todo `set` deste app mexe em algo que não é persistido.
 *
 * Escrita adiada obriga a fechar a porta: `pagehide` e `visibilitychange`
 * descarregam na hora. Sem isso, fechar a janela logo depois de trocar o tema
 * perderia a troca — trocar travamento por perda de dado não seria acordo.
 *
 * ## Cota
 *
 * O `localStorage` do WebView tem cerca de 5 MB e o `QuotaExceededError` sobe
 * de dentro do `setState`: sem tratamento, a exceção derruba a AÇÃO da pessoa
 * (o envio da mensagem), não apenas a gravação. Aqui ela é engolida com aviso
 * no console. A hierarquia é explícita: perder a preferência de tema é
 * aceitável, perder a mensagem não.
 */

/** O pedaço de `Storage` que este módulo usa. Estreito de propósito: testável. */
export interface RawStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Um evento de "estou indo embora" e a condição para acreditar nele.
 *
 * `visibilitychange` dispara também quando a aba VOLTA, e descarregar ali seria
 * gravar por nada — daí o `when`.
 */
export interface LifecycleHook {
  target: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  event: string;
  when?: () => boolean;
}

export interface CoalescedStorageOptions {
  /** Janela de coalescência, em ms. */
  windowMs?: number;
  /** Agenda a descarga. Injetável para o teste não depender do relógio. */
  schedule?: (action: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
  /** Onde escutar o fechamento. Vazio = ninguém descarrega sozinho. */
  lifecycle?: LifecycleHook[];
  /** Chamado quando nem o valor mínimo coube. Só para o teste e o log. */
  onQuotaExceeded?: (message: string) => void;
}

export interface CoalescedStorage extends RawStorage {
  /** Grava agora o que estiver pendente. Usado no fechamento e no teste. */
  flush(): void;
  /** Solta os ouvintes do ciclo de vida. */
  dispose(): void;
}

/**
 * Uma gravação por quadro longo.
 *
 * 250ms é curto o bastante para a preferência sobreviver a um fechamento
 * abrupto (que nem o `pagehide` pega) e longo o bastante para engolir a rajada
 * de `set` de um turno inteiro.
 */
const DEFAULT_WINDOW_MS = 250;

/**
 * Nomes do estouro de cota nos motores que este app pode encontrar.
 *
 * Só `instanceof DOMException` não serve: o WebView2 entrega um `Error` comum
 * com o `name` certo, e o jsdom do teste faz o mesmo.
 */
function isQuotaError(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null) return false;
  const failure = cause as { name?: unknown; code?: unknown };
  return (
    failure.name === "QuotaExceededError" ||
    failure.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    failure.code === 22
  );
}

/** Os eventos de fechamento do navegador; vazio fora dele (teste em node puro). */
export function defaultLifecycle(): LifecycleHook[] {
  const hooks: LifecycleHook[] = [];
  if (typeof window !== "undefined") {
    // `pagehide` e não `beforeunload`: este é o único que o WebView dispara de
    // forma confiável quando a janela some, inclusive no descarte para o cache.
    hooks.push({ target: window, event: "pagehide" });
  }
  if (typeof document !== "undefined") {
    hooks.push({
      target: document,
      event: "visibilitychange",
      when: () => document.visibilityState === "hidden"
    });
  }
  return hooks;
}

export function createCoalescedStorage(
  raw: RawStorage,
  options: CoalescedStorageOptions = {}
): CoalescedStorage {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const schedule = options.schedule ?? ((action, ms) => setTimeout(action, ms));
  const cancel =
    options.cancel ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  /** Valor esperando a janela fechar, por chave. */
  const pending = new Map<string, string>();
  /** Último valor que REALMENTE entrou no disco, por chave. */
  const written = new Map<string, string>();
  let handle: unknown = null;

  function write(key: string, value: string): void {
    try {
      raw.setItem(key, value);
      written.set(key, value);
    } catch (cause) {
      if (!isQuotaError(cause)) throw cause;
      /*
       * Não relança. A exceção nasceria aqui mas subiria de dentro do
       * `setState` que a disparou, matando a ação da pessoa por causa de uma
       * preferência. O estado em memória continua certo; o que se perde é a
       * durabilidade, e disso o log precisa saber.
       */
      const message = `[persist] "${key}" não coube no armazenamento local; a preferência vale só nesta janela`;
      console.warn(message, cause);
      options.onQuotaExceeded?.(message);
    }
  }

  function flush(): void {
    if (handle !== null) {
      cancel(handle);
      handle = null;
    }
    if (pending.size === 0) return;
    const batch = [...pending.entries()];
    pending.clear();
    for (const [key, value] of batch) write(key, value);
  }

  const listeners: Array<() => void> = [];
  for (const hook of options.lifecycle ?? []) {
    const listener = () => {
      if (hook.when && !hook.when()) return;
      flush();
    };
    hook.target.addEventListener(hook.event, listener);
    listeners.push(() => hook.target.removeEventListener(hook.event, listener));
  }

  return {
    getItem(key) {
      // O pendente é mais novo que o disco: devolver o do disco entregaria uma
      // versão velha para a hidratação.
      const waiting = pending.get(key);
      return waiting !== undefined ? waiting : raw.getItem(key);
    },

    setItem(key, value) {
      if (written.get(key) === value) {
        // Idêntico ao que já está gravado: a escrita não teria efeito nenhum.
        // É o caso da esmagadora maioria dos `set` — tema, trilho e avatares
        // não mudam durante um turno.
        pending.delete(key);
        return;
      }
      pending.set(key, value);
      if (handle === null) {
        handle = schedule(() => {
          handle = null;
          flush();
        }, windowMs);
      }
    },

    removeItem(key) {
      pending.delete(key);
      written.delete(key);
      raw.removeItem(key);
    },

    flush,

    dispose() {
      for (const off of listeners) off();
      listeners.length = 0;
      flush();
    }
  };
}

/** Instância única do processo: um `persist`, um freio, um jogo de ouvintes. */
let shared: CoalescedStorage | null = null;

/**
 * O armazenamento de preferências do app.
 *
 * LANÇA quando não há `localStorage` (janela sem storage, contexto sem DOM), e
 * isso é de propósito: é o `createJSONStorage` do zustand que trata — ele
 * captura, devolve `undefined`, e o `persist` segue só em memória com um aviso.
 * Devolver um objeto de mentira faria o store parecer persistido sem estar.
 */
export function preferenceStorage(): CoalescedStorage {
  if (shared) return shared;
  if (typeof localStorage === "undefined") {
    throw new Error("sem localStorage: as preferências valem só nesta janela");
  }
  shared = createCoalescedStorage(localStorage, { lifecycle: defaultLifecycle() });
  return shared;
}
