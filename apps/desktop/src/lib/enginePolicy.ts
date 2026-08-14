/**
 * A política do admin aplicada à ESCOLHA DE MOTOR.
 *
 * ## Por que isto existe fora do menu
 *
 * `byokAllowed` e `localRuntimeAllowed` eram lidos num lugar só: a lista
 * suspensa do `ModelSelect`, que simplesmente não mostrava as opções
 * proibidas. Parece suficiente e não é, por duas razões.
 *
 * A primeira é que a escolha é PERSISTIDA (`settings.engines[aba]`, em
 * localStorage). Quem selecionou "chave própria" na semana passada continua
 * usando a chave própria depois de o admin desligar o BYOK: o menu esconde a
 * opção, e ninguém revalida a que já está gravada. O portão fica olhando para
 * a porta enquanto a pessoa já está dentro.
 *
 * A segunda é que `local` e `model` NÃO passam pelo gateway — o runtime local
 * roda na estação e o BYOK sai direto para o provedor. O comentário que dizia
 * "o portão de verdade é o gateway" vale para tudo, MENOS para as duas coisas
 * que a política proíbe. Sem esta checagem, elas não têm portão nenhum.
 *
 * ## Política ausente
 *
 * `policy: null` acontece em dois casos que precisam de respostas opostas:
 * instalação sem gateway (uso local legítimo — tem de funcionar) e bootstrap
 * que ainda não chegou ou falhou (não se sabe nada — não é hora de liberar).
 * A diferença está em `policyVerified`, e é por isso que ele entra aqui: sem
 * gateway configurado, libera; com gateway e sem resposta, segura.
 */

import type { BootstrapPolicy } from "@multiplike/contracts";
import type { EngineSelection } from "@multiplike/contracts";

export interface ContextoDePolitica {
  policy: BootstrapPolicy | null;
  /** A política que está em mãos foi conferida (assinatura/bootstrap)? */
  policyVerified: boolean;
  /** Há gateway configurado? Sem ele, não existe admin para proibir nada. */
  temGateway: boolean;
}

export interface Veredito {
  permitido: boolean;
  /** Frase pronta para a tela — vazia quando permitido. */
  motivo: string;
}

const OK: Veredito = { permitido: true, motivo: "" };

/**
 * Esta seleção pode ser usada agora?
 *
 * `workspace` e `fusion` sempre podem: as duas terminam no gateway, que
 * aplica a política do grupo do seu lado.
 */
export function avaliarSelecao(
  selection: EngineSelection,
  contexto: ContextoDePolitica
): Veredito {
  if (selection.kind === "workspace" || selection.kind === "fusion") return OK;

  // Sem gateway configurado não existe política — é instalação solta, e o
  // runtime local é justamente o modo de trabalho dela.
  if (!contexto.temGateway) return OK;

  if (!contexto.policy || !contexto.policyVerified) {
    return {
      permitido: false,
      motivo:
        "A política do administrador ainda não foi carregada. Use a rota do workspace até a conexão com o servidor se restabelecer."
    };
  }

  if (selection.kind === "local" && contexto.policy.localRuntimeAllowed === false) {
    return {
      permitido: false,
      motivo: "O runtime local está desativado pela política do administrador."
    };
  }

  if (selection.kind === "model" && contexto.policy.byokAllowed === false) {
    return {
      permitido: false,
      motivo: "O uso de chave própria (BYOK) está desativado pela política do administrador."
    };
  }

  return OK;
}

/**
 * A seleção a usar de fato — cai para `workspace` quando a gravada não vale.
 *
 * Existe para o turno não morrer: proibir o BYOK deve mandar a conversa pela
 * rota do workspace, não devolver erro para quem só quis mandar uma mensagem.
 * O motivo volta junto para a tela dizer o que aconteceu.
 */
export function selecaoEfetiva(
  selection: EngineSelection,
  contexto: ContextoDePolitica
): { selection: EngineSelection; aviso: string } {
  const veredito = avaliarSelecao(selection, contexto);
  if (veredito.permitido) return { selection, aviso: "" };
  return { selection: { kind: "workspace" }, aviso: veredito.motivo };
}
