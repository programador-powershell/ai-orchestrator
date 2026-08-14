import { describe, expect, it } from "vitest";
import type { BootstrapPolicy, EngineSelection } from "@multiplike/contracts";

import { avaliarSelecao, selecaoEfetiva, type ContextoDePolitica } from "./enginePolicy";

const politica = (patch: Partial<BootstrapPolicy> = {}): BootstrapPolicy =>
  ({ byokAllowed: true, localRuntimeAllowed: true, ...patch }) as BootstrapPolicy;

const ctx = (patch: Partial<ContextoDePolitica> = {}): ContextoDePolitica => ({
  policy: politica(),
  policyVerified: true,
  temGateway: true,
  ...patch
});

const LOCAL: EngineSelection = { kind: "local" };
const BYOK: EngineSelection = { kind: "model", target: { providerId: "openai", model: "gpt-4o" } };
const WORKSPACE: EngineSelection = { kind: "workspace" };
const FUSION: EngineSelection = { kind: "fusion", presetId: "code-pair" };

describe("avaliarSelecao", () => {
  it("workspace e fusion passam sempre — quem decide é o gateway", () => {
    const fechado = ctx({ policy: politica({ byokAllowed: false, localRuntimeAllowed: false }) });
    expect(avaliarSelecao(WORKSPACE, fechado).permitido).toBe(true);
    expect(avaliarSelecao(FUSION, fechado).permitido).toBe(true);
  });

  it("bloqueia o runtime local quando a política proíbe", () => {
    const veredito = avaliarSelecao(LOCAL, ctx({ policy: politica({ localRuntimeAllowed: false }) }));
    expect(veredito.permitido).toBe(false);
    expect(veredito.motivo).toContain("runtime local");
  });

  it("bloqueia BYOK quando a política proíbe", () => {
    const veredito = avaliarSelecao(BYOK, ctx({ policy: politica({ byokAllowed: false }) }));
    expect(veredito.permitido).toBe(false);
    expect(veredito.motivo).toContain("BYOK");
  });

  it("sem gateway configurado, libera — é instalação solta", () => {
    // Não existe admin para proibir nada, e o runtime local é o modo de
    // trabalho dessa instalação. Segurar aqui deixaria o app inútil.
    const solto = ctx({ temGateway: false, policy: null, policyVerified: false });
    expect(avaliarSelecao(LOCAL, solto).permitido).toBe(true);
    expect(avaliarSelecao(BYOK, solto).permitido).toBe(true);
  });

  it("com gateway e política ausente, SEGURA", () => {
    /*
     * Aqui está o caso que o código antigo errava: `policy?.byokAllowed !==
     * false` tratava "não sei" como "pode". Bootstrap que não respondeu, ou
     * assinatura que não conferiu, viravam permissão.
     */
    const semResposta = ctx({ policy: null, policyVerified: false });
    expect(avaliarSelecao(LOCAL, semResposta).permitido).toBe(false);
    expect(avaliarSelecao(BYOK, semResposta).permitido).toBe(false);
    expect(avaliarSelecao(BYOK, semResposta).motivo).toContain("ainda não foi carregada");
  });

  it("política presente mas NÃO verificada também segura", () => {
    // Ter o objeto em mãos não basta: sem conferir, ele pode ser qualquer
    // coisa que alguém deixou no armazenamento local.
    const naoVerificada = ctx({ policy: politica({ byokAllowed: true }), policyVerified: false });
    expect(avaliarSelecao(BYOK, naoVerificada).permitido).toBe(false);
  });

  it("política que não fala do assunto permite", () => {
    // O contrato é `!== false`: campo ausente é "sem restrição", não "proibido".
    const omissa = ctx({ policy: {} as BootstrapPolicy });
    expect(avaliarSelecao(LOCAL, omissa).permitido).toBe(true);
    expect(avaliarSelecao(BYOK, omissa).permitido).toBe(true);
  });
});

describe("selecaoEfetiva", () => {
  it("devolve a própria seleção quando ela vale", () => {
    const saida = selecaoEfetiva(BYOK, ctx());
    expect(saida.selection).toBe(BYOK);
    expect(saida.aviso).toBe("");
  });

  it("cai para workspace com o motivo, em vez de derrubar o turno", () => {
    /*
     * A seleção fica PERSISTIDA. Quem escolheu BYOK antes de o admin
     * desligá-lo continuaria usando a chave própria — o menu esconde a opção
     * e ninguém revalidava a que já estava gravada. Cair para a rota do
     * workspace corrige sem transformar "mandar uma mensagem" em erro.
     */
    const saida = selecaoEfetiva(BYOK, ctx({ policy: politica({ byokAllowed: false }) }));
    expect(saida.selection).toEqual({ kind: "workspace" });
    expect(saida.aviso).toContain("BYOK");
  });

  it("runtime local proibido também cai para workspace", () => {
    const saida = selecaoEfetiva(LOCAL, ctx({ policy: politica({ localRuntimeAllowed: false }) }));
    expect(saida.selection).toEqual({ kind: "workspace" });
    expect(saida.aviso).toContain("runtime local");
  });
});
