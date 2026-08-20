/**
 * O estado compartilhado da IDE (rail ⇄ editor), com o gateway dublado.
 *
 * As regras que estes casos fixam são as que a tela não pode errar: árvore
 * honesta (erro aparece, nada é inventado), buffer não confiável não salva
 * (leitura falhou / arquivo cortado), edição durante a gravação não perde o
 * indicador de sujo, e TUDO morre junto quando a sessão troca.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Transport } from "../transport";
import { initialAppData, useApp } from "../store";
import {
  abrirArquivo,
  abrirVindoDaConversa,
  alternarPasta,
  atualizarArvore,
  buscarNoProjeto,
  carregarPasta,
  editarAtivo,
  fecharArquivo,
  indiceDeArquivos,
  recarregarArvore,
  salvarAtivo,
  sincronizarSessao,
  useIde,
  zerarIde
} from "./ideStore";

let transporteFalso: Transport | null = null;

vi.mock("../store", async (original) => {
  const real = await original<typeof import("../store")>();
  return { ...real, activeTransport: (): Transport | null => transporteFalso };
});

interface CorpoDaChamada {
  session: string;
  tool: string;
  args?: Record<string, unknown>;
}

let chamadas: CorpoDaChamada[] = [];
let responder: (corpo: CorpoDaChamada) => unknown | Promise<unknown>;

function armarTransporte(): void {
  transporteFalso = {
    post: async (_path: string, body: unknown) => {
      const corpo = body as CorpoDaChamada;
      chamadas.push(corpo);
      return responder(corpo);
    }
  } as unknown as Transport;
}

/** Roteia por ferramenta+path — a árvore de mentira dos testes. */
function respostasPadrao(corpo: CorpoDaChamada): unknown {
  if (corpo.tool === "fs.list") {
    const path = String(corpo.args?.path ?? "");
    if (path === "") return { ok: true, output: "src/\nREADME.md (2048 bytes)" };
    if (path === "src") return { ok: true, output: "main.go (12 bytes)" };
    return { ok: true, output: "(pasta vazia)" };
  }
  if (corpo.tool === "fs.read") return { ok: true, output: "package main\n" };
  if (corpo.tool === "fs.write") return { ok: true, output: "gravado" };
  if (corpo.tool === "fs.search") return { ok: true, output: "src/main.go:1: package main" };
  return { ok: false, error: `ferramenta inesperada: ${corpo.tool}` };
}

beforeEach(() => {
  chamadas = [];
  responder = respostasPadrao;
  armarTransporte();
  useApp.setState({ ...initialAppData(), session: "s-1" });
  zerarIde();
  sincronizarSessao("s-1");
});

describe("árvore", () => {
  it("carrega a raiz pelo fs.list, pastas primeiro", async () => {
    await carregarPasta("");
    const raiz = useIde.getState().tree[""];
    expect(raiz?.erro).toBe("");
    expect(raiz?.entradas.map((item) => item.name)).toEqual(["src", "README.md"]);
    expect(chamadas[0]).toEqual({ session: "s-1", tool: "fs.list", args: { path: "" } });
  });

  it("falha vira erro HONESTO no lugar da pasta — nunca árvore inventada", async () => {
    responder = () => ({ ok: false, error: "sem workspace nesta sessão" });
    await carregarPasta("");
    expect(useIde.getState().tree[""]?.erro).toBe("sem workspace nesta sessão");
    expect(useIde.getState().tree[""]?.entradas).toEqual([]);
  });

  it("alternarPasta expande e lista PREGUIÇOSO — cada nível é um POST", async () => {
    await carregarPasta("");
    alternarPasta("src");
    expect(useIde.getState().expanded.has("src")).toBe(true);
    await vi.waitFor(() => {
      expect(useIde.getState().tree["src"]?.entradas.map((item) => item.name)).toEqual(["main.go"]);
    });
    // Fechar e reabrir NÃO relista: o cache da pasta fica.
    alternarPasta("src");
    alternarPasta("src");
    expect(chamadas.filter((corpo) => corpo.args?.path === "src")).toHaveLength(1);
  });

  it("resposta em voo de sessão antiga é descartada", async () => {
    let soltar!: (valor: unknown) => void;
    responder = () => new Promise((resolver) => (soltar = resolver));
    const pendente = carregarPasta("");
    sincronizarSessao("s-2");
    soltar({ ok: true, output: "fantasma/" });
    await pendente;
    expect(useIde.getState().tree[""]).toBeUndefined();
  });

  it("atualizarArvore relista EM LUGAR: raiz e abertas agora; fechada sai do cache velho", async () => {
    await carregarPasta("");
    alternarPasta("src");
    await vi.waitFor(() => {
      expect(useIde.getState().tree["src"]).toBeDefined();
    });
    // Fecha src: o cache dela fica — e é exatamente ele que a gravação do bot
    // acabou de deixar VELHO.
    alternarPasta("src");
    responder = (corpo) =>
      corpo.tool === "fs.list" && String(corpo.args?.path ?? "") === ""
        ? { ok: true, output: "src/\nREADME.md (2048 bytes)\nhello.html (64 bytes)" }
        : respostasPadrao(corpo);

    atualizarArvore();
    await vi.waitFor(() => {
      // Arquivos em ordem de locale — "hello" antes de "README", como o parse ordena.
      expect(useIde.getState().tree[""]?.entradas.map((item) => item.name)).toEqual([
        "src",
        "hello.html",
        "README.md"
      ]);
    });
    // src estava fechada: saiu do cache — a expansão preguiçosa a relista
    // fresca na próxima abertura, em vez de reabrir mostrando o passado.
    expect(useIde.getState().tree["src"]).toBeUndefined();
  });

  it("atualizarArvore sem raiz carregada vira a primeira carga — não há o que preservar", async () => {
    atualizarArvore();
    await vi.waitFor(() => {
      expect(useIde.getState().tree[""]?.entradas.length).toBeGreaterThan(0);
    });
  });
});

