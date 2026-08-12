/**
 * FINE-TUNING — 100% interno e SÓ NUVEM (API de fine-tuning com a chave BYOK).
 *
 * O app NÃO instala nada e não depende de runtime local: o dataset é montado
 * aqui, validado e enviado ao provedor; o job roda na infraestrutura dele e o
 * modelo resultante entra no catálogo do app.
 *
 * Toda execução (validação, upload, eventos do job) aparece na CONVERSA da
 * aba como cartões — igual ao Claude mostrando diffs na conversa.
 */
import "../styles/modes/tune.css";
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import {
  Cloud,
  Download,
  FlaskConical,
  FolderOpen,
  Gauge,
  History,
  Plus,
  RefreshCw,
  Save,
  Settings2,
  Sparkles,
  Trash2,
  Upload
} from "lucide-react";
import {
  EmptyHero,
  FloatingPulse,
  PanelScroll,
  PanelTitle,
  Surface,
  TopbarActions,
  VBody,
  VCenter,
  VRight,
  VStatus
} from "../components/Primitives";
import { Markdown } from "../components/Markdown";
import { RailConversations } from "../components/RailConversations";
import {
  FINETUNABLE_MODELS,
  validateJsonlForFineTune,
  type FineTuneMethod,
  type FineTuneJob,
  type JobOptions
} from "../lib/finetune";
// Roteado: gateway corporativo quando conectado, direto ao provedor sem ele.
import {
  cancelFineTuneJob,
  createFineTuneJob,
  getFineTuneJob,
  listFineTuneJobs,
  listJobEvents,
  uploadTrainingFile,
  usesGateway
} from "../lib/finetuneRoute";
import { estimateTrainingCost } from "../lib/tunelab";
import { fsWrite, isTauriFs } from "../lib/fsx";
import { useApp } from "../lib/store";

type TuneTab = "configure" | "run" | "history";

interface Hyperparams {
  method: FineTuneMethod;
  epochs: number;
  batchSize: number | null;
  lrMultiplier: number | null;
}

const DEFAULT_HYPERPARAMS: Hyperparams = { method: "supervised", epochs: 3, batchSize: null, lrMultiplier: null };

function toJobOptions(hyperparams: Hyperparams): JobOptions {
  return {
    method: hyperparams.method,
    epochs: hyperparams.epochs,
    ...(hyperparams.batchSize !== null ? { batchSize: hyperparams.batchSize } : {}),
    ...(hyperparams.lrMultiplier !== null ? { lrMultiplier: hyperparams.lrMultiplier } : {})
  };
}

const ROOT_KEY = "tune.root";
const DATASET_KEY = "tune.dataset";
const JOB_KEY = "tune.job";

interface TuneExample {
  id: string;
  system: string;
  user: string;
  assistant: string;
}

const newId = () =>
  crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

function loadDataset(): TuneExample[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(DATASET_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? (parsed as TuneExample[]).filter((item) => item && item.id) : [];
  } catch {
    return [];
  }
}

/** JSONL no formato chat (uma linha por exemplo) — o que a API treina. */
export function datasetToJsonl(examples: TuneExample[]): string {
  return examples
    .map((example) =>
      JSON.stringify({
        messages: [
          ...(example.system.trim() ? [{ role: "system", content: example.system.trim() }] : []),
          { role: "user", content: example.user.trim() },
          { role: "assistant", content: example.assistant.trim() }
        ]
      })
    )
    .join("\n");
}

interface TuneState {
  root: string;
  examples: TuneExample[];
  selectedId: string | null;
  /** Job de treino na nuvem (persistido para acompanhar entre sessões). */
  job: FineTuneJob | null;
  cloudBusy: boolean;
  setRoot: (root: string) => void;
  select: (id: string | null) => void;
}

