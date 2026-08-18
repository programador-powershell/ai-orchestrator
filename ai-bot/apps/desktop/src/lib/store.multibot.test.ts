/**
 * A tela sob multi-bot: de quem é cada bolha, e quantos pedidos cabem na fila.
 *
 * Os dois defeitos que estes testes guardam eram INVISÍVEIS como erro — a tela
 * desenhava algo plausível e errado. Um bloco único com o avatar do primeiro
 * trabalhador contendo o texto de dois; e a conclusão do turno assinada pelo bot
 * que só tinha sido consultado de passagem.
 */

import { describe, expect, it } from "vitest";
import type { ApprovalRequest, Delta, Envelope, Message } from "@ai-bot/contracts";
import { applyEnvelope, initialAppData } from "./store";

let seq = 0;

function envelope<P>(
  kind: Envelope["kind"],
  payload: P,
  from: { id: string; specialist?: string },
  turn = "t-1"
): Envelope<P> {
  seq += 1;
  return {
    v: 1,
    id: `e-${seq}`,
    ts: "2026-08-17T12:00:00Z",
    seq,
    session: "s-1",
    turn,
    kind,
    from: { kind: "specialist", id: from.id, specialist: from.specialist ?? from.id },
    payload
  };
}

describe("linhas por falante", () => {
  it("dois trabalhadores da mesma onda não se misturam numa bolha só", () => {
    // Mesmo turno (`crew-…`), falantes diferentes: é o cenário exato da onda com
    // dois trabalhadores streamando ao mesmo tempo.
    const estado = [
      envelope<Delta>("delta", { text: "eu sou o code" }, { id: "w-1-t1", specialist: "code" }, "crew-1"),
      envelope<Delta>("delta", { text: "eu sou o data" }, { id: "w-1-t2", specialist: "data" }, "crew-1"),
      envelope<Delta>("delta", { text: " ainda" }, { id: "w-1-t1", specialist: "code" }, "crew-1")
    ].reduce(applyEnvelope, initialAppData());

    expect(estado.lines).toHaveLength(2);
    const code = estado.lines.find((line) => line.speakerId === "w-1-t1");
    const data = estado.lines.find((line) => line.speakerId === "w-1-t2");
    expect(code?.text).toBe("eu sou o code ainda");
    expect(code?.specialist).toBe("code");
    expect(data?.text).toBe("eu sou o data");
    expect(data?.specialist).toBe("data");
  });

  it("dois trabalhadores do MESMO especialista ainda ganham bolhas separadas", () => {
    // O especialista não basta como chave: uma onda pode ter duas tarefas de
    // `code`. Quem separa é o id do trabalhador.
    const estado = [
      envelope<Delta>("delta", { text: "tarefa A" }, { id: "w-1-t1", specialist: "code" }, "crew-1"),
      envelope<Delta>("delta", { text: "tarefa B" }, { id: "w-1-t2", specialist: "code" }, "crew-1")
    ].reduce(applyEnvelope, initialAppData());

    expect(estado.lines).toHaveLength(2);
    expect(estado.lines.map((line) => line.text)).toEqual(["tarefa A", "tarefa B"]);
  });

  it("a conclusão de quem delegou não é assinada pelo delegado", () => {
    // O `code` fala, delega para o `data` (que abre bolha própria com os deltas
    // dele) e volta a falar. A mensagem final é do `code`.
    const estado = [
      envelope<Delta>("delta", { text: "vou consultar o banco" }, { id: "code" }),
      envelope<Delta>("delta", { text: "esquema: cobranca(id)" }, { id: "data" }),
      envelope<Message>(
        "message",
        { role: "assistant", text: "Pronto: a cobrança vence em 30 dias.", specialist: "code" },
        { id: "code" }
      )
    ].reduce(applyEnvelope, initialAppData());

    const conclusao = estado.lines[estado.lines.length - 1];
    expect(conclusao?.text).toContain("30 dias");
    expect(conclusao?.specialist).toBe("code");
    // E a fala do delegado continua sendo dele, na bolha dele.
    const doDelegado = estado.lines.find((line) => line.speakerId === "data");
    expect(doDelegado?.specialist).toBe("data");
  });
});

describe("fila de aprovações", () => {
  function pedido(callId: string, tool: string): ApprovalRequest {
    return { callId, tool, risk: "write", summary: `${tool} em algum lugar` };
  }

  it("uma onda com quatro pedidos não perde três deles", () => {
    // O slot único fazia o segundo pedido sobrescrever o primeiro: a pessoa
    // decidia um e os outros morriam no relógio, segurando a onda inteira.
    const estado = ["c1", "c2", "c3", "c4"]
      .map((id) => envelope<ApprovalRequest>("approval.request", pedido(id, "fs.write"), { id: "agent" }))
      .reduce(applyEnvelope, initialAppData());

    expect(estado.pendingApprovals.map((item) => item.callId)).toEqual(["c1", "c2", "c3", "c4"]);
  });

  it("decidir um tira só aquele da fila, e a ordem de chegada é mantida", () => {
    const cheia = ["c1", "c2", "c3"]
      .map((id) => envelope<ApprovalRequest>("approval.request", pedido(id, "fs.write"), { id: "agent" }))
      .reduce(applyEnvelope, initialAppData());

    const depois = applyEnvelope(
      cheia,
      envelope("approval.decision", { callId: "c2", allow: true, scope: "once" }, { id: "user" })
    );
    expect(depois.pendingApprovals.map((item) => item.callId)).toEqual(["c1", "c3"]);
  });

  it("o resultado da ferramenta também fecha o cartão dela", () => {
    const cheia = ["c1", "c2"]
      .map((id) => envelope<ApprovalRequest>("approval.request", pedido(id, "proc.run"), { id: "agent" }))
      .reduce(applyEnvelope, initialAppData());

    const depois = applyEnvelope(
      cheia,
      envelope("tool.result", { callId: "c1", tool: "proc.run", ok: true, output: "pronto" }, { id: "code" })
    );
    expect(depois.pendingApprovals.map((item) => item.callId)).toEqual(["c2"]);
  });

  it("o mesmo pedido reentregue não duplica o cartão", () => {
    // Replay e reconexão reentregam envelopes; um cartão duplicado pediria duas
    // vezes a mesma autorização.
    const uma = applyEnvelope(
      initialAppData(),
      envelope<ApprovalRequest>("approval.request", pedido("c1", "fs.write"), { id: "agent" })
    );
    const duas = applyEnvelope(
      uma,
      envelope<ApprovalRequest>("approval.request", pedido("c1", "fs.write"), { id: "agent" })
    );
    expect(duas.pendingApprovals).toHaveLength(1);
  });
});