describe("abrir e editar", () => {
  it("abrirArquivo lê pelo fs.read e a aba nasce limpa e ativa", async () => {
    await abrirArquivo({ name: "main.go", path: "src/main.go" });
    const estado = useIde.getState();
    expect(estado.activePath).toBe("src/main.go");
    const aba = estado.files[0];
    expect(aba).toMatchObject({
      content: "package main\n",
      savedContent: "package main\n",
      dirty: false,
      loading: false,
      erro: ""
    });
  });

  it("leitura que falha marca a aba com o motivo e BLOQUEIA o salvar", async () => {
    responder = (corpo) =>
      corpo.tool === "fs.read" ? { ok: false, error: "ler src/main.go: acesso negado" } : respostasPadrao(corpo);
    await abrirArquivo({ name: "main.go", path: "src/main.go" });
    expect(useIde.getState().files[0]?.erro).toContain("acesso negado");
    await salvarAtivo();
    expect(chamadas.some((corpo) => corpo.tool === "fs.write")).toBe(false);
  });

  it("arquivo CORTADO pelo teto do gateway abre somente leitura — salvar gravaria um arquivo pela metade", async () => {
    responder = (corpo) =>
      corpo.tool === "fs.read"
        ? { ok: true, output: "início…\n… (arquivo cortado: 524288 de 900000 bytes — peça por faixa: {path, offset, limit})" }
        : respostasPadrao(corpo);
    await abrirArquivo({ name: "grande.log", path: "grande.log" });
    expect(useIde.getState().files[0]?.erro).toContain("teto de leitura");
    await salvarAtivo();
    expect(chamadas.some((corpo) => corpo.tool === "fs.write")).toBe(false);
  });

  it("editar suja; salvar grava via fs.write e limpa", async () => {
    await abrirArquivo({ name: "main.go", path: "src/main.go" });
    editarAtivo("package main // v2\n");
    expect(useIde.getState().files[0]?.dirty).toBe(true);
    await salvarAtivo();
    const escrita = chamadas.find((corpo) => corpo.tool === "fs.write");
    expect(escrita?.args).toEqual({ path: "src/main.go", content: "package main // v2\n" });
    expect(useIde.getState().files[0]?.dirty).toBe(false);
    expect(useIde.getState().saveState).toBe("salvo");
  });

  it("editar DURANTE a gravação (o cartão de aprovação espera) mantém o sujo", async () => {
    await abrirArquivo({ name: "main.go", path: "src/main.go" });
    editarAtivo("v1");
    let soltar!: (valor: unknown) => void;
    responder = (corpo) =>
      corpo.tool === "fs.write" ? new Promise((resolver) => (soltar = resolver)) : respostasPadrao(corpo);
    const gravando = salvarAtivo();
    editarAtivo("v2");
    soltar({ ok: true, output: "gravado" });
    await gravando;
    const aba = useIde.getState().files[0];
    // O disco tem "v1"; o editor tem "v2" — o chip não pode dizer limpo.
    expect(aba?.savedContent).toBe("v1");
    expect(aba?.dirty).toBe(true);
  });

  it("recusa do fs.write (portão, pessoa, prazo) vira estado de erro com o motivo", async () => {
    await abrirArquivo({ name: "main.go", path: "src/main.go" });
    editarAtivo("v1");
    responder = (corpo) =>
      corpo.tool === "fs.write"
        ? { ok: false, error: "ninguém decidiu a aprovação no prazo" }
        : respostasPadrao(corpo);
    await salvarAtivo();
    expect(useIde.getState().saveState).toBe("erro");
    expect(useIde.getState().saveErro).toBe("ninguém decidiu a aprovação no prazo");
    expect(useIde.getState().files[0]?.dirty).toBe(true);
  });

  it("fecharArquivo tira a aba e devolve o palco à última que sobrou", async () => {
    await abrirArquivo({ name: "main.go", path: "src/main.go" });
    await abrirArquivo({ name: "README.md", path: "README.md" });
    fecharArquivo("README.md");
    expect(useIde.getState().activePath).toBe("src/main.go");
    fecharArquivo("src/main.go");
    expect(useIde.getState().activePath).toBe("");
  });
});

