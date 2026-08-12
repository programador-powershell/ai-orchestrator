import { describe, expect, it } from "vitest";
import { aiChangeCount, emptyChangeLog, recordChange, revertEntry, timeline, undoLast } from "./changeLog";

const entry = (over: Partial<Parameters<typeof recordChange>[1]> = {}) => ({
  author: "ai" as const,
  label: "Alterou título",
  before: "antes",
  after: "depois",
  ...over
});

describe("recordChange", () => {
  it("registra com id e ordem automáticos", () => {
    const log = recordChange(emptyChangeLog(), entry());
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0].id).toBeTruthy();
  });

  it("não muta o estado anterior", () => {
    const original = emptyChangeLog();
    recordChange(original, entry());
    expect(original.entries).toHaveLength(0);
  });
});

describe("revertEntry", () => {
  it("reverte quando o documento ainda está no estado que a entrada produziu", () => {
    const log = recordChange(emptyChangeLog(), entry({ id: "a" }));
    const result = revertEntry(log, "a", "depois");
    expect(result.ok).toBe(true);
    expect(result.content).toBe("antes");
    expect(result.state?.entries[0].reverted).toBe(true);
  });

  it("RECUSA reverter se o documento mudou depois (não corrompe o trabalho posterior)", () => {
    const log = recordChange(emptyChangeLog(), entry({ id: "a" }));
    const result = revertEntry(log, "a", "usuário editou depois");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("mudou depois");
  });

  it("não reverte duas vezes", () => {
    const log = recordChange(emptyChangeLog(), entry({ id: "a" }));
    const first = revertEntry(log, "a", "depois");
    const second = revertEntry(first.state!, "a", "antes");
    expect(second.ok).toBe(false);
    expect(second.reason).toContain("já foi revertida");
  });

  it("id inexistente retorna motivo", () => {
    expect(revertEntry(emptyChangeLog(), "zzz", "x").ok).toBe(false);
  });
});

describe("undoLast", () => {
  it("desfaz a última alteração não revertida", () => {
    let log = recordChange(emptyChangeLog(), entry({ id: "a", before: "v0", after: "v1" }));
    log = recordChange(log, entry({ id: "b", before: "v1", after: "v2" }));
    const result = undoLast(log, "v2");
    expect(result.ok).toBe(true);
    expect(result.content).toBe("v1");
  });

  it("log vazio informa que não há o que desfazer", () => {
    expect(undoLast(emptyChangeLog(), "x").ok).toBe(false);
  });
});

describe("timeline e contagem", () => {
  it("lista mais recentes primeiro e conta só alterações vivas da IA", () => {
    let log = recordChange(emptyChangeLog(), entry({ id: "a", at: 1 }));
    log = recordChange(log, entry({ id: "b", at: 2, author: "user", label: "Editou célula D18" }));
    log = recordChange(log, entry({ id: "c", at: 3 }));
    expect(timeline(log)[0].id).toBe("c");
    expect(aiChangeCount(log)).toBe(2);
    const reverted = revertEntry(log, "c", "depois");
    expect(aiChangeCount(reverted.state!)).toBe(1);
  });
});
