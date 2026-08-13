import { useEffect, useMemo, useState } from "react";

/**
 * Fila de aprovações de ferramenta.
 *
 * O agente delega em PARALELO (runDelegations roda os irmãos num Promise.all),
 * então dois subordinados podem pedir aprovação ao mesmo tempo. Guardar o
 * pedido num único useState fazia o segundo sobrescrever o primeiro: o
 * `resolve` do primeiro sumia com o registro, o `await hooks.approve` daquele
 * agente nunca voltava, o Promise.all nunca resolvia e a execução inteira
 * ficava presa em "running" — nem o botão Parar destravava, porque ele só
 * resolvia a aprovação VISÍVEL.
 *
 * Aqui os pedidos entram numa fila: a pessoa responde um de cada vez, na
 * ordem, e ninguém perde o resolve.
 *
 * A fila é um objeto comum, fora do React, por dois motivos: `resolve` é
 * efeito colateral (dentro de um updater do useState o React pode chamá-lo
 * duas vezes em StrictMode) e porque assim ela pode ser testada sem montar
 * componente.
 */
export type Queued<T> = T & { resolve: (ok: boolean) => void };

export interface ApprovalQueue<T> {
  /** Enfileira um pedido. Resolve quando alguém responder — ou false se a fila fechou. */
  request(item: T): Promise<boolean>;
  /** Responde o pedido da FRENTE. Sem pedido nenhum, não faz nada. */
  answer(ok: boolean): void;
  /** Parar: recusa todos, inclusive os que ainda não apareceram na tela. */
  denyAll(): void;
  /** Depois disto todo pedido é recusado na hora (a tela não existe mais). */
  close(): void;
  peek(): Queued<T> | null;
  size(): number;
}

export function createApprovalQueue<T>(onChange: () => void = () => undefined): ApprovalQueue<T> {
  let fila: Queued<T>[] = [];
  let fechada = false;

  return {
    request: (item) =>
      new Promise<boolean>((resolve) => {
        // Depois do unmount não há mais quem clique. Recusar na hora é o
        // único desfecho honesto: deixar pendurado trava o agente para sempre.
        if (fechada) {
          resolve(false);
          return;
        }
        fila = [...fila, { ...item, resolve }];
        onChange();
      }),
    answer: (ok) => {
      const [primeiro, ...resto] = fila;
      if (!primeiro) return;
      fila = resto;
      onChange();
      primeiro.resolve(ok);
    },
    denyAll: () => {
      const todos = fila;
      fila = [];
      onChange();
      todos.forEach((item) => item.resolve(false));
    },
    close: () => {
      fechada = true;
      const todos = fila;
      fila = [];
      todos.forEach((item) => item.resolve(false));
    },
    peek: () => fila[0] ?? null,
    size: () => fila.length
  };
}

/** Cola do React em cima da fila: só traduz mudança de fila em re-render. */
export function useApprovalQueue<T>() {
  const [, setVersao] = useState(0);
  const fila = useMemo(() => createApprovalQueue<T>(() => setVersao((n) => n + 1)), []);

  useEffect(() => () => fila.close(), [fila]);

  return {
    current: fila.peek(),
    pending: fila.size(),
    request: fila.request,
    answer: fila.answer,
    denyAll: fila.denyAll
  };
}