describe("ponte da conversa", () => {
  it("arquivo lido pelo especialista vira aba; palco vazio fica com ela", () => {
    abrirVindoDaConversa("docs/nota.md", "# nota");
    expect(useIde.getState().files[0]?.content).toBe("# nota");
    expect(useIde.getState().activePath).toBe("docs/nota.md");
  });

  it("rascunho SUJO da pessoa vence o conteúdo que chegou da conversa", async () => {
    await abrirArquivo({ name: "main.go", path: "src/main.go" });
    editarAtivo("meu rascunho");
    abrirVindoDaConversa("src/main.go", "conteúdo novo do bot");
    expect(useIde.getState().files[0]?.content).toBe("meu rascunho");
  });

  it("aba limpa é atualizada quando o especialista releu o arquivo", async () => {
    await abrirArquivo({ name: "main.go", path: "src/main.go" });
    abrirVindoDaConversa("src/main.go", "package main // relido\n");
    expect(useIde.getState().files[0]?.content).toBe("package main // relido\n");
    expect(useIde.getState().files[0]?.dirty).toBe(false);
  });
});

describe("índice do Quick Open", () => {
  it("coleta por fs.list recursivo e CACHEIA por sessão", async () => {
    const primeira = await indiceDeArquivos();
    expect(primeira.map((item) => item.path)).toEqual(["README.md", "src/main.go"]);
    const chamadasAntes = chamadas.length;
    await indiceDeArquivos();
    expect(chamadas.length).toBe(chamadasAntes);
  });

  it("recarregarArvore invalida o índice junto com a árvore", async () => {
    await indiceDeArquivos();
    const antes = chamadas.filter((corpo) => corpo.tool === "fs.list").length;
    recarregarArvore();
    await indiceDeArquivos();
    expect(chamadas.filter((corpo) => corpo.tool === "fs.list").length).toBeGreaterThan(antes);
  });
});

describe("busca no projeto", () => {
  it("fs.search volta estruturado em arquivo:linha", async () => {
    const ocorrencias = await buscarNoProjeto("package");
    expect(ocorrencias).toEqual([{ path: "src/main.go", line: 1, preview: "package main" }]);
    expect(chamadas[0]).toEqual({ session: "s-1", tool: "fs.search", args: { query: "package" } });
  });

  it("recusa vira exceção com o motivo — o overlay mostra a frase", async () => {
    responder = () => ({ ok: false, error: "a interface não pode pedir fs.search fora do turno" });
    await expect(buscarNoProjeto("x")).rejects.toThrow("fora do turno");
  });
});

describe("sessão", () => {
  it("trocar de sessão zera árvore, abas e índice — outro projeto, outro palco", async () => {
    await carregarPasta("");
    await abrirArquivo({ name: "main.go", path: "src/main.go" });
    await indiceDeArquivos();
    sincronizarSessao("s-2");
    const estado = useIde.getState();
    expect(estado.session).toBe("s-2");
    expect(estado.files).toEqual([]);
    expect(estado.tree).toEqual({});
    // O índice também morreu: a próxima paleta recoleta na sessão nova.
    useApp.setState({ session: "s-2" });
    const antes = chamadas.length;
    await indiceDeArquivos();
    expect(chamadas.length).toBeGreaterThan(antes);
  });

  it("sincronizar com a MESMA sessão é neutro — rail e editor chamam os dois", async () => {
    await carregarPasta("");
    sincronizarSessao("s-1");
    expect(useIde.getState().tree[""]?.entradas.length).toBeGreaterThan(0);
  });
});
