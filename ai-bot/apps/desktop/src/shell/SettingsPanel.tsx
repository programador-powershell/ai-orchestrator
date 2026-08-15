/**
 * As configurações.
 *
 * A parte de cima continua LEITURA: endereço, conexão, modelo e tema são
 * decididos em outro lugar, e repetir controles aqui criaria dois botões para a
 * mesma coisa. A seção "Modelos e provedores" é a exceção deliberada — ela é a
 * ÚNICA dona do assunto: antes dela o catalog.json só se editava na mão, com o
 * gateway parado.
 *
 * A regra de segredo da seção, que não pode ser afrouxada: a chave de API vai
 * do campo direto para o POST e do POST direto para o cofre do gateway. Ela
 * NUNCA entra no store (que o `persist` serializa), nunca vai a localStorage e
 * o campo zera assim que o envio termina — sucesso ou falha. O que volta do
 * gateway é só o booleano "cadastrada/ausente".
 *
 * A moldura é a do cartão de aprovação (`.approval-backdrop`/`.approval-card`)
 * porque é a mesma interrupção: a tela para e mostra uma coisa só.
 */
import { useCallback, useEffect, useState } from "react";
import { Bot, Moon, PlugZap, Plus, Settings, Sun, Trash2, X } from "lucide-react";
import { activeTransport, useApp } from "../lib/store";
import { SPECIALIST_ICON } from "../lib/specialists";

const STATUS_LABEL: Record<"connecting" | "ready" | "offline", string> = {
  connecting: "conectando…",
  ready: "conectado",
  offline: "offline"
};

/* ------------------------------ o catálogo ------------------------------- */

/**
 * O REST autenticado que a seção usa. É o `Transport` visto por três métodos —
 * e é interface própria para o teste montar o formulário com um cliente falso,
 * sem gateway e sem token.
 */
export interface CatalogClient {
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
  patch(path: string, body: unknown): Promise<unknown>;
  del(path: string): Promise<unknown>;
}

export interface CatalogProvider {
  id: string;
  name: string;
  kind: string;
  baseUrl: string;
  enabled: boolean;
  needsKey: boolean;
  hasKey: boolean;
  canDelete: boolean;
}

export interface CatalogModel {
  id: string;
  providerId: string;
  label: string;
  context: number;
  default?: boolean;
  local?: boolean;
  canDelete: boolean;
}

interface CatalogSnapshot {
  providers: CatalogProvider[];
  models: CatalogModel[];
}

/** Os dialetos que o gateway aceita — a mesma lista fechada do catalog.go. */
export const PROVIDER_KINDS = [
  "openai",
  "xai",
  "anthropic",
  "gemini",
  "openai-compatible",
  "local"
] as const;

/**
 * Conferência ESTRUTURAL do que veio do fio, como `payloadOf` no store: o dono
 * do contrato é o Go, e revalidar campo a campo criaria uma segunda verdade.
 * Campo ausente vira valor neutro em vez de derrubar a lista inteira.
 */
function parseCatalog(raw: unknown): CatalogSnapshot {
  const snapshot: CatalogSnapshot = { providers: [], models: [] };
  if (typeof raw !== "object" || raw === null) return snapshot;
  const data = raw as { providers?: unknown; models?: unknown };

  if (Array.isArray(data.providers)) {
    for (const item of data.providers) {
      if (typeof item !== "object" || item === null) continue;
      const provider = item as Partial<CatalogProvider>;
      if (typeof provider.id !== "string" || provider.id === "") continue;
      snapshot.providers.push({
        id: provider.id,
        name: typeof provider.name === "string" && provider.name !== "" ? provider.name : provider.id,
        kind: typeof provider.kind === "string" ? provider.kind : "",
        baseUrl: typeof provider.baseUrl === "string" ? provider.baseUrl : "",
        enabled: provider.enabled === true,
        needsKey: provider.needsKey !== false,
        hasKey: provider.hasKey === true,
        canDelete: provider.canDelete !== false
      });
    }
  }
  if (Array.isArray(data.models)) {
    for (const item of data.models) {
      if (typeof item !== "object" || item === null) continue;
      const model = item as Partial<CatalogModel>;
      if (typeof model.id !== "string" || model.id === "") continue;
      snapshot.models.push({
        id: model.id,
        providerId: typeof model.providerId === "string" ? model.providerId : "",
        label: typeof model.label === "string" && model.label !== "" ? model.label : model.id,
        context: typeof model.context === "number" ? model.context : 0,
        default: model.default === true,
        local: model.local === true,
        canDelete: model.canDelete !== false
      });
    }
  }
  return snapshot;
}

