/**
 * Kernel de plugins — capacidade do agente definida por configuração.
 *
 * Duas origens, com precedência declarada:
 *
 * - **global**, definido pelo ADMIN na política do grupo: vale para todo mundo
 *   do grupo, em todas as abas que o plugin declarar;
 * - **user**, criado pela própria pessoa: vale **só nas execuções de agente
 *   dela**, e só se a política permitir.
 *
 * ## Por que declarativo, e não um módulo JavaScript
 *
 * Um plugin que executa código arbitrário no cliente abriria exatamente a porta
 * que a edição `managed` fecha compilando as saídas diretas para fora do
 * binário. Aqui um plugin **descreve** o que quer — uma ferramenta HTTP, uma
 * ferramenta de um servidor MCP já conectado, um trecho de prompt — e o kernel
 * o executa pelos caminhos que já têm guarda (SSRF no Rust, blocklist da
 * política, fila de aprovação). O usuário ganha extensão de verdade sem ganhar
 * execução de código.
 *
 * ## A regra que não se negocia
 *
 * Plugin de usuário **nunca** sobrepõe plugin do admin. Se os dois declaram a
 * mesma ferramenta, o do usuário é recusado com o motivo — silenciar isso
 * permitiria sequestrar uma ferramenta corporativa pelo nome.
 *
 * Módulo puro: sem rede, sem DOM. Coberto por plugins.test.ts.
 */

import type { UiMode } from "@multiplike/contracts";

export type PluginScope = "global" | "user";

/**
 * Como a ferramenta do plugin é executada. Cada uma cai num caminho que já
 * existe e já tem guarda — nenhuma abre um novo.
 */
export type PluginToolKind =
  /** Requisição HTTPS pelo Rust, com guarda de SSRF e blocklist. */
  | "http"
  /** Ferramenta de um servidor MCP já conectado. */
  | "mcp"
  /** Só texto: monta um trecho de contexto, sem efeito externo. */
  | "prompt";

export interface PluginParam {
  name: string;
  description: string;
  required?: boolean;
}

export interface PluginTool {
  /** Nome local; no registro vira `pluginId.nome`. */
  name: string;
  description: string;
  kind: PluginToolKind;
  /**
   * `http`: URL com `{param}`; `mcp`: `servidor/ferramenta`;
   * `prompt`: o próprio texto, com `{param}`.
   */
  target: string;
  method?: "GET" | "POST";
  params?: PluginParam[];
}

/**
 * Matcher de varredura da aba Security.
 *
 * O caso de uso que motivou: as convenções de auth e de camada de dados são
 * de CADA empresa, e a lista padrão não as conhece. O admin declara os padrões
 * da Multiplike e eles valem para o grupo; a pessoa acrescenta os do projeto
 * dela.
 */
export interface PluginScanner {
  id: string;
  /** O que este padrão indica — vai no prompt da investigação. */
  label: string;
  /** Fonte da expressão regular. Compilada com guarda, nunca com `eval`. */
  pattern: string;
  /** Peso na priorização, de 1 a 10. */
  weight?: number;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  /** Capacidades exigidas; sem elas o plugin não monta. */
  inject?: string[];
  /** Abas onde vale. Vazio/ausente = todas. */
  modes?: UiMode[];
  tools?: PluginTool[];
  /** Trecho injetado no sistema quando o plugin está ativo. */
  prompt?: string;
  /** Padrões extras para a pré-varredura de segurança. */
  scanners?: PluginScanner[];
}

export interface MountedPlugin {
  manifest: PluginManifest;
  scope: PluginScope;
  /** Ferramentas com o nome já qualificado. */
  tools: Array<PluginTool & { qualified: string }>;
}

export interface PluginRegistry {
  plugins: MountedPlugin[];
  /** Capacidades disponíveis para satisfazer `inject`. */
  capabilities: string[];
}

export const EMPTY_REGISTRY: PluginRegistry = { plugins: [], capabilities: [] };

export function createRegistry(capabilities: string[] = []): PluginRegistry {
  return { plugins: [], capabilities: [...new Set(capabilities.map((item) => item.trim()).filter(Boolean))] };
}

/* ----------------------------- Validação ----------------------------- */

const ID = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,38}$/;

export type MountResult =
  | { ok: true; registry: PluginRegistry }
  | { ok: false; reason: string };

/** Nome qualificado — é ele que o modelo vê e que evita colisão entre plugins. */
export function qualify(pluginId: string, tool: string): string {
  return `${pluginId}.${tool}`;
}

