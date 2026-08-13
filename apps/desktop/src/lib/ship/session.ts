/**
 * Sessão de build/deploy — compartilhada entre a aba Code e a aba Agent.
 *
 * Fica fora da view para que o Composer consiga injetar o contexto (stack,
 * último run, versão) no prompt sem que o agente precise redescobrir tudo.
 */

import { create } from "zustand";
import { terminal } from "../terminal";
import { buildRun, canRelease, runPipeline, suggestBump, type Exec, type RunState, type StepState } from "./pipeline";
import { sourceLabel, type ProjectSource } from "./source";
import { detectStacks, MANIFEST_FILES, type DetectedStack } from "./stack";
import { collectFiles, fsRead, isTauriFs } from "../fsx";

interface ShipState {
  source?: ProjectSource;
  stacks: DetectedStack[];
  selected?: DetectedStack;
  detecting: boolean;
  run?: RunState;
  version: string;
  /** Controller do run em andamento — permite cancelar. */
  controller?: AbortController;
}

export const useShip = create<ShipState>()(() => ({
  stacks: [],
  detecting: false,
  version: window.localStorage.getItem("ship.version") ?? "V.1"
}));

/** Lista rasa o suficiente para achar as âncoras sem varrer o projeto inteiro. */
const SCAN_LIMITS = { maxDepth: 3, maxEntries: 4000 };

export async function detectFrom(source: ProjectSource, root: string): Promise<void> {
  useShip.setState({ source, detecting: true, stacks: [], selected: undefined, run: undefined });

  // Artefato pré-compilado não tem fonte para inspecionar — o formato já basta.
  if (source.kind === "artifact") {
    useShip.setState({ detecting: false, stacks: [], selected: undefined });
    return;
  }

  const entries = await collectFiles(root, SCAN_LIMITS).catch(() => []);
  const files = entries.map((entry) => entry.path.replace(/\\/g, "/"));

  const manifests: Record<string, string> = {};
  for (const name of MANIFEST_FILES) {
    const hit = files.find((file) => file === name || file.endsWith(`/${name}`));
    if (!hit) continue;
    const content = await fsRead(root, hit).catch(() => "");
    if (content) manifests[name] = content;
  }

  const stacks = detectStacks({ files, manifests });
  useShip.setState({ stacks, selected: stacks[0], detecting: false });
}

export function selectStack(stack: DetectedStack): void {
  useShip.setState({ selected: stack, run: buildRun(`run-${Date.now()}`, stack) });
}

/** Executor real: roda na raiz do projeto, com o terminal do app. */
function execIn(cwd: string): Exec {
  return async (command, signal) => {
    if (signal.aborted) throw new Error("cancelado");
    // Sem host nativo não há terminal. Falha explícita: um "ok" falso aqui
    // liberaria versionar um build que nunca rodou.
    if (!isTauriFs) return { exitCode: 127, output: "Build indisponível no navegador — abra o app desktop." };
    /**
     * "Parar" devolve o controle na hora, e diz a verdade sobre o limite.
     *
     * Antes o signal era consultado só ANTES de iniciar: durante um
     * `docker compose build` o botão parecia não fazer nada, porque o
     * `await` só voltava quando o passo terminava sozinho. Agora a espera
     * termina imediatamente — mas o PROCESSO não morre: nem
     * `terminal_execute` nem `ssh_exec` aceitam cancelamento hoje, e matar
     * um build pela metade num servidor exige suporte do outro lado. O passo
     * registra isso em vez de deixar a pessoa achar que abortou o deploy.
     */
    const execucao = terminal
      .execute(command, cwd)
      .then((result) => ({
        exitCode: result.exitCode ?? 0,
        output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim()
      }));
    const cancelamento = new Promise<{ exitCode: number; output: string }>((resolve) => {
      signal.addEventListener(
        "abort",
        () =>
          resolve({
            exitCode: 130,
            output: "interrompido pelo usuário — o comando pode seguir rodando até terminar sozinho"
          }),
        { once: true }
      );
    });
    return Promise.race([execucao, cancelamento]);
  };
}

export async function startRun(cwd: string): Promise<void> {
  const { selected, controller: previous } = useShip.getState();
  if (!selected) return;
  previous?.abort();

  const controller = new AbortController();
  const run = buildRun(`run-${Date.now()}`, selected);
  useShip.setState({ run: { ...run, status: "running" }, controller });

  const onStep = (step: StepState) =>
    useShip.setState((state) =>
      state.run ? { run: { ...state.run, steps: state.run.steps.map((item) => (item.id === step.id ? step : item)) } } : {}
    );

  const finished = await runPipeline(run, execIn(cwd), controller.signal, { onStep });
  useShip.setState({ run: finished, controller: undefined });
}

export function cancelRun(): void {
  useShip.getState().controller?.abort();
}

export function setVersion(version: string): void {
  window.localStorage.setItem("ship.version", version);
  useShip.setState({ version });
}

export function suggestedBump(): "major" | "minor" | "patch" {
  const run = useShip.getState().run;
  return run ? suggestBump(run.steps) : "patch";
}

/**
 * Contexto para o modelo: o que está carregado, qual stack e como foi o último
 * build. Sem isso o agente sugere `npm run build` em projeto Go.
 */
export function shipContextMessage(): string | undefined {
  const { source, selected, run, version } = useShip.getState();
  if (!source) return undefined;

  const lines = [`Projeto carregado: ${sourceLabel(source)} (${source.kind}).`, `Versão atual: ${version}.`];
  if (selected && selected.id !== "unknown") {
    lines.push(`Stack detectada: ${selected.label}${selected.variant ? ` (${selected.variant})` : ""}, por ${selected.evidence}.`);
    const commands = Object.entries(selected.commands).map(([key, value]) => `${key}: ${value}`);
    if (commands.length) lines.push(`Comandos do projeto — ${commands.join("; ")}.`);
  }
  if (run && run.status !== "idle") {
    const failed = run.steps.find((step) => step.status === "failed");
    lines.push(
      failed
        ? `Último build FALHOU em "${failed.step}" (${failed.command}). Saída: ${failed.output.slice(0, 600)}`
        : `Último build: ${run.status}.`
    );
  }
  if (run && canRelease(run)) lines.push("O build passou inteiro — pode versionar.");
  return lines.join("\n");
}
