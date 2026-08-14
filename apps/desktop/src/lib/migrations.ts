const MIGRATION_KEY = "multiplike-ai.migration.local-runtime.v1";

/**
 * Preserva escolhas antigas sem iniciar downloads ou processos. A antiga seleção
 * local passa a ser apenas uma entrada desativada que o usuário pode reconfigurar.
 */
export function migrateLegacyLocalSettings() {
  if (localStorage.getItem(MIGRATION_KEY)) return;
  const legacyKeys = Object.keys(localStorage).filter((key) => /ollama|local:model|local:provider/i.test(key));
  if (legacyKeys.length) {
    localStorage.setItem("runtime.migrated", JSON.stringify({
      enabled: false,
      source: "legacy-local-provider",
      previousKeys: legacyKeys,
      migratedAt: new Date().toISOString()
    }));
    legacyKeys.forEach((key) => localStorage.removeItem(key));
  }
  localStorage.setItem(MIGRATION_KEY, "done");
}
