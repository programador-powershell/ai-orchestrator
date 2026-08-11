/**
 * FINE-TUNING — interno, com o soup EMBUTIDO (third_party/soup, Apache-2.0).
 *
 * O app NÃO instala nada. Escada de execução local: binário `soup` no PATH →
 * cópia embutida rodando via Python do usuário (`run_soup.py`, sem pip) →
 * fonte presente sem runtime (rotulado honestamente). O treino na nuvem é
 * 100% interno (API de fine-tuning com a chave BYOK).
 *
 * Toda execução (comandos, saídas, eventos do job) aparece na CONVERSA da
 * aba como cartões — igual ao Claude mostrando diffs na conversa.
 */
import "../styles/modes/tune.css";
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import {
  Cloud,
  Cpu,
  Download,
  FlaskConical,
  FolderOpen,
  Plus,
  RefreshCw,
  Save,
  Sparkles,
  Trash2,
  Upload,
  Wand2
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
  createFineTuneJob,
  getFineTuneJob,
  listJobEvents,
  uploadTrainingFile,
  validateJsonlForFineTune,
  type FineTuneJob
} from "../lib/finetune";
import { fsRead, fsWrite, isTauriFs } from "../lib/fsx";
import { terminal } from "../lib/terminal";
import { useApp } from "../lib/store";
import { vendoredSoupCommand, vendoredSoupLauncher } from "../lib/vendored";

const isTauriHost = "__TAURI_INTERNALS__" in window;
const ROOT_KEY = "tune.root";
const DATASET_KEY = "tune.dataset";
const JOB_KEY = "tune.job";

/**
 * Template interno do soup.yaml (compatível com o soup-cli homologado) —
 * gerado pelo PRÓPRIO app, sem binário externo. Ajuste livre no editor.
 */
const SOUP_TEMPLATE = `# soup.yaml — gerado internamente pelo AI Orchestrator (template chat)
# Docs do formato: github.com/MakazhanAlpamys/Soup
model: meta-llama/Llama-3.1-8B-Instruct
dataset: dataset.jsonl
template: chat
output: ./soup-out
train:
  method: lora
  epochs: 3
  batch_size: auto
  quantization: nf4
  # GPUs pequenas (ex.: 4 GB): ative o layer streaming (BETA)
  stream_layers: false
`;

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

/** JSONL no formato chat (uma linha por exemplo) — o que o soup treina. */
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
  /** Escada local: binário no PATH → cópia EMBUTIDA via Python → só fonte. */
  soup: { status: "unknown" | "ok" | "vendored" | "missing"; version: string; launcher: string | null };
  examples: TuneExample[];
  selectedId: string | null;
  busy: boolean;
  configText: string;
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
  soup: { status: "unknown", version: "", launcher: null },
  examples: loadDataset(),
  selectedId: null,
  busy: false,
  configText: "",
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
 * Toda execução vai para a CONVERSA da aba (thread "tune") — comandos e
 * saídas viram cartões, como o Claude mostra diffs na conversa.
 */
const feed = (content: string) =>
  useApp.getState().appendMessage("tune", { role: "assistant", content, meta: { kind: "ops" } });

/** Saída de terminal como cartão de código na conversa. */
const feedConsole = (command: string, output: string, footer?: string) =>
  feed(`\`\`\`console\n$ ${command}\n${output.trimEnd()}\n\`\`\`${footer ? `\n${footer}` : ""}`);

async function detectSoup() {
  if (!isTauriHost) {
    useTune.setState({ soup: { status: "missing", version: "", launcher: null } });
    return;
  }
  try {
    const result = await terminal.execute("soup --version");
    if (result.exitCode === 0) {
      useTune.setState({
        soup: { status: "ok", version: result.stdout.trim().split("\n")[0] ?? "", launcher: null }
      });
      return;
    }
  } catch {
    // binário ausente: tenta a cópia embutida
  }
  // Cópia EMBUTIDA (third_party/soup) via Python do usuário — sonda REAL.
  const launcher = await vendoredSoupLauncher();
  if (launcher) {
    try {
      const probe = await terminal.execute(vendoredSoupCommand(launcher, "--version"));
      if (probe.exitCode === 0) {
        useTune.setState({
          soup: { status: "vendored", version: probe.stdout.trim().split("\n")[0] ?? "", launcher }
        });
        return;
      }
    } catch {
      // Python/deps ausentes: fonte embutida segue disponível, sem runtime
    }
  }
  useTune.setState({ soup: { status: "missing", version: "", launcher } });
}

