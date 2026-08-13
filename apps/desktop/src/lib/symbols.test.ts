import { describe, expect, it } from "vitest";

import {
  buildIndex,
  dialectOf,
  enclosingSymbol,
  extractSymbols,
  indentOf,
  outlineOf,
  reindexFile,
  removeFile,
  scoreSymbol,
  searchSymbols,
  type CodeSymbol
} from "./symbols";

const nomes = (symbols: CodeSymbol[]) => symbols.map((symbol) => symbol.name);
const par = (symbols: CodeSymbol[]) => symbols.map((symbol) => `${symbol.kind}:${symbol.name}`);

describe("dialectOf", () => {
  it("cobre as extensões que o editor destaca", () => {
    expect(dialectOf("a.tsx")).toBe("ts");
    expect(dialectOf("a.mjs")).toBe("ts");
    expect(dialectOf("a.py")).toBe("py");
    expect(dialectOf("a.rs")).toBe("rs");
    expect(dialectOf("a.sql")).toBe("sql");
    expect(dialectOf("a.md")).toBe("md");
  });

  it("arquivo sem dialeto conhecido não entra no índice", () => {
    expect(dialectOf("a.bin")).toBe("none");
    expect(extractSymbols("a.bin", "function x() {}")).toEqual([]);
  });
});

describe("indentOf", () => {
  it("mede espaço e tabulação de forma consistente", () => {
    expect(indentOf("  a")).toBe(2);
    expect(indentOf("\ta")).toBe(4);
    expect(indentOf("a")).toBe(0);
  });
});

describe("extractSymbols · TypeScript", () => {
  it("pega as declarações de topo com a linha exata", () => {
    const src = ["export function alfa() {}", "", "class Beta {}", "interface Gama {}"].join("\n");
    const symbols = extractSymbols("a.ts", src);
    expect(par(symbols)).toEqual(["function:alfa", "class:Beta", "interface:Gama"]);
    expect(symbols[0].line).toBe(1);
    expect(symbols[1].line).toBe(3);
  });

  it("reconhece const com arrow function como função", () => {
    const symbols = extractSymbols("a.ts", "export const somar = (a: number) => a + 1;");
    expect(par(symbols)).toEqual(["function:somar"]);
  });

  it("separa constante de variável pelo caixa alta", () => {
    const src = ["const LIMITE = 10;", "const contador = 0;"].join("\n");
    expect(par(extractSymbols("a.ts", src))).toEqual(["constant:LIMITE", "variable:contador"]);
  });

  it("não deixa `export default function` virar um símbolo chamado default", () => {
    expect(nomes(extractSymbols("a.ts", "export default function Pagina() {}"))).toEqual(["Pagina"]);
  });

  it("método dentro de classe vira method, com o container", () => {
    const src = ["class Conta {", "  sacar(valor: number) {", "    return valor;", "  }", "}"].join("\n");
    const symbols = extractSymbols("a.ts", src);
    expect(par(symbols)).toEqual(["class:Conta", "method:sacar"]);
    expect(symbols[1].container).toBe("Conta");
    expect(symbols[1].line).toBe(2);
  });

  it("não confunde bloco de controle com método", () => {
    const src = ["class X {", "  go() {", "    if (a) {", "    }", "    for (const y of z) {", "    }", "  }", "}"].join(
      "\n"
    );
    expect(nomes(extractSymbols("a.ts", src))).toEqual(["X", "go"]);
  });

  it("chamada de função no topo do arquivo não vira símbolo", () => {
    // Fora de um container, `configurar(...) {` é chamada, não declaração —
    // e um índice cheio de fantasma faz o ir-para-símbolo perder a confiança.
    expect(extractSymbols("a.ts", "configurar({\n  chave: 1\n});")).toEqual([]);
  });

  it("ignora o interior de comentário de bloco", () => {
    const src = ["/*", " * export function fantasma() {}", " */", "export function real() {}"].join("\n");
    expect(nomes(extractSymbols("a.ts", src))).toEqual(["real"]);
  });

  it("ignora comentário de linha", () => {
    expect(extractSymbols("a.ts", "// function fantasma() {}")).toEqual([]);
  });

  it("comentário de bloco que abre e fecha na mesma linha não engole o resto", () => {
    const src = ["/* nota */ export function real() {}"].join("\n");
    expect(nomes(extractSymbols("a.ts", src))).toEqual(["real"]);
  });

  it("marca exportado, que é o que o resto do projeto alcança", () => {
    const symbols = extractSymbols("a.ts", "export function publica() {}\nfunction privada() {}");
    expect(symbols[0].exported).toBe(true);
    expect(symbols[1].exported).toBe(false);
  });

  it("fecha o container quando o recuo volta", () => {
    const src = ["class A {", "  metodo() {}", "}", "function solta() {}"].join("\n");
    const symbols = extractSymbols("a.ts", src);
    expect(symbols.find((symbol) => symbol.name === "solta")?.container).toBeUndefined();
  });
});

