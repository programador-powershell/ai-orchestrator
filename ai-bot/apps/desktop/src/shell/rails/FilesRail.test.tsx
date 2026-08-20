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
import type { Done, Envelope, ToolResult } from "@aibot/contracts";
import type { Transport } from "../../lib/transport";
import { applyEnvelope, initialAppData, useApp } from "../../lib/store";
import {
  ATRASO_DA_ATUALIZACAO_MS,
  sincronizarSessao,
  useIde,
  zerarIde
} from "../../lib/ide/ideStore";
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

function nomesNaTela(): Array<string | null> {
  return [...container.querySelectorAll(".files-tree-name")].map((item) => item.textContent);
}

/* Envelopes de VERDADE (reduzidos pelo applyEnvelope real): é assim que o
 * tool.result e o done chegam à janela no fio de produção. */
let seqDeEnvelope = 100;

function envelopeDe<P>(kind: Envelope["kind"], payload: P, turn = "t-1"): Envelope<P> {
  seqDeEnvelope += 1;
  return {
    v: 1,
    id: `e-${seqDeEnvelope}`,
    ts: "2026-08-20T12:00:00Z",
    seq: seqDeEnvelope,
    session: "s-1",
    turn,
    kind,
    from: { kind: "specialist", id: "code", specialist: "code" },
    payload
  };
}

function gravacaoDoBot(callId: string, tool: "fs.write" | "fs.patch", ok = true): Envelope<ToolResult> {
  const payload: ToolResult = ok
    ? { callId, tool, ok: true, output: "gravado" }
    : { callId, tool, ok: false, error: "a pessoa recusou a escrita" };
  return envelopeDe("tool.result", payload);
}

/** Espera o debounce da atualização vencer e as listagens assentarem. */
async function esperarAtualizacao(): Promise<void> {
  await act(async () => {
    await new Promise((resolver) => setTimeout(resolver, ATRASO_DA_ATUALIZACAO_MS + 50));
  });
  await assentar();
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

describe("árvore viva", () => {
  it("tool.result de fs.write/fs.patch recarrega a árvore sozinho — rajada vira UMA relistagem, pastas abertas ficam abertas", async () => {
    montar();
    await assentar();
    act(() => {
      botaoPorTexto("src").click();
    });
    await assentar();
    expect(chamadas.filter((corpo) => corpo.tool === "fs.list")).toHaveLength(2);

    // O bot criou hello.html na raiz e novo.go dentro de src durante o turno.
    responder = (corpo) => {
      if (corpo.tool !== "fs.list") return respostasPadrao(corpo);
      const path = String(corpo.args?.path ?? "");
      if (path === "") return { ok: true, output: "src/\nREADME.md (2048 bytes)\nhello.html (64 bytes)" };
      if (path === "src") return { ok: true, output: "main.go (12 bytes)\nnovo.go (7 bytes)" };
      return { ok: true, output: "(pasta vazia)" };
    };

    // Duas gravações na MESMA rajada — o fio real de "criar o projeto inteiro".
    act(() => {
      useApp.setState((state) => applyEnvelope(state, gravacaoDoBot("c-1", "fs.write")));
      useApp.setState((state) => applyEnvelope(state, gravacaoDoBot("c-2", "fs.patch")));
    });
    // Antes do debounce vencer, nada relistou: é ele que colapsa a rajada.
    expect(chamadas.filter((corpo) => corpo.tool === "fs.list")).toHaveLength(2);
    await esperarAtualizacao();

    // O arquivo do bot apareceu SEM clique, e a pasta aberta continuou aberta.
    // (arquivos em ordem de locale — "hello" antes de "README", como o parse ordena)
    expect(nomesNaTela()).toEqual(["src", "main.go", "novo.go", "hello.html", "README.md"]);
    // Uma relistagem por pasta viva (raiz + src), apesar das duas gravações.
    expect(chamadas.filter((corpo) => corpo.tool === "fs.list")).toHaveLength(4);
  });

  it("gravação RECUSADA (ok:false) não relista — nada mudou no disco", async () => {
    montar();
    await assentar();

    act(() => {
      useApp.setState((state) => applyEnvelope(state, gravacaoDoBot("c-3", "fs.write", false)));
    });
    await esperarAtualizacao();

    expect(chamadas.filter((corpo) => corpo.tool === "fs.list")).toHaveLength(1);
    expect(nomesNaTela()).toEqual(["src", "README.md"]);
  });

  it("o erro de 'sem pasta de projeto' se recupera SOZINHO quando o turno conclui", async () => {
    responder = () => ({ ok: false, error: "esta sessão não tem pasta de projeto definida" });
    montar();
    await assentar();
    expect(container.querySelector(".rail-empty")?.textContent).toContain(
      "não tem pasta de projeto"
    );

    // A pessoa mandou o pedido (busy sobe, como no send) e o gateway
    // provisionou o workspace durante o turno de trabalho.
    act(() => {
      useApp.setState({ busy: true });
    });
    responder = respostasPadrao;
    // O done que fecha o turno é o MESMO envelope que o store reduz.
    act(() => {
      useApp.setState((state) => applyEnvelope(state, envelopeDe<Done>("done", { turn: "t-1" })));
    });
    await assentar();

    // A árvore que tinha falhado ao montar tentou de novo sem nenhum clique.
    expect(nomesNaTela()).toEqual(["src", "README.md"]);
    expect(container.querySelector(".rail-empty")).toBeNull();
  });

  it("turno que conclui com a árvore SAUDÁVEL não dispara relistagem nenhuma", async () => {
    montar();
    await assentar();
    expect(chamadas.filter((corpo) => corpo.tool === "fs.list")).toHaveLength(1);

    act(() => {
      useApp.setState({ busy: true });
    });
    act(() => {
      useApp.setState((state) => applyEnvelope(state, envelopeDe<Done>("done", { turn: "t-2" })));
    });
    await esperarAtualizacao();

    // O retry é do ERRO, não do relógio: árvore boa fica quieta.
    expect(chamadas.filter((corpo) => corpo.tool === "fs.list")).toHaveLength(1);
  });

  it("na conversa FILHA, toda chamada /v1/tools/call carrega a sessão DELA", async () => {
    montar();
    await assentar();

    // O gesto do openSession: linhas zeradas e a sessão vira a da filha.
    act(() => {
      useApp.setState({ session: "filha-1", lines: [] });
    });
    await assentar();

    const listagens = chamadas.filter((corpo) => corpo.tool === "fs.list");
    expect(listagens[listagens.length - 1]?.session).toBe("filha-1");

    act(() => {
      botaoPorTexto("README.md").click();
    });
    await assentar();

    // Abrir arquivo na filha lê o PROJETO DA FILHA — nunca o da raiz.
    expect(chamadas[chamadas.length - 1]).toEqual({
      session: "filha-1",
      tool: "fs.read",
      args: { path: "README.md" }
    });
    expect(chamadas.some((corpo) => corpo.session !== "filha-1" && corpo.tool === "fs.read")).toBe(
      false
    );
  });
});
