/**
 * O gesto da jaula na redução do store.
 *
 * O contrato que se fixa aqui: o KindNotice "no sandbox: …" NÃO entra na fila
 * do popup — ele vira chip pendurado na linha do turno (a mesma âncora dos
 * tool.call). O turno de trabalho executa dezenas de gestos liberados na
 * jaula; dezenas de cartões animados ensinariam a ignorá-los, e o chip
 * discreto é o rastro visível que o modelo com sandbox prometeu ("executado
 * no sandbox", sem pedir permissão um a um). O aviso de container de sempre
 * continua indo para o popup — são frases diferentes para gestos diferentes.
 */

import { describe, expect, it } from "vitest";
import type { Envelope, EnvelopeKind, Notice, Route } from "@aibot/contracts";
import { applyEnvelope, initialAppData, type AppData } from "./store";

let counter = 0;

function envelope<P>(kind: EnvelopeKind, payload: P, turn: string | undefined = "t-1"): Envelope {
  counter += 1;
  return {
    v: 1,
    id: `env-sbx-${counter}`,
    ts: "2026-08-20T12:00:00.000Z",
    seq: counter,
    session: "sessao-1",
    turn,
    kind,
    from: { kind: "supervisor", specialist: "code" },
    payload
  };
}

/** Abre a linha do turno pela rota, como no fluxo real. */
function comLinhaAberta(): AppData {
  const route: Route = {
    specialist: "code",
    reason: "model",
    confidence: 0.9,
    surface: "editor",
    model: "m-1"
  };
  return applyEnvelope(initialAppData(), envelope<Route>("route", route));
}

const GESTO: Notice = {
  icon: "sandbox",
  title: "no sandbox: pnpm install",
  detail: "instalação isolada na cópia do turno",
  specialist: "code"
};

describe("applyEnvelope: o notice da jaula vira chip", () => {
  it("pendura o chip na linha do turno e NÃO abre popup", () => {
    const aberto = comLinhaAberta();
    const state = applyEnvelope(aberto, envelope<Notice>("notice", GESTO));

    expect(state.notices).toHaveLength(0);
    expect(state.chipsDeSandbox).toEqual([
      {
        lineId: aberto.lines[0]?.id,
        title: "no sandbox: pnpm install",
        detail: "instalação isolada na cópia do turno"
      }
    ]);
  });

  it("reconhece o gesto pelo TÍTULO, nunca pelo ícone", () => {
    // O ícone não serve de porta: o gateway usa o MESMO "sandbox" na
    // degradação, que precisa continuar popup (teste abaixo). O título
    // continua valendo com outra capitalização e outro ícone.
    const soTitulo: Notice = { icon: "docker", title: "No sandbox: gravou src/App.tsx" };
    const state = applyEnvelope(comLinhaAberta(), envelope<Notice>("notice", soTitulo));

    expect(state.notices).toHaveLength(0);
    expect(state.chipsDeSandbox.map((chip) => chip.title)).toEqual([
      "No sandbox: gravou src/App.tsx"
    ]);
  });

  it("o aviso real viaja SEM turno e ainda ancora na última bolha", () => {
    // avisoDeJaula (jaula.go) publica o notice efêmero sem `turn`. A âncora
    // então é a última linha de assistente — durante o turno vivo, que é
    // quando o aviso chega, essa bolha é a do gesto.
    const aberto = comLinhaAberta();
    const state = applyEnvelope(aberto, envelope<Notice>("notice", GESTO, undefined));

    expect(state.chipsDeSandbox).toHaveLength(1);
    expect(state.chipsDeSandbox[0]?.lineId).toBe(aberto.lines[0]?.id);
  });

  it("a DEGRADAÇÃO ('sem sandbox: …') continua popup — ela muda o modelo de aprovação", () => {
    // Mesmo ícone "sandbox", intenção oposta: rebaixá-la a chip discreto
    // esconderia o aviso de que cada gesto voltou a pedir permissão.
    const degradacao: Notice = {
      icon: "sandbox",
      title: "sem sandbox: este turno trabalha direto no projeto",
      detail: "cada gravação e execução volta a pedir aprovação individual."
    };
    const state = applyEnvelope(comLinhaAberta(), envelope<Notice>("notice", degradacao));

    expect(state.chipsDeSandbox).toHaveLength(0);
    expect(state.notices.map((notice) => notice.title)).toEqual([
      "sem sandbox: este turno trabalha direto no projeto"
    ]);
  });

  it("acumula os gestos do turno em ordem — cada um é um acontecimento", () => {
    let state = comLinhaAberta();
    state = applyEnvelope(state, envelope<Notice>("notice", GESTO));
    state = applyEnvelope(
      state,
      envelope<Notice>("notice", { icon: "sandbox", title: "no sandbox: pnpm build" })
    );

    expect(state.chipsDeSandbox.map((chip) => chip.title)).toEqual([
      "no sandbox: pnpm install",
      "no sandbox: pnpm build"
    ]);
  });

  it("gesto antes de existir linha não some: entra sem âncora", () => {
    // O chip é a prova visível do isolamento; perdê-lo por falta de linha
    // seria esconder exatamente o que ele existe para mostrar.
    const state = applyEnvelope(initialAppData(), envelope<Notice>("notice", GESTO));

    expect(state.chipsDeSandbox).toHaveLength(1);
    expect(state.chipsDeSandbox[0]?.lineId).toBe("");
  });

  it("o aviso de container de sempre continua indo para o popup", () => {
    const containerNotice: Notice = {
      icon: "docker",
      title: "Este passo vai rodar num container",
      detail: "o comando usa docker",
      specialist: "code"
    };
    const state = applyEnvelope(comLinhaAberta(), envelope<Notice>("notice", containerNotice));

    expect(state.notices).toHaveLength(1);
    expect(state.chipsDeSandbox).toHaveLength(0);
  });

  it("não interrompe nada: busy, aprovações e linhas ficam como estavam", () => {
    const before = { ...comLinhaAberta(), busy: true, thinking: "trabalhando" };
    const after = applyEnvelope(before, envelope<Notice>("notice", GESTO));

    expect(after.busy).toBe(true);
    expect(after.thinking).toBe("trabalhando");
    expect(after.lines).toEqual(before.lines);
    expect(after.pendingApprovals).toEqual([]);
  });
});
