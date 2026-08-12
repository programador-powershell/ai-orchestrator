import { describe, expect, it } from "vitest";
import { RULES_MAX_CHARS, RULE_FILES, loadProjectRules, rulesSystemMessage } from "./projectRules";

/** Filesystem falso: só os caminhos do mapa existem; o resto rejeita como o fs_read real. */
function fakeReader(files: Record<string, string>) {
  const calls: string[] = [];
  const roots: string[] = [];
  const read = async (root: string, path: string): Promise<string> => {
    calls.push(path);
    roots.push(root);
    if (!(path in files)) throw new Error(`ENOENT: ${root}/${path}`);
    return files[path];
  };
  return { read, calls, roots };
}

describe("loadProjectRules", () => {
  it("devolve o primeiro arquivo da ordem de precedência", async () => {
    const fs = fakeReader({
      "AGENTS.md": "regras do agente",
      "CLAUDE.md": "regras do claude",
      ".cursorrules": "regras do cursor"
    });

    const rules = await loadProjectRules("/repo", fs.read);

    expect(rules).toEqual({ source: "AGENTS.md", content: "regras do agente" });
    expect(fs.calls).toEqual(["AGENTS.md"]);
    expect(fs.roots).toEqual(["/repo"]);
  });

  it("pula arquivos ausentes e vazios até achar um com conteúdo", async () => {
    const fs = fakeReader({ "CLAUDE.md": "   \n  ", ".cursorrules": "sempre use TDD" });

    const rules = await loadProjectRules("/repo", fs.read);

    expect(rules).toEqual({ source: ".cursorrules", content: "sempre use TDD" });
    expect(fs.calls).toEqual(["AGENTS.md", "CLAUDE.md", ".cursorrules"]);
  });

  it("chega até as instruções do copilot quando é o único presente", async () => {
    const fs = fakeReader({ ".github/copilot-instructions.md": "prefira funções puras" });

    const rules = await loadProjectRules("/repo", fs.read);

    expect(rules?.source).toBe(".github/copilot-instructions.md");
    expect(fs.calls).toEqual([...RULE_FILES]);
  });

  it("retorna null quando nenhum arquivo de regras existe", async () => {
    const fs = fakeReader({});

    await expect(loadProjectRules("/repo", fs.read)).resolves.toBeNull();
  });

  it("trunca conteúdo gigante preservando o início e avisando do corte", async () => {
    const huge = "x".repeat(RULES_MAX_CHARS + 500);
    const fs = fakeReader({ "AGENTS.md": `INICIO\n${huge}` });

    const rules = await loadProjectRules("/repo", fs.read);

    expect(rules?.content.startsWith("INICIO\n")).toBe(true);
    expect(rules?.content).toContain("truncad");
    expect(rules?.content.length).toBeLessThan(huge.length);
  });

  it("não trunca conteúdo dentro do limite", async () => {
    const content = "y".repeat(RULES_MAX_CHARS);
    const fs = fakeReader({ "AGENTS.md": content });

    const rules = await loadProjectRules("/repo", fs.read);

    expect(rules?.content).toBe(content);
  });
});

describe("rulesSystemMessage", () => {
  it("marca as regras como do projeto e com precedência sobre preferências gerais", () => {
    const message = rulesSystemMessage({ source: "AGENTS.md", content: "commits em pt-BR" });

    expect(message.role).toBe("system");
    expect(message.content).toContain("AGENTS.md");
    expect(message.content).toContain("commits em pt-BR");
    expect(message.content.toLowerCase()).toContain("precedência");
    expect(message.content.toLowerCase()).toContain("projeto");
  });
});
