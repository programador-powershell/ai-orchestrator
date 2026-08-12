"use client";

/**
 * Configurações → Ship (build & deploy) e Servidor Openship.
 *
 * O cadastro de servidor NÃO tem campo de senha nem de chave privada: o
 * caminho padrão é o agente SSH (o app nunca vê segredo algum) e, quando a
 * chave está em arquivo cifrado, a passphrase vai direto para o keyring do SO
 * e nunca volta para o JS. Isso é o oposto do Openship original, que gravava
 * sshPassword e sshKeyPassphrase em JSON texto puro no userData.
 */

import { useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CircleCheck, LoaderCircle, Rocket, ServerCog, ShieldAlert, Trash2, Wrench } from "lucide-react";
import { APPROVAL_POLICIES, type ApprovalPolicy } from "../../lib/approval";
import {
  REMOTE_ACTIONS,
  emptyDraft,
  looksLikeSecret,
  needsConfirmation,
  newServer,
  passphraseAccount,
  validateDraft,
  type DeployServer,
  type ServerDraft
} from "../../lib/ship/server";
import { useApp } from "../../lib/store";

type Notice = { text: string; tone: "ok" | "warn" | "danger" } | null;

const isTauriHost = "__TAURI_INTERNALS__" in window;

const VAULT_URL = "https://vault.multiplikelabs.com/";

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

function NoticeLine({ notice }: { notice: Notice }) {
  if (!notice) return null;
  return <p className={`setx-notice ${notice.tone}`}>{notice.text}</p>;
}

/* ------------------------------ Ship ---------------------------------- */

