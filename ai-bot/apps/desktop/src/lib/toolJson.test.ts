/**
 * O extrator do bloco JSON estruturado — o meio-fio entre o gateway e as telas
 * anti-casca. Cada caso aqui é um jeito real de o resultado chegar: JSON puro
 * (schema.export), texto + cerca (as quatro da onda), cerca no meio do texto
 * legível (exemplo citado pelo modelo) e resultado picotado pelo teto.
 */
import { describe, expect, it } from "vitest";
import { structuredJson } from "./toolJson";

describe("structuredJson", () => {
  it("aceita a saída que é JSON puro (padrão schema.export)", () => {
    expect(structuredJson('{"tables": []}')).toEqual({ tables: [] });
    expect(structuredJson("  [1, 2]  ")).toEqual([1, 2]);
  });

  it("extrai o bloco demarcado depois do texto legível", () => {
    const output = 'fluxo "x" — 2 nó(s) — VÁLIDO\n\n```json\n{"ok": true, "nodes": []}\n```';
    expect(structuredJson(output)).toEqual({ ok: true, nodes: [] });
  });

  it("usa a ÚLTIMA cerca — a do gateway, não a do exemplo no texto", () => {
    const output = [
      "veja um exemplo de fluxo:",
      "```json",
      '{"ok": false, "exemplo": true}',
      "```",
      "e o resultado de verdade:",
      "```json",
      '{"ok": true}',
      "```"
    ].join("\n");
    expect(structuredJson(output)).toEqual({ ok: true });
  });

  it("devolve null para texto sem bloco — a tela fica no vazio digno", () => {
    expect(structuredJson("nenhum segredo aparente em 12 arquivos")).toBeNull();
    expect(structuredJson("")).toBeNull();
  });

  it("devolve null para bloco picotado pelo teto de saída", () => {
    // Sem a cerca de fechamento (truncado), o corpo não parseia — null, nunca
    // um objeto pela metade.
    expect(structuredJson('relatório…\n\n```json\n{"ok": true, "nodes": [')).toBeNull();
  });

  it("não confunde JSON quebrado no começo com ausência de bloco", () => {
    const output = '{texto que parece json mas não é}\n\n```json\n{"ok": true}\n```';
    expect(structuredJson(output)).toEqual({ ok: true });
  });
});
