import { describe, expect, it, vi } from "vitest";
import { createApprovalQueue } from "./approvalQueue";

type Pedido = { tool: string };

describe("fila de aprovação", () => {
  it("dois pedidos concorrentes esperam a sua vez — nenhum resolve se perde", async () => {
    // É o caso que travava a árvore inteira: dois subordinados irmãos pedindo
    // aprovação dentro do mesmo Promise.all.
    const fila = createApprovalQueue<Pedido>();
    const a = fila.request({ tool: "fs_write" });
    const b = fila.request({ tool: "terminal" });

    expect(fila.size()).toBe(2);
    expect(fila.peek()?.tool).toBe("fs_write");

    fila.answer(true);
    expect(await a).toBe(true);
    expect(fila.peek()?.tool).toBe("terminal");

    fila.answer(false);
    expect(await b).toBe(false);
    expect(fila.size()).toBe(0);
  });

  it("Parar recusa TODOS, não só o que está na tela", async () => {
    const fila = createApprovalQueue<Pedido>();
    const pedidos = [
      fila.request({ tool: "a" }),
      fila.request({ tool: "b" }),
      fila.request({ tool: "c" })
    ];
    fila.denyAll();
    expect(await Promise.all(pedidos)).toEqual([false, false, false]);
    expect(fila.size()).toBe(0);
  });

  it("fila fechada recusa na hora em vez de pendurar o agente", async () => {
    const fila = createApprovalQueue<Pedido>();
    const antes = fila.request({ tool: "a" });
    fila.close();
    expect(await antes).toBe(false);
    // Sem isto, um pedido feito depois do unmount esperaria um clique que
    // nunca viria.
    expect(await fila.request({ tool: "b" })).toBe(false);
  });

  it("avisa a tela a cada entrada e saída da fila", () => {
    const aviso = vi.fn();
    const fila = createApprovalQueue<Pedido>(aviso);
    void fila.request({ tool: "a" });
    void fila.request({ tool: "b" });
    fila.answer(true);
    expect(aviso).toHaveBeenCalledTimes(3);
  });

  it("responder com a fila vazia não quebra", () => {
    const fila = createApprovalQueue<Pedido>();
    expect(() => fila.answer(true)).not.toThrow();
    expect(fila.peek()).toBeNull();
  });
});
