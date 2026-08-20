/**
 * A ENTREGA vista do cliente — o pedido de aprovação que promove o staging
 * (a cópia em que o turno de modelo trabalhou) para o projeto de verdade.
 *
 * O modelo do produto: DENTRO da jaula o gesto não pede permissão (fs.write na
 * cópia, proc.run no sandbox — só chips e log); a APROVAÇÃO ÚNICA é aqui, na
 * entrega. O gateway suspende a promoção com um `approval.request` cuja
 * ferramenta é `workspace.promote`, e este módulo é a metade do cliente desse
 * contrato: reconhecer o pedido e transformar o `detail` (texto, uma mudança
 * por linha) na lista com contagens que o cartão desenha.
 *
 * O parser é DELIBERADAMENTE tolerante. O envelope de aprovação é genérico
 * (summary + detail em texto), então a lista viaja como linhas prefixadas — e
 * duas grafias são aceitas por linha:
 *
 *   - símbolo:  `+ caminho` (criado), `~ caminho` (alterado), `- caminho` (apagado);
 *   - palavra:  `novo: caminho`, `alterado: caminho`, `sumido: caminho` — o
 *     vocabulário do espelho do gateway (promoteStaging fala "novo, alterado,
 *     sumido"), mais os sinônimos óbvios, porque a redação de lá pode mudar
 *     sem avisar a daqui.
 *
 * Linha que não casa com nenhuma grafia NÃO é descartada: ela entra na lista
 * sem tipo (e fora das contagens). Esconder um caminho porque o cliente não
 * entendeu o prefixo seria aprovar uma entrega mostrando menos do que ela faz
 * — o oposto do que o cartão existe para garantir.
 */

import type { ApprovalRequest } from "@aibot/contracts";

/**
 * O nome da ferramenta de entrega no funil de aprovação. É a CHAVE do cartão
 * específico: qualquer outro tool cai no cartão genérico de sempre.
 */
export const FERRAMENTA_DE_ENTREGA = "workspace.promote";

export type TipoDeMudanca = "criado" | "alterado" | "apagado";

export interface MudancaDeEntrega {
  /** `undefined` = o cliente não soube classificar; a linha aparece mesmo assim. */
  tipo?: TipoDeMudanca;
  caminho: string;
}

export interface Entrega {
  mudancas: MudancaDeEntrega[];
  criados: number;
  alterados: number;
  apagados: number;
}

/** Este pedido de aprovação é uma entrega staging→projeto? */
export function ehEntrega(request: Pick<ApprovalRequest, "tool">): boolean {
  return request.tool === FERRAMENTA_DE_ENTREGA;
}

/**
 * Palavra-prefixo → tipo. Minúsculas e SEM acento (o normaliza abaixo tira),
 * para "excluído" e "excluido" caírem na mesma chave — o texto vem de outra
 * base de código e não dá para apostar na grafia.
 */
const TIPO_POR_PALAVRA: Record<string, TipoDeMudanca> = {
  criado: "criado",
  criada: "criado",
  novo: "criado",
  nova: "criado",
  adicionado: "criado",
  alterado: "alterado",
  alterada: "alterado",
  modificado: "alterado",
  atualizado: "alterado",
  apagado: "apagado",
  apagada: "apagado",
  removido: "apagado",
  excluido: "apagado",
  // O vocabulário do espelho do gateway: "sumido" é o que a promoção apaga.
  sumido: "apagado"
};

/** Minúsculas sem acento, para o mapa acima ter uma chave só por palavra. */
function normaliza(palavra: string): string {
  let saida = "";
  for (const ch of palavra.toLowerCase().normalize("NFD")) {
    const code = ch.codePointAt(0) ?? 0;
    // Compara o COMBINANTE por codigo (U+0300-U+036F, o acento que o NFD
    // decompoe) em vez de regex com o caractere literal: o combinante
    // literal some em editor/diff sem ninguem ver e a faixa muda calada.
    if (code < 0x0300 || code > 0x036f) saida += ch;
  }
  return saida;
}

/**
 * `palavra: caminho` ou `palavra caminho`. O caminho de um arquivo nunca casa
 * aqui por engano: "src/main.ts" começa com "src" seguido de "/", que não é
 * nem dois-pontos nem espaço.
 */
const LINHA_COM_PALAVRA = /^([A-Za-zÀ-ÿ]+)(?::\s*|\s+)(.+)$/;

/**
 * As contagens VERDADEIRAS, quando o summary as traz.
 *
 * O gateway CAPA a lista do detail (20 caminhos + "… e mais N"), mas escreve
 * as contagens inteiras no summary — "… 2 criado(s), 1 alterado(s), 0
 * apagado(s)". Contar só as linhas listadas mentiria num turno grande: o
 * cartão diria "18 criados" sobre uma entrega de 400. O prefixo da palavra
 * ("criad", "alterad", "apagad") cobre singular, plural e o "(s)" do Go.
 */
function contagemDoSummary(summary: string, prefixo: string): number | undefined {
  const casada = new RegExp(`(\\d+)\\s+${prefixo}`).exec(summary);
  if (!casada) return undefined;
  const valor = Number(casada[1]);
  return Number.isFinite(valor) ? valor : undefined;
}

/**
 * O `detail` do pedido de entrega, linha a linha, com as contagens prontas.
 * O `summary` (opcional) corrige as contagens quando a lista veio capada.
 */
export function parseEntrega(detail: string | undefined, summary?: string): Entrega {
  const mudancas: MudancaDeEntrega[] = [];
  let criados = 0;
  let alterados = 0;
  let apagados = 0;

  for (const bruta of (detail ?? "").split("\n")) {
    const linha = bruta.trim();
    if (linha === "") continue;

    let tipo: TipoDeMudanca | undefined;
    let caminho = linha;

    const simbolo = linha[0] ?? "";
    if (simbolo === "+" || simbolo === "~" || simbolo === "-") {
      tipo = simbolo === "+" ? "criado" : simbolo === "~" ? "alterado" : "apagado";
      caminho = linha.slice(1).trim();
    } else {
      const casada = LINHA_COM_PALAVRA.exec(linha);
      if (casada) {
        const palavra = TIPO_POR_PALAVRA[normaliza(casada[1] ?? "")];
        if (palavra) {
          tipo = palavra;
          caminho = (casada[2] ?? "").trim();
        }
      }
    }

    // Prefixo sem caminho ("+" sozinho) não é mudança: não há o que listar.
    if (caminho === "") continue;

    if (tipo === "criado") criados += 1;
    else if (tipo === "alterado") alterados += 1;
    else if (tipo === "apagado") apagados += 1;

    mudancas.push(tipo === undefined ? { caminho } : { tipo, caminho });
  }

  if (summary !== undefined && summary !== "") {
    // O summary vence a lista: ele carrega o total real, a lista pode estar
    // capada. Cada contagem cai de volta na contada quando a frase não a traz.
    criados = contagemDoSummary(summary, "criad") ?? criados;
    alterados = contagemDoSummary(summary, "alterad") ?? alterados;
    apagados = contagemDoSummary(summary, "apagad") ?? apagados;
  }

  return { mudancas, criados, alterados, apagados };
}