function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : "falha ao falar com o gateway";
}

/** O rótulo de chave da linha do provedor — o único eco que o segredo tem. */
export function keyLabel(provider: CatalogProvider): string {
  if (!provider.needsKey) return "não usa chave";
  return provider.hasKey ? "chave: cadastrada" : "chave: ausente";
}

/* ---------------------- configuração de provedor existente ---------------------- */

/**
 * Atualiza um provedor sem expor a chave atual. Campo vazio significa
 * "preserve a chave no cofre"; quando há valor, ele zera no `finally` como no
 * formulário de cadastro.
 */
export function ProviderConfigForm({
  provider,
  onSubmit
}: {
  provider: CatalogProvider;
  onSubmit: (change: { apiKey?: string; enabled: boolean }) => Promise<void>;
}) {
  const [apiKey, setApiKey] = useState("");
  const [enabled, setEnabled] = useState(provider.enabled);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const change: { apiKey?: string; enabled: boolean } = { enabled };
      if (apiKey !== "") change.apiKey = apiKey;
      await onSubmit(change);
      setFailure("");
    } catch (cause) {
      setFailure(reasonOf(cause));
    } finally {
      setApiKey("");
      setBusy(false);
    }
  }

  return (
    <form className="settings-provider-config" onSubmit={submit}>
      {provider.needsKey && (
        <input
          className="settings-input"
          type="password"
          aria-label={`chave de API de ${provider.id}`}
          placeholder={provider.hasKey ? "nova chave (opcional)" : "chave de API"}
          autoComplete="off"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
        />
      )}
      <label className="settings-check">
        <input
          type="checkbox"
          aria-label={`habilitar ${provider.id}`}
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        habilitado
      </label>
      <button type="submit" className="button-secondary" disabled={busy}>
        Salvar
      </button>
      {failure !== "" && (
        <span className="settings-feedback" data-ok="false">
          {failure}
        </span>
      )}
    </form>
  );
}

/* ------------------------- formulário de provedor ------------------------- */

export interface NewProvider {
  id: string;
  name: string;
  kind: string;
  baseUrl: string;
  apiKey: string;
}

/**
 * O formulário de adicionar provedor.
 *
 * O campo de chave é `password` e ZERA no `finally` do envio — com sucesso ou
 * sem. O valor vive só no estado local deste componente: o store nunca o vê
 * (o `persist` serializa o store), e nada aqui toca localStorage.
 */
export function ProviderForm({ onSubmit }: { onSubmit: (provider: NewProvider) => Promise<void> }) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<string>("openai-compatible");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      await onSubmit({ id, name, kind, baseUrl, apiKey });
      // Sucesso limpa o formulário inteiro; os campos não-secretos só aqui,
      // porque numa falha a pessoa corrige um campo em vez de redigitar tudo.
      setId("");
      setName("");
      setBaseUrl("");
      setFailure("");
    } catch (cause) {
      setFailure(reasonOf(cause));
    } finally {
      // A chave zera SEMPRE, inclusive na falha: o segredo não fica esperando
      // no DOM enquanto a pessoa lê a mensagem de erro.
      setApiKey("");
      setBusy(false);
    }
  }

  return (
    <form className="settings-form" onSubmit={submit}>
      <div className="settings-form-row">
        <input
          className="settings-input"
          aria-label="id do provedor"
          placeholder="id (ex.: openrouter)"
          value={id}
          onChange={(event) => setId(event.target.value)}
        />
        <input
          className="settings-input"
          aria-label="nome do provedor"
          placeholder="nome"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <select
          className="model-select"
          aria-label="tipo do provedor"
          value={kind}
          onChange={(event) => setKind(event.target.value)}
        >
          {PROVIDER_KINDS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </div>
      <div className="settings-form-row">
        <input
          className="settings-input"
          aria-label="baseUrl do provedor"
          placeholder="https://api.exemplo.com/v1"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
        />
        <input
          className="settings-input"
          type="password"
          aria-label="chave de API"
          placeholder="chave de API (opcional)"
          autoComplete="off"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
        />
        <button type="submit" className="button-secondary" disabled={busy}>
          <Plus size={13} aria-hidden />
          Adicionar
        </button>
      </div>
      <p className="approval-note">
        a chave vai para o cofre do gateway e não volta — aqui o campo zera após enviar.
      </p>
      {failure !== "" && (
        <p className="settings-feedback" data-ok="false">
          {failure}
        </p>
      )}
    </form>
  );
}

