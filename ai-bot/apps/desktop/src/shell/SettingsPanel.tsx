/**
 * As configurações.
 *
 * O menu lateral é o MESMO do orquestrador — doze seções, mesma ordem, mesmos
 * rótulos — porque quem usa os dois apps não deveria reaprender onde mora cada
 * assunto. Cinco delas falam com o gateway do AI-BOT; as outras sete abrem
 * dizendo o que falta do lado dele, em vez de mostrar um controle que não faz
 * nada (ver `NAV` e `PENDENTE`).
 *
 * Endereço do gateway e modelo da conversa continuam LEITURA: quem sobe o
 * gateway é o próprio aplicativo, e o modelo se troca na barra superior, que é
 * onde ele é usado. Repetir esses controles aqui criaria duas verdades. O tema
 * é a exceção: ele é preferência de aparência, e "Aparência" é o lugar dele —
 * o botão da barra superior continua sendo o atalho.
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
import {
  Blocks,
  Bot,
  Brain,
  Cable,
  Cpu,
  HardDrive,
  KeyRound,
  Monitor,
  Moon,
  Palette,
  PlugZap,
  Plus,
  Puzzle,
  Rocket,
  Server,
  Settings,
  ShieldCheck,
  Sun,
  Trash2,
  X,
  type LucideIcon
} from "lucide-react";
import { activeTransport, useApp } from "../lib/store";
import { SPECIALIST_ICON } from "../lib/specialists";
import { ENVIRONMENT_ICON } from "../lib/environments";

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
/**
 * Estamos dentro do aplicativo, ou numa aba de navegador?
 *
 * A pergunta não é cosmética: quem conhece o token do gateway é o processo Rust,
 * que o leu do disco. Numa aba comum esse comando não existe, e o token não pode
 * ser embutido no pacote JavaScript — qualquer página do mesmo contexto o leria.
 * Ou seja: no navegador a tela NÃO VAI conectar, nem daqui a pouco, e dizer
 * "aguardando o gateway" ali seria mentira educada.
 */
const noAplicativo = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * O que a seção mostra quando não há gateway para conversar.
 *
 * Mensagem ACIONÁVEL, com o comando que resolve. A versão anterior dizia só
 * "sem conexão com o gateway — os provedores aparecem quando ele conectar", e no
 * navegador isso nunca acontecia: a pessoa ficava esperando uma conexão que o
 * desenho impede.
 */
