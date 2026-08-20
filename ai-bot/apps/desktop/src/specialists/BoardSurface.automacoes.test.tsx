/**
 * A janela de TRABALHO reage à entrega do PRÓPRIO bot — o conserto anti-casca.
 *
 * O quadro de colunas é alimentado por `crew` (task.dispatch/progress/done),
 * eventos que o bot de Trabalho NÃO emite — quem os emite é a Equipe. Na
 * sessão do próprio bot, a entrega dele é o GATILHO agendado
 * (schedule.create/list/remove, ver specialist.go), e antes deste conserto a
 * tela ficava em "Nenhuma tarefa ainda" enquanto o bot agendava automações
 * que ninguém via. Aqui a montagem real prova: o tool.result confirmado do
 * schedule.create vira linha na seção de Automações; o remove a tira; o list
 * substitui o quadro; e recusa (ok:false) não desenha nada.
 *
 * Sem @testing-library: montagem `react-dom/client` crua com o `act` do
 * React 19, como nos outros testes de tela deste projeto.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ConversationLine, ToolCall, ToolResult } from "@aibot/contracts";
import { initialAppData, useApp } from "../lib/store";
import { BoardSurface } from "./BoardSurface";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

// O jsdom não implementa scrollTo de elemento, e a conversa compacta (que o
// Quadro monta ao lado das colunas) rola até o fim no mount.
Element.prototype.scrollTo = (() => {}) as Element["scrollTo"];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
  useApp.setState({ ...initialAppData() });
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
    root.render(<BoardSurface />);
  });
}

/** Uma linha de assistente com as ferramentas do turno — como o store as pendura. */
function linhaComFerramentas(id: string, calls: ToolCall[], results: ToolResult[]): ConversationLine {
  return {
    id,
    seq: 1,
    turn: "t-1",
    ts: "2026-08-20T12:00:00Z",
    role: "assistant",
    specialist: "work",
    text: "",
    toolCalls: calls,
    toolResults: results
  };
}

const CRIACAO_CALL: ToolCall = {
  callId: "call-sch-1",
  tool: "schedule.create",
  args: { prompt: "Resuma os chamados abertos e me avise", every: "1h", note: "rotina da manhã" }
};

/** O recibo REAL do gateway (tools_flow.go) — id e agenda saem daqui. */
const CRIACAO_OK: ToolResult = {
  callId: "call-sch-1",
  tool: "schedule.create",
  ok: true,
  output:
    "gatilho trg-7f criado (a cada 1h). primeiro disparo em 20/08/2026 16:00, hora local desta máquina. " +
    "o prompt vai rodar nesta mesma sessão sem ninguém olhando; use schedule.list para conferir e " +
    "schedule.remove para desfazer"
};

