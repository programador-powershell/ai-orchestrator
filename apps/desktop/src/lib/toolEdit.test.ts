import { describe, expect, it } from "vitest";
import { buildToolEdit, editLabel, formatPatch } from "./toolEdit";

describe("buildToolEdit", () => {
  it("conta linhas somadas na criação de arquivo", () => {
    const edit = buildToolEdit("novo.ts", null, "linha 1\nlinha 2\nlinha 3");
    expect(edit.created).toBe(true);
    expect(edit.added).toBe(3);
    expect(edit.removed).toBe(0);
  });

  it("conta somadas e removidas numa edição", () => {
    const edit = buildToolEdit("a.ts", "um\ndois\ntres", "um\nDOIS\ntres\nquatro");
    expect(edit.created).toBe(false);
    expect(edit.added).toBe(2);
    expect(edit.removed).toBe(1);
  });

  it("edição sem mudança real fica zerada", () => {
    const edit = buildToolEdit("a.ts", "igual", "igual");
    expect(edit.added).toBe(0);
    expect(edit.removed).toBe(0);
  });
});

describe("formatPatch", () => {
  it("prefixa + e - nas linhas alteradas", () => {
    const patch = formatPatch("um\ndois", "um\ntres");
    expect(patch).toContain("-dois");
    expect(patch).toContain("+tres");
    expect(patch).toContain(" um");
  });
});

describe("editLabel", () => {
  it("usa Criado quando o arquivo é novo", () => {
    expect(editLabel({ path: "x.ts", added: 44, removed: 0, patch: "", created: true })).toBe("Criado x.ts +44 −0");
  });

  it("usa Editado quando o arquivo já existia", () => {
    expect(editLabel({ path: "y.ts", added: 3, removed: 1, patch: "", created: false })).toBe("Editado y.ts +3 −1");
  });
});
