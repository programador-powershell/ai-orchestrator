/**
 * O fio da tela com as rotas /v1/tools/call e /v1/model/complete.
 *
 * O que os casos fixam: recusa NUNCA vira exceção (whitelist, portão, pessoa,
 * transporte — tudo volta como {ok:false, error} para a tela mostrar), offline
 * responde na hora com a frase honesta, e `args` ausente fica FORA do corpo.
 * O transporte é dublado via activeTransport — o padrão da casa.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Transport } from "../transport";
import { initialAppData, useApp } from "../store";
import { chamarFerramenta, completarTrecho, SEM_CONEXAO } from "./ferramentas";

let transporteFalso: Transport | null = null;

vi.mock("../store", async (original) => {
  const real = await original<typeof import("../store")>();
  return { ...real, activeTransport: (): Transport | null => transporteFalso };
});

interface Chamada {
  path: string;
  body: unknown;
}

const chamadas: Chamada[] = [];

function transporteQueResponde(resposta: unknown | (() => Promise<unknown>)): Transport {
  return {
    post: async (path: string, body: unknown) => {
      chamadas.push({ path, body });
      return typeof resposta === "function" ? (resposta as () => Promise<unknown>)() : resposta;
    }
  } as unknown as Transport;
}

beforeEach(() => {
  chamadas.length = 0;
  transporteFalso = null;
  useApp.setState({ ...initialAppData(), session: "s-1" });
});

describe("chamarFerramenta", () => {
  it("offline responde na hora com a frase honesta, sem tentar POST", async () => {
    transporteFalso = null;
    expect(await chamarFerramenta("fs.list", { path: "" })).toEqual({ ok: false, error: SEM_CONEXAO });
    expect(chamadas).toHaveLength(0);
  });

  it("sem sessão é o mesmo caso de offline — não há a quem pedir", async () => {
    transporteFalso = transporteQueResponde({ ok: true, output: "" });
    useApp.setState({ session: null });
    expect(await chamarFerramenta("fs.list", { path: "" })).toEqual({ ok: false, error: SEM_CONEXAO });
    expect(chamadas).toHaveLength(0);
  });

  it("sucesso: manda {session, tool, args} para /v1/tools/call e devolve o output", async () => {
    transporteFalso = transporteQueResponde({ ok: true, output: "package main" });
    const resultado = await chamarFerramenta("fs.read", { path: "src/main.go" });
    expect(resultado).toEqual({ ok: true, output: "package main" });
    expect(chamadas[0]?.path).toBe("/v1/tools/call");
    expect(chamadas[0]?.body).toEqual({ session: "s-1", tool: "fs.read", args: { path: "src/main.go" } });
  });

  it("ferramenta sem parâmetro NÃO manda o campo args — o contrato da rota", async () => {
    transporteFalso = transporteQueResponde({ ok: true, output: "limpo" });
    await chamarFerramenta("git.status");
    expect("args" in (chamadas[0]?.body as Record<string, unknown>)).toBe(false);
  });

  it("recusa de mérito (200 com ok:false) volta com o motivo que a tela mostra", async () => {
    transporteFalso = transporteQueResponde({ ok: false, error: "a pessoa recusou a escrita" });
    expect(await chamarFerramenta("fs.write", { path: "a", content: "b" })).toEqual({
      ok: false,
      error: "a pessoa recusou a escrita"
    });
  });

  it("recusa sem motivo ganha um motivo — a tela nunca mostra vazio", async () => {
    transporteFalso = transporteQueResponde({ ok: false });
    const resultado = await chamarFerramenta("fs.write", { path: "a", content: "b" });
    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.error).toContain("sem informar o motivo");
  });

  it("erro de transporte (404, 500, rede) vira {ok:false} com a frase do gateway", async () => {
    transporteFalso = transporteQueResponde(() => Promise.reject(new Error("sessão inexistente (404)")));
    expect(await chamarFerramenta("fs.list", { path: "" })).toEqual({
      ok: false,
      error: "sessão inexistente (404)"
    });
  });

  it("corpo fora do contrato não vira sucesso silencioso", async () => {
    transporteFalso = transporteQueResponde({ qualquer: "coisa" });
    const resultado = await chamarFerramenta("fs.list", { path: "" });
    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.error).toContain("contrato");
  });
});

describe("completarTrecho", () => {
  it("sucesso: manda {session, prompt, maxTokens} e devolve o texto", async () => {
    transporteFalso = transporteQueResponde({ text: "int {\n\treturn a + b\n}" });
    const resultado = await completarTrecho("Linguagem: go\n\n```\nfunc soma(a, b int) <CURSOR>\n```", 256);
    expect(resultado).toEqual({ ok: true, text: "int {\n\treturn a + b\n}" });
    expect(chamadas[0]?.path).toBe("/v1/model/complete");
    expect(chamadas[0]?.body).toEqual({
      session: "s-1",
      prompt: "Linguagem: go\n\n```\nfunc soma(a, b int) <CURSOR>\n```",
      maxTokens: 256
    });
  });

  it("maxTokens ausente fica fora do corpo — o teto duro é do gateway", async () => {
    transporteFalso = transporteQueResponde({ text: "x" });
    await completarTrecho("p");
    expect("maxTokens" in (chamadas[0]?.body as Record<string, unknown>)).toBe(false);
  });

  it("503 sem_modelo (e qualquer falha) vira {ok:false} — sem sugestão, com motivo", async () => {
    transporteFalso = transporteQueResponde(() =>
      Promise.reject(new Error("catálogo sem modelo utilizável (503)"))
    );
    expect(await completarTrecho("p")).toEqual({
      ok: false,
      error: "catálogo sem modelo utilizável (503)"
    });
  });

  it("offline responde na hora, sem POST", async () => {
    transporteFalso = null;
    expect(await completarTrecho("p")).toEqual({ ok: false, error: SEM_CONEXAO });
    expect(chamadas).toHaveLength(0);
  });
});