describe("a seção de Automações do Quadro", () => {
  it("nasce com vazio honesto — diz o que vai aparecer, sem inventar agenda", () => {
    monta();

    const secao = container.querySelector('[aria-label="automações agendadas"]');
    expect(secao).not.toBeNull();
    expect(secao?.textContent).toContain("nenhuma automação agendada nesta sessão");
    // E o rodapé conta zero, não esconde a régua.
    expect(container.querySelector(".surface-status")?.textContent).toContain("automações 0");
  });

  it("schedule.create confirmado vira linha: id do recibo, agenda e o prompt dos argumentos", () => {
    useApp.setState({ lines: [linhaComFerramentas("l1", [CRIACAO_CALL], [CRIACAO_OK])] });
    monta();

    const linha = container.querySelector(".board-automacao");
    expect(linha).not.toBeNull();
    expect(linha?.querySelector(".board-automacao-id")?.textContent).toBe("trg-7f");
    expect(linha?.textContent).toContain("a cada 1h");
    expect(linha?.textContent).toContain("Resuma os chamados abertos e me avise");
    expect(linha?.textContent).toContain("nota: rotina da manhã");
    expect(linha?.textContent).toContain("próximo 20/08/2026 16:00");
    expect(container.querySelector(".surface-status")?.textContent).toContain("automações 1");
  });

  it("recusa (ok:false) não desenha nada — agendamento que não aconteceu não é linha", () => {
    useApp.setState({
      lines: [
        linhaComFerramentas(
          "l1",
          [CRIACAO_CALL],
          [{ callId: "call-sch-1", tool: "schedule.create", ok: false, error: "a agenda local não está ligada" }]
        )
      ]
    });
    monta();

    expect(container.querySelector(".board-automacao")).toBeNull();
  });

  it("schedule.remove confirmado tira a linha do quadro", () => {
    useApp.setState({
      lines: [
        linhaComFerramentas("l1", [CRIACAO_CALL], [CRIACAO_OK]),
        linhaComFerramentas(
          "l2",
          [{ callId: "call-sch-2", tool: "schedule.remove", args: { id: "trg-7f" } }],
          [
            {
              callId: "call-sch-2",
              tool: "schedule.remove",
              ok: true,
              output: "gatilho trg-7f apagado; ele não dispara mais"
            }
          ]
        )
      ]
    });
    monta();

    expect(container.querySelector(".board-automacao")).toBeNull();
    expect(container.textContent).toContain("nenhuma automação agendada nesta sessão");
  });

  it("schedule.list SUBSTITUI o quadro — a lista é a fotografia mais recente da agenda", () => {
    const lista =
      "2 gatilho(s):\n" +
      "- trg-7f — a cada 1h — próximo 20/08/2026 16:00 — 3 disparo(s)\n" +
      "  Resuma os chamados abertos e me avise\n" +
      "  nota: rotina da manhã\n" +
      "- trg-9c [desligado] — às 07:30 — próximo 21/08/2026 07:30 — 0 disparo(s)\n" +
      "  Gere o relatório diário\n";
    useApp.setState({
      lines: [
        linhaComFerramentas("l1", [CRIACAO_CALL], [CRIACAO_OK]),
        linhaComFerramentas(
          "l2",
          [{ callId: "call-sch-3", tool: "schedule.list", args: {} }],
          [{ callId: "call-sch-3", tool: "schedule.list", ok: true, output: lista }]
        )
      ]
    });
    monta();

    const linhas = [...container.querySelectorAll(".board-automacao")];
    expect(linhas).toHaveLength(2);
    expect(linhas[0]?.textContent).toContain("3 disparos");
    // O gatilho desligado continua NA LISTA (ele existe no disco), marcado.
    expect(linhas[1]?.getAttribute("data-desligada")).toBe("true");
    expect(linhas[1]?.textContent).toContain("desligado");
    expect(linhas[1]?.textContent).toContain("Gere o relatório diário");
  });

  it("lista vazia zera o quadro — o disco é a fonte, não a memória da tela", () => {
    useApp.setState({
      lines: [
        linhaComFerramentas("l1", [CRIACAO_CALL], [CRIACAO_OK]),
        linhaComFerramentas(
          "l2",
          [{ callId: "call-sch-4", tool: "schedule.list", args: {} }],
          [
            {
              callId: "call-sch-4",
              tool: "schedule.list",
              ok: true,
              output: "não há nenhum gatilho agendado nesta sessão"
            }
          ]
        )
      ]
    });
    monta();

    expect(container.querySelector(".board-automacao")).toBeNull();
  });

  it("«pedir para remover» escreve o pedido no composer — quem remove é o especialista", () => {
    useApp.setState({ lines: [linhaComFerramentas("l1", [CRIACAO_CALL], [CRIACAO_OK])] });
    monta();

    const botao = [...container.querySelectorAll<HTMLButtonElement>(".board-automacao button")].find(
      (item) => item.textContent?.includes("pedir para remover")
    );
    expect(botao).toBeDefined();
    act(() => {
      botao?.click();
    });

    expect(useApp.getState().input).toContain("Remova o gatilho agendado trg-7f");
  });
});
