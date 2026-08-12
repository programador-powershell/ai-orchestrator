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
    // 1ª chamada: PLANO adaptativo do orquestrador (complexidade + executores).
    deltasByCall.push(
      ['```json\n{"complexity":0.8,"executors":[{"role":"Núcleo","focus":"a"},{"role":"Riscos","focus":"b"}]}\n```'],
      ["parte A"],
      ["parte B"],
      ["Int", "egrado"]
    );
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

  it("adaptativo: plano com 1 executor responde direto, sem integração", async () => {
    callIndex = 0;
    deltasByCall.length = 0;
    // Orquestrador julga simples → 1 executor. Não deve haver etapa de integração.
    deltasByCall.push(
      ['```json\n{"complexity":0.15,"executors":[{"role":"Núcleo","focus":"responder"}]}\n```'],
      ["Res", "posta ", "direta"]
    );
    const received: string[] = [];
    const planos: Array<{ complexity: number; executors: unknown[] }> = [];
    const preset = {
      id: "p3",
      name: "Adaptativo",
      strategy: "merge" as const,
      orchestrator: { providerId: "openai", model: "a" },
      executors: [
        { providerId: "openai", model: "b" },
        { providerId: "openai", model: "c" }
      ]
    };
    const answer = await chatOnce(
      { kind: "fusion", presetId: "p3" },
      "chat",
      [{ role: "user", content: "oi" }],
      { session, runtimeRunning: false, fusionPresets: [preset] },
      { onDelta: (delta) => received.push(delta), onFusionPlan: (plan) => planos.push(plan) }
    );
    expect(planos).toHaveLength(1);
    expect(planos[0].executors).toHaveLength(1);
    expect(answer).toBe("Resposta direta");
    // Só 2 chamadas: plano + resposta (sem decompor nem integrar).
    expect(callIndex).toBe(2);
    expect(received.length).toBeGreaterThan(1);
  });
});
