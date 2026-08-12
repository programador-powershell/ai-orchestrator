/**
 * Fine-tuning PELO GATEWAY corporativo.
 *
 * O caminho antigo (lib/finetune.ts) mandava o dataset DIRETO para
 * api.openai.com com a chave do usuário — o dado corporativo saía sem passar
 * pela governança. Aqui tudo passa pelo gateway: ele usa a chave do PROVEDOR
 * do workspace (não a do usuário), registra `usage_events` e persiste o job.
 * Continua sendo fine-tuning em nuvem — não é treino local —, mas auditado.
 *
 * Sem sessão de gateway estas funções falham de propósito: fine-tuning
 * corporativo exige o servidor. O dispatcher em lib/finetuneRoute.ts decide.
 */

import type { FineTuneJob, JobOptions } from "./finetune";
import { buildJobPayload } from "./finetune";
import { useApp } from "./store";

interface Session {
  baseUrl: string;
  workspaceId: string;
  accessToken: string;
}

function session(): Session {
  const current = useApp.getState().session;
  if (!current?.accessToken || !current.workspaceId) {
    throw new Error("fine-tuning corporativo requer conexão com o gateway");
  }
  return current;
}

function base(): string {
  const { baseUrl, workspaceId } = session();
  return `${baseUrl.replace(/\/$/, "")}/v1/workspaces/${workspaceId}/finetune`;
}

async function call(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${base()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${session().accessToken}`,
      ...(init.body && !(init.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {})
    }
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(detail || `gateway respondeu ${response.status}`);
  }
  return response.json();
}

/** O gateway devolve `providerFileId`; o resto do fluxo trata como fileId. */
export async function uploadTrainingFile(jsonl: string, fileName = "dataset.jsonl"): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([jsonl], { type: "application/jsonl" }), fileName);
  form.append("format", "chat");
  const payload = (await call("/datasets", { method: "POST", body: form })) as { providerFileId?: string };
  if (!payload.providerFileId) throw new Error("o gateway não retornou o id do dataset");
  return payload.providerFileId;
}

/** job_json do gateway → o FineTuneJob enxuto que a UI consome. */
function normalize(row: Record<string, unknown>): FineTuneJob {
  return {
    id: String(row.id ?? ""),
    status: String(row.status ?? "desconhecido"),
    fineTunedModel: (row.fineTunedModel as string | null) ?? null,
    error: (row.error as string | null) ?? null
  };
}

export async function createFineTuneJob(
  trainingFileId: string,
  model: string,
  suffix?: string,
  options?: JobOptions
): Promise<FineTuneJob> {
  // Reusa o mesmo builder do caminho direto e adapta os nomes que o gateway
  // espera (baseModel/trainingFileId camelCase).
  const oa = buildJobPayload(trainingFileId, model, suffix, options) as {
    training_file: string;
    hyperparameters?: Record<string, unknown>;
  };
  const body = {
    baseModel: model,
    trainingFileId: oa.training_file,
    suffix,
    method: options?.method ?? "supervised",
    hyperparams: oa.hyperparameters ?? {}
  };
  const row = (await call("/jobs", { method: "POST", body: JSON.stringify(body) })) as Record<string, unknown>;
  return normalize(row);
}

export async function listFineTuneJobs(limit = 20): Promise<FineTuneJob[]> {
  const payload = (await call(`/jobs?limit=${limit}`)) as { jobs?: Array<Record<string, unknown>> };
  return (payload.jobs ?? []).map(normalize);
}

export async function getFineTuneJob(jobId: string): Promise<FineTuneJob> {
  return normalize((await call(`/jobs/${jobId}`)) as Record<string, unknown>);
}

export async function cancelFineTuneJob(jobId: string): Promise<FineTuneJob> {
  return normalize((await call(`/jobs/${jobId}/cancel`, { method: "POST" })) as Record<string, unknown>);
}

export async function listJobEvents(jobId: string, limit = 8): Promise<string[]> {
  const payload = (await call(`/jobs/${jobId}/events?limit=${limit}`)) as {
    events?: Array<{ message?: string }>;
  };
  return (payload.events ?? []).map((event) => event.message ?? "").filter(Boolean);
}
