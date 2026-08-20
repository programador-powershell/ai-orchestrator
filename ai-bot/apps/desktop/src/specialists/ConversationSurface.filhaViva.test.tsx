/**
 * A JANELA DA FILHA VIVA — o contrato do cliente para o sub-turno delegado
 * emitido NA SESSÃO DA FILHA (docs/execucao-na-janela.md, item 1).
 *
 * Com o gateway emitindo o trabalho do delegado na conversa filha, quem clica
 * na linha dela DURANTE a execução precisa ver o turno de verdade: a pergunta,
 * o texto chegando ao vivo (deltas), as ferramentas (tool.call/tool.result), o
 * cartão de aprovação — e nunca a cerca `aibot:tool` como texto cru, porque os
 * deltas streamam o texto do modelo sem o strip que a mensagem durável ganha
 * no gateway.
 *
 * Três garantias fixadas:
 *
 *   1. A conversa da filha mostra tool.call/result e a resposta AO VIVO — o
 *      redutor é agnóstico de sessão de propósito (o transporte assina uma por
 *      vez), e este teste FIXA que o fluxo do sub-turno reduz e desenha igual
 *      ao de um turno normal.
 *   2. NENHUMA cerca de protocolo aparece crua — nem durante o streaming, nem
 *      no turno que fecha SEM mensagem final (o caso `visible == ""`, em que
 *      nada substitui o acumulado dos deltas).
 *   3. A aprovação espelhada com o MESMO callID não duplica: o redutor
 *      deduplica por callId, o cartão mostra UM pedido (sem "+1 na fila") e o
 *      eco da decisão (decidida em qualquer janela) fecha o cartão aqui.
 *
 * Sem @testing-library: react-dom/client cru + act, envelopes reduzidos pelo
 * applyEnvelope real — o mesmo desenho do ConversationSurface.espelho.test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  ApprovalDecision,
  ApprovalRequest,
  Delta,
  Done,
  Envelope,
  Message,
  ToolCall,
  ToolResult
} from "@aibot/contracts";
import { applyEnvelope, initialAppData, useApp } from "../lib/store";
import { ApprovalCard } from "../shell/ApprovalCard";
import { ConversationSurface } from "./ConversationSurface";

/* O avatar carrega o módulo do Lab por URL; o dublê devolve um controlador
   inerte, como nos testes vizinhos. */
vi.mock("../avatar/grok_professional_avatar_v3", async (original) => {
  const real = await original<typeof import("../avatar/grok_professional_avatar_v3")>();
  return {
    ...real,
    mountGrokSpecialistAvatar: () =>
      Promise.resolve({
        setSpecialist: () => {},
        setState: () => {},
        destroy: () => {}
      })
  };
});

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

/* jsdom não implementa element.scrollTo, e a conversa rola ao montar. */
if (typeof Element.prototype.scrollTo !== "function") {
  Element.prototype.scrollTo = (() => {}) as typeof Element.prototype.scrollTo;
}

let container: HTMLDivElement;
let root: Root;
let seq = 0;

const FILHA = "s-filha";
const PEDIDO = "construa um site completo de padaria";
const CERCA_CRUA = '```aibot:tool\n{"tool":"fs.write","args":{"path":"index.html"}}\n```';

function envelope<P>(
  kind: Envelope["kind"],
  payload: P,
  from: { kind?: "user" | "supervisor" | "specialist"; id?: string; specialist?: string } = {}
): Envelope<P> {
  seq += 1;
  return {
    v: 1,
    id: `e-${seq}`,
    ts: "2026-08-20T12:00:00Z",
    seq,
    session: FILHA,
    turn: "t-1",
    kind,
    from: { kind: from.kind ?? "specialist", id: from.id, specialist: from.specialist },
    payload
  };
}

const doCode = { id: "code", specialist: "code" } as const;

function chegam(envelopes: Envelope<unknown>[]): void {
  act(() => {
    for (const item of envelopes) {
      useApp.setState((estado) => applyEnvelope(estado, item));
    }
  });
}

function monta(): void {
  act(() => {
    root.render(
      <>
        <ConversationSurface />
        <ApprovalCard />
      </>
    );
  });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  seq = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
  // A pessoa ABRIU a conversa da filha: o transporte assina uma sessão por
  // vez, então tudo que chega daqui em diante é o log/vivo DELA.
  useApp.setState({ ...initialAppData(), status: "ready", session: FILHA, busy: true });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
});

