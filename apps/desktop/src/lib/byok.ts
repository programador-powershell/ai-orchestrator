/**
 * BYOK — armazenamento da chave por provedor.
 *
 * Desktop (Tauri): keyring nativo do Windows via comandos Rust; a chave nunca
 * transita pelo JS na hora da chamada (o Rust lê do keyring).
 * Navegador: fallback em localStorage COM AVISO na UI — útil para o preview
 * web; a recomendação continua sendo o app desktop + cofre corporativo.
 */
import { invoke } from "@tauri-apps/api/core";

const isTauriHost = "__TAURI_INTERNALS__" in window;
const LS_PREFIX = "byok.provider:";

export const byokBackend: "keyring" | "browser" = isTauriHost ? "keyring" : "browser";

export const byok = {
  async set(providerId: string, key: string): Promise<void> {
    const clean = key.trim();
    if (!clean) throw new Error("Chave vazia.");
    if (isTauriHost) {
      await invoke("credential_store", { account: `provider:${providerId}`, token: clean });
    } else {
      localStorage.setItem(`${LS_PREFIX}${providerId}`, clean);
    }
  },

  async has(providerId: string): Promise<boolean> {
    if (isTauriHost) {
      try {
        await invoke<string>("credential_read", { account: `provider:${providerId}` });
        return true;
      } catch {
        return false;
      }
    }
    return Boolean(localStorage.getItem(`${LS_PREFIX}${providerId}`));
  },

  async clear(providerId: string): Promise<void> {
    if (isTauriHost) {
      await invoke("credential_delete", { account: `provider:${providerId}` });
    } else {
      localStorage.removeItem(`${LS_PREFIX}${providerId}`);
    }
  },

  /**
   * Leitura direta da chave — usada SOMENTE pelo caminho web do motor
   * (no desktop quem lê é o Rust). Nunca exibir o valor na UI.
   */
  async readForWebCall(providerId: string): Promise<string | null> {
    if (isTauriHost) return null;
    return localStorage.getItem(`${LS_PREFIX}${providerId}`);
  }
};

/** Headers extras por provedor para chamadas diretas do navegador. */
export function providerExtraHeaders(providerId: string): Record<string, string> {
  if (providerId === "anthropic") {
    // CORS oficial da Anthropic para chamadas de navegador.
    return { "anthropic-dangerous-direct-browser-access": "true" };
  }
  return {};
}
