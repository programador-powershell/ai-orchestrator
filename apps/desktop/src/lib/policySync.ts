/**
 * Sincronização da política — o lado IMPURO (window, store, invoke).
 * Separado de lib/policy.ts para os helpers puros rodarem na suíte node.
 */

import { invoke } from "@tauri-apps/api/core";
import type { BootstrapResponse } from "@ai-bot/contracts";
import { useApp } from "./store";
import { usePlugins } from "./pluginStore";

const isTauriHost = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;



function apply(body: BootstrapResponse & { verified?: boolean }): void {
  useApp.setState({
    policy: body.policy,
    profile: body.profile,
    policyVerified: Boolean(body.verified)
  });
  rebuildPlugins(body.policy);
}

/**
 * Remonta o registro de plugins a cada política nova.
 *
 * Sem isto, mudar o plugin global no console do admin só valeria depois de
 * reiniciar o app — e o admin ficaria sem saber se a mudança pegou. Também é
 * aqui que o interruptor de plugin de usuário passa a valer na hora.
 */
function rebuildPlugins(policy: BootstrapResponse["policy"]): void {
  usePlugins.getState().rebuild({
    global: policy.agentPlugins ?? [],
    userPluginsAllowed: policy.userPluginsAllowed ?? false,
    // Capacidades que um plugin pode exigir em `inject`.
    capabilities: ["http", "mcp", "prompt"]
  });
}

/**
 * Busca a política ao logar. No desktop passa pelo Rust (que verifica a
 * assinatura); no navegador — superfície de desenvolvimento — busca direto e
 * fica marcada como não-verificada.
 */
export async function syncPolicy(baseUrl: string, accessToken: string): Promise<void> {
  try {
    if (isTauriHost) {
      const body = await invoke<BootstrapResponse & { verified?: boolean }>("bootstrap_sync", {
        baseUrl,
        token: accessToken
      });
      apply(body);
      return;
    }
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/bootstrap`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!response.ok) return;
    apply({ ...((await response.json()) as BootstrapResponse), verified: false });
  } catch {
    // Sem rede: o cache assinado (restorePolicy) cobre a graça offline.
  }
}

/** Cache assinado do disco — chamado no boot, antes de qualquer rede. */
export async function restorePolicy(): Promise<void> {
  if (!isTauriHost) return;
  try {
    const cached = await invoke<(BootstrapResponse & { verified?: boolean }) | null>("bootstrap_cached");
    if (cached) apply(cached);
  } catch {
    // Cache inválido/adulterado: segue sem política; o login renova.
  }
}

