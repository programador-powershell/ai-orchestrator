import { describe, expect, it } from "vitest";
import type { SchemaTable } from "@ai-orchestrator/contracts";

import {
  alca,
  campoDaAlca,
  indiceDaChave,
  indiceDeFkProvavel,
  ladosDaLigacao,
  resolverLigacao
} from "./erdLinks";

function tabela(id: string, nome: string, campos: Array<[string, boolean?]>, x = 0): SchemaTable {
  return {
    id,
    name: nome,
    x,
    y: 0,
    fields: campos.map(([name, primaryKey]) => ({ name, type: "text", primaryKey }))
  } as SchemaTable;
}

const clientes = tabela("t1", "clientes", [["id", true], ["nome"], ["email"]], 60);
const pedidos = tabela("t2", "pedidos", [["id", true], ["cliente_id"], ["total"]], 380);

describe("ids de alça", () => {
  it("monta e lê o índice de volta", () => {
    expect(alca("s", "r", 3)).toBe("sr3");
    expect(alca("t", "l", 0)).toBe("tl0");
    expect(campoDaAlca("sr3")).toBe(3);
    expect(campoDaAlca("tl0")).toBe(0);
  });

  it("trata a alça do cabeçalho como 'sem campo escolhido'", () => {
    expect(alca("s", "l", "tbl")).toBe("sl-tbl");
    expect(campoDaAlca("sl-tbl")).toBeNull();
    expect(campoDaAlca("tr-tbl")).toBeNull();
  });

  it("recusa lixo em vez de apontar para o campo 0", () => {
    // `Number("")` é 0 e `Number(" 1")` é 1: sem a checagem de dígitos, os dois
    // ligariam um campo que ninguém escolheu.
    expect(campoDaAlca("sr")).toBeNull();
    expect(campoDaAlca("sr ")).toBeNull();
    expect(campoDaAlca("sr 1")).toBeNull();
    expect(campoDaAlca("sr-1")).toBeNull();
    expect(campoDaAlca("srx")).toBeNull();
    expect(campoDaAlca(null)).toBeNull();
    expect(campoDaAlca(undefined)).toBeNull();
  });
});

describe("lado de saída", () => {
  it("aponta para o alvo em vez de contornar o cartão", () => {
    expect(ladosDaLigacao(60, 380)).toEqual({ origem: "r", destino: "l" });
    expect(ladosDaLigacao(380, 60)).toEqual({ origem: "l", destino: "r" });
  });

  it("com as tabelas empilhadas, mantém saída à direita", () => {
    expect(ladosDaLigacao(200, 200)).toEqual({ origem: "r", destino: "l" });
  });
});

describe("campos inferidos", () => {
  it("a FK provável é a primeira coluna que não é chave", () => {
    expect(indiceDeFkProvavel(clientes)).toBe(1);
  });

  it("sem coluna comum, cai na primeira", () => {
    expect(indiceDeFkProvavel(tabela("t9", "so_pk", [["id", true]]))).toBe(0);
  });

  it("o alvo é a chave primária", () => {
    expect(indiceDaChave(clientes)).toBe(0);
  });

  it("sem PK declarada, o alvo é a primeira coluna", () => {
    expect(indiceDaChave(tabela("t8", "sem_pk", [["a"], ["b"]]))).toBe(0);
  });
});

describe("resolverLigacao", () => {
  it("respeita os campos quando o arrasto saiu das alças de campo", () => {
    expect(resolverLigacao(pedidos, clientes, "sl1", "tr0")).toEqual({ campoOrigem: 1, campoDestino: 0 });
  });

  it("infere o par quando o arrasto saiu do cabeçalho", () => {
    // pedidos.<primeira não-chave> → clientes.<PK>
    expect(resolverLigacao(pedidos, clientes, "sr-tbl", "tl-tbl")).toEqual({ campoOrigem: 1, campoDestino: 0 });
  });

  it("mistura: campo na origem, cabeçalho no destino", () => {
    expect(resolverLigacao(pedidos, clientes, "sr2", "tl-tbl")).toEqual({ campoOrigem: 2, campoDestino: 0 });
  });

  it("recusa auto-referência de tabela", () => {
    expect(resolverLigacao(pedidos, pedidos, "sr1", "tl0")).toBeNull();
  });

  it("recusa tabela sem campo nenhum", () => {
    const vazia = tabela("t7", "vazia", []);
    expect(resolverLigacao(vazia, clientes, "sr-tbl", "tl-tbl")).toBeNull();
    expect(resolverLigacao(clientes, vazia, "sr1", "tl-tbl")).toBeNull();
  });

  it("recusa índice além do fim — alça de um campo que já foi apagado", () => {
    expect(resolverLigacao(pedidos, clientes, "sr9", "tl0")).toBeNull();
    expect(resolverLigacao(pedidos, clientes, "sr1", "tl9")).toBeNull();
  });
});
