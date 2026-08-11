/**
 * Painel de Configurações V2 — modal com navegação lateral interna.
 * Seções: Conexão, Motores & Fusion, Provedores (BYOK), Memória,
 * Extensões, Runtime local e Aparência.
 *
 * Segurança: chaves de provedor vão direto ao keyring nativo via comando
 * Rust (`credential_store`) e nunca são gravadas em arquivo/localStorage,
 * nem exibidas de volta na interface.
 */
import "../styles/settings.css";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  UI_MODES,
  type EngineSelection,
  type ExtensionBundle,
  type FusionModeOverride,
  type FusionPreset,
  type FusionStrategy,
  type LanguageRuntime,
  type MemoryItem,
  type MemoryKind,
  type ModelTarget,
  type RuntimeStatus,
  type UiMode,
  type WorkspaceSummary
} from "@ai-orchestrator/contracts";
import {
  Brain,
  Check,
  Cpu,
  Download,
  FileText,
  FolderOpen,
  HardDriveDownload,
  Keyboard,
  KeyRound,
  LoaderCircle,
  LogIn,
  LogOut,
  Merge,
  Moon,
  Palette,
  Pencil,
  Play,
  Plug,
  Plus,
  Puzzle,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Sun,
  Trash2,
  TriangleAlert,
  Upload,
  X
} from "lucide-react";
import { byok, byokBackend, providerExtraHeaders } from "../lib/byok";
import { providerBaseUrls, resolveBaseUrl } from "../lib/engine";
import { extensions } from "../lib/extensions";
import { listWorkspaces } from "../lib/gateway";
import { memory, parseClaudeMemoryMarkdown, parseOpenAiMemoryExport } from "../lib/memory";
import { runtime } from "../lib/runtime";
import { terminal } from "../lib/terminal";
import { useApp, type CatalogModel } from "../lib/store";

const isTauriHost = "__TAURI_INTERNALS__" in window;

type SectionId = "conexao" | "motores" | "provedores" | "memoria" | "extensoes" | "runtime" | "aparencia";

type Notice = { text: string; tone: "ok" | "warn" | "danger" } | null;

const NAV: Array<{ id: SectionId; label: string; icon: typeof Plug }> = [
  { id: "conexao", label: "Conexão", icon: Plug },
  { id: "motores", label: "Motores & Fusion", icon: Merge },
  { id: "provedores", label: "Provedores (BYOK)", icon: KeyRound },
  { id: "memoria", label: "Memória", icon: Brain },
  { id: "extensoes", label: "Extensões", icon: Puzzle },
  { id: "runtime", label: "Runtime local", icon: Cpu },
  { id: "aparencia", label: "Aparência", icon: Palette }
];