/** Comando local REAL — binário ou a cópia embutida — com saída na conversa. */
async function runSoup(command: string) {
  const { root, busy, soup } = useTune.getState();
  if (busy) return;
  if (!isTauriHost) {
    feedConsole(command, "execução local real acontece no app desktop — aqui no navegador só o treino na nuvem roda.");
    return;
  }
  // soup <args>: traduz para a cópia embutida quando não há binário no PATH.
  let real = command;
  if (command.startsWith("soup") && soup.status === "vendored" && soup.launcher) {
    real = vendoredSoupCommand(soup.launcher, command.replace(/^soup\s*/, ""));
  }
  useTune.setState({ busy: true });
  try {
    const result = await terminal.execute(real, root.trim() || undefined);
    const output = [result.stdout, result.stderr].filter(Boolean).join("");
    feedConsole(command, output || "(sem saída)", `\`exit ${result.exitCode ?? "n/a"} · ${result.durationMs} ms\``);
  } catch (cause) {
    feedConsole(command, cause instanceof Error ? cause.message : String(cause));
  } finally {
    useTune.setState({ busy: false });
  }
}

/** Init INTERNO: o app gera o soup.yaml do template embutido — sem binário. */
async function initInternal() {
  const { root } = useTune.getState();
  useTune.setState({ configText: SOUP_TEMPLATE });
  if (isTauriFs && root.trim()) {
    try {
      await fsWrite(root.trim(), "soup.yaml", SOUP_TEMPLATE);
      feed("**Init interno** — `soup.yaml` gerado no projeto (template chat embutido, nenhum binário usado):\n```yaml\n" + SOUP_TEMPLATE.trimEnd() + "\n```");
      return;
    } catch (cause) {
      feed(`Init interno falhou ao gravar: ${cause instanceof Error ? cause.message : String(cause)}`);
      return;
    }
  }
  feed(
    "**Init interno** — template carregado no editor de config" +
      (isTauriFs ? " — defina a pasta do projeto para gravar o soup.yaml." : " (gravação em disco no app desktop).")
  );
}

