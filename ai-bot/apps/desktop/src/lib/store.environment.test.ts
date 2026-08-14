/**
 * A recusa do gateway tem de chegar à PESSOA.
 *
 * O caminho inteiro é testado aqui porque o defeito morava numa emenda: o
 * `post` lia o status e jogava o corpo fora, então o `setEnvironment` só tinha
 * "409" para pôr em `state.error` — que é o texto que o composer mostra em
 * `role="alert"`. A frase acionável ("instale o Docker Desktop e o sbx…")
 * existia, viajava pela rede e morria a um passo da tela.
 *
 * O desfazer do rodapé viaja junto: o ambiente volta ao anterior, porque quem
 * executa é o gateway e ele NÃO aceitou a troca.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const GATEWAY = { url: "ws://127.0.0.1:8799/v1/stream", token: "segredo" };

// Fora do Tauri o comando não existe; aqui ele responde para o transporte
// nascer com endereço e token.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => GATEWAY)
}));

import { useApp } from "./store";

class FakeSocket {
  static readonly OPEN = 1;
  readyState = FakeSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  send(): void {}
  close(): void {}
}

const DETAIL = "o Docker Sandboxes não está instalado — instale o Docker Desktop e o sbx";

describe("setEnvironment", () => {
  beforeEach(async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    useApp.getState().connect();
    // O token é buscado de forma assíncrona; sem transporte não há POST.
    await vi.waitFor(() => expect(useApp.getState().gatewayUrl).toBe(GATEWAY.url));
    useApp.setState({ session: "s-1", environment: "local", error: "" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("mostra a frase do gateway e desfaz a escolha quando a troca é recusada", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 409,
        text: async () => JSON.stringify({ error: { code: "ambiente_indisponivel", message: DETAIL } })
      }))
    );

    useApp.getState().setEnvironment("docker");
    // Otimista: o menu fecha com a escolha aplicada.
    expect(useApp.getState().environment).toBe("docker");

    await vi.waitFor(() => expect(useApp.getState().error).not.toBe(""));

    // É ESTA frase que o composer desenha. "409" sozinho não é acionável.
    expect(useApp.getState().error).toContain("instale o Docker Desktop e o sbx");
    expect(useApp.getState().environment).toBe("local");
  });

  it("mantém a escolha quando o gateway aceita", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 204, text: async () => "" }))
    );

    useApp.getState().setEnvironment("docker");
    await vi.waitFor(() => expect(useApp.getState().environment).toBe("docker"));
    expect(useApp.getState().error).toBe("");
  });
});
