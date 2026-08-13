import { describe, expect, it } from "vitest";

import { buildRegistry } from "./pluginStore";
import { activeTools, type PluginManifest } from "./plugins";

const plugin = (id: string, tool = "buscar"): PluginManifest => ({
  id,
  name: id,
  version: "1.0.0",
  tools: [{ name: tool, description: "d", kind: "prompt", target: "t" }]
});

const opcoes = { mode: "agent" as const, userPluginsAllowed: true };

describe("buildRegistry", () => {
  it("monta global e usuário", () => {
    const { registry, rejected } = buildRegistry({
      global: [plugin("corp")],
      user: [plugin("meu")],
      userPluginsAllowed: true,
      capabilities: []
    });
    expect(registry.plugins.map((item) => `${item.manifest.id}:${item.scope}`)).toEqual([
      "corp:global",
      "meu:user"
    ]);
    expect(rejected).toEqual([]);
  });

  it("com o interruptor fechado, o do usuário nem é montado", () => {
    const { registry } = buildRegistry({
      global: [plugin("corp")],
      user: [plugin("meu")],
      userPluginsAllowed: false,
      capabilities: []
    });
    expect(registry.plugins).toHaveLength(1);
    expect(registry.plugins[0].scope).toBe("global");
  });

  it("global entra ANTES — é o que faz a precedência valer", () => {
    // Se o do usuário montasse primeiro, ele ficaria com o id e o do admin é
    // que seria recusado. A ordem é a regra.
    const { registry, rejected } = buildRegistry({
      global: [plugin("cep")],
      user: [plugin("cep")],
      userPluginsAllowed: true,
      capabilities: []
    });
    expect(registry.plugins).toHaveLength(1);
    expect(registry.plugins[0].scope).toBe("global");
    expect(rejected[0].id).toBe("cep");
    expect(rejected[0].reason).toContain("já existe");
  });

  it("guarda o motivo da recusa em vez de sumir com o plugin", () => {
    const { rejected } = buildRegistry({
      global: [],
      user: [{ id: "X maiúsculo", name: "n", version: "1" }],
      userPluginsAllowed: true,
      capabilities: []
    });
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain("minúsculas");
  });

  it("plugin global inválido não derruba os outros", () => {
    const { registry, rejected } = buildRegistry({
      global: [{ id: "" } as PluginManifest, plugin("bom")],
      user: [],
      userPluginsAllowed: true,
      capabilities: []
    });
    expect(registry.plugins.map((item) => item.manifest.id)).toEqual(["bom"]);
    expect(rejected).toHaveLength(1);
  });

  it("plugin que exige capacidade ausente é recusado com o nome dela", () => {
    const { rejected } = buildRegistry({
      global: [{ ...plugin("mcp-dep"), inject: ["mcp"] }],
      user: [],
      userPluginsAllowed: true,
      capabilities: []
    });
    expect(rejected[0].reason).toContain("mcp");
  });

  it("as ferramentas ficam disponíveis com o escopo certo", () => {
    const { registry } = buildRegistry({
      global: [plugin("corp")],
      user: [plugin("meu")],
      userPluginsAllowed: true,
      capabilities: []
    });
    expect(activeTools(registry, opcoes).map((tool) => `${tool.qualified}:${tool.scope}`)).toEqual([
      "corp.buscar:global",
      "meu.buscar:user"
    ]);
  });

  it("sem plugin nenhum, o registro nasce vazio e sem recusa", () => {
    const { registry, rejected } = buildRegistry({
      global: [],
      user: [],
      userPluginsAllowed: true,
      capabilities: ["mcp"]
    });
    expect(registry.plugins).toEqual([]);
    expect(registry.capabilities).toEqual(["mcp"]);
    expect(rejected).toEqual([]);
  });
});