/** Treino NA NUVEM — interno, via API de fine-tuning com a chave BYOK. */
async function startCloudTraining(model: string, suffix: string) {
  const { examples, cloudBusy } = useTune.getState();
  if (cloudBusy) return;
  const jsonl = datasetToJsonl(examples);
  const validation = validateJsonlForFineTune(jsonl);
  if (!validation.ok) {
    feed(`**Treino na nuvem** — dataset reprovado na validação:\n${validation.issues.map((issue) => `- ${issue}`).join("\n")}`);
    return;
  }
  useTune.setState({ cloudBusy: true });
  feed(`**Treino na nuvem** — enviando ${validation.examples} exemplos para a OpenAI…`);
  try {
    const fileId = await uploadTrainingFile(jsonl);
    feed(`Upload ok (\`${fileId}\`) — criando job de fine-tuning em \`${model}\`…`);
    const job = await createFineTuneJob(fileId, model, suffix);
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

/** Rail dinâmico: projeto, status do soup, dataset e sessões. */
export function TuneRail() {
  const root = useTune((state) => state.root);
  const soup = useTune((state) => state.soup);
  const examples = useTune((state) => state.examples);
  const busy = useTune((state) => state.busy);
  const { setRoot } = useTune.getState();

  return (
    <>
      <span className="eyebrow">PROJETO DE TREINO</span>
      <label className="rail-search">
        <FolderOpen size={13} />
        <input
          value={root}
          onChange={(event) => setRoot(event.target.value)}
          placeholder="pasta do projeto soup"
          aria-label="Pasta do projeto de fine-tuning"
        />
      </label>
      <button className="lg-button compact" onClick={() => void detectSoup()} disabled={busy}>
        <RefreshCw size={13} />
        Detectar soup
      </button>
      <span className="chip accent" style={{ margin: "2px 6px" }} title="Init, dataset e treino na nuvem são do próprio app — nada precisa ser instalado">
        tuning · interno
      </span>
      <span
        className={`chip ${soup.status === "ok" || soup.status === "vendored" ? "ok" : ""}`}
        style={{ margin: "0 6px 2px" }}
        title="O soup viaja EMBUTIDO no app (third_party/soup, Apache-2.0) e roda da cópia local via Python — sem instalar nada. Sem runtime Python/ML, o treino interno na nuvem cobre tudo."
      >
        {soup.status === "ok"
          ? `soup local: ${soup.version}`.trim()
          : soup.status === "vendored"
            ? `soup embutido: ${soup.version}`.trim()
            : "soup embutido: requer Python p/ rodar"}
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
  const soup = useTune((state) => state.soup);
  const examples = useTune((state) => state.examples);
  const selectedId = useTune((state) => state.selectedId);
  const busy = useTune((state) => state.busy);
  const configText = useTune((state) => state.configText);
  const { select } = useTune.getState();
  const messages = useApp((state) => state.threads.tune.messages);
  const sending = useApp((state) => state.threads.tune.sending);
  const stage = useApp((state) => state.stage);
  const feedRef = useRef<HTMLDivElement | null>(null);
  const job = useTune((state) => state.job);
  const cloudBusy = useTune((state) => state.cloudBusy);
  const [configNote, setConfigNote] = useState("");
  const [baseModel, setBaseModel] = useState(FINETUNABLE_MODELS[0]);
  const [suffix, setSuffix] = useState("");

  const selected = examples.find((example) => example.id === selectedId) ?? null;
  const soupReady = isTauriHost && (soup.status === "ok" || soup.status === "vendored");
  const jobRunning = job !== null && !["succeeded", "failed", "cancelled"].includes(job.status);

  // Job em andamento: atualização automática periódica enquanto a aba está aberta.
  useEffect(() => {
    if (!jobRunning) return;
    const timer = window.setInterval(() => void refreshJob(), 20_000);
    return () => window.clearInterval(timer);
  }, [jobRunning]);

  // Sonda o soup ao abrir a aba no desktop — o "Treinar" reflete o estado real.
  useEffect(() => {
    if (isTauriHost && useTune.getState().soup.status === "unknown") void detectSoup();
  }, []);

  // Conversa acompanha a última mensagem (saídas de execução incluídas).
  useEffect(() => {
    const node = feedRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages.length, sending]);

  async function loadConfig() {
    if (!isTauriFs || !root.trim()) {
      setConfigNote("leitura real do soup.yaml requer o app desktop e a pasta definida");
      return;
    }
    try {
      useTune.setState({ configText: await fsRead(root.trim(), "soup.yaml") });
      setConfigNote("soup.yaml carregado do projeto");
    } catch {
      setConfigNote("soup.yaml não encontrado — rode o Init");
    }
  }

  async function saveConfig() {
    if (!isTauriFs || !root.trim()) return;
    try {
      await fsWrite(root.trim(), "soup.yaml", configText);
      setConfigNote("soup.yaml salvo no projeto");
    } catch (cause) {
      setConfigNote(cause instanceof Error ? cause.message : String(cause));
    }
  }

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
        <span className="chip accent" title="Init, dataset e treino na nuvem são internos do app — nada é instalado">
          interno
        </span>
        <button
          className="lg-button ghost"
          title="Gera o soup.yaml do template EMBUTIDO no app (sem binário externo)"
          onClick={() => void initInternal()}
        >
          <Wand2 size={13} />
          Init
        </button>
        <button
          className="lg-button ghost"
          disabled={!examples.length}
          onClick={() => downloadJsonl(examples)}
          title="Baixar dataset.jsonl (formato chat)"
        >
          <Download size={13} />
          JSONL
        </button>
        {soupReady && (
          <button
            className="lg-button ghost"
            disabled={busy}
            title={
              soup.status === "vendored"
                ? "Treino local com o soup EMBUTIDO (roda da cópia do app via Python) — pode levar horas"
                : "Treino local com o soup do PATH na sua GPU — pode levar horas"
            }
            onClick={() => {
              feed("**Treino local** — `soup train` é um treino real e pode levar muito tempo; a saída completa chega aqui na conversa ao concluir.");
              void runSoup("soup train");
            }}
          >
            <Cpu size={13} />
            {busy ? "Treinando…" : "Treinar local"}
          </button>
        )}
        <button
          className="lg-button primary"
          disabled={cloudBusy || !examples.length}
          title="Treino REAL na nuvem via API de fine-tuning (sua chave OpenAI) — nada instalado; exige ≥10 exemplos"
          onClick={() => void startCloudTraining(baseModel, suffix)}
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
                    kicker="FINE-TUNING · SOUP"
                    title="Um dataset. Um comando."
                    detail='Monte exemplos (sistema/usuário/assistente), exporte o JSONL e rode "soup train" — o soup cuida de LoRA, quantização e batch automaticamente.'
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
                {(busy || cloudBusy) && <span className="chip accent">rodando…</span>}
              </header>
              <div className="tunex-feed-scroll" ref={feedRef} aria-live="polite">
                {messages.length === 0 && (
                  <p className="tunex-feed-empty">
                    Comandos, saídas do soup e eventos do treino aparecem aqui como cartões — junto das respostas do
                    agente. Init → dataset → Treinar.
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
          ) : (
            <>
              <PanelTitle icon={<Cloud size={13} />} label="Treino na nuvem" meta="interno · API" />
              <div className="tunex-config">
                <p className="tunex-hint">
                  Fine-tuning REAL na infraestrutura do provedor com a sua chave — nada instalado. Exige ≥10 exemplos;
                  o modelo resultante entra no catálogo.
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
              <PanelTitle icon={<Cpu size={13} />} label="Config & hardware" meta="soup.yaml (acelerador local)" />
              <PanelScroll>
                <div className="tunex-config">
                  <div className="tunex-cfg-actions">
                    <button className="lg-button compact" onClick={() => void loadConfig()} disabled={!isTauriFs}>
                      <RefreshCw size={12} />
                      Carregar
                    </button>
                    <button className="lg-button compact" onClick={() => void saveConfig()} disabled={!isTauriFs || !configText}>
                      <Save size={12} />
                      Salvar
                    </button>
                    <button
                      className="lg-button compact"
                      disabled={busy}
                      title="nvidia-smi real — nome e VRAM da GPU"
                      onClick={() => void runSoup("nvidia-smi --query-gpu=name,memory.total --format=csv,noheader")}
                    >
                      <Cpu size={12} />
                      GPU
                    </button>
                  </div>
                  <textarea
                    className="tunex-yaml"
                    value={configText}
                    onChange={(event) => useTune.setState({ configText: event.target.value })}
                    placeholder={isTauriFs ? 'soup.yaml — carregue do projeto ou rode "Init"' : "edição real do soup.yaml requer o app desktop"}
                    spellCheck={false}
                  />
                  {configNote && <small className="tunex-note">{configNote}</small>}
                  <p className="tunex-hint">
                    Dica do Soup: GPUs pequenas treinam 8B com <code>stream_layers: true</code> (layer streaming BETA —
                    3,32 GB de pico numa RTX 3050 4 GB).
                  </p>
                </div>
              </PanelScroll>
            </>
          )}
        </VRight>
      </VBody>

      <VStatus>
        <span>
          <FlaskConical size={11} />{" "}
          {soup.status === "ok"
            ? `soup ${soup.version || "ok"}`
            : soup.status === "vendored"
              ? `soup embutido ${soup.version || "ok"}`
              : "soup embutido (fonte) · nuvem interna ativa"}
        </span>
        <span>{examples.length} exemplo{examples.length === 1 ? "" : "s"} no dataset</span>
        <span>
          <FolderOpen size={11} /> {root.trim() || "pasta não definida"}
        </span>
        <div className="spacer" />
        <span>{busy ? "comando em execução…" : sending ? stage || "gerando…" : "pronto"}</span>
      </VStatus>
    </Surface>
  );
}
