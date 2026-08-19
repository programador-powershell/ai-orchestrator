/**
 * A barra lateral enchia de conversas que ninguém começou.
 *
 * A sessão nasce no aperto de mão do WebSocket: abrir a janela, recarregar a
 * página ou reconectar já criava uma. Numa manhã de diagnóstico a barra chegou a
 * onze linhas, todas com zero turno e sem título — e a pergunta certa do dono do
 * projeto foi "por que aparecem bots em conversas se eu nem pedi nada?".
 */
import { describe, expect, it } from "vitest";
import { agruparConversas, conversasVisiveis } from "./Rail";

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

/**
 * A conversa do bot fica ABAIXO da conversa que o chamou.
 *
 * Antes, pedir um HTML na conversa do Conversa fazia o Código responder ali
 * dentro e sumir: não sobrava com quem falar. Agora ele tem conversa própria, e
 * a barra precisa mostrar de quem ela é — solta na raiz, ela vira mais uma
 * linha sem relação com nada, que foi o "ficou misturado".
 */
describe("agrupamento por dono", () => {
  const raiz = (id: string) => ({ id });
  const filha = (id: string, parentId: string) => ({ id, parentId });

  it("pendura cada bot sob a conversa que o criou", () => {
    const grupos = agruparConversas([
      raiz("s1"),
      filha("s1-code", "s1"),
      filha("s1-design", "s1"),
      raiz("s2")
    ]);

    expect(grupos.map((g) => g.dona.id)).toEqual(["s1", "s2"]);
    expect(grupos[0]?.filhas.map((f) => f.id)).toEqual(["s1-code", "s1-design"]);
    expect(grupos[1]?.filhas).toEqual([]);
  });

  it("preserva a ordem que veio do gateway, dentro e fora do grupo", () => {
    const grupos = agruparConversas([
      raiz("s2"),
      filha("s1-design", "s1"),
      raiz("s1"),
      filha("s1-code", "s1")
    ]);

    expect(grupos.map((g) => g.dona.id)).toEqual(["s2", "s1"]);
    expect(grupos[1]?.filhas.map((f) => f.id)).toEqual(["s1-design", "s1-code"]);
  });

  it("filha órfã sobe para a raiz em vez de sumir", () => {
    // O pai pode ter ficado fora do corte de recentes do `ready`, ou ter sido
    // apagado. Esconder a conversa por causa disso seria perder trabalho da
    // pessoa por um detalhe de arrumação.
    const grupos = agruparConversas([raiz("s2"), filha("s9-code", "s9")]);

    expect(grupos.map((g) => g.dona.id)).toEqual(["s2", "s9-code"]);
  });

  it("cada conversa aparece UMA vez", () => {
    const entrada = [raiz("s1"), filha("s1-code", "s1"), raiz("s2"), filha("s9-code", "s9")];

    const vistos = agruparConversas(entrada).flatMap((g) => [g.dona.id, ...g.filhas.map((f) => f.id)]);

    expect(vistos.length).toBe(entrada.length);
    expect(new Set(vistos).size).toBe(entrada.length);
  });
});
