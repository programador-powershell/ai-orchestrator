/**
 * O botão "ramificar" da barra lateral, de ponta a ponta no store.
 *
 * O contrato tem duas metades e as duas precisam de teste: quando o gateway
 * cria o fork, a tela ABRE a sessão nova (é o corpo do 201 que carrega o id —
 * jogá-lo fora obrigaria uma segunda chamada); quando o gateway recusa, a
 * frase acionável chega a `state.error` e a pessoa continua na conversa em que
 * estava — trocar de sessão sem fork criado seria abrir uma conversa que não
 * existe.
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

describe("forkSession", () => {
  beforeEach(async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    useApp.getState().connect();
    await vi.waitFor(() => expect(useApp.getState().gatewayUrl).toBe(GATEWAY.url));
    useApp.setState({ session: "s-original", error: "" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("chama a rota de fork e abre a sessão que o gateway devolveu", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 201,
      text: async () =>
        JSON.stringify({ id: "s-original-fork-1", title: "fork: cobrança", lastSeq: 12 })
    }));
    vi.stubGlobal("fetch", fetchMock);

    useApp.getState().forkSession("s-original");

    await vi.waitFor(() => expect(useApp.getState().session).toBe("s-original-fork-1"));

    // A rota certa, com o id escapado — é o contrato do gateway.
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toContain("/v1/sessions/s-original/fork");
    expect(useApp.getState().error).toBe("");
  });

  it("mostra a frase do gateway e fica na conversa atual quando o fork é recusado", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 404,
        text: async () => JSON.stringify({ error: { code: "not_found", message: "sessão não encontrada" } })
      }))
    );

    useApp.getState().forkSession("s-que-sumiu");

    await vi.waitFor(() => expect(useApp.getState().error).not.toBe(""));
    expect(useApp.getState().error).toContain("sessão não encontrada");
    // Sem fork criado, a pessoa continua onde estava.
    expect(useApp.getState().session).toBe("s-original");
  });
});
