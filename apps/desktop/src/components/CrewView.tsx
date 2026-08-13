"use client";

/**
 * Acionamento de agentes — a tela principal da aba Agent.
 *
 * **Não há campo nenhum aqui.** A pessoa escreve o que quer no composer, como
 * em qualquer outra aba, e o envio vira o objetivo da equipe. Um campo próprio
 * no corpo faria a mesma coisa de dois jeitos, e ninguém saberia qual manda.
 *
 * Quem decide o tamanho da equipe é o **modelo orquestrador**, não a interface:
 * não existe seletor de complexidade. Ele lê o pedido, escolhe o nível e a
 * equipe é montada na espinha spec-driven — constituição → spec → plano →
 * tarefas → revisão → CI. A tela mostra a decisão e o porquê, para ela poder
 * ser julgada.
 *
 * Os nós **aparecem conforme os agentes são contratados**. Mostrar a equipe
 * inteira de antemão pareceria progresso que não existe; o que interessa é ver
 * quem trabalha agora, e o que é série e o que é paralelo.
 *
 * A lista viva "modelo - papel" fica na barra lateral (`CrewRail`), lendo o
 * mesmo store.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { CircleAlert, LoaderCircle, Square, Users, Wand2 } from "lucide-react";
import type { EngineSelection } from "@ai-orchestrator/contracts";

import { Markdown } from "./Markdown";
import {
  COMPLEXITY_LABEL,
  roleStageLabel,
  ROLE_LABEL,
  rosterLine,
  summarizeCrew,
  type CrewMember,
  type ModelsByRole
} from "../lib/agentCrew";
import { runCrew, type CrewCall, type CrewDecision } from "../lib/agentCrewRun";
import { useCrew } from "../lib/crewStore";
import { goalBus } from "../lib/ops";
import { useApp } from "../lib/store";
import { chatOnce, modelLabel, type EngineContext } from "../lib/engine";

const STATUS_LABEL: Record<CrewMember["status"], string> = {
  hired: "contratado",
  working: "trabalhando",
  done: "concluído",
  failed: "falhou",
  cancelled: "cancelado"
};

export function CrewView({
  selection,
  ctx
}: {
  selection: EngineSelection;
  ctx: EngineContext;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [erro, setErro] = useState("");
  /** Como o nível foi decidido nesta execução — e por quê. */
  const [decision, setDecision] = useState<CrewDecision | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const policy = useApp((state) => state.policy);
  const catalog = useApp((state) => state.settings.modelCatalog);
  const crew = useCrew((state) => state.crew);
  const running = useCrew((state) => state.running);
  const outputs = useCrew((state) => state.outputs);
  const storeVerdict = useCrew((state) => state.verdict);
  // O objetivo vem do store, não de um campo local: quem o define é o composer.
  const goal = useCrew((state) => state.goal);

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

  const resumo = summarizeCrew(crew);

  /**
   * Aciona a equipe a partir do que veio do composer.
   *
   * A classificação NÃO acontece aqui: quem decide é o orquestrador, dentro do
   * `runCrew`. A tela só recebe a decisão pronta pelo `onPlan` e a mostra.
   */
  async function start(goal: string) {
    if (useCrew.getState().running || !goal.trim()) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setErro("");
    setDecision(null);
    // `running` já vale aqui, antes do orquestrador responder — senão um
    // segundo envio no composer abriria uma segunda equipe no mesmo objetivo.
    useCrew.getState().begin(goal.trim());

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
        models,
        call,
        signal: controller.signal,
        // O orquestrador é uma chamada de modelo curta, sem streaming: o que
        // interessa dela é a decisão, não o texto.
        orchestrate: ({ system, user, signal }) =>
          chatOnce(
            selection,
            "agent",
            [
              { role: "system", content: system },
              { role: "user", content: user }
            ],
            ctx,
            { onDelta: () => undefined },
            signal
          ),
        hooks: {
          onPlan: (plano, veredito, decidido) => {
            useCrew.getState().setPlan(veredito, plano);
            setDecision(decidido);
          },
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

  // O composer é a ENTRADA da aba: registrar aqui é o que dispensa campo
  // próprio no corpo.
  useEffect(() => goalBus.register("agent", (texto) => void start(texto)));

  return (
    <div className="crwx">
      {/* Barra do objetivo em curso. Só aparece quando há execução — sem
          formulário, o corpo fica vazio até a pessoa pedir algo. */}
      {goal ? (
        <div className="crwx-run">
          <span className="crwx-run-goal" title={goal}>
            {goal}
          </span>
          {decision ? (
            <span className="crwx-decision" title={decision.reason}>
              {storeVerdict ? COMPLEXITY_LABEL[storeVerdict.complexity] : "…"}
              <em>{decision.by === "orchestrator" ? "orquestrador" : decision.by === "forced" ? "forçado" : "reserva"}</em>
            </span>
          ) : (
            <span className="crwx-decision">
              <LoaderCircle size={11} className="spin" />
              orquestrando…
            </span>
          )}
          {running ? (
            <button className="lg-button ghost" onClick={stop}>
              <Square size={12} />
              Parar
            </button>
          ) : null}
        </div>
      ) : null}

      {/* O porquê da escalação. Uma decisão de equipe sem justificativa não dá
          para julgar — e é o modelo que decide, então ela precisa ficar à vista. */}
      {decision?.reason ? <small className="crwx-why">{decision.reason}</small> : null}

      {crew.length > 0 ? (
        <div className="crwx-summary">
          <span>
            <Users size={12} /> {resumo.total} contratado(s)
          </span>
          <span>{resumo.done} entregou</span>
          {resumo.failed > 0 ? <span className="bad">{resumo.failed} falhou</span> : null}
          {resumo.working > 0 ? <span className="live">{resumo.working} trabalhando</span> : null}
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

      {!crew.length && !goal ? (
        <div className="crwx-hero">
          <Wand2 size={22} />
          <strong>Diga o que você quer, no campo de mensagem abaixo.</strong>
          <p>
            O orquestrador lê o pedido e monta a equipe. Ela segue sempre a mesma ordem — constituição,
            especificação, plano, tarefas, revisão — e os agentes aparecem aqui conforme são contratados.
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
