import { describe, expect, it } from "vitest";
import {
  ARTIFACT_MIN_LINES,
  artifactFileName,
  extractArtifacts,
  languageExtension,
  replaceArtifacts
} from "./canvas";

const codeOf = (lines: number) => Array.from({ length: lines }, (_, i) => `const linha${i} = ${i};`).join("\n");

const longCode = codeOf(ARTIFACT_MIN_LINES);
const shortCode = codeOf(ARTIFACT_MIN_LINES - 1);

describe("extractArtifacts — código", () => {
  it("transforma bloco longo em artifact editável", () => {
    const artifacts = extractArtifacts(`Segue o módulo:\n\n\`\`\`ts\n${longCode}\n\`\`\`\n\nPronto.`);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].kind).toBe("code");
    expect(artifacts[0].content).toBe(longCode);
  });

  it("ignora bloco curto — continua inline no markdown", () => {
    expect(extractArtifacts(`Olha:\n\n\`\`\`ts\n${shortCode}\n\`\`\`\n`)).toEqual([]);
  });

  it("preserva a linguagem do bloco", () => {
    const artifacts = extractArtifacts(`\`\`\`python\n${longCode}\n\`\`\``);
    expect(artifacts[0].language).toBe("python");
  });

  it("bloco longo sem linguagem não perde o conteúdo", () => {
    const artifacts = extractArtifacts(`\`\`\`\n${longCode}\n\`\`\``);
    expect(artifacts[0].language).toBe("");
    expect(artifacts[0].content).toBe(longCode);
  });

  it("markdown sem cerca nenhuma não gera artifact", () => {
    expect(extractArtifacts("Só texto **normal** com `inline`.")).toEqual([]);
  });

  it("bloco ainda aberto (streaming) já vira artifact ao passar do limite", () => {
    const artifacts = extractArtifacts(`Escrevendo:\n\n\`\`\`ts\n${longCode}`);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].content).toBe(longCode);
  });
});

describe("extractArtifacts — títulos", () => {
  it("usa o title= explícito da cerca", () => {
    const artifacts = extractArtifacts(`\`\`\`ts title="Motor de fusão"\n${longCode}\n\`\`\``);
    expect(artifacts[0].title).toBe("Motor de fusão");
  });

  it("usa o nome de arquivo declarado depois da linguagem", () => {
    const artifacts = extractArtifacts(`\`\`\`ts src/lib/engine.ts\n${longCode}\n\`\`\``);
    expect(artifacts[0].title).toBe("src/lib/engine.ts");
  });

  it("usa o nome de arquivo do comentário da primeira linha", () => {
    const artifacts = extractArtifacts(`\`\`\`ts\n// src/lib/store.ts\n${longCode}\n\`\`\``);
    expect(artifacts[0].title).toBe("src/lib/store.ts");
  });

  it("sem pista nenhuma, cai num nome de arquivo pela linguagem", () => {
    expect(extractArtifacts(`\`\`\`typescript\n${longCode}\n\`\`\``)[0].title).toBe("codigo.ts");
    expect(extractArtifacts(`\`\`\`\n${longCode}\n\`\`\``)[0].title).toBe("codigo.txt");
  });
});

describe("extractArtifacts — documento", () => {
  it("bloco ```artifact vira documento mesmo sendo curto", () => {
    const artifacts = extractArtifacts("```artifact\n# Plano\n\nUm parágrafo.\n```");
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].kind).toBe("document");
    expect(artifacts[0].content).toBe("# Plano\n\nUm parágrafo.");
  });

  it("título do documento vem do primeiro heading", () => {
    expect(extractArtifacts("```artifact\n## Guia de onboarding\ntexto\n```")[0].title).toBe("Guia de onboarding");
  });

  it("título explícito ganha do heading", () => {
    expect(extractArtifacts('```artifact title="Release checklist"\n# Outro\n```')[0].title).toBe("Release checklist");
  });

  it("documento sem título nenhum tem rótulo padrão", () => {
    expect(extractArtifacts("```artifact\ntexto solto\n```")[0].title).toBe("Documento");
  });

  it("cerca de 4 crases carrega código dentro do documento sem quebrar", () => {
    const source = "````artifact\n# Doc\n\n```ts\nconst a = 1;\n```\n````";
    const artifacts = extractArtifacts(source);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].kind).toBe("document");
    expect(artifacts[0].content).toBe("# Doc\n\n```ts\nconst a = 1;\n```");
  });
});

