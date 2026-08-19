/**
 * A tela de Dados EDITANDO — montagem real da superfície, porque o que esta
 * onda entrega é de TELA: o clique no cartão abrindo o editor, o blur virando
 * rename propagado, o Ctrl+Z desfazendo, o DDL colado virando diagrama e o
 * snapshot virando migração. A lógica pura (schemaDoc/ddl/migration/history)
 * já é coberta pelos testes de módulo em lib/schema; aqui o réu é a fiação.
 *
 * Sem @testing-library: montagem `react-dom/client` crua com o `act` do React
 * 19, como nos outros testes de tela deste projeto (CanvasSurface.estudio).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ConversationLine } from "@aibot/contracts";
import { initialAppData, useApp } from "../lib/store";
import { createHistory, useSchemaStudio, type EsquemaEditavel } from "../lib/schema";
import { SCHEMA_VAZIO, useSchemaFoco } from "../lib/schemaFoco";
import { SchemaSurface } from "./SchemaSurface";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let topbarHost: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  // O host do portal da barra superior: no app ele vive na Topbar; sem ele os
  // botões Importar SQL/Migração não teriam onde aparecer.
  topbarHost = document.createElement("div");
  topbarHost.id = "topbar-actions";
  document.body.appendChild(topbarHost);
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
  useApp.setState({ ...initialAppData() });
  // Os stores são de MÓDULO (sobrevivem entre testes de propósito, como no
  // app); cada teste parte do zero para um não contaminar o outro.
  useSchemaStudio.setState({ doc: null, history: createHistory<EsquemaEditavel>(), base: null, origem: "", sessao: null });
  useSchemaFoco.setState({ schema: SCHEMA_VAZIO, tabelaFocada: null, nonce: 0 });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  topbarHost.remove();
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
});

/** Um tool.result de schema.export com users ← orders, como o gateway emite. */
function linhaComSchema(): ConversationLine {
  return {
    id: "l1",
    seq: 1,
    ts: "2026-08-19T00:00:00Z",
    role: "assistant",
    text: "",
    toolResults: [
      {
        callId: "c1",
        tool: "schema.export",
        ok: true,
        output: JSON.stringify({
          tables: [
            {
              name: "users",
              columns: [
                { name: "id", type: "uuid", pk: true },
                { name: "email", type: "text" }
              ]
            },
            {
              name: "orders",
              columns: [
                { name: "id", type: "uuid", pk: true },
                { name: "user_id", type: "uuid", fk: true }
              ]
            }
          ],
          relations: [{ from: "orders", to: "users", fromColumn: "user_id", toColumn: "id", kind: "n-1" }]
        })
      }
    ]
  };
}

function monta(lines: ConversationLine[] = [linhaComSchema()]) {
  useApp.setState({ lines });
  act(() => {
    root.render(<SchemaSurface />);
  });
}

