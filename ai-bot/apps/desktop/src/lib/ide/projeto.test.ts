/**
 * As traduções PURAS da tela de Código: o texto que o gateway escreve
 * (supervisor/tools.go) virando estrutura. Cada regra aqui fixa um pedaço do
 * contrato — se o formato do Go mudar, é este arquivo que acusa primeiro.
 */
import { describe, expect, it } from "vitest";
import {
  coletarArquivos,
  nomeBase,
  parseBusca,
  parseListagem,
  tipoDoArquivo,
  type EntradaProjeto
} from "./projeto";

describe("parseListagem", () => {
  it("traduz o formato do fs.list: pasta com barra, arquivo com tamanho", () => {
    const saida = "src/\nREADME.md (2048 bytes)\nMakefile";
    expect(parseListagem(saida, "")).toEqual([
      { name: "src", path: "src", isDir: true, size: 0 },
      { name: "Makefile", path: "Makefile", isDir: false, size: 0 },
      { name: "README.md", path: "README.md", isDir: false, size: 2048 }
    ]);
  });

  it("ordena pastas primeiro e alfabético dentro do tipo — o Go intercala", () => {
    const nomes = parseListagem("b.ts (1 bytes)\nzz/\na.ts (1 bytes)\naa/", "").map((item) => item.name);
    expect(nomes).toEqual(["aa", "zz", "a.ts", "b.ts"]);
  });

  it("monta o caminho relativo a partir da pasta pai", () => {
    expect(parseListagem("main.go (7 bytes)", "src/cmd")[0]?.path).toBe("src/cmd/main.go");
  });

  it("'(pasta vazia)' é vazio de verdade, não um arquivo com esse nome", () => {
    expect(parseListagem("(pasta vazia)", "src")).toEqual([]);
  });

  it("o sufixo de tamanho só é removido no FIM — parênteses no meio são nome", () => {
    const [entrada] = parseListagem("notas (2 bytes) finais.txt", "");
    expect(entrada?.name).toBe("notas (2 bytes) finais.txt");
    expect(entrada?.size).toBe(0);
  });

  it("tolera CRLF — o gateway roda em Windows também", () => {
    expect(parseListagem("src/\r\na.ts (1 bytes)\r\n", "").map((item) => item.name)).toEqual(["src", "a.ts"]);
  });
});

describe("parseBusca", () => {
  it("traduz `caminho:linha: trecho` do fs.search", () => {
    const saida = "src/main.go:12: func main() {\nlib/a.ts:3: export const x = 1";
    expect(parseBusca(saida)).toEqual([
      { path: "src/main.go", line: 12, preview: "func main() {" },
      { path: "lib/a.ts", line: 3, preview: "export const x = 1" }
    ]);
  });

  it("a frase de resumo ('nenhuma ocorrência…') não vira resultado", () => {
    expect(parseBusca('nenhuma ocorrência de "x" em 40 arquivos')).toEqual([]);
  });

  it("linha de ocorrência vazia mantém o preview vazio, não descarta", () => {
    expect(parseBusca("a.ts:1: ")).toEqual([{ path: "a.ts", line: 1, preview: "" }]);
  });
});

describe("coletarArquivos", () => {
  const arvore: Record<string, EntradaProjeto[]> = {
    "": [
      { name: "src", path: "src", isDir: true, size: 0 },
      { name: "node_modules", path: "node_modules", isDir: true, size: 0 },
      { name: "a.ts", path: "a.ts", isDir: false, size: 1 }
    ],
    src: [
      { name: "fundo", path: "src/fundo", isDir: true, size: 0 },
      { name: "b.ts", path: "src/b.ts", isDir: false, size: 1 }
    ],
    "src/fundo": [{ name: "c.ts", path: "src/fundo/c.ts", isDir: false, size: 1 }]
  };

  const listar = (sub: string) => Promise.resolve(arvore[sub] ?? []);

  it("varre em largura pulando as pastas geradas (node_modules e afins)", async () => {
    const arquivos = await coletarArquivos(listar);
    expect(arquivos.map((item) => item.path)).toEqual(["a.ts", "src/b.ts", "src/fundo/c.ts"]);
  });

  it("respeita o teto de arquivos — cada nível é um POST no gateway", async () => {
    const arquivos = await coletarArquivos(listar, { maxEntries: 2 });
    expect(arquivos).toHaveLength(2);
  });

  it("respeita a profundidade máxima", async () => {
    const arquivos = await coletarArquivos(listar, { maxDepth: 1 });
    expect(arquivos.map((item) => item.path)).toEqual(["a.ts", "src/b.ts"]);
  });

  it("erro na RAIZ sobe (sem raiz não há índice); erro em subpasta é pulado", async () => {
    await expect(coletarArquivos(() => Promise.reject(new Error("sem workspace")))).rejects.toThrow(
      "sem workspace"
    );
    const comFalha = (sub: string) =>
      sub === "src" ? Promise.reject(new Error("sem permissão")) : listar(sub);
    const arquivos = await coletarArquivos(comFalha);
    expect(arquivos.map((item) => item.path)).toEqual(["a.ts"]);
  });
});

describe("tipoDoArquivo", () => {
  it("classifica pela extensão para o ícone da árvore", () => {
    expect(tipoDoArquivo("main.go")).toBe("codigo");
    expect(tipoDoArquivo("store.test.tsx")).toBe("codigo");
    expect(tipoDoArquivo("package.json")).toBe("json");
    expect(tipoDoArquivo("README.md")).toBe("texto");
    expect(tipoDoArquivo("tokens.css")).toBe("estilo");
    expect(tipoDoArquivo("logo.svg")).toBe("imagem");
    expect(tipoDoArquivo("schema.sql")).toBe("dados");
    expect(tipoDoArquivo(".gitignore")).toBe("config");
    expect(tipoDoArquivo("build.ps1")).toBe("shell");
    expect(tipoDoArquivo("LICENSE")).toBe("outro");
  });
});

describe("nomeBase", () => {
  it("fica com o último segmento, aceitando os dois separadores", () => {
    expect(nomeBase("src/lib/a.ts")).toBe("a.ts");
    expect(nomeBase("src\\lib\\a.ts")).toBe("a.ts");
    expect(nomeBase("a.ts")).toBe("a.ts");
  });
});
