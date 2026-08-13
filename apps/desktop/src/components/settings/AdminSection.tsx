"use client";

/**
 * Configurações → Administração — o console do admin.
 *
 * Esta tela é só um CLIENTE dos endpoints /v1/workspaces/{ws}/admin/*: a
 * autorização real (role >= admin) é do servidor. Ela nem aparece para quem
 * o bootstrap não marca como admin — mas escondê-la é cosmético; o endpoint
 * é o portão.
 */

import { useEffect, useState, type ReactNode } from "react";
import { CircleCheck, LoaderCircle, ShieldCheck, Trash2, UsersRound } from "lucide-react";
import { UI_MODES, type UiMode } from "@ai-orchestrator/contracts";
import { useApp } from "../../lib/store";
import { UsageReport } from "./UsageReport";
import { AgentAuditLog } from "./AgentAuditLog";

interface AdminGroup {
  id: string;
  adObjectId: string;
  name: string;
  modes: string[];
  policy: {
    agentTools?: boolean;
    approvalPolicy?: string;
    byokAllowed?: boolean;
    localRuntimeAllowed?: boolean;
    effortMax?: number;
    /* Modelo de agente: tetos e computer use, definidos aqui e não no cliente. */
    agentMaxDepth?: number;
    agentMaxChildren?: number;
    agentMaxTotal?: number;
    computerUseAllowed?: boolean;
    /** União entre grupos — bloquear num grupo não é desfeito por outro. */
    blockedDomains?: string[];
  };
  members: number;
}

type Notice = { text: string; tone: "ok" | "warn" | "danger" } | null;

const MODE_LABELS: Record<UiMode, string> = {
  chat: "Chat",
  code: "Code",
  office: "Office",
  design: "Design",
  data: "Data",
  work: "Work",
  security: "Security",
  agent: "Agent",
  tune: "Tuning"
};

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

