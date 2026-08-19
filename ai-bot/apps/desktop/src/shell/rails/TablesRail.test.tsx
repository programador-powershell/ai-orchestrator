/**
 * O rail de tabelas DESENHADO: o placeholder virou navegação de verdade.
 *
 * O defeito apontado no confronto com o orquestrador era de tela — "o rail
 * 'tables' é um placeholder permanente sem nenhum caminho de código que o
 * preencha" —, então além das funções puras de filtro este arquivo monta o
 * componente e confere o que a pessoa vê e o que o clique dispara no store
 * compartilhado (schemaFoco), que é o canal do foco com o diagrama.
 *
 * Sem @testing-library: montagem com react-dom/client cru e o act do React 19,
 * como nos outros testes de tela deste projeto.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  SCHEMA_VAZIO,
  useSchemaFoco,
  type Relation,
  type SchemaSnapshot,
  type Table
} from "../../lib/schemaFoco";
import { filtrarRelacoes, filtrarTabelas, TablesRail } from "./TablesRail";

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

const schema: SchemaSnapshot = {
  ...SCHEMA_VAZIO,
  tables: [tabela("users", ["id", "email"]), tabela("orders", ["id", "user_id"])],
  relations: [
    relacao("r1", "orders", "user_id", "users", "id"),
    // Órfã: payments não veio no schema — precisa aparecer ACUSADA, não sumir.
    relacao("r2", "orders", "id", "payments", "order_id")
  ]
};

/* ------------------------------ filtros puros ----------------------------- */

describe("filtros do rail", () => {
  it("acha a tabela pelo nome de um campo — quem busca 'email' não lembra a tabela", () => {
    expect(filtrarTabelas(schema.tables, "email").map((item) => item.name)).toEqual(["users"]);
  });

  it("busca vazia devolve tudo, na ordem que veio", () => {
    expect(filtrarTabelas(schema.tables, "  ").map((item) => item.name)).toEqual(["users", "orders"]);
  });

  it("acha a relação pelo rótulo inteiro, que é o texto que está na tela", () => {
    expect(filtrarRelacoes(schema.relations, "payments").map((item) => item.id)).toEqual(["r2"]);
  });
});

/* --------------------------------- a tela --------------------------------- */

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: Root;

function montar(): void {
  act(() => {
    root.render(<TablesRail />);
  });
}

function botaoPorTexto(texto: string): HTMLButtonElement {
  const alvo = [...container.querySelectorAll("button")].find((botao) => botao.textContent?.includes(texto));
  if (!alvo) throw new Error(`botão "${texto}" não está na tela`);
  return alvo;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
  useSchemaFoco.setState({ schema, tabelaFocada: null, nonce: 0 });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
});

describe("rail de tabelas", () => {
  it("sem schema mostra o vazio honesto, sem inventar tabela de exemplo", () => {
    useSchemaFoco.setState({ schema: SCHEMA_VAZIO });
    montar();

    expect(container.querySelector(".rail-empty")).not.toBeNull();
    expect(container.querySelectorAll(".rail-item")).toHaveLength(0);
  });

  it("lista as tabelas com a contagem de campos, e as abas carregam os contadores", () => {
    montar();

    const rotulos = [...container.querySelectorAll(".rail-item-label")].map((item) => item.textContent);
    expect(rotulos).toEqual(["users", "orders"]);
    expect(botaoPorTexto("users").textContent).toContain("2 campos");
    // O contador na PRÓPRIA aba diz quanto existe do outro lado sem trocar.
    expect(botaoPorTexto("Tabelas").textContent).toContain("2");
    expect(botaoPorTexto("Relações").textContent).toContain("2");
  });

  it("clicar numa tabela FOCA o cartão no diagrama: nome no store e nonce para o scroll", () => {
    montar();

    act(() => {
      botaoPorTexto("users").click();
    });

    expect(useSchemaFoco.getState().tabelaFocada).toBe("users");
    expect(useSchemaFoco.getState().nonce).toBe(1);
    // A linha clicada fica marcada como ativa — o rail confirma o gesto.
    expect(botaoPorTexto("users").dataset.active).toBe("true");
  });

  it("a busca filtra por nome de campo", () => {
    montar();

    const busca = container.querySelector<HTMLInputElement>(".rail-search input");
    expect(busca).not.toBeNull();
    act(() => {
      // React 19 rastreia o value com descritor próprio; para o onChange ver a
      // digitação é preciso escrever pelo setter NATIVO e disparar "input".
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      setter?.call(busca, "email");
      busca?.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const rotulos = [...container.querySelectorAll(".rail-item-label")].map((item) => item.textContent);
    expect(rotulos).toEqual(["users"]);
  });

  it("na aba Relações a órfã aparece ACUSADA e clicar numa íntegra foca a tabela de origem", () => {
    montar();

    act(() => {
      botaoPorTexto("Relações").click();
    });

    const linhas = [...container.querySelectorAll<HTMLButtonElement>(".rail-item")];
    expect(linhas.map((item) => item.textContent)).toEqual([
      "orders.user_id → users.id" + "n-1",
      "orders.id → payments.order_id" + "n-1"
    ]);
    // A órfã não some: ganha a marca de problema — e continua clicável porque
    // a tabela de ORIGEM existe (o conserto começa nela).
    expect(linhas[1]?.dataset.orfa).toBe("true");
    expect(linhas[1]?.disabled).toBe(false);

    act(() => {
      linhas[0]?.click();
    });
    expect(useSchemaFoco.getState().tabelaFocada).toBe("orders");
  });
});
