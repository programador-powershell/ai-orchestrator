import { describe, expect, it } from "vitest";

import {
  activeTools,
  createRegistry,
  fillTarget,
  mount,
  parseManifest,
  pluginPrompt,
  qualify,
  resolve,
  unmount,
  validateManifest,
  type PluginManifest,
  type PluginRegistry
} from "./plugins";

const manifest = (over: Partial<PluginManifest> = {}): PluginManifest => ({
  id: "cep",
  name: "Consulta de CEP",
  version: "1.0.0",
  tools: [
    {
      name: "buscar",
      description: "Busca o endereço de um CEP",
      kind: "http",
      target: "https://interno.multiplike.local/cep/{cep}",
      params: [{ name: "cep", description: "CEP com 8 dígitos", required: true }]
    }
  ],
  ...over
});

/** Monta ou explode o teste — o caminho feliz não deve exigir cerimônia. */
function mounted(registry: PluginRegistry, item: PluginManifest, scope: "global" | "user"): PluginRegistry {
  const resultado = mount(registry, item, scope);
  if (!resultado.ok) throw new Error(`falhou montar: ${resultado.reason}`);
  return resultado.registry;
}

const opcoes = { mode: "agent" as const, userPluginsAllowed: true };

describe("validateManifest", () => {
  it("aceita um manifesto bem formado", () => {
    expect(validateManifest(manifest())).toBeNull();
  });

  it("recusa id fora do formato, dizendo o formato", () => {
    expect(validateManifest(manifest({ id: "CEP Interno" }))).toContain("minúsculas");
    expect(validateManifest(manifest({ id: "a" }))).toContain("3 a 40");
  });

  it("exige nome e versão", () => {
    expect(validateManifest(manifest({ name: "  " }))).toContain("nome");
    expect(validateManifest(manifest({ version: "" }))).toContain("versão");
  });

  it("recusa ferramenta HTTP sem TLS", () => {
    const ruim = manifest({
      tools: [{ name: "x", description: "d", kind: "http", target: "http://interno/x" }]
    });
    expect(validateManifest(ruim)).toContain("HTTPS");
  });

  it("recusa parâmetro citado no alvo mas não declarado", () => {
    // Sem a checagem, `{token}` nunca seria preenchido e a URL sairia literal.
    const ruim = manifest({
      tools: [
        {
          name: "x",
          description: "d",
          kind: "http",
          target: "https://interno/x?t={token}",
          params: [{ name: "outro", description: "d" }]
        }
      ]
    });
    expect(validateManifest(ruim)).toContain("{token}");
  });

  it("recusa duas ferramentas com o mesmo nome", () => {
    const ruim = manifest({
      tools: [
        { name: "x", description: "d", kind: "prompt", target: "t" },
        { name: "x", description: "d", kind: "prompt", target: "t" }
      ]
    });
    expect(validateManifest(ruim)).toContain("duas vezes");
  });

  it("recusa alvo MCP sem servidor", () => {
    const ruim = manifest({ tools: [{ name: "x", description: "d", kind: "mcp", target: "soltinha" }] });
    expect(validateManifest(ruim)).toContain("servidor/ferramenta");
  });

  it("exige descrição da ferramenta — é o que o modelo lê para decidir usá-la", () => {
    const ruim = manifest({ tools: [{ name: "x", description: " ", kind: "prompt", target: "t" }] });
    expect(validateManifest(ruim)).toContain("descreva");
  });
});

describe("mount", () => {
  it("qualifica a ferramenta com o id do plugin", () => {
    const registry = mounted(createRegistry(), manifest(), "global");
    expect(registry.plugins[0].tools[0].qualified).toBe("cep.buscar");
    expect(qualify("a", "b")).toBe("a.b");
  });

  it("recusa id repetido", () => {
    const registry = mounted(createRegistry(), manifest(), "global");
    const segundo = mount(registry, manifest(), "user");
    expect(segundo.ok).toBe(false);
    if (!segundo.ok) expect(segundo.reason).toContain("já existe");
  });

  it("recusa quando a capacidade exigida não existe", () => {
    const resultado = mount(createRegistry(["mcp"]), manifest({ inject: ["sandbox"] }), "global");
    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.reason).toContain("sandbox");
  });

  it("monta quando a capacidade exigida existe", () => {
    expect(mount(createRegistry(["mcp"]), manifest({ inject: ["mcp"] }), "global").ok).toBe(true);
  });

  it("plugin de USUÁRIO não sequestra ferramenta do admin", () => {
    // Mesmo id de ferramenta, plugin com outro id — o qualificado é que conta.
    const admin = manifest({ id: "cep", name: "CEP oficial" });
    const registry = mounted(createRegistry(), admin, "global");
    const doUsuario = mount(registry, manifest({ id: "cep" }), "user");
    expect(doUsuario.ok).toBe(false);
  });

  it("colisão de ferramenta qualificada é recusada com o nome dela", () => {
    const registry = mounted(createRegistry(), manifest({ id: "interno" }), "global");
    const clone = manifest({ id: "interno" });
    const resultado = mount(registry, clone, "user");
    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.reason).toMatch(/interno|já existe/);
  });

  it("plugin do usuário com id próprio convive com o do admin", () => {
    let registry = mounted(createRegistry(), manifest({ id: "cep" }), "global");
    registry = mounted(registry, manifest({ id: "cep-meu" }), "user");
    expect(registry.plugins).toHaveLength(2);
  });

  it("não altera o registro recebido", () => {
    const original = createRegistry();
    mounted(original, manifest(), "global");
    expect(original.plugins).toHaveLength(0);
  });
});