function loadJob(): FineTuneJob | null {
  try {
    const raw = localStorage.getItem(JOB_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as FineTuneJob;
    return parsed?.id ? parsed : null;
  } catch {
    return null;
  }
}

const useTune = create<TuneState>()((set) => ({
  root: localStorage.getItem(ROOT_KEY) ?? "",
  examples: loadDataset(),
  selectedId: null,
  job: loadJob(),
  cloudBusy: false,
  setRoot: (root) => {
    localStorage.setItem(ROOT_KEY, root);
    set({ root });
  },
  select: (selectedId) => set({ selectedId })
}));

function setJob(job: FineTuneJob | null) {
  try {
    if (job) localStorage.setItem(JOB_KEY, JSON.stringify(job));
    else localStorage.removeItem(JOB_KEY);
  } catch {
    // storage indisponível: segue em memória
  }
  useTune.setState({ job });
}

useTune.subscribe((state, previous) => {
  if (state.examples !== previous.examples) {
    try {
      localStorage.setItem(DATASET_KEY, JSON.stringify(state.examples));
    } catch {
      // storage indisponível: segue em memória
    }
  }
});

/**
 * Toda execução vai para a CONVERSA da aba (thread "tune") — validações e
 * eventos viram cartões, como o Claude mostra diffs na conversa.
 */
const feed = (content: string) =>
  useApp.getState().appendMessage("tune", { role: "assistant", content, meta: { kind: "ops" } });

/** Treino NA NUVEM — interno, via API de fine-tuning com a chave BYOK. */
async function startCloudTraining(model: string, suffix: string, hyperparams: Hyperparams) {
  const { examples, cloudBusy } = useTune.getState();
  if (cloudBusy) return;
  const jsonl = datasetToJsonl(examples);
  const validation = validateJsonlForFineTune(jsonl);
  if (!validation.ok) {
    feed(`**Treino na nuvem** — dataset reprovado na validação:\n${validation.issues.map((issue) => `- ${issue}`).join("\n")}`);
    return;
  }
  useTune.setState({ cloudBusy: true });
  // Diz por onde o dataset vai: gateway corporativo (governança, chave do
  // workspace) ou direto ao provedor com a chave do usuário.
  const via = usesGateway()
    ? "pelo **gateway corporativo** (dado auditado, chave do workspace)"
    : "**direto ao provedor** com a sua chave (sem gateway conectado)";
  feed(`**Treino na nuvem** — enviando ${validation.examples} exemplos ${via}…`);
  try {
    const fileId = await uploadTrainingFile(jsonl);
    feed(`Upload ok (\`${fileId}\`) — criando job de fine-tuning em \`${model}\` (${hyperparams.method}, ${hyperparams.epochs} época(s))…`);
    const job = await createFineTuneJob(fileId, model, suffix, toJobOptions(hyperparams));
    setJob(job);
    feed(`Job criado: \`${job.id}\` · status **${job.status}**. Acompanho aqui na conversa (atualização automática).`);
  } catch (cause) {
    feed(`Treino na nuvem falhou: ${cause instanceof Error ? cause.message : String(cause)}`);
  } finally {
    useTune.setState({ cloudBusy: false });
  }
}

async function refreshJob() {
  const { job, cloudBusy } = useTune.getState();
  if (!job || cloudBusy) return;
  useTune.setState({ cloudBusy: true });
  try {
    const updated = await getFineTuneJob(job.id);
    const events = await listJobEvents(job.id, 5).catch(() => []);
    // Só publica na conversa quando algo mudou — sem poluir o histórico.
    if (updated.status !== job.status || updated.error) {
      feed(
        `Job \`${updated.id}\`: **${updated.status}**` +
          (events.length ? `\n${events.map((event) => `- ${event}`).join("\n")}` : "") +
          (updated.error ? `\n\nErro do job: ${updated.error}` : "")
      );
      if (updated.status === "succeeded" && updated.fineTunedModel) {
        feed(`Modelo pronto: \`${updated.fineTunedModel}\` — use "Adicionar ao catálogo" para ele entrar no seletor e no fusion.`);
      }
    }
    setJob(updated);
  } catch (cause) {
    feed(cause instanceof Error ? cause.message : String(cause));
  } finally {
    useTune.setState({ cloudBusy: false });
  }
}

function addExample() {
  const example: TuneExample = { id: newId(), system: "", user: "", assistant: "" };
  useTune.setState((state) => ({ examples: [...state.examples, example], selectedId: example.id }));
}

function patchExample(id: string, patch: Partial<TuneExample>) {
  useTune.setState((state) => ({
    examples: state.examples.map((example) => (example.id === id ? { ...example, ...patch } : example))
  }));
}

function removeExample(id: string) {
  useTune.setState((state) => ({
    examples: state.examples.filter((example) => example.id !== id),
    selectedId: state.selectedId === id ? null : state.selectedId
  }));
}

function importJsonl(text: string) {
  const imported: TuneExample[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as { messages?: Array<{ role: string; content: string }> };
      if (!Array.isArray(parsed.messages)) continue;
      const system = parsed.messages.find((message) => message.role === "system")?.content ?? "";
      const user = parsed.messages.find((message) => message.role === "user")?.content ?? "";
      const assistant = parsed.messages.find((message) => message.role === "assistant")?.content ?? "";
      if (user && assistant) imported.push({ id: newId(), system, user, assistant });
    } catch {
      // linha inválida é ignorada; contagem final mostra o que entrou
    }
  }
  if (imported.length) useTune.setState((state) => ({ examples: [...state.examples, ...imported] }));
  feed(`Import: ${imported.length} exemplo(s) válidos adicionados ao dataset.`);
}