const modeLabels: Record<UiMode, string> = {
  chat: "Chat",
  code: "Code",
  design: "Design",
  data: "Data",
  work: "Work",
  security: "Security",
  agent: "Agent",
  game: "Game Studio",
  tune: "Fine-Tuning"
};

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const formatBytes = (size: number) => {
  if (size >= 1_073_741_824) return `${(size / 1_073_741_824).toFixed(1)} GB`;
  if (size >= 1_048_576) return `${(size / 1_048_576).toFixed(1)} MB`;
  if (size >= 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${size} B`;
};

function NoticeLine({ notice }: { notice: Notice }) {
  if (!notice) return null;
  return <p className={`setx-notice ${notice.tone}`}>{notice.text}</p>;
}

function Section({ title, detail, children }: { title: string; detail: string; children: ReactNode }) {
  return (
    <section className="setx-section">
      <header>
        <h3>{title}</h3>
        <p>{detail}</p>
      </header>
      {children}
    </section>
  );
}

/* ------------------------------ 1. Conexão ------------------------------ */

function ConnectionSection() {
  const settings = useApp((state) => state.settings);
  const updateSettings = useApp((state) => state.updateSettings);
  const session = useApp((state) => state.session);
  const setSession = useApp((state) => state.setSession);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);

  const connected = Boolean(session?.accessToken && session.workspaceId);
  const workspaceName =
    workspaces.find((workspace) => workspace.id === session?.workspaceId)?.name ?? session?.workspaceId ?? "";

  function patchGateway(patch: Partial<typeof settings.gateway>) {
    updateSettings({ gateway: { ...settings.gateway, ...patch } });
  }

  async function login() {
    if (!isTauriHost) {
      setNotice({
        text: "O login OIDC exige o aplicativo desktop: o token fica no keyring nativo do Windows.",
        tone: "warn"
      });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const oidc = await invoke<{ accessToken: string }>("oidc_login", {
        gatewayBaseUrl: settings.gateway.baseUrl
      });
      const base = { baseUrl: settings.gateway.baseUrl, accessToken: oidc.accessToken };
      const list = await listWorkspaces(base);
      setWorkspaces(list);
      const workspaceId = settings.gateway.workspaceId || list[0]?.id || "";
      setSession({ ...base, workspaceId });
      patchGateway({ workspaceId });
      setNotice({
        text: workspaceId ? "Conectado ao gateway." : "Autenticado — selecione um workspace.",
        tone: "ok"
      });
    } catch (cause) {
      setNotice({ text: errorText(cause), tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    setBusy(true);
    try {
      if (isTauriHost) await invoke("oidc_logout", { gatewayBaseUrl: settings.gateway.baseUrl });
    } catch {
      // entrada ausente no keyring não impede o logout local
    }
    setSession(null);
    setWorkspaces([]);
    setNotice({ text: "Sessão encerrada.", tone: "ok" });
    setBusy(false);
  }

  function chooseWorkspace(workspaceId: string) {
    patchGateway({ workspaceId });
    if (session) setSession({ ...session, workspaceId });
  }

  return (
    <Section
      title="Conexão"
      detail="Endereço do gateway corporativo e autenticação OIDC. O token de acesso é guardado no keyring nativo, nunca em arquivo."
    >
      <div className="setx-card">
        <div className="setx-grid">
          <label className="lg-field">
            URL do gateway
            <input
              value={settings.gateway.baseUrl}
              onChange={(event) => patchGateway({ baseUrl: event.target.value.trim() })}
              placeholder="http://127.0.0.1:8787"
              spellCheck={false}
            />
          </label>
          <label className="lg-field">
            Workspace
            {workspaces.length > 0 ? (
              <select
                value={session?.workspaceId ?? settings.gateway.workspaceId}
                onChange={(event) => chooseWorkspace(event.target.value)}
              >
                {workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name} · {workspace.role}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={settings.gateway.workspaceId}
                onChange={(event) => patchGateway({ workspaceId: event.target.value.trim() })}
                placeholder="id do workspace"
                spellCheck={false}
              />
            )}
          </label>
        </div>
        <div className="setx-row">
          {connected ? (
            <>
              <span className="chip ok">
                <Server size={11} />
                conectado · {workspaceName || "workspace"}
              </span>
              <div className="spacer" style={{ flex: 1 }} />
              <button className="lg-button" onClick={() => void logout()} disabled={busy}>
                <LogOut size={13} />
                Sair
              </button>
            </>
          ) : (
            <>
              <span className="chip">desconectado</span>
              <div className="spacer" style={{ flex: 1 }} />
              <button className="lg-button primary" onClick={() => void login()} disabled={busy}>
                {busy ? <LoaderCircle className="spin" size={13} /> : <LogIn size={13} />}
                Entrar com OIDC
              </button>
            </>
          )}
        </div>
        <NoticeLine notice={notice} />
      </div>
    </Section>
  );
}

/* ------------------------- 2. Motores & Fusion -------------------------- */

const emptyTarget = (): ModelTarget => ({ providerId: "openai", model: "" });

function selectionValue(selection: EngineSelection): string {
  switch (selection.kind) {
    case "workspace":
      return "workspace";
    case "local":
      return "local";
    case "model":
      return "model";
    case "fusion":
      return `fusion:${selection.presetId}`;
  }
}

function EnginesSection() {
  const settings = useApp((state) => state.settings);
  const updateSettings = useApp((state) => state.updateSettings);
  const setEngine = useApp((state) => state.setEngine);
  const [draft, setDraft] = useState<FusionPreset | null>(null);

  function applyEngine(mode: UiMode, value: string) {
    const current = settings.engines[mode];
    if (value === "workspace") setEngine(mode, { kind: "workspace" });
    else if (value === "local") setEngine(mode, { kind: "local" });
    else if (value === "model")
      setEngine(mode, { kind: "model", target: current.kind === "model" ? current.target : emptyTarget() });
    else if (value.startsWith("fusion:")) setEngine(mode, { kind: "fusion", presetId: value.slice(7) });
  }

  function patchTarget(mode: UiMode, patch: Partial<ModelTarget>) {
    const current = settings.engines[mode];
    const target = current.kind === "model" ? current.target : emptyTarget();
    setEngine(mode, { kind: "model", target: { ...target, ...patch } });
  }

  function startCreate() {
    setDraft({
      id: `preset-${Date.now().toString(36)}`,
      name: "Novo preset",
      strategy: "orchestrate",
      orchestrator: { providerId: "anthropic", model: "claude-fable-5" },
      executors: [{ providerId: "openai", model: "gpt-5.6-luna" }],
      notes: ""
    });
  }

  function saveDraft() {
    if (!draft) return;
    const exists = settings.fusionPresets.some((preset) => preset.id === draft.id);
    const fusionPresets = exists
      ? settings.fusionPresets.map((preset) => (preset.id === draft.id ? draft : preset))
      : [...settings.fusionPresets, draft];
    updateSettings({ fusionPresets });
    setDraft(null);
  }

  function removePreset(id: string) {
    updateSettings({ fusionPresets: settings.fusionPresets.filter((preset) => preset.id !== id) });
    if (draft?.id === id) setDraft(null);
  }

  const draftValid = Boolean(
    draft &&
      draft.name.trim() &&
      draft.orchestrator.model.trim() &&
      draft.executors.length > 0 &&
      draft.executors.every((executor) => executor.model.trim())
  );

  return (
    <Section
      title="Motores & Fusion"
      detail="Defina qual motor responde em cada aba — rota do workspace, runtime local, um preset de fusion ou um modelo direto (BYOK)."
    >
      <div className="setx-card">
        <div className="setx-card-title">
          <Server size={13} />
          Motor por aba
        </div>
        {UI_MODES.map((mode) => {
          const selection = settings.engines[mode];
          return (
            <div className="setx-engine" key={mode}>
              <strong>{modeLabels[mode]}</strong>
              <label className="lg-field">
                <select value={selectionValue(selection)} onChange={(event) => applyEngine(mode, event.target.value)}>
                  <option value="workspace">Rota do workspace (gateway)</option>
                  <option value="local">Runtime local</option>
                  {settings.fusionPresets.map((preset) => (
                    <option key={preset.id} value={`fusion:${preset.id}`}>
                      Fusion · {preset.name}
                    </option>
                  ))}
                  <option value="model">Modelo direto (BYOK)</option>
                </select>
              </label>
              {selection.kind === "model" && (
                <div className="setx-engine-extra">
                  <label className="lg-field">
                    Provedor
                    <input
                      value={selection.target.providerId}
                      onChange={(event) => patchTarget(mode, { providerId: event.target.value.trim() })}
                      placeholder="openai, moonshot…"
                      spellCheck={false}
                    />
                  </label>
                  <label className="lg-field">
                    Modelo
                    <input
                      value={selection.target.model}
                      onChange={(event) => patchTarget(mode, { model: event.target.value.trim() })}
                      placeholder="nome do modelo"
                      spellCheck={false}
                      list="setx-model-catalog"
                    />
                  </label>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <ModelCatalogCard />

      <div className="setx-card">
        <div className="setx-card-title">
          <Merge size={13} />
          Presets de fusion
          <small>{settings.fusionPresets.length} preset(s)</small>
          <div style={{ flex: 1 }} />
          <button className="lg-button" onClick={startCreate}>
            <Plus size={13} />
            Novo preset
          </button>
        </div>
        {settings.fusionPresets.length === 0 && <p className="setx-empty">Nenhum preset — crie o primeiro.</p>}
        {settings.fusionPresets.map((preset) => (
          <div className="setx-item" key={preset.id}>
            <div className="setx-item-head">
              <span className="grow">{preset.name}</span>
              <span className="chip accent">{preset.strategy}</span>
              <small>
                {preset.orchestrator.model} → {preset.executors.length} executor(es)
              </small>
              <button className="icon-button" onClick={() => setDraft({ ...preset, executors: preset.executors.map((executor) => ({ ...executor })) })} aria-label={`Editar ${preset.name}`}>
                <Pencil size={13} />
              </button>
              <button className="icon-button" onClick={() => removePreset(preset.id)} aria-label={`Excluir ${preset.name}`}>
                <Trash2 size={13} />
              </button>
            </div>
            {preset.notes && <p className="setx-item-body">{preset.notes}</p>}
          </div>
        ))}

        {draft && (
          <div className="setx-item">
            <div className="setx-grid">
              <label className="lg-field">
                Nome
                <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
              </label>
              <label className="lg-field">
                Estratégia
                <select
                  value={draft.strategy}
                  onChange={(event) => setDraft({ ...draft, strategy: event.target.value as FusionStrategy })}
                >
                  <option value="orchestrate">orchestrate — planeja, executa e revisa</option>
                  <option value="merge">merge — executa em paralelo e funde</option>
                  <option value="race">race — primeiro a responder vence</option>
                </select>
              </label>
            </div>
            <div className="setx-grid">
              <label className="lg-field">
                Orquestrador · provedor
                <input
                  value={draft.orchestrator.providerId}
                  onChange={(event) =>
                    setDraft({ ...draft, orchestrator: { ...draft.orchestrator, providerId: event.target.value.trim() } })
                  }
                  spellCheck={false}
                />
              </label>
              <label className="lg-field">
                Orquestrador · modelo
                <input
                  value={draft.orchestrator.model}
                  onChange={(event) =>
                    setDraft({ ...draft, orchestrator: { ...draft.orchestrator, model: event.target.value.trim() } })
                  }
                  spellCheck={false}
                  list="setx-model-catalog"
                />
              </label>
            </div>
            {draft.executors.map((executor, index) => (
              <div className="setx-exec" key={index}>
                <label className="lg-field">
                  Executor {index + 1} · provedor
                  <input
                    value={executor.providerId}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        executors: draft.executors.map((item, i) =>
                          i === index ? { ...item, providerId: event.target.value.trim() } : item
                        )
                      })
                    }
                    spellCheck={false}
                  />
                </label>
                <label className="lg-field">
                  Executor {index + 1} · modelo
                  <input
                    value={executor.model}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        executors: draft.executors.map((item, i) =>
                          i === index ? { ...item, model: event.target.value.trim() } : item
                        )
                      })
                    }
                    spellCheck={false}
                    list="setx-model-catalog"
                  />
                </label>
                <button
                  className="icon-button"
                  disabled={draft.executors.length <= 1}
                  onClick={() => setDraft({ ...draft, executors: draft.executors.filter((_, i) => i !== index) })}
                  aria-label={`Remover executor ${index + 1}`}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
            <div className="setx-permode">
              <span className="eyebrow">MODELOS POR ATIVIDADE (OPCIONAL)</span>
              <p className="setx-hint">
                Defina modelos específicos por aba — ex.: Code com um orquestrador mais forte. Em branco, a aba usa o
                preset base acima.
              </p>
              {UI_MODES.map((activity) => {
                const override = draft.perMode?.[activity];
                const patchMode = (patch: FusionModeOverride | undefined) => {
                  const perMode = { ...(draft.perMode ?? {}) };
                  if (patch && (patch.orchestrator || patch.executors?.length)) perMode[activity] = patch;
                  else delete perMode[activity];
                  setDraft({ ...draft, perMode: Object.keys(perMode).length ? perMode : undefined });
                };
                const asKey = (target?: ModelTarget) => (target ? `${target.providerId}/${target.model}` : "");
                const fromKey = (key: string): ModelTarget | undefined => {
                  const entry = settings.modelCatalog.find((item) => `${item.providerId}/${item.model}` === key);
                  return entry ? { providerId: entry.providerId, model: entry.model } : undefined;
                };
                return (
                  <div className="setx-permode-row" key={activity}>
                    <strong>{modeLabels[activity]}</strong>
                    <select
                      aria-label={`Orquestrador de ${modeLabels[activity]}`}
                      value={asKey(override?.orchestrator)}
                      onChange={(event) =>
                        patchMode({ ...override, orchestrator: fromKey(event.target.value) })
                      }
                    >
                      <option value="">orquestrador — usar o preset base</option>
                      {settings.modelCatalog.map((entry) => (
                        <option key={`o-${entry.providerId}/${entry.model}`} value={`${entry.providerId}/${entry.model}`}>
                          {entry.label ?? entry.model} · {entry.providerId}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label={`Executor de ${modeLabels[activity]}`}
                      value={asKey(override?.executors?.[0])}
                      onChange={(event) => {
                        const target = fromKey(event.target.value);
                        patchMode({ ...override, executors: target ? [target] : undefined });
                      }}
                    >
                      <option value="">executor — usar o preset base</option>
                      {settings.modelCatalog.map((entry) => (
                        <option key={`e-${entry.providerId}/${entry.model}`} value={`${entry.providerId}/${entry.model}`}>
                          {entry.label ?? entry.model} · {entry.providerId}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>
            <label className="lg-field">
              Notas (opcional)
              <input
                value={draft.notes ?? ""}
                onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
                placeholder="quando usar este preset"
              />
            </label>
            <div className="setx-actions">
              <button
                className="lg-button ghost"
                onClick={() => setDraft({ ...draft, executors: [...draft.executors, emptyTarget()] })}
              >
                <Plus size={13} />
                Executor
              </button>
              <button className="lg-button ghost" onClick={() => setDraft(null)}>
                <X size={13} />
                Cancelar
              </button>
              <button className="lg-button primary" disabled={!draftValid} onClick={saveDraft}>
                <Check size={13} />
                Salvar preset
              </button>
            </div>
          </div>
        )}
      </div>
    </Section>
  );
}

/* --------------------- 2b. Catálogo de modelos (admin) ------------------ */

const CATALOG_PROVIDERS = ["anthropic", "openai", "moonshot", "deepseek", "mistral", "openrouter"];

function ModelCatalogCard() {
  const settings = useApp((state) => state.settings);
  const updateSettings = useApp((state) => state.updateSettings);
  const [form, setForm] = useState<CatalogModel>({ providerId: "anthropic", model: "", label: "" });

  function addModel() {
    const model = form.model.trim();
    const providerId = form.providerId.trim();
    if (!model || !providerId) return;
    const withoutDuplicate = settings.modelCatalog.filter(
      (entry) => !(entry.providerId === providerId && entry.model === model)
    );
    updateSettings({
      modelCatalog: [...withoutDuplicate, { providerId, model, label: form.label?.trim() || undefined }]
    });
    setForm({ providerId, model: "", label: "" });
  }

  function removeModel(entry: CatalogModel) {
    updateSettings({
      modelCatalog: settings.modelCatalog.filter(
        (item) => !(item.providerId === entry.providerId && item.model === entry.model)
      )
    });
  }

  return (
    <div className="setx-card">
      <div className="setx-card-title">
        <Sparkles size={13} />
        Catálogo de modelos
        <small>{settings.modelCatalog.length} modelo(s) habilitado(s)</small>
      </div>
      <p className="setx-hint">
        Modelos listados aqui aparecem no seletor do composer e como sugestão nos presets de fusion. A API não muda:
        a chamada continua pelo provedor configurado (chave no keyring, Anthropic via camada compatível OpenAI).
      </p>
      {settings.modelCatalog.map((entry) => (
        <div className="setx-item" key={`${entry.providerId}/${entry.model}`}>
          <div className="setx-item-head">
            <span className="grow">{entry.label ?? entry.model}</span>
            <code className="setx-code">{entry.model}</code>
            <span className="chip">{entry.providerId}</span>
            <button
              className="icon-button"
              onClick={() => removeModel(entry)}
              aria-label={`Remover ${entry.model} do catálogo`}
            >
              <Trash2 size={13} />
            </button>
          </div>
        </div>
      ))}
      <div className="setx-grid setx-catalog-form">
        <label className="lg-field">
          Provedor
          <select
            value={CATALOG_PROVIDERS.includes(form.providerId) ? form.providerId : "outro"}
            onChange={(event) =>
              setForm({ ...form, providerId: event.target.value === "outro" ? "" : event.target.value })
            }
          >
            {CATALOG_PROVIDERS.map((provider) => (
              <option key={provider} value={provider}>
                {provider}
              </option>
            ))}
            <option value="outro">outro…</option>
          </select>
        </label>
        {!CATALOG_PROVIDERS.includes(form.providerId) && (
          <label className="lg-field">
            Provedor (id)
            <input
              value={form.providerId}
              onChange={(event) => setForm({ ...form, providerId: event.target.value.trim() })}
              placeholder="id do provedor"
              spellCheck={false}
            />
          </label>
        )}
        <label className="lg-field">
          ID do modelo
          <input
            value={form.model}
            onChange={(event) => setForm({ ...form, model: event.target.value })}
            placeholder="ex.: claude-sonnet-5"
            spellCheck={false}
            onKeyDown={(event) => {
              if (event.key === "Enter") addModel();
            }}
          />
        </label>
        <label className="lg-field">
          Rótulo (opcional)
          <input
            value={form.label ?? ""}
            onChange={(event) => setForm({ ...form, label: event.target.value })}
            placeholder="nome exibido"
          />
        </label>
        <button className="lg-button primary setx-catalog-add" disabled={!form.model.trim() || !form.providerId.trim()} onClick={addModel}>
          <Plus size={13} />
          Adicionar
        </button>
      </div>
      <datalist id="setx-model-catalog">
        {settings.modelCatalog.map((entry) => (
          <option key={`${entry.providerId}/${entry.model}`} value={entry.model}>
            {(entry.label ?? entry.model) + " · " + entry.providerId}
          </option>
        ))}
      </datalist>
    </div>
  );
}

/* -------------------------- 3. Provedores (BYOK) ------------------------ */

const COMPATIBLE_PROVIDERS = [
  { id: "deepseek", label: "DeepSeek" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "mistral", label: "Mistral" },
  { id: "moonshot", label: "Moonshot (Kimi)" },
  { id: "custom", label: "Custom (OpenAI-compatible)" }
] as const;

/** Teste REAL de conexão: GET {base}/models com a chave. No desktop (keyring),
 *  o JS não lê a chave — o teste vira verificação de presença no keyring. */
async function testProviderConnection(
  providerId: string,
  overrides: Record<string, string>
): Promise<{ ok: boolean; text: string }> {
  if (isTauriHost) {
    try {
      await invoke<string>("credential_read", { account: `provider:${providerId}` });
      return { ok: true, text: `Chave presente no keyring para ${providerId}. A validação online ocorre na primeira chamada.` };
    } catch {
      return { ok: false, text: `Nenhuma chave salva para ${providerId}.` };
    }
  }
  const key = await byok.readForWebCall(providerId);
  if (!key) return { ok: false, text: `Nenhuma chave salva para ${providerId} neste navegador.` };
  const base = resolveBaseUrl(providerId, overrides);
  if (!base) return { ok: false, text: "Defina a base URL do provedor." };
  try {
    const response = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${key}`, ...providerExtraHeaders(providerId) }
    });
    if (!response.ok) return { ok: false, text: `${providerId} respondeu HTTP ${response.status} — confira a chave.` };
    const payload = (await response.json().catch(() => null)) as { data?: unknown[] } | null;
    const count = Array.isArray(payload?.data) ? payload.data.length : undefined;
    return { ok: true, text: `Conexão OK com ${providerId}${count ? ` — ${count} modelos disponíveis` : ""}.` };
  } catch {
    return { ok: false, text: `Falha de rede/CORS ao contatar ${providerId}. No app desktop a chamada não depende de CORS.` };
  }
}

