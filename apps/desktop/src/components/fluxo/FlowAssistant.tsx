"use client";

/**
 * O assistente do fluxo — a coluna da esquerda.
 *
 * Ele NÃO devolve o fluxo pronto: consome o stream do modelo e aplica cada
 * operação no canvas assim que a linha fecha (ver `assistant.ts` e `ops.ts`).
 * Por isso o histórico aqui mostra o que ele FEZ ("+ nó Enviar WhatsApp"),
 * e não o texto que ele escreveu — o texto é a lista de operações, ilegível
 * para quem está olhando o canvas.
 *
 * O mesmo campo cria e edita: "remova a espera" e "troque a mensagem" passam
 * pelo mesmo caminho, porque o pedido vai junto com o fluxo atual e seus ids.
 */

import { useEffect, useRef, useState } from "react";
import { CircleAlert, LoaderCircle, Send, Sparkles, Square } from "lucide-react";

import { buildRequest, createOpStream, heuristicOps } from "../../lib/fluxo/assistant";
import { useFluxo } from "../../lib/fluxo/store";
import type { FlowOp } from "../../lib/fluxo/ops";
import { chatOnce, type EngineContext } from "../../lib/engine";
import { useApp } from "../../lib/store";
import type { EngineSelection } from "@ai-orchestrator/contracts";

const EXEMPLOS = [
  "Quando chegar um lead novo, mandar boas-vindas no WhatsApp",
  "Se o orçamento passar de 5 mil, marcar como quente e avisar o gestor",
  "Se o lead não responder em 3 dias, enviar uma retomada",
  "Quando o cartão atrasar, criar tarefa de cobrança",
  "Troque a mensagem do WhatsApp e remova a espera"
];

/** Uma linha do histórico: o que a operação fez, em português. */
function descreve(op: FlowOp): string | null {
  switch (op.op) {
    case "clear":
      return "limpou o canvas";
    case "add":
      return `+ ${op.data.label || op.type}`;
    case "update":
      return `ajustou ${op.data.label ?? op.id}`;
    case "remove":
      return `− removeu ${op.id}`;
    case "connect":
      return `ligou ${op.from} → ${op.to}${op.branch ? ` (${op.branch === "true" ? "sim" : "não"})` : ""}`;
    case "disconnect":
      return `desligou ${op.from} → ${op.to}`;
    case "rename":
      return `renomeou para “${op.name}”`;
    default:
      return null;
  }
}

export function FlowAssistant({ selection, ctx }: { selection: EngineSelection; ctx: EngineContext }) {
  const [pedido, setPedido] = useState("");
  const [passos, setPassos] = useState<string[]>([]);
  const [erro, setErro] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const listaRef = useRef<HTMLDivElement>(null);

  const building = useFluxo((state) => state.building);
  const apply = useFluxo((state) => state.apply);
  const beginBuild = useFluxo((state) => state.beginBuild);
  const endBuild = useFluxo((state) => state.endBuild);
  const activeId = useFluxo((state) => state.activeId);

  useEffect(() => {
    listaRef.current?.scrollTo({ top: listaRef.current.scrollHeight });
  }, [passos]);

  // Sair da aba com uma montagem em curso deixaria a chamada correndo para um
  // componente morto — e o `building` preso em true.
  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    []
  );

  async function enviar() {
    const texto = pedido.trim();
    if (!texto || building || !activeId) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setErro("");
    setPassos([]);
    setPedido("");
    beginBuild(texto);

    const registrar = (op: FlowOp) => {
      apply(op);
      const linha = descreve(op);
      if (linha) setPassos((atual) => [...atual, linha]);
    };

    try {
      const stream = createOpStream(registrar);
      const resposta = await chatOnce(
        selection,
        "fluxo",
        buildRequest(texto, useFluxo.getState().draft),
        ctx,
        { onDelta: (delta) => stream.push(delta) },
        controller.signal
      );
      stream.end();

      /**
       * Nenhuma operação chegou?
       *
       * Ou não há motor conectado (a resposta é o texto do modo demonstração),
       * ou o modelo respondeu em prosa. Nos dois casos a heurística monta um
       * esqueleto pelas palavras da frase — pelo MESMO caminho, operação por
       * operação. Um canvas vazio com "configure um motor" faria o recurso
       * parecer quebrado quando é só falta de conexão.
       */
      if (!useFluxo.getState().draft.nodes.length || resposta.trim().startsWith("—")) {
        for (const op of heuristicOps(texto)) registrar(op);
        endBuild("Montado sem modelo, pelas palavras do pedido — revise os detalhes.");
        return;
      }
      endBuild();
    } catch (cause) {
      if (controller.signal.aborted) {
        endBuild("Montagem interrompida.");
        return;
      }
      // Falha de rede não pode deixar a pessoa sem fluxo nenhum.
      for (const op of heuristicOps(texto)) registrar(op);
      setErro(cause instanceof Error ? cause.message : String(cause));
      endBuild("Montado sem modelo — revise os detalhes.");
    } finally {
      abortRef.current = null;
    }
  }

  return (
    <div className="fxa">
      <header className="fxa-head">
        <span className="fxa-title">
          <Sparkles size={14} />
          Assistente
        </span>
        <p>Descreva o que deve acontecer. O fluxo é montado na tela enquanto ele responde — e o mesmo campo edita e remove o que já está lá.</p>
      </header>

      <div className="fxa-body" ref={listaRef}>
        {passos.length === 0 && !building ? (
          <>
            <span className="fxa-label">Exemplos</span>
            {EXEMPLOS.map((exemplo) => (
              <button key={exemplo} type="button" className="fxa-exemplo" onClick={() => setPedido(exemplo)}>
                {exemplo}
              </button>
            ))}
          </>
        ) : (
          <ol className="fxa-passos">
            {passos.map((passo, indice) => (
              <li key={`${passo}-${indice}`}>{passo}</li>
            ))}
            {building ? (
              <li className="fxa-vivo">
                <LoaderCircle size={11} className="spin" />
                montando…
              </li>
            ) : null}
          </ol>
        )}
      </div>

      {erro ? (
        <p className="fxa-erro">
          <CircleAlert size={12} />
          {erro}
        </p>
      ) : null}

      <div className="fxa-foot">
        <textarea
          value={pedido}
          rows={3}
          placeholder={activeId ? "Ex.: se o orçamento passar de 5 mil, marcar como quente…" : "Crie um fluxo para começar"}
          disabled={building || !activeId}
          onChange={(event) => setPedido(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void enviar();
          }}
        />
        {building ? (
          <button type="button" className="lg-button" onClick={() => abortRef.current?.abort()}>
            <Square size={13} />
            Parar
          </button>
        ) : (
          <button
            type="button"
            className="lg-button primary"
            disabled={!pedido.trim() || !activeId}
            onClick={() => void enviar()}
          >
            <Send size={13} />
            Montar
          </button>
        )}
      </div>
    </div>
  );
}
