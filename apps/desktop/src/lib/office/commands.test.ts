import { describe, expect, it } from "vitest";
import { isActionAllowed, parseCommands, previewChanges, validateCommand } from "./commands";

describe("validateCommand", () => {
  it("aceita e normaliza o comando do exemplo da especificação", () => {
    const result = validateCommand(
      {
        action: "replace_text",
        target: { type: "heading", text: "Proposta Comercial" },
        value: "Proposta Comercial 2026"
      },
      "docx"
    );
    expect(result.ok).toBe(true);
    expect(result.command?.action).toBe("replace_text");
    expect(result.command?.value).toBe("Proposta Comercial 2026");
    // Rótulo é gerado quando o modelo não manda um.
    expect(result.command?.label).toContain("Substituir texto");
  });

  it("recusa ação fora do vocabulário (a IA não inventa operação)", () => {
    const result = validateCommand({ action: "delete_everything", target: { type: "text" } }, "docx");
    expect(result.ok).toBe(false);
    expect(result.issues[0]).toContain("ação desconhecida");
  });

  it("recusa ação incompatível com o formato", () => {
    const result = validateCommand({ action: "insert_slide", target: { type: "slide" } }, "xlsx");
    expect(result.ok).toBe(false);
    expect(result.issues[0]).toContain("não se aplica a xlsx");
  });

  it("recusa comando sem alvo ou com alvo inválido", () => {
    expect(validateCommand({ action: "delete" }, "docx").ok).toBe(false);
    expect(validateCommand({ action: "delete", target: { type: "galaxia" } }, "docx").ok).toBe(false);
  });

  it("recusa entrada que nem é objeto", () => {
    expect(validateCommand("apague tudo", "docx").ok).toBe(false);
    expect(validateCommand(null, "docx").ok).toBe(false);
  });

  it("preserva ref e index do alvo", () => {
    const result = validateCommand(
      { action: "set_cells", target: { type: "range", ref: "B12:F24", index: 2 }, value: [[1, 2]] },
      "xlsx"
    );
    expect(result.command?.target).toEqual({ type: "range", ref: "B12:F24", index: 2 });
  });
});

describe("isActionAllowed", () => {
  it("PDF só aceita comentário (não editamos o conteúdo)", () => {
    expect(isActionAllowed("comment", "pdf")).toBe(true);
    expect(isActionAllowed("replace_text", "pdf")).toBe(false);
  });

  it("planilha aceita células e fórmula; documento não", () => {
    expect(isActionAllowed("set_cells", "xlsx")).toBe(true);
    expect(isActionAllowed("set_cells", "docx")).toBe(false);
  });
});

describe("parseCommands", () => {
  it("lê um bloco office com array de operações", () => {
    const text =
      'Vou ajustar.\n```office\n[{"action":"replace_text","target":{"type":"heading"},"value":"Novo"},' +
      '{"action":"insert_text","target":{"type":"paragraph"},"value":"texto"}]\n```';
    const { commands, issues } = parseCommands(text, "docx");
    expect(commands).toHaveLength(2);
    expect(issues).toHaveLength(0);
  });

  it("aceita objeto único e reporta os inválidos sem derrubar os válidos", () => {
    const text =
      '```office\n{"action":"replace_text","target":{"type":"heading"},"value":"ok"}\n```\n' +
      '```office\n{"action":"hackear","target":{"type":"text"}}\n```';
    const { commands, issues } = parseCommands(text, "docx");
    expect(commands).toHaveLength(1);
    expect(issues).toHaveLength(1);
  });

  it("JSON malformado vira issue, não exceção", () => {
    const { commands, issues } = parseCommands("```office\n{quebrado\n```", "docx");
    expect(commands).toHaveLength(0);
    expect(issues[0]).toContain("JSON inválido");
  });

  it("texto sem bloco office não produz comando", () => {
    expect(parseCommands("só uma explicação", "docx").commands).toHaveLength(0);
  });
});

describe("previewChanges", () => {
  it("agrega por tipo com sinal (o usuário aprova antes de aplicar)", () => {
    const preview = previewChanges([
      { action: "insert_slide", target: { type: "slide" } },
      { action: "insert_slide", target: { type: "slide" } },
      { action: "replace_text", target: { type: "text" } },
      { action: "set_cells", target: { type: "range", ref: "A1:B2" } }
    ]);
    expect(preview.total).toBe(4);
    expect(preview.lines).toContain("+ 2 slide(s)");
    expect(preview.lines).toContain("~ 1 texto(s)");
  });

  it("lista vazia não quebra", () => {
    expect(previewChanges([])).toEqual({ lines: [], total: 0 });
  });
});
