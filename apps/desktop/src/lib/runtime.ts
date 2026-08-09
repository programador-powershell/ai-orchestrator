import { invoke } from "@tauri-apps/api/core";
import type { RuntimeStatus } from "@ai-orchestrator/contracts";

export const runtime = {
  status: () => invoke<RuntimeStatus>("runtime_status"),
  install: (variant: "cpu" | "vulkan") =>
    invoke<RuntimeStatus>("runtime_install", { variant }),
  start: (modelId: string) => invoke<RuntimeStatus>("runtime_start", { modelId }),
  stop: () => invoke<RuntimeStatus>("runtime_stop"),
  listModels: () => invoke<RuntimeStatus["models"]>("runtime_list_models"),
  downloadModel: (id: string, url: string, sha256: string) =>
    invoke<RuntimeStatus>("runtime_download_model", { id, url, sha256 }),
  removeModel: (id: string) => invoke<RuntimeStatus>("runtime_remove_model", { id }),
  chat: (messages: Array<{ role: string; content: string }>) =>
    invoke<{ choices?: Array<{ message?: { content?: string } }> }>("runtime_chat", { messages })
};
