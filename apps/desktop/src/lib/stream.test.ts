import { describe, expect, it, vi } from "vitest";

vi.stubGlobal("window", {});
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));

const { readSseStream } = await import("./engine");

function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index++]));
      } else {
        controller.close();
      }
    }
  });
}

const dataEvent = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

const DONE = "data: [DONE]\n\n";

describe("readSseStream", () => {
  it("emite deltas na ordem e retorna o texto completo", async () => {
    const deltas: string[] = [];
    const full = await readSseStream(
      streamFrom([dataEvent("Olá"), dataEvent(", "), dataEvent("mundo"), DONE]),
      (delta) => deltas.push(delta)
    );
    expect(deltas).toEqual(["Olá", ", ", "mundo"]);
    expect(full).toBe("Olá, mundo");
  });

  it("lida com evento partido entre chunks e ignora [DONE]", async () => {
    const event = dataEvent("tudo bem");
    const deltas: string[] = [];
    const full = await readSseStream(
      streamFrom([event.slice(0, 12), event.slice(12), "data: [DONE]\n\n"]),
      (delta) => deltas.push(delta)
    );
    expect(deltas).toEqual(["tudo bem"]);
    expect(full).toBe("tudo bem");
  });

  it("ignora linha de dados malformada sem quebrar o stream", async () => {
    const deltas: string[] = [];
    const full = await readSseStream(streamFrom(["data: {quebrado\n\n", dataEvent("ok"), DONE]), (delta) =>
      deltas.push(delta)
    );
    expect(deltas).toEqual(["ok"]);
    expect(full).toBe("ok");
  });

  it("aceita finish_reason como sinal terminal (provedor sem [DONE])", async () => {
    const finish = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`;
    const full = await readSseStream(streamFrom([dataEvent("pronto"), finish]), () => undefined);
    expect(full).toBe("pronto");
  });

  it("EOF sem sinal terminal é ERRO — resposta truncada não passa por completa", async () => {
    await expect(
      readSseStream(streamFrom([dataEvent("resposta pela met")]), () => undefined)
    ).rejects.toThrow(/interrompida/);
  });

  it("separa o raciocínio do texto visível", async () => {
    const reasoning = `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "pensando" } }] })}\n\n`;
    const visible: string[] = [];
    const thoughts: string[] = [];
    const full = await readSseStream(
      streamFrom([reasoning, dataEvent("resposta"), DONE]),
      (delta) => visible.push(delta),
      (delta) => thoughts.push(delta)
    );
    expect(thoughts).toEqual(["pensando"]);
    expect(visible).toEqual(["resposta"]);
    expect(full).toBe("resposta");
  });
});
