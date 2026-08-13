import { describe, expect, it } from "vitest";

import {
  MAX_EVENTS,
  bySource,
  createTrajectory,
  eventsOf,
  exportText,
  preview,
  record,
  recordContext,
  redact,
  summarize,
  type Trajectory
} from "./trajectory";

const nova = () => createTrajectory("t1", "chat", 1_000);

const comContexto = (): Trajectory => {
  let t = nova();
  t = recordContext(t, "prompt-master", "a".repeat(300), 1_100);
  t = recordContext(t, "memory", "b".repeat(100), 1_200);
  t = recordContext(t, "memory", "c".repeat(100), 1_300);
  return t;
};

describe("redact", () => {
  it("mascara chave no formato de provedor", () => {
    expect(redact("use sk-abcdefgh12345678 aqui")).toContain("«segredo»");
    expect(redact("use sk-abcdefgh12345678 aqui")).not.toContain("abcdefgh");
  });

  it("mascara token de três partes", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27u";
    expect(redact(jwt)).toContain("«token»");
  });

  it("Bearer com ESPAÇO não deixa o token do lado do rótulo", () => {
    // O `\S+` genérico parava no espaço: mascarava a palavra "Bearer" e
    // deixava o token inteiro exposto na prévia e no export.
    const saida = redact("authorization: Bearer 3f9c8a7b21e4d5f6a7b8");
    expect(saida).not.toContain("3f9c8a7b21e4d5f6a7b8");
    expect(saida).toContain("«segredo»");
    // O esquema fica: saber COMO autentica é informação de auditoria.
    expect(saida).toContain("Bearer");
  });

  it("segredo em JSON com chave entre aspas é mascarado", () => {
    // A aspa de fechamento do nome quebrava o `[:=]` colado e nada casava.
    for (const entrada of ['"api_key": "hunter2"', '{"password":"hunter22segredo"}']) {
      const saida = redact(entrada);
      expect(saida).not.toContain("hunter2");
      expect(saida).toContain("«segredo»");
    }
  });

  it("mascara valor depois de rótulo sensível, mantendo o rótulo", () => {
    const saida = redact("Authorization: Bearer-abcdefghij");
    expect(saida).toContain("Authorization");
    expect(saida).toContain("«segredo»");
    expect(saida).not.toContain("abcdefghij");
  });

  it("não estraga texto comum", () => {
    expect(redact("o deploy roda na sexta")).toBe("o deploy roda na sexta");
  });
});

describe("preview", () => {
  it("achata espaço e corta no limite", () => {
    const saida = preview(`linha1\n\n   linha2 ${"x".repeat(400)}`);
    expect(saida).toContain("linha1 linha2");
    expect(saida.endsWith("…")).toBe(true);
    expect(saida.length).toBeLessThanOrEqual(161);
  });

  it("texto curto sai inteiro, sem reticência", () => {
    expect(preview("curto")).toBe("curto");
  });

  it("redige antes de recortar — o segredo não escapa pela prévia", () => {
    expect(preview("chave sk-abcdefgh12345678")).not.toContain("abcdefgh");
  });
});

describe("record", () => {
  it("é append-only: devolve trilha nova e não mexe na anterior", () => {
    const antes = nova();
    const depois = record(antes, { kind: "note", at: 1_100, text: "oi" });
    expect(antes.events).toHaveLength(0);
    expect(depois.events).toHaveLength(1);
  });

  it("preserva o começo e descarta o meio no estouro", () => {
    let t = nova();
    for (let i = 0; i < MAX_EVENTS + 40; i += 1) {
      t = record(t, { kind: "note", at: 1_000 + i, text: `n${i}` });
    }
    expect(t.events).toHaveLength(MAX_EVENTS);
    expect(t.dropped).toBe(40);
    // O primeiro evento continua lá — é onde ficam as injeções de contexto.
    expect((t.events[0] as { text: string }).text).toBe("n0");
    // E o último também.
    expect((t.events.at(-1) as { text: string }).text).toBe(`n${MAX_EVENTS + 39}`);
  });

  it("no teto exato não descarta nada", () => {
    let t = nova();
    for (let i = 0; i < MAX_EVENTS; i += 1) t = record(t, { kind: "note", at: 1_000, text: `n${i}` });
    expect(t.dropped).toBe(0);
    expect(t.events).toHaveLength(MAX_EVENTS);
  });
});