describe("extractSymbols · Python", () => {
  it("pega class e def com o aninhamento certo", () => {
    const src = ["class Conta:", "    def sacar(self):", "        pass", "", "def solta():", "    pass"].join("\n");
    const symbols = extractSymbols("a.py", src);
    expect(par(symbols)).toEqual(["class:Conta", "method:sacar", "function:solta"]);
    expect(symbols[1].container).toBe("Conta");
    expect(symbols[2].container).toBeUndefined();
  });

  it("reconhece def assíncrono", () => {
    expect(nomes(extractSymbols("a.py", "async def buscar():\n    pass"))).toEqual(["buscar"]);
  });

  it("ignora o conteúdo da docstring", () => {
    const src = ['"""', "def fantasma():", '"""', "def real():", "    pass"].join("\n");
    expect(nomes(extractSymbols("a.py", src))).toEqual(["real"]);
  });

  it("docstring de uma linha só não engole o arquivo", () => {
    const src = ['"""nota"""', "def real():", "    pass"].join("\n");
    expect(nomes(extractSymbols("a.py", src))).toEqual(["real"]);
  });

  it("ignora comentário com cerquilha", () => {
    expect(extractSymbols("a.py", "# def fantasma(): pass")).toEqual([]);
  });
});

describe("extractSymbols · Rust", () => {
  it("pega fn, struct, enum e trait", () => {
    const src = [
      "pub fn somar(a: i32) -> i32 { a }",
      "pub struct Conta {}",
      "enum Estado {}",
      "pub trait Salvavel {}"
    ].join("\n");
    expect(par(extractSymbols("a.rs", src))).toEqual([
      "function:somar",
      "struct:Conta",
      "enum:Estado",
      "trait:Salvavel"
    ]);
  });

  it("em `impl Trait for Tipo` o nome útil é o do TIPO", () => {
    const symbols = extractSymbols("a.rs", "impl Display for Conta {\n    fn fmt(&self) {}\n}");
    expect(symbols[0].name).toBe("Conta");
    expect(symbols[0].kind).toBe("impl");
    // O método dentro do impl fica pendurado no tipo.
    expect(symbols[1].container).toBe("Conta");
  });

  it("impl simples também", () => {
    expect(extractSymbols("a.rs", "impl Conta {}")[0].name).toBe("Conta");
  });

  it("marca pub como exportado", () => {
    const symbols = extractSymbols("a.rs", "pub fn a() {}\nfn b() {}");
    expect(symbols[0].exported).toBe(true);
    expect(symbols[1].exported).toBe(false);
  });

  it("ignora comentário de bloco", () => {
    expect(nomes(extractSymbols("a.rs", "/*\npub fn fantasma() {}\n*/\npub fn real() {}"))).toEqual(["real"]);
  });
});

describe("extractSymbols · SQL e Markdown", () => {
  it("pega tabela e view, sem se importar com a caixa", () => {
    const src = ["CREATE TABLE IF NOT EXISTS public.contas (", "  id uuid", ");", "create view v_ativas as select 1;"].join(
      "\n"
    );
    expect(par(extractSymbols("a.sql", src))).toEqual(["table:public.contas", "view:v_ativas"]);
  });

  it("ignora comentário SQL", () => {
    expect(extractSymbols("a.sql", "-- create table fantasma (id int);")).toEqual([]);
  });

  it("títulos de markdown viram símbolos com o nível como recuo", () => {
    const symbols = extractSymbols("a.md", "# Topo\n## Meio\n### Fundo");
    expect(nomes(symbols)).toEqual(["Topo", "Meio", "Fundo"]);
    expect(symbols[1].container).toBe("Topo");
    expect(symbols[2].container).toBe("Meio");
  });
});

