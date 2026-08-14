/**
 * Como o balão de prompt se comporta em cada aba.
 *
 * Estava espalhado em dois literais dentro do `Composer.tsx` — um mapa de
 * placeholders e um `mode === "code" || mode === "fluxo"` no className. Sempre
 * que uma aba mudava de ideia sobre ter ou não o balão, era preciso lembrar dos
 * dois lugares, e o Fluxo passou um tempo com placeholder escrito para um campo
 * que nem aparecia.
 */

/**
 * Abas SEM balão de prompt.
 *
 * Só o Code: lá a conversa acontece dentro do painel do editor, colada no
 * arquivo e no diff, e um segundo campo no rodapé daria duas caixas para a
 * mesma frase. Toda outra aba usa o balão — inclusive as que não conversam,
 * como Fluxo e Agent, que recebem o texto pelo `goalBus` e o transformam em
 * ação em vez de resposta.
 */
export const COMPOSER_HIDDEN = new Set<string>(["code"]);

export function composerHidden(mode: string): boolean {
  return COMPOSER_HIDDEN.has(mode);
}

/** O que o campo promete em cada aba — é a única instrução de uso que existe. */
export const MODE_PLACEHOLDERS: Record<string, string> = {
  chat: "Pergunte, pesquise ou pense junto…",
  code: "Descreva a mudança de código…",
  design: "Descreva a interface ou cole uma URL para replicar…",
  data: "Peça tabelas, relações ou migrações…",
  work: "Descreva o objetivo ou a automação…",
  security: "Peça uma revisão, simulação ou correção…",
  agent: "Descreva o objetivo — a equipe se organiza para entregar…",
  fluxo: "Descreva o que deve acontecer — o fluxo é montado na tela…",
  office: "Diga o que quer alterar no arquivo…",
  tune: "Peça exemplos de dataset, config de treino ou avaliação…"
};