describe("replaceArtifacts", () => {
  it("round-trip sem edição devolve o markdown idêntico", () => {
    const source = `Antes.\n\n\`\`\`ts title="x"\n${longCode}\n\`\`\`\n\nDepois.\n`;
    expect(replaceArtifacts(source, extractArtifacts(source))).toBe(source);
  });

  it("grava o conteúdo editado sem tocar no resto do markdown", () => {
    const source = `Antes.\n\n\`\`\`ts\n${longCode}\n\`\`\`\n\nDepois.\n`;
    const [artifact] = extractArtifacts(source);
    const updated = replaceArtifacts(source, [{ ...artifact, content: "const editado = true;" }]);
    expect(updated).toBe("Antes.\n\n```ts\nconst editado = true;\n```\n\nDepois.\n");
    expect(updated.startsWith("Antes.")).toBe(true);
  });

  it("atualiza a linguagem quando o artifact muda de idioma", () => {
    const source = `\`\`\`ts\n${longCode}\n\`\`\``;
    const [artifact] = extractArtifacts(source);
    const updated = replaceArtifacts(source, [{ ...artifact, language: "python" }]);
    expect(updated.startsWith("```python\n")).toBe(true);
  });

  it("atinge só o artifact do id informado", () => {
    const source = `\`\`\`ts\n${longCode}\n\`\`\`\n\n\`\`\`py\n${longCode}\n\`\`\`\n`;
    const artifacts = extractArtifacts(source);
    expect(artifacts[0].id).not.toBe(artifacts[1].id);
    const updated = replaceArtifacts(source, [{ ...artifacts[1], content: "print(1)" }]);
    expect(updated).toBe(`\`\`\`ts\n${longCode}\n\`\`\`\n\n\`\`\`py\nprint(1)\n\`\`\`\n`);
  });

  it("ids desconhecidos são ignorados", () => {
    const source = `\`\`\`ts\n${longCode}\n\`\`\``;
    const artifacts = extractArtifacts(source);
    expect(replaceArtifacts(source, [{ ...artifacts[0], id: "fantasma", content: "x" }])).toBe(source);
  });

  it("blocos curtos inline não são afetados", () => {
    const source = `\`\`\`ts\n${shortCode}\n\`\`\`\n\n\`\`\`ts\n${longCode}\n\`\`\``;
    const artifacts = extractArtifacts(source);
    const updated = replaceArtifacts(source, [{ ...artifacts[0], content: "novo" }]);
    expect(updated).toBe(`\`\`\`ts\n${shortCode}\n\`\`\`\n\n\`\`\`ts\nnovo\n\`\`\``);
  });

  it("cresce a cerca quando o conteúdo editado passa a ter crases", () => {
    const source = "```artifact\n# Doc\n```";
    const [artifact] = extractArtifacts(source);
    const updated = replaceArtifacts(source, [{ ...artifact, content: "# Doc\n\n```ts\nconst a = 1;\n```" }]);
    expect(updated).toBe("````artifact\n# Doc\n\n```ts\nconst a = 1;\n```\n````");
    expect(extractArtifacts(updated)[0].content).toBe("# Doc\n\n```ts\nconst a = 1;\n```");
  });

  it("round-trip de bloco ainda aberto não fecha a cerca", () => {
    const source = `\`\`\`ts\n${longCode}`;
    expect(replaceArtifacts(source, extractArtifacts(source))).toBe(source);
  });

  it("editar → extrair de novo devolve o mesmo conteúdo", () => {
    const source = `Doc:\n\n\`\`\`artifact\n# A\n\`\`\`\n\n\`\`\`ts\n${longCode}\n\`\`\`\n`;
    const artifacts = extractArtifacts(source);
    const editados = artifacts.map((item) => ({ ...item, content: `${item.content}\n// editado` }));
    const updated = replaceArtifacts(source, editados);
    expect(extractArtifacts(updated).map((item) => item.content)).toEqual(editados.map((item) => item.content));
  });
});

describe("languageExtension / artifactFileName", () => {
  it("traduz a linguagem para extensão real", () => {
    expect(languageExtension("typescript")).toBe("ts");
    expect(languageExtension("python")).toBe("py");
    expect(languageExtension("")).toBe("txt");
    expect(languageExtension("sql")).toBe("sql");
  });

  it("documento salva como .md e código mantém o nome de arquivo do título", () => {
    expect(artifactFileName({ id: "a", kind: "document", title: "Meu Plano", content: "" })).toBe("meu-plano.md");
    expect(artifactFileName({ id: "b", kind: "code", language: "ts", title: "src/x.ts", content: "" })).toBe("src/x.ts");
  });
});
