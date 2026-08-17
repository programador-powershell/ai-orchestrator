import { invoke } from "@tauri-apps/api/core";
import type { ExtensionBundle } from "@orchestrator/contracts";

export const extensions = {
  inspect: (path: string) => invoke<ExtensionBundle>("extension_inspect", { path }),
  import: (path: string) => invoke<ExtensionBundle>("extension_import", { path }),
  list: () => invoke<ExtensionBundle[]>("extension_list")
};