/* -------------------------- formulário de modelo -------------------------- */

export interface NewModel {
  id: string;
  providerId: string;
  label: string;
  context: number;
  skills: string[];
  default: boolean;
}

export function ModelForm({
  providers,
  onSubmit
}: {
  providers: CatalogProvider[];
  onSubmit: (model: NewModel) => Promise<void>;
}) {
  const [id, setId] = useState("");
  const [providerId, setProviderId] = useState("");
  const [label, setLabel] = useState("");
  const [context, setContext] = useState("");
  const [skills, setSkills] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");

  // O select nasce no primeiro provedor da lista quando nada foi escolhido:
  // sem isso o envio sairia com providerId vazio e a recusa do gateway seria a
  // primeira notícia de que havia um campo obrigatório invisível.
  const firstProvider = providers[0];
  const chosenProvider = providerId !== "" ? providerId : (firstProvider?.id ?? "");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      await onSubmit({
        id,
        providerId: chosenProvider,
        label,
        context: Number.parseInt(context, 10) || 0,
        skills: skills
          .split(",")
          .map((skill) => skill.trim())
          .filter((skill) => skill !== ""),
        default: isDefault
      });
      setId("");
      setLabel("");
      setContext("");
      setSkills("");
      setIsDefault(false);
      setFailure("");
    } catch (cause) {
      setFailure(reasonOf(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="settings-form" onSubmit={submit}>
      <div className="settings-form-row">
        <input
          className="settings-input"
          aria-label="id do modelo"
          placeholder="id (ex.: gpt-5-mini)"
          value={id}
          onChange={(event) => setId(event.target.value)}
        />
        <select
          className="model-select"
          aria-label="provedor do modelo"
          value={chosenProvider}
          onChange={(event) => setProviderId(event.target.value)}
        >
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.name}
            </option>
          ))}
        </select>
        <input
          className="settings-input"
          aria-label="rótulo do modelo"
          placeholder="rótulo"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
      </div>
      <div className="settings-form-row">
        <input
          className="settings-input"
          aria-label="janela de contexto"
          placeholder="contexto (tokens)"
          inputMode="numeric"
          value={context}
          onChange={(event) => setContext(event.target.value)}
        />
        <input
          className="settings-input"
          aria-label="habilidades do modelo"
          placeholder="skills (chat, code, …)"
          value={skills}
          onChange={(event) => setSkills(event.target.value)}
        />
        <label className="settings-check">
          <input
            type="checkbox"
            checked={isDefault}
            onChange={(event) => setIsDefault(event.target.checked)}
          />
          padrão
        </label>
        <button type="submit" className="button-secondary" disabled={busy || providers.length === 0}>
          <Plus size={13} aria-hidden />
          Adicionar
        </button>
      </div>
      {failure !== "" && (
        <p className="settings-feedback" data-ok="false">
          {failure}
        </p>
      )}
    </form>
  );
}

/* ------------------------------ a seção viva ------------------------------ */

