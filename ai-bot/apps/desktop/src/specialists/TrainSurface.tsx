/**
 * Superfície do especialista de TUNING — dataset, configuração e execuções.
 *
 * A ordem dos três blocos é a ordem em que as decisões acontecem de verdade:
 * primeiro o DATASET (formato, tamanho, o que tem dentro), depois a
 * CONFIGURAÇÃO e só então as EXECUÇÕES. Quem começa pelo hiperparâmetro está
 * afinando um treino sobre dados que ninguém olhou, e nenhuma taxa de
 * aprendizado conserta isso.
 *
 * Os dados vêm do `tool.result` de `finetune.status` — relatório legível +
 * bloco ```json demarcado no fim (lib/toolJson).
 */

import { useMemo } from "react";
import {
  AlertTriangle,
  Ban,
  Check,
  Circle,
  Clock,
  Coins,
  Database,
  Loader2,
  SlidersHorizontal,
  X,
  type LucideIcon
} from "lucide-react";
import type { ConversationLine, ToolResult } from "@aibot/contracts";
import { useApp } from "../lib/store";
import { structuredJson } from "../lib/toolJson";
import { TopbarActions, TrainTopbarActions } from "../shell/TopbarActions";

/* -------------------------------- modelo -------------------------------- */

type RunState = "queued" | "running" | "done" | "failed" | "canceled" | "unknown";

const RUN_LABEL: Record<RunState, string> = {
  queued: "na fila",
  running: "rodando",
  done: "concluído",
  failed: "falhou",
  canceled: "cancelado",
  unknown: "—"
};

const RUN_ICON: Record<RunState, LucideIcon> = {
  queued: Clock,
  running: Loader2,
  done: Check,
  failed: X,
  canceled: Ban,
  unknown: Circle
};

/** `.run-row` colore por `data-state`; só conhece running/ok/failed. */
const RUN_HOOK: Record<RunState, string> = {
  queued: "queued",
  running: "running",
  done: "ok",
  failed: "failed",
  canceled: "canceled",
  unknown: "unknown"
};

interface TrainRun {
  id: string;
  state: RunState;
  loss: number | undefined;
  duration: string;
  model: string;
  step: string;
  local: boolean;
}

interface TrainModel {
  hasData: boolean;
  dataset: {
    examples: number | undefined;
    name: string;
    format: string;
    preview: string[];
  };
  config: [string, string][];
  runs: TrainRun[];
  cost: string;
  /** Algum sinal, no payload, de que o treino roda na própria máquina. */
  local: boolean;
}

const EMPTY_MODEL: TrainModel = {
  hasData: false,
  dataset: { examples: undefined, name: "", format: "", preview: [] },
  config: [],
  runs: [],
  cost: "",
  local: false
};