function downloadJsonl(examples: TuneExample[]) {
  const blob = new Blob([datasetToJsonl(examples)], { type: "application/jsonl" });
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(blob);
  anchor.download = "dataset.jsonl";
  anchor.click();
  URL.revokeObjectURL(anchor.href);
}

/** Rail dinâmico: projeto, dataset e sessões. */
export function TuneRail() {
  const root = useTune((state) => state.root);
  const examples = useTune((state) => state.examples);
  const { setRoot } = useTune.getState();

  return (
    <>
      <span className="eyebrow">PROJETO DE TREINO</span>
      <label className="rail-search">
        <FolderOpen size={13} />
        <input
          value={root}
          onChange={(event) => setRoot(event.target.value)}
          placeholder="pasta do projeto"
          aria-label="Pasta do projeto de fine-tuning"
        />
      </label>
      <span className="chip accent" style={{ margin: "2px 6px" }} title="Dataset e treino na nuvem são do próprio app — nada precisa ser instalado">
        tuning · interno
      </span>
      <span className="eyebrow">DATASET</span>
      <button className="row-item" onClick={addExample}>
        <Plus size={14} />
        <span className="grow">Novo exemplo</span>
        <small>{examples.length}</small>
      </button>
      <span className="eyebrow">TREINOS</span>
      <RailConversations mode="tune" />
    </>
  );
}

