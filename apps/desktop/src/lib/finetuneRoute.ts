/**
 * Roteador de fine-tuning: gateway corporativo quando há sessão, direto ao
 * provedor (BYOK) só quando não há gateway.
 *
 * Isto fecha o furo de governança: com o gateway conectado, o dataset
 * corporativo NÃO vai mais direto para api.openai.com com a chave do usuário —
 * passa pelo servidor, que usa a chave do provedor do workspace e registra o
 * uso. Sem gateway, mantém o caminho direto (o mesmo de antes), para quem usa
 * o app de forma autônoma com a própria chave.
 */

import * as direct from "./finetune";
import * as gateway from "./finetuneGateway";
import type { FineTuneJob, JobOptions } from "./finetune";
import { useApp } from "./store";

/** Há um gateway conectado agora? */
export function usesGateway(): boolean {
  const session = useApp.getState().session;
  return Boolean(session?.accessToken && session.workspaceId);
}

const route = () => (usesGateway() ? gateway : direct);

export function uploadTrainingFile(jsonl: string, fileName?: string): Promise<string> {
  return route().uploadTrainingFile(jsonl, fileName);
}

export function createFineTuneJob(
  trainingFileId: string,
  model: string,
  suffix?: string,
  options?: JobOptions
): Promise<FineTuneJob> {
  return route().createFineTuneJob(trainingFileId, model, suffix, options);
}

export function listFineTuneJobs(limit?: number): Promise<FineTuneJob[]> {
  return route().listFineTuneJobs(limit);
}

export function getFineTuneJob(jobId: string): Promise<FineTuneJob> {
  return route().getFineTuneJob(jobId);
}

export function cancelFineTuneJob(jobId: string): Promise<FineTuneJob> {
  return route().cancelFineTuneJob(jobId);
}

export function listJobEvents(jobId: string, limit?: number): Promise<string[]> {
  return route().listJobEvents(jobId, limit);
}
