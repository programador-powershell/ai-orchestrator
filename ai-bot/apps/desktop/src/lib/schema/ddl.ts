/**
 * Import de DDL — o caminho que traz um schema EXISTENTE para a tela sem
 * depender do modelo reescrevê-lo de memória.
 *
 * Porte do importSql do orquestrador (lib/schema.ts), com o MESMO subset
 * declarado: CREATE TABLE (colunas, tipos, PRIMARY KEY, UNIQUE, REFERENCES
 * inline), ALTER TABLE … ADD FOREIGN KEY e CREATE [UNIQUE] INDEX, aceitando
 * nomes qualificados (public.pedidos, `db`.`t`) e comentários de linha e de
 * bloco. Não é um parser de SQL — é o suficiente para round-trip dos exports
 * do próprio gateway e para o dump comum de pg_dump/mysqldump; o que ele não
 * reconhece ele IGNORA, nunca derruba o import inteiro.
 *
 * As adaptações ao modelo do AI-BOT são três, todas para o vocabulário do
 * snapshot (schemaFoco): `NOT NULL` vira `required` (o snapshot não tem
 * nullable), `UNIQUE` de coluna vira ÍNDICE único (o snapshot não tem flag
 * unique — e índice preserva a informação em vez de descartá-la), e não há
 * posição x/y (o layout da tela é automático por decisão declarada).
 */
import type { Relation } from "../schemaFoco";
import {
  adicionarIndice,
  adicionarRelacao,
  docVazio,
  inserirTabela,
  type CampoEdit,
  type EsquemaEditavel,
  type SqlDialect,
  type TabelaEdit
} from "./schemaDoc";

/* -------------------------------- pedaços -------------------------------- */

/** Divide o corpo do CREATE TABLE por vírgulas de NÍVEL ZERO — vírgula dentro
 *  de parêntese (numeric(18,6), PRIMARY KEY (a, b)) não separa coluna. */
function dividirTopo(corpo: string): string[] {
  const partes: string[] = [];
  let profundidade = 0;
  let atual = "";
  for (const char of corpo) {
    if (char === "(") profundidade += 1;
    if (char === ")") profundidade -= 1;
    if (char === "," && profundidade === 0) {
      partes.push(atual);
      atual = "";
    } else {
      atual += char;
    }
  }
  if (atual.trim() !== "") partes.push(atual);
  return partes.map((parte) => parte.trim()).filter((parte) => parte !== "");
}

function dividirNomes(bruto: string): string[] {
  return bruto
    .split(",")
    .map((nome) => nome.replace(/[`"\s]/g, ""))
    .filter((nome) => nome !== "");
}

/** `public.pedidos` / `` `db`.`t` `` → `pedidos` / `t`. O ERD é por tabela. */
function desqualificar(bruto: string): string {
  const partes = bruto.split(".").map((pedaco) => pedaco.trim().replace(/^[`"]|[`"]$/g, ""));
  return partes[partes.length - 1] ?? "";
}

