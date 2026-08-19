/**
 * O aviso de execução (`notice`) na redução do store.
 *
 * O contrato que se fixa aqui: o aviso entra numa FILA que só cresce — quem o
 * tira da tela é o timer do componente NoticePopup, nunca o redutor, que é
 * puro e não tem relógio. Sem o caso "notice" no switch, o envelope cairia no
 * `default` silencioso e o popup nunca apareceria: o supervisor anunciaria o
 * container para ninguém — exatamente o silêncio que o verbo existe para
 * acabar.
 */

import { describe, expect, it } from "vitest";
import type { Envelope, EnvelopeKind, Notice } from "@aibot/contracts";
import { applyEnvelope, initialAppData } from "./store";

let counter = 0;

function envelope<P>(kind: EnvelopeKind, payload: P): Envelope {
  counter += 1;
  return {
    v: 1,
    id: `env-notice-${counter}`,
    ts: "2026-08-14T12:00:00.000Z",
    seq: counter,
    session: "sessao-1",
    turn: "t-1",
    kind,
    from: { kind: "supervisor", specialist: "code" },
    payload
  };
}

const DOCKER_NOTICE: Notice = {
  icon: "docker",
  title: "Este passo vai rodar num container",
  detail: "o comando usa docker",
  specialist: "code"
};

describe("applyEnvelope: notice", () => {
  it("enfileira o aviso com ícone, motivo e especialista", () => {
    const state = applyEnvelope(initialAppData(), envelope<Notice>("notice", DOCKER_NOTICE));

    expect(state.notices).toHaveLength(1);
    expect(state.notices[0]).toMatchObject({
      icon: "docker",
      title: "Este passo vai rodar num container",
      specialist: "code"
    });
  });

  it("acumula avisos em ordem de chegada em vez de sobrescrever", () => {
    // Dois anúncios no mesmo turno (o container e depois o downgrade) são dois
    // acontecimentos: guardar só o último apagaria a prova do primeiro antes
    // de o componente ter tido a chance de mostrá-lo.
    const downgrade: Notice = {
      icon: "docker",
      title: "Sem container nesta máquina — este passo cai no ai-jail da VPS",
      specialist: "code"
    };
    let state = applyEnvelope(initialAppData(), envelope<Notice>("notice", DOCKER_NOTICE));
    state = applyEnvelope(state, envelope<Notice>("notice", downgrade));

    expect(state.notices.map((notice) => notice.title)).toEqual([
      DOCKER_NOTICE.title,
      downgrade.title
    ]);
  });

  it("ignora payload malformado em vez de enfileirar um cartão vazio", () => {
    // Sem título não há o que anunciar: um popup em branco por ~4 s seria pior
    // que nenhum. O envelope malformado morre aqui, não na renderização.
    const semTitulo = applyEnvelope(
      initialAppData(),
      envelope<{ icon: string }>("notice", { icon: "docker" })
    );
    expect(semTitulo.notices).toHaveLength(0);

    const semPayload = applyEnvelope(initialAppData(), envelope<null>("notice", null));
    expect(semPayload.notices).toHaveLength(0);
  });

  it("não mexe no resto do estado: o aviso informa, não interrompe", () => {
    // O notice NÃO é approval: `busy`, aprovação pendente e linhas ficam como
    // estavam — o turno continua correndo atrás do popup.
    const before = { ...initialAppData(), busy: true, thinking: "trabalhando" };
    const after = applyEnvelope(before, envelope<Notice>("notice", DOCKER_NOTICE));

    expect(after.busy).toBe(true);
    expect(after.thinking).toBe("trabalhando");
    expect(after.lines).toEqual(before.lines);
    expect(after.pendingApprovals).toEqual([]);
  });
});
