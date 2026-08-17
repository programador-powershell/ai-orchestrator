"use client";

/**
 * Montagem do fluxo a partir de uma frase.
 *
 * Saiu de dentro do painel do assistente para cá porque a entrada passou a ser
 * o balão de prompt do app — o mesmo das outras abas. Com a lógica presa ao
 * componente, o balão só funcionaria com a coluna da esquerda aberta, e o
 * pedido era justamente que ela fosse opcional.
 *
 * Não devolve o fluxo pronto: consome o stream e aplica CADA operação assim
 * que a linha fecha, que é o que faz o desenho nascer na tela enquanto o
 * modelo ainda escreve.
 */

import { buildRequest, createOpStream, heuristicOps } from "./assistant";
import type { FlowOp } from "./ops";
import { useFluxo } from "./store";
import { chatOnce, type EngineContext } from "../engine";
import { useApp } from "../store";
import type { EngineSelection } from "@ai-bot/contracts";

/** Uma linha do histórico: o que a operação fez, em português. */
export function descreveOp(op: FlowOp): string | null {
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

export interface MontarOpcoes {
  selection: EngineSelection;
  ctx: EngineContext;
}

/**
 * Monta (ou edita) o fluxo ativo a partir do texto.
 *
 * O mesmo caminho cria e altera: "remova a espera" e "troque a mensagem"
 * chegam aqui igual a "quando chegar um lead, mande boas-vindas", porque o
 * pedido vai ao modelo junto com o fluxo atual e os ids de cada nó.
 */
export async function montarDoPrompt(texto: string, { selection, ctx }: MontarOpcoes): Promise<void> {
  const pedido = texto.trim();
  if (!pedido) return;
  if (useFluxo.getState().building) {
    // O composer já ecoou a mensagem e limpou o campo: sair calado deixaria a
    // frase sumir sem explicação. O aviso vai para o rodapé da aba.
    useFluxo.getState().setNote("Uma montagem já está em curso — espere ela terminar ou clique em Parar.");
    return;
  }

  // Sem fluxo ativo, o Enter no balão não podia simplesmente não fazer nada:
  // quem digitou já disse o que quer, e criar o fluxo é o passo óbvio.
  if (!useFluxo.getState().activeId) useFluxo.getState().newFlow();

  const controller = new AbortController();
  const { apply, beginBuild, endBuild, pushPasso, setErro, setAbort } = useFluxo.getState();
  const setStage = useApp.getState().setStage;
  setAbort(controller);
  beginBuild(pedido);
  setStage("Montando o fluxo…");

  /**
   * Quantas operações o stream trouxe.
   *
   * É o sinal que separa "o modelo não respondeu operação nenhuma" de "as
   * operações que ele mandou esvaziaram o canvas". Sem ele, um pedido
   * legítimo como "limpe o fluxo, quero começar do zero" — que o modelo
   * atende com `{"op":"clear"}` — parecia falha de conexão: a heurística
   * entrava, montava um esqueleto que ninguém pediu e ainda renomeava o
   * fluxo SALVO com a frase do comando.
   */
  let recebidas = 0;

  const registrar = (op: FlowOp) => {
    recebidas += 1;
    apply(op);
    const linha = descreveOp(op);
    if (!linha) return;
    pushPasso(linha);
    // A etapa vira o texto do orbe no rodapé: quem está olhando o canvas vê a
    // operação acontecer; quem está olhando o balão lê o que acabou de sair.
    setStage(`Montando o fluxo · ${linha}`);
  };

  try {
    const stream = createOpStream(registrar);
    const resposta = await chatOnce(
      selection,
      "fluxo",
      buildRequest(pedido, useFluxo.getState().draft),
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
     *
     * A conta é de OPERAÇÕES RECEBIDAS, não de nós no canvas: "limpe o fluxo"
     * e "remova todos os nós" terminam com o canvas vazio de propósito, e
     * olhar só o resultado transformava o acerto do modelo em um fluxo
     * inventado por cima.
     */
    if (!recebidas || resposta.trim().startsWith("—")) {
      for (const op of heuristicOps(pedido)) registrar(op);
      endBuild("Montado sem modelo, pelas palavras do pedido — revise os detalhes.");
      return;
    }
    endBuild(
      useFluxo.getState().draft.nodes.length
        ? undefined
        : "Canvas limpo — descreva o novo fluxo no campo abaixo."
    );
  } catch (cause) {
    if (controller.signal.aborted) {
      endBuild("Montagem interrompida.");
      return;
    }
    // Falha de rede não pode deixar a pessoa sem fluxo nenhum.
    for (const op of heuristicOps(pedido)) registrar(op);
    setErro(cause instanceof Error ? cause.message : String(cause));
    endBuild("Montado sem modelo — revise os detalhes.");
  } finally {
    setAbort(null);
    setStage("");
  }
}
