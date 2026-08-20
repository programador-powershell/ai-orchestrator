/**
 * O cartão de ENTREGA — a aprovação única do modelo com sandbox.
 *
 * Dentro da jaula o gesto não pede permissão; o que pede é a promoção do
 * staging ao projeto. Este teste fixa a apresentação própria desse pedido
 * (título "entregar ao projeto", contagens e a lista de caminhos ABERTA) e o
 * contrato dos botões: "Permitir entrega" e "Recusar" mandam a decisão
 * `approval.decision` com o MESMO callId do pedido — allow true/false. É o
 * mesmo funil de sempre (fila, contador, expiração-que-recusa); só o corpo é
 * específico, e o cartão genérico das outras ferramentas continua intacto.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ApprovalRequest } from "@aibot/contracts";
import { initialAppData, useApp } from "../lib/store";
import { ApprovalCard } from "./ApprovalCard";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
  useApp.setState(initialAppData());
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
});

function monta() {
  act(() => {
    root.render(<ApprovalCard />);
  });
}

function clica(rotulo: string) {
  const botao = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === rotulo
  );
  expect(botao, `botão "${rotulo}" não está no cartão`).toBeTruthy();
  act(() => {
    botao?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

const PEDIDO: ApprovalRequest = {
  callId: "call-entrega-1",
  tool: "workspace.promote",
  risk: "write",
  summary: "o Código quer entregar 4 arquivo(s) ao projeto",
  detail: "+ src/App.tsx\n+ docs/novo.md\n~ src/lib/store.ts\n- velho.txt"
};

describe("o cartão de entrega", () => {
  it("apresenta o gesto: título próprio, contagens e a lista de caminhos aberta", () => {
    useApp.setState({ pendingApprovals: [PEDIDO] });
    monta();

    // O título fala o gesto, não o id da ferramenta: "workspace.promote" não
    // diz a ninguém que é o próprio projeto que vai mudar.
    expect(container.querySelector("#approval-tool")?.textContent).toBe("entregar ao projeto");

    expect(container.querySelector(".approval-entrega-contagens")?.textContent).toBe(
      "2 criados · 1 alterado · 1 apagado"
    );

    // A lista ABERTA — ela é o objeto da decisão, não um detalhe colapsável.
    expect(container.querySelector("details")).toBeNull();
    const caminhos = [...container.querySelectorAll(".approval-entrega-lista code")].map(
      (item) => item.textContent
    );
    expect(caminhos).toEqual(["src/App.tsx", "docs/novo.md", "src/lib/store.ts", "velho.txt"]);
  });

  it("os botões são só dois — permitir entrega e recusar", () => {
    useApp.setState({ pendingApprovals: [PEDIDO] });
    monta();

    const rotulos = [...container.querySelectorAll(".approval-actions button")].map(
      (item) => item.textContent
    );
    // Sem "permitir estes argumentos": cada promoção é única (outro staging,
    // outro digest) — o escopo por digest nunca reaproveitaria nada.
    expect(rotulos).toEqual(["Permitir entrega", "Recusar"]);
  });

  it("permitir entrega decide allow com o callId do pedido", () => {
    const decide = vi.fn();
    useApp.setState({ pendingApprovals: [PEDIDO], decide });
    monta();

    clica("Permitir entrega");

    expect(decide).toHaveBeenCalledExactlyOnceWith("call-entrega-1", true, "once");
  });

  it("recusar decide deny com o mesmo callId — e o staging morre do outro lado", () => {
    const decide = vi.fn();
    useApp.setState({ pendingApprovals: [PEDIDO], decide });
    monta();

    clica("Recusar");

    expect(decide).toHaveBeenCalledExactlyOnceWith("call-entrega-1", false, "once");
  });

  it("linha que o cliente não entende aparece na lista mesmo assim", () => {
    // Mostrar MENOS caminhos do que a entrega toca seria pedir um sim no
    // escuro; o formato desconhecido entra cru, sem contagem.
    useApp.setState({
      pendingApprovals: [{ ...PEDIDO, detail: "+ src/a.ts\n<<formato novo>> src/b.ts" }]
    });
    monta();

    const caminhos = [...container.querySelectorAll(".approval-entrega-lista code")].map(
      (item) => item.textContent
    );
    expect(caminhos).toEqual(["src/a.ts", "<<formato novo>> src/b.ts"]);
    expect(container.querySelector(".approval-entrega-contagens")?.textContent).toBe("1 criado");
  });

  it("qualquer outra ferramenta continua no cartão genérico", () => {
    useApp.setState({
      pendingApprovals: [
        {
          callId: "call-proc-1",
          tool: "proc.run",
          risk: "execute",
          summary: "Executar: pnpm test",
          detail: "pnpm test",
          digest: "abc123"
        }
      ]
    });
    monta();

    expect(container.querySelector("#approval-tool")?.textContent).toBe("proc.run");
    expect(container.querySelector(".approval-entrega")).toBeNull();
    // O detalhe genérico segue colapsável, e os três botões seguem lá.
    expect(container.querySelector("details.approval-detail")).not.toBeNull();
    const rotulos = [...container.querySelectorAll(".approval-actions button")].map(
      (item) => item.textContent
    );
    expect(rotulos).toEqual(["Permitir uma vez", "Permitir estes argumentos", "Recusar"]);
  });
});