function clica(alvo: Element) {
  act(() => {
    alvo.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

/** Commit de um input não controlado do editor: valor + focusout (o evento
 *  nativo por trás do onBlur do React). */
function commitInput(campo: HTMLInputElement, valor: string) {
  act(() => {
    campo.value = valor;
    campo.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
}

/** Digita num controle CONTROLADO (textarea do modal): setter nativo + input. */
function digita(campo: HTMLTextAreaElement, valor: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  act(() => {
    setter?.call(campo, valor);
    campo.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Tecla global — é no window que o atalho de undo/redo escuta. */
function tecla(key: string, extra: KeyboardEventInit = {}) {
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra }));
  });
}

function botaoPorTexto(raiz: ParentNode, texto: string): HTMLButtonElement {
  const alvo = [...raiz.querySelectorAll("button")].find((botao) => botao.textContent?.trim() === texto);
  expect(alvo, `botão "${texto}"`).toBeDefined();
  return alvo as HTMLButtonElement;
}

/* ------------------------- gateway → modelo → editor ---------------------- */

describe("edição do schema pela tela", () => {
  it("promove o tool.result a documento editável e clicar num cartão abre o editor", () => {
    monta();

    // O resultado do gateway virou o modelo (efeito de import).
    expect(useSchemaStudio.getState().doc?.tables.map((t) => t.name)).toEqual(["users", "orders"]);

    const cartao = container.querySelector('g.erd-card[data-tabela="users"]');
    expect(cartao).not.toBeNull();
    clica(cartao!);

    const nome = container.querySelector<HTMLInputElement>('input[aria-label="Nome da tabela"]');
    expect(nome).not.toBeNull();
    expect(nome!.value).toBe("users");
  });

  it("renomear tabela propaga à relação, redesenha o diagrama e Ctrl+Z desfaz", () => {
    monta();
    clica(container.querySelector('g.erd-card[data-tabela="users"]')!);

    commitInput(container.querySelector<HTMLInputElement>('input[aria-label="Nome da tabela"]')!, "clientes");

    // O EDITADO virou a fonte do diagrama…
    expect(container.querySelector('g.erd-card[data-tabela="clientes"]')).not.toBeNull();
    expect(container.querySelector('g.erd-card[data-tabela="users"]')).toBeNull();
    // …e a FK seguiu junto (propagação do rename).
    expect(useSchemaStudio.getState().doc?.relations[0]).toMatchObject({ from: "orders", to: "clientes" });
    // O foco seguiu o nome novo: o painel continua aberto na mesma tabela.
    expect(useSchemaFoco.getState().tabelaFocada).toBe("clientes");

    tecla("z", { ctrlKey: true });
    expect(container.querySelector('g.erd-card[data-tabela="users"]')).not.toBeNull();
    expect(useSchemaStudio.getState().doc?.relations[0]).toMatchObject({ to: "users" });

    // Ctrl+Shift+Z refaz.
    tecla("z", { ctrlKey: true, shiftKey: true });
    expect(container.querySelector('g.erd-card[data-tabela="clientes"]')).not.toBeNull();
  });

  it("o 'Pedir ao agente' embute o schema EDITADO, não o do gateway", () => {
    monta();
    clica(container.querySelector('g.erd-card[data-tabela="users"]')!);
    commitInput(container.querySelector<HTMLInputElement>('input[aria-label="Nome da tabela"]')!, "clientes");

    clica(botaoPorTexto(container, "Pedir ao agente"));

    const prompt = useApp.getState().input;
    expect(prompt).toContain("clientes(");
    expect(prompt).not.toContain("users(");
  });

  it("adicionar e remover campo pelo painel mexem no documento", () => {
    monta();
    clica(container.querySelector('g.erd-card[data-tabela="users"]')!);

    clica(container.querySelector('button[aria-label="Adicionar campo"]')!);
    expect(useSchemaStudio.getState().doc?.tables[0]?.columns.map((c) => c.name)).toContain("campo_3");

    clica(container.querySelector('button[aria-label="Remover campo campo_3"]')!);
    expect(useSchemaStudio.getState().doc?.tables[0]?.columns.map((c) => c.name)).not.toContain("campo_3");
  });
});

/* ------------------------------- importar DDL ----------------------------- */

describe("importar DDL pela tela", () => {
  it("cola CREATE TABLE no modal e o diagrama passa a desenhar o schema importado", () => {
    monta([]);
    expect(container.querySelector(".erd")).toBeNull();

    clica(botaoPorTexto(topbarHost, "Importar SQL"));
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="SQL para importar"]');
    expect(textarea).not.toBeNull();

    digita(
      textarea!,
      `CREATE TABLE produtos (id uuid NOT NULL, nome text, PRIMARY KEY (id));
       CREATE TABLE itens (id uuid NOT NULL, produto_id uuid REFERENCES produtos (id), PRIMARY KEY (id));`
    );
    clica(botaoPorTexto(document.querySelector(".schema-modal")!, "Importar"));

    expect(container.querySelector('g.erd-card[data-tabela="produtos"]')).not.toBeNull();
    expect(container.querySelector('g.erd-card[data-tabela="itens"]')).not.toBeNull();
    expect(useSchemaStudio.getState().doc?.relations).toHaveLength(1);
    // O modal fechou e o texto foi consumido.
    expect(document.querySelector(".schema-modal")).toBeNull();
  });

  it("DDL irreconhecível mostra o erro amigável e NÃO substitui o diagrama", () => {
    monta();
    clica(botaoPorTexto(topbarHost, "Importar SQL"));

    digita(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="SQL para importar"]')!, "SELECT 1;");
    clica(botaoPorTexto(document.querySelector(".schema-modal")!, "Importar"));

    expect(document.querySelector(".schema-modal-erro")?.textContent).toContain("Nenhum CREATE TABLE");
    expect(useSchemaStudio.getState().doc?.tables.map((t) => t.name)).toEqual(["users", "orders"]);
  });
});

/* --------------------------- migração por snapshot ------------------------ */

describe("migração por snapshot pela tela", () => {
  it("salvar snapshot, editar e ver o diff no status e no modal", () => {
    monta();

    // Sem snapshot, o status convida.
    expect(container.querySelector(".surface-status")?.textContent).toContain("sem snapshot");

    clica(botaoPorTexto(topbarHost, "Migração"));
    clica(botaoPorTexto(document.querySelector(".schema-modal")!, "Salvar snapshot"));
    // Recém-salvo: nenhuma diferença.
    expect(document.querySelector(".schema-modal")?.textContent).toContain("Nenhuma diferença");
    clica(document.querySelector('.schema-modal button[aria-label="Fechar"]')!);

    // Uma edição: campo novo em users.
    clica(container.querySelector('g.erd-card[data-tabela="users"]')!);
    clica(container.querySelector('button[aria-label="Adicionar campo"]')!);

    expect(container.querySelector(".surface-status")?.textContent).toContain("1 mudanças vs snapshot");

    clica(botaoPorTexto(topbarHost, "Migração"));
    const modal = document.querySelector(".schema-modal");
    expect(modal?.querySelector("pre")?.textContent).toContain('ALTER TABLE "users" ADD COLUMN "campo_3" text;');
    // O down existe (botão de baixar) — a reversão é o diff invertido.
    expect(botaoPorTexto(modal!, "Baixar down.sql")).toBeDefined();
  });
});
