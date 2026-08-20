/**
 * A aba VÍDEO reage ao trabalho do PRÓPRIO bot — o conserto anti-casca.
 *
 * O Design tem as ferramentas `video.probe/trim/concat/text/export` (rodadas
 * pelo host, atrás do portão de aprovação — ver tools.go), e até este
 * conserto a aba não reagia a nada disso: o bot cortava e exportava e o
 * estúdio seguia como se nada tivesse acontecido. Aqui a montagem real prova
 * que o `tool.result` confirmado vira linha na seção "Trabalho do bot" (com o
 * arquivo de saída), que a falha aparece COM o erro em vez de sumir, e que
 * ferramenta de outro ofício não contamina a lista.
 *
 * Sem @testing-library: montagem `react-dom/client` crua com o `act` do
 * React 19, como nos outros testes de tela deste projeto.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ConversationLine, ToolCall, ToolResult } from "@aibot/contracts";
import { initialAppData, useApp } from "../lib/store";
import { VideoStudio, useVideoStudio } from "./VideoStudio";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
  useApp.setState({ ...initialAppData() });
  // O store do estúdio é de módulo; cada teste parte do projeto vazio.
  useVideoStudio.setState({ media: [], clips: [], texts: [], logos: [], selectedClipId: null, playbackEpoch: 0 });
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
    root.render(<VideoStudio />);
  });
}

/** Uma linha de assistente com as ferramentas do turno — como o store as pendura. */
function linhaComFerramentas(id: string, calls: ToolCall[], results: ToolResult[]): ConversationLine {
  return {
    id,
    seq: 1,
    turn: "t-1",
    ts: "2026-08-20T12:00:00Z",
    role: "assistant",
    specialist: "design",
    text: "",
    toolCalls: calls,
    toolResults: results
  };
}

describe("a seção «Trabalho do bot» da aba Vídeo", () => {
  it("nasce com vazio honesto — diz o que vai aparecer, sem inventar operação", () => {
    monta();

    const secao = container.querySelector('[aria-label="trabalho do bot em vídeo"]');
    expect(secao).not.toBeNull();
    expect(secao?.textContent).toContain("o resultado de cada operação aparece aqui");
    expect(container.querySelector(".vid-bot-item")).toBeNull();
  });

  it("video.export confirmado vira linha com o arquivo de saída e o resumo", () => {
    useApp.setState({
      lines: [
        linhaComFerramentas(
          "l1",
          [
            {
              callId: "call-vid-1",
              tool: "video.export",
              args: { path: "bruto.mov", output: "corte-final.mp4", format: "mp4" }
            }
          ],
          [
            {
              callId: "call-vid-1",
              tool: "video.export",
              ok: true,
              output: "exportado para corte-final.mp4 (mp4, 12,4 s)\nffmpeg saiu com código 0"
            }
          ]
        )
      ]
    });
    monta();

    const item = container.querySelector(".vid-bot-item");
    expect(item).not.toBeNull();
    expect(item?.getAttribute("data-ok")).toBe("true");
    expect(item?.textContent).toContain("video.export");
    expect(item?.textContent).toContain("corte-final.mp4");
    // Só a PRIMEIRA linha do resultado — o registro integral fica na conversa.
    expect(item?.textContent).toContain("exportado para corte-final.mp4");
    expect(item?.textContent).not.toContain("código 0");
  });

  it("a falha aparece COM o erro — export que morreu é o que a pessoa precisa ver", () => {
    useApp.setState({
      lines: [
        linhaComFerramentas(
          "l1",
          [{ callId: "call-vid-2", tool: "video.trim", args: { path: "bruto.mov", start: 1, end: 5, output: "corte.mp4" } }],
          [{ callId: "call-vid-2", tool: "video.trim", ok: false, error: "ffmpeg não está instalado nesta máquina" }]
        )
      ]
    });
    monta();

    const item = container.querySelector(".vid-bot-item");
    expect(item?.getAttribute("data-ok")).toBe("false");
    expect(item?.textContent).toContain("erro");
    expect(item?.textContent).toContain("ffmpeg não está instalado");
  });

  it("video.probe (sem saída) mostra o arquivo analisado e o veredito", () => {
    useApp.setState({
      lines: [
        linhaComFerramentas(
          "l1",
          [{ callId: "call-vid-3", tool: "video.probe", args: { path: "abertura.mp4" } }],
          [{ callId: "call-vid-3", tool: "video.probe", ok: true, output: "10,0 s · 1920x1080 · h264 + aac" }]
        )
      ]
    });
    monta();

    const item = container.querySelector(".vid-bot-item");
    expect(item?.textContent).toContain("video.probe");
    expect(item?.textContent).toContain("abertura.mp4");
    expect(item?.textContent).toContain("1920x1080");
  });

  it("ferramenta de outro ofício não contamina a lista — a seção é só de video.*", () => {
    useApp.setState({
      lines: [
        linhaComFerramentas(
          "l1",
          [{ callId: "call-fs-1", tool: "fs.write", args: { path: "index.html" } }],
          [{ callId: "call-fs-1", tool: "fs.write", ok: true, output: "gravado" }]
        )
      ]
    });
    monta();

    expect(container.querySelector(".vid-bot-item")).toBeNull();
  });

  it("chamada ainda SEM resultado não vira linha — em curso não tem o que mostrar", () => {
    useApp.setState({
      lines: [
        linhaComFerramentas(
          "l1",
          [{ callId: "call-vid-4", tool: "video.concat", args: { paths: ["a.mp4", "b.mp4"], output: "ab.mp4" } }],
          []
        )
      ]
    });
    monta();

    expect(container.querySelector(".vid-bot-item")).toBeNull();
  });
});