export function AdminSection() {
  const session = useApp((state) => state.session);
  const profile = useApp((state) => state.profile);
  const [groups, setGroups] = useState<AdminGroup[]>([]);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);

  const [draftName, setDraftName] = useState("");
  const [draftObjectId, setDraftObjectId] = useState("");
  const [draftModes, setDraftModes] = useState<UiMode[]>(["chat"]);

  const [masterContent, setMasterContent] = useState("");
  const [masterAppend, setMasterAppend] = useState(true);
  const [masterMax, setMasterMax] = useState(2000);

  const base = session ? `${session.baseUrl.replace(/\/$/, "")}/v1/workspaces/${session.workspaceId}/admin` : null;

  async function call(path: string, init: RequestInit = {}): Promise<Response> {
    if (!base || !session) throw new Error("sem sessão com o gateway");
    return fetch(`${base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {})
      }
    });
  }

  async function refresh() {
    try {
      const [groupsResponse, masterResponse] = await Promise.all([call("/groups"), call("/prompt-master")]);
      if (groupsResponse.ok) setGroups((await groupsResponse.json()) as AdminGroup[]);
      if (masterResponse.ok) {
        const master = (await masterResponse.json()) as {
          content: string;
          allowLocalAppend: boolean;
          localMaxChars: number;
        } | null;
        if (master) {
          setMasterContent(master.content);
          setMasterAppend(master.allowLocalAppend);
          setMasterMax(master.localMaxChars);
        }
      }
    } catch (cause) {
      setNotice({ text: cause instanceof Error ? cause.message : String(cause), tone: "danger" });
    }
  }

  useEffect(() => {
    if (base) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);

  if (!session) {
    return (
      <Section title="Administração" detail="Grupos do AD, módulos por grupo e prompt master do workspace.">
        <p className="setx-notice warn">Conecte-se ao gateway para administrar a política.</p>
      </Section>
    );
  }

  async function createGroup() {
    setBusy(true);
    try {
      const response = await call("/groups", {
        method: "POST",
        body: JSON.stringify({ adObjectId: draftObjectId, name: draftName, modes: draftModes })
      });
      if (!response.ok) throw new Error(`gateway respondeu ${response.status}`);
      setDraftName("");
      setDraftObjectId("");
      setDraftModes(["chat"]);
      setNotice({ text: "Grupo salvo.", tone: "ok" });
      await refresh();
    } catch (cause) {
      setNotice({ text: cause instanceof Error ? cause.message : String(cause), tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  /** Grava um pedaço da política do grupo, preservando o resto. */
  async function patchPolicy(group: AdminGroup, patch: Partial<AdminGroup["policy"]>) {
    const response = await call(`/groups/${group.id}`, {
      method: "PATCH",
      body: JSON.stringify({ policy: { ...group.policy, ...patch } })
    });
    if (response.ok) await refresh();
    else setNotice({ text: "não foi possível salvar a política do grupo", tone: "danger" });
  }

  async function toggleMode(group: AdminGroup, mode: UiMode) {
    const modes = group.modes.includes(mode)
      ? group.modes.filter((item) => item !== mode)
      : [...group.modes, mode];
    const response = await call(`/groups/${group.id}`, { method: "PATCH", body: JSON.stringify({ modes }) });
    if (response.ok) await refresh();
  }

  async function removeGroup(group: AdminGroup) {
    const response = await call(`/groups/${group.id}`, { method: "DELETE" });
    if (response.ok) {
      setNotice({ text: `Grupo "${group.name}" removido.`, tone: "ok" });
      await refresh();
    }
  }

  async function saveMaster() {
    setBusy(true);
    try {
      const response = await call("/prompt-master", {
        method: "PUT",
        body: JSON.stringify({ content: masterContent, allowLocalAppend: masterAppend, localMaxChars: masterMax })
      });
      if (!response.ok) throw new Error(`gateway respondeu ${response.status}`);
      setNotice({ text: "Prompt master publicado — os clientes herdam no próximo bootstrap.", tone: "ok" });
    } catch (cause) {
      setNotice({ text: cause instanceof Error ? cause.message : String(cause), tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="Administração"
      detail={`Grupos do AD, módulos por grupo e prompt master. Workspace: ${profile?.workspaceName ?? session.workspaceId}.`}
    >
      <div className="setx-card">
        <div className="setx-card-title">
          <UsersRound size={13} />
          Grupos e módulos
          <span className="chip">{groups.length}</span>
          <small>união dos grupos do usuário; sem grupo casado, nada aparece</small>
        </div>
        {groups.map((group) => (
          <div key={group.id} className="admx-group">
            <span className="admx-group__name">
              <strong>{group.name}</strong>
              <small>
                {group.adObjectId} · {group.members} usuário(s)
              </small>
            </span>
            <span className="admx-group__modes">
              {UI_MODES.map((mode) => (
                <button
                  key={mode}
                  className={`chip${group.modes.includes(mode) ? " accent" : ""}`}
                  onClick={() => void toggleMode(group, mode)}
                  title={group.modes.includes(mode) ? "Clique para bloquear" : "Clique para liberar"}
                >
                  {MODE_LABELS[mode]}
                </button>
              ))}
            </span>
            {/* Modelo de agente do grupo. Fica aqui e não no cliente porque
                define quanto uma execução pode custar — e quem paga é a
                empresa. Vazio = usa o padrão do servidor. */}
            <span className="admx-group__agent">
              {(
                [
                  ["agentMaxDepth", "níveis", 5],
                  ["agentMaxChildren", "filhos", 10],
                  ["agentMaxTotal", "total", 60]
                ] as const
              ).map(([campo, rotulo, teto]) => (
                <label key={campo} title={`Teto de ${rotulo} na delegação (máx. ${teto})`}>
                  {rotulo}
                  <input
                    type="number"
                    min={0}
                    max={teto}
                    value={group.policy[campo] ?? ""}
                    placeholder="padrão"
                    onChange={(event) => {
                      const bruto = event.target.value.trim();
                      void patchPolicy(group, {
                        [campo]: bruto === "" ? undefined : Math.max(0, Math.min(Number(bruto) || 0, teto))
                      });
                    }}
                  />
                </label>
              ))}
              <label
                className="admx-group__cu"
                title="Permite ao agente escrever e EXECUTAR código na estação (área isolada). Ver docs/adr-computer-use.md"
              >
                <input
                  type="checkbox"
                  checked={group.policy.computerUseAllowed === true}
                  onChange={(event) => void patchPolicy(group, { computerUseAllowed: event.target.checked })}
                />
                executa código
              </label>
            </span>
            {/* Blocklist: a lista efetiva é a UNIÃO dos grupos do usuário —
                bloquear em um grupo não é desfeito por pertencer a outro. */}
            <label className="admx-group__block" title="Um domínio por linha. exemplo.com pega os subdomínios; *.exemplo.com pega só eles.">
              domínios bloqueados
              <textarea
                rows={2}
                placeholder="facebook.com&#10;*.tiktok.com"
                defaultValue={(group.policy.blockedDomains ?? []).join("\n")}
                onBlur={(event) => {
                  const lista = event.target.value
                    .split(/[\n,;]+/)
                    .map((item) => item.trim().toLowerCase())
                    .filter(Boolean);
                  const atual = group.policy.blockedDomains ?? [];
                  // Só grava se mudou: o onBlur dispara a cada saída de foco.
                  if (lista.join("|") !== atual.join("|")) void patchPolicy(group, { blockedDomains: lista });
                }}
              />
            </label>
            <button className="lg-button danger" onClick={() => void removeGroup(group)} title="Remover grupo">
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        <div className="setx-grid">
          <label className="lg-field">
            Nome do grupo
            <input value={draftName} onChange={(event) => setDraftName(event.target.value)} placeholder="Tecnologia" />
          </label>
          <label className="lg-field">
            ObjectId do AD (ou nome da app role)
            <input
              value={draftObjectId}
              onChange={(event) => setDraftObjectId(event.target.value)}
              placeholder="9f3c… ou grupo-ti"
              spellCheck={false}
            />
          </label>
        </div>
        <div className="setx-row admx-draft-modes">
          {UI_MODES.map((mode) => (
            <button
              key={mode}
              className={`chip${draftModes.includes(mode) ? " accent" : ""}`}
              onClick={() =>
                setDraftModes((current) =>
                  current.includes(mode) ? current.filter((item) => item !== mode) : [...current, mode]
                )
              }
            >
              {MODE_LABELS[mode]}
            </button>
          ))}
        </div>
        <div className="setx-actions">
          <button
            className="lg-button primary"
            disabled={busy || !draftName.trim() || !draftObjectId.trim()}
            onClick={() => void createGroup()}
          >
            {busy ? <LoaderCircle className="spin" size={13} /> : <CircleCheck size={13} />}
            Salvar grupo
          </button>
        </div>
      </div>

      <div className="setx-card">
        <div className="setx-card-title">
          <ShieldCheck size={13} />
          Prompt master do workspace
        </div>
        <p className="setx-hint">
          Entra PRIMEIRO no sistema de toda conversa de todo cliente conectado. O prompt local de cada estação só
          complementa — e apenas se permitido aqui.
        </p>
        <label className="lg-field">
          Conteúdo
          <textarea
            value={masterContent}
            onChange={(event) => setMasterContent(event.target.value)}
            rows={6}
            placeholder="Você é o assistente corporativo da Multiplike…"
            spellCheck={false}
          />
        </label>
        <div className="setx-row">
          <button className={`lg-toggle ${masterAppend ? "on" : ""}`} onClick={() => setMasterAppend(!masterAppend)}>
            <i />
            Permitir complemento local
          </button>
          <label className="lg-field" style={{ maxWidth: 180 }}>
            Teto do complemento (chars)
            <input
              type="number"
              value={masterMax}
              onChange={(event) => setMasterMax(Math.max(0, Number(event.target.value)))}
            />
          </label>
        </div>
        <div className="setx-actions">
          <button className="lg-button primary" disabled={busy} onClick={() => void saveMaster()}>
            {busy ? <LoaderCircle className="spin" size={13} /> : <CircleCheck size={13} />}
            Publicar
          </button>
        </div>
        {notice ? <p className={`setx-notice ${notice.tone}`}>{notice.text}</p> : null}
      </div>

      {/* Relatoria de uso e custo — mesma autorização de admin do resto. */}
      <div className="setx-block">
        <h4>Relatoria de uso</h4>
        <p className="setx-hint">
          Consumo e custo por usuário, grupo, modelo e dia. Os números vêm dos eventos registrados pelo gateway.
        </p>
        <UsageReport />
      </div>

      {/* Trilha de execuções: pergunta diferente da relatoria de custo, por
          isso vem em bloco próprio e sai de outra tabela. */}
      <div className="setx-block">
        <h4>Execuções do agente na estação</h4>
        <p className="setx-hint">
          O que a IA executou na máquina de cada usuário, com aprovações e recusas. Alimentado pelas ações de{" "}
          <code>computer_exec</code> — ver <code>docs/adr-computer-use.md</code>.
        </p>
        <AgentAuditLog />
      </div>
    </Section>
  );
}
