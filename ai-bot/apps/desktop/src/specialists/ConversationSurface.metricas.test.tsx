/**
 * O rodapé da bolha, DESENHADO: métricas do turno, copiar com feedback,
 * raciocínio recolhido por padrão e os botões de regenerar/editar só no último
 * turno. O redutor que preenche esses campos já é provado em
 * store.metricas.test.ts — aqui se prova que a tela os mostra.
 *
 * Sem @testing-library, como nos vizinhos: react-dom/client cru + act.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ConversationLine } from "@aibot/contracts";
import { initialAppData, useApp } from "../lib/store";
import { ConversationSurface, formatDuration } from "./ConversationSurface";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: Root;

const escrito: string[] = [];

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom não implementa scrollTo de elemento, e o autoscroll da superfície o
  // chama a cada mudança de linha — sem o dublê, todo teste de montagem morre.
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
  escrito.length = 0;
  // jsdom não tem clipboard; o dublê registra o que o botão copiou.
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: (text: string) => (escrito.push(text), Promise.resolve()) }
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
});

function linha(extra: Partial<ConversationLine> & { id: string; seq: number }): ConversationLine {
  return { role: "assistant", text: "", ts: "2026-08-19T12:00:00Z", turn: "t-1", ...extra };
}

function seed(lines: ConversationLine[], extra: Record<string, unknown> = {}) {
  useApp.setState({
    ...initialAppData(),
    status: "ready",
    busy: false,
    lines,
    ...extra
  });
}

function monta() {
  act(() => {
    root.render(<ConversationSurface />);
  });
}

const CONVERSA: ConversationLine[] = [
  linha({ id: "u1", seq: 1, role: "user", text: "faça algo" }),
  linha({
    id: "a1",
    seq: 2,
    specialist: "code",
    text: "feito",
    streaming: false,
    reasoning: "primeiro leio o arquivo",
    durationMs: 12_500,
    outputTokens: 1280
  })
];

describe("as métricas no rodapé da resposta", () => {
  it("mostra duração e tokens pequenos, com o porquê no title", () => {
    seed(CONVERSA);
    monta();

    // O rodapé procurado é o da RESPOSTA — a pergunta do último turno também
    // tem um (o do botão de editar).
    const foot = container.querySelector('[data-role="assistant"] .line-foot');
    expect(foot?.textContent).toContain("12,5 s");
    expect(foot?.textContent).toContain("1.280 tokens");
  });

  it("não mostra métrica de resposta ainda em streaming — número parcial é chute", () => {
    seed([
      linha({ id: "u1", seq: 1, role: "user", text: "oi" }),
      linha({ id: "a1", seq: 2, text: "escrev", streaming: true, durationMs: 100 })
    ]);
    monta();
    expect(container.querySelector(".line-foot .line-foot-item")).toBeNull();
  });
});

describe("copiar por mensagem", () => {
  it("copia o texto da bolha e confirma com 'copiado'", async () => {
    seed(CONVERSA);
    monta();

    const botao = container.querySelector<HTMLButtonElement>('button[aria-label="copiar a mensagem"]');
    expect(botao).not.toBeNull();
    await act(async () => {
      botao?.click();
      await Promise.resolve();
    });

    expect(escrito).toEqual(["feito"]);
    expect(container.querySelector('button[aria-label="copiado"]')).not.toBeNull();
  });
});

describe("o raciocínio recolhível", () => {
  it("nasce FECHADO e abre no clique do chip", () => {
    seed(CONVERSA);
    monta();

    expect(container.querySelector(".line-reasoning-text")).toBeNull();
    const chip = container.querySelector<HTMLButtonElement>(".line-reasoning .chip");
    expect(chip?.textContent).toContain("raciocínio");

    act(() => {
      chip?.click();
    });
    expect(container.querySelector(".line-reasoning-text")?.textContent).toBe("primeiro leio o arquivo");
  });

  it("linha sem raciocínio não ganha chip nenhum", () => {
    seed([linha({ id: "a9", seq: 3, text: "sem bastidor", streaming: false })]);
    monta();
    expect(container.querySelector(".line-reasoning")).toBeNull();
  });
});

describe("regenerar e editar no último turno", () => {
  it("regenerar aparece só na última resposta, editar só na última pergunta", () => {
    const chamados: string[] = [];
    seed(CONVERSA);
    useApp.setState({
      regenerateLastTurn: () => chamados.push("regenerar"),
      editLastTurn: () => chamados.push("editar")
    });
    monta();

    const regenerar = container.querySelector<HTMLButtonElement>('button[aria-label="Regenerar a última resposta"]');
    const editar = container.querySelector<HTMLButtonElement>('button[aria-label="Editar a última pergunta"]');
    expect(regenerar).not.toBeNull();
    expect(editar).not.toBeNull();

    act(() => {
      regenerar?.click();
      editar?.click();
    });
    expect(chamados).toEqual(["regenerar", "editar"]);
  });

  it("com a conversa OCUPADA os botões somem — não há o que cortar no meio do turno", () => {
    seed(CONVERSA, { busy: true });
    monta();
    expect(container.querySelector('button[aria-label="Regenerar a última resposta"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Editar a última pergunta"]')).toBeNull();
  });

  it("resposta antiga não ganha o botão — o corte é sempre do último turno", () => {
    seed([
      linha({ id: "u1", seq: 1, role: "user", text: "primeira", turn: "t-1" }),
      linha({ id: "a1", seq: 2, text: "resposta velha", streaming: false, turn: "t-1" }),
      linha({ id: "u2", seq: 3, role: "user", text: "segunda", turn: "t-2" }),
      linha({ id: "a2", seq: 4, text: "resposta nova", streaming: false, turn: "t-2" })
    ]);
    monta();
    const botoes = container.querySelectorAll('button[aria-label="Regenerar a última resposta"]');
    expect(botoes).toHaveLength(1);
    // O único botão mora na bolha da resposta NOVA.
    expect(botoes[0]?.closest(".line-group")?.textContent).toContain("resposta nova");
  });
});

describe("formatDuration", () => {
  it("fala pt-BR: ms curtos, segundos com vírgula, minutos compostos", () => {
    expect(formatDuration(870)).toBe("870 ms");
    expect(formatDuration(12_500)).toBe("12,5 s");
    expect(formatDuration(125_000)).toBe("2min 05s");
    expect(formatDuration(-5)).toBe("");
  });
});
