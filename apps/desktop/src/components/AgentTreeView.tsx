"use client";

/**
 * Acionamento de agentes — a tela principal da aba Agent.
 *
 * Você declara um OBJETIVO; um agente raiz recebe e decide, em execução, se
 * divide o trabalho e em quantas partes. A árvore se forma na tela conforme
 * ele aciona subordinados. É diferente do flow builder (que continua na aba
 * "Fluxo"): lá o grafo é desenhado antes de rodar; aqui quem divide é o
 * modelo.
 *
 * A árvore não é decoração: é o único lugar onde dá para ver quantos agentes
 * foram acionados e quanto do trabalho é delegação. Sem ela, uma recursão
 * dirigida por modelo seria invisível até a fatura chegar.
 */

import { useRef, useState } from "react";
import {
  Bot,
  ChevronRight,
  CircleAlert,
  LoaderCircle,
  Play,
  Square,
  Wand2,
} from "lucide-react";
import type { EngineSelection } from "@ai-orchestrator/contracts";
import { Markdown } from "./Markdown";
import {
  effectiveLimits,
  flatten,
  summarize,
  type AgentTask,
  type TreeState,
} from "../lib/agentTree";
import { useApp } from "../lib/store";
import { runAgentGoal } from "../lib/agentRuntime";
import type { ToolCall } from "../lib/agent";
import type { EngineContext } from "../lib/engine";

const STATUS_LABEL: Record<AgentTask["status"], string> = {
  running: "rodando",
  "waiting-children": "aguardando subordinados",
  done: "concluído",
  failed: "falhou",
  cancelled: "cancelado",
};

interface PendingApproval {
  task: AgentTask;
  call: ToolCall;
  resolve: (allowed: boolean) => void;
}

