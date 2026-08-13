"use client";

/**
 * Acionamento de agentes — a tela principal da aba Agent.
 *
 * No prompt vai **só o objetivo** (e correções, quando a primeira volta não
 * serviu). O fluxo NÃO é desenhado pela pessoa nem inventado pelo modelo: é
 * pré-determinado pela complexidade do pedido e segue a espinha spec-driven —
 * constituição → spec → plano → tarefas → revisão → CI.
 *
 * Os nós **aparecem conforme os agentes são contratados** e ficam marcados
 * quando saem. Mostrar a equipe inteira de antemão pareceria progresso que não
 * existe; o que interessa é ver quem está trabalhando agora, e o que é série e
 * o que é paralelo.
 *
 * A lista viva "modelo - papel" fica na barra lateral (`CrewRail`), lendo o
 * mesmo store.
 */

import { useMemo, useRef, useState } from "react";
import { CircleAlert, LoaderCircle, Play, Square, Users, Wand2 } from "lucide-react";
import type { EngineSelection } from "@ai-orchestrator/contracts";

import { Markdown } from "./Markdown";
import {
  classifyComplexity,
  COMPLEXITY_LABEL,
  planCrew,
  roleStageLabel,
  ROLE_LABEL,
  rosterLine,
  summarizeCrew,
  type Complexity,
  type CrewMember,
  type ModelsByRole
} from "../lib/agentCrew";
import { runCrew, type CrewCall } from "../lib/agentCrewRun";
import { useCrew } from "../lib/crewStore";
import { useApp } from "../lib/store";
import { chatOnce, modelLabel, type EngineContext } from "../lib/engine";

const STATUS_LABEL: Record<CrewMember["status"], string> = {
  hired: "contratado",
  working: "trabalhando",
  done: "concluído",
  failed: "falhou",
  cancelled: "cancelado"
};

const NIVEIS: Complexity[] = ["trivial", "simples", "media", "alta"];

