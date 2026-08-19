/**
 * A tela de Achados com cartões DE VERDADE — montagem real da superfície: o
 * bloco ```json de secrets.scan e osv.query virando cartão, os chips de resumo
 * ("N críticos/altos", "N pacotes vulneráveis"), o filtro por categoria e o
 * link do advisory apontando para o osv.dev. E o vazio digno quando o
 * resultado é só texto (gateway antigo).
 *
 * Sem @testing-library: montagem `react-dom/client` crua com o `act` do React
 * 19, como nos outros testes de tela deste projeto.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ConversationLine, ToolResult } from "@aibot/contracts";
import { initialAppData, useApp } from "../lib/store";
import { FindingsSurface } from "./FindingsSurface";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let statusHost: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  // O host do portal do rodapé (SurfaceStatus): no app ele vive na StatusBar.
  statusHost = document.createElement("div");
  statusHost.id = "statusbar-slot";
  document.body.appendChild(statusHost);
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
  statusHost.remove();
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
});

/** Resultado como o gateway emite: relatório legível + bloco demarcado. */
function resultado(tool: string, callId: string, texto: string, bloco: unknown): ToolResult {
  return {
    callId,
    tool,
    ok: true,
    output: `${texto}\n\n\`\`\`json\n${JSON.stringify(bloco, null, 2)}\n\`\`\``
  };
}

function linhaComAchados(): ConversationLine {
  return {
    id: "l1",
    seq: 1,
    ts: "2026-08-19T00:00:00Z",
    role: "assistant",
    text: "",
    toolResults: [
      resultado("secrets.scan", "c1", "1 achado(s) em 12 arquivos:", {
        scanned: 12,
        findings: [
          {
            severity: "critical",
            rule: "chave da AWS",
            file: "config/env.ts",
            line: 3,
            evidence: "AKIA…•••…XY"
          }
        ]
      }),
      resultado("osv.query", "c2", "lodash 4.17.15 (npm): 1 vulnerabilidade(s)", {
        package: { name: "lodash", ecosystem: "npm" },
        version: "4.17.15",
        vulns: [
          {
            id: "GHSA-p6mc-m468-83gw",
            aliases: ["CVE-2020-8203"],
            severity: "high",
            summary: "Prototype Pollution in lodash",
            url: "https://osv.dev/vulnerability/GHSA-p6mc-m468-83gw"
          }
        ]
      })
    ]
  };
}

function monta(lines: ConversationLine[]) {
  useApp.setState({ lines });
  act(() => {
    root.render(<FindingsSurface />);
  });
}

function clica(alvo: Element) {
  act(() => {
    alvo.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function chipPorTexto(raiz: ParentNode, texto: string): HTMLButtonElement {
  const alvo = [...raiz.querySelectorAll("button.chip")].find((chip) =>
    chip.textContent?.trim().startsWith(texto)
  );
  expect(alvo, `chip "${texto}"`).toBeDefined();
  return alvo as HTMLButtonElement;
}

/* --------------------------- bloco JSON → cartões -------------------------- */

describe("a tela de Achados com os blocos JSON", () => {
  it("desenha o achado de segredo e a vulnerabilidade como cartões", () => {
    monta([linhaComAchados()]);

    const cartoes = container.querySelectorAll("article.finding");
    expect(cartoes.length).toBe(2);
    expect(container.textContent).toContain("chave da AWS");
    expect(container.textContent).toContain("config/env.ts:3");
    expect(container.textContent).toContain("Prototype Pollution in lodash");
    // O "onde" da vulnerabilidade é o pacote consultado, montado da raiz.
    expect(container.textContent).toContain("npm:lodash@4.17.15");
  });

  it("resume a mesa nos chips: críticos/altos e pacotes vulneráveis", () => {
    monta([linhaComAchados()]);

    // 1 critical (segredo) + 1 high (CVE) = 2; 1 pacote distinto.
    expect(container.textContent).toContain("2 críticos/altos");
    expect(container.textContent).toContain("1 pacote vulnerável");
  });

  it("filtra por categoria: só segredos esconde a vulnerabilidade", () => {
    monta([linhaComAchados()]);

    clica(chipPorTexto(container, "segredos"));

    expect(container.textContent).toContain("chave da AWS");
    expect(container.textContent).not.toContain("Prototype Pollution");

    // Clicar de novo desfaz o filtro — o chip é um alternador, não um beco.
    clica(chipPorTexto(container, "segredos"));
    expect(container.textContent).toContain("Prototype Pollution");
  });

  it("aponta o advisory para o osv.dev", () => {
    monta([linhaComAchados()]);

    const link = container.querySelector("a.finding-advisory") as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link!.getAttribute("href")).toBe("https://osv.dev/vulnerability/GHSA-p6mc-m468-83gw");
    // O clique é interceptado (openAdvisory); o rel protege o fallback.
    expect(link!.getAttribute("rel")).toBe("noreferrer");
  });

  it("nunca ecoa o valor do segredo — só a evidência mascarada", () => {
    monta([linhaComAchados()]);
    // A evidência mascarada pode aparecer; um valor com cara de chave inteira, jamais.
    expect(container.textContent).not.toMatch(/AKIA[0-9A-Z]{16}/);
  });
});

/* ------------------------------ vazio digno ------------------------------- */

describe("a tela de Achados sem bloco JSON", () => {
  it("resultado só texto (gateway antigo) mantém o estado vazio", () => {
    monta([
      {
        id: "l1",
        seq: 1,
        ts: "2026-08-19T00:00:00Z",
        role: "assistant",
        text: "",
        toolResults: [
          { callId: "c1", tool: "secrets.scan", ok: true, output: "nenhum segredo aparente em 12 arquivos" }
        ]
      }
    ]);

    expect(container.textContent).toContain("Nenhum achado na mesa");
    expect(container.querySelectorAll("article.finding").length).toBe(0);
  });

  it("varredura limpa COM bloco também fica no vazio — zero achado é zero cartão", () => {
    monta([
      {
        id: "l1",
        seq: 1,
        ts: "2026-08-19T00:00:00Z",
        role: "assistant",
        text: "",
        toolResults: [
          resultado("secrets.scan", "c1", "nenhum segredo aparente em 12 arquivos", {
            scanned: 12,
            findings: []
          })
        ]
      }
    ]);

    expect(container.textContent).toContain("Nenhum achado na mesa");
  });
});
