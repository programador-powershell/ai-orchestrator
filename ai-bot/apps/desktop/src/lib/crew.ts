/**
 * A regra de COMO TERMINOU um trabalhador, num lugar só.
 *
 * Duas telas leem o mesmo `worker.done` — o grafo da Equipe e o quadro do
 * Trabalho — e as duas precisam da mesma resposta. Enquanto a regra morava
 * dentro do `useMemo` de cada uma, ela existia duas vezes; foi assim que as duas
 * passaram a chamar de "falhou" o trabalhador que só havia feito uma pergunta,
 * bem depois de o gateway já saber distinguir os dois casos.
 */

import type { WorkerDone } from "@ai-bot/contracts";

/** Como o trabalho de um trabalhador acabou. */
export type WorkerOutcome = "done" | "failed" | "escalated";

/**
 * ESCALAR NÃO É FALHAR.
 *
 * O trabalhador que escreve `ESCALAR:` não errou: ele se recusou a adivinhar e
 * devolveu a decisão para cima. O gateway já trata os dois casos como coisas
 * diferentes — escalação não entra na contagem de falhas da onda e não abre o
 * portão —, e quem diz qual foi é ele, no campo `escalated`. A tela LÊ; não
 * deduz.
 *
 * Deduzir seria possível: `crew.escalations` traz o `taskId`, e cruzar com o
 * `worker.done` daria a resposta na maioria dos casos. É a maioria que engana.
 * `crew.escalations` é lista que só cresce enquanto a conversa vive, e
 * `crew.done` é mapa sobrescrito por `taskId`; dois planos na mesma conversa
 * reusando o id `t1` — que é exatamente o que um modelo faz — deixariam a
 * escalação velha rotulando a falha nova de "escalado". A falha sumiria do
 * contador e apareceria como pergunta pendente que ninguém pode responder.
 *
 * `ok` continua mandando. Escalação sai do gateway com `ok=false` porque não
 * houve resultado para as tarefas dependentes lerem; se algum dia vier
 * `ok=true` junto com `escalated`, há resultado, e mostrar o resultado é mais
 * útil que mostrar a pergunta.
 */
export function outcomeOf(done: WorkerDone): WorkerOutcome {
  if (done.ok) return "done";
  return done.escalated === true ? "escalated" : "failed";
}
