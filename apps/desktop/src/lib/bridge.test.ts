import { describe, expect, it } from "vitest";
import { bridgeConfig, bridgeEnvLines, bridgeStatus } from "./bridge";

const running = {
  installed: true,
  running: true,
  port: 51234,
  apiKey: "tok-abc",
  models: [{ id: "qwen3-8b", fileName: "qwen3.gguf", size: 1 }]
};

describe("bridgeStatus", () => {
  it("relata online com a URL local quando o runtime está rodando", () => {
    const status = bridgeStatus(running);
    expect(status.online).toBe(true);
    expect(status.baseUrl).toBe("http://127.0.0.1:51234/v1");
    expect(status.model).toBe("qwen3-8b");
  });

  it("relata offline sem porta (runtime parado)", () => {
    const status = bridgeStatus({ installed: true, running: false, models: [] });
    expect(status.online).toBe(false);
    expect(status.baseUrl).toBeNull();
  });

  it("offline quando roda mas não há modelo carregado", () => {
    expect(bridgeStatus({ installed: true, running: true, port: 1, apiKey: "t", models: [] }).model).toBeNull();
  });
});

describe("bridgeEnvLines", () => {
  it("gera as variáveis que apontam um agente externo ao runtime local", () => {
    const lines = bridgeEnvLines(bridgeStatus(running));
    expect(lines.join("\n")).toContain("http://127.0.0.1:51234/v1");
    expect(lines.join("\n")).toContain("tok-abc");
  });

  it("retorna vazio quando offline", () => {
    expect(bridgeEnvLines(bridgeStatus({ installed: false, running: false, models: [] }))).toEqual([]);
  });
});

describe("bridgeConfig", () => {
  it("monta o JSON de configuração no formato OpenAI-compatível", () => {
    const config = JSON.parse(bridgeConfig(bridgeStatus(running))) as {
      baseUrl: string;
      apiKey: string;
      model: string;
    };
    expect(config.baseUrl).toBe("http://127.0.0.1:51234/v1");
    expect(config.apiKey).toBe("tok-abc");
    expect(config.model).toBe("qwen3-8b");
  });
});
