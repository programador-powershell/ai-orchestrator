/**
 * A tela de documentos contra o defeito que a motivou: `collectDocument`
 * aceitava QUALQUER office.* — e `office.edit` devolve RELATÓRIO ("1
 * ocorrência(s) trocadas…"), então a primeira troca substituía o contrato na
 * tela pelo recibo da edição. Aqui se fixa o contrato inteiro: só `office.open`
 * alimenta o corpo, o histórico sai das edições REAIS (não do texto do pedido),
 * o cabeçalho diz formato e somente-leitura, e a troca aplicada dispara a
 * releitura — uma vez, e nunca para histórico recarregado.
 *
 * Sem @testing-library: montagem `react-dom/client` crua com o `act` do React
 * 19, como nos outros testes de tela deste projeto.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ConversationLine } from "@aibot/contracts";
import { initialAppData, useApp } from "../lib/store";
import { DocumentSurface, collectChanges, collectDocument, pendingReread } from "./DocumentSurface";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

/* O jsdom não implementa `element.scrollTo`, e a conversa compacta (coluna da
   direita da superfície) rola até o fim ao montar. O stub é vazio de propósito:
   o comportamento de rolagem não é o réu deste arquivo — aqui basta a montagem
   não explodir. */
if (typeof Element.prototype.scrollTo !== "function") {
  Element.prototype.scrollTo = (() => {}) as typeof Element.prototype.scrollTo;
}

let container: HTMLDivElement;
let topbarHost: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  topbarHost = document.createElement("div");
  topbarHost.id = "topbar-actions";
  document.body.appendChild(topbarHost);
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
  useApp.setState({ ...initialAppData() });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  topbarHost.remove();
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
});

/* -------------------------------- fixtures -------------------------------- */

const TEXTO = "O CONTRATANTE assina o presente instrumento na data acordada.";
const RELATORIO = '1 ocorrência(s) de "contratante" trocadas em docs/contrato.docx (partes: word/document.xml)';

let seq = 0;

/** Uma linha do assistente com um par chamada/resultado, como o gateway emite. */
function linhaDeFerramenta(
  tool: string,
  args: Record<string, unknown>,
  output: string,
  ok = true
): ConversationLine {
  seq += 1;
  const callId = `c${seq}`;
  return {
    id: `l${seq}`,
    seq,
    ts: "2026-08-19T00:00:00Z",
    role: "assistant",
    text: "",
    toolCalls: [{ callId, tool, args }],
    toolResults: [{ callId, tool, ok, output: ok ? output : undefined, error: ok ? undefined : output }]
  };
}

function abre(path = "docs/contrato.docx", texto = TEXTO): ConversationLine {
  return linhaDeFerramenta("office.open", { path }, texto);
}

function edita(find: string, replace: string, path = "docs/contrato.docx", ok = true): ConversationLine {
  return linhaDeFerramenta("office.edit", { path, find, replace }, RELATORIO, ok);
}

function monta(lines: ConversationLine[]) {
  useApp.setState({ lines });
  act(() => {
    root.render(<DocumentSurface />);
  });
}

/* --------------------------- o corpo do documento -------------------------- */

describe("o corpo do documento", () => {
  it("só office.open alimenta o corpo — o relatório do office.edit não o substitui", () => {
    monta([abre(), edita("contratante", "cliente")]);

    const corpo = container.querySelector(".doc-extract");
    expect(corpo?.textContent).toContain("CONTRATANTE");
    // O recibo da edição não pode virar "o documento".
    expect(corpo?.textContent).not.toContain("ocorrência(s)");
  });

  it("office.export também é relatório, não conteúdo", () => {
    const exporta = linhaDeFerramenta(
      "office.export",
      { path: "docs/contrato.docx", format: "txt" },
      "texto exportado para docs/contrato.txt (62 bytes)"
    );
    monta([abre(), exporta]);

    expect(container.querySelector(".doc-extract")?.textContent).toContain("CONTRATANTE");
    expect(container.querySelector(".doc-extract")?.textContent).not.toContain("exportado");
  });

  it("a pura confirma: edit e export não viram documento", () => {
    const doc = collectDocument([edita("a", "b")]);
    expect(doc).toBeNull();
  });
});

/* ------------------------ formato e somente-leitura ----------------------- */