describe("índice", () => {
  const arquivos = [
    { path: "src/a.ts", text: "export function alfa() {}\nexport const LIMITE = 1;" },
    { path: "src/b.ts", text: "export function beta() {}" }
  ];

  it("junta os símbolos de todos os arquivos", () => {
    const index = buildIndex(arquivos);
    expect(index.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(nomes(index.symbols).sort()).toEqual(["LIMITE", "alfa", "beta"]);
  });

  it("reindexa só o arquivo editado", () => {
    const index = reindexFile(buildIndex(arquivos), "src/a.ts", "export function alfa2() {}");
    expect(nomes(index.symbols).sort()).toEqual(["alfa2", "beta"]);
    expect(index.files).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("reindexar um arquivo novo o adiciona à lista", () => {
    const index = reindexFile(buildIndex(arquivos), "src/c.ts", "export function gama() {}");
    expect(index.files).toContain("src/c.ts");
    expect(nomes(index.symbols)).toContain("gama");
  });

  it("remover o arquivo tira os símbolos dele", () => {
    const index = removeFile(buildIndex(arquivos), "src/a.ts");
    expect(nomes(index.symbols)).toEqual(["beta"]);
    expect(index.files).toEqual(["src/b.ts"]);
  });

  it("remover arquivo que não está no índice devolve o mesmo objeto", () => {
    const index = buildIndex(arquivos);
    expect(removeFile(index, "nao/existe.ts")).toBe(index);
  });
});

describe("busca", () => {
  const index = buildIndex([
    {
      path: "src/store.ts",
      text: ["export const useDesign = () => 1;", "export const useIsDarkMode = () => 1;", "function design() {}"].join(
        "\n"
      )
    }
  ]);

  it("prefixo exato ganha de subsequência", () => {
    // Quem digita `useD` quer useDesign, não useIsDarkMode só porque as
    // letras aparecem na ordem.
    expect(searchSymbols(index, "useD")[0].name).toBe("useDesign");
  });

  it("nome idêntico vem primeiro", () => {
    expect(searchSymbols(index, "design")[0].name).toBe("design");
  });

  it("exportado aparece antes do interno em empate", () => {
    const dois = buildIndex([
      { path: "a.ts", text: "function alfa() {}" },
      { path: "b.ts", text: "export function alfa() {}" }
    ]);
    expect(searchSymbols(dois, "alfa")[0].exported).toBe(true);
  });

  it("consulta vazia não devolve o índice inteiro", () => {
    expect(searchSymbols(index, "   ")).toEqual([]);
  });

  it("respeita o limite", () => {
    expect(searchSymbols(index, "use", 1)).toHaveLength(1);
  });

  it("nome que não casa de jeito nenhum fica de fora", () => {
    expect(searchSymbols(index, "zzz")).toEqual([]);
  });

  it("scoreSymbol devolve negativo para quem não casa", () => {
    const symbol = index.symbols[0];
    expect(scoreSymbol(symbol, "zzz")).toBeLessThan(0);
    expect(scoreSymbol(symbol, "")).toBe(0);
  });
});

describe("enclosingSymbol", () => {
  const index = buildIndex([
    {
      path: "a.ts",
      text: ["export function alfa() {", "  return 1;", "}", "", "export function beta() {", "  return 2;", "}"].join(
        "\n"
      )
    }
  ]);

  it("acha a declaração que contém a linha", () => {
    expect(enclosingSymbol(index, "a.ts", 2)?.name).toBe("alfa");
    expect(enclosingSymbol(index, "a.ts", 6)?.name).toBe("beta");
  });

  it("antes da primeira declaração não há container", () => {
    expect(enclosingSymbol(index, "a.ts", 0)).toBeNull();
  });

  it("arquivo fora do índice devolve null", () => {
    expect(enclosingSymbol(index, "z.ts", 5)).toBeNull();
  });
});

describe("outlineOf", () => {
  it("devolve em ordem de linha, com o aninhamento", () => {
    const index = buildIndex([{ path: "a.ts", text: "class A {\n  metodo() {}\n}\nfunction solta() {}" }]);
    expect(outlineOf(index, "a.ts").map((entry) => `${entry.depth}:${entry.symbol.name}`)).toEqual([
      "0:A",
      "1:metodo",
      "0:solta"
    ]);
  });
});
