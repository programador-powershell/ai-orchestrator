/**
 * Enviar sem conexão FALA, não engole.
 *
 * O transporte descarta envio com socket fechado em silêncio — decisão certa
 * lá (fila de saída reenviaria pergunta abandonada). Mas o silêncio subia até
 * a pessoa: ela apertava Enter e NADA acontecia, sem uma palavra — "não estou
 * conseguindo testar" foi exatamente isto. Quem avisa é o send do store.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { initialAppData, useApp } from "./store";

describe("enviar sem conexão", () => {
  beforeEach(() => {
    useApp.setState({ ...initialAppData(), input: "crie uma tabela de clientes" });
  });

  it("conectando: o erro diz que ainda conecta e o texto NÃO é perdido", () => {
    useApp.setState({ status: "connecting" });

    useApp.getState().send();

    const state = useApp.getState();
    expect(state.error).toContain("ainda conectando");
    // O que a pessoa digitou fica no campo — apagar o texto de um envio que
    // não aconteceu seria punir duas vezes.
    expect(state.input).toBe("crie uma tabela de clientes");
    expect(state.busy).toBe(false);
  });

  it("offline: o erro diz que não há conexão", () => {
    useApp.setState({ status: "offline" });

    useApp.getState().send();

    expect(useApp.getState().error).toContain("sem conexão com o gateway");
    expect(useApp.getState().input).toBe("crie uma tabela de clientes");
  });

  it("sem nada digitado, nada a avisar", () => {
    useApp.setState({ status: "offline", input: "   " });

    useApp.getState().send();

    expect(useApp.getState().error).toBe("");
  });
});