function lerColuna(parte: string): CampoEdit | { campo: CampoEdit; referencia: { to: string; toColumn: string } } | undefined {
  const cabeca = parte.match(/^[`"]?(\w+)[`"]?\s+([\s\S]+)$/);
  if (!cabeca) return undefined;
  const name = cabeca[1] ?? "";
  const resto = (cabeca[2] ?? "").trim();
  const tipoMatch = resto.match(/^(\w+(?:\s*\([^)]*\))?(?:\s+(?:precision|varying))?(?:\s+auto_increment)?)/i);
  if (!tipoMatch) return undefined;
  const type = (tipoMatch[1] ?? "").replace(/\s+/g, " ").trim();
  const cauda = resto.slice(tipoMatch[0].length);
  const campo: CampoEdit = {
    name,
    type,
    pk: /primary\s+key/i.test(cauda),
    fk: false,
    // Sem NOT NULL declarado a coluna é opcional — o mesmo contrato do
    // snapshot: `required` só quando alguém afirmou.
    required: /not\s+null/i.test(cauda)
  };
  const def = cauda.match(/default\s+((?:'[^']*')|(?:\w+\s*\([^)]*\))|[^\s,]+)/i);
  const defValor = def?.[1];
  if (defValor !== undefined) campo.defaultValue = defValor;
  // REFERENCES pode vir qualificado (public.clientes) — o ERD guarda só a tabela.
  const ref = cauda.match(/references\s+((?:[`"]?\w+[`"]?\s*\.\s*)?[`"]?\w+[`"]?)\s*\(\s*[`"]?(\w+)[`"]?\s*\)/i);
  if (ref) {
    campo.fk = true;
    return { campo, referencia: { to: desqualificar(ref[1] ?? ""), toColumn: ref[2] ?? "" } };
  }
  // UNIQUE inline vira índice único no chamador — o campo em si não guarda.
  return campo;
}

/* --------------------------------- import -------------------------------- */

/**
 * DDL → modelo editável. Devolve um doc SEM tabelas quando nada foi
 * reconhecido — é o sinal que a tela usa para o erro amigável, em vez de uma
 * exceção que derrubaria o modal.
 */
export function importarDdl(sql: string): EsquemaEditavel {
  // Comentário de linha E de bloco: um dump real vem com cabeçalho /* … */,
  // e sem tirar isso o CREATE TABLE seguinte nem era reconhecido.
  const limpo = sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
  // Detecção de dialeto do orquestrador, na mesma ordem: crase/InnoDB grita
  // MySQL, tipos nativos gritam Postgres, o resto cai no ANSI neutro.
  // sqlite/mssql existem no vocabulário mas não têm marca inequívoca num DDL
  // genérico — chutar seria pior que o neutro, que todo dialeto entende.
  const dialect: SqlDialect = /`|engine\s*=\s*innodb/i.test(limpo)
    ? "mysql"
    : /\b(timestamptz|jsonb|serial)\b/i.test(limpo)
      ? "postgres"
      : "ansi";

  let doc = docVazio(dialect);
  // Relações inline (REFERENCES na coluna) são aplicadas DEPOIS de todas as
  // tabelas entrarem: a tabela alvo pode ser declarada mais abaixo no dump.
  const pendentes: Array<Omit<Relation, "id" | "fromCard" | "toCard">> = [];
  const unicos: Array<{ table: string; field: string }> = [];

  // Nome pode vir qualificado por schema (public.pedidos, `db`.`t`) — sem
  // isto o dump inteiro era ignorado em silêncio.
  const createRe =
    /create\s+table\s+(?:if\s+not\s+exists\s+)?((?:[`"]?\w+[`"]?\s*\.\s*)?[`"]?\w+[`"]?)\s*\(([\s\S]*?)\)\s*(?:engine\s*=\s*\w+)?\s*;/gi;
  for (const match of limpo.matchAll(createRe)) {
    const nomeTabela = desqualificar(match[1] ?? "");
    const colunas: CampoEdit[] = [];
    const fks: Array<{ fromColumn: string; to: string; toColumn: string }> = [];
    const pks = new Set<string>();
    const uqs = new Set<string>();

    for (const parte of dividirTopo(match[2] ?? "")) {
      const pk = parte.match(/^primary\s+key\s*\(([^)]*)\)/i);
      if (pk) {
        for (const nome of dividirNomes(pk[1] ?? "")) pks.add(nome);
        continue;
      }
      const uq = parte.match(/^unique\s*(?:key\s*)?\(([^)]*)\)/i);
      if (uq) {
        for (const nome of dividirNomes(uq[1] ?? "")) uqs.add(nome);
        continue;
      }
      const fk = parte.match(
        /^(?:constraint\s+\S+\s+)?foreign\s+key\s*\(\s*[`"]?(\w+)[`"]?\s*\)\s*references\s+[`"]?(\w+)[`"]?\s*\(\s*[`"]?(\w+)[`"]?\s*\)/i
      );
      if (fk) {
        fks.push({ fromColumn: fk[1] ?? "", to: desqualificar(fk[2] ?? ""), toColumn: fk[3] ?? "" });
        continue;
      }
      const lido = lerColuna(parte);
      if (lido === undefined) continue;
      if ("referencia" in lido) {
        colunas.push(lido.campo);
        pendentes.push({ from: nomeTabela, fromColumn: lido.campo.name, ...lido.referencia });
      } else {
        colunas.push(lido);
      }
      // UNIQUE inline (na declaração da coluna, fora de PRIMARY KEY).
      const semRef = parte.replace(/references[\s\S]*$/i, "");
      if (/\bunique\b/i.test(semRef) && !/primary\s+key/i.test(semRef)) {
        const ultimo = colunas[colunas.length - 1];
        if (ultimo) uqs.add(ultimo.name);
      }
    }

    for (const coluna of colunas) {
      if (pks.has(coluna.name)) coluna.pk = true;
      const fk = fks.find((item) => item.fromColumn === coluna.name);
      if (fk) {
        coluna.fk = true;
        pendentes.push({ from: nomeTabela, fromColumn: coluna.name, to: fk.to, toColumn: fk.toColumn });
      }
    }
    for (const nome of uqs) {
      if (colunas.some((coluna) => coluna.name === nome)) unicos.push({ table: nomeTabela, field: nome });
    }

    const tabela: TabelaEdit = { name: nomeTabela, note: "", columns: colunas };
    doc = inserirTabela(doc, tabela);
  }

  // Nomes qualificados nos dois lados (ALTER TABLE public.b … REFERENCES public.a).
  const alterRe =
    /alter\s+table\s+((?:[`"]?\w+[`"]?\s*\.\s*)?[`"]?\w+[`"]?)\s+add\s+(?:constraint\s+[`"]?\w+[`"]?\s+)?foreign\s+key\s*\(\s*[`"]?(\w+)[`"]?\s*\)\s*references\s+((?:[`"]?\w+[`"]?\s*\.\s*)?[`"]?\w+[`"]?)\s*\(\s*[`"]?(\w+)[`"]?\s*\)/gi;
  for (const match of limpo.matchAll(alterRe)) {
    pendentes.push({
      from: desqualificar(match[1] ?? ""),
      fromColumn: match[2] ?? "",
      to: desqualificar(match[3] ?? ""),
      toColumn: match[4] ?? ""
    });
  }

  for (const pendente of pendentes) {
    // FK simples: muitos de cá, um de lá — o mesmo padrão do editor.
    doc = adicionarRelacao(doc, { ...pendente, fromCard: "n", toCard: "1" });
  }
  for (const unico of unicos) {
    doc = adicionarIndice(doc, unico.table, [unico.field], true);
  }

  const indexRe =
    /create\s+(unique\s+)?index\s+[`"]?\w+[`"]?\s+on\s+((?:[`"]?\w+[`"]?\s*\.\s*)?[`"]?\w+[`"]?)\s*\(([^)]*)\)\s*;/gi;
  for (const match of limpo.matchAll(indexRe)) {
    doc = adicionarIndice(doc, desqualificar(match[2] ?? ""), dividirNomes(match[3] ?? ""), Boolean(match[1]));
  }
  return doc;
}