function SemGateway() {
  const navegador = !noAplicativo();

  return (
    <div className="settings-section">
      <div className="settings-cardx">
        <div className="settings-cardx-title">
          <PlugZap size={13} aria-hidden />
          Sem conexão com o gateway
          <span className="settings-chip-pill">
            {navegador ? "aba de navegador" : "gateway fora do ar"}
          </span>
        </div>
        {navegador ? (
          <>
            <p className="settings-help">
              Numa aba de navegador esta tela não tem como se autenticar: quem conhece o token
              do gateway é o processo do aplicativo, que o lê do disco. Embutir o token no
              JavaScript servido o entregaria a qualquer página aberta no mesmo contexto.
            </p>
            <p className="settings-help">
              Para configurar provedores, modelos e ambientes, abra o aplicativo:
            </p>
            <pre className="settings-comando">corepack pnpm dev:desktop</pre>
            <p className="settings-help">
              Esse comando compila o gateway em <code>dist/</code> e sobe a janela com ele no
              caminho de busca. O <code>corepack pnpm dev</code> serve só a interface — é o
              modo de mexer em tela, e a bancada de avatares em <code>/bench.html</code>.
            </p>
          </>
        ) : (
          <p className="settings-help">
            O aplicativo está no ar, mas o gateway não respondeu. Ele sobe junto com a janela;
            se isto persistir, o motivo aparece no log do aplicativo — porta 8799 ocupada por
            outro <code>aibotd</code> é a causa mais comum.
          </p>
        )}
      </div>
    </div>
  );
}

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
  onSubmit,
  children
}: {
  provider: CatalogProvider;
  onSubmit: (change: { apiKey?: string; enabled: boolean }) => Promise<void>;
  /** Ações do cartão (testar, remover) — vêm à esquerda do botão primário. */
  children?: React.ReactNode;
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
        <div className="settings-grid">
          <label className="settings-field">
            Chave da API
            <input
              type="password"
              aria-label={`chave de API de ${provider.id}`}
              placeholder={provider.hasKey ? "cole a nova chave (não é exibida depois)" : "cole a chave (não é exibida depois)"}
              autoComplete="off"
              spellCheck={false}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </label>
        </div>
      )}
      {failure !== "" && (
        <span className="settings-feedback" data-ok="false">
          {failure}
        </span>
      )}
      <div className="settings-actions">
        <label className="settings-check">
          <input
            type="checkbox"
            aria-label={`habilitar ${provider.id}`}
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          habilitado
        </label>
        <span className="settings-head-spacer" />
        {children}
        <button type="submit" className="settings-button" data-kind="primary" disabled={busy}>
          <KeyRound size={13} aria-hidden />
          Salvar chave
        </button>
      </div>
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
    <form className="settings-cardx" onSubmit={submit}>
      <div className="settings-cardx-title">
        <Plus size={13} aria-hidden />
        Novo provedor
        <small>qualquer endpoint que fale o protocolo do dialeto escolhido</small>
      </div>

      <div className="settings-grid">
        <label className="settings-field">
          Id
          <input
            aria-label="id do provedor"
            placeholder="ex.: openrouter"
            value={id}
            onChange={(event) => setId(event.target.value)}
          />
        </label>
        <label className="settings-field">
          Nome
          <input
            aria-label="nome do provedor"
            placeholder="nome exibido"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="settings-field">
          Dialeto
          <select
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
        </label>
        <label className="settings-field">
          Base URL
          <input
            aria-label="baseUrl do provedor"
            placeholder="https://api.exemplo.com/v1"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </label>
        <label className="settings-field">
          Chave da API (opcional)
          <input
            type="password"
            aria-label="chave de API"
            placeholder="cole a chave (não é exibida depois)"
            autoComplete="off"
            spellCheck={false}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </label>
      </div>

      <p className="settings-help">
        A chave vai para o cofre do gateway e não volta — o campo zera depois de enviar, com
        sucesso ou com falha.
      </p>

      {failure !== "" && (
        <p className="settings-feedback" data-ok="false">
          {failure}
        </p>
      )}

      <div className="settings-actions">
        <button type="submit" className="settings-button" data-kind="primary" disabled={busy}>
          <Plus size={13} aria-hidden />
          Adicionar
        </button>
      </div>
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
    <form className="settings-cardx" onSubmit={submit}>
      <div className="settings-cardx-title">
        <Plus size={13} aria-hidden />
        Novo modelo
        <small>o que entra na lista do seletor da barra superior</small>
      </div>

      <div className="settings-grid">
        <label className="settings-field">
          Provedor
          <select
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
        </label>
        <label className="settings-field">
          Id do modelo
          <input
            aria-label="id do modelo"
            placeholder="ex.: claude-sonnet-5"
            value={id}
            onChange={(event) => setId(event.target.value)}
          />
        </label>
        <label className="settings-field">
          Rótulo (opcional)
          <input
            aria-label="rótulo do modelo"
            placeholder="nome exibido"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
        </label>
        <label className="settings-field">
          Contexto (tokens)
          <input
            aria-label="janela de contexto"
            placeholder="ex.: 200000"
            inputMode="numeric"
            value={context}
            onChange={(event) => setContext(event.target.value)}
          />
        </label>
        <label className="settings-field">
          Habilidades
          <input
            aria-label="habilidades do modelo"
            placeholder="chat, code, …"
            value={skills}
            onChange={(event) => setSkills(event.target.value)}
          />
        </label>
      </div>

      {failure !== "" && (
        <p className="settings-feedback" data-ok="false">
          {failure}
        </p>
      )}

      <div className="settings-actions">
        <label className="settings-check">
          <input
            type="checkbox"
            checked={isDefault}
            onChange={(event) => setIsDefault(event.target.checked)}
          />
          padrão
        </label>
        <span className="settings-head-spacer" />
        <button
          type="submit"
          className="settings-button"
          data-kind="primary"
          disabled={busy || providers.length === 0}
        >
          <Plus size={13} aria-hidden />
          Adicionar
        </button>
      </div>
    </form>
  );
}

