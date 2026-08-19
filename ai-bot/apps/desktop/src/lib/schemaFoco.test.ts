/**
 * O estado compartilhado entre a tela de Dados e o rail de tabelas.
 *
 * Duas coisas moram aqui e as duas já causaram defeito em telas irmãs: o foco
 * que sobrevive a um schema que mudou embaixo dele (apontar para tabela que
 * não existe mais realça o nada), e a relação órfã descartada em silêncio —
 * a tela concordando com um schema quebrado.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  problemasDoSchema,
  rotuloDaRelacao,
  SCHEMA_VAZIO,
  useSchemaFoco,
  type Relation,
  type SchemaSnapshot,
  type Table
} from "./schemaFoco";

const tabela = (name: string, colunas: string[]): Table => ({
  name,
  columns: colunas.map((coluna) => ({ name: coluna, type: "text", pk: false, fk: false, required: false })),
  note: ""
});

const relacao = (id: string, from: string, fromColumn: string, to: string, toColumn: string): Relation => ({
  id,
  from,
  fromColumn,
  to,
  toColumn,
  fromCard: "n",
  toCard: "1"
});

const schemaCom = (tables: Table[], relations: Relation[] = []): SchemaSnapshot => ({
  ...SCHEMA_VAZIO,
  tables,
  relations
});

/* ------------------------------- problemas ------------------------------- */

describe("problemas do schema", () => {
  const tabelas = [tabela("users", ["id", "email"]), tabela("orders", ["id", "user_id"])];

  it("acusa relação para tabela que não veio no export", () => {
    const orfa = relacao("r1", "orders", "user_id", "payments", "id");

    expect(problemasDoSchema(tabelas, [orfa])).toEqual([orfa]);
  });

  it("acusa relação que cita coluna que a tabela não tem", () => {
    const orfa = relacao("r1", "orders", "customer_id", "users", "id");

    expect(problemasDoSchema(tabelas, [orfa])).toEqual([orfa]);
  });

  it("não acusa relação íntegra nem a sem coluna declarada", () => {
    // Coluna vazia é formato tolerado, não defeito: acusá-la seria reprovar o
    // formato, não o schema.
    const inteira = relacao("r1", "orders", "user_id", "users", "id");
    const semColuna = relacao("r2", "orders", "", "users", "");

    expect(problemasDoSchema(tabelas, [inteira, semColuna])).toEqual([]);
  });

  it("compara sem caixa, como o diagrama: Users e users são a mesma tabela", () => {
    const relacoes = [relacao("r1", "Orders", "USER_ID", "USERS", "ID")];

    expect(problemasDoSchema(tabelas, relacoes)).toEqual([]);
  });
});

describe("rótulo da relação", () => {
  it("inclui as colunas quando existem e omite quando não vieram", () => {
    expect(rotuloDaRelacao(relacao("r", "orders", "user_id", "users", "id"))).toBe("orders.user_id → users.id");
    expect(rotuloDaRelacao(relacao("r", "orders", "", "users", ""))).toBe("orders → users");
  });
});

/* ------------------------------- foco ------------------------------------ */

describe("foco compartilhado rail ↔ superfície", () => {
  beforeEach(() => {
    useSchemaFoco.setState({ schema: SCHEMA_VAZIO, tabelaFocada: null, nonce: 0 });
  });

  it("focar guarda a tabela e incrementa o nonce a CADA pedido", () => {
    // Re-focar a mesma tabela precisa rolar de novo — é o nonce que dispara o
    // efeito, não o nome, senão o segundo clique no rail não faz nada.
    useSchemaFoco.getState().focar("users");
    useSchemaFoco.getState().focar("users");

    expect(useSchemaFoco.getState().tabelaFocada).toBe("users");
    expect(useSchemaFoco.getState().nonce).toBe(2);
  });

  it("selecionar não mexe no nonce: clique no diagrama não pode rolar a tela", () => {
    useSchemaFoco.getState().selecionar("users");

    expect(useSchemaFoco.getState().tabelaFocada).toBe("users");
    expect(useSchemaFoco.getState().nonce).toBe(0);
  });

  it("publicar preserva o foco quando a tabela continua no schema (mesmo mudando a caixa)", () => {
    useSchemaFoco.getState().focar("Users");
    useSchemaFoco.getState().publicar(schemaCom([tabela("users", ["id"])]));

    expect(useSchemaFoco.getState().tabelaFocada).toBe("Users");
  });

  it("publicar limpa o foco quando a tabela saiu do schema", () => {
    // Foco em tabela que não existe mais realçaria o nada no diagrama e uma
    // linha fantasma no rail.
    useSchemaFoco.getState().focar("payments");
    useSchemaFoco.getState().publicar(schemaCom([tabela("users", ["id"])]));

    expect(useSchemaFoco.getState().tabelaFocada).toBeNull();
  });
});