describe("a janela da filha durante o sub-turno", () => {
  it("mostra a pergunta, o texto ao vivo e as ferramentas — sem cerca crua", () => {
    monta();

    // O começo do sub-turno na filha: o pedido como fala do usuário e os
    // deltas do delegado — inclusive a cerca de protocolo, que streama crua.
    chegam([
      envelope<Message>("message", { role: "user", text: PEDIDO }, { kind: "user" }),
      envelope<Delta>("delta", { text: "Vou gravar a estrutura agora.\n\n" }, doCode),
      envelope<Delta>("delta", { text: `${CERCA_CRUA}\n` }, doCode),
      envelope<ToolCall>(
        "tool.call",
        { callId: "c-1", tool: "fs.write", args: { path: "index.html" } },
        doCode
      )
    ]);

    // A pergunta e o progresso estão NA TELA da filha — a janela viva.
    expect(container.textContent).toContain(PEDIDO);
    expect(container.textContent).toContain("Vou gravar a estrutura agora.");

    // A faixa de ferramentas ancora na bolha do turno, com o call em curso.
    const chip = container.querySelector<HTMLButtonElement>(".line-tools .chip");
    expect(chip?.textContent).toContain("ferramentas (1)");
    act(() => {
      chip?.click();
    });
    expect(container.textContent).toContain("fs.write");
    expect(container.textContent).toContain("em curso");

    // A cerca é máquina: o redutor guarda o texto cru (o replay é fiel), mas o
    // renderer NUNCA a desenha — nem aqui nem na raiz, que usa o mesmo camino.
    expect(container.textContent).not.toContain("aibot:tool");
    expect(container.textContent).not.toContain('"path"');

    // O resultado chega e o mesmo chip conta o desfecho.
    chegam([
      envelope<ToolResult>(
        "tool.result",
        { callId: "c-1", tool: "fs.write", ok: true, output: "gravado" },
        doCode
      )
    ]);
    expect(container.textContent).toContain("ok");

    // A resposta final na voz do bot SUBSTITUI o acumulado (delta é prévia); o
    // done fecha o turno sem apagar nada do que a pessoa viu.
    chegam([
      envelope<Message>(
        "message",
        { role: "assistant", text: "Estrutura gravada em index.html.", specialist: "code" },
        doCode
      ),
      envelope<Done>("done", { turn: "t-1" }, { kind: "supervisor" })
    ]);
    expect(container.textContent).toContain("Estrutura gravada em index.html.");
    expect(container.textContent).not.toContain("aibot:tool");
    expect(useApp.getState().busy).toBe(false);
  });

  it("turno que fecha SEM mensagem final não deixa a cerca crua para trás", () => {
    monta();

    // O caso `visible == ""`: o modelo só emitiu a chamada de ferramenta.
    // Nenhuma mensagem vem substituir o acumulado — o que ficar na bolha é o
    // que a pessoa lê para sempre nesta janela.
    chegam([
      envelope<Message>("message", { role: "user", text: PEDIDO }, { kind: "user" }),
      envelope<Delta>("delta", { text: `${CERCA_CRUA}\n` }, doCode),
      envelope<ToolCall>(
        "tool.call",
        { callId: "c-2", tool: "fs.write", args: { path: "index.html" } },
        doCode
      ),
      envelope<ToolResult>(
        "tool.result",
        { callId: "c-2", tool: "fs.write", ok: true, output: "gravado" },
        doCode
      ),
      envelope<Done>("done", { turn: "t-1" }, { kind: "supervisor" })
    ]);

    expect(container.textContent).not.toContain("aibot:tool");
    expect(container.textContent).not.toContain("fs.write{");
    // O registro visível da chamada continua existindo — no lugar certo.
    expect(container.querySelector(".line-tools .chip")?.textContent).toContain("ferramentas (1)");
  });
});

describe("a aprovação espelhada (mesmo callID nas duas sessões)", () => {
  const pedido: ApprovalRequest = {
    callId: "call-entrega",
    tool: "workspace.promote",
    summary: "entregar 1 criado(s), 0 alterado(s), 0 apagado(s)",
    detail: "+ index.html",
    risk: "write"
  };

  it("não duplica o cartão de entrega para quem olha as duas janelas", () => {
    monta();

    // O gateway grava o pedido no log da FILHA e o espelha na RAIZ com o MESMO
    // callID (o Decide é por callID, não por sessão). Reconexão/replay pode
    // entregar as duas cópias à mesma janela — e a fila não pode virar dois
    // cartões para uma decisão só.
    chegam([
      envelope<ApprovalRequest>("approval.request", pedido, { kind: "supervisor" }),
      { ...envelope<ApprovalRequest>("approval.request", pedido, { kind: "supervisor" }), session: "s-raiz" }
    ]);

    expect(useApp.getState().pendingApprovals).toHaveLength(1);
    expect(container.querySelectorAll(".approval-card")).toHaveLength(1);
    // Sem "+1 na fila": a cópia espelhada é o MESMO pedido, não um segundo.
    expect(container.querySelector(".approval-queue")).toBeNull();
    // E é o cartão de ENTREGA, com a lista de mudanças do detail.
    expect(container.textContent).toContain("entregar ao projeto");
    expect(container.textContent).toContain("index.html");
  });

  it("o eco da decisão — dada em qualquer janela — fecha o cartão daqui", () => {
    monta();
    chegam([envelope<ApprovalRequest>("approval.request", pedido, { kind: "supervisor" })]);
    expect(container.querySelectorAll(".approval-card")).toHaveLength(1);

    // A pessoa decidiu no cartão da RAIZ; o eco chega pelo log da filha.
    chegam([
      envelope<ApprovalDecision>(
        "approval.decision",
        { callId: "call-entrega", allow: true },
        { kind: "user" }
      )
    ]);
    expect(useApp.getState().pendingApprovals).toHaveLength(0);
    expect(container.querySelector(".approval-card")).toBeNull();
  });
});