function ProviderKeyCard({ providerId, label, hint }: { providerId: string; label: string; hint: string }) {
  const settings = useApp((state) => state.settings);
  const [token, setToken] = useState("");
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  useEffect(() => {
    let mounted = true;
    void byok.has(providerId).then((has) => {
      if (mounted) setConfigured(has);
    });
    return () => {
      mounted = false;
    };
  }, [providerId]);

  async function run(action: () => Promise<Notice>) {
    setBusy(true);
    setNotice(null);
    try {
      setNotice(await action());
      setConfigured(await byok.has(providerId));
    } catch (cause) {
      setNotice({ text: errorText(cause), tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="setx-card">
      <div className="setx-card-title">
        <KeyRound size={13} />
        {label}
        <span className={`chip ${configured ? "ok" : ""}`}>{configured == null ? "…" : configured ? "chave configurada" : "não configurada"}</span>
        <small>{hint}</small>
      </div>
      <div className="setx-grid">
        <label className="lg-field">
          Chave da API
          <input
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="cole a chave (não é exibida depois)"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
      </div>
      <div className="setx-actions">
        <button
          className="lg-button ghost"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const result = await testProviderConnection(providerId, settings.providerBaseOverrides);
              return { text: result.text, tone: result.ok ? "ok" : "warn" };
            })
          }
        >
          <ShieldCheck size={13} />
          Testar conexão
        </button>
        <button
          className="lg-button ghost"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await byok.clear(providerId);
              return { text: `Chave de ${label} removida.`, tone: "ok" };
            })
          }
        >
          <Trash2 size={13} />
          Remover
        </button>
        <button
          className="lg-button primary"
          disabled={busy || !token.trim()}
          onClick={() =>
            void run(async () => {
              await byok.set(providerId, token);
              setToken("");
              return {
                text:
                  byokBackend === "keyring"
                    ? `Chave de ${label} salva no keyring do Windows.`
                    : `Chave de ${label} salva neste navegador (localStorage). Prefira o app desktop para uso contínuo.`,
                tone: "ok"
              };
            })
          }
        >
          {busy ? <LoaderCircle className="spin" size={13} /> : <KeyRound size={13} />}
          Salvar chave
        </button>
      </div>
      <NoticeLine notice={notice} />
    </div>
  );
}

