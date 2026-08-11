import { describe, expect, it } from "vitest";
import { resolvePresetForMode } from "./fusionResolve";
import type { FusionPreset } from "@ai-orchestrator/contracts";

const base: FusionPreset = {
  id: "p1",
  name: "Deep Audit",
  strategy: "orchestrate",
  orchestrator: { providerId: "moonshot", model: "kimi-latest" },
  executors: [{ providerId: "openai", model: "gpt-5.6-luna" }]
};

describe("resolvePresetForMode", () => {
  it("sem override devolve o preset base intacto", () => {
    expect(resolvePresetForMode(base, "chat")).toEqual(base);
  });

  it("aplica orquestrador e executores da atividade", () => {
    const preset: FusionPreset = {
      ...base,
      perMode: {
        code: {
          orchestrator: { providerId: "anthropic", model: "claude-opus-5" },
          executors: [{ providerId: "openai", model: "gpt-5.6-terra" }]
        }
      }
    };
    const resolved = resolvePresetForMode(preset, "code");
    expect(resolved.orchestrator).toEqual({ providerId: "anthropic", model: "claude-opus-5" });
    expect(resolved.executors).toEqual([{ providerId: "openai", model: "gpt-5.6-terra" }]);
    // outra aba continua no base
    expect(resolvePresetForMode(preset, "chat").orchestrator).toEqual(base.orchestrator);
  });

  it("override parcial mantém o resto do preset base", () => {
    const preset: FusionPreset = {
      ...base,
      perMode: { data: { executors: [{ providerId: "deepseek", model: "deepseek-chat" }] } }
    };
    const resolved = resolvePresetForMode(preset, "data");
    expect(resolved.orchestrator).toEqual(base.orchestrator);
    expect(resolved.executors).toEqual([{ providerId: "deepseek", model: "deepseek-chat" }]);
  });

  it("permite trocar a estratégia por atividade", () => {
    const preset: FusionPreset = { ...base, perMode: { security: { strategy: "merge" } } };
    expect(resolvePresetForMode(preset, "security").strategy).toBe("merge");
    expect(resolvePresetForMode(preset, "chat").strategy).toBe("orchestrate");
  });

  it("ignora override com lista de executores vazia (evita preset inválido)", () => {
    const preset: FusionPreset = { ...base, perMode: { work: { executors: [] } } };
    expect(resolvePresetForMode(preset, "work").executors).toEqual(base.executors);
  });
});