describe("unmount", () => {
  it("tira o plugin e as ferramentas dele", () => {
    const registry = mounted(createRegistry(), manifest(), "user");
    expect(unmount(registry, "cep").plugins).toEqual([]);
  });

  it("id inexistente devolve o mesmo objeto", () => {
    const registry = mounted(createRegistry(), manifest(), "user");
    expect(unmount(registry, "nao-existe")).toBe(registry);
  });
});

describe("resolve", () => {
  it("o interruptor do admin derruba os do usuário e mantém os globais", () => {
    let registry = mounted(createRegistry(), manifest({ id: "global-um" }), "global");
    registry = mounted(registry, manifest({ id: "meu-um" }), "user");
    const ativos = resolve(registry, { mode: "agent", userPluginsAllowed: false });
    expect(ativos.map((item) => item.manifest.id)).toEqual(["global-um"]);
  });

  it("filtra por aba quando o plugin declara abas", () => {
    let registry = mounted(createRegistry(), manifest({ id: "so-code", modes: ["code"] }), "global");
    registry = mounted(registry, manifest({ id: "todas" }), "global");
    const ativos = resolve(registry, opcoes);
    expect(ativos.map((item) => item.manifest.id)).toEqual(["todas"]);
  });

  it("plugin sem abas declaradas vale em todas", () => {
    const registry = mounted(createRegistry(), manifest({ modes: [] }), "global");
    expect(resolve(registry, { mode: "office", userPluginsAllowed: true })).toHaveLength(1);
  });

  it("global vem antes do usuário, mesmo montado depois", () => {
    let registry = mounted(createRegistry(), manifest({ id: "meu" }), "user");
    registry = mounted(registry, manifest({ id: "corp" }), "global");
    expect(resolve(registry, opcoes).map((item) => item.manifest.id)).toEqual(["corp", "meu"]);
  });
});

describe("activeTools", () => {
  it("expõe o escopo junto — a UI precisa distinguir a origem", () => {
    let registry = mounted(createRegistry(), manifest({ id: "corp" }), "global");
    registry = mounted(registry, manifest({ id: "meu" }), "user");
    const tools = activeTools(registry, opcoes);
    expect(tools.map((tool) => `${tool.qualified}:${tool.scope}`)).toEqual([
      "corp.buscar:global",
      "meu.buscar:user"
    ]);
  });

  it("não expõe ferramenta de plugin filtrado pela aba", () => {
    const registry = mounted(createRegistry(), manifest({ modes: ["design"] }), "global");
    expect(activeTools(registry, opcoes)).toEqual([]);
  });
});

describe("pluginPrompt", () => {
  it("rotula cada bloco com nome e escopo", () => {
    let registry = mounted(createRegistry(), manifest({ id: "corp", prompt: "Use o padrão X." }), "global");
    registry = mounted(registry, manifest({ id: "meu", prompt: "Prefiro Y." }), "user");
    const texto = pluginPrompt(registry, opcoes);
    expect(texto).toContain("(global)");
    expect(texto).toContain("(user)");
    expect(texto.indexOf("Use o padrão X.")).toBeLessThan(texto.indexOf("Prefiro Y."));
  });

  it("sem plugin com prompt, devolve vazio em vez de cabeçalho solto", () => {
    const registry = mounted(createRegistry(), manifest(), "global");
    expect(pluginPrompt(registry, opcoes)).toBe("");
  });
});

describe("parseManifest", () => {
  it("lê um manifesto válido", () => {
    const resultado = parseManifest(JSON.stringify(manifest()));
    expect(resultado.ok).toBe(true);
  });

  it("JSON quebrado devolve motivo, não exceção", () => {
    const resultado = parseManifest("{{{");
    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.reason).toContain("JSON");
  });

  it("array não é manifesto", () => {
    const resultado = parseManifest("[]");
    expect(resultado.ok).toBe(false);
  });

  it("manifesto inválido devolve o mesmo motivo da validação", () => {
    const resultado = parseManifest(JSON.stringify(manifest({ id: "X" })));
    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.reason).toContain("minúsculas");
  });
});

describe("fillTarget", () => {
  const tool = manifest().tools![0];

  it("preenche o parâmetro", () => {
    const resultado = fillTarget(tool, { cep: "01001000" });
    expect(resultado).toEqual({ ok: true, target: "https://interno.multiplike.local/cep/01001000" });
  });

  it("codifica o valor no HTTP — o modelo preenche esse campo", () => {
    // Sem codificar, `?x=1&admin=1` mudaria a requisição que o admin autorizou.
    const resultado = fillTarget(tool, { cep: "a/b?x=1&y=2" });
    expect(resultado.ok).toBe(true);
    if (resultado.ok) {
      expect(resultado.target).toContain("a%2Fb%3Fx%3D1%26y%3D2");
      expect(resultado.target).not.toContain("&y=2");
    }
  });

  it("não codifica no prompt, que não é URL", () => {
    const texto = { name: "t", description: "d", kind: "prompt" as const, target: "Olá {nome}", params: [{ name: "nome", description: "d" }] };
    const resultado = fillTarget(texto, { nome: "João & Maria" });
    expect(resultado).toEqual({ ok: true, target: "Olá João & Maria" });
  });

  it("recusa quando falta parâmetro obrigatório, dizendo qual", () => {
    const resultado = fillTarget(tool, {});
    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.reason).toContain("cep");
  });

  it("parâmetro opcional ausente vira vazio, não trava", () => {
    const opcional = {
      name: "t",
      description: "d",
      kind: "http" as const,
      target: "https://x/{a}",
      params: [{ name: "a", description: "d" }]
    };
    expect(fillTarget(opcional, {})).toEqual({ ok: true, target: "https://x/" });
  });
});
