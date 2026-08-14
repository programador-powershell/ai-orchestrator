"use client";

/**
 * O histórico da montagem — a coluna opcional da esquerda.
 *
 * Já teve campo de texto próprio. Não tem mais: a entrada é o balão de prompt
 * do app, o mesmo das outras abas, e duas caixas para a mesma frase deixavam
 * a dúvida de qual delas manda. Aqui fica só o que o assistente FEZ ("+ nó
 * Enviar WhatsApp"), porque o que ele escreveu é uma lista de operações,
 * ilegível para quem está olhando o canvas.
 *
 * O painel é dispensável de propósito: quem já sabe o que pediu não precisa
 * da coluna ocupando um terço da tela.
 */

import { useEffect, useRef } from "react";
import { CircleAlert, Square } from "lucide-react";

import { ThinkingOrb } from "../ThinkingOrb";
import { Glyph } from "../icons";
import { useFluxo } from "../../lib/fluxo/store";
import { useApp } from "../../lib/store";

const EXEMPLOS = [
  "Quando chegar um lead novo, mandar boas-vindas no WhatsApp",
  "Se o orçamento passar de 5 mil, marcar como quente e avisar o gestor",
  "Se o lead não responder em 3 dias, enviar uma retomada",
  "Quando o cartão atrasar, criar tarefa de cobrança",
  "Troque a mensagem do WhatsApp e remova a espera"
];

export function FlowAssistant() {
  const listaRef = useRef<HTMLDivElement>(null);

  const building = useFluxo((state) => state.building);
  const passos = useFluxo((state) => state.passos);
  const erro = useFluxo((state) => state.erro);
  const stopBuild = useFluxo((state) => state.stopBuild);
  const setInput = useApp((state) => state.setInput);

  useEffect(() => {
    listaRef.current?.scrollTo({ top: listaRef.current.scrollHeight });
  }, [passos]);

  return (
    <div className="fxa">
      <header className="fxa-head">
        <span className="fxa-title">
          <Glyph name="features/dag" size={14} />
          Montagem
        </span>
        <p>
          Descreva no campo abaixo o que deve acontecer. O fluxo é montado na tela enquanto o modelo responde — e o
          mesmo campo edita e remove o que já está lá.
        </p>
      </header>

      <div className="fxa-body" ref={listaRef}>
        {passos.length === 0 && !building ? (
          <>
            <span className="fxa-label">Exemplos</span>
            {/* Clicar preenche o balão em vez de enviar: a frase quase sempre
                precisa de um ajuste antes de virar fluxo. */}
            {EXEMPLOS.map((exemplo) => (
              <button key={exemplo} type="button" className="fxa-exemplo" onClick={() => setInput(exemplo)}>
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
                <ThinkingOrb kind="weaving" size={13} className="orb--inline" />
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

      {building ? (
        <div className="fxa-foot">
          <button type="button" className="lg-button" onClick={stopBuild}>
            <Square size={13} />
            Parar
          </button>
        </div>
      ) : null}
    </div>
  );
}
