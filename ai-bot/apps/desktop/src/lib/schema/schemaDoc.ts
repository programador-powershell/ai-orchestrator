/**
 * O modelo EDITÁVEL do schema — a peça que faltava para a tela de Dados deixar
 * de ser casca: o resultado do gateway vira este documento, e é ele (não o
 * tool.result cru) que o diagrama desenha e o "Pedir ao agente" embute.
 *
 * O vocabulário é o MESMO do snapshot derivado (lib/schemaFoco: Table, Column,
 * Relation, IndexDef) de propósito: o Erd, o rail e o contador de problemas já
 * falam essa língua, e um segundo vocabulário obrigaria a converter em cada
 * fronteira — a primeira conversão esquecida mostraria schemas diferentes na
 * tela e no rail. A edição só ACRESCENTA o que a leitura não tinha: dialeto e
 * DEFAULT de coluna (CampoEdit), que o DDL precisa e o tool.result não traz.
 *
 * Toda operação é IMUTÁVEL e devolve o MESMO objeto quando não há o que fazer:
 * é isso que deixa o histórico barato (entradas compartilham as tabelas não
 * tocadas por referência) e o subscribe de persistência/publicação comparar
 * por identidade. Portado de lib/schema.ts do orquestrador (applyOps), sem o
 * canal ops:data — aqui quem edita é a tela, não o modelo.
 */
import type { Column, Relation, SchemaSnapshot, Table } from "../schemaFoco";

/* -------------------------------- dialetos ------------------------------- */

/**
 * O MESMO vocabulário de dialetos da superfície (Onda 1) e do gateway
 * (tools_data.go). A lista mora aqui — módulo puro — para a tela e a migração
 * importarem de um lugar só; duplicá-la na superfície foi o que deixou o
 * gateway e o cliente com TRÊS dialetos de diferença na primeira versão.
 */
export const SQL_DIALECTS = ["postgres", "mysql", "sqlite", "mssql", "ansi"] as const;
export type SqlDialect = (typeof SQL_DIALECTS)[number];

export function isDialect(value: string): value is SqlDialect {
  return (SQL_DIALECTS as readonly string[]).includes(value);
}

/** Tipos comuns oferecidos no editor por dialeto (a migração mapeia o resto). */
export const tiposPorDialeto: Record<SqlDialect, string[]> = {
  postgres: ["uuid", "text", "varchar", "int", "bigint", "serial", "boolean", "timestamptz", "date", "jsonb", "numeric"],
  mysql: ["uuid", "varchar", "text", "int", "bigint", "serial", "boolean", "timestamptz", "date", "jsonb", "numeric"],
  sqlite: ["uuid", "text", "varchar", "int", "bigint", "serial", "boolean", "timestamptz", "date", "jsonb", "numeric"],
  mssql: ["uuid", "text", "varchar", "int", "bigint", "serial", "boolean", "timestamptz", "date", "jsonb", "numeric"],
  ansi: ["uuid", "varchar", "text", "int", "bigint", "boolean", "timestamptz", "date", "numeric"]
};

/* --------------------------------- o doc --------------------------------- */

/** Coluna editável: o snapshot + DEFAULT, que só o DDL conhece. */
export interface CampoEdit extends Column {
  defaultValue?: string;
}

/** Tabela editável — estruturalmente atribuível a Table (CampoEdit ⊃ Column),
 *  então o Erd e o rail a desenham sem conversão nenhuma. */
export interface TabelaEdit extends Omit<Table, "columns"> {
  columns: CampoEdit[];
}

export interface EsquemaEditavel {
  tables: TabelaEdit[];
  relations: Relation[];
  indexes: IndiceEdit[];
  dialect: SqlDialect;
}

/** Índice do modelo: sem o `name` livre do snapshot — aqui o nome é sempre
 *  DERIVADO (nomeDoIndice), para renomear tabela/campo propagar sozinho. */
