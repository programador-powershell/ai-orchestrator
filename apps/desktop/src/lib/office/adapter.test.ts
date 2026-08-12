import { describe, expect, it } from "vitest";
import { TextAdapter, formatFromPath } from "./adapter";

describe("formatFromPath", () => {
  it("deduz o formato pela extensão", () => {
    expect(formatFromPath("proposta.docx")).toBe("docx");
    expect(formatFromPath("orçamento_2026.xlsx")).toBe("xlsx");
    expect(formatFromPath("pitch.pptx")).toBe("pptx");
    expect(formatFromPath("relatorio.pdf")).toBe("pdf");
    expect(formatFromPath("pagina.html")).toBe("html");
    expect(formatFromPath("notas.md")).toBe("markdown");
  });

  it("desconhecido vira texto", () => {
    expect(formatFromPath("arquivo.xyz")).toBe("text");
    expect(formatFromPath("semextensao")).toBe("text");
  });
});

describe("TextAdapter", () => {
  const doc = "# Proposta Comercial\n\nTexto do corpo.\n\n## Escopo\n\nItem A";

  it("expõe a estrutura para a IA escolher alvos", () => {
    const structure = new TextAdapter("markdown", doc).getStructure();
    const headings = structure.nodes.filter((node) => node.type === "heading");
    expect(headings.map((node) => node.text)).toEqual(["Proposta Comercial", "Escopo"]);
  });

  it('"troque o título" sem alvo explícito troca o primeiro heading', () => {
    const adapter = new TextAdapter("markdown", doc);
    const result = adapter.apply({
      action: "replace_text",
      target: { type: "heading" },
      value: "Proposta Comercial 2026"
    });
    expect(result.ok).toBe(true);
    expect(adapter.read()).toContain("# Proposta Comercial 2026");
    expect(adapter.read()).toContain("## Escopo");
  });

  it("substitui texto alvo e conta as ocorrências", () => {
    const adapter = new TextAdapter("text", "azul e azul de novo");
    const result = adapter.apply({ action: "replace_text", target: { type: "text", ref: "azul" }, value: "verde" });
    expect(result.touched).toBe(2);
    expect(adapter.read()).toBe("verde e verde de novo");
  });

  it("informa quando o alvo não existe (não altera nada em silêncio)", () => {
    const adapter = new TextAdapter("text", "conteúdo");
    const result = adapter.apply({ action: "replace_text", target: { type: "text", ref: "inexistente" }, value: "x" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("não encontrado");
    expect(adapter.read()).toBe("conteúdo");
  });

  it("usa a SELEÇÃO como alvo quando o comando não traz ref", () => {
    const adapter = new TextAdapter("text", "linha um\nlinha dois");
    adapter.setSelection({ text: "linha dois" });
    const result = adapter.apply({ action: "delete", target: { type: "selection" } });
    expect(result.ok).toBe(true);
    expect(adapter.read().trim()).toBe("linha um");
  });

  it("insere texto ao final", () => {
    const adapter = new TextAdapter("markdown", "# Título");
    adapter.apply({ action: "insert_text", target: { type: "paragraph" }, value: "novo parágrafo" });
    expect(adapter.read()).toBe("# Título\nnovo parágrafo");
  });

  it("recusa ação que o adapter de texto não implementa", () => {
    const adapter = new TextAdapter("text", "x");
    const result = adapter.apply({ action: "insert_slide", target: { type: "slide" } });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("não suportada");
  });
});
