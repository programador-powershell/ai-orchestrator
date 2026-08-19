/**
 * A barra lateral enchia de conversas que ninguém começou.
 *
 * A sessão nasce no aperto de mão do WebSocket: abrir a janela, recarregar a
 * página ou reconectar já criava uma. Numa manhã de diagnóstico a barra chegou a
 * onze linhas, todas com zero turno e sem título — e a pergunta certa do dono do
 * projeto foi "por que aparecem bots em conversas se eu nem pedi nada?".
 */
import { describe, expect, it } from "vitest";
import { conversasVisiveis } from "./Rail";

const sessao = (id: string, turns: number) => ({ id, turns });

describe("conversas visíveis na barra", () => {
  it("esconde as que não têm nenhum turno", () => {
    const todas = [sessao("a", 3), sessao("b", 0), sessao("c", 0), sessao("d", 12)];

    expect(conversasVisiveis(todas, null).map((s) => s.id)).toEqual(["a", "d"]);
  });

  it("mantém a ATIVA visível mesmo vazia", () => {
    // É para onde o próximo texto vai; sumir com ela faria a pessoa achar que
    // perdeu o lugar.
    const todas = [sessao("a", 3), sessao("nova", 0)];

    expect(conversasVisiveis(todas, "nova").map((s) => s.id)).toEqual(["a", "nova"]);
  });

  it("com tudo vazio e nada ativo, a lista fica vazia — e a tela mostra o vazio honesto", () => {
    const todas = [sessao("a", 0), sessao("b", 0), sessao("c", 0)];

    expect(conversasVisiveis(todas, null)).toEqual([]);
  });

  it("não inventa: a ordem que veio do gateway é preservada", () => {
    const todas = [sessao("z", 1), sessao("m", 0), sessao("a", 2)];

    expect(conversasVisiveis(todas, null).map((s) => s.id)).toEqual(["z", "a"]);
  });
});

/**
 * O sinal de "esta conversa tem conteúdo" não pode ser um contador de cache.
 *
 * `turns` mora no cabeçalho da sessão e é gravado com atraso; quando o gateway
 * morre antes da descarga, ele volta ZERADO — enquanto o log, que é a fonte,
 * continua inteiro. `lastSeq` é reconstruído lendo o fim do log na reabertura, e
 * por isso é ele que responde. Filtrar por `turns` fazia a conversa anterior
 * sumir da barra ao clicar em "nova conversa".
 */
describe("conversa com contador zerado", () => {
  it("continua visível quando o log tem seq", () => {
    const todas = [
      { id: "a", turns: 0, lastSeq: 42, title: "qual a capital da frança?" },
      { id: "vazia", turns: 0, lastSeq: 0, title: "" }
    ];

    expect(conversasVisiveis(todas, null).map((s) => s.id)).toEqual(["a"]);
  });

  it("continua visível quando tem título, mesmo sem contador nem seq", () => {
    const todas = [
      { id: "titulada", turns: 0, lastSeq: 0, title: "conversa antiga" },
      { id: "crua", turns: 0, lastSeq: 0, title: "" }
    ];

    expect(conversasVisiveis(todas, null).map((s) => s.id)).toEqual(["titulada"]);
  });
});