export function CatalogSection({ client }: { client: CatalogClient | null }) {
  const [snapshot, setSnapshot] = useState<CatalogSnapshot | null>(null);
  const [failure, setFailure] = useState("");
  const [tests, setTests] = useState<Record<string, { ok: boolean; detail: string }>>({});

  const reload = useCallback(async () => {
    if (client === null) return;
    try {
      setSnapshot(parseCatalog(await client.get("/v1/catalog")));
      setFailure("");
    } catch (cause) {
      setFailure(reasonOf(cause));
    }
  }, [client]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (client === null) {
    return (
      <p className="approval-note">
        sem conexão com o gateway — os provedores aparecem quando ele conectar.
      </p>
    );
  }
  // O TypeScript não carrega o estreitamento do guard para dentro das funções
  // abaixo (parâmetro não é `const`); o apelido carrega.
  const gateway = client;

  async function addProvider(provider: NewProvider) {
    // O corpo segue como veio; quem valida (kind, https, id) é o gateway, e a
    // frase da recusa dele volta inteira para o formulário.
    await gateway.post("/v1/catalog/providers", provider);
    await reload();
  }

  async function removeProvider(id: string) {
    try {
      await gateway.del(`/v1/catalog/providers/${encodeURIComponent(id)}`);
      setTests((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      await reload();
    } catch (cause) {
      setFailure(reasonOf(cause));
    }
  }

  async function updateProvider(id: string, change: { apiKey?: string; enabled: boolean }) {
    await gateway.patch(`/v1/catalog/providers/${encodeURIComponent(id)}`, change);
    await reload();
  }

  async function testProvider(id: string) {
    setTests((current) => ({ ...current, [id]: { ok: false, detail: "testando…" } }));
    try {
      const raw = await gateway.post(`/v1/catalog/test/${encodeURIComponent(id)}`, {});
      const result =
        typeof raw === "object" && raw !== null
          ? (raw as { ok?: unknown; detail?: unknown })
          : {};
      setTests((current) => ({
        ...current,
        [id]: {
          ok: result.ok === true,
          detail: typeof result.detail === "string" ? result.detail : "resposta inesperada do gateway"
        }
      }));
    } catch (cause) {
      setTests((current) => ({ ...current, [id]: { ok: false, detail: reasonOf(cause) } }));
    }
  }

  async function addModel(model: NewModel) {
    await gateway.post("/v1/catalog/models", model);
    await reload();
  }

  async function removeModel(id: string) {
    try {
      await gateway.del(`/v1/catalog/models/${encodeURIComponent(id)}`);
      await reload();
    } catch (cause) {
      setFailure(reasonOf(cause));
    }
  }

  const providers = snapshot?.providers ?? [];
  const models = snapshot?.models ?? [];

  return (
    <div className="settings-section">
      <p className="approval-summary">Modelos e provedores</p>

      {failure !== "" && (
        <p className="settings-feedback" data-ok="false">
          {failure}
        </p>
      )}

      <ul className="settings-list">
        {providers.length === 0 && <li className="approval-note">nenhum provedor cadastrado.</li>}
        {providers.map((provider) => {
          const test = tests[provider.id];
          return (
            <li key={provider.id} className="settings-item settings-provider-item">
              <div className="settings-item-main">
                <span>
                  {provider.name}
                  <span className="settings-bot-tag"> · {provider.kind}</span>
                  {!provider.enabled && <span className="settings-bot-tag"> · desligado</span>}
                </span>
                <span className="settings-item-sub">{provider.baseUrl}</span>
                {test && (
                  <span className="settings-feedback" data-ok={test.ok ? "true" : "false"}>
                    {test.detail}
                  </span>
                )}
              </div>
              <span className="settings-chip" data-ok={!provider.needsKey || provider.hasKey ? "true" : "false"}>
                {keyLabel(provider)}
              </span>
              <button
                type="button"
                className="button-secondary"
                aria-label={`testar conexão de ${provider.id}`}
                onClick={() => void testProvider(provider.id)}
              >
                <PlugZap size={13} aria-hidden />
                Testar
              </button>
              {provider.canDelete && (
                <button
                  type="button"
                  className="button-secondary"
                  aria-label={`remover provedor ${provider.id}`}
                  onClick={() => void removeProvider(provider.id)}
                >
                  <Trash2 size={13} aria-hidden />
                </button>
              )}
              <ProviderConfigForm
                provider={provider}
                onSubmit={(change) => updateProvider(provider.id, change)}
              />
            </li>
          );
        })}
      </ul>

      <ProviderForm onSubmit={addProvider} />

      <ul className="settings-list">
        {models.length === 0 && <li className="approval-note">nenhum modelo cadastrado.</li>}
        {models.map((model) => (
          <li key={model.id} className="settings-item">
            <div className="settings-item-main">
              <span>
                {model.label}
                {model.default === true && <span className="settings-chip"> padrão</span>}
              </span>
              <span className="settings-item-sub">
                {model.id} · {model.providerId}
                {model.context > 0 ? ` · ${model.context.toLocaleString("pt-BR")} tokens` : ""}
              </span>
            </div>
            {model.canDelete && (
              <button
                type="button"
                className="button-secondary"
                aria-label={`remover modelo ${model.id}`}
                onClick={() => void removeModel(model.id)}
              >
                <Trash2 size={13} aria-hidden />
              </button>
            )}
          </li>
        ))}
      </ul>

      <ModelForm providers={providers} onSubmit={addModel} />
    </div>
  );
}

/* --------------------------------- painel --------------------------------- */

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="settings-row">
      <span className="settings-key">{label}</span>
      <span className="settings-value">{value}</span>
    </div>
  );
}

export function SettingsPanel() {
  const gatewayUrl = useApp((state) => state.gatewayUrl);
  const status = useApp((state) => state.status);
  const models = useApp((state) => state.models);
  const activeModel = useApp((state) => state.activeModel);
  const theme = useApp((state) => state.theme);
  const specialists = useApp((state) => state.specialists);
  const setSettingsOpen = useApp((state) => state.setSettingsOpen);

  // O endereço só é conhecido depois que o Rust responde de onde subiu o
  // gateway. Dizer isso é melhor que mostrar o padrão como se fosse o real.
  const url = gatewayUrl === "" ? "ainda descobrindo…" : gatewayUrl;

  // O rótulo do modelo é do catálogo; um id fora da lista aparece como veio, e
  // marcado — inventar um nome bonito esconderia justamente a divergência.
  const known = models.find((model) => model.id === activeModel);
  const model =
    activeModel === ""
      ? "nenhum escolhido"
      : known
        ? `${known.label} · ${known.provider}${known.local ? " · local" : ""}`
        : `${activeModel} (fora da lista do gateway)`;

  return (
    <div className="approval-backdrop">
      <section
        className="approval-card settings-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <header className="approval-head">
          <Settings size={16} aria-hidden />
          <h2 id="settings-title" className="approval-tool">
            configurações
          </h2>
        </header>

        <div className="settings-list">
          <Row label="Gateway" value={url} />
          <Row label="Conexão" value={STATUS_LABEL[status]} />
          <Row label="Modelo" value={model} />
          <Row label="Tema" value={theme === "dark" ? "escuro" : "claro"} />
        </div>

        <CatalogSection client={activeTransport()} />

        <p className="approval-summary">Especialistas</p>

        <ul className="settings-list">
          {specialists.map((specialist) => {
            const Glyph = SPECIALIST_ICON[specialist.id] ?? Bot;
            return (
              <li key={specialist.id} className="settings-bot">
                <Glyph size={14} strokeWidth={1.75} aria-hidden />
                <span>{specialist.name}</span>
                <span className="settings-bot-tag">{specialist.tagline}</span>
              </li>
            );
          })}
        </ul>

        <p className="approval-note">
          {theme === "dark" ? <Moon size={13} aria-hidden /> : <Sun size={13} aria-hidden />}
          O tema e o modelo são trocados na barra superior; aqui eles só são mostrados.
        </p>

        <p className="approval-note">
          O token do gateway e as chaves dos provedores ficam no cofre e não são exibidos aqui —
          nem por engano, nem em log.
        </p>

        <footer className="approval-actions">
          <button type="button" className="button-secondary" onClick={() => setSettingsOpen(false)}>
            <X size={14} aria-hidden />
            Fechar
          </button>
        </footer>
      </section>
    </div>
  );
}

export default SettingsPanel;