/**
 * Valida o manifesto isoladamente (sem olhar o registro).
 *
 * Devolve o MOTIVO, não um booleano: quem escreveu o plugin precisa saber o
 * que corrigir, e "plugin inválido" não conserta nada.
 */
export function validateManifest(manifest: PluginManifest): string | null {
  if (!manifest || typeof manifest !== "object") return "manifesto deve ser um objeto JSON";
  if (!ID.test(manifest.id ?? "")) {
    return "id deve ter de 3 a 40 caracteres, minúsculas, números e hífen, começando por letra";
  }
  if (!manifest.name?.trim()) return "informe um nome";
  if (!manifest.version?.trim()) return "informe uma versão";
  /**
   * O TIPO dos campos importa tanto quanto a presença deles.
   *
   * `{"prompt": 123}` passava por aqui, montava, e no próximo envio o
   * `mounted.manifest.prompt?.trim()` lançava TypeError dentro do
   * `buildSystemMessages` — TODA mensagem, em TODA aba, falhava com um erro
   * críptico até alguém remover o plugin. E `tools: {}` (objeto no lugar de
   * lista) fazia o `for…of` LANÇAR aqui dentro, o que derrubava o
   * `rebuildPlugins` no meio do `apply()` e deixava a política aplicada pela
   * metade, em silêncio.
   */
  if (manifest.prompt !== undefined && typeof manifest.prompt !== "string") {
    return "prompt deve ser texto";
  }
  if (manifest.tools !== undefined && !Array.isArray(manifest.tools)) {
    return "tools deve ser uma lista";
  }
  if (manifest.scanners !== undefined && !Array.isArray(manifest.scanners)) {
    return "scanners deve ser uma lista";
  }
  if (manifest.modes !== undefined && !Array.isArray(manifest.modes)) {
    return "modes deve ser uma lista";
  }

  const vistos = new Set<string>();
  for (const tool of manifest.tools ?? []) {
    if (!TOOL_NAME.test(tool.name ?? "")) {
      return `ferramenta "${tool.name}": use minúsculas, números e sublinhado`;
    }
    if (vistos.has(tool.name)) return `ferramenta "${tool.name}" declarada duas vezes`;
    vistos.add(tool.name);
    if (!tool.description?.trim()) return `ferramenta "${tool.name}": descreva o que ela faz`;
    if (!tool.target?.trim()) return `ferramenta "${tool.name}": informe o alvo`;
    if (tool.kind === "http" && !/^https:\/\//i.test(tool.target)) {
      // Sem TLS o parâmetro que o modelo preenche viajaria em claro.
      return `ferramenta "${tool.name}": só HTTPS`;
    }
    if (tool.kind === "mcp" && !tool.target.includes("/")) {
      return `ferramenta "${tool.name}": use servidor/ferramenta`;
    }
    // Parâmetro citado no alvo mas não declarado nunca seria preenchido.
    const citados = [...tool.target.matchAll(/\{([a-z][a-z0-9_]*)\}/g)].map((hit) => hit[1]);
    const declarados = new Set((tool.params ?? []).map((param) => param.name));
    for (const citado of citados) {
      if (!declarados.has(citado)) return `ferramenta "${tool.name}": parâmetro {${citado}} não declarado`;
    }
  }

  const scanners = new Set<string>();
  for (const scanner of manifest.scanners ?? []) {
    if (!TOOL_NAME.test(scanner.id ?? "")) return `padrão "${scanner.id}": use minúsculas, números e sublinhado`;
    if (scanners.has(scanner.id)) return `padrão "${scanner.id}" declarado duas vezes`;
    scanners.add(scanner.id);
    if (!scanner.label?.trim()) return `padrão "${scanner.id}": descreva o que ele indica`;
    const problema = checkPattern(scanner.pattern ?? "");
    if (problema) return `padrão "${scanner.id}": ${problema}`;
  }
  return null;
}

/** Teto do padrão. Expressão gigante é sinal de gerador, não de intenção. */
const MAX_PATTERN = 400;

/**
 * Quantificador aninhado — a forma clássica de expressão que trava.
 *
 * `(a+)+` ou `(\w*)*` fazem o motor voltar atrás exponencialmente numa entrada
 * que quase casa. Como estes padrões rodam sobre TODOS os arquivos do escopo,
 * um deles derrubaria a interface — e quem escreveu não teria como saber por
 * quê. Recusar na validação é mais honesto que travar depois.
 */
