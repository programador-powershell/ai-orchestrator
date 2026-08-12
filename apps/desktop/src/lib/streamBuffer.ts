/**
 * Coalescing de deltas por frame — a técnica que separa "conversa fluida" de
 * "aba congelada". Sem isto, cada token vira um setState: o React não termina
 * de pintar antes do próximo chegar e a UI trava em respostas rápidas.
 *
 * Os deltas se acumulam num buffer e são despejados UMA vez por frame
 * (requestAnimationFrame). O texto continua chegando token a token do provedor;
 * só a REPINTURA é limitada à taxa de quadros.
 */
export interface StreamBuffer {
  /** Enfileira um delta; o flush acontece no próximo frame. */
  push: (delta: string) => void;
  /** Despeja imediatamente o que estiver pendente (fim do stream). */
  flush: () => void;
  /** Cancela o frame agendado e descarta o pendente (abortar). */
  dispose: () => void;
}

type Scheduler = (callback: () => void) => number;
type Canceller = (handle: number) => void;

export interface StreamBufferOptions {
  /** Injetáveis para teste; por padrão usam requestAnimationFrame. */
  schedule?: Scheduler;
  cancel?: Canceller;
}

const defaultSchedule: Scheduler = (callback) =>
  typeof requestAnimationFrame === "function"
    ? requestAnimationFrame(() => callback())
    : (setTimeout(callback, 16) as unknown as number);

const defaultCancel: Canceller = (handle) => {
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(handle);
  else clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
};

/**
 * @param emit recebe o texto acumulado desde o último flush (nunca vazio).
 */
export function createStreamBuffer(emit: (chunk: string) => void, options: StreamBufferOptions = {}): StreamBuffer {
  const schedule = options.schedule ?? defaultSchedule;
  const cancel = options.cancel ?? defaultCancel;
  let pending = "";
  let handle: number | null = null;

  const flush = () => {
    if (handle !== null) {
      cancel(handle);
      handle = null;
    }
    if (!pending) return;
    const chunk = pending;
    pending = "";
    emit(chunk);
  };

  return {
    push: (delta) => {
      if (!delta) return;
      pending += delta;
      // Um único frame agendado por vez — deltas seguintes só engrossam o buffer.
      if (handle === null) {
        handle = schedule(() => {
          handle = null;
          if (!pending) return;
          const chunk = pending;
          pending = "";
          emit(chunk);
        });
      }
    },
    flush,
    dispose: () => {
      if (handle !== null) {
        cancel(handle);
        handle = null;
      }
      pending = "";
    }
  };
}