describe("recordContext", () => {
  it("guarda tamanho real e prévia recortada, não o texto inteiro", () => {
    const t = recordContext(nova(), "memory", "x".repeat(1_000), 1_100);
    const evento = t.events[0] as { chars: number; preview: string };
    expect(evento.chars).toBe(1_000);
    expect(evento.preview.length).toBeLessThan(200);
  });
});

describe("bySource", () => {
  it("soma por fonte e ordena pelo maior", () => {
    const resultado = bySource(comContexto());
    expect(resultado[0].source).toBe("prompt-master");
    expect(resultado[0].chars).toBe(300);
    expect(resultado[1].source).toBe("memory");
    expect(resultado[1].chars).toBe(200);
    expect(resultado[1].count).toBe(2);
  });

  it("a fração soma 1", () => {
    const total = bySource(comContexto()).reduce((soma, item) => soma + item.share, 0);
    expect(total).toBeCloseTo(1, 5);
  });

  it("trilha sem contexto devolve lista vazia, não divide por zero", () => {
    const t = record(nova(), { kind: "note", at: 1_100, text: "oi" });
    expect(bySource(t)).toEqual([]);
  });
});

describe("summarize", () => {
  it("conta ferramenta, falha e agente distinto", () => {
    let t = comContexto();
    t = record(t, { kind: "tool", at: 1_400, name: "fs_read", ok: true, ms: 12, detail: "a.ts" });
    t = record(t, { kind: "tool", at: 1_500, name: "fs_write", ok: false, ms: 4, detail: "negado" });
    t = record(t, { kind: "agent", at: 1_600, id: "a1", role: "code", model: "kimi 3", status: "done" });
    t = record(t, { kind: "agent", at: 1_700, id: "a1", role: "code", model: "kimi 3", status: "done" });

    const resumo = summarize(t, 3_000);
    expect(resumo.contextChars).toBe(500);
    expect(resumo.tools).toBe(2);
    expect(resumo.toolsFailed).toBe(1);
    // O mesmo agente aparecendo duas vezes conta uma.
    expect(resumo.agents).toBe(1);
    expect(resumo.durationMs).toBe(2_000);
  });

  it("relógio para trás não vira duração negativa", () => {
    expect(summarize(nova(), 0).durationMs).toBe(0);
  });
});

describe("eventsOf", () => {
  it("filtra pela fonte pedida", () => {
    expect(eventsOf(comContexto(), "memory")).toHaveLength(2);
    expect(eventsOf(comContexto(), "mentions")).toEqual([]);
  });
});

describe("exportText", () => {
  it("traz resumo, participação por fonte e a linha do tempo", () => {
    let t = comContexto();
    t = record(t, { kind: "tool", at: 1_400, name: "fs_read", ok: false, ms: 9, detail: "sem permissão" });
    const texto = exportText(t, 3_000);
    expect(texto).toContain("Prompt master (admin)");
    expect(texto).toContain("60%");
    expect(texto).toContain("[ferramenta] fs_read FALHOU");
    expect(texto).toContain("+0.4s");
  });

  it("declara o corte quando houve descarte", () => {
    let t = nova();
    for (let i = 0; i < MAX_EVENTS + 3; i += 1) t = record(t, { kind: "note", at: 1_000, text: "n" });
    expect(exportText(t, 2_000)).toContain("descartado");
  });

  it("não vaza segredo pelo export", () => {
    const t = recordContext(nova(), "memory", "chave sk-abcdefgh12345678", 1_100);
    expect(exportText(t, 2_000)).not.toContain("abcdefgh");
  });
});