export function AgentTreeView({
  selection,
  ctx,
  root,
  limits: limitsInput,
}: {
  selection: EngineSelection;
  ctx: EngineContext;
  root: string;
  limits?: { maxDepth?: number; maxChildren?: number; maxTotal?: number };
}) {
  const [goal, setGoal] = useState("");
  const [tree, setTree] = useState<TreeState | null>(null);
  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState("");
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  /**
   * Computer use nasce DESLIGADO. É a diferença entre um agente que lê e
   * explica e um que executa comando na máquina — quem liga é a pessoa.
   */
  const [computerUse, setComputerUse] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Os tetos são do ADMIN (política do grupo). O prop local só APERTA.
  const policy = useApp((state) => state.policy);
  const limits = effectiveLimits(
    policy
      ? { maxDepth: policy.agentMaxDepth, maxChildren: policy.agentMaxChildren, maxTotal: policy.agentMaxTotal }
      : null,
    limitsInput
  );
  const computerUseAllowed = policy?.computerUseAllowed ?? false;

  async function start() {
    if (running || !goal.trim()) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setStage("");
    try {
      await runAgentGoal({
        goal: goal.trim(),
        selection,
        ctx,
        limits,
        root,
        signal: controller.signal,
        computerUse: computerUse && computerUseAllowed,
        // Code mode só existe se a política do grupo abrir. As ferramentas
        // liberadas para o programa são as de LEITURA mais a gravação: cada
        // uma continua pedindo aprovação lá dentro.
        codeModeTools: policy?.codeModeAllowed
          ? ["fs_read", "fs_list", "search", "fs_write"]
          : [],
        hooks: {
          onTree: setTree,
          onStage: setStage,
          // A aprovação continua sendo a mesma do resto do app: delegar não
          // pode virar caminho lateral para gravar arquivo sem gate.
          approve: (task, call) =>
            new Promise<boolean>((resolve) =>
              setApproval({ task, call, resolve }),
            ),
        },
      });
    } finally {
      setRunning(false);
      setStage("");
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
    // Uma aprovação pendente ficaria travada esperando clique.
    approval?.resolve(false);
    setApproval(null);
  }

  function toggle(id: string) {
    setOpenIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const nodes = tree ? flatten(tree) : [];
  const resumo = tree ? summarize(tree) : null;

  return (
    <div className="agtx">
      <div className="agtx-goal">
        <textarea
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          rows={2}
          placeholder="Descreva o OBJETIVO. O agente decide sozinho se divide o trabalho e em quantas partes."
          disabled={running}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey))
              void start();
          }}
        />
        {running ? (
          <button className="lg-button" onClick={stop}>
            <Square size={13} />
            Parar
          </button>
        ) : (
          <button
            className="lg-button primary"
            onClick={() => void start()}
            disabled={!goal.trim()}
          >
            <Play size={13} />
            Acionar
          </button>
        )}
      </div>

      <label className="agtx-cu">
        <input
          type="checkbox"
          checked={computerUse && computerUseAllowed}
          onChange={(event) => setComputerUse(event.target.checked)}
          disabled={running || !computerUseAllowed}
        />
        <span>
          Área de trabalho isolada (escrever e executar código)
          {!computerUseAllowed ? <em> — bloqueada pela política do seu grupo</em> : null}
          <small>
            O agente ganha uma pasta própria, apagada no fim, e roda comandos dentro de um Job Object. Cada execução
            pede sua aprovação. Não reduz privilégio: o comando roda com os <strong>seus</strong> direitos e alcança a rede.
          </small>
        </span>
      </label>

      <p className="agtx-limits">
        Até <strong>{limits.maxTotal}</strong> agentes nesta execução,{" "}
        <strong>{limits.maxChildren}</strong> por agente e{" "}
        <strong>{limits.maxDepth}</strong> nível(is) de profundidade. Os tetos
        são do servidor — o agente é avisado quando bate neles e conclui a
        tarefa ele mesmo.
      </p>

      {resumo ? (
        <div className="agtx-summary">
          <span>
            <Bot size={12} /> {resumo.total} agente(s)
          </span>
          <span>{resumo.done} concluído(s)</span>
          {resumo.failed > 0 ? (
            <span className="bad">{resumo.failed} falhou</span>
          ) : null}
          {resumo.running > 0 ? (
            <span className="live">{resumo.running} em curso</span>
          ) : null}
          <span>profundidade {resumo.maxDepth}</span>
          {stage ? <span className="agtx-stage">{stage}</span> : null}
        </div>
      ) : null}

      <div className="agtx-tree">
        {nodes.map((task) => {
          const open = openIds.has(task.id);
          const texto =
            task.status === "done" ? task.report : task.output || task.report;
          return (
            <article
              key={task.id}
              className={`agtx-node agtx-node--${task.status}`}
              style={{ marginLeft: task.depth * 18 }}
            >
              <button
                className="agtx-node-head"
                onClick={() => toggle(task.id)}
              >
                <ChevronRight size={12} className={open ? "open" : ""} />
                <strong>{task.title}</strong>
                <span className="agtx-badge">{STATUS_LABEL[task.status]}</span>
                {task.status === "running" ||
                task.status === "waiting-children" ? (
                  <LoaderCircle size={11} className="spin" />
                ) : null}
                {task.childIds.length > 0 ? (
                  <small>{task.childIds.length} subordinado(s)</small>
                ) : null}
              </button>
              {open ? (
                <div className="agtx-node-body">
                  <p className="agtx-task">{task.prompt}</p>
                  {texto ? (
                    <Markdown source={texto} />
                  ) : (
                    <small className="agtx-empty">sem saída ainda</small>
                  )}
                </div>
              ) : null}
            </article>
          );
        })}
      </div>

      {/* Aprovação de ferramenta mutante, com o agente que pediu identificado. */}
      {approval ? (
        <div className="agtx-approval">
          <CircleAlert size={13} />
          <div>
            <strong>
              “{approval.task.title}” quer executar{" "}
              <code>{approval.call.tool}</code>
            </strong>
            <pre>{JSON.stringify(approval.call.args, null, 2)}</pre>
          </div>
          <div className="agtx-approval-actions">
            <button
              className="lg-button primary"
              onClick={() => {
                approval.resolve(true);
                setApproval(null);
              }}
            >
              Permitir
            </button>
            <button
              className="lg-button ghost"
              onClick={() => {
                approval.resolve(false);
                setApproval(null);
              }}
            >
              Recusar
            </button>
          </div>
        </div>
      ) : null}

      {!tree && !running ? (
        <div className="agtx-hero">
          <Wand2 size={22} />
          <strong>Acione um agente.</strong>
          <p>
            Diga o objetivo — não o passo a passo. O agente investiga, decide se
            vale dividir e aciona subordinados com contexto próprio, que
            devolvem relatório para ele sintetizar.
          </p>
        </div>
      ) : null}
    </div>
  );
}
