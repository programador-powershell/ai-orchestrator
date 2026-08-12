/**
 * Execução de build/deploy com controle de versão.
 *
 * O runner é puro em relação ao IO: recebe um `exec` injetado. Isso permite
 * testar a máquina de estados (parar no primeiro erro, cancelar no meio,
 * versionar só quando tudo passou) sem rodar comando nenhum.
 */

import type { DetectedStack } from "./stack";
import { pipelineFor } from "./stack";

export type StepStatus = "pending" | "running" | "ok" | "failed" | "skipped" | "cancelled";

export interface StepState {
  id: string;
  step: string;
  command: string;
  status: StepStatus;
  output: string;
  exitCode?: number;
  durationMs?: number;
}

export interface RunState {
  id: string;
  status: "idle" | "running" | "ok" | "failed" | "cancelled";
  steps: StepState[];
  /** Versão gravada ao final, quando o run inteiro passou. */
  version?: string;
}

export interface ExecResult {
  exitCode: number;
  output: string;
}

/** Assinatura do executor real (terminal_execute no desktop). */
export type Exec = (command: string, signal: AbortSignal) => Promise<ExecResult>;

export function buildRun(id: string, stack: DetectedStack): RunState {
  return {
    id,
    status: "idle",
    steps: pipelineFor(stack).map((entry, index) => ({
      id: `${id}-${index}`,
      step: entry.step,
      command: entry.command,
      status: "pending",
      output: ""
    }))
  };
}

export interface RunEvents {
  onStep?: (step: StepState) => void;
  onDelta?: (stepId: string, chunk: string) => void;
}

/**
 * Roda as etapas em sequência. Para no primeiro erro — um build que segue
 * depois de `install` falhar só produz um erro pior e mais longe da causa.
 */
export async function runPipeline(
  run: RunState,
  exec: Exec,
  signal: AbortSignal,
  events: RunEvents = {},
  now: () => number = () => Date.now()
): Promise<RunState> {
  const steps: StepState[] = run.steps.map((step) => ({ ...step }));
  // Sempre uma cópia: o consumidor guarda o objeto e nós continuamos mutando.
  const emit = (step: StepState) => events.onStep?.({ ...step });
  const skipRest = (from: number) => {
    for (const rest of steps.slice(from)) rest.status = "skipped";
  };

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (signal.aborted) {
      step.status = "cancelled";
      emit(step);
      skipRest(index + 1);
      return { ...run, steps, status: "cancelled" };
    }

    step.status = "running";
    emit(step);
    const started = now();

    try {
      const result = await exec(step.command, signal);
      step.durationMs = now() - started;
      step.exitCode = result.exitCode;
      step.output = result.output;
      step.status = result.exitCode === 0 ? "ok" : "failed";
    } catch (error) {
      step.durationMs = now() - started;
      step.status = signal.aborted ? "cancelled" : "failed";
      step.output = error instanceof Error ? error.message : String(error);
    }

    emit(step);

    if (step.status !== "ok") {
      // As seguintes nunca rodaram — marcar como puladas, não como falhas.
      skipRest(index + 1);
      return { ...run, steps, status: step.status === "cancelled" ? "cancelled" : "failed" };
    }
  }

  return { ...run, steps, status: signal.aborted ? "cancelled" : "ok" };
}

/* ---------------------------------- versão --------------------------------- */

export type BumpKind = "major" | "minor" | "patch";

/**
 * Versionamento no padrão da casa (`V.1`, `V.1.1`, `V.1.1.1`):
 * major = UI/UX ou grande atualização, minor = ganho de função, patch = correção.
 */
export function bumpVersion(current: string, kind: BumpKind): string {
  const match = current.trim().match(/^V\.(\d+)(?:\.(\d+))?(?:\.(\d+))?$/i);
  const major = match ? Number(match[1]) : 0;
  const minor = match?.[2] ? Number(match[2]) : 0;
  const patch = match?.[3] ? Number(match[3]) : 0;

  if (kind === "major") return `V.${major + 1}`;
  if (kind === "minor") return `V.${major || 1}.${minor + 1}`;
  return `V.${major || 1}.${minor}.${patch + 1}`;
}

/** Sugere o tipo de bump pelo que o run fez — o usuário pode trocar. */
export function suggestBump(steps: StepState[]): BumpKind {
  return steps.some((step) => step.step === "Empacotar" && step.status === "ok") ? "minor" : "patch";
}

export interface ReleaseTag {
  version: string;
  /** Comandos de versionamento — mostrados para aprovação antes de rodar. */
  commands: string[];
}

/**
 * Monta a marcação de versão. Não executa: o usuário aprova a lista primeiro,
 * porque `git tag`/`push` é ação que sai da máquina.
 */
export function planRelease(version: string, message: string, push: boolean): ReleaseTag {
  const safe = message.replace(/"/g, "'").slice(0, 200);
  const commands = [`git tag -a ${version} -m "${safe}"`];
  if (push) commands.push(`git push origin ${version}`);
  return { version, commands };
}

/** Um run só pode virar release se todas as etapas passaram. */
export function canRelease(run: RunState): boolean {
  return run.status === "ok" && run.steps.length > 0 && run.steps.every((step) => step.status === "ok");
}