function CompatibleProvidersCard() {
  const settings = useApp((state) => state.settings);
  const updateSettings = useApp((state) => state.updateSettings);
  const [providerId, setProviderId] = useState<string>("deepseek");
  const [customId, setCustomId] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [configured, setConfigured] = useState(false);

  const effectiveId = providerId === "custom" ? customId.trim() : providerId;
  const baseOverride = settings.providerBaseOverrides[effectiveId] ?? "";
  const defaultBase = providerBaseUrls[effectiveId] ?? "";

  useEffect(() => {
    if (!effectiveId) {
      setConfigured(false);
      return;
    }
    let mounted = true;
    void byok.has(effectiveId).then((has) => {
      if (mounted) setConfigured(has);
    });
    return () => {
      mounted = false;
    };
  }, [effectiveId]);

  function setBase(value: string) {
    const overrides = { ...settings.providerBaseOverrides };
    if (value.trim()) overrides[effectiveId] = value.trim();
    else delete overrides[effectiveId];
    updateSettings({ providerBaseOverrides: overrides });
  }

  async function run(action: () => Promise<Notice>) {
    if (!effectiveId) return;
    setBusy(true);
    setNotice(null);
    try {
      setNotice(await action());
      setConfigured(await byok.has(effectiveId));
    } catch (cause) {
      setNotice({ text: errorText(cause), tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="setx-card">
      <div className="setx-card-title">
        <Server size={13} />
        Compatíveis OpenAI (DeepSeek, OpenRouter, Mistral, Moonshot, custom)
        <span className={`chip ${configured ? "ok" : ""}`}>{configured ? "chave configurada" : "não configurada"}</span>
      </div>
      <p className="setx-hint">
        Qualquer endpoint que fale o protocolo /chat/completions. Para self-hosted ou proxy, escolha "Custom" e informe
        a base URL (ex.: http://localhost:8000/v1).
      </p>
      <div className="setx-grid">
        <label className="lg-field">
          Provedor
          <select value={providerId} onChange={(event) => setProviderId(event.target.value)}>
            {COMPATIBLE_PROVIDERS.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.label}
              </option>
            ))}
          </select>
        </label>
        {providerId === "custom" && (
          <label className="lg-field">
            Identificador
            <input
              value={customId}
              onChange={(event) => setCustomId(event.target.value)}
              placeholder="meu-endpoint"
              spellCheck={false}
            />
          </label>
        )}
        <label className="lg-field">
          Base URL {defaultBase ? "(opcional — sobrescreve o padrão)" : "(obrigatória para custom)"}
          <input
            value={baseOverride}
            onChange={(event) => setBase(event.target.value)}
            placeholder={defaultBase || "https://host/v1"}
            spellCheck={false}
            disabled={!effectiveId}
          />
        </label>
        <label className="lg-field">
          Chave da API
          <input
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="cole a chave (não é exibida depois)"
            autoComplete="off"
            spellCheck={false}
            disabled={!effectiveId}
          />
        </label>
      </div>
      <div className="setx-actions">
        <button
          className="lg-button ghost"
          disabled={busy || !effectiveId}
          onClick={() =>
            void run(async () => {
              const result = await testProviderConnection(effectiveId, settings.providerBaseOverrides);
              return { text: result.text, tone: result.ok ? "ok" : "warn" };
            })
          }
        >
          <ShieldCheck size={13} />
          Testar conexão
        </button>
        <button
          className="lg-button ghost"
          disabled={busy || !effectiveId}
          onClick={() =>
            void run(async () => {
              await byok.clear(effectiveId);
              return { text: `Chave de ${effectiveId} removida.`, tone: "ok" };
            })
          }
        >
          <Trash2 size={13} />
          Remover
        </button>
        <button
          className="lg-button primary"
          disabled={busy || !effectiveId || !token.trim()}
          onClick={() =>
            void run(async () => {
              await byok.set(effectiveId, token);
              setToken("");
              return {
                text:
                  byokBackend === "keyring"
                    ? `Chave de ${effectiveId} salva no keyring do Windows.`
                    : `Chave de ${effectiveId} salva neste navegador (localStorage).`,
                tone: "ok"
              };
            })
          }
        >
          {busy ? <LoaderCircle className="spin" size={13} /> : <KeyRound size={13} />}
          Salvar chave
        </button>
      </div>
      <NoticeLine notice={notice} />
    </div>
  );
}

function ProvidersSection() {
  return (
    <Section
      title="Provedores (BYOK)"
      detail="Traga sua própria chave por provedor. No app desktop ela vai direto ao keyring nativo do Windows; no navegador fica no armazenamento local deste perfil (com aviso). Política Multiplike: gestão e rotação das chaves no cofre corporativo (Vaultwarden) — cole aqui apenas para uso local, nunca no chat."
    >
      {!isTauriHost && (
        <p className="setx-notice warn">
          Você está no navegador: a chave será salva em localStorage deste perfil e as chamadas saem direto do navegador
          (sujeitas a CORS do provedor). Para keyring nativo e chamadas sem CORS, use o aplicativo desktop.
        </p>
      )}
      <ProviderKeyCard providerId="openai" label="OpenAI" hint="platform.openai.com · GPT" />
      <ProviderKeyCard providerId="anthropic" label="Anthropic" hint="console.anthropic.com · Claude (camada compatível OpenAI)" />
      <CompatibleProvidersCard />
    </Section>
  );
}

/* ------------------------------ 4. Memória ------------------------------ */

const MEMORY_KINDS: MemoryKind[] = ["fact", "preference", "project", "decision", "reference"];

function MemorySection() {
  const settings = useApp((state) => state.settings);
  const updateSettings = useApp((state) => state.updateSettings);
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [edit, setEdit] = useState({ title: "", content: "", importance: 3 });
  const [create, setCreate] = useState<{ kind: MemoryKind; title: string; content: string; importance: number } | null>(
    null
  );
  const jsonRef = useRef<HTMLInputElement>(null);
  const claudeRef = useRef<HTMLInputElement>(null);

  async function reload() {
    try {
      setItems(await memory.list());
    } catch (cause) {
      setNotice({ text: errorText(cause), tone: "danger" });
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return items;
    return items.filter((item) =>
      `${item.title} ${item.content} ${item.tags.join(" ")}`.toLowerCase().includes(term)
    );
  }, [items, query]);

  async function saveEdit(item: MemoryItem) {
    if (!edit.title.trim()) return;
    try {
      await memory.update({ ...item, title: edit.title.trim(), content: edit.content, importance: edit.importance });
      setEditId(null);
      await reload();
    } catch (cause) {
      setNotice({ text: errorText(cause), tone: "danger" });
    }
  }

  async function removeItem(id: string) {
    try {
      await memory.remove(id);
      await reload();
    } catch (cause) {
      setNotice({ text: errorText(cause), tone: "danger" });
    }
  }

  async function saveCreate() {
    if (!create || !create.title.trim() || !create.content.trim()) return;
    try {
      await memory.add({
        kind: create.kind,
        title: create.title.trim(),
        content: create.content.trim(),
        importance: create.importance,
        source: "manual"
      });
      setCreate(null);
      await reload();
    } catch (cause) {
      setNotice({ text: errorText(cause), tone: "danger" });
    }
  }

  async function exportJson() {
    try {
      const json = await memory.exportJson();
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "memories.json";
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setNotice({ text: errorText(cause), tone: "danger" });
    }
  }

  async function importJsonFile(file: File) {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      let rows: unknown[] = [];
      if (Array.isArray(parsed)) rows = parsed;
      else if (parsed && typeof parsed === "object") {
        const record = parsed as Record<string, unknown>;
        if (Array.isArray(record.memories)) rows = record.memories;
        else if (Array.isArray(record.items)) rows = record.items;
      }
      const ownShape = rows.some(
        (row) =>
          Boolean(row) &&
          typeof row === "object" &&
          "title" in (row as Record<string, unknown>) &&
          "content" in (row as Record<string, unknown>)
      );
      let imported = 0;
      if (ownShape) {
        imported = await memory.importJson(text);
      } else {
        for (const input of parseOpenAiMemoryExport(text)) {
          await memory.add(input);
          imported += 1;
        }
      }
      setNotice({ text: `${imported} memória(s) importada(s) de ${file.name}.`, tone: "ok" });
      await reload();
    } catch (cause) {
      setNotice({ text: `Import falhou: ${errorText(cause)}`, tone: "danger" });
    }
  }

  async function importClaudeFiles(files: File[]) {
    try {
      let imported = 0;
      for (const file of files) {
        for (const input of parseClaudeMemoryMarkdown(file.name, await file.text())) {
          await memory.add(input);
          imported += 1;
        }
      }
      setNotice({ text: `${imported} memória(s) importada(s) do Claude (${files.length} arquivo(s)).`, tone: "ok" });
      await reload();
    } catch (cause) {
      setNotice({ text: `Import falhou: ${errorText(cause)}`, tone: "danger" });
    }
  }

  return (
    <Section
      title="Memória"
      detail="Memórias persistentes sobrevivem à troca de fornecedor: no desktop ficam em SQLite, no navegador em IndexedDB. São injetadas como contexto em qualquer motor."
    >
      <div className="setx-card">
        <div className="setx-row">
          <button
            className={`lg-toggle ${settings.memoryEnabled ? "on" : ""}`}
            onClick={() => updateSettings({ memoryEnabled: !settings.memoryEnabled })}
          >
            <i />
            Memória ativa
          </button>
          <label className="lg-field" style={{ flex: 1, minWidth: 180 }}>
            Recall K — memórias por resposta ({settings.memoryRecallK})
            <input
              type="range"
              min={2}
              max={12}
              step={1}
              value={settings.memoryRecallK}
              onChange={(event) => updateSettings({ memoryRecallK: Number(event.target.value) })}
            />
          </label>
        </div>
        <div className="setx-actions">
          <button className="lg-button ghost" onClick={() => void exportJson()}>
            <Download size={13} />
            Exportar JSON
          </button>
          <button className="lg-button ghost" onClick={() => jsonRef.current?.click()}>
            <Upload size={13} />
            Importar JSON / OpenAI
          </button>
          <button className="lg-button ghost" onClick={() => claudeRef.current?.click()}>
            <FileText size={13} />
            Importar Claude (.md)
          </button>
          <button
            className="lg-button"
            onClick={() => setCreate({ kind: "fact", title: "", content: "", importance: 3 })}
          >
            <Plus size={13} />
            Nova memória
          </button>
        </div>
        <input
          ref={jsonRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void importJsonFile(file);
          }}
        />
        <input
          ref={claudeRef}
          type="file"
          accept=".md,text/markdown"
          multiple
          hidden
          onChange={(event) => {
            const files = event.target.files ? Array.from(event.target.files) : [];
            event.target.value = "";
            if (files.length) void importClaudeFiles(files);
          }}
        />
        <NoticeLine notice={notice} />
      </div>

      {create && (
        <div className="setx-card">
          <div className="setx-card-title">
            <Plus size={13} />
            Nova memória
          </div>
          <div className="setx-grid">
            <label className="lg-field">
              Título
              <input value={create.title} onChange={(event) => setCreate({ ...create, title: event.target.value })} />
            </label>
            <label className="lg-field">
              Tipo
              <select
                value={create.kind}
                onChange={(event) => setCreate({ ...create, kind: event.target.value as MemoryKind })}
              >
                {MEMORY_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {kind}
                  </option>
                ))}
              </select>
            </label>
            <label className="lg-field">
              Importância ({create.importance})
              <input
                type="range"
                min={1}
                max={5}
                step={1}
                value={create.importance}
                onChange={(event) => setCreate({ ...create, importance: Number(event.target.value) })}
              />
            </label>
          </div>
          <label className="lg-field">
            Conteúdo
            <textarea
              rows={3}
              value={create.content}
              onChange={(event) => setCreate({ ...create, content: event.target.value })}
            />
          </label>
          <div className="setx-actions">
            <button className="lg-button ghost" onClick={() => setCreate(null)}>
              <X size={13} />
              Cancelar
            </button>
            <button
              className="lg-button primary"
              disabled={!create.title.trim() || !create.content.trim()}
              onClick={() => void saveCreate()}
            >
              <Check size={13} />
              Salvar
            </button>
          </div>
        </div>
      )}

      <div className="setx-card">
        <div className="setx-card-title">
          <Brain size={13} />
          Memórias
          <small>
            {filtered.length} de {items.length}
          </small>
        </div>
        <label className="lg-field">
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <Search size={11} />
            Buscar
          </span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="título, conteúdo ou tag…"
          />
        </label>
        {filtered.length === 0 && <p className="setx-empty">Nenhuma memória encontrada.</p>}
        {filtered.map((item) =>
          editId === item.id ? (
            <div className="setx-item" key={item.id}>
              <div className="setx-grid">
                <label className="lg-field">
                  Título
                  <input value={edit.title} onChange={(event) => setEdit({ ...edit, title: event.target.value })} />
                </label>
                <label className="lg-field">
                  Importância ({edit.importance})
                  <input
                    type="range"
                    min={1}
                    max={5}
                    step={1}
                    value={edit.importance}
                    onChange={(event) => setEdit({ ...edit, importance: Number(event.target.value) })}
                  />
                </label>
              </div>
              <label className="lg-field">
                Conteúdo
                <textarea
                  rows={3}
                  value={edit.content}
                  onChange={(event) => setEdit({ ...edit, content: event.target.value })}
                />
              </label>
              <div className="setx-actions">
                <button className="lg-button ghost" onClick={() => setEditId(null)}>
                  <X size={13} />
                  Cancelar
                </button>
                <button className="lg-button primary" disabled={!edit.title.trim()} onClick={() => void saveEdit(item)}>
                  <Check size={13} />
                  Salvar
                </button>
              </div>
            </div>
          ) : (
            <div className="setx-item" key={item.id}>
              <div className="setx-item-head">
                <span className="grow">{item.title}</span>
                <span className="chip">{item.kind}</span>
                <small>
                  imp {item.importance} · {item.source}
                </small>
                <button
                  className="icon-button"
                  onClick={() => {
                    setEditId(item.id);
                    setEdit({ title: item.title, content: item.content, importance: item.importance });
                  }}
                  aria-label={`Editar ${item.title}`}
                >
                  <Pencil size={13} />
                </button>
                <button className="icon-button" onClick={() => void removeItem(item.id)} aria-label={`Excluir ${item.title}`}>
                  <Trash2 size={13} />
                </button>
              </div>
              <p className="setx-item-body">{item.content}</p>
            </div>
          )
        )}
      </div>
    </Section>
  );
}

