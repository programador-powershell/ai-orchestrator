/**
 * Bridge de agente local — expõe o runtime local (llama.cpp, API
 * OpenAI-compatível em 127.0.0.1) para agentes EXTERNOS como Claude Code e
 * Codex apontarem para ele ("model swapping"). Nada é instalado nem aberto
 * para fora: o servidor já existe e escuta só em loopback com token.
 *
 * Lógica pura: monta URL/variáveis/config a partir do RuntimeStatus.
 */
import type { RuntimeStatus } from "@orchestrator/contracts";

export interface BridgeStatus {
  online: boolean;
  baseUrl: string | null;
  apiKey: string | null;
  /** Primeiro modelo local disponível — o que o agente externo deve pedir. */
  model: string | null;
}

export function bridgeStatus(status: RuntimeStatus): BridgeStatus {
  const online = Boolean(status.running && status.port);
  return {
    online,
    baseUrl: online ? `http://127.0.0.1:${status.port}/v1` : null,
    apiKey: online ? (status.apiKey ?? null) : null,
    model: status.models[0]?.id ?? null
  };
}

/** Variáveis de ambiente que apontam um agente OpenAI-compatível ao runtime. */
export function bridgeEnvLines(bridge: BridgeStatus): string[] {
  if (!bridge.online || !bridge.baseUrl) return [];
  return [
    `OPENAI_BASE_URL=${bridge.baseUrl}`,
    `OPENAI_API_KEY=${bridge.apiKey ?? ""}`,
    ...(bridge.model ? [`OPENAI_MODEL=${bridge.model}`] : [])
  ];
}

/** Config em JSON para colar em clientes que aceitam base URL + chave. */
export function bridgeConfig(bridge: BridgeStatus): string {
  return JSON.stringify(
    { baseUrl: bridge.baseUrl, apiKey: bridge.apiKey, model: bridge.model },
    null,
    2
  );
}