export interface IndiceEdit {
  table: string;
  fields: string[];
  unique: boolean;
}

/**
 * Convenção idx_<tabela>_<campos> — a MESMA que a leitura do tool.result usa
 * como fallback (SchemaSurface.readIndexList): o CREATE INDEX da migração, o
 * prompt e a tela mostram o mesmo nome.
 */
export function nomeDoIndice(indice: IndiceEdit): string {
  return `idx_${indice.table}_${indice.fields.join("_")}`;
}

export function docVazio(dialect: SqlDialect = "postgres"): EsquemaEditavel {
  return { tables: [], relations: [], indexes: [], dialect };
}

/* ------------------------------- conversões ------------------------------ */

/**
 * tool.result → modelo editável. Índices perdem o nome declarado de propósito
 * (viram a convenção): guardar o nome livre quebraria a propagação do rename —
 * um `users_email_uq` sobreviveria intacto ao renomear de `users`, mentindo.
 */
export function deSnapshot(snapshot: SchemaSnapshot, fallback: SqlDialect): EsquemaEditavel {
  return {
    tables: snapshot.tables.map((table) => ({ ...table, columns: table.columns.map((column) => ({ ...column })) })),
    relations: snapshot.relations.map((relation) => ({ ...relation })),
    indexes: snapshot.indexes.map((indice) => ({ table: indice.table, fields: [...indice.fields], unique: indice.unique })),
    dialect: isDialect(snapshot.dialect) ? snapshot.dialect : fallback
  };
}

/**
 * Modelo editável → snapshot que o Erd/rail/status leem. O `sql` e o `dialect`
 * do texto vêm de fora: continuam sendo do ÚLTIMO resultado do gateway — o
 * painel "SQL gerado" mostra o que o modelo escreveu, não uma reconstrução.
 */
export function paraSnapshot(doc: EsquemaEditavel, sql: string, sqlDialect: string): SchemaSnapshot {
  return {
    tables: doc.tables,
    relations: doc.relations,
    indexes: doc.indexes.map((indice) => ({ name: nomeDoIndice(indice), ...indice })),
    sql,
    dialect: sqlDialect
  };
}

/* -------------------------------- helpers -------------------------------- */

