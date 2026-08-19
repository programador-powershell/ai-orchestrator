/**
 * O fio da tela de Código com o gateway — as duas rotas FORA do turno.
 *
 * POST /v1/tools/call     {session, tool, args?}          → {ok, output|error}
 * POST /v1/model/complete {session, prompt, maxTokens?}   → {text}
 *
 * Duas decisões deste arquivo importam:
 *
 * 1. RECUSA NUNCA VIRA EXCEÇÃO. Para a tela, "fora da whitelist", "a pessoa
 *    disse não", "ninguém decidiu no prazo" e "a ferramenta falhou" são o
 *    mesmo evento — não rodou, e este é o motivo que se mostra. Por isso o
 *    retorno é sempre um resultado com `ok`, e o `catch` do transporte (400,
 *    401, 404, 500, rede) entra no MESMO formato: quem consome trata UM caso
 *    de erro, não dois.
 *
 * 2. OFFLINE É RESPOSTA, NÃO TRAVAMENTO. Sem transporte ou sem sessão, a
 *    função devolve na hora a frase honesta — a árvore, o Quick Open e o
 *    salvar mostram a mensagem em vez de inventar conteúdo ou pendurar um
 *    spinner contra um gateway que não existe.
 */

import { activeTransport, useApp } from "../store";

export type ResultadoFerramenta =
  | { ok: true; output: string }
  | { ok: false; error: string };

/** A frase única do estado sem gateway — as telas comparam com ela nos testes. */
export const SEM_CONEXAO = "sem conexão com o gateway — conecte para trabalhar no projeto real";

/**
 * Conferência ESTRUTURAL da resposta, não campo a campo: o dono do contrato é
 * o Go (transport/tools.go), e revalidar cada detalhe aqui criaria uma segunda
 * verdade. O que não pode passar é um corpo de outro formato virando sucesso.
 */
function resultadoDe(corpo: unknown): ResultadoFerramenta | null {
  if (typeof corpo !== "object" || corpo === null) return null;
  const bruto = corpo as { ok?: unknown; output?: unknown; error?: unknown };
  if (bruto.ok === true) {
    return { ok: true, output: typeof bruto.output === "string" ? bruto.output : "" };
  }
  if (bruto.ok === false) {
    const motivo = typeof bruto.error === "string" && bruto.error !== "" ? bruto.error : "";
    return { ok: false, error: motivo === "" ? "a ferramenta recusou sem informar o motivo" : motivo };
  }
  return null;
}

/**
 * Uma ferramenta a pedido da INTERFACE, fora do turno do modelo.
 *
 * `args` ausente fica FORA do corpo de propósito: ferramenta sem parâmetro
 * (git.status) recebe o pedido sem o campo, como o contrato da rota descreve —
 * mandar `args: undefined` serializaria diferente do combinado.
 */
export async function chamarFerramenta(tool: string, args?: unknown): Promise<ResultadoFerramenta> {
  const transporte = activeTransport();
  const session = useApp.getState().session;
  if (transporte === null || session === null || session === "") {
    return { ok: false, error: SEM_CONEXAO };
  }
  const corpo: Record<string, unknown> = { session, tool };
  if (args !== undefined) corpo.args = args;
  try {
    const resposta = await transporte.post("/v1/tools/call", corpo);
    const resultado = resultadoDe(resposta);
    if (resultado === null) {
      return { ok: false, error: "o gateway respondeu fora do contrato {ok, output|error}" };
    }
    return resultado;
  } catch (causa) {
    // 400/401/404/500 e falha de rede chegam aqui com a frase que o transporte
    // já extraiu do corpo — é ela que a tela mostra.
    return { ok: false, error: causa instanceof Error ? causa.message : String(causa) };
  }
}

export type ResultadoComplete =
  | { ok: true; text: string }
  | { ok: false; error: string };

/**
 * O one-shot de completar código no cursor (POST /v1/model/complete).
 *
 * Sem ferramenta, sem histórico, não entra no log da sessão — e o teto duro de
 * 512 tokens é do GATEWAY: pedir mais só faz o servidor cortar no mesmo lugar,
 * então o cliente nem tenta. Erro nunca é exceção pelo mesmo motivo da
 * `chamarFerramenta`: para o autocomplete, toda falha significa "sem sugestão,
 * e este é o motivo se alguém quiser saber".
 */
export async function completarTrecho(prompt: string, maxTokens?: number): Promise<ResultadoComplete> {
  const transporte = activeTransport();
  const session = useApp.getState().session;
  if (transporte === null || session === null || session === "") {
    return { ok: false, error: SEM_CONEXAO };
  }
  const corpo: Record<string, unknown> = { session, prompt };
  if (maxTokens !== undefined) corpo.maxTokens = maxTokens;
  try {
    const resposta = await transporte.post("/v1/model/complete", corpo);
    if (typeof resposta === "object" && resposta !== null) {
      const texto = (resposta as { text?: unknown }).text;
      if (typeof texto === "string") return { ok: true, text: texto };
    }
    return { ok: false, error: "o gateway respondeu fora do contrato {text}" };
  } catch (causa) {
    return { ok: false, error: causa instanceof Error ? causa.message : String(causa) };
  }
}