/* ----------------------------- 5. Extensões ----------------------------- */

const demoBundle = (path: string): ExtensionBundle => ({
  name: path.split(/[\\/]/).filter(Boolean).at(-1) ?? "extensao-demo",
  format: "agent-skill",
  version: "0.0.0",
  sourcePath: path || "C:/exemplo/skill",
  skills: ["exemplo"],
  agents: [],
  artifacts: [],
  hasMcp: false,
  compatible: true,
  warnings: ["Modo demonstração no navegador — nada foi lido do disco. Importar exige o desktop."]
});

function ExtensionsSection() {
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [bundle, setBundle] = useState<ExtensionBundle | null>(null);
  const [installed, setInstalled] = useState<ExtensionBundle[]>([]);
  const [notice, setNotice] = useState<Notice>(null);

  useEffect(() => {
    if (!isTauriHost) return;
    extensions
      .list()
      .then(setInstalled)
      .catch(() => undefined);
  }, []);

  async function inspect() {
    if (!path.trim()) return;
    setBusy(true);
    setNotice(null);
    try {
      if (!isTauriHost) {
        setBundle(demoBundle(path.trim()));
        return;
      }
      setBundle(await extensions.inspect(path.trim()));
    } catch (cause) {
      setBundle(null);
      setNotice({ text: errorText(cause), tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  async function importBundle() {
    if (!path.trim()) return;
    if (!isTauriHost) {
      setNotice({ text: "Importar extensões exige o aplicativo desktop.", tone: "warn" });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const result = await extensions.import(path.trim());
      setBundle(result);
      setNotice({ text: `Extensão "${result.name}" importada.`, tone: "ok" });
      setInstalled(await extensions.list().catch(() => installed));
    } catch (cause) {
      setNotice({ text: errorText(cause), tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  function bundleView(item: ExtensionBundle, key: string) {
    return (
      <div className="setx-item" key={key}>
        <div className="setx-item-head">
          <span className="grow">{item.name}</span>
          <span className="chip accent">{item.format}</span>
          <span className={`chip ${item.compatible ? "ok" : "danger"}`}>
            {item.compatible ? "compatível" : "incompatível"}
          </span>
          {item.hasMcp && <span className="chip warn">MCP</span>}
          <small>
            {item.skills.length} skill(s) · {item.agents.length} agente(s) · {item.artifacts.length} artefato(s)
          </small>
        </div>
        {item.warnings.length > 0 && (
          <ul className="setx-warns">
            {item.warnings.map((warning) => (
              <li key={warning}>
                <TriangleAlert size={11} />
                {warning}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  return (
    <Section
      title="Extensões"
      detail="Importe plugins e skills nos formatos OpenAI/Codex, Anthropic/Claude e Agent Skills. Inspecione antes de importar para ver avisos de compatibilidade."
    >
      <div className="setx-card">
        <label className="lg-field">
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <FolderOpen size={11} />
            Pasta da extensão
          </span>
          <input
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="C:\\extensoes\\minha-skill"
            spellCheck={false}
          />
        </label>
        <div className="setx-actions">
          <button className="lg-button ghost" onClick={() => void inspect()} disabled={!path.trim() || busy}>
            <Search size={13} />
            Inspecionar
          </button>
          <button className="lg-button primary" onClick={() => void importBundle()} disabled={!path.trim() || busy}>
            {busy ? <LoaderCircle className="spin" size={13} /> : <Puzzle size={13} />}
            Importar
          </button>
        </div>
        <NoticeLine notice={notice} />
        {bundle && bundleView(bundle, `inspect-${bundle.sourcePath}`)}
      </div>

      <div className="setx-card">
        <div className="setx-card-title">
          <Puzzle size={13} />
          Instaladas
          <small>{installed.length} extensão(ões)</small>
        </div>
        {installed.length === 0 && (
          <p className="setx-empty">
            {isTauriHost ? "Nenhuma extensão instalada ainda." : "Lista disponível apenas no desktop."}
          </p>
        )}
        {installed.map((item, index) => bundleView(item, `${item.sourcePath}-${index}`))}
      </div>
    </Section>
  );
}

/* --------------------------- 6. Runtime local --------------------------- */

function RuntimeSection() {
  const runtimeStatus = useApp((state) => state.runtimeStatus);
  const setRuntimeStatus = useApp((state) => state.setRuntimeStatus);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [startModel, setStartModel] = useState("");
  const [modelForm, setModelForm] = useState({ id: "", url: "", sha256: "" });

  useEffect(() => {
    if (!isTauriHost) return;
    runtime
      .status()
      .then(setRuntimeStatus)
      .catch(() => undefined);
  }, [setRuntimeStatus]);

  async function run(action: string, task: () => Promise<RuntimeStatus>) {
    if (!isTauriHost) {
      setNotice({ text: "Ações do runtime local exigem o aplicativo desktop.", tone: "warn" });
      return;
    }
    setBusy(action);
    setNotice(null);
    try {
      setRuntimeStatus(await task());
    } catch (cause) {
      setNotice({ text: errorText(cause), tone: "danger" });
    } finally {
      setBusy("");
    }
  }

  const effectiveModel = startModel || runtimeStatus.models[0]?.id || "";
  const canDownload = Boolean(modelForm.id.trim() && modelForm.url.trim() && modelForm.sha256.trim());

  return (
    <Section
      title="Runtime local"
      detail="Execute modelos GGUF offline via llama.cpp. Instale a variante CPU ou Vulkan (GPU), gerencie modelos e inicie o servidor local."
    >
      <div className="setx-card">
        <div className="setx-row">
          <span className={`chip ${runtimeStatus.installed ? "ok" : ""}`}>
            {runtimeStatus.installed ? `instalado · ${runtimeStatus.variant ?? "cpu"}` : "não instalado"}
          </span>
          <span className={`chip ${runtimeStatus.running ? "ok" : ""}`}>
            {runtimeStatus.running ? `rodando · porta ${runtimeStatus.port ?? "?"}` : "parado"}
          </span>
          {runtimeStatus.version && <span className="chip">v{runtimeStatus.version}</span>}
          {!isTauriHost && <span className="chip warn">navegador — somente leitura</span>}
        </div>
        <div className="setx-actions">
          <button className="lg-button ghost" onClick={() => void run("install-cpu", () => runtime.install("cpu"))} disabled={Boolean(busy)}>
            {busy === "install-cpu" ? <LoaderCircle className="spin" size={13} /> : <HardDriveDownload size={13} />}
            Instalar CPU
          </button>
          <button
            className="lg-button ghost"
            onClick={() => void run("install-vulkan", () => runtime.install("vulkan"))}
            disabled={Boolean(busy)}
          >
            {busy === "install-vulkan" ? <LoaderCircle className="spin" size={13} /> : <HardDriveDownload size={13} />}
            Instalar Vulkan
          </button>
          {runtimeStatus.running ? (
            <button className="lg-button danger" onClick={() => void run("stop", () => runtime.stop())} disabled={Boolean(busy)}>
              {busy === "stop" ? <LoaderCircle className="spin" size={13} /> : <Square size={13} />}
              Parar
            </button>
          ) : (
            <button
              className="lg-button primary"
              onClick={() => void run("start", () => runtime.start(effectiveModel))}
              disabled={Boolean(busy) || !runtimeStatus.installed || !effectiveModel}
            >
              {busy === "start" ? <LoaderCircle className="spin" size={13} /> : <Play size={13} />}
              Iniciar
            </button>
          )}
        </div>
        {runtimeStatus.models.length > 0 && !runtimeStatus.running && (
          <label className="lg-field">
            Modelo para iniciar
            <select value={effectiveModel} onChange={(event) => setStartModel(event.target.value)}>
              {runtimeStatus.models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.id}
                </option>
              ))}
            </select>
          </label>
        )}
        <NoticeLine notice={notice} />
      </div>

      <div className="setx-card">
        <div className="setx-card-title">
          <Cpu size={13} />
          Modelos GGUF
          <small>{runtimeStatus.models.length} modelo(s)</small>
        </div>
        {runtimeStatus.models.length === 0 && <p className="setx-empty">Nenhum modelo baixado.</p>}
        {runtimeStatus.models.map((model) => (
          <div className="setx-model" key={model.id}>
            <span>
              {model.id}
              <small style={{ marginLeft: 8 }}>{model.fileName}</small>
            </span>
            <small>{formatBytes(model.size)}</small>
            <button
              className="icon-button"
              onClick={() => void run(`remove-${model.id}`, () => runtime.removeModel(model.id))}
              disabled={Boolean(busy)}
              aria-label={`Remover ${model.id}`}
            >
              {busy === `remove-${model.id}` ? <LoaderCircle className="spin" size={13} /> : <Trash2 size={13} />}
            </button>
          </div>
        ))}
        <div className="setx-grid">
          <label className="lg-field">
            ID do modelo
            <input
              value={modelForm.id}
              onChange={(event) => setModelForm({ ...modelForm, id: event.target.value })}
              placeholder="qwen3-4b-q4"
              spellCheck={false}
            />
          </label>
          <label className="lg-field">
            URL (.gguf)
            <input
              value={modelForm.url}
              onChange={(event) => setModelForm({ ...modelForm, url: event.target.value })}
              placeholder="https://…/modelo.gguf"
              spellCheck={false}
            />
          </label>
          <label className="lg-field">
            SHA-256
            <input
              value={modelForm.sha256}
              onChange={(event) => setModelForm({ ...modelForm, sha256: event.target.value })}
              placeholder="hash de verificação"
              spellCheck={false}
            />
          </label>
        </div>
        <div className="setx-actions">
          <button
            className="lg-button primary"
            disabled={!canDownload || Boolean(busy)}
            onClick={() =>
              void run("download", async () => {
                const status = await runtime.downloadModel(
                  modelForm.id.trim(),
                  modelForm.url.trim(),
                  modelForm.sha256.trim()
                );
                setModelForm({ id: "", url: "", sha256: "" });
                return status;
              })
            }
          >
            {busy === "download" ? <LoaderCircle className="spin" size={13} /> : <Download size={13} />}
            Baixar modelo
          </button>
        </div>
      </div>
      <LanguageRuntimesCard />
      <KimiK3Card />
    </Section>
  );
}

/** Runtimes de linguagem do terminal — instalação via manifesto assinado. */
function LanguageRuntimesCard() {
  const [runtimes, setRuntimes] = useState<LanguageRuntime[] | null>(null);
  const [busyId, setBusyId] = useState("");
  const [notice, setNotice] = useState<Notice>(null);

  async function reload() {
    if (!isTauriHost) return;
    try {
      setRuntimes(await terminal.catalog());
    } catch (cause) {
      setNotice({ text: errorText(cause), tone: "danger" });
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function install(id: string) {
    setBusyId(id);
    setNotice(null);
    try {
      await terminal.installRuntime(id);
      await reload();
      setNotice({ text: `Runtime "${id}" instalado via manifesto assinado.`, tone: "ok" });
    } catch (cause) {
      setNotice({ text: errorText(cause), tone: "danger" });
    } finally {
      setBusyId("");
    }
  }

  return (
    <div className="setx-card">
      <div className="setx-card-title">
        <HardDriveDownload size={13} />
        Runtimes de linguagem
        <small>{runtimes ? `${runtimes.filter((item) => item.installed).length}/${runtimes.length} instalados` : "—"}</small>
      </div>
      <p className="setx-hint">
        O terminal detecta a linguagem automaticamente; runtimes gerenciados instalam por manifesto assinado
        (Ed25519/SHA-256), no perfil do usuário — sem admin.
      </p>
      {!isTauriHost && <p className="setx-notice warn">Catálogo e instalação exigem o aplicativo desktop.</p>}
      {runtimes?.map((item) => (
        <div className="setx-item" key={item.id}>
          <div className="setx-item-head">
            <span className="grow">{item.label}</span>
            <code className="setx-code">{item.commands.join(", ")}</code>
            {item.installed ? (
              <span className="chip ok">instalado</span>
            ) : item.managed ? (
              <button className="lg-button compact" disabled={busyId === item.id} onClick={() => void install(item.id)}>
                {busyId === item.id ? <LoaderCircle className="spin" size={12} /> : <Download size={12} />}
                Instalar
              </button>
            ) : (
              <span className="chip" title={item.source}>
                instalação manual
              </span>
            )}
          </div>
        </div>
      ))}
      <NoticeLine notice={notice} />
    </div>
  );
}

/** Kimi K3 in C (experimental) — informativo do produto original, restaurado. */
function KimiK3Card() {
  return (
    <div className="setx-card">
      <div className="setx-card-title">
        <Cpu size={13} />
        Kimi K3 in C · experimental
        <span className="chip">nunca baixado automaticamente</span>
      </div>
      <p className="setx-hint">
        Modelo local avançado em C puro. Requisitos: Linux x64 / WSL2, CPU com AVX2+FMA e ~1,7 TB livres — o
        checkpoint (~1,56 TB) é baixado por sua conta, fora do app. No Windows depende do WSL2.
      </p>
      <div className="setx-actions">
        <button
          className="lg-button ghost"
          onClick={() => window.open("https://github.com/FareedKhan-dev/kimi-k3-in-c", "_blank", "noopener,noreferrer")}
        >
          <Plug size={13} />
          Ver requisitos e fonte
        </button>
      </div>
    </div>
  );
}

/* ----------------------------- 7. Aparência ----------------------------- */

const SHORTCUTS: Array<{ keys: string; action: string }> = [
  { keys: "Ctrl + 1…9", action: "Alternar abas visíveis (na ordem da barra)" },
  { keys: "Ctrl + Shift + P", action: "Alternar modo planejamento" },
  { keys: "Enter", action: "Enviar mensagem" },
  { keys: "Shift + Enter", action: "Nova linha no composer" },
  { keys: "Esc", action: "Fechar este painel" }
];

const MODE_LABELS: Record<UiMode, string> = {
  chat: "Chat",
  code: "Code",
  design: "Design",
  data: "Data",
  work: "Work",
  security: "Security",
  agent: "Agent",
  game: "Game Studio",
  tune: "Fine-Tuning"
};

/** Ocultar/exibir abas — pelo menos uma permanece visível. */
function VisibleTabsCard() {
  const visibleModes = useApp((state) => state.settings.visibleModes);
  const updateSettings = useApp((state) => state.updateSettings);

  function toggle(mode: UiMode) {
    const isOn = visibleModes.includes(mode);
    if (isOn && visibleModes.length <= 1) return;
    const next = isOn
      ? visibleModes.filter((item) => item !== mode)
      : [...UI_MODES].filter((item) => visibleModes.includes(item) || item === mode);
    updateSettings({ visibleModes: next });
  }

  return (
    <div className="setx-card">
      <div className="setx-card-title">
        <Settings2 size={13} />
        Abas visíveis
        <small>
          {visibleModes.length}/{UI_MODES.length}
        </small>
      </div>
      <p className="setx-hint">
        Oculte as abas que você não usa — a ordem original é preservada ao reexibir. Pelo menos uma aba permanece
        visível; se a aba ativa for ocultada, o app troca para a primeira visível.
      </p>
      <div className="setx-tabs-grid">
        {UI_MODES.map((mode) => {
          const on = visibleModes.includes(mode);
          const lastOne = on && visibleModes.length <= 1;
          return (
            <button
              key={mode}
              className={`lg-toggle ${on ? "on" : ""}`}
              onClick={() => toggle(mode)}
              disabled={lastOne}
              title={lastOne ? "Pelo menos uma aba precisa ficar visível" : undefined}
            >
              <i />
              {MODE_LABELS[mode]}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function AppearanceSection() {
  const theme = useApp((state) => state.theme);
  const setTheme = useApp((state) => state.setTheme);

  return (
    <Section title="Aparência" detail="Tema da interface, abas visíveis, movimento e atalhos de teclado.">
      <VisibleTabsCard />
      <div className="setx-card">
        <div className="setx-card-title">
          <Palette size={13} />
          Tema
        </div>
        <div className="setx-row">
          <div className="segmented">
            <button className={theme === "light" ? "active" : ""} onClick={() => setTheme("light")}>
              <Sun size={12} />
              Claro
            </button>
            <button className={theme === "dark" ? "active" : ""} onClick={() => setTheme("dark")}>
              <Moon size={12} />
              Escuro
            </button>
          </div>
        </div>
        <p className="setx-help">
          Movimento: quando o sistema define <code>prefers-reduced-motion</code>, todas as animações da interface são
          reduzidas automaticamente — nenhuma configuração extra é necessária.
        </p>
      </div>

      <div className="setx-card">
        <div className="setx-card-title">
          <Keyboard size={13} />
          Atalhos
        </div>
        {SHORTCUTS.map((shortcut) => (
          <div className="setx-shortcut" key={shortcut.keys}>
            <span className="setx-kbd">{shortcut.keys}</span>
            <span className="grow">{shortcut.action}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}

/* ------------------------------- Painel --------------------------------- */

export function SettingsPanel() {
  const setSettingsOpen = useApp((state) => state.setSettingsOpen);
  const [section, setSection] = useState<SectionId>("conexao");

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setSettingsOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setSettingsOpen]);

  return (
    <div className="modal-backdrop" onMouseDown={() => setSettingsOpen(false)}>
      <section
        className="modal-panel glass-strong setx-panel"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Configurações"
      >
        <header className="setx-head">
          <div className="setx-head-id">
            <span>
              <Settings2 size={15} />
            </span>
            <div>
              <strong>Configurações</strong>
              <small>ai orchestrator · v2</small>
            </div>
          </div>
          <div className="setx-spacer" />
          <button className="icon-button" onClick={() => setSettingsOpen(false)} aria-label="Fechar configurações">
            <X size={15} />
          </button>
        </header>
        <div className="setx-layout">
          <nav className="setx-nav" aria-label="Seções de configuração">
            {NAV.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  className={section === item.id ? "active" : ""}
                  onClick={() => setSection(item.id)}
                  aria-current={section === item.id}
                >
                  <Icon size={14} />
                  {item.label}
                </button>
              );
            })}
          </nav>
          <div className="setx-content">
            {section === "conexao" && <ConnectionSection />}
            {section === "motores" && <EnginesSection />}
            {section === "provedores" && <ProvidersSection />}
            {section === "memoria" && <MemorySection />}
            {section === "extensoes" && <ExtensionsSection />}
            {section === "runtime" && <RuntimeSection />}
            {section === "aparencia" && <AppearanceSection />}
          </div>
        </div>
      </section>
    </div>
  );
}