/* ------------------------------ a seção viva ------------------------------ */

/**
 * Metade do catálogo que esta montagem desenha.
 *
 * O assunto é um só do lado do gateway (um GET, um arquivo), mas na tela ele
 * mora em dois lugares diferentes, como no orquestrador: a CHAVE de cada
 * provedor fica em "Provedores (BYOK)" e a lista de MODELOS em "Motores &
 * Fusion". Só uma das duas está montada por vez — o menu troca o painel —, então
 * cada uma carregar o próprio retrato custa um GET por troca de seção, e não
 * dois em paralelo.
 */
export type CatalogScope = "providers" | "models";

export function CatalogSection({
  client,
  scope
}: {
  client: CatalogClient | null;
  scope: CatalogScope;
}) {
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
    return <SemGateway />;
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

  if (scope === "models") {
    return (
      <div className="settings-section">
        {failure !== "" && (
          <p className="settings-feedback" data-ok="false">
            {failure}
          </p>
        )}

        {models.length === 0 && <p className="settings-empty">nenhum modelo cadastrado.</p>}

        {models.map((model) => (
          <div key={model.id} className="settings-cardx">
            <div className="settings-cardx-title">
              {model.label}
              {model.default === true && (
                <span className="settings-chip-pill" data-tone="accent">
                  padrão
                </span>
              )}
              <span className="settings-head-spacer" />
              <span className="settings-chip-pill">{model.id}</span>
              <span className="settings-chip-pill">{model.providerId}</span>
              {model.context > 0 && (
                <small>{model.context.toLocaleString("pt-BR")} tokens</small>
              )}
              {model.canDelete && (
                <button
                  type="button"
                  className="settings-button"
                  data-kind="ghost"
                  aria-label={`remover modelo ${model.id}`}
                  onClick={() => void removeModel(model.id)}
                >
                  <Trash2 size={13} aria-hidden />
                </button>
              )}
            </div>
          </div>
        ))}

        <ModelForm providers={providers} onSubmit={addModel} />
      </div>
    );
  }

  return (
    <div className="settings-section">
      {failure !== "" && (
        <p className="settings-feedback" data-ok="false">
          {failure}
        </p>
      )}

      {providers.length === 0 && <p className="settings-empty">nenhum provedor cadastrado.</p>}

      {providers.map((provider) => {
        const test = tests[provider.id];
        const comChave = !provider.needsKey || provider.hasKey;
        return (
          <div key={provider.id} className="settings-cardx">
            <div className="settings-cardx-title">
              <KeyRound size={13} aria-hidden />
              {provider.name}
              <span className="settings-chip-pill" data-tone={comChave ? "ok" : ""}>
                {keyLabel(provider)}
              </span>
              {!provider.enabled && <span className="settings-chip-pill">desligado</span>}
              <small>
                {provider.baseUrl} · {provider.kind}
              </small>
            </div>

            {test && (
              <p className="settings-feedback" data-ok={test.ok ? "true" : "false"}>
                {test.detail}
              </p>
            )}

            <ProviderConfigForm
              provider={provider}
              onSubmit={(change) => updateProvider(provider.id, change)}
            >
              <button
                type="button"
                className="settings-button"
                data-kind="ghost"
                aria-label={`testar conexão de ${provider.id}`}
                onClick={() => void testProvider(provider.id)}
              >
                <PlugZap size={13} aria-hidden />
                Testar conexão
              </button>
              {provider.canDelete && (
                <button
                  type="button"
                  className="settings-button"
                  data-kind="ghost"
                  aria-label={`remover provedor ${provider.id}`}
                  onClick={() => void removeProvider(provider.id)}
                >
                  <Trash2 size={13} aria-hidden />
                  Remover
                </button>
              )}
            </ProviderConfigForm>
          </div>
        );
      })}

      <ProviderForm onSubmit={addProvider} />
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

/* ------------------------------- as seções -------------------------------- */

/**
 * O MENU é o mesmo do orquestrador, item por item e na mesma ordem.
 *
 * Ele não é decoração: é o mapa do que este produto configura, e a pessoa que
 * usa os dois apps não deveria ter de reaprender onde mora cada assunto. Por
 * isso os ids e os rótulos são copiados de `components/Settings.tsx` do
 * orquestrador — inclusive os parênteses de "Provedores (BYOK)" e
 * "Ship (build & deploy)".
 *
 * Cinco seções falam com o gateway do AI-BOT hoje. As outras SETE abrem
 * dizendo, em uma frase, o que falta do lado do gateway para elas existirem —
 * ver `PENDENTE`. Preferir a seção vazia e honesta ao controle bonito que não
 * faz nada é a mesma regra do quadro de features do README: prometer o que não
 * entrega é o defeito que este produto não pode ter.
 */
type SectionId =
  | "conexao"
  | "motores"
  | "provedores"
  | "memoria"
  | "extensoes"
  | "plugins"
  | "conectores"
  | "runtime"
  | "ship"
  | "vps"
  | "administracao"
  | "aparencia";

const NAV: ReadonlyArray<{ id: SectionId; label: string; icon: LucideIcon }> = [
  { id: "conexao", label: "Conexão", icon: PlugZap },
  { id: "motores", label: "Motores & Fusion", icon: Cpu },
  { id: "provedores", label: "Provedores (BYOK)", icon: KeyRound },
  { id: "memoria", label: "Memória", icon: Brain },
  { id: "extensoes", label: "Extensões", icon: Puzzle },
  { id: "plugins", label: "Plugins & trilha", icon: Blocks },
  { id: "conectores", label: "Conectores (MCP)", icon: Cable },
  { id: "runtime", label: "Runtime local", icon: HardDrive },
  { id: "ship", label: "Ship (build & deploy)", icon: Rocket },
  { id: "vps", label: "Servidor VPS", icon: Server },
  { id: "administracao", label: "Administração", icon: ShieldCheck },
  { id: "aparencia", label: "Aparência", icon: Palette }
];

/**
 * Título e explicação de cada seção — o cabeçalho que abre o painel.
 *
 * O texto é do assunto NESTE produto, não copiado: onde o orquestrador fala do
 * keyring do Windows e do cofre corporativo, aqui quem guarda a chave é o
 * gateway, e é isso que a frase precisa dizer. O que se copia do orquestrador é
 * a FORMA — um título e uma explicação curta antes de qualquer controle.
 */
const SECAO_TEXTO: Record<SectionId, { titulo: string; detalhe: string }> = {
  conexao: {
    titulo: "Conexão",
    detalhe:
      "Endereço do gateway e estado da ligação. Quem sobe o gateway é o próprio aplicativo — o token de acesso fica no cofre, nunca em arquivo e nunca nesta tela."
  },
  motores: {
    titulo: "Motores & Fusion",
    detalhe:
      "O que entra na lista de modelos do seletor. Quem escolhe o modelo é quem conversa; aqui se decide o que ele pode escolher."
  },
  provedores: {
    titulo: "Provedores (BYOK)",
    detalhe:
      "Traga sua própria chave por provedor. Ela vai do campo direto ao cofre do gateway e não volta — o campo zera depois de enviar, e o que a tela recebe de volta é só \"cadastrada\" ou \"ausente\"."
  },
  memoria: {
    titulo: "Memória",
    detalhe: "Fatos que sobrevivem à conversa e voltam como contexto na próxima."
  },
  extensoes: {
    titulo: "Extensões",
    detalhe: "Pacotes de skills e agentes trazidos de fora, inspecionados antes de importar."
  },
  plugins: {
    titulo: "Plugins & trilha",
    detalhe:
      "Provedores, modelos, conectores e overlays de especialista que entram por manifesto — e a trilha do que o agente fez."
  },
  conectores: {
    titulo: "Conectores (MCP)",
    detalhe:
      "Servidores MCP externos, em JSON-RPC sobre HTTP. As ferramentas de cada servidor entram no catálogo do agente e passam pelo mesmo diálogo de aprovação."
  },
  runtime: {
    titulo: "Runtime local",
    detalhe:
      "Onde o próximo comando roda. Quem mede o que existe nesta máquina é o gateway: ele procura o Docker, a distro do WSL e a VPS cadastrada."
  },
  ship: {
    titulo: "Ship (build & deploy)",
    detalhe: "Como o especialista de código carrega o projeto, roda o pipeline e marca a versão."
  },
  vps: {
    titulo: "Servidor VPS",
    detalhe:
      "O servidor ao qual o AI-BOT se conecta para build e deploy. Sem senha e sem chave privada no formulário."
  },
  administracao: {
    titulo: "Administração",
    detalhe:
      "A política do grupo: tetos de delegação, quais ferramentas cada papel executa, quais modelos ele enxerga e quanto custa."
  },
  aparencia: {
    titulo: "Aparência",
    detalhe: "Tema da interface e a equipe de especialistas que atende nesta instalação."
  }
};

/**
 * O que falta, por seção, para ela deixar de ser uma frase.
 *
 * Texto concreto de propósito: nomeia o pacote que já existe no gateway e a
 * rota que não existe. "Em breve" não ajuda ninguém a decidir nada; isto aqui é
 * a lista de trabalho.
 */
const PENDENTE: Partial<Record<SectionId, string>> = {
  memoria:
    "O gateway guarda a CONVERSA em SQLite (o store durável das sessões), que é outra coisa: memória é o fato que sobrevive à conversa e volta como contexto na próxima. Falta um CRUD de memórias no gateway e o recall injetando as melhores no prompt.",
  extensoes:
    "Inspecionar e importar pacote de extensão (Agent Skills, formato do Codex, formato do Claude) é leitura de pasta do disco, então o caminho é um comando do shell Rust — que hoje não expõe nenhum. Sem ele a tela não teria o que ler.",
  plugins:
    "O microkernel de plugins existe no gateway, com manifesto, perfis, efeitos reversíveis e rollback na falha de montagem. O que não existe é rota para LISTAR, salvar e remover plugin pela tela: hoje eles entram por arquivo, na subida do processo.",
  conectores:
    "O cliente MCP existe e fala JSON-RPC, mas os servidores vêm da configuração do gateway. Falta rota para cadastrar, testar (tools/list) e remover — e o token de cada conector teria de ir para o mesmo cofre das chaves de provedor, nunca para o estado da tela.",
  ship:
    "O empacotamento existe no gateway. O que não tem rota é a CONFIGURAÇÃO dele: raiz padrão do projeto, versão corrente e a política de aprovação do laço agêntico continuam decididas fora da tela.",
  vps: "O arquivo de catálogo já preserva uma seção `vps`, mas ela nunca sai no GET do catálogo — fica guardada como extra. Falta expor, e com ela o modelo do servidor: host, porta, usuário, autenticação por agente ou por arquivo de chave, e a passphrase indo direto ao cofre.",
  administracao:
    "A política decide tetos de delegação, quais ferramentas cada papel executa e quais modelos ele enxerga — só que ela é lida de arquivo quando o gateway sobe. Falta a rota de administração para grupo, prompt master, preço por modelo e relatoria de uso."
};

function Pendente({ id }: { id: SectionId }) {
  return (
    <div className="settings-section">
      <div className="settings-cardx">
        <div className="settings-cardx-title">
          <ShieldCheck size={13} aria-hidden />
          Ainda não configurável aqui
          <span className="settings-chip-pill">sem rota no gateway</span>
        </div>
        <p className="settings-help">{PENDENTE[id]}</p>
      </div>
      <p className="settings-help">
        O item fica no menu porque o assunto é do produto — tirá-lo seria fingir que a
        configuração não existe.
      </p>
    </div>
  );
}

function ConexaoSection() {
  const gatewayUrl = useApp((state) => state.gatewayUrl);
  const status = useApp((state) => state.status);
  const environment = useApp((state) => state.environment);
  const models = useApp((state) => state.models);
  const specialists = useApp((state) => state.specialists);

  // O endereço só é conhecido depois que o Rust responde de onde subiu o
  // gateway. Dizer isso é melhor que mostrar o padrão como se fosse o real.
  const url = gatewayUrl === "" ? "ainda descobrindo…" : gatewayUrl;

  return (
    <div className="settings-section">
      <div className="settings-cardx">
        <div className="settings-cardx-title">
          <PlugZap size={13} aria-hidden />
          Gateway
          <span className="settings-chip-pill" data-tone={status === "ready" ? "ok" : ""}>
            {STATUS_LABEL[status]}
          </span>
          <small>{url}</small>
        </div>
        <div className="settings-list">
          <Row label="Ambiente" value={environment} />
          <Row label="Modelos no catálogo" value={String(models.length)} />
          <Row label="Especialistas" value={String(specialists.length)} />
        </div>
        <p className="settings-help">
          O endereço não se digita aqui: quem sobe o gateway é o próprio aplicativo, e o Rust
          informa em que porta ele atendeu. Um campo editável criaria duas verdades.
        </p>
      </div>
      <p className="settings-help">
        O token do gateway e as chaves dos provedores ficam no cofre e não são exibidos aqui —
        nem por engano, nem em log.
      </p>
    </div>
  );
}

function MotoresSection({ client }: { client: CatalogClient | null }) {
  const models = useApp((state) => state.models);
  const activeModel = useApp((state) => state.activeModel);

  // O rótulo do modelo é do catálogo; um id fora da lista aparece como veio, e
  // marcado — inventar um nome bonito esconderia justamente a divergência.
  const known = models.find((model) => model.id === activeModel);
  const label =
    activeModel === ""
      ? "nenhum escolhido"
      : known
        ? `${known.label} · ${known.provider}${known.local ? " · local" : ""}`
        : `${activeModel} (fora da lista do gateway)`;

  return (
    <>
      <div className="settings-section">
        <div className="settings-cardx">
          <div className="settings-cardx-title">
            <Cpu size={13} aria-hidden />
            Modelo da conversa
            <span className="settings-head-spacer" />
            <span className="settings-chip-pill" data-tone="accent">
              {label}
            </span>
          </div>
          <p className="settings-help">
            Ele é trocado na barra superior, que é onde ele é usado; aqui se decide o que ENTRA
            na lista dela.
          </p>
        </div>
      </div>
      <CatalogSection client={client} scope="models" />
      <div className="settings-section">
        <div className="settings-cardx">
          <div className="settings-cardx-title">
            <Blocks size={13} aria-hidden />
            Presets de fusion
            <span className="settings-chip-pill">não existe neste produto</span>
          </div>
          <p className="settings-help">
            Fusion é vários modelos respondendo a mesma pergunta e um fundindo as respostas. O
            que existe aqui é a equipe de especialistas, que DIVIDE a tarefa em vez de repetir a
            pergunta em três modelos — e cobra uma vez por parte, não três vezes pelo todo.
          </p>
        </div>
      </div>
    </>
  );
}

function RuntimeSection() {
  const environments = useApp((state) => state.environments);
  const environment = useApp((state) => state.environment);
  const setEnvironment = useApp((state) => state.setEnvironment);

  return (
    <div className="settings-section">
      {environments.map((item) => {
        const Glyph = ENVIRONMENT_ICON[item.id] ?? Monitor;
        const ativo = item.id === environment;
        return (
          <div key={item.id} className="settings-cardx">
            <div className="settings-cardx-title">
              <Glyph size={13} strokeWidth={1.75} aria-hidden />
              {item.label}
              {ativo && (
                <span className="settings-chip-pill" data-tone="accent">
                  em uso
                </span>
              )}
              {item.available === false && (
                <span className="settings-chip-pill">indisponível</span>
              )}
              <span className="settings-head-spacer" />
              <small>{item.hint}</small>
            </div>
            {item.available === false && item.detail !== undefined && (
              <p className="settings-help">{item.detail}</p>
            )}
            <div className="settings-actions">
              <button
                type="button"
                className="settings-button"
                disabled={ativo || item.available === false}
                aria-label={`usar o ambiente ${item.label}`}
                onClick={() => setEnvironment(item.id)}
              >
                Usar
              </button>
            </div>
          </div>
        );
      })}
      <p className="settings-help">
        Um ambiente indisponível não é escolhível: oferecer seria prometer uma execução que
        falha depois, e o comando cairia na estação da pessoa em vez do contêiner. Baixar motor
        de inferência e modelo `.gguf` pela tela ainda não existe aqui — o modelo local entra
        pelo catálogo, como provedor de dialeto `local`.
      </p>
    </div>
  );
}

function AparenciaSection() {
  const theme = useApp((state) => state.theme);
  const setTheme = useApp((state) => state.setTheme);
  const specialists = useApp((state) => state.specialists);

  return (
    <div className="settings-section">
      <div className="settings-cardx">
        <div className="settings-cardx-title">
          <Palette size={13} aria-hidden />
          Tema
          <span className="settings-head-spacer" />
          <small>o botão da barra superior é o atalho</small>
        </div>
        <div className="settings-actions">
          <button
            type="button"
            className="settings-button"
            data-kind={theme === "light" ? "primary" : undefined}
            aria-pressed={theme === "light"}
            onClick={() => setTheme("light")}
          >
            <Sun size={13} aria-hidden />
            Claro
          </button>
          <button
            type="button"
            className="settings-button"
            data-kind={theme === "dark" ? "primary" : undefined}
            aria-pressed={theme === "dark"}
            onClick={() => setTheme("dark")}
          >
            <Moon size={13} aria-hidden />
            Escuro
          </button>
        </div>
      </div>

      <div className="settings-cardx">
        <div className="settings-cardx-title">
          <Bot size={13} aria-hidden />
          Especialistas
          <span className="settings-chip-pill">{specialists.length}</span>
        </div>
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
        <p className="settings-help">
          A cor de acento do app não se escolhe: ela é do especialista que está atendendo, e
          muda quando a conversa muda de dono. Esconder especialista também não — a barra
          lateral mostra a equipe inteira, e quem decide quem entra é a política.
        </p>
      </div>
    </div>
  );
}

export function SettingsPanel() {
  const setSettingsOpen = useApp((state) => state.setSettingsOpen);
  const [section, setSection] = useState<SectionId>("conexao");

  // O transporte é resolvido UMA vez por render do painel: as seções que falam
  // com o gateway recebem o mesmo cliente, e a que não fala ignora.
  const client = activeTransport();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setSettingsOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setSettingsOpen]);

  return (
    <div className="approval-backdrop" onMouseDown={() => setSettingsOpen(false)}>
      <section
        className="approval-card settings-card"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <header className="approval-head settings-head">
          <div className="settings-head-id">
            <span>
              <Settings size={15} aria-hidden />
            </span>
            <div>
              <strong id="settings-title">Configurações</strong>
              <small>AI-BOT</small>
            </div>
          </div>
          <span className="settings-head-spacer" />
          <button
            type="button"
            className="settings-button"
            data-kind="ghost"
            aria-label="fechar configurações"
            onClick={() => setSettingsOpen(false)}
          >
            <X size={14} aria-hidden />
          </button>
        </header>

        <div className="settings-layout">
          <nav className="settings-nav" aria-label="Seções de configuração">
            {NAV.map((item) => {
              const Glyph = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={section === item.id ? "active" : ""}
                  aria-current={section === item.id}
                  onClick={() => setSection(item.id)}
                >
                  <Glyph size={14} strokeWidth={1.75} aria-hidden />
                  {item.label}
                </button>
              );
            })}
          </nav>

          <div className="settings-content">
            <div className="settings-section">
              <header>
                <h3>{SECAO_TEXTO[section].titulo}</h3>
                <p>{SECAO_TEXTO[section].detalhe}</p>
              </header>
            </div>

            {section === "conexao" && <ConexaoSection />}
            {section === "motores" && <MotoresSection client={client} />}
            {section === "provedores" && <CatalogSection client={client} scope="providers" />}
            {section === "runtime" && <RuntimeSection />}
            {section === "aparencia" && <AparenciaSection />}
            {PENDENTE[section] !== undefined && <Pendente id={section} />}
          </div>
        </div>
      </section>
    </div>
  );
}

export default SettingsPanel;
