"use client";

/**
 * Configurações → Administração → Trilha de execuções do agente.
 *
 * Responde uma pergunta só: **o que a IA rodou na máquina de quem**. Não é o
 * relatório de custo (esse é o `UsageReport`, alimentado por `usage_events`) —
 * são perguntas diferentes, e por isso a trilha tem tabela própria.
 *
 * O filtro "só o que merece atenção" é o modo de uso real: numa revisão de
 * segurança ninguém lê 200 linhas de `pytest`, lê o que foi recusado, o que
 * falhou e o que por algum motivo rodou fora do Job Object.
 */

import { useCallback, useEffect, useState } from "react";
import { LoaderCircle, RefreshCw, ShieldAlert, Terminal, TriangleAlert } from "lucide-react";
import { useApp } from "../../lib/store";

interface AgentAction {
  at: string;
  agent: string;
  goal: string;
  command: string;
  approved: boolean;
  exitCode: number | null;
  durationMs: number;
  jailed: boolean;
  email: string | null;
  name: string | null;
}

const WINDOWS = [7, 30, 90];

/** Quem executou: e-mail é mais estável que nome de exibição. */
function quem(action: AgentAction): string {
  return action.email?.trim() || action.name?.trim() || "desconhecido";
}

function quando(iso: string): string {
  const data = new Date(iso);
  return Number.isNaN(data.getTime()) ? iso : data.toLocaleString("pt-BR");
}

export function AgentAuditLog() {
  const session = useApp((state) => state.session);
  const [items, setItems] = useState<AgentAction[]>([]);
  const [days, setDays] = useState(30);
  const [flagged, setFlagged] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const base = session
    ? `${session.baseUrl.replace(/\/$/, "")}/v1/workspaces/${session.workspaceId}/admin`
    : null;

  const refresh = useCallback(async () => {
    if (!base || !session) return;
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`${base}/agent-actions?days=${days}&flagged=${flagged}`, {
        headers: { Authorization: `Bearer ${session.accessToken}` }
      });
      if (!response.ok) {
        throw new Error(
          response.status === 403
            ? "sem permissão de administrador neste workspace"
            : `gateway respondeu ${response.status}`
        );
      }
      setItems(((await response.json()) as { items: AgentAction[] }).items ?? []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [base, session, days, flagged]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!session) {
    return <p className="setx-hint">Conecte-se ao gateway para ver a trilha de execuções.</p>;
  }

  const recusadas = items.filter((item) => !item.approved).length;
  const foraDoJob = items.filter((item) => item.jailed === false).length;

  return (
    <div className="audx">
      <div className="audx-toolbar">
        <div className="usgx-windows">
          {WINDOWS.map((value) => (
            <button key={value} className={`lg-chip ${days === value ? "active" : ""}`} onClick={() => setDays(value)}>
              {value} dias
            </button>
          ))}
        </div>
        <label className="audx-filter">
          <input type="checkbox" checked={flagged} onChange={(event) => setFlagged(event.target.checked)} />
          só o que merece atenção
        </label>
        <button className="lg-button" onClick={() => void refresh()} disabled={loading}>
          {loading ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}
        </button>
      </div>

      {error ? <p className="usgx-error">{error}</p> : null}

      {/* O comando é gravado JÁ REDIGIDO pelo cliente. Dizer isso aqui evita
          que alguém leia a trilha achando que ela é um cofre. */}
      <p className="setx-hint">
        Os comandos são gravados com os segredos conhecidos já removidos (<code>Bearer</code>, senhas, chaves de API).
        Segredo em formato desconhecido pode passar — a trilha responde <strong>o que foi executado</strong>, não guarda
        credencial.
      </p>

      {recusadas > 0 || foraDoJob > 0 ? (
        <p className="usgx-warn">
          <TriangleAlert size={12} />
          {recusadas > 0 ? `${recusadas} execução(ões) recusada(s)` : ""}
          {recusadas > 0 && foraDoJob > 0 ? " · " : ""}
          {foraDoJob > 0 ? `${foraDoJob} rodaram FORA do Job Object` : ""}
        </p>
      ) : null}

      <div className="audx-rows">
        {items.length ? (
          items.map((action, index) => (
            <article
              className={`audx-row ${action.approved ? "" : "audx-row--denied"}`}
              key={`${action.at}-${index}`}
            >
              <header>
                <strong>{quem(action)}</strong>
                <span className="audx-agent">{action.agent}</span>
                <small>{quando(action.at)}</small>
              </header>
              <pre className="audx-cmd">
                <Terminal size={11} /> {action.command}
              </pre>
              <footer>
                {action.approved ? (
                  <span className={action.exitCode === 0 ? "ok" : "bad"}>saída {action.exitCode ?? "?"}</span>
                ) : (
                  <span className="bad">
                    <ShieldAlert size={11} /> recusada — não executou
                  </span>
                )}
                <span>{Math.round(action.durationMs)}ms</span>
                {!action.jailed ? <span className="bad">sem Job Object</span> : null}
                {action.goal ? <small title={action.goal}>{action.goal}</small> : null}
              </footer>
            </article>
          ))
        ) : (
          <p className="setx-hint">
            {flagged ? "Nada com pendência nesta janela." : "Nenhuma execução registrada nesta janela."}
          </p>
        )}
      </div>
    </div>
  );
}