/* ------------------------------ parsing cru ----------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "sim" : "não";
  return "";
}

function firstText(source: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const found = text(source[key]);
    if (found) return found;
  }
  return "";
}

function numberOf(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function firstNumber(source: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const parsed = numberOf(source[key]);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function recordAt(source: Record<string, unknown>, keys: string[]): Record<string, unknown> | null {
  for (const key of keys) {
    const candidate = source[key];
    if (isRecord(candidate)) return candidate;
  }
  return null;
}

function arrayAt(source: Record<string, unknown>, keys: string[]): unknown[] {
  for (const key of keys) {
    const candidate = source[key];
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function pairs(source: Record<string, unknown> | null): [string, string][] {
  if (!source) return [];
  const list: [string, string][] = [];
  for (const [key, value] of Object.entries(source)) {
    if (value === null || value === undefined) continue;
    list.push([key, text(value) || JSON.stringify(value)]);
  }
  return list;
}

function runStateOf(raw: string): RunState {
  const value = raw.toLowerCase();
  if (!value) return "unknown";
  // "validating_files" é a antessala da fila no dialeto da OpenAI: o treino já
  // foi aceito e ainda não roda — para quem olha a tela, é fila.
  if (value.startsWith("queu") || value.startsWith("pend") || value.startsWith("fila") || value.startsWith("valid"))
    return "queued";
  if (value.startsWith("run") || value.startsWith("train") || value.startsWith("rod")) return "running";
  if (
    value.startsWith("succ") ||
    value.startsWith("done") ||
    value.startsWith("compl") ||
    value.startsWith("conclu") ||
    value.startsWith("ok")
  ) {
    return "done";
  }
  if (value.startsWith("fail") || value.startsWith("err") || value.startsWith("falh")) return "failed";
  if (value.startsWith("cancel") || value.startsWith("abort") || value.startsWith("stop")) return "canceled";
  return "unknown";
}

/** Duração legível: o payload manda ms, segundos ou já uma string pronta. */
function durationOf(raw: Record<string, unknown>): string {
  const ready = firstText(raw, ["duration", "elapsed", "took"]);
  if (ready && Number.isNaN(Number(ready))) return ready;

  let milliseconds = firstNumber(raw, ["durationMs", "elapsedMs", "tookMs", "runtimeMs"]);
  if (milliseconds === undefined) {
    const seconds = firstNumber(raw, ["durationSeconds", "elapsedSeconds", "seconds", "duration", "elapsed"]);
    if (seconds !== undefined) milliseconds = seconds * 1000;
  }
  if (milliseconds === undefined) return "";

  const total = Math.max(0, Math.round(milliseconds / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function lossOf(raw: Record<string, unknown>): number | undefined {
  const direct = firstNumber(raw, ["loss", "trainLoss", "finalLoss", "trainingLoss", "evalLoss"]);
  if (direct !== undefined) return direct;
  const metrics = recordAt(raw, ["metrics", "stats", "eval"]);
  return metrics ? firstNumber(metrics, ["loss", "trainLoss", "finalLoss", "evalLoss"]) : undefined;
}

function isLocal(raw: Record<string, unknown>): boolean {
  if (raw["local"] === true || raw["onDevice"] === true || raw["offline"] === true) return true;
  const provider = firstText(raw, ["provider", "backend", "runtime", "device", "engine"]).toLowerCase();
  return provider.includes("local") || provider.includes("cuda") || provider.includes("gpu");
}

function toRun(raw: unknown, index: number): TrainRun | null {
  if (!isRecord(raw)) return null;
  const step = firstNumber(raw, ["step", "steps", "currentStep"]);
  const total = firstNumber(raw, ["totalSteps", "maxSteps", "stepsTotal"]);
  return {
    id: firstText(raw, ["id", "run", "runId", "jobId", "name"]) || `run-${index + 1}`,
    state: runStateOf(firstText(raw, ["state", "status", "phase", "result"])),
    loss: lossOf(raw),
    duration: durationOf(raw),
    model: firstText(raw, ["model", "baseModel", "base", "adapter"]),
    step: step !== undefined ? (total !== undefined ? `${step}/${total}` : String(step)) : "",
    local: isLocal(raw)
  };
}

/** O custo pode chegar como número, string pronta ou objeto {amount,currency}. */
function costOf(root: Record<string, unknown>): string {
  const nested = recordAt(root, ["cost", "estimatedCost", "costEstimate", "pricing", "estimate"]);
  if (nested) {
    const ready = firstText(nested, ["label", "formatted", "display"]);
    if (ready) return ready;
    const amount = firstNumber(nested, ["amount", "value", "estimate", "total", "usd"]);
    const currency = firstText(nested, ["currency", "unit"]) || "US$";
    if (amount !== undefined) return `${currency} ${amount.toFixed(2)}`;
  }
  for (const key of ["estimatedCost", "costEstimate", "cost", "estimatedUsd", "priceEstimate"]) {
    const value = root[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return `US$ ${value.toFixed(2)}`;
  }
  return "";
}

/** Uma linha do dataset em uma linha de texto — a prévia é amostra, não leitor. */
function previewLine(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!isRecord(value)) return text(value);
  const prompt = firstText(value, ["prompt", "input", "instruction", "question", "user"]);
  const completion = firstText(value, ["completion", "output", "response", "answer", "assistant"]);
  if (prompt || completion) return `${prompt} → ${completion}`.trim();
  return JSON.stringify(value);
}

function latestResult(lines: ConversationLine[], tool: string): ToolResult | null {
  let latest: ToolResult | null = null;
  for (const line of lines) {
    for (const result of line.toolResults ?? []) {
      if (result.tool === tool && result.ok && result.output) latest = result;
    }
  }
  return latest;
}

function buildModel(result: ToolResult | null): TrainModel {
  if (!result?.output) return EMPTY_MODEL;
  // O gateway devolve o relatório legível + bloco ```json no fim; resultado
  // antigo, só texto, cai em null e a tela fica no vazio digno.
  const parsed = structuredJson(result.output);
  if (!isRecord(parsed)) return EMPTY_MODEL;

  const datasetRecord = recordAt(parsed, ["dataset", "data", "corpus"]) ?? parsed;

  // `examples` é ambíguo entre os formatos: número = contagem, array = as linhas.
  const rawExamples = datasetRecord["examples"];
  const previewSource = arrayAt(datasetRecord, ["preview", "samples", "head", "rows", "sample"]);
  const preview = (previewSource.length > 0 ? previewSource : Array.isArray(rawExamples) ? rawExamples : [])
    .slice(0, 3)
    .map((row) => previewLine(row))
    .filter((row) => row.length > 0);

  const examples = Array.isArray(rawExamples)
    ? rawExamples.length
    : firstNumber(datasetRecord, ["examples", "count", "size", "rows", "total", "lines", "n"]);

  const configRecord = recordAt(parsed, [
    "config",
    "hyperparams",
    "hyperparameters",
    "parameters",
    "params",
    "training"
  ]);

  const runs = arrayAt(parsed, ["runs", "jobs", "trainings", "history", "executions"])
    .map((item, index) => toRun(item, index))
    .filter((run): run is TrainRun => run !== null);

  return {
    hasData: preview.length > 0 || examples !== undefined || configRecord !== null || runs.length > 0,
    dataset: {
      examples,
      name: firstText(datasetRecord, ["name", "path", "file", "id", "source"]),
      format: firstText(datasetRecord, ["format", "kind", "type"]),
      preview
    },
    config: pairs(configRecord),
    runs,
    cost: costOf(parsed),
    local: isLocal(parsed) || (configRecord ? isLocal(configRecord) : false) || runs.some((run) => run.local)
  };
}

/* ------------------------------ componente ------------------------------ */

export function TrainSurface() {
  const lines = useApp((state) => state.lines);
  // MEMO EM DUAS ETAPAS: o array de linhas troca de identidade a cada delta do
  // streaming, e o memo único reparseava o JSON do resultado por token. A
  // identidade do ToolResult sobrevive aos deltas, então a etapa cara (parse)
  // só roda quando chega resultado novo. Mesmo padrão do FlowSurface.
  const resultado = useMemo(() => latestResult(lines, "finetune.status"), [lines]);
  const train = useMemo(() => buildModel(resultado), [resultado]);

  return (
    <section className="surface train-surface">
      {/* Os botões desta superfície entram na barra do app por portal — o palco
          não desenha barra própria (ver shell/TopbarActions, que também define
          as ações). */}
      <TopbarActions>
        <TrainTopbarActions />
      </TopbarActions>

      <div className="surface-toolbar">
        <span className="surface-title">Tuning</span>
        {train.local ? <span className="chip">local</span> : null}
        <span className="surface-toolbar-spacer" />
        {train.cost ? (
          <span className="chip" data-active="true" title="estimativa da configuração atual">
            <Coins size={12} aria-hidden />
            {train.cost}
          </span>
        ) : null}
        <span className="chip">
          {train.runs.length} {train.runs.length === 1 ? "execução" : "execuções"}
        </span>
      </div>

      <div className="surface-body">
        {!train.hasData ? (
          <div className="surface-empty">
            <SlidersHorizontal size={26} aria-hidden />
            <b>Nenhum treino na mesa</b>
            <span>
              Comece pelo dataset: <code>/dataset</code> monta os exemplos e <code>/avaliar</code>{" "}
              compara com o modelo base. O estado dos treinos (<code>finetune.status</code>) preenche
              esta tela.
            </span>
          </div>
        ) : (
          <>
            {/* O custo estimado fica VISÍVEL e não escondido num detalhe: é a
                única informação da tela que muda a decisão antes de submeter. */}
            {train.cost ? (
              <article className="card train-cost">
                <div className="card-head">
                  <Coins size={14} aria-hidden />
                  <span className="card-title">Custo estimado · {train.cost}</span>
                </div>
                <p className="card-body">
                  Estimativa para a configuração atual, antes de submeter. Treino que roda até o fim
                  cobra o que rodou, não o que foi estimado.
                </p>
              </article>
            ) : null}

            <div className="grid-2">
              <article className="card train-dataset">
                <div className="card-head">
                  <Database size={14} aria-hidden />
                  <span className="card-title">Dataset</span>
                  <span className="chip">
                    {train.dataset.examples !== undefined
                      ? `${train.dataset.examples.toLocaleString("pt-BR")} ${
                          train.dataset.examples === 1 ? "exemplo" : "exemplos"
                        }`
                      : "sem contagem"}
                  </span>
                </div>

                {train.dataset.name || train.dataset.format ? (
                  <p className="card-eyebrow">
                    {train.dataset.name}
                    {train.dataset.format ? ` · ${train.dataset.format}` : ""}
                  </p>
                ) : null}

                {train.dataset.preview.length > 0 ? (
                  <ol className="train-preview" aria-label="Primeiras linhas">
                    {train.dataset.preview.map((row, index) => (
                      <li key={index}>
                        <pre>
                          <code>{row}</code>
                        </pre>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="card-body">A ferramenta não devolveu prévia das linhas.</p>
                )}
              </article>

              <article className="card train-config">
                <div className="card-head">
                  <SlidersHorizontal size={14} aria-hidden />
                  <span className="card-title">Configuração</span>
                  <span className="chip">
                    {train.config.length} {train.config.length === 1 ? "parâmetro" : "parâmetros"}
                  </span>
                </div>

                {train.config.length > 0 ? (
                  <dl className="train-params">
                    {train.config.map(([key, value]) => (
                      <div key={key}>
                        <dt>{key}</dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                  </dl>
                ) : (
                  <p className="card-body">Nenhum hiperparâmetro definido ainda.</p>
                )}

                {/*
                  O aviso fica FIXO, e não só quando o payload diz `local: true`:
                  o caminho comum é a pessoa montar dataset e configuração aqui e
                  só depois descobrir a exigência de GPU. Dizer antes custa uma
                  linha; dizer depois custa a tarde inteira.
                */}
                <div className="card-foot train-warning">
                  <AlertTriangle size={13} aria-hidden />
                  <span>
                    Treino local roda na SUA máquina e exige GPU própria com VRAM suficiente para o
                    modelo base — sem ela o treino não começa, ou cai por falta de memória no meio.
                  </span>
                </div>
              </article>
            </div>

            <article className="card train-runs">
              <div className="card-head">
                <span className="card-title">Execuções</span>
              </div>

              {train.runs.length > 0 ? (
                <ul className="train-run-list">
                  {train.runs.map((run) => {
                    const Icon = RUN_ICON[run.state];
                    return (
                      <li key={run.id} className="run-row" data-state={RUN_HOOK[run.state]}>
                        <span className="run-row-icon" title={RUN_LABEL[run.state]}>
                          <Icon size={14} aria-hidden />
                        </span>
                        <span className="run-row-name" title={run.id}>
                          {run.id}
                          {run.model ? ` · ${run.model}` : ""}
                          {run.local ? " · local" : ""}
                        </span>
                        <span className="run-row-meta">
                          perda {run.loss !== undefined ? run.loss.toFixed(4) : "—"}
                          {run.step ? ` · passo ${run.step}` : ""}
                        </span>
                        <span className="run-row-time">{run.duration || RUN_LABEL[run.state]}</span>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="card-body">Nenhum treino submetido nesta sessão.</p>
              )}
            </article>
          </>
        )}
      </div>

      <div className="surface-status">
        <span>
          dataset{" "}
          <b>
            {train.dataset.examples !== undefined
              ? train.dataset.examples.toLocaleString("pt-BR")
              : "—"}
          </b>
        </span>
        <span>
          execuções <b>{train.runs.length}</b>
        </span>
        {train.cost ? (
          <span>
            custo estimado <b>{train.cost}</b>
          </span>
        ) : null}
        <span className="surface-toolbar-spacer" />
        <span>fonte: finetune.status</span>
      </div>
    </section>
  );
}

export default TrainSurface;
