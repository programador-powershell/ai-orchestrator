import { describe, expect, it, vi } from "vitest";
import { opsBus, opsInstruction, parseOps } from "./ops";

const block = (channel: string, body: string) => "```ops:" + channel + "\n" + body + "\n```";

describe("parseOps", () => {
  it("extrai operações de um bloco válido do canal", () => {
    const text =
      "Vou criar a tabela.\n" +
      block("data", '[{"op": "add_table", "name": "users"}, {"op": "add_field", "table": "users", "name": "id"}]');
    const ops = parseOps(text, "data");
    expect(ops).toHaveLength(2);
    expect(ops[0]).toEqual({ op: "add_table", name: "users" });
    expect(ops[1].op).toBe("add_field");
  });

  it("ignora blocos de canal diferente", () => {
    const text = block("code", '[{"op": "open_file", "path": "a.ts"}]');
    expect(parseOps(text, "data")).toEqual([]);
  });

  it("ignora bloco com JSON malformado sem lançar", () => {
    const text = block("data", '[{"op": "add_table", "name": ]');
    expect(parseOps(text, "data")).toEqual([]);
  });

  it("ignora JSON válido que não é array", () => {
    const text = block("data", '{"op": "add_table"}');
    expect(parseOps(text, "data")).toEqual([]);
  });

  it("filtra entradas sem campo op string", () => {
    const text = block("data", '[{"op": "ok"}, {"name": "sem-op"}, {"op": 42}, null, "texto"]');
    const ops = parseOps(text, "data");
    expect(ops).toEqual([{ op: "ok" }]);
  });

  it("concatena múltiplos blocos do mesmo canal na ordem", () => {
    const text =
      block("data", '[{"op": "primeiro"}]') +
      "\ntexto no meio\n" +
      block("data", '[{"op": "segundo"}, {"op": "terceiro"}]');
    const ops = parseOps(text, "data");
    expect(ops.map((entry) => entry.op)).toEqual(["primeiro", "segundo", "terceiro"]);
  });

  it("retorna vazio quando não há bloco ops", () => {
    expect(parseOps("resposta comum sem operações", "data")).toEqual([]);
  });
});

describe("opsInstruction", () => {
  it("inclui o canal e cada operação do catálogo com descrição", () => {
    const instruction = opsInstruction("data", {
      add_table: "cria uma tabela no diagrama",
      drop_table: "remove uma tabela existente"
    });
    expect(instruction).toContain('superfície "data"');
    expect(instruction).toContain("```ops:data```");
    expect(instruction).toContain('- {"op": "add_table", …}: cria uma tabela no diagrama');
    expect(instruction).toContain('- {"op": "drop_table", …}: remove uma tabela existente');
  });
});

describe("opsBus", () => {
  it("publica ops parseadas para os assinantes do canal e respeita unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = opsBus.subscribe("data", listener);
    opsBus.publish("data", block("data", '[{"op": "add_table", "name": "users"}]'));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith([{ op: "add_table", name: "users" }]);

    opsBus.publish("data", "sem bloco: não deve publicar");
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    opsBus.publish("data", block("data", '[{"op": "outra"}]'));
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
