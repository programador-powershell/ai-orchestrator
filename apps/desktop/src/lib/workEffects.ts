/**
 * Execução dos efeitos EXTERNOS das automações do Work.
 *
 * Vive fora de `automations.ts` de propósito: o cliente MCP importa
 * `./agent`, que puxa `./fsx` e `./terminal` (e o `invoke` do Tauri). Trazer
 * isso para dentro do motor mataria a pureza que os testes de nó dependem.
 *
 * Aqui só há efeito colateral. Duas garantias que valem mais que o código:
 *
 * 1. **A URL do webhook nunca passa por aqui.** O efeito carrega só a
 *    `secretRef`; quem lê a URL do cofre do SO é o Rust (`webhook_post`).
 * 2. **Nada é executado sem gate.** Quem decide se um efeito sai é o
 *    `workEngine`; esta camada só sabe COMO enviar, não SE pode.
 */
import { invoke } from "@tauri-apps/api/core";
import type { Effect } from "./automations";
import { McpHttpClient, type McpServerConfig } from "./mcp";

export interface EffectOutcome {
  ok: boolean;
  /** Linha pronta para o log do rail. Nunca contém segredo. */
  line: string;
}

interface WebhookOutcome {
  status: number;
  ok: boolean;
  excerpt: string;
}

/** Corta a resposta de terceiro antes de ela virar texto na UI. */
const EXCERPT_LIMIT = 160;

function short(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > EXCERPT_LIMIT ? `${clean.slice(0, EXCERPT_LIMIT)}…` : clean;
}

async function runWebhook(effect: Extract<Effect, { kind: "webhook" }>): Promise<EffectOutcome> {
  try {
    const outcome = await invoke<WebhookOutcome>("webhook_post", {
      secretRef: effect.secretRef,
      body: effect.body
    });
    return {
      ok: outcome.ok,
      line: outcome.ok
        ? `webhook "${effect.label}" enviado (HTTP ${outcome.status})`
        : `webhook "${effect.label}" respondeu HTTP ${outcome.status}${
            outcome.excerpt ? ` — ${short(outcome.excerpt)}` : ""
          }`
    };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, line: `webhook "${effect.label}" falhou — ${short(detail)}` };
  }
}

async function runMcp(
  effect: Extract<Effect, { kind: "mcp" }>,
  servers: McpServerConfig[]
): Promise<EffectOutcome> {
  const server = servers.find((entry) => entry.name === effect.server);
  if (!server) {
    // Honesto: servidor não cadastrado é erro de configuração, não "sucesso silencioso".
    return {
      ok: false,
      line: `servidor MCP "${effect.server}" não está cadastrado nas Configurações — ${effect.tool} não executou`
    };
  }
  try {
    const result = await new McpHttpClient(server).callTool(effect.tool, effect.args);
    return {
      ok: result.ok,
      line: `mcp:${effect.server}:${effect.tool} ${result.ok ? "executou" : "falhou"} — ${short(result.output)}`
    };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, line: `mcp:${effect.server}:${effect.tool} falhou — ${short(detail)}` };
  }
}

/** Executa UM efeito. Nunca lança: a falha vira linha de log. */
export function runEffect(effect: Effect, servers: McpServerConfig[]): Promise<EffectOutcome> {
  return effect.kind === "webhook" ? runWebhook(effect) : runMcp(effect, servers);
}

/**
 * Drena a fila em SÉRIE. Um efeito que falha não interrompe os seguintes —
 * cada regra é independente e o operador precisa ver o resultado de todas.
 */
export async function drainEffects(
  effects: readonly Effect[],
  servers: McpServerConfig[]
): Promise<EffectOutcome[]> {
  const outcomes: EffectOutcome[] = [];
  for (const effect of effects) {
    outcomes.push(await runEffect(effect, servers));
  }
  return outcomes;
}