describe("o chip do cabeçalho", () => {
  it("diz o formato do documento aberto", () => {
    monta([abre()]);
    expect(container.querySelector(".doc-format")?.textContent).toBe("DOCX");
    expect(container.querySelector(".doc-readonly")).toBeNull();
  });

  it("marca somente leitura no que office.edit não alcança e trava o formulário", () => {
    monta([abre("planilha.xlsx", "Planilha 1: valores")]);

    expect(container.querySelector(".doc-format")?.textContent).toBe("XLSX");
    expect(container.querySelector(".doc-readonly")).not.toBeNull();
    const campo = container.querySelector<HTMLInputElement>(".doc-input");
    expect(campo?.disabled).toBe(true);
    expect(container.querySelector(".doc-replace .card-body")?.textContent).toContain("somente leitura");
  });
});

/* ------------------------- o histórico das trocas ------------------------- */

describe("as trocas aplicadas", () => {
  it("saem das chamadas office.edit reais — inclusive as que não vieram do formulário", () => {
    // A segunda edição simula o modelo trocando por conta própria (a pessoa
    // pediu na conversa): não existe prompt no formato do formulário.
    monta([abre(), edita("contratante", "cliente"), edita("foro", "comarca")]);

    const itens = [...container.querySelectorAll(".doc-change")];
    expect(itens.map((item) => item.querySelector(".doc-change-terms")?.textContent)).toEqual([
      "contratante → cliente",
      "foro → comarca"
    ]);
  });

  it("edição que falhou não entra — 'nenhuma ocorrência' não trocou nada", () => {
    monta([abre(), edita("inexistente", "x", "docs/contrato.docx", false)]);
    expect(container.querySelectorAll(".doc-change").length).toBe(0);
  });

  it("a edição inversa marca a troca original como desfeita", () => {
    monta([abre(), edita("contratante", "cliente"), edita("cliente", "contratante")]);

    const itens = [...container.querySelectorAll(".doc-change")];
    expect(itens.length).toBe(1);
    expect(itens[0]?.getAttribute("data-reverted")).toBe("true");
    expect(itens[0]?.querySelector(".chip")?.textContent).toBe("desfeita");
  });

  it("a inversa em OUTRO arquivo não desfaz nada — a pura fixa o pareamento por caminho", () => {
    const changes = collectChanges([
      edita("contratante", "cliente", "docs/contrato.docx"),
      edita("cliente", "contratante", "docs/outro.docx")
    ]);
    expect(changes.length).toBe(2);
    expect(changes.every((change) => !change.reverted)).toBe(true);
  });
});

/* --------------------------- releitura automática -------------------------- */

describe("a releitura automática", () => {
  it("uma troca aplicada num turno vivo dispara a releitura — uma vez só", () => {
    const send = vi.fn((_text?: string) => {});
    useApp.setState({ send });
    monta([abre()]);

    // O turno vivo: a pessoa pediu a troca, o especialista editou, o turno fechou.
    act(() => {
      useApp.setState({ busy: true });
    });
    act(() => {
      useApp.setState({ lines: [abre(), edita("contratante", "cliente")], busy: false });
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toContain("Releia o documento contrato.docx");

    // Outro turno sem edição nova não repete o pedido.
    act(() => {
      useApp.setState({ busy: true });
    });
    act(() => {
      useApp.setState({ busy: false });
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("histórico recarregado não dispara nada — reencenar o pedido de ontem seria defeito", () => {
    const send = vi.fn((_text?: string) => {});
    useApp.setState({ send });
    // A edição já estava nas linhas quando a tela montou (reload da conversa).
    monta([abre(), edita("contratante", "cliente")]);

    act(() => {
      useApp.setState({ busy: true });
    });
    act(() => {
      useApp.setState({ busy: false });
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("se o modelo já releu no mesmo turno, a tela não pede de novo", () => {
    const send = vi.fn((_text?: string) => {});
    useApp.setState({ send });
    monta([abre()]);

    act(() => {
      useApp.setState({ busy: true });
    });
    act(() => {
      useApp.setState({
        lines: [abre(), edita("contratante", "cliente"), abre("docs/contrato.docx", "O CLIENTE assina.")],
        busy: false
      });
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("a pura: a releitura pendente é a última edição sem office.open do MESMO arquivo depois dela", () => {
    expect(pendingReread([abre(), edita("a", "b")])?.name).toBe("contrato.docx");
    expect(pendingReread([abre(), edita("a", "b"), abre()])).toBeNull();
    // Reler OUTRO arquivo não fecha a pendência deste.
    expect(pendingReread([abre(), edita("a", "b"), abre("docs/outro.docx")])?.name).toBe("contrato.docx");
  });
});
