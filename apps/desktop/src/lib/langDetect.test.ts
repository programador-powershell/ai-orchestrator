import { describe, expect, it } from "vitest";
import {
  detectByContent,
  detectByFileName,
  detectByShebang,
  detectLanguage,
  isRunnableFileInput
} from "./langDetect";

describe("detectByFileName (extensão)", () => {
  it("detecta pelo caminho e monta o runner certo", () => {
    const py = detectByFileName("scripts/main.py");
    expect(py?.language).toBe("python");
    expect(py?.run?.("scripts/main.py")).toBe("python scripts/main.py");

    expect(detectByFileName("src/App.tsx")?.language).toBe("typescript");
    expect(detectByFileName("tool.mjs")?.language).toBe("javascript");
    expect(detectByFileName("cmd/serve.go")?.run?.("cmd/serve.go")).toBe("go run cmd/serve.go");
    expect(detectByFileName("build.ps1")?.run?.("build.ps1")).toContain("powershell -NoProfile");
  });

  it("cita caminhos com espaço e ignora extensões desconhecidas", () => {
    const spaced = detectByFileName("meu script.py");
    expect(spaced?.run?.("meu script.py")).toBe('python "meu script.py"');
    expect(detectByFileName("arquivo.xyz")).toBeNull();
    expect(detectByFileName("sem-extensao")).toBeNull();
  });
});

describe("detectByShebang", () => {
  it("resolve python, node e bash", () => {
    expect(detectByShebang("#!/usr/bin/env python3\nprint(1)")?.language).toBe("python");
    expect(detectByShebang("#!/usr/bin/env node\nconsole.log(1)")?.language).toBe("javascript");
    expect(detectByShebang("#!/bin/bash\necho oi")?.language).toBe("bash");
    expect(detectByShebang("print(1)")).toBeNull();
  });
});

describe("detectByContent (heurística)", () => {
  it("reconhece trechos reais de cada linguagem", () => {
    expect(
      detectByContent("def soma(a, b):\n    return a + b\n\nprint(soma(2, 3))")?.language
    ).toBe("python");
    expect(detectByContent("package main\n\nimport \"fmt\"\n\nfunc main() { fmt.Println(1) }")?.language).toBe("go");
    expect(detectByContent("fn main() {\n    let mut x = 1;\n    println!(\"{x}\");\n}")?.language).toBe("rust");
    expect(
      detectByContent("public class A { public static void main(String[] args) { System.out.println(1); } }")
        ?.language
    ).toBe("java");
    expect(detectByContent("SELECT id, name FROM users WHERE active = 1;")?.language).toBe("sql");
    expect(detectByContent("Write-Host 'oi'\n$total = 2")?.language).toBe("powershell");
    expect(detectByContent("interface Props { title: string }\nexport type X = Props;")?.language).toBe("typescript");
    expect(detectByContent("const x = require(\"fs\");\nconsole.log(x);")?.language).toBe("javascript");
  });

  it("devolve null para prosa comum", () => {
    expect(detectByContent("bom dia, preciso de ajuda com o relatório de vendas")).toBeNull();
    expect(detectByContent("")).toBeNull();
  });
});

describe("detectLanguage (ordem extensão → shebang → conteúdo)", () => {
  it("linha única com extensão vence conteúdo", () => {
    expect(detectLanguage("main.py")?.via).toBe("extension");
  });
  it("shebang vence heurística", () => {
    const detected = detectLanguage("#!/usr/bin/env python3\nconsole.log('pegadinha')");
    expect(detected?.language).toBe("python");
    expect(detected?.via).toBe("shebang");
  });
  it("código colado cai na heurística", () => {
    const detected = detectLanguage("def f():\n    return 42");
    expect(detected?.language).toBe("python");
    expect(detected?.via).toBe("content");
  });
  it("sql não tem runner direto", () => {
    expect(detectLanguage("CREATE TABLE t (id INT);")?.run).toBeNull();
  });
});

describe("isRunnableFileInput", () => {
  it("aceita arquivo simples e caminho citado com espaço", () => {
    expect(isRunnableFileInput("main.py")).toBe(true);
    expect(isRunnableFileInput('"meu script.py"')).toBe(true);
  });
  it("recusa comandos, prosa e multilinha", () => {
    expect(isRunnableFileInput("python main.py")).toBe(false);
    expect(isRunnableFileInput("dir")).toBe(false);
    expect(isRunnableFileInput("def f():\n  pass")).toBe(false);
  });
});
