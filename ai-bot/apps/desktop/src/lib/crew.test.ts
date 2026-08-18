/**
 * O contrato de `outcomeOf`: escalar não é falhar, e a tela não adivinha qual foi.
 *
 * Este teste existe porque o defeito que ele fecha era INVISÍVEL. Um trabalhador
 * que perguntava algo aparecia vermelho no grafo e somava no contador de falhas
 * — ao mesmo tempo que a faixa de escalação pedia resposta logo acima. Nada
 * quebrava; só se lia errado.
 */

import { describe, expect, it } from "vitest";
import type { WorkerDone } from "@ai-bot/contracts";
import { outcomeOf } from "./crew";

/** `worker.done` mínimo. Os campos que não estão em teste ficam de fora. */
function workerDone(fields: Partial<WorkerDone>): WorkerDone {
  return { taskId: "t1", workerId: "w-1-t1", ok: false, ...fields };
}

describe("outcomeOf", () => {
  it("trabalhador que entregou é concluído", () => {
    expect(outcomeOf(workerDone({ ok: true, result: "pronto" }))).toBe("done");
  });

  it("trabalhador que escalou NÃO é falha", () => {
    const done = workerDone({ ok: false, escalated: true, error: "escalado: qual banco?" });
    expect(outcomeOf(done)).toBe("escalated");
  });

  it("trabalhador que falhou é falha", () => {
    const done = workerDone({ ok: false, error: "o trabalhador não concluiu em 6 rodadas" });
    expect(outcomeOf(done)).toBe("failed");
  });

  it("escalated ausente é falha, não escalação", () => {
    // O gateway antigo não mandava o campo. Ausência não pode virar "escalado":
    // isso apagaria falha de verdade do contador.
    expect(outcomeOf(workerDone({ ok: false }))).toBe("failed");
    expect(outcomeOf(workerDone({ ok: false, escalated: false }))).toBe("failed");
  });

  it("ok manda quando os dois vêm juntos", () => {
    // Combinação que o gateway não emite. Se emitir, há resultado para as
    // dependentes lerem — e mostrar o resultado é mais útil que a pergunta.
    expect(outcomeOf(workerDone({ ok: true, escalated: true, result: "pronto" }))).toBe("done");
  });

  it("a mesma tarefa reexecutada é julgada pelo done NOVO", () => {
    // Este é o caso que derrubou a alternativa de deduzir a escalação cruzando
    // `crew.escalations` com o `taskId`: aquela lista só cresce, então a
    // escalação do primeiro plano continuaria rotulando o segundo. Aqui cada
    // `worker.done` responde por si.
    const escalou = workerDone({ ok: false, escalated: true, error: "escalado: qual banco?" });
    const falhou = workerDone({ ok: false, error: "o trabalhador não concluiu em 6 rodadas" });

    expect(outcomeOf(escalou)).toBe("escalated");
    expect(outcomeOf(falhou)).toBe("failed");
  });
});
