/**
 * O chip da jaula na conversa.
 *
 * O gesto liberado dentro do sandbox precisa deixar rastro VISÍVEL sem
 * interromper: aqui se fixa que o chip "no sandbox: …" aparece pendurado na
 * bolha do turno em que aconteceu — discreto (classe .chip, como o resto da
 * tela) e com o porquê no title — e que o painel de ferramentas da linha
 * (tool.call/tool.result) continua lá, intocado, como registro integral.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ConversationLine, ToolCall } from "@aibot/contracts";
import { initialAppData, useApp } from "../lib/store";
import { ConversationSurface } from "./ConversationSurface";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

/* jsdom não implementa `element.scrollTo`, e a conversa rola ao montar. */
if (typeof Element.prototype.scrollTo !== "function") {
  Element.prototype.scrollTo = (() => {}) as typeof Element.prototype.scrollTo;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
  useApp.setState(initialAppData());
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
});

function monta() {
  act(() => {
    root.render(<ConversationSurface />);
  });
}

const CHAMADA: ToolCall = { callId: "c-1", tool: "proc.run", args: { command: "pnpm install" } };

const LINHA: ConversationLine = {
  id: "linha-1",
  seq: 2,
  turn: "t-1",
  role: "assistant",
  specialist: "code",
  text: "Instalando as dependências…",
  streaming: false,
  toolCalls: [CHAMADA],
  ts: "2026-08-20T12:00:00.000Z"
};

describe("o chip da jaula", () => {
  it("aparece na bolha do turno, com o porquê no title", () => {
    useApp.setState({
      lines: [LINHA],
      chipsDeSandbox: [
        {
          lineId: "linha-1",
          title: "no sandbox: pnpm install",
          detail: "instalação isolada na cópia do turno"
        }
      ]
    });
    monta();

    const chip = container.querySelector(".line-sandbox-chip");
    expect(chip?.textContent).toBe("no sandbox: pnpm install");
    expect(chip?.getAttribute("title")).toBe("instalação isolada na cópia do turno");
    // Dentro do MESMO grupo da linha — pendurado na bolha, não solto no fim.
    expect(chip?.closest(".line-group")?.querySelector(".line")).not.toBeNull();

    // E o painel de ferramentas continua lá, como sempre: o chip é o "onde
    // rodou" de relance, não o substituto do registro.
    expect(container.querySelector(".line-tools")).not.toBeNull();
  });

  it("gesto sem âncora aparece no fim em vez de sumir", () => {
    useApp.setState({
      lines: [LINHA],
      chipsDeSandbox: [{ lineId: "", title: "no sandbox: pnpm build" }]
    });
    monta();

    const chips = [...container.querySelectorAll(".line-sandbox-chip")].map(
      (chip) => chip.textContent
    );
    expect(chips).toEqual(["no sandbox: pnpm build"]);
  });

  it("sem gesto não há fileira nenhuma", () => {
    useApp.setState({ lines: [LINHA], chipsDeSandbox: [] });
    monta();

    expect(container.querySelector(".line-sandbox")).toBeNull();
  });
});