/** Comparação canônica de nomes: o SQL que importa aqui não distingue caixa. */
function mesmoNome(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function acharTabela(doc: EsquemaEditavel, nome: string): TabelaEdit | undefined {
  return doc.tables.find((table) => mesmoNome(table.name, nome));
}

function mesmosCampos(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((nome, i) => nome === b[i]);
}

/** Primeiro nome `base_N` que ainda não existe na lista. */
export function nomeLivre(existentes: readonly string[], base: string): string {
  let n = existentes.length + 1;
  let nome = `${base}_${n}`;
  while (existentes.some((item) => mesmoNome(item, nome))) nome = `${base}_${++n}`;
  return nome;
}

/**
 * Depois de remover relações, o flag `fk` das colunas de ORIGEM removidas é
 * recalculado — e SÓ delas: um `fk` que veio marcado do gateway sem relação
 * listada não é nosso para apagar; limpar tudo por recomputação global
 * reescreveria o dado alheio.
 */
function limparFkOrfas(tables: TabelaEdit[], removidas: readonly Relation[], restantes: readonly Relation[]): TabelaEdit[] {
  if (removidas.length === 0) return tables;
  const aindaFk = (tabela: string, campo: string): boolean =>
    restantes.some((r) => mesmoNome(r.from, tabela) && mesmoNome(r.fromColumn, campo));
  return tables.map((table) => {
    const tocadas = removidas.filter((r) => mesmoNome(r.from, table.name) && r.fromColumn !== "");
    if (tocadas.length === 0) return table;
    return {
      ...table,
      columns: table.columns.map((column) =>
        column.fk && tocadas.some((r) => mesmoNome(r.fromColumn, column.name)) && !aindaFk(table.name, column.name)
          ? { ...column, fk: false }
          : column
      )
    };
  });
}

/* ------------------------------- tabelas --------------------------------- */

/**
 * Cria uma tabela `tabela_N` com a PK padrão (id uuid) — mesmo esqueleto do
 * addTable do orquestrador. Devolve o nome junto porque quem cria quer focar
 * a tabela nova, e o chamador não deveria ter que reproduzir o nomeLivre.
 */
export function criarTabela(doc: EsquemaEditavel): { doc: EsquemaEditavel; nome: string } {
  const nome = nomeLivre(doc.tables.map((table) => table.name), "tabela");
  const tabela: TabelaEdit = {
    name: nome,
    note: "",
    columns: [{ name: "id", type: "uuid", pk: true, fk: false, required: true }]
  };
  return { doc: { ...doc, tables: [...doc.tables, tabela] }, nome };
}

/** Insere uma tabela pronta (import de DDL); nome repetido é ignorado. */
export function inserirTabela(doc: EsquemaEditavel, tabela: TabelaEdit): EsquemaEditavel {
  if (tabela.name === "" || acharTabela(doc, tabela.name)) return doc;
  return { ...doc, tables: [...doc.tables, tabela] };
}

/** Remove a tabela, as relações que a tocam e os índices dela — e limpa o
 *  flag fk das colunas que apontavam para ela e ficaram sem relação. */
export function removerTabela(doc: EsquemaEditavel, nome: string): EsquemaEditavel {
  if (!acharTabela(doc, nome)) return doc;
  const removidas = doc.relations.filter((r) => mesmoNome(r.from, nome) || mesmoNome(r.to, nome));
  const restantes = doc.relations.filter((r) => !removidas.includes(r));
  return {
    ...doc,
    tables: limparFkOrfas(
      doc.tables.filter((table) => !mesmoNome(table.name, nome)),
      removidas,
      restantes
    ),
    relations: restantes,
    indexes: doc.indexes.filter((indice) => !mesmoNome(indice.table, nome))
  };
}

/**
 * Renomeia PROPAGANDO: relações (os dois lados) e índices seguem junto. É o
 * motivo de o modelo existir — no orquestrador, renomear sem propagar deixava
 * FK apontando para tabela fantasma e o export saía quebrado.
 */
export function renomearTabela(doc: EsquemaEditavel, de: string, para: string): EsquemaEditavel {
  const nome = para.trim();
  if (nome === "" || de === nome) return doc;
  if (!acharTabela(doc, de)) return doc;
  // Colisão compara SEM caixa, exceto quando é a própria tabela mudando só a
  // caixa (users → Users): isso é rename legítimo, não colisão.
  const colisao = doc.tables.some((table) => !mesmoNome(table.name, de) && mesmoNome(table.name, nome));
  if (colisao) return doc;
  return {
    ...doc,
    tables: doc.tables.map((table) => (mesmoNome(table.name, de) ? { ...table, name: nome } : table)),
    relations: doc.relations.map((r) => ({
      ...r,
      from: mesmoNome(r.from, de) ? nome : r.from,
      to: mesmoNome(r.to, de) ? nome : r.to
    })),
    indexes: doc.indexes.map((indice) => (mesmoNome(indice.table, de) ? { ...indice, table: nome } : indice))
  };
}

/* -------------------------------- campos --------------------------------- */

/** Campo novo `campo_N text` — o tipo neutro que todo dialeto aceita. */
export function criarCampo(doc: EsquemaEditavel, tabela: string): EsquemaEditavel {
  const alvo = acharTabela(doc, tabela);
  if (!alvo) return doc;
  const nome = nomeLivre(alvo.columns.map((column) => column.name), "campo");
  const campo: CampoEdit = { name: nome, type: "text", pk: false, fk: false, required: false };
  return {
    ...doc,
    tables: doc.tables.map((table) => (table === alvo ? { ...table, columns: [...table.columns, campo] } : table))
  };
}

/** Remove o campo, as relações que o usam como ponta e o tira dos índices
 *  (índice que ficou sem campo nenhum não indexa nada — sai junto). */
export function removerCampo(doc: EsquemaEditavel, tabela: string, campo: string): EsquemaEditavel {
  const alvo = acharTabela(doc, tabela);
  if (!alvo || !alvo.columns.some((column) => mesmoNome(column.name, campo))) return doc;
  const removidas = doc.relations.filter(
    (r) =>
      (mesmoNome(r.from, tabela) && mesmoNome(r.fromColumn, campo)) ||
      (mesmoNome(r.to, tabela) && mesmoNome(r.toColumn, campo))
  );
  const restantes = doc.relations.filter((r) => !removidas.includes(r));
  const tables = doc.tables.map((table) =>
    table === alvo ? { ...table, columns: table.columns.filter((column) => !mesmoNome(column.name, campo)) } : table
  );
  return {
    ...doc,
    tables: limparFkOrfas(tables, removidas, restantes),
    relations: restantes,
    indexes: doc.indexes
      .map((indice) =>
        mesmoNome(indice.table, tabela)
          ? { ...indice, fields: indice.fields.filter((nome) => !mesmoNome(nome, campo)) }
          : indice
      )
      .filter((indice) => indice.fields.length > 0)
  };
}

/** Renomeia o campo PROPAGANDO a relações (as duas pontas) e índices. */
export function renomearCampo(doc: EsquemaEditavel, tabela: string, de: string, para: string): EsquemaEditavel {
  const nome = para.trim();
  if (nome === "" || de === nome) return doc;
  const alvo = acharTabela(doc, tabela);
  if (!alvo || !alvo.columns.some((column) => mesmoNome(column.name, de))) return doc;
  const colisao = alvo.columns.some((column) => !mesmoNome(column.name, de) && mesmoNome(column.name, nome));
  if (colisao) return doc;
  return {
    ...doc,
    tables: doc.tables.map((table) =>
      table === alvo
        ? { ...table, columns: table.columns.map((column) => (mesmoNome(column.name, de) ? { ...column, name: nome } : column)) }
        : table
    ),
    relations: doc.relations.map((r) => ({
      ...r,
      fromColumn: mesmoNome(r.from, tabela) && mesmoNome(r.fromColumn, de) ? nome : r.fromColumn,
      toColumn: mesmoNome(r.to, tabela) && mesmoNome(r.toColumn, de) ? nome : r.toColumn
    })),
    indexes: doc.indexes.map((indice) =>
      mesmoNome(indice.table, tabela)
        ? { ...indice, fields: indice.fields.map((nome2) => (mesmoNome(nome2, de) ? nome : nome2)) }
        : indice
    )
  };
}

/** Flags e tipo do campo. `fk` fica de fora de propósito: ele é DERIVADO das
 *  relações (definirReferencia) — um toggle solto mentiria sobre o schema. */
export function alterarCampo(
  doc: EsquemaEditavel,
  tabela: string,
  campo: string,
  patch: Partial<Pick<CampoEdit, "type" | "pk" | "required" | "defaultValue">>
): EsquemaEditavel {
  const alvo = acharTabela(doc, tabela);
  if (!alvo || !alvo.columns.some((column) => mesmoNome(column.name, campo))) return doc;
  return {
    ...doc,
    tables: doc.tables.map((table) =>
      table === alvo
        ? {
            ...table,
            columns: table.columns.map((column) => (mesmoNome(column.name, campo) ? { ...column, ...patch } : column))
          }
        : table
    )
  };
}

/* -------------------------------- relações ------------------------------- */

function idDaRelacao(from: string, fromColumn: string, to: string, toColumn: string): string {
  return `rel_${from}_${fromColumn}__${to}_${toColumn}`;
}

/** Relação nova sem id — o id é derivado das pontas, como no orquestrador. */
export type RelacaoNova = Omit<Relation, "id">;

/** Acrescenta a relação (dedupe pelas pontas) e marca o campo de origem como
 *  FK — a mesma dupla que o add_relation do orquestrador mantinha coerente. */
export function adicionarRelacao(doc: EsquemaEditavel, nova: RelacaoNova): EsquemaEditavel {
  const existe = doc.relations.some(
    (r) =>
      mesmoNome(r.from, nova.from) &&
      mesmoNome(r.fromColumn, nova.fromColumn) &&
      mesmoNome(r.to, nova.to) &&
      mesmoNome(r.toColumn, nova.toColumn)
  );
  if (existe) return doc;
  const relacao: Relation = { id: idDaRelacao(nova.from, nova.fromColumn, nova.to, nova.toColumn), ...nova };
  return {
    ...doc,
    tables: doc.tables.map((table) =>
      mesmoNome(table.name, nova.from)
        ? {
            ...table,
            columns: table.columns.map((column) =>
              mesmoNome(column.name, nova.fromColumn) ? { ...column, fk: true } : column
            )
          }
        : table
    ),
    relations: [...doc.relations, relacao]
  };
}

/**
 * A FK do editor: aponta `tabela.campo` para `alvo` (formato "tabela.campo"
 * do select) ou desliga com "". Troca de alvo remove as relações antigas do
 * MESMO campo antes — um campo com duas FKs é erro de modelagem, não feature.
 */
export function definirReferencia(doc: EsquemaEditavel, tabela: string, campo: string, alvo: string): EsquemaEditavel {
  const removidas = doc.relations.filter((r) => mesmoNome(r.from, tabela) && mesmoNome(r.fromColumn, campo));
  const restantes = doc.relations.filter((r) => !removidas.includes(r));
  const base: EsquemaEditavel = {
    ...doc,
    tables: limparFkOrfas(doc.tables, removidas, restantes),
    relations: restantes
  };
  if (alvo === "") return removidas.length > 0 ? base : doc;
  const [para = "", paraCampo = ""] = alvo.split(".");
  if (para === "" || paraCampo === "") return doc;
  // FK simples é o caso comum: muitos do lado de cá, um do lado de lá.
  return adicionarRelacao(base, { from: tabela, fromColumn: campo, to: para, toColumn: paraCampo, fromCard: "n", toCard: "1" });
}

/* -------------------------------- índices -------------------------------- */

/** Valida tabela e campos ANTES de aceitar: índice sobre coluna fantasma
 *  geraria CREATE INDEX que nenhum banco aceita. Dedupe por tabela+campos. */
export function adicionarIndice(doc: EsquemaEditavel, tabela: string, fields: string[], unique: boolean): EsquemaEditavel {
  const alvo = acharTabela(doc, tabela);
  if (!alvo || fields.length === 0) return doc;
  if (!fields.every((nome) => alvo.columns.some((column) => mesmoNome(column.name, nome)))) return doc;
  if (doc.indexes.some((indice) => mesmoNome(indice.table, alvo.name) && mesmosCampos(indice.fields, fields))) return doc;
  return { ...doc, indexes: [...doc.indexes, { table: alvo.name, fields, unique }] };
}

export function removerIndice(doc: EsquemaEditavel, tabela: string, fields: string[]): EsquemaEditavel {
  const restantes = doc.indexes.filter((indice) => !(mesmoNome(indice.table, tabela) && mesmosCampos(indice.fields, fields)));
  if (restantes.length === doc.indexes.length) return doc;
  return { ...doc, indexes: restantes };
}

/*
 * Não há operação de trocar o dialeto DO DOC de propósito: o dialeto ativo é
 * preferência da TELA (o select da barra — decide em que língua a migração e
 * o /sql saem), e `doc.dialect` guarda só o dialeto em que o schema CHEGOU
 * (detecção do parser de DDL, ou o do gateway). Duas fontes para a mesma
 * escolha foi exatamente o bug dos três dialetos da primeira versão.
 */