export function CrewView({
  selection,
  ctx
}: {
  selection: EngineSelection;
  ctx: EngineContext;
}) {
  const [goal, setGoal] = useState("");
  const [corrections, setCorrections] = useState("");
  /** Nível forçado pela pessoa; null = o classificado. */
  const [forced, setForced] = useState<Complexity | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [erro, setErro] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  const policy = useApp((state) => state.policy);
  const catalog = useApp((state) => state.settings.modelCatalog);
  const crew = useCrew((state) => state.crew);
  const running = useCrew((state) => state.running);
  const outputs = useCrew((state) => state.outputs);
  const storeVerdict = useCrew((state) => state.verdict);

  /**
   * Modelos por papel vêm da POLÍTICA do grupo. Escolher modelo é escolher
   * quanto gastar — não é preferência do usuário. O que o admin não definiu
   * cai no modelo do módulo.
   */
  const models: ModelsByRole = useMemo(
    () => ({
      byRole: policy?.agentRoleModels ?? {},
      fallback: selection.kind === "model" ? modelLabel(selection.target, catalog) : "modelo do módulo"
    }),
    [policy, selection, catalog]
  );

  // Classificação ao vivo: a pessoa vê a equipe ANTES de acionar.
  const verdict = useMemo(() => {
    const base = classifyComplexity(goal);
    return forced ? { ...base, complexity: forced } : base;
  }, [goal, forced]);
  const preview = useMemo(() => planCrew(verdict, models), [verdict, models]);
  const resumo = summarizeCrew(crew);

  async function start() {
    if (running || !goal.trim()) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setErro("");
    const store = useCrew.getState();
    store.start(goal.trim(), verdict, preview);

    // O streaming alimenta a barra lateral: sem isso o agente ficaria
    // "trabalhando" por minutos sem sinal nenhum de que algo acontece.
    const call: CrewCall = async ({ member, system, user, signal }) => {
      let escritos = 0;
      return chatOnce(
        selection,
        "agent",
        [
          { role: "system", content: system },
          { role: "user", content: user }
        ],
        ctx,
        {
          onDelta: (delta) => {
            escritos += delta.length;
            useCrew.getState().activity(member.id, `escrevendo · ${escritos} car.`);
          },
          onStage: (nota) => useCrew.getState().activity(member.id, nota)
        },
        signal
      );
    };

    try {
      await runCrew({
        goal: goal.trim(),
        corrections: corrections.trim() || undefined,
        verdict,
        models,
        call,
        signal: controller.signal,
        hooks: {
          onHire: (member) => useCrew.getState().hire(member),
          onActivity: (id, activity) => useCrew.getState().activity(id, activity),
          onFire: (id, status, output) => useCrew.getState().fire(id, status, output)
        }
      });
    } catch (cause) {
      setErro(cause instanceof Error ? cause.message : String(cause));
    } finally {
      useCrew.getState().stop();
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
    useCrew.getState().stop();
  }

  const mostraPreview = !crew.length && goal.trim().length > 0;

  return (
    <div className="crwx">
      <div className="crwx-goal">
        <textarea
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          rows={2}
          placeholder="Qual é o OBJETIVO? A equipe é escalada pela complexidade do que você pedir."
          disabled={running}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void start();
          }}
        />
        {running ? (
          <button className="lg-button" onClick={stop}>
            <Square size={13} />
            Parar
          </button>
        ) : (
          <button className="lg-button primary" onClick={() => void start()} disabled={!goal.trim()}>
            <Play size={13} />
            Acionar
          </button>
        )}
      </div>

      <input
        className="crwx-fix"
        value={corrections}
        onChange={(event) => setCorrections(event.target.value)}
        placeholder="Correções (opcional) — o que a volta anterior errou"
        disabled={running}
        spellCheck={false}
      />

      {/* A classificação fica visível e ajustável: uma heurística que decide
          sozinha e não mostra o porquê vira caixa-preta na primeira discordância. */}
      <div className="crwx-complex">
        <span className="crwx-complex-head">
          complexidade
          <strong>{COMPLEXITY_LABEL[verdict.complexity]}</strong>
          {forced ? <em>forçada</em> : null}
        </span>
        <span className="crwx-levels">
          {NIVEIS.map((nivel) => (
            <button
              key={nivel}
              className={`chip${verdict.complexity === nivel ? " accent" : ""}`}
              onClick={() => setForced(forced === nivel ? null : nivel)}
              disabled={running}
              title={forced === nivel ? "Clique para voltar ao classificado" : "Forçar este nível"}
            >
              {COMPLEXITY_LABEL[nivel]}
            </button>
          ))}
        </span>
        {verdict.signals.length > 0 && !forced ? (
          <small className="crwx-why">
            {verdict.signals.map((signal) => signal.reason).join(" · ")}
          </small>
        ) : null}
      </div>

      {mostraPreview ? (
        <div className="crwx-preview">
          <Users size={12} />
          <span>
            equipe: {preview.slots.map((slot) => `${slot.model} - ${ROLE_LABEL[slot.role]}`).join(" · ")}
          </span>
        </div>
      ) : null}

      {crew.length > 0 ? (
        <div className="crwx-summary">
          <span>
            <Users size={12} /> {resumo.total} contratado(s)
          </span>
          <span>{resumo.done} entregou</span>
          {resumo.failed > 0 ? <span className="bad">{resumo.failed} falhou</span> : null}
          {resumo.working > 0 ? <span className="live">{resumo.working} trabalhando</span> : null}
          {storeVerdict ? <span className="crwx-stage">{COMPLEXITY_LABEL[storeVerdict.complexity]}</span> : null}
        </div>
      ) : null}

      {erro ? (
        <div className="crwx-error">
          <CircleAlert size={13} />
          {erro}
        </div>
      ) : null}

      {/* Um nó por agente contratado, na ordem em que entraram. Agentes da
          mesma onda ficam lado a lado — é assim que o paralelo fica visível. */}
      <div className="crwx-flow">
        {groupByWave(crew).map(([wave, membros]) => (
          <div className="crwx-wave" key={wave}>
            {membros.map((member) => {
              const texto = outputs[member.id] ?? "";
              const aberto = openId === member.id;
              return (
                <article key={member.id} className={`crwx-node crwx-node--${member.status}`}>
                  <button
                    className="crwx-node-head"
                    onClick={() => setOpenId(aberto ? null : member.id)}
                    disabled={!texto}
                  >
                    <span className="crwx-role">{ROLE_LABEL[member.role]}</span>
                    <strong>{member.model}</strong>
                    {member.status === "working" || member.status === "hired" ? (
                      <LoaderCircle size={11} className="spin" />
                    ) : null}
                    <span className="crwx-badge">{STATUS_LABEL[member.status]}</span>
                  </button>
                  <small className="crwx-stagename">{roleStageLabel(member.role)}</small>
                  {aberto && texto ? (
                    <div className="crwx-node-body">
                      <Markdown source={texto} />
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        ))}
      </div>

      {!crew.length && !goal.trim() ? (
        <div className="crwx-hero">
          <Wand2 size={22} />
          <strong>Diga o objetivo.</strong>
          <p>
            A equipe é escalada pela complexidade do pedido e segue sempre a mesma ordem — constituição,
            especificação, plano, tarefas, revisão. Os agentes aparecem aqui conforme são contratados.
          </p>
        </div>
      ) : null}
    </div>
  );
}

/** Agrupa por onda preservando a ordem de contratação dentro de cada uma. */
function groupByWave(crew: CrewMember[]): Array<[number, CrewMember[]]> {
  const mapa = new Map<number, CrewMember[]>();
  for (const member of crew) {
    const lista = mapa.get(member.wave);
    if (lista) lista.push(member);
    else mapa.set(member.wave, [member]);
  }
  return [...mapa.entries()].sort((a, b) => a[0] - b[0]);
}

/**
 * Lista viva da barra lateral — `modelo - papel`, em ordem de contratação.
 *
 * É o painel que responde "o que os agentes estão fazendo agora". Cresce a
 * cada contratação, em série ou em paralelo, e a linha some do estado ativo
 * quando o agente é demitido.
 */
export function CrewRail() {
  const crew = useCrew((state) => state.crew);
  const running = useCrew((state) => state.running);
  const goal = useCrew((state) => state.goal);
  const verdict = useCrew((state) => state.verdict);

  if (!crew.length) {
    return (
      <>
        <span className="eyebrow">Equipe</span>
        <small className="crwr-hint">
          Ninguém contratado ainda. Descreva o objetivo e a equipe aparece aqui conforme entra.
        </small>
      </>
    );
  }

  return (
    <>
      <span className="eyebrow">
        Equipe · {crew.length}
        {verdict ? ` · ${COMPLEXITY_LABEL[verdict.complexity]}` : ""}
      </span>
      {goal ? <small className="crwr-goal">{goal}</small> : null}
      <div className="crwr-list">
        {crew.map((member) => (
          <div key={member.id} className={`crwr-row st-${member.status}`}>
            <i className="crwr-dot" />
            <span className="crwr-line">{rosterLine(member)}</span>
            <small>{member.activity || STATUS_LABEL[member.status]}</small>
          </div>
        ))}
      </div>
      {running ? <small className="crwr-hint">em execução…</small> : null}
    </>
  );
}