export function TuneView() {
  const root = useTune((state) => state.root);
  const examples = useTune((state) => state.examples);
  const selectedId = useTune((state) => state.selectedId);
  const { select } = useTune.getState();
  const messages = useApp((state) => state.threads.tune.messages);
  const sending = useApp((state) => state.threads.tune.sending);
  const stage = useApp((state) => state.stage);
  const feedRef = useRef<HTMLDivElement | null>(null);
  const job = useTune((state) => state.job);
  const cloudBusy = useTune((state) => state.cloudBusy);
  const [baseModel, setBaseModel] = useState(FINETUNABLE_MODELS[0]);
  const [suffix, setSuffix] = useState("");
  const [tab, setTab] = useState<TuneTab>("configure");
  const [hyperparams, setHyperparams] = useState<Hyperparams>(DEFAULT_HYPERPARAMS);
  const [history, setHistory] = useState<FineTuneJob[] | null>(null);

  const selected = examples.find((example) => example.id === selectedId) ?? null;
  const jobRunning = job !== null && !["succeeded", "failed", "cancelled"].includes(job.status);
  const cost = estimateTrainingCost(datasetToJsonl(examples), baseModel, hyperparams.epochs);

  // Job iniciado leva o usuário direto para o acompanhamento (padrão Studio).
  useEffect(() => {
    if (job) setTab("run");
  }, [job?.id]);

  // Histórico carrega do provedor ao abrir a sub-aba (jobs anteriores da conta).
  useEffect(() => {
    if (tab !== "history") return;
    let active = true;
    listFineTuneJobs(20)
      .then((jobs) => active && setHistory(jobs))
      .catch(() => active && setHistory([]));
    return () => {
      active = false;
    };
  }, [tab]);

  // Job em andamento: atualização automática periódica enquanto a aba está aberta.
  useEffect(() => {
    if (!jobRunning) return;
    const timer = window.setInterval(() => void refreshJob(), 20_000);
    return () => window.clearInterval(timer);
  }, [jobRunning]);

  // Conversa acompanha a última mensagem (saídas de execução incluídas).
  useEffect(() => {
    const node = feedRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages.length, sending]);

  async function writeDatasetToProject() {
    if (!isTauriFs || !root.trim()) return;
    try {
      await fsWrite(root.trim(), "dataset.jsonl", datasetToJsonl(examples));
      feed(`\`dataset.jsonl\` gravado no projeto (${examples.length} exemplos).`);
    } catch (cause) {
      feed(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <Surface className="tunex">
      <TopbarActions>
        <span className="chip accent" title="Dataset e treino na nuvem são internos do app — nada é instalado">
          interno
        </span>
        <button
          className="lg-button ghost"
          disabled={!examples.length}
          onClick={() => downloadJsonl(examples)}
          title="Baixar dataset.jsonl (formato chat)"
        >
          <Download size={13} />
          JSONL
        </button>
        <div className="segmented" role="tablist" aria-label="Etapas do treino">
          <button role="tab" aria-selected={tab === "configure"} className={tab === "configure" ? "active" : ""} onClick={() => setTab("configure")}>
            <Settings2 size={12} /> Configurar
          </button>
          <button role="tab" aria-selected={tab === "run"} className={tab === "run" ? "active" : ""} onClick={() => setTab("run")}>
            <Gauge size={12} /> Execução
          </button>
          <button role="tab" aria-selected={tab === "history"} className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>
            <History size={12} /> Histórico
          </button>
        </div>
        <button
          className="lg-button primary"
          disabled={cloudBusy || !examples.length}
          title="Treino REAL na nuvem via API de fine-tuning (sua chave OpenAI) — nada instalado; exige ≥10 exemplos"
          onClick={() => void startCloudTraining(baseModel, suffix, hyperparams)}
        >
          <Cloud size={13} />
          {cloudBusy ? "Enviando…" : "Treinar na nuvem"}
        </button>
      </TopbarActions>

      <VBody>
        <VCenter>
          {sending && <FloatingPulse label={stage || "Gerando"} detail="dataset e config com o motor ativo" />}
          <div className="tunex-center">
            <div className="tunex-dataset v-panel">
              <PanelTitle
                icon={<FlaskConical size={13} />}
                label="Dataset (chat JSONL)"
                meta={`${examples.length} exemplo${examples.length === 1 ? "" : "s"}`}
                action={
                  <span className="tunex-ds-actions">
                    <label className="lg-button compact" title="Importar dataset.jsonl existente">
                      <Upload size={12} />
                      Importar
                      <input
                        type="file"
                        accept=".jsonl,.json,.txt"
                        style={{ display: "none" }}
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (file) void file.text().then(importJsonl);
                          event.target.value = "";
                        }}
                      />
                    </label>
                    {isTauriFs && (
                      <button className="lg-button compact" disabled={!examples.length || !root.trim()} onClick={() => void writeDatasetToProject()}>
                        <Save size={12} />
                        Gravar no projeto
                      </button>
                    )}
                  </span>
                }
              />
              <div className="tunex-examples">
                {examples.length === 0 && (
                  <EmptyHero
                    icon={<FlaskConical size={26} />}
                    kicker="FINE-TUNING · NUVEM"
                    title="Um dataset. Um clique."
                    detail='Monte exemplos (sistema/usuário/assistente) e clique em "Treinar na nuvem" — o job roda na infraestrutura do provedor com a sua chave e o modelo entra no catálogo.'
                  >
                    <button className="lg-button primary" onClick={addExample}>
                      <Plus size={14} />
                      Primeiro exemplo
                    </button>
                  </EmptyHero>
                )}
                {examples.map((example, index) => (
                  <button
                    key={example.id}
                    className={`tunex-example ${example.id === selectedId ? "selected" : ""}`}
                    onClick={() => select(example.id)}
                  >
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <div>
                      <strong>{example.user.trim() || "exemplo sem pergunta"}</strong>
                      <small>{example.assistant.trim().slice(0, 80) || "sem resposta ainda"}</small>
                    </div>
                    <i
                      role="button"
                      aria-label="Remover exemplo"
                      onClick={(event) => {
                        event.stopPropagation();
                        removeExample(example.id);
                      }}
                    >
                      <Trash2 size={12} />
                    </i>
                  </button>
                ))}
              </div>
            </div>
            <div className="tunex-feed v-panel">
              <header>
                <span className="eyebrow">CONVERSA · EXECUÇÃO</span>
                {cloudBusy && <span className="chip accent">rodando…</span>}
              </header>
              <div className="tunex-feed-scroll" ref={feedRef} aria-live="polite">
                {messages.length === 0 && (
                  <p className="tunex-feed-empty">
                    Validações do dataset e eventos do treino aparecem aqui como cartões — junto das respostas do
                    agente. Dataset → Treinar na nuvem.
                  </p>
                )}
                {messages.map((message, index) => (
                  <div key={index} className={`tunex-msg ${message.role}`}>
                    <Markdown source={message.content} />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </VCenter>

        <VRight>
          {selected ? (
            <>
              <PanelTitle icon={<Sparkles size={13} />} label="Exemplo" meta={`#${examples.findIndex((e) => e.id === selected.id) + 1}`} />
              <PanelScroll>
                <div className="tunex-editor">
                  <label className="lg-field">
                    Sistema (opcional)
                    <textarea
                      rows={3}
                      value={selected.system}
                      onChange={(event) => patchExample(selected.id, { system: event.target.value })}
                      placeholder="persona/instruções do assistente"
                    />
                  </label>
                  <label className="lg-field">
                    Usuário
                    <textarea
                      rows={4}
                      value={selected.user}
                      onChange={(event) => patchExample(selected.id, { user: event.target.value })}
                      placeholder="pergunta/entrada"
                    />
                  </label>
                  <label className="lg-field">
                    Assistente
                    <textarea
                      rows={6}
                      value={selected.assistant}
                      onChange={(event) => patchExample(selected.id, { assistant: event.target.value })}
                      placeholder="resposta ideal (o que o modelo deve aprender)"
                    />
                  </label>
                  <button
                    className="lg-button ghost"
                    disabled={!selected.user.trim()}
                    title="Preenche o composer com o prompt de variações — revise e envie"
                    onClick={() =>
                      useApp
                        .getState()
                        .setInput(
                          `Gere 5 exemplos de fine-tuning no formato JSONL chat (messages system/user/assistant) no estilo deste: usuário "${selected.user.slice(0, 120)}"`
                        )
                    }
                  >
                    <Sparkles size={13} />
                    Gerar variações com o agente
                  </button>
                </div>
              </PanelScroll>
            </>
          ) : tab === "history" ? (
            <>
              <PanelTitle icon={<History size={13} />} label="Histórico de treinos" meta="provedor · conta" />
              <PanelScroll>
                <div className="tunex-config">
                  {history === null && <p className="tunex-hint">Carregando jobs anteriores…</p>}
                  {history !== null && history.length === 0 && (
                    <p className="tunex-hint">Nenhum job de fine-tuning na conta ainda.</p>
                  )}
                  {history?.map((entry) => (
                    <div key={entry.id} className="tunex-job">
                      <div className="tunex-job-head">
                        <code className="setx-code">{entry.id}</code>
                        <span
                          className={`chip ${entry.status === "succeeded" ? "ok" : entry.status === "failed" ? "danger" : "accent"}`}
                        >
                          {entry.status}
                        </span>
                      </div>
                      {entry.fineTunedModel && <small className="tunex-note">{entry.fineTunedModel}</small>}
                    </div>
                  ))}
                </div>
              </PanelScroll>
            </>
          ) : (
            <>
              <PanelTitle icon={<Cloud size={13} />} label="Treino na nuvem" meta="interno · API" />
              <div className="tunex-config">
                <p className="tunex-hint">
                  Fine-tuning REAL na infraestrutura do provedor com a sua chave — nada instalado. Exige ≥10 exemplos;
                  o modelo resultante entra no catálogo. Sem export de pesos: modelos tunados na nuvem ficam no catálogo,
                  não geram GGUF.
                </p>
                <div className="tunex-cfg-actions">
                  <label className="lg-field" style={{ flex: 1 }}>
                    Modelo base
                    <select value={baseModel} onChange={(event) => setBaseModel(event.target.value)}>
                      {FINETUNABLE_MODELS.map((model) => (
                        <option key={model} value={model}>
                          {model}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="lg-field" style={{ flex: 1 }}>
                    Sufixo (opcional)
                    <input
                      value={suffix}
                      onChange={(event) => setSuffix(event.target.value)}
                      placeholder="ex.: multiplike"
                      spellCheck={false}
                    />
                  </label>
                </div>
                <div className="tunex-cfg-actions">
                  <label className="lg-field" style={{ flex: 1 }}>
                    Método
                    <select
                      value={hyperparams.method}
                      onChange={(event) => setHyperparams((current) => ({ ...current, method: event.target.value as FineTuneMethod }))}
                    >
                      <option value="supervised">Supervisionado (SFT)</option>
                      <option value="dpo">Preferência (DPO)</option>
                    </select>
                  </label>
                  <label className="lg-field" style={{ flex: 1 }}>
                    Épocas
                    <input
                      type="number"
                      min={1}
                      max={50}
                      value={hyperparams.epochs}
                      onChange={(event) =>
                        setHyperparams((current) => ({ ...current, epochs: Math.max(1, Number(event.target.value) || 1) }))
                      }
                    />
                  </label>
                </div>
                <div className="tunex-cfg-actions">
                  <label className="lg-field" style={{ flex: 1 }}>
                    Batch (auto se vazio)
                    <input
                      type="number"
                      min={1}
                      value={hyperparams.batchSize ?? ""}
                      placeholder="auto"
                      onChange={(event) =>
                        setHyperparams((current) => ({ ...current, batchSize: event.target.value ? Number(event.target.value) : null }))
                      }
                    />
                  </label>
                  <label className="lg-field" style={{ flex: 1 }}>
                    LR multiplier (auto)
                    <input
                      type="number"
                      min={0}
                      step={0.1}
                      value={hyperparams.lrMultiplier ?? ""}
                      placeholder="auto"
                      onChange={(event) =>
                        setHyperparams((current) => ({
                          ...current,
                          lrMultiplier: event.target.value ? Number(event.target.value) : null
                        }))
                      }
                    />
                  </label>
                </div>
                <div className="tunex-preview">
                  <span>
                    <FlaskConical size={11} /> {examples.length} exemplo{examples.length === 1 ? "" : "s"}
                  </span>
                  <span>
                    <Gauge size={11} /> ~{cost.tokens.toLocaleString("pt-BR")} tokens
                  </span>
                  <span title="Estimativa ~4 chars/token × épocas × preço de treino do provedor. Revise antes de rodar.">
                    <Cloud size={11} />{" "}
                    {cost.costUsd === null
                      ? "custo: modelo sem tabela"
                      : `~US$ ${cost.costUsd.toFixed(cost.costUsd < 1 ? 3 : 2)}`}
                  </span>
                  {hyperparams.method === "dpo" && (
                    <span className="tunex-note" style={{ flexBasis: "100%" }}>
                      DPO exige dataset de preferência (input/preferred_output/non_preferred_output) — o construtor de
                      exemplos acima gera SFT.
                    </span>
                  )}
                </div>
                {job && (
                  <div className="tunex-job">
                    <div className="tunex-job-head">
                      <code className="setx-code">{job.id}</code>
                      <span className={`chip ${job.status === "succeeded" ? "ok" : job.status === "failed" ? "danger" : "accent"}`}>
                        {job.status}
                      </span>
                    </div>
                    {job.error && <small className="tunex-note">{job.error}</small>}
                    <div className="tunex-cfg-actions">
                      <button className="lg-button compact" disabled={cloudBusy} onClick={() => void refreshJob()}>
                        <RefreshCw size={12} className={cloudBusy ? "spin" : undefined} />
                        Atualizar status
                      </button>
                      {jobRunning && (
                        <button
                          className="lg-button compact ghost"
                          disabled={cloudBusy}
                          title="Cancelar o job no provedor"
                          onClick={() => {
                            const current = useTune.getState().job;
                            if (!current) return;
                            useTune.setState({ cloudBusy: true });
                            void cancelFineTuneJob(current.id)
                              .then((updated) => {
                                setJob(updated);
                                feed(`Job \`${updated.id}\` cancelado: **${updated.status}**.`);
                              })
                              .catch((cause: unknown) => feed(cause instanceof Error ? cause.message : String(cause)))
                              .finally(() => useTune.setState({ cloudBusy: false }));
                          }}
                        >
                          <Trash2 size={12} />
                          Cancelar
                        </button>
                      )}
                      {job.status === "succeeded" && job.fineTunedModel && (
                        <button
                          className="lg-button compact primary"
                          onClick={() => {
                            const model = job.fineTunedModel as string;
                            const settings = useApp.getState().settings;
                            if (!settings.modelCatalog.some((entry) => entry.model === model)) {
                              useApp.getState().updateSettings({
                                modelCatalog: [
                                  ...settings.modelCatalog,
                                  { providerId: "openai", model, label: suffix.trim() ? `FT ${suffix.trim()}` : "Fine-tuned" }
                                ]
                              });
                            }
                            feed(`\`${model}\` adicionado ao catálogo — disponível no seletor e no fusion.`);
                          }}
                        >
                          <Plus size={12} />
                          Adicionar ao catálogo
                        </button>
                      )}
                      <button className="lg-button compact ghost" onClick={() => setJob(null)} title="Esquecer este job">
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </VRight>
      </VBody>

      <VStatus>
        <span>
          <Cloud size={11} /> treino na nuvem · interno
        </span>
        <span>{examples.length} exemplo{examples.length === 1 ? "" : "s"} no dataset</span>
        <span>
          <FolderOpen size={11} /> {root.trim() || "pasta não definida"}
        </span>
        <div className="spacer" />
        <span>{sending ? stage || "gerando…" : "pronto"}</span>
      </VStatus>
    </Surface>
  );
}