export function ShipSection() {
  const settings = useApp((state) => state.settings);
  const updateSettings = useApp((state) => state.updateSettings);
  const [version, setVersion] = useState(() => window.localStorage.getItem("ship.version") ?? "V.1");
  const [root, setRoot] = useState(() => window.localStorage.getItem("code.root") ?? ".");

  return (
    <Section
      title="Ship (build & deploy)"
      detail="Como as abas Code e Agent carregam o projeto, rodam o pipeline e marcam a versão."
    >
      <div className="setx-card">
        <div className="setx-card-title">
          <Wrench size={13} />
          Loop agêntico
          <span className="chip">{settings.agentTools ? "ligado" : "desligado"}</span>
        </div>
        <p className="setx-hint">
          Com o loop ligado, o modelo lê arquivos, roda comandos e edita — sempre sujeito à política de aprovação. Este
          é o interruptor da administração; o composer não expõe mais esse controle ao usuário.
        </p>
        <div className="setx-row">
          <button
            className={`lg-toggle ${settings.agentTools ? "on" : ""}`}
            onClick={() => updateSettings({ agentTools: !settings.agentTools })}
          >
            <i />
            Ferramentas do agente
          </button>
        </div>
      </div>

      <div className="setx-card">
        <div className="setx-card-title">
          <ShieldAlert size={13} />
          Política de aprovação
        </div>
        <p className="setx-hint">
          Vale para todas as abas. O usuário também consegue trocar pelo seletor do composer — desmarque o loop acima se
          quiser tirar essa decisão dele.
        </p>
        <div className="setx-row">
          <label className="lg-field" style={{ flex: 1, minWidth: 240 }}>
            Política
            <select
              value={settings.approvalPolicy ?? "ask"}
              onChange={(event) => updateSettings({ approvalPolicy: event.target.value as ApprovalPolicy })}
            >
              {APPROVAL_POLICIES.map((policy) => (
                <option key={policy.id} value={policy.id}>
                  {policy.label} — {policy.hint}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="setx-card">
        <div className="setx-card-title">
          <Rocket size={13} />
          Projeto e versão
        </div>
        <p className="setx-hint">
          A versão segue o padrão da casa: <code>V.1</code> para UI/UX ou grande atualização, <code>V.1.1</code> para
          ganho de função, <code>V.1.1.1</code> para correção. O painel do rail só libera marcar quando o pipeline passa
          inteiro.
        </p>
        <div className="setx-grid">
          <label className="lg-field">
            Raiz padrão do projeto
            <input
              value={root}
              onChange={(event) => {
                setRoot(event.target.value);
                window.localStorage.setItem("code.root", event.target.value);
              }}
              placeholder="C:\\Users\\voce\\Code\\projeto"
              spellCheck={false}
            />
          </label>
          <label className="lg-field">
            Versão atual
            <input
              value={version}
              onChange={(event) => {
                setVersion(event.target.value);
                window.localStorage.setItem("ship.version", event.target.value);
              }}
              placeholder="V.1"
              spellCheck={false}
            />
          </label>
        </div>
      </div>
    </Section>
  );
}

/* --------------------------- Servidor Openship -------------------------- */

export function OpenshipSection() {
  const settings = useApp((state) => state.settings);
  const updateSettings = useApp((state) => state.updateSettings);
  const servers = settings.deployServers ?? [];

  const [draft, setDraft] = useState<ServerDraft>(emptyDraft);
  const [passphrase, setPassphrase] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);

  const issues = validateDraft(draft);
  const issueFor = (field: string) => issues.find((issue) => issue.field === field)?.message;
  const patch = (part: Partial<ServerDraft>) => setDraft((current) => ({ ...current, ...part }));

  async function save() {
    if (issues.length) {
      setNotice({ text: issues[0].message, tone: "warn" });
      return;
    }
    setBusy(true);
    try {
      const id = crypto.randomUUID();
      const server = newServer(id, draft, new Date().toISOString());
      // A passphrase vai direto ao keyring e some do state. Nunca entra no
      // zustand, nunca no persist, nunca em log.
      if (draft.authMethod === "keyFile" && passphrase) {
        await invoke("credential_store", { account: passphraseAccount(id), token: passphrase });
      }
      setPassphrase("");
      updateSettings({ deployServers: [...servers, server] });
      setDraft(emptyDraft());
      setNotice({ text: `Servidor "${server.name}" cadastrado.`, tone: "ok" });
    } catch (cause) {
      setNotice({ text: cause instanceof Error ? cause.message : String(cause), tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  async function remove(server: DeployServer) {
    // Apaga a credencial junto: sem isso acumulam entradas órfãs no
    // Gerenciador de Credenciais do Windows.
    await invoke("credential_delete", { account: passphraseAccount(server.id) }).catch(() => undefined);
    updateSettings({ deployServers: servers.filter((item) => item.id !== server.id) });
    setNotice({ text: `Servidor "${server.name}" removido.`, tone: "ok" });
  }

  return (
    <Section
      title="Servidor Openship"
      detail="O VPS ao qual o Orchestrator se conecta para build e deploy. Sem senha e sem chave privada neste formulário."
    >
      <div className="setx-card">
        <div className="setx-card-title">
          <ShieldAlert size={13} />
          Onde ficam as credenciais
        </div>
        <p className="setx-hint">
          Este formulário guarda só metadado. O caminho recomendado é <strong>agente SSH</strong> — você carrega a chave
          no agente do sistema e o app nunca vê segredo nenhum. Se a chave estiver em arquivo cifrado, informe o{" "}
          <strong>caminho</strong> e a passphrase vai para o cofre do sistema operacional; a interface só consulta se
          existe, nunca lê o valor. Chave e senha em si devem morar no{" "}
          <a href={VAULT_URL} target="_blank" rel="noreferrer">
            Vaultwarden
          </a>{" "}
          (ou AWS Secrets Manager / Passbolt em DEV).
        </p>
        {!isTauriHost ? (
          <p className="setx-notice warn">
            No navegador esta seção fica desabilitada: não há cofre do sistema, e guardar credencial em localStorage é
            exatamente o anti-padrão que estamos evitando.
          </p>
        ) : null}
      </div>

      {servers.length ? (
        <div className="setx-card">
          <div className="setx-card-title">
            <ServerCog size={13} />
            Servidores cadastrados
            <span className="chip">{servers.length}</span>
          </div>
          {servers.map((server) => (
            <div key={server.id} className="setx-row ship-server">
              <span className="ship-server__name">
                <strong>{server.name}</strong>
                <small>
                  {server.user}@{server.host}:{server.port} · {server.environment} · {server.remoteWorkdir}
                </small>
              </span>
              <span className="chip">{server.authMethod === "agent" ? "agente SSH" : "arquivo de chave"}</span>
              <button className="lg-button danger" onClick={() => void remove(server)} title="Remover servidor">
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="setx-card">
        <div className="setx-card-title">
          <ServerCog size={13} />
          Novo servidor
        </div>
        <div className="setx-grid">
          <label className="lg-field">
            Nome
            <input value={draft.name} onChange={(event) => patch({ name: event.target.value })} placeholder="VPS Openship — produção" />
          </label>
          <label className="lg-field">
            Host
            <input
              value={draft.host}
              onChange={(event) => patch({ host: event.target.value })}
              placeholder="deploy.exemplo.com"
              spellCheck={false}
            />
          </label>
          <label className="lg-field">
            Porta
            <input
              type="number"
              value={draft.port}
              onChange={(event) => patch({ port: Number(event.target.value) })}
              placeholder="22"
            />
          </label>
          <label className="lg-field">
            Usuário SSH
            <input
              value={draft.user}
              onChange={(event) => patch({ user: event.target.value })}
              placeholder="deploy"
              spellCheck={false}
            />
          </label>
          <label className="lg-field">
            Autenticação
            <select value={draft.authMethod} onChange={(event) => patch({ authMethod: event.target.value as ServerDraft["authMethod"] })}>
              <option value="agent">Agente SSH (recomendado — nenhum segredo no app)</option>
              <option value="keyFile">Arquivo de chave</option>
            </select>
          </label>
          <label className="lg-field">
            Ambiente
            <select
              value={draft.environment}
              onChange={(event) => patch({ environment: event.target.value as ServerDraft["environment"] })}
            >
              <option value="prod">Produção — confirma antes de mexer no serviço</option>
              <option value="staging">Homologação</option>
              <option value="dev">Desenvolvimento</option>
            </select>
          </label>
          <label className="lg-field">
            Rede
            <select value={draft.network} onChange={(event) => patch({ network: event.target.value as ServerDraft["network"] })}>
              <option value="internet">Internet (VPS)</option>
              <option value="corporate">Rede corporativa</option>
            </select>
          </label>
          <label className="lg-field">
            Pasta do projeto no servidor
            <input
              value={draft.remoteWorkdir}
              onChange={(event) => patch({ remoteWorkdir: event.target.value })}
              placeholder="/opt/openship/app"
              spellCheck={false}
            />
          </label>
        </div>

        {draft.authMethod === "keyFile" ? (
          <div className="setx-grid">
            <label className="lg-field">
              Caminho do arquivo de chave
              <input
                value={draft.keyPath ?? ""}
                onChange={(event) => {
                  const value = event.target.value;
                  // Recusa ativamente material de chave colado aqui.
                  if (looksLikeSecret(value)) {
                    setNotice({
                      text: "Isso é o conteúdo da chave. Guarde a chave no cofre e informe apenas o caminho do arquivo.",
                      tone: "danger"
                    });
                    return;
                  }
                  patch({ keyPath: value });
                }}
                placeholder="C:\\Users\\voce\\.ssh\\id_ed25519"
                spellCheck={false}
              />
            </label>
            <label className="lg-field">
              Passphrase da chave (vai para o cofre do sistema)
              <input
                type="password"
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                placeholder="opcional — só se a chave for cifrada"
              />
            </label>
          </div>
        ) : null}

        <div className="setx-grid">
          <label className="lg-field">
            Painel do Openship (opcional)
            <input
              value={draft.openshipUrl ?? ""}
              onChange={(event) => patch({ openshipUrl: event.target.value })}
              placeholder="https://painel.exemplo.com"
              spellCheck={false}
            />
          </label>
          <label className="lg-field">
            Item no cofre (opcional — rastreabilidade)
            <input
              value={draft.vaultItemRef ?? ""}
              onChange={(event) => patch({ vaultItemRef: event.target.value })}
              placeholder="Vaultwarden: VPS Openship prod"
              spellCheck={false}
            />
          </label>
        </div>

        {issues.length && draft.name ? <p className="setx-notice warn">{issues[0].message}</p> : null}
        {issueFor("secret") ? <p className="setx-notice danger">{issueFor("secret")}</p> : null}

        <div className="setx-actions">
          <button className="lg-button primary" onClick={() => void save()} disabled={busy || !isTauriHost}>
            {busy ? <LoaderCircle className="spin" size={13} /> : <CircleCheck size={13} />}
            Cadastrar servidor
          </button>
        </div>
        <NoticeLine notice={notice} />
      </div>

      <div className="setx-card">
        <div className="setx-card-title">
          <ShieldAlert size={13} />
          O que este cadastro ainda NÃO faz
        </div>
        <p className="setx-hint">
          A execução remota (SSH + Docker) não está implementada. Ela exige um crate SSH novo — dependência de cadeia de
          suprimentos — e dar shell em VPS de produção a um app com loop de agente é decisão de SI e de gestão de
          mudança. Quando entrar, os comandos serão um conjunto fechado ({REMOTE_ACTIONS.map((item) => item.label).join(", ")}),
          nunca comando livre vindo da interface ou do modelo, e produção
          {needsConfirmation({ environment: "prod" } as DeployServer, "up") ? " pedirá confirmação explícita" : ""}.
        </p>
      </div>
    </Section>
  );
}
