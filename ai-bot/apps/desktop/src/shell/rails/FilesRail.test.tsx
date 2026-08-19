/**
 * O rail de arquivos DESENHADO: o placeholder virou árvore de verdade.
 *
 * Além das regras puras (que moram em lib/ide), este arquivo monta o
 * componente e confere o que a pessoa vê e o que o clique dispara no store
 * compartilhado (ideStore) — expansão preguiçosa, abrir no editor e, acima de
 * tudo, o vazio HONESTO quando o gateway está fora: nunca árvore inventada.
 *
 * Sem @testing-library: montagem com react-dom/client cru e o act do React 19,
 * como nos outros testes de tela deste projeto. O gateway é dublado por
 * activeTransport, o padrão da casa.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Transport } from "../../lib/transport";
import { initialAppData, useApp } from "../../lib/store";
import { sincronizarSessao, useIde, zerarIde } from "../../lib/ide/ideStore";
import { FilesRail } from "./FilesRail";

let transporteFalso: Transport | null = null;

vi.mock("../../lib/store", async (original) => {
  const real = await original<typeof import("../../lib/store")>();
  return { ...real, activeTransport: (): Transport | null => transporteFalso };
});

interface CorpoDaChamada {
  session: string;
  tool: string;
  args?: Record<string, unknown>;
}

let chamadas: CorpoDaChamada[] = [];
let responder: (corpo: CorpoDaChamada) => unknown;

function respostasPadrao(corpo: CorpoDaChamada): unknown {
  if (corpo.tool === "fs.list") {
    const path = String(corpo.args?.path ?? "");
    if (path === "") return { ok: true, output: "src/\nREADME.md (2048 bytes)" };
    if (path === "src") return { ok: true, output: "main.go (12 bytes)" };
    return { ok: true, output: "(pasta vazia)" };
  }
  if (corpo.tool === "fs.read") return { ok: true, output: "package main\n" };
  return { ok: false, error: `ferramenta inesperada: ${corpo.tool}` };
}

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: Root;

function montar(): void {
  act(() => {
    root.render(<FilesRail />);
  });
}

/** Descarrega as promessas em voo (fs.list → parse → setState) dentro do act. */
async function assentar(): Promise<void> {
  await act(async () => {
    for (let passo = 0; passo < 12; passo += 1) await Promise.resolve();
  });
}

function botaoPorTexto(texto: string): HTMLButtonElement {
  const alvo = [...container.querySelectorAll("button")].find((botao) =>
    botao.textContent?.includes(texto)
  );
  if (!alvo) throw new Error(`botão "${texto}" não está na tela`);
  return alvo;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  chamadas = [];
  responder = respostasPadrao;
  transporteFalso = {
    post: async (_path: string, body: unknown) => {
      const corpo = body as CorpoDaChamada;
      chamadas.push(corpo);
      return responder(corpo);
    }
  } as unknown as Transport;
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
  useApp.setState({ ...initialAppData(), status: "ready", session: "s-1" });
  zerarIde();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
});

describe("rail de arquivos", () => {
  it("offline mostra o vazio honesto — nunca uma árvore inventada", async () => {
    useApp.setState({ status: "offline", session: null });
    montar();
    await assentar();

    expect(container.querySelector(".rail-empty")?.textContent).toContain("Sem conexão com o gateway");
    expect(container.querySelectorAll(".files-tree-row")).toHaveLength(0);
    // E não gastou nem um POST tentando listar o que não existe.
    expect(chamadas).toHaveLength(0);
  });

  it("com gateway, a raiz vem do fs.list: pastas primeiro, tamanho nos arquivos", async () => {
    montar();
    await assentar();

    const nomes = [...container.querySelectorAll(".files-tree-name")].map((item) => item.textContent);
    expect(nomes).toEqual(["src", "README.md"]);
    expect(botaoPorTexto("README.md").textContent).toContain("2k");
    expect(chamadas[0]).toEqual({ session: "s-1", tool: "fs.list", args: { path: "" } });
  });

  it("expansão é preguiçosa: a subpasta só é listada quando alguém a abre", async () => {
    montar();
    await assentar();
    expect(chamadas.filter((corpo) => corpo.tool === "fs.list")).toHaveLength(1);

    act(() => {
      botaoPorTexto("src").click();
    });
    await assentar();

    const nomes = [...container.querySelectorAll(".files-tree-name")].map((item) => item.textContent);
    expect(nomes).toEqual(["src", "main.go", "README.md"]);
    expect(chamadas.filter((corpo) => corpo.tool === "fs.list")).toHaveLength(2);
  });

  it("clicar num arquivo abre no editor via fs.read e a linha fica ativa", async () => {
    montar();
    await assentar();
    act(() => {
      botaoPorTexto("src").click();
    });
    await assentar();

    act(() => {
      botaoPorTexto("main.go").click();
    });
    await assentar();

    expect(chamadas.some((corpo) => corpo.tool === "fs.read" && corpo.args?.path === "src/main.go")).toBe(true);
    const estado = useIde.getState();
    expect(estado.activePath).toBe("src/main.go");
    expect(estado.files[0]?.content).toBe("package main\n");
    expect(botaoPorTexto("main.go").dataset.active).toBe("true");
  });

  it("raiz que falha mostra o MOTIVO e oferece tentar de novo", async () => {
    responder = () => ({ ok: false, error: "sem workspace nesta sessão" });
    montar();
    await assentar();

    expect(container.querySelector(".rail-empty")?.textContent).toContain("sem workspace nesta sessão");

    // O gateway voltou: o retry recarrega a árvore de verdade.
    responder = respostasPadrao;
    act(() => {
      botaoPorTexto("Tentar de novo").click();
    });
    await assentar();
    expect(
      [...container.querySelectorAll(".files-tree-name")].map((item) => item.textContent)
    ).toEqual(["src", "README.md"]);
  });

  it("trocar de sessão zera a árvore e relista no projeto novo", async () => {
    montar();
    await assentar();
    expect(container.querySelectorAll(".files-tree-row").length).toBeGreaterThan(0);

    responder = (corpo) =>
      corpo.tool === "fs.list" ? { ok: true, output: "outro.ts (9 bytes)" } : respostasPadrao(corpo);
    act(() => {
      useApp.setState({ session: "s-2" });
    });
    await assentar();

    const nomes = [...container.querySelectorAll(".files-tree-name")].map((item) => item.textContent);
    expect(nomes).toEqual(["outro.ts"]);
    expect(useIde.getState().session).toBe("s-2");
  });

  it("a exportação usada pelos testes de módulo continua coerente", () => {
    // sincronizarSessao é a MESMA função que o rail chama no efeito — se o
    // contrato dela mudar, este arquivo e o ideStore.test acusam juntos.
    sincronizarSessao("s-x");
    expect(useIde.getState().session).toBe("s-x");
  });
});
