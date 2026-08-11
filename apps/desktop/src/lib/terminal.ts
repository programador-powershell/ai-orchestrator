import { invoke } from "@tauri-apps/api/core";
import type { LanguageRuntime, TerminalResult } from "@ai-orchestrator/contracts";

export const terminal = {
  catalog: () => invoke<LanguageRuntime[]>("terminal_catalog"),
  execute: (command: string, cwd?: string) => invoke<TerminalResult>("terminal_execute", { command, cwd }),
  installRuntime: (runtimeId: string) => invoke<void>("terminal_runtime_install", { runtimeId })
};
