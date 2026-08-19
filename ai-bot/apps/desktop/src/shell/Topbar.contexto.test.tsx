/**
 * O medidor de contexto NA BARRA: aparece com modelo ativo de janela conhecida,
 * carrega a conta no title e some — em vez de inventar número — quando não há
 * o que medir. A conta em si é provada em contextMeter.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ConversationLine, ModelInfo } from "@aibot/contracts";
import { initialAppData, useApp } from "../lib/store";
import { Topbar } from "./Topbar";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: Root;

const MODELOS: ModelInfo[] = [{ id: "m-8k", provider: "local", label: "Oito mil", context: 8000 }];

function linha(text: string): ConversationLine {
  return { id: "l1", seq: 1, role: "assistant", text, ts: "2026-08-19T12:00:00Z" };
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
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
    root.render(<Topbar />);
  });
}

describe("o medidor de contexto na barra", () => {
  it("mostra o percentual estimado e declara a heurística no title", () => {
    useApp.setState({
      ...initialAppData(),
      models: MODELOS,
      activeModel: "m-8k",
      // 8000 chars / 4 = 2000 tokens de 8000 = 25%.
      lines: [linha("x".repeat(8000))]
    });
    monta();

    const meter = container.querySelector<HTMLElement>(".context-meter");
    expect(meter?.textContent).toContain("25%");
    expect(meter?.getAttribute("title")).toContain("caracteres por token");
    expect(meter?.getAttribute("data-nivel")).toBe("ok");
  });

  it("sobe o nível quando a janela está enchendo", () => {
    useApp.setState({
      ...initialAppData(),
      models: MODELOS,
      activeModel: "m-8k",
      lines: [linha("x".repeat(30_000))] // ~94%
    });
    monta();
    expect(container.querySelector(".context-meter")?.getAttribute("data-nivel")).toBe("cheio");
  });

  it("some sem modelo ativo — o chip não inventa percentual", () => {
    useApp.setState({ ...initialAppData(), models: MODELOS, activeModel: "", lines: [linha("oi")] });
    monta();
    expect(container.querySelector(".context-meter")).toBeNull();
  });
});
