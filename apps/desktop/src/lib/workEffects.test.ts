import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Effect } from "./automations";

/** `invoke` do Tauri e o cliente MCP são as duas saídas reais — ambos mockados. */
const invokeMock = vi.fn();
const callToolMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock("./mcp", () => ({
  McpHttpClient: class {
    constructor(public readonly config: unknown) {}
    callTool(tool: string, args: Record<string, unknown>) {
      return callToolMock(tool, args, this.config);
    }
  }
}));

const { drainEffects, runEffect } = await import("./workEffects");

const webhook: Extract<Effect, { kind: "webhook" }> = {
  kind: "webhook",
  ruleId: "r1",
  ruleName: "Avisar TI",
  secretRef: "teams-ti-abc123",
  label: "Teams · TI",
  body: '{"text":"oi"}'
};

const mcp: Extract<Effect, { kind: "mcp" }> = {
  kind: "mcp",
  ruleId: "r2",
  ruleName: "Abrir chamado",
  server: "jira",
  tool: "create_issue",
  args: { cardId: "c1" }
};

const servidores = [{ name: "jira", url: "https://jira.exemplo.com/mcp" }];

beforeEach(() => {
  invokeMock.mockReset();
  callToolMock.mockReset();
});

describe("runEffect · webhook", () => {
  it("manda só a REFERÊNCIA do segredo, nunca uma URL", async () => {
    invokeMock.mockResolvedValue({ status: 204, ok: true, excerpt: "" });
    const outcome = await runEffect(webhook, servidores);
    expect(outcome.ok).toBe(true);
    const [comando, payload] = invokeMock.mock.calls[0];
    expect(comando).toBe("webhook_post");
    expect(payload).toEqual({ secretRef: "teams-ti-abc123", body: '{"text":"oi"}' });
    // nada que pareça URL saiu do JS
    expect(JSON.stringify(payload)).not.toMatch(/https?:\/\//);
  });

  it("resposta de erro do serviço vira linha honesta, não sucesso", async () => {
    invokeMock.mockResolvedValue({ status: 500, ok: false, excerpt: "internal error" });
    const outcome = await runEffect(webhook, servidores);
    expect(outcome.ok).toBe(false);
    expect(outcome.line).toContain("500");
  });

  it("erro do Rust não lança — vira linha de log", async () => {
    invokeMock.mockRejectedValue(new Error("webhook \"x\" não está no cofre"));
    const outcome = await runEffect(webhook, servidores);
    expect(outcome.ok).toBe(false);
    expect(outcome.line).toContain("não está no cofre");
  });

  it("trecho gigante da resposta é truncado antes de virar UI", async () => {
    invokeMock.mockResolvedValue({ status: 400, ok: false, excerpt: "x".repeat(5000) });
    const outcome = await runEffect(webhook, servidores);
    expect(outcome.line.length).toBeLessThan(300);
    expect(outcome.line).toContain("…");
  });
});

describe("runEffect · mcp", () => {
  it("chama a ferramenta no servidor cadastrado", async () => {
    callToolMock.mockResolvedValue({ ok: true, output: "DSV-1 criada" });
    const outcome = await runEffect(mcp, servidores);
    expect(outcome.ok).toBe(true);
    expect(callToolMock).toHaveBeenCalledWith("create_issue", { cardId: "c1" }, servidores[0]);
    expect(outcome.line).toContain("DSV-1 criada");
  });

  it("servidor não cadastrado falha explicitamente, sem lançar", async () => {
    const outcome = await runEffect(mcp, []);
    expect(outcome.ok).toBe(false);
    expect(outcome.line).toContain("não está cadastrado");
    expect(callToolMock).not.toHaveBeenCalled();
  });

  it("exceção do cliente vira linha de log", async () => {
    callToolMock.mockRejectedValue(new Error("rede caiu"));
    const outcome = await runEffect(mcp, servidores);
    expect(outcome.ok).toBe(false);
    expect(outcome.line).toContain("rede caiu");
  });
});

describe("drainEffects", () => {
  it("uma falha no meio não impede os efeitos seguintes", async () => {
    invokeMock.mockRejectedValueOnce(new Error("caiu")).mockResolvedValueOnce({ status: 200, ok: true, excerpt: "" });
    callToolMock.mockResolvedValue({ ok: true, output: "ok" });
    const outcomes = await drainEffects([webhook, mcp, { ...webhook, ruleId: "r3" }], servidores);
    expect(outcomes).toHaveLength(3);
    expect(outcomes[0].ok).toBe(false);
    expect(outcomes[1].ok).toBe(true);
    expect(outcomes[2].ok).toBe(true);
  });

  it("lista vazia não chama nada", async () => {
    expect(await drainEffects([], servidores)).toEqual([]);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