const ANINHADO = /\([^)]*[+*][^)]*\)\s*[+*]/;

/**
 * Alternância quantificada — o mesmo estrago sem quantificador dentro.
 *
 * `(a|a)+b` e `(\w|\d)+x` passavam pela regra acima (não há `+`/`*` DENTRO
 * dos parênteses) e explodem igual: com uma linha longa de "a" sem o "b", o
 * motor tenta cada combinação de como dividir a entrada. Como o padrão roda
 * síncrono no renderer sobre o arquivo inteiro, a interface congela — que é
 * exatamente o que a guarda existe para impedir.
 *
 * A regra é conservadora de propósito: grupo com `|` seguido de `+`/`*`/`{n,}`
 * é recusado, mesmo quando as alternativas não se sobrepõem. Escrever
 * `(?:abc|def)+` sem quantificador externo continua possível, e um padrão
 * legítimo raramente precisa dessa forma.
 */
const ALTERNANCIA_QUANTIFICADA = /\([^)]*\|[^)]*\)\s*(?:[+*]|\{\d+,\d*\})/;

/** Devolve o motivo da recusa, ou `null` quando o padrão presta. */
export function checkPattern(source: string): string | null {
  const bruto = source?.trim() ?? "";
  if (!bruto) return "informe a expressão";
  if (bruto.length > MAX_PATTERN) return `a expressão passa de ${MAX_PATTERN} caracteres`;
  if (ANINHADO.test(bruto)) return "quantificador aninhado pode travar a varredura — simplifique";
  if (ALTERNANCIA_QUANTIFICADA.test(bruto)) {
    return "alternância repetida (ex.: (a|b)+) pode travar a varredura — simplifique";
  }
  try {
    // Sem `g`: `lastIndex` persistiria entre arquivos e o segundo começaria
    // no meio. Este é o mesmo cuidado dos matchers padrão.
    new RegExp(bruto);
  } catch (cause) {
    return `expressão inválida (${cause instanceof Error ? cause.message : "erro"})`;
  }
  return null;
}

/**
 * Padrões dos plugins ativos, prontos para a varredura.
 *
 * Já validados na montagem; aqui só compila. O id é qualificado com o do
 * plugin para dois plugins poderem chamar o padrão de "auth" sem colidir.
 */
export function activeScanners(
  registry: PluginRegistry,
  options: ResolveOptions
): Array<{ id: string; label: string; pattern: RegExp; weight: number; scope: PluginScope }> {
  const saida: Array<{ id: string; label: string; pattern: RegExp; weight: number; scope: PluginScope }> = [];
  for (const mounted of resolve(registry, options)) {
    for (const scanner of mounted.manifest.scanners ?? []) {
      try {
        saida.push({
          id: qualify(mounted.manifest.id, scanner.id),
          label: scanner.label,
          pattern: new RegExp(scanner.pattern),
          weight: Math.max(1, Math.min(Math.floor(scanner.weight ?? 3), 10)),
          scope: mounted.scope
        });
      } catch {
        // Já validado na montagem; se chegou aqui corrompido, ignorar um
        // padrão é melhor que derrubar a varredura inteira.
      }
    }
  }
  return saida;
}

/**
 * Monta o plugin no registro.
 *
 * A ordem de montagem importa: monte os globais ANTES dos do usuário, senão a
 * regra de precedência não tem o que comparar.
 */
export function mount(registry: PluginRegistry, manifest: PluginManifest, scope: PluginScope): MountResult {
  const invalido = validateManifest(manifest);
  if (invalido) return { ok: false, reason: invalido };

  if (registry.plugins.some((mounted) => mounted.manifest.id === manifest.id)) {
    return { ok: false, reason: `já existe um plugin com o id "${manifest.id}"` };
  }

  for (const exigida of manifest.inject ?? []) {
    if (!registry.capabilities.includes(exigida)) {
      return { ok: false, reason: `depende de "${exigida}", que não está disponível` };
    }
  }

  const tools = (manifest.tools ?? []).map((tool) => ({ ...tool, qualified: qualify(manifest.id, tool.name) }));

  // Plugin do usuário não sequestra ferramenta do admin. O contrário é
  // permitido: o admin manda.
  if (scope === "user") {
    const doAdmin = new Set(
      registry.plugins
        .filter((mounted) => mounted.scope === "global")
        .flatMap((mounted) => mounted.tools.map((tool) => tool.qualified))
    );
    const colisao = tools.find((tool) => doAdmin.has(tool.qualified));
    if (colisao) {
      return { ok: false, reason: `"${colisao.qualified}" já é uma ferramenta definida pela administração` };
    }
  }

  return {
    ok: true,
    registry: { ...registry, plugins: [...registry.plugins, { manifest, scope, tools }] }
  };
}

