import { describe, expect, it, vi } from "vitest";

vi.stubGlobal("window", {});
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const { APPROVAL_POLICIES, policyLabel, requiresPrompt } = await import("./approval");

const call = (tool: string) => ({ tool, args: {} });

describe("requiresPrompt", () => {
  it("nunca pergunta para ferramentas só-leitura", () => {
    for (const policy of ["ask", "edits", "all"] as const) {
      expect(requiresPrompt(call("fs_read"), policy)).toBe(false);
      expect(requiresPrompt(call("fs_list"), policy)).toBe(false);
      expect(requiresPrompt(call("search"), policy)).toBe(false);
    }
  });

  it("'perguntar sempre' pede aval para escrita e terminal", () => {
    expect(requiresPrompt(call("fs_write"), "ask")).toBe(true);
    expect(requiresPrompt(call("terminal"), "ask")).toBe(true);
  });

  it("'aprovar edições' libera fs_write mas segura o terminal", () => {
    expect(requiresPrompt(call("fs_write"), "edits")).toBe(false);
    expect(requiresPrompt(call("terminal"), "edits")).toBe(true);
  });

  it("'aprovar tudo' não pergunta nada", () => {
    expect(requiresPrompt(call("fs_write"), "all")).toBe(false);
    expect(requiresPrompt(call("terminal"), "all")).toBe(false);
  });
});

describe("catálogo de políticas", () => {
  it("expõe as três opções com rótulo e explicação", () => {
    expect(APPROVAL_POLICIES).toHaveLength(3);
    expect(APPROVAL_POLICIES.every((item) => item.label && item.hint)).toBe(true);
  });

  it("policyLabel cai no conservador para valor inválido", () => {
    expect(policyLabel("all")).toBe("Aprovar tudo");
    expect(policyLabel("inexistente" as never)).toBe("Perguntar sempre");
  });
});
