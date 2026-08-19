/**
 * O estúdio do schema — o store de módulo que guarda o documento EDITÁVEL,
 * o histórico (teto 50) e o snapshot-base da migração.
 *
 * É zustand de módulo pelo mesmo motivo do schemaFoco e do useCanvasStudio: o
 * rail e a superfície precisam do MESMO documento, e o store global do app é
 * dono da conversa, não de derivados editáveis. O doc NÃO é persistido em
 * localStorage de propósito: a fonte dele é a conversa (o gateway re-emite o
 * schema quando pedido) mais as edições da sessão — persistir uma cópia local
 * criaria um segundo dono, e o primeiro reload com os dois divergindo iria
 * mostrar um schema que ninguém escreveu.
 *
 * `doc === null` significa "nada importado nem editado ainda": a superfície
 * cai no snapshot derivado do tool.result (o caminho de leitura da Onda 1,
 * intocado). No primeiro resultado com tabelas, `importar` promove o snapshot
 * a documento — e daí em diante o EDITADO é a fonte do diagrama.
 */
import { create } from "zustand";
import { createHistory, pushHistory, redo, undo, type DocHistory } from "./history";
import { criarTabela, docVazio, type EsquemaEditavel } from "./schemaDoc";

interface SchemaStudioState {
  doc: EsquemaEditavel | null;
  history: DocHistory<EsquemaEditavel>;
  /** O snapshot-base da migração: diff base→doc é o up, doc→base é o down. */
  base: EsquemaEditavel | null;
  /** Chave dos tool.results já importados — o guarda contra re-importar o
   *  mesmo resultado num remount e atropelar as edições da pessoa. */
  origem: string;
  /** Sessão a que o doc pertence; trocar de conversa zera tudo. */
  sessao: string | null;
  /** Toda edição passa por aqui: registra o estado atual e aplica. A função
   *  recebe o doc atual (ou o vazio, na primeira edição) e devolve o próximo;
   *  devolver o MESMO objeto = no-op, sem entrada de histórico. */
  editar(muta: (atual: EsquemaEditavel) => EsquemaEditavel): void;
  /** Gateway → doc. Se já havia doc, a troca entra no histórico: o resultado
   *  novo substitui as edições, mas um Ctrl+Z as devolve. */
  importar(doc: EsquemaEditavel, origem: string): void;
  /** Cria `tabela_N` e devolve o nome — quem cria quer focar a tabela nova. */
  novaTabela(): string;
  desfazer(): void;
  refazer(): void;
  salvarBase(): void;
  /** Conversa nova = estúdio zerado; desfazer através de uma troca de sessão
   *  restauraria o schema alheio. Idempotente para a mesma sessão. */
  aoTrocarSessao(sessao: string | null): void;
}

export const useSchemaStudio = create<SchemaStudioState>((set, get) => ({
  doc: null,
  history: createHistory<EsquemaEditavel>(),
  base: null,
  origem: "",
  sessao: null,
  editar: (muta) =>
    set((state) => {
      const atual = state.doc ?? docVazio();
      const proximo = muta(atual);
      if (proximo === atual && state.doc !== null) return {};
      return { doc: proximo, history: pushHistory(state.history, atual) };
    }),
  importar: (doc, origem) =>
    set((state) => {
      if (origem === state.origem) return {};
      if (state.doc === null) return { doc, origem };
      return { doc, origem, history: pushHistory(state.history, state.doc) };
    }),
  novaTabela: () => {
    const atual = get().doc ?? docVazio();
    const { doc, nome } = criarTabela(atual);
    set((state) => ({ doc, history: pushHistory(state.history, atual) }));
    return nome;
  },
  desfazer: () =>
    set((state) => {
      if (state.doc === null) return {};
      const passo = undo(state.history, state.doc);
      return passo ? { doc: passo.doc, history: passo.history } : {};
    }),
  refazer: () =>
    set((state) => {
      if (state.doc === null) return {};
      const passo = redo(state.history, state.doc);
      return passo ? { doc: passo.doc, history: passo.history } : {};
    }),
  // Base = o doc de agora (ou o vazio: snapshot antes da primeira tabela
  // também vale — o diff a partir dele é o CREATE de tudo).
  salvarBase: () => set((state) => ({ base: state.doc ?? docVazio() })),
  aoTrocarSessao: (sessao) =>
    set((state) => {
      if (state.sessao === sessao) return {};
      return { sessao, doc: null, history: createHistory<EsquemaEditavel>(), base: null, origem: "" };
    })
}));
