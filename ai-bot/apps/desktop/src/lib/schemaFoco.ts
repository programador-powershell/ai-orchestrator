/**
 * Estado compartilhado entre a superfície de Dados e o rail de tabelas.
 *
 * É um store zustand DE MÓDULO, e não um pedaço do store global do app, de
 * propósito: o schema é DERIVADO da conversa (tool.result), e o store global é
 * a fonte da conversa — guardar o derivado ao lado da fonte criaria uma cópia
 * que teria de ser invalidada a cada linha nova, e a primeira vez que alguém
 * esquecesse, a tela e o rail mostrariam schemas diferentes. Aqui a superfície
 * PUBLICA o snapshot que ela mesma derivou (memo em duas etapas) e o rail só
 * lê; o foco anda no sentido contrário: o rail pede, a superfície rola até o
 * cartão. É o mesmo desenho do rail↔view da aba Data do orquestrador
 * (useDataStore em DataView.tsx), reduzido ao que esta tela tem — leitura.
 */
import { create } from "zustand";

/* ------------------------------ o snapshot ------------------------------ */

export interface Column {
  name: string;
  type: string;
  pk: boolean;
  fk: boolean;
  required: boolean;
}

export interface Table {
  name: string;
  columns: Column[];
  note: string;
}

export type Cardinality = "1" | "n";

export interface Relation {
  id: string;
  from: string;
  fromColumn: string;
  to: string;
  toColumn: string;
  fromCard: Cardinality;
  toCard: Cardinality;
}

export interface IndexDef {
  name: string;
  table: string;
  fields: string[];
  unique: boolean;
}

export interface SchemaSnapshot {
  tables: Table[];
  relations: Relation[];
  /** Ausente no JSON = lista vazia: o gateway mais velho não emite índices. */
  indexes: IndexDef[];
  sql: string;
  dialect: string;
}

export const SCHEMA_VAZIO: SchemaSnapshot = { tables: [], relations: [], indexes: [], sql: "", dialect: "" };

/** O rótulo canônico de uma relação — o rail, o tooltip e o prompt usam o
 *  MESMO texto, para a pessoa reconhecer no chat o que leu na barra. */
export function rotuloDaRelacao(relation: Relation): string {
  const de = relation.fromColumn === "" ? relation.from : `${relation.from}.${relation.fromColumn}`;
  const para = relation.toColumn === "" ? relation.to : `${relation.to}.${relation.toColumn}`;
  return `${de} → ${para}`;
}

/**
 * Relações órfãs: apontam para tabela que não veio no schema, ou citam uma
 * coluna que a tabela não tem. O diagrama não as desenha (não há onde ancorar
 * a linha) — mas descartá-las CALADO era esconder exatamente o tipo de erro de
 * modelagem que a tela existe para mostrar; quem conta é o status.
 *
 * Coluna vazia NÃO reprova: o parser tolerante aceita relação sem coluna
 * declarada, e inventar problema em cima de campo opcional seria acusar o
 * formato, não o schema. A comparação ignora caixa pelo mesmo motivo do
 * diagrama: `Users` e `users` são a mesma tabela para o SQL que importa aqui.
 */
export function problemasDoSchema(tables: readonly Table[], relations: readonly Relation[]): Relation[] {
  const porNome = new Map(tables.map((table) => [table.name.toLowerCase(), table]));
  const temColuna = (table: Table | undefined, coluna: string): boolean => {
    if (table === undefined) return false;
    if (coluna === "") return true;
    return table.columns.some((item) => item.name.toLowerCase() === coluna.toLowerCase());
  };
  return relations.filter((relation) => {
    const de = porNome.get(relation.from.toLowerCase());
    const para = porNome.get(relation.to.toLowerCase());
    return de === undefined || para === undefined || !temColuna(de, relation.fromColumn) || !temColuna(para, relation.toColumn);
  });
}

/* -------------------------------- o store ------------------------------- */

interface SchemaFocoStore {
  schema: SchemaSnapshot;
  /** Nome da tabela em destaque; nomes são a identidade — o snapshot não tem id. */
  tabelaFocada: string | null;
  /** Incrementa a cada `focar`: é o que dispara o scroll mesmo re-focando a mesma tabela. */
  nonce: number;
  publicar(schema: SchemaSnapshot): void;
  /** Rail → superfície: seleciona E pede o scroll até o cartão. */
  focar(nome: string): void;
  /** Clique no próprio diagrama: só seleciona — rolar até o cartão que a
   *  pessoa acabou de clicar arrancaria a tela da mão dela. */
  selecionar(nome: string | null): void;
}

export const useSchemaFoco = create<SchemaFocoStore>()((set) => ({
  schema: SCHEMA_VAZIO,
  tabelaFocada: null,
  nonce: 0,
  publicar: (schema) =>
    set((state) => ({
      schema,
      // Foco em tabela que saiu do schema apontaria para o nada — o realce
      // sumiria do diagrama mas o rail continuaria marcando uma linha. Limpa.
      tabelaFocada:
        state.tabelaFocada !== null &&
        schema.tables.some((table) => table.name.toLowerCase() === state.tabelaFocada?.toLowerCase())
          ? state.tabelaFocada
          : null
    })),
  focar: (nome) => set((state) => ({ tabelaFocada: nome, nonce: state.nonce + 1 })),
  selecionar: (nome) => set({ tabelaFocada: nome })
}));