/** Remove o plugin e tudo que ele registrou. Id ausente devolve o mesmo objeto. */
export function unmount(registry: PluginRegistry, id: string): PluginRegistry {
  if (!registry.plugins.some((mounted) => mounted.manifest.id === id)) return registry;
  return { ...registry, plugins: registry.plugins.filter((mounted) => mounted.manifest.id !== id) };
}

/* ------------------------------ Consulta ------------------------------ */

export interface ResolveOptions {
  mode: UiMode;
  /**
   * `false` derruba TODOS os plugins de usuário — é o interruptor do admin.
   * Os globais continuam, porque são dele.
   */
  userPluginsAllowed: boolean;
}

/** Plugins que valem para esta execução, na ordem global → usuário. */
export function resolve(registry: PluginRegistry, options: ResolveOptions): MountedPlugin[] {
  return registry.plugins
    .filter((mounted) => options.userPluginsAllowed || mounted.scope === "global")
    .filter((mounted) => !mounted.manifest.modes?.length || mounted.manifest.modes.includes(options.mode))
    .sort((a, b) => (a.scope === b.scope ? 0 : a.scope === "global" ? -1 : 1));
}

/** Ferramentas expostas ao modelo nesta execução. */
export function activeTools(
  registry: PluginRegistry,
  options: ResolveOptions
): Array<PluginTool & { qualified: string; scope: PluginScope; pluginId: string }> {
  return resolve(registry, options).flatMap((mounted) =>
    mounted.tools.map((tool) => ({ ...tool, scope: mounted.scope, pluginId: mounted.manifest.id }))
  );
}

/**
 * Trecho de contexto dos plugins ativos.
 *
 * Cada bloco é rotulado com a origem porque ele entra no prompt junto com
 * outras sete fontes — sem o rótulo, um comportamento estranho vira caça ao
 * tesouro na trilha.
 */
export function pluginPrompt(registry: PluginRegistry, options: ResolveOptions): string {
  const blocos = resolve(registry, options)
    .filter((mounted) => mounted.manifest.prompt?.trim())
    .map((mounted) => `## ${mounted.manifest.name} (${mounted.scope})\n${mounted.manifest.prompt!.trim()}`);
  return blocos.length ? `Plugins ativos:\n\n${blocos.join("\n\n")}` : "";
}

/* --------------------------- Serialização --------------------------- */

/**
 * Lê um manifesto vindo de fora (JSON do usuário ou da política).
 *
 * Devolve o motivo da recusa em vez de lançar: manifesto ruim é entrada
 * comum, não excepcional — quem escreveu precisa da mensagem.
 */
export function parseManifest(raw: string): { ok: true; manifest: PluginManifest } | { ok: false; reason: string } {
  let valor: unknown;
  try {
    valor = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "JSON inválido" };
  }
  if (!valor || typeof valor !== "object" || Array.isArray(valor)) {
    return { ok: false, reason: "o manifesto deve ser um objeto" };
  }
  const manifest = valor as PluginManifest;
  const invalido = validateManifest(manifest);
  return invalido ? { ok: false, reason: invalido } : { ok: true, manifest };
}

/**
 * Preenche o alvo com os argumentos.
 *
 * Os valores são **codificados para URL** no `http`: o modelo preenche esses
 * campos, e um `&` ou `../` cru mudaria a requisição que o admin autorizou.
 */
export function fillTarget(tool: PluginTool, args: Record<string, string>): { ok: true; target: string } | { ok: false; reason: string } {
  const faltando = (tool.params ?? []).filter((param) => param.required && !args[param.name]?.trim());
  if (faltando.length) {
    return { ok: false, reason: `faltou ${faltando.map((param) => param.name).join(", ")}` };
  }
  const escapar = tool.kind === "http";
  const alvo = tool.target.replace(/\{([a-z][a-z0-9_]*)\}/g, (_todo, nome: string) => {
    const valor = args[nome] ?? "";
    return escapar ? encodeURIComponent(valor) : valor;
  });
  return { ok: true, target: alvo };
}
