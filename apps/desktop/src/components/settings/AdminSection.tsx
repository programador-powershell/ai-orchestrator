"use client";

/**
 * Configurações → Administração — o console do admin.
 *
 * Esta tela é só um CLIENTE dos endpoints /v1/workspaces/{ws}/admin/*: a
 * autorização real (role >= admin) é do servidor. Ela nem aparece para quem
 * o bootstrap não marca como admin — mas escondê-la é cosmético; o endpoint
 * é o portão.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { CircleCheck, LoaderCircle, ShieldCheck, Trash2, UsersRound } from "lucide-react";
import { UI_MODES, type UiMode } from "@orchestrator/contracts";
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
    /**
     * Modelo por papel da equipe da aba Agent. Escolher o modelo é escolher
     * quanto gastar, então é decisão do admin. Papel vazio = modelo do módulo.
     */
    agentRoleModels?: Record<string, string>;
    /** Plugins válidos para todo o grupo. União entre grupos. */
    agentPlugins?: unknown[];
    /** Deixa a pessoa criar plugin próprio no agente dela. */
    userPluginsAllowed?: boolean;
    /** Programa único combinando ferramentas, interpretado no cliente. */
    codeModeAllowed?: boolean;
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
  fluxo: "Fluxo",
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

  /**
   * Os grupos como o SERVIDOR devolveu por último, fora do ciclo de render.
   *
   * O PATCH manda a política inteira e o servidor substitui o documento. Se o
   * corpo fosse montado a partir do `group` do render — que só muda depois do
   * refresh —, marcar "executa código" e, antes do roundtrip terminar, marcar
   * "code mode" faria o segundo PATCH sobrescrever o primeiro com o valor
   * velho: a flag de segurança voltava a desligada sem nenhum aviso.
   */
  const groupsRef = useRef<AdminGroup[]>([]);
  /**
   * Fila de gravações. Duas edições rápidas viram duas gravações em ORDEM,
   * cada uma montada sobre o resultado da anterior — é o que fecha a corrida
   * de vez, já que o servidor é last-write-wins por contrato.
   */
  const filaRef = useRef<Promise<void>>(Promise.resolve());

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
      if (groupsResponse.ok) {
        const lidos = (await groupsResponse.json()) as AdminGroup[];
        groupsRef.current = lidos;
        setGroups(lidos);
      }
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

  /** Enfileira uma gravação; cada uma vê o resultado da anterior. */
  function enfileirar(tarefa: () => Promise<void>): Promise<void> {
    filaRef.current = filaRef.current.then(tarefa, tarefa).catch(() => undefined);
    return filaRef.current;
  }

  /** O grupo como o servidor devolveu por último — nunca o do render. */
  function atual(id: string, fallback: AdminGroup): AdminGroup {
    return groupsRef.current.find((item) => item.id === id) ?? fallback;
  }

  /** Grava um pedaço da política do grupo, preservando o resto. */
  function patchPolicy(group: AdminGroup, patch: Partial<AdminGroup["policy"]>) {
    return enfileirar(async () => {
      const base = atual(group.id, group);
      const response = await call(`/groups/${group.id}`, {
        method: "PATCH",
        body: JSON.stringify({ policy: { ...base.policy, ...patch } })
      });
      if (response.ok) await refresh();
      else setNotice({ text: "não foi possível salvar a política do grupo", tone: "danger" });
    });
  }

  function toggleMode(group: AdminGroup, mode: UiMode) {
    return enfileirar(async () => {
      const base = atual(group.id, group);
      const modes = base.modes.includes(mode)
        ? base.modes.filter((item) => item !== mode)
        : [...base.modes, mode];
      const response = await call(`/groups/${group.id}`, { method: "PATCH", body: JSON.stringify({ modes }) });
      if (response.ok) await refresh();
    });
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
                  {/*
                    `defaultValue` + `onBlur`, como nos textareas vizinhos.
                    Com input CONTROLADO pelo estado do servidor e PATCH a cada
                    tecla, digitar "10" gravava 1 e depois 0 — o React
                    restaurava o valor antigo entre as teclas e o segundo
                    evento chegava num campo vazio. Teto 0 é delegação
                    bloqueada; ninguém pediu isso.
                  */}
                  <input
                    type="number"
                    min={0}
                    max={teto}
                    key={`${group.id}-${campo}-${group.policy[campo] ?? ""}`}
                    defaultValue={group.policy[campo] ?? ""}
                    placeholder="padrão"
                    onBlur={(event) => {
                      const bruto = event.target.value.trim();
                      const valor = bruto === "" ? undefined : Math.max(0, Math.min(Number(bruto) || 0, teto));
                      if (valor === (group.policy[campo] ?? undefined)) return;
                      void patchPolicy(group, { [campo]: valor });
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
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
              <label
                className="admx-group__cu"
                title="Permite que a pessoa crie plugin próprio, válido só no agente dela. Os plugins globais abaixo continuam valendo."
              >
                <input
                  type="checkbox"
                  checked={group.policy.userPluginsAllowed === true}
                  onChange={(event) => void patchPolicy(group, { userPluginsAllowed: event.target.checked })}
                />
                plugin próprio
              </label>
              <label
                className="admx-group__cu"
                title="O modelo entrega um programa único combinando ferramentas, interpretado por um subconjunto fechado no cliente. Cada chamada dentro dele mantém a aprovação."
              >
                <input
                  type="checkbox"
                  checked={group.policy.codeModeAllowed === true}
                  onChange={(event) => void patchPolicy(group, { codeModeAllowed: event.target.checked })}
                />
                code mode
              </label>
            </span>
            {/* Plugins globais do grupo. Uma ferramenta que aponta para um
                endpoint interno é decisão de arquitetura da empresa, não
                preferência de estação — por isso mora aqui. */}
            <label
              className="admx-group__block"
              title="Lista JSON de manifestos (ver a seção Plugins & trilha para o formato). União entre grupos; o primeiro id vence."
            >
              plugins globais (JSON)
              <textarea
                rows={3}
                placeholder='[{"id":"cep","name":"CEP","version":"1.0.0","tools":[…]}]'
                defaultValue={
                  group.policy.agentPlugins?.length ? JSON.stringify(group.policy.agentPlugins, null, 2) : ""
                }
                onBlur={(event) => {
                  const bruto = event.target.value.trim();
                  const atual = JSON.stringify(group.policy.agentPlugins ?? []);
                  if (!bruto) {
                    if (atual !== "[]") void patchPolicy(group, { agentPlugins: [] });
                    return;
                  }
                  try {
                    const lista = JSON.parse(bruto) as unknown;
                    if (!Array.isArray(lista)) {
                      setNotice({ text: "Os plugins globais devem ser uma lista.", tone: "danger" });
                      return;
                    }
                    // Só grava se mudou: o onBlur dispara a cada saída de foco.
                    if (JSON.stringify(lista) !== atual) void patchPolicy(group, { agentPlugins: lista });
                  } catch {
                    // Salvar JSON quebrado deixaria o grupo sem plugin nenhum
                    // sem o admin perceber.
                    setNotice({ text: "JSON inválido nos plugins globais — nada foi salvo.", tone: "danger" });
                  }
                }}
              />
            </label>
            {/* Modelo por papel da equipe. A escalação da aba Agent é fixa por
                complexidade; o que muda é QUEM ocupa cada cadeira — e isso é
                custo, não preferência. Vazio = modelo do módulo. */}
            <span className="admx-group__roles" title="Modelo de cada papel da equipe de agentes. Vazio usa o modelo do módulo.">
              {(["idea", "scope", "plan", "code", "review"] as const).map((papel) => (
                <label key={papel}>
                  {papel}
                  <input
                    defaultValue={group.policy.agentRoleModels?.[papel] ?? ""}
                    placeholder="padrão"
                    spellCheck={false}
                    onBlur={(event) => {
                      const valor = event.target.value.trim();
                      const atual = group.policy.agentRoleModels ?? {};
                      if ((atual[papel] ?? "") === valor) return;
                      const proximo = { ...atual };
                      if (valor) proximo[papel] = valor;
                      else delete proximo[papel];
                      void patchPolicy(group, { agentRoleModels: proximo });
                    }}
                  />
                </label>
              ))}
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
            placeholder="Você é o assistente corporativo da Orchestrator…"
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
