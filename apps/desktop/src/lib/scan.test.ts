import { describe, expect, it } from "vitest";
import {
  applyUnifiedDiff,
  buildReviewPrompt,
  parseFindings,
  parseUnifiedDiff,
  scanTextForSecrets
} from "./scan";

describe("scanTextForSecrets", () => {
  it("detecta chave AWS e senha em literal, com arquivo e linha", () => {
    const text = 'aws = "AKIAIOSFODNN7EXAMPLE"\npassword = "super-secreta-123"\n';
    const findings = scanTextForSecrets("config/app.py", text);

    const aws = findings.find((finding) => finding.title.includes("AWS"));
    expect(aws).toBeDefined();
    expect(aws?.severity).toBe("critical");
    expect(aws?.line).toBe(1);

    const literal = findings.find((finding) => finding.title.includes("literal"));
    expect(literal).toBeDefined();
    expect(literal?.file).toBe("config/app.py");
    expect(literal?.line).toBe(2);
    expect(literal?.suggestion).toContain("cofre");
    // achado corrigível vem com patch em diff unificado
    expect(literal?.patch).toContain("@@ -2,1 +2,1 @@");
  });

  it("nunca inclui o valor do segredo no achado", () => {
    const findings = scanTextForSecrets("a.env", 'password = "super-secreta-123"');
    expect(JSON.stringify(findings.map(({ patch: _patch, ...rest }) => rest))).not.toContain(
      "super-secreta-123"
    );
  });

  it("ignora texto normal", () => {
    const text = "Este projeto usa o cofre corporativo.\nNenhuma credencial fica no código.";
    expect(scanTextForSecrets("README.md", text)).toEqual([]);
  });

  it("o patch troca o valor do segredo, não a primeira string da linha", () => {
    const line = 'const cfg = { name: "bob", password: "hunter22" };';
    const [finding] = scanTextForSecrets("cfg.ts", line);
    expect(finding?.patch).toContain('password: "${SECRET_FROM_VAULT}"');
    expect(finding?.patch).toContain('name: "bob"'); // literal anterior preservado
  });

  it("não flagra placeholders de cofre/template como segredo", () => {
    const text =
      'password = "${SECRET_FROM_VAULT}"\napi_key = "{{vault.api}}"\ntoken = "%TOKEN%"\nsecret = "<YOUR_SECRET>"';
    expect(scanTextForSecrets("config.ini", text)).toEqual([]);
  });
});

describe("parseFindings", () => {
  it("extrai bloco json válido, valida severidade e gera ids ausentes", () => {
    const text =
      "Resumo da revisão.\n```json\n" +
      JSON.stringify([
        { severity: "high", title: "Token exposto", file: "src/a.ts", line: 3, detail: "Token no fonte." },
        { severity: "absurda", title: "Sem severidade válida", file: "src/b.ts", detail: "x" }
      ]) +
      "\n```";
    const findings = parseFindings(text);
    expect(findings).toHaveLength(2);
    expect(findings[0].severity).toBe("high");
    expect(findings[0].line).toBe(3);
    expect(findings[0].id).toBeTruthy();
    expect(findings[1].severity).toBe("info");
    expect(findings[0].id).not.toBe(findings[1].id);
  });

  it("descarta entradas sem título/arquivo e blocos malformados", () => {
    expect(parseFindings("```json\n{quebrado]\n```")).toEqual([]);
    expect(parseFindings("resposta sem bloco algum")).toEqual([]);
    const partial = parseFindings('```json\n[{"detail":"sem título nem arquivo"}]\n```');
    expect(partial).toEqual([]);
  });
});

describe("parseUnifiedDiff", () => {
  it("classifica hunk, contexto, remoção e adição", () => {
    const patch = "@@ -1,3 +1,3 @@\n contexto A\n-removida\n+adicionada\n contexto B";
    const lines = parseUnifiedDiff(patch);
    expect(lines.map((line) => line.type)).toEqual(["hunk", "context", "remove", "add", "context"]);
    expect(lines[2].text).toBe("removida");
    expect(lines[3].text).toBe("adicionada");
  });

  it("ignora cabeçalhos de arquivo do diff", () => {
    const lines = parseUnifiedDiff("--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b");
    expect(lines[0].type).toBe("hunk");
    expect(lines).toHaveLength(3);
  });

  it("dentro do hunk, +++ e --- são conteúdo — e aparecem na prévia", () => {
    // O furo: a prévia escondia estas duas linhas e a aplicação gravava as
    // duas. Quem revisava aprovava um patch diferente do que ia para o disco.
    const patch = "@@ -1,2 +1,2 @@\n---- senha = 'x'\n++++i;";
    const lines = parseUnifiedDiff(patch);
    expect(lines.map((line) => line.type)).toEqual(["hunk", "remove", "add"]);
    expect(lines[1].text).toBe("--- senha = 'x'");
    expect(lines[2].text).toBe("+++i;");
  });

  it("a prévia mostra exatamente o que a aplicação grava", () => {
    const source = "--- senha = 'x'\nfim";
    const patch = "@@ -1,1 +1,1 @@\n---- senha = 'x'\n++++i;";
    const previa = parseUnifiedDiff(patch);
    const aplicado = applyUnifiedDiff(source, patch);
    const adicionadas = previa.filter((line) => line.type === "add").map((line) => line.text);
    expect(aplicado).toBe("+++i;\nfim");
    expect(adicionadas.every((texto) => aplicado?.includes(texto))).toBe(true);
  });
});

describe("applyUnifiedDiff", () => {
  it("aplica um patch simples preservando o resto do arquivo", () => {
    const source = 'linha 1\npassword = "abc"\nlinha 3';
    const patch = '@@ -2,1 +2,1 @@\n-password = "abc"\n+password = "${SECRET_FROM_VAULT}"';
    expect(applyUnifiedDiff(source, patch)).toBe('linha 1\npassword = "${SECRET_FROM_VAULT}"\nlinha 3');
  });

  it("devolve null quando o patch não bate com o conteúdo", () => {
    expect(applyUnifiedDiff("outra coisa", "@@ -1,1 +1,1 @@\n-não existe\n+x")).toBeNull();
  });

  it("aplica em arquivo CRLF e devolve CRLF", () => {
    // Windows é a plataforma-alvo: sem isto o auto-fix de segredo nunca
    // aplicava, e a UI culpava o arquivo ("mudou desde o scan").
    const source = 'linha 1\r\npassword = "abc"\r\nlinha 3';
    const patch = '@@ -2,1 +2,1 @@\n-password = "abc"\n+password = "${SECRET_FROM_VAULT}"';
    expect(applyUnifiedDiff(source, patch)).toBe(
      'linha 1\r\npassword = "${SECRET_FROM_VAULT}"\r\nlinha 3'
    );
  });

  it("arquivo LF continua saindo em LF", () => {
    const source = "a\nb";
    expect(applyUnifiedDiff(source, "@@ -1,1 +1,1 @@\n-a\n+z")).toBe("z\nb");
  });
});

describe("buildReviewPrompt", () => {
  it("monta system+user pedindo bloco json com os arquivos no corpo", () => {
    const messages = buildReviewPrompt([{ path: "src/a.ts", content: "const x = 1;" }]);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("```json");
    expect(messages[1].content).toContain("src/a.ts");
  });
});
