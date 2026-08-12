import { describe, expect, it, vi } from "vitest";

vi.stubGlobal("window", {});
vi.stubGlobal("crypto", { randomUUID: () => "id-teste" });

/**
 * Contrato de conversa natural: no fusion, a resposta final deve chegar em
 * VÁRIOS deltas (token a token) e não num único bloco no fim — o comportamento
 * "Perplexity" que queremos evitar.
 */
const deltasByCall: string[][] = [];
let callIndex = 0;

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: ((event: { kind: string; data: string }) => void) | null = null;
  },
  invoke: vi.fn()
}));

// O engine chama providerChat → invoke; simplificamos interceptando no nível do
// gateway (rota workspace), que é o caminho usado quando não há chave local.
vi.mock("./gateway", () => ({
  streamChat: async (
    _session: unknown,
    _mode: string,
    _messages: unknown,
    onDelta: (delta: string) => void
  ) => {
    const chunks = deltasByCall[callIndex] ?? ["ok"];
    callIndex += 1;
    for (const chunk of chunks) onDelta(chunk);
  }
}));

vi.mock("./runtime", () => ({ runtime: { chat: vi.fn(), chatStream: vi.fn() } }));

const { chatOnce } = await import("./engine");

const session = { baseUrl: "http://gw", workspaceId: "ws", accessToken: "t" };

describe("fusion — conversa natural (streaming na etapa final)", () => {
  it("orchestrate entrega a revisão final em vários deltas", async () => {
    callIndex = 0;
    deltasByCall.length = 0;
    deltasByCall.push(["spec"], ["rascunho"], ["Res", "posta ", "final"]);
    const received: string[] = [];
    const preset = {
      id: "p1",
      name: "Orq",
      strategy: "orchestrate" as const,
      orchestrator: { providerId: "openai", model: "a" },
      executors: [{ providerId: "openai", model: "b" }]
    };
    const answer = await chatOnce(
      { kind: "fusion", presetId: "p1" },
      "chat",
      [{ role: "user", content: "oi" }],
      { session, runtimeRunning: false, fusionPresets: [preset] },
      { onDelta: (delta) => received.push(delta) }
    );
    expect(answer).toBe("Resposta final");
    // O ponto do teste: chegou em pedaços, não num único bloco.
    expect(received.length).toBeGreaterThan(1);
    expect(received.join("")).toBe("Resposta final");
  });

  it("merge entrega a integração final em vários deltas", async () => {
    callIndex = 0;
    deltasByCall.length = 0;
    deltasByCall.push(["1. foco A\n2. foco B"], ["parte A"], ["parte B"], ["Int", "egrado"]);
    const received: string[] = [];
    const preset = {
      id: "p2",
      name: "Merge",
      strategy: "merge" as const,
      orchestrator: { providerId: "openai", model: "a" },
      executors: [
        { providerId: "openai", model: "b" },
        { providerId: "openai", model: "c" }
      ]
    };
    await chatOnce(
      { kind: "fusion", presetId: "p2" },
      "chat",
      [{ role: "user", content: "oi" }],
      { session, runtimeRunning: false, fusionPresets: [preset] },
      { onDelta: (delta) => received.push(delta) }
    );
    expect(received.length).toBeGreaterThan(1);
    expect(received.join("")).toContain("Integrado");
  });
});
