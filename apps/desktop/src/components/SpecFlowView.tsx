"use client";

/**
 * Fluxo spec-driven — a terceira superfície da aba Agent.
 *
 * Constituição → especificação → plano → tarefas, cada etapa gerada pelo
 * modelo e **revisada por uma pessoa** antes da seguinte. As tarefas viram
 * execução pelos mesmos agentes do acionamento.
 *
 * Duas coisas que a tela faz questão de mostrar:
 *
 * - **Aprovar é um ato humano.** Nenhuma etapa avança sozinha. Editar uma
 *   etapa derruba a aprovação das posteriores — carimbar plano feito em cima
 *   de uma spec que mudou seria pior que não ter aprovação nenhuma.
 * - **Tarefa sem verificação é sinalizada.** "Concluído" sem critério é
 *   opinião; o cartão avisa em vez de deixar passar.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CircleCheck,
  Download,
  FileText,
  LoaderCircle,
  Play,
  Sparkles,
  Square,
  TriangleAlert
} from "lucide-react";
import type { EngineSelection } from "@ai-orchestrator/contracts";
import { Markdown } from "./Markdown";
import type { ToolCall } from "../lib/agent";
import { chatOnce, type EngineContext } from "../lib/engine";
import { runAgentGoal } from "../lib/agentRuntime";
import { useApprovalQueue } from "../lib/approvalQueue";
import { clampLimits } from "../lib/agentTree";
import {
  approveStage,
  canEnterStage,
  emptyDoc,
  isApproved,
  isStageFilled,
  nextPendingTask,
  parseDoc,
  patchTask,
  serializeDoc,
  setStage,
  SPEC_STORAGE_KEY,
  STAGE_HINT,
  STAGE_LABEL,
  STAGE_ORDER,
  stagePrompt,
  taskProgress,
  taskPrompt,
  toMarkdown,
  type SpecDoc,
  type StageId
} from "../lib/specKit";

export function SpecFlowView({
  selection,
  ctx,
  root
}: {
  selection: EngineSelection;
  ctx: EngineContext;
  root: string;
}) {
  const [doc, setDoc] = useState<SpecDoc>(() => emptyDoc());
  const [stage, setStageId] = useState<StageId>("constitution");
  const [pedido, setPedido] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [running, setRunning] = useState(false);
  const approvals = useApprovalQueue<{ label: string; call: ToolCall }>();
  const approval = approvals.current;
  const abortRef = useRef<AbortController | null>(null);
  /**
   * O documento COMMITADO, fora do ciclo de render.
   *
   * Gerar uma etapa leva um stream inteiro e executar tarefas leva minutos.
   * Nesse intervalo a pessoa pode corrigir um texto ou aprovar uma etapa —
   * e o `doc` capturado no clique já está velho. Commitar aquele valor
   * apagava a edição e a aprovação, em memória E no localStorage. Toda
   * escrita passa por aqui e é aplicada sobre o ÚLTIMO estado commitado.
   */
  const docRef = useRef<SpecDoc>(doc);

  // Restaura o documento salvo (o fluxo dura dias, não uma sessão).
  useEffect(() => {
    const stored = parseDoc(window.localStorage.getItem(SPEC_STORAGE_KEY));
    if (stored) {
      docRef.current = stored;
      setDoc(stored);
    }
  }, []);

  function commit(update: SpecDoc | ((current: SpecDoc) => SpecDoc)) {
    const next = typeof update === "function" ? update(docRef.current) : update;
    docRef.current = next;
    setDoc(next);
    try {
      window.localStorage.setItem(SPEC_STORAGE_KEY, serializeDoc(next));
    } catch {
      // storage cheio: o fluxo segue em memória
    }
  }

  const gate = canEnterStage(doc, stage);
  const progress = taskProgress(doc);

  async function gerar() {
    if (busy) return;
    if (!gate.ok) {
      setNotice(gate.message);
      return;
    }
    setBusy(true);
    setNotice("");
    const controller = new AbortController();
    abortRef.current = controller;
    let buffer = "";
    try {
      const texto = await chatOnce(
        selection,
        "agent",
        [
          {
            role: "system",
            content:
              "Você está num fluxo spec-driven. Responda APENAS com o documento pedido, em markdown, " +
              "sem preâmbulo nem comentário sobre o que vai fazer."
          },
          { role: "user", content: stagePrompt(doc, stage, pedido) }
        ],
        ctx,
        {
          onDelta: (delta) => {
            buffer += delta;
            // Mostra o texto crescendo, sem derrubar aprovação a cada token:
            // o commit só acontece no fim.
            setDoc((current) => applyDraft(current, stage, buffer));
          }
        },
        controller.signal
      );
      commit((current) => setStage(current, stage, texto, Date.now()));
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
      // Volta ao que estava salvo — rascunho parcial não vira documento.
      setDoc(docRef.current);
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  /** Executa as tarefas pendentes, uma a uma, pelos agentes. */
  async function executar() {
    if (running) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setNotice("");
    try {
      for (;;) {
        const task = nextPendingTask(docRef.current);
        if (!task || controller.signal.aborted) break;
        commit((current) => patchTask(current, task.id, { status: "running" }, Date.now()));
        try {
          const tree = await runAgentGoal({
            goal: taskPrompt(docRef.current, task),
            selection,
            ctx,
            limits: clampLimits({}),
            root,
            signal: controller.signal,
            hooks: {
              onTree: () => undefined,
              // Mesma trava do resto do app: ferramenta que muda estado só sai
              // com um humano dizendo sim. Recusar por padrão faria a execução
              // parecer funcionar sem nunca escrever nada. A fila existe porque
              // os subordinados rodam em paralelo e pedem ao mesmo tempo.
              approve: (agent, call) =>
                approvals.request({ label: `${task.title} · ${agent.title}`, call })
            }
          });
          const raiz = tree.tasks[tree.rootId];
          commit((current) =>
            patchTask(
              current,
              task.id,
              {
                status: raiz.status === "done" ? "done" : "failed",
                report: raiz.report
              },
              Date.now()
            )
          );
        } catch (cause) {
          commit((current) =>
            patchTask(
              current,
              task.id,
              { status: "failed", report: cause instanceof Error ? cause.message : String(cause) },
              Date.now()
            )
          );
        }
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }

  function exportar() {
    const blob = new Blob([toMarkdown(doc)], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${doc.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "spec"}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const conteudo = useMemo(() => {
    switch (stage) {
      case "constitution":
        return doc.constitution;
      case "spec":
        return doc.spec;
      case "plan":
        return doc.plan;
      case "tasks":
        return "";
    }
  }, [doc, stage]);

  const semVerificacao = doc.tasks.filter((task) => !task.verify.trim()).length;

  return (
    <div className="spkx">
      <div className="spkx-steps">
        {STAGE_ORDER.map((id, index) => {
          const filled = isStageFilled(doc, id);
          const ok = isApproved(doc, id);
          return (
            <button
              key={id}
              className={`spkx-step ${stage === id ? "active" : ""} ${ok ? "approved" : filled ? "filled" : ""}`}
              onClick={() => setStageId(id)}
            >
              <span className="spkx-step-n">{ok ? <CircleCheck size={12} /> : index + 1}</span>
              {STAGE_LABEL[id]}
            </button>
          );
        })}
        <button className="lg-button ghost" onClick={exportar} title="Baixar o documento em Markdown">
          <Download size={13} />
        </button>
      </div>

      <p className="spkx-hint">{STAGE_HINT[stage]}</p>
      {!gate.ok ? (
        <p className="spkx-block">
          <TriangleAlert size={12} /> {gate.message}
        </p>
      ) : null}
      {notice ? <p className="spkx-block">{notice}</p> : null}

      <div className="spkx-ask">
        <textarea
          rows={2}
          value={pedido}
          onChange={(event) => setPedido(event.target.value)}
          placeholder={
            stage === "constitution"
              ? "Contexto do time: stack, o que não se negocia, o que já deu errado antes…"
              : "Restrições ou contexto adicional (opcional)"
          }
          disabled={busy || !gate.ok}
        />
        <button className="lg-button primary" onClick={() => void gerar()} disabled={busy || !gate.ok}>
          {busy ? <LoaderCircle size={13} className="spin" /> : <Sparkles size={13} />}
          {busy ? "Gerando…" : `Gerar ${STAGE_LABEL[stage].toLowerCase()}`}
        </button>
      </div>

      {stage !== "tasks" ? (
        <div className="spkx-doc">
          {conteudo.trim() ? (
            <>
              <Markdown source={conteudo} />
              <div className="spkx-actions">
                {/*
                  Enquanto o modelo escreve a etapa (ou os agentes executam
                  tarefas), editar aqui é trabalho jogado fora: o texto na tela
                  é rascunho e o commit do fim substitui a etapa inteira. Melhor
                  travar o campo do que aceitar a edição e perdê-la em silêncio.
                */}
                <textarea
                  className="spkx-edit"
                  rows={6}
                  value={conteudo}
                  onChange={(event) =>
                    commit((current) => setStage(current, stage, event.target.value, Date.now()))
                  }
                  disabled={busy || running}
                  aria-label={`Editar ${STAGE_LABEL[stage]}`}
                />
                <button
                  className={`lg-button ${isApproved(doc, stage) ? "" : "primary"}`}
                  onClick={() => commit((current) => approveStage(current, stage, Date.now()))}
                  disabled={isApproved(doc, stage) || busy || running}
                >
                  <CircleCheck size={13} />
                  {isApproved(doc, stage) ? "Aprovada" : "Aprovar etapa"}
                </button>
              </div>
            </>
          ) : (
            <p className="spkx-empty">
              <FileText size={16} />
              Nada gerado ainda nesta etapa.
            </p>
          )}
        </div>
      ) : (
        <div className="spkx-tasks">
          {doc.tasks.length ? (
            <>
              <div className="spkx-progress">
                <span>
                  {progress.done}/{progress.total} concluída(s)
                  {progress.failed > 0 ? ` · ${progress.failed} falhou` : ""}
                </span>
                {running ? (
                  <button
                    className="lg-button"
                    onClick={() => {
                      abortRef.current?.abort();
                      // Sem isto a execução ficaria travada esperando clique —
                      // inclusive quem está atrás na fila e nem apareceu.
                      approvals.denyAll();
                    }}
                  >
                    <Square size={13} /> Parar
                  </button>
                ) : (
                  <button
                    className="lg-button primary"
                    onClick={() => void executar()}
                    disabled={!nextPendingTask(doc)}
                  >
                    <Play size={13} /> Executar pendentes
                  </button>
                )}
              </div>
              {semVerificacao > 0 ? (
                <p className="spkx-block">
                  <TriangleAlert size={12} />
                  {semVerificacao} tarefa(s) sem critério de verificação — “concluído” nelas será opinião, não fato.
                </p>
              ) : null}
              {doc.tasks.map((task, index) => (
                <article className={`spkx-task spkx-task--${task.status}`} key={task.id}>
                  <header>
                    <strong>
                      {index + 1}. {task.title}
                    </strong>
                    <span className="spkx-task-status">{task.status}</span>
                  </header>
                  <p>{task.detail}</p>
                  {task.verify ? (
                    <small className="spkx-verify">Verificação: {task.verify}</small>
                  ) : (
                    <small className="spkx-noverify">sem critério de verificação</small>
                  )}
                  {task.report ? <Markdown source={task.report} /> : null}
                </article>
              ))}
            </>
          ) : (
            <p className="spkx-empty">
              <FileText size={16} />
              Gere as tarefas a partir do plano aprovado.
            </p>
          )}
        </div>
      )}

      {approval ? (
        <div className="agtx-approval">
          <TriangleAlert size={13} />
          <div>
            <strong>
              “{approval.label}” quer executar <code>{approval.call.tool}</code>
            </strong>
            <pre>{JSON.stringify(approval.call.args, null, 2)}</pre>
            {approvals.pending > 1 ? (
              <span className="agtx-approval-fila">+{approvals.pending - 1} na fila</span>
            ) : null}
          </div>
          <div className="agtx-approval-actions">
            <button className="lg-button primary" onClick={() => approvals.answer(true)}>
              Permitir
            </button>
            <button className="lg-button ghost" onClick={() => approvals.answer(false)}>
              Recusar
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Rascunho em streaming — não passa por setStage para não derrubar aprovações. */
function applyDraft(doc: SpecDoc, stage: StageId, text: string): SpecDoc {
  switch (stage) {
    case "constitution":
      return { ...doc, constitution: text };
    case "spec":
      return { ...doc, spec: text };
    case "plan":
      return { ...doc, plan: text };
    case "tasks":
      return doc;
  }
}
