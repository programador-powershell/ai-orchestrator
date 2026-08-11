/**
 * Fine-tuning INTERNO — sem instalar nada.
 *
 * O treino roda na infraestrutura do provedor (API de fine-tuning da OpenAI)
 * com a chave BYOK do usuário: upload do JSONL → criação do job → acompanhamento
 * → modelo resultante. No desktop a chamada sai do Rust (`provider_fetch`,
 * chave no keyring); no navegador, do próprio app (chave BYOK local).
 * Validações e payloads são puros e testáveis.
 */
import { invoke } from "@tauri-apps/api/core";
import { byok } from "./byok";

const isTauriHost = "__TAURI_INTERNALS__" in window;

/** Modelos fine-tunáveis conhecidos da OpenAI (o campo aceita texto livre). */
export const FINETUNABLE_MODELS = ["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini"];

export interface FineTuneJob {
  id: string;
  status: string;
  fineTunedModel: string | null;
  error: string | null;
}

export interface JsonlValidation {
  ok: boolean;
  examples: number;
  issues: string[];
}

/** Regras mínimas da API: ≥10 exemplos, cada linha JSON com user+assistant. */
export function validateJsonlForFineTune(jsonl: string): JsonlValidation {
  const issues: string[] = [];
  let examples = 0;
  const lines = jsonl.split("\n").filter((line) => line.trim());
  for (const [index, line] of lines.entries()) {
    try {
      const parsed = JSON.parse(line) as { messages?: Array<{ role?: string; content?: string }> };
      const messages = parsed.messages;
      if (!Array.isArray(messages)) {
        issues.push(`linha ${index + 1}: sem array "messages"`);
        continue;
      }
      const hasUser = messages.some((message) => message.role === "user" && message.content?.trim());
      const hasAssistant = messages.some((message) => message.role === "assistant" && message.content?.trim());
      if (!hasUser || !hasAssistant) {
        issues.push(`linha ${index + 1}: precisa de user e assistant com conteúdo`);
        continue;
      }
      examples += 1;
    } catch {
      issues.push(`linha ${index + 1}: JSON inválido`);
    }
  }
  if (examples < 10) issues.push(`a API exige no mínimo 10 exemplos válidos (há ${examples})`);
  return { ok: issues.length === 0, examples, issues };
}

export type FineTuneMethod = "supervised" | "dpo";

export interface JobOptions {
  method?: FineTuneMethod;
  epochs?: number;
  batchSize?: number;
  lrMultiplier?: number;
  validationFileId?: string;
}

function buildHyperparameters(options: JobOptions) {
  return {
    ...(options.epochs !== undefined ? { n_epochs: options.epochs } : {}),
    ...(options.batchSize !== undefined ? { batch_size: options.batchSize } : {}),
    ...(options.lrMultiplier !== undefined ? { learning_rate_multiplier: options.lrMultiplier } : {})
  };
}

export function buildJobPayload(trainingFileId: string, model: string, suffix?: string, options?: JobOptions) {
  const base = {
    training_file: trainingFileId,
    model,
    ...(suffix?.trim() ? { suffix: suffix.trim().slice(0, 18) } : {})
  };
  if (!options) return base;
  const method = options.method ?? "supervised";
  return {
    ...base,
    ...(options.validationFileId ? { validation_file: options.validationFileId } : {}),
    method: { type: method, [method]: { hyperparameters: buildHyperparameters(options) } }
  };
}

/* ---------------------------- transporte ---------------------------- */

interface RequestOptions {
  json?: unknown;
  file?: { name: string; content: string; purpose: string };
}

async function request(baseUrl: string, providerId: string, method: string, path: string, options: RequestOptions = {}) {
  if (isTauriHost) {
    // Desktop: a chave sai do keyring dentro do Rust.
    return invoke("provider_fetch", {
      request: {
        baseUrl,
        account: `provider:${providerId}`,
        method,
        path,
        jsonBody: options.json ?? null,
        fileName: options.file?.name ?? null,
        fileContent: options.file?.content ?? null,
        purpose: options.file?.purpose ?? null
      }
    });
  }
  const key = await byok.readForWebCall(providerId);
  if (!key) throw new Error(`Sem chave para "${providerId}" — adicione em Configurações → Provedores.`);
  const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
  let body: BodyInit | undefined;
  if (options.file) {
    const form = new FormData();
    form.append("purpose", options.file.purpose);
    form.append("file", new Blob([options.file.content], { type: "application/jsonl" }), options.file.name);
    body = form;
  } else if (options.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.json);
  }
  const response = await fetch(`${baseUrl}${path}`, { method, headers, body });
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    const message =
      (payload?.error as { message?: string } | undefined)?.message ?? `provedor respondeu ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

/* ------------------------------ fluxo ------------------------------- */

const OPENAI_BASE = "https://api.openai.com/v1";

export async function uploadTrainingFile(jsonl: string, fileName = "dataset.jsonl"): Promise<string> {
  const payload = (await request(OPENAI_BASE, "openai", "POST", "/files", {
    file: { name: fileName, content: jsonl, purpose: "fine-tune" }
  })) as { id?: string };
  if (!payload?.id) throw new Error("upload não retornou id do arquivo");
  return payload.id;
}

export async function createFineTuneJob(
  trainingFileId: string,
  model: string,
  suffix?: string,
  options?: JobOptions
): Promise<FineTuneJob> {
  const payload = (await request(OPENAI_BASE, "openai", "POST", "/fine_tuning/jobs", {
    json: buildJobPayload(trainingFileId, model, suffix, options)
  })) as Record<string, unknown>;
  return normalizeJob(payload);
}

export async function listFineTuneJobs(limit = 20): Promise<FineTuneJob[]> {
  const payload = (await request(OPENAI_BASE, "openai", "GET", `/fine_tuning/jobs?limit=${limit}`)) as {
    data?: Array<Record<string, unknown>>;
  };
  return (payload.data ?? []).map(normalizeJob);
}

export async function cancelFineTuneJob(jobId: string): Promise<FineTuneJob> {
  const payload = (await request(OPENAI_BASE, "openai", "POST", `/fine_tuning/jobs/${jobId}/cancel`)) as Record<
    string,
    unknown
  >;
  return normalizeJob(payload);
}

export async function getFineTuneJob(jobId: string): Promise<FineTuneJob> {
  const payload = (await request(OPENAI_BASE, "openai", "GET", `/fine_tuning/jobs/${jobId}`)) as Record<string, unknown>;
  return normalizeJob(payload);
}

export async function listJobEvents(jobId: string, limit = 8): Promise<string[]> {
  const payload = (await request(
    OPENAI_BASE,
    "openai",
    "GET",
    `/fine_tuning/jobs/${jobId}/events?limit=${limit}`
  )) as { data?: Array<{ message?: string }> };
  return (payload.data ?? []).map((event) => event.message ?? "").filter(Boolean);
}

export function normalizeJob(payload: Record<string, unknown>): FineTuneJob {
  const error = payload.error as { message?: string } | null | undefined;
  return {
    id: String(payload.id ?? ""),
    status: String(payload.status ?? "desconhecido"),
    fineTunedModel: (payload.fine_tuned_model as string | null) ?? null,
    error: error?.message ?? null
  };
}
