import { describe, expect, it } from "vitest";
import { diagnosticCommand, formatDiagnostics } from "./diagnostics";

describe("diagnosticCommand", () => {
  it("mapeia TypeScript para o type-check do projeto", () => {
    expect(diagnosticCommand("apps/desktop/src/lib/foo.ts")).toContain("check");
    expect(diagnosticCommand("x.tsx")).toBe(diagnosticCommand("y.ts"));
  });

  it("mapeia Rust, Python e JS para seus checks", () => {
    expect(diagnosticCommand("services/gateway/src/main.rs")).toContain("cargo");
    expect(diagnosticCommand("scripts/x.py")).toContain("py_compile");
    expect(diagnosticCommand("a.mjs")).toContain("node --check");
  });

  it("retorna null para extensões sem diagnóstico", () => {
    expect(diagnosticCommand("README.md")).toBeNull();
    expect(diagnosticCommand("data.json")).toBeNull();
    expect(diagnosticCommand("noext")).toBeNull();
  });
});

describe("formatDiagnostics", () => {
  it("relata sucesso sem erros", () => {
    expect(formatDiagnostics("a.ts", { ok: true, output: "" })).toContain("sem erros");
  });

  it("relata falha com a saída do check", () => {
    const out = formatDiagnostics("a.ts", { ok: false, output: "TS2322: type error" });
    expect(out).toContain("TS2322");
    expect(out.toLowerCase()).toContain("diagnóstic");
  });
});
