/**
 * A barra DESENHADA: a conversa do bot aparece aninhada sob a que o chamou, e
 * clicar nela abre a conversa dele.
 *
 * `Rail.conversas.test.ts` já cobre a regra de agrupamento como função pura.
 * Este monta o componente porque o defeito relatado era de TELA — "não ficou o
 * bot subagente no histórico no menu lateral esquerdo abaixo do chat" —, e a
 * regra certa com a marcação errada continuaria sendo o mesmo defeito.
 *
 * Aqui não há @testing-library: a montagem é `react-dom/client` cru com o `act`
 * do React 19, como nos outros testes de tela deste projeto.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { initialAppData, useApp } from "../lib/store";
import { Rail } from "./Rail";

/*
 * O avatar carrega o módulo do Lab por URL, e jsdom não tem de onde buscá-lo.
 * O dublê registra QUEM cada linha pediu — que é justamente o que este arquivo
 * precisa observar: o retrato de cada linha é o do bot daquela linha. A
 * animação em si é assunto de `grokSpecialistAvatar.test.ts`.
 */
const montados: Array<{ specialist: string; size: number }> = [];

vi.mock("../avatar/grok_professional_avatar_v3", async (original) => {
  const real = await original<typeof import("../avatar/grok_professional_avatar_v3")>();
  return {
    ...real,
    mountGrokSpecialistAvatar: (_alvo: unknown, options: { specialist: string; size?: number }) => {
      montados.push({ specialist: options.specialist, size: options.size ?? 0 });
      return Promise.resolve({
        setSpecialist: () => {},
        setState: () => {},
        destroy: () => {}
      });
    }
  };
});

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: Root;

const conversa = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id,
  title,
  createdAt: "2026-08-19T12:00:00Z",
  updatedAt: "2026-08-19T12:00:00Z",
  lastSeq: 4,
  syncedSeq: 4,
  turns: 2,
  ...extra
});

beforeEach(() => {
  montados.length = 0;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
  useApp.setState({
    ...initialAppData(),
    railOpen: true,
    session: "s1",
    activeSpecialist: "chat",
    sessions: [
      conversa("s1", "página de vendas", { specialist: "chat" }),
      conversa("s1-code", "Código", { specialist: "code", botId: "code", parentId: "s1" }),
      conversa("s2", "modelo de dados", { specialist: "data" })
    ]
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
});

function monta() {
  act(() => {
    root.render(<Rail />);
  });
}

/** Os títulos das linhas, na ordem em que aparecem na tela. */
function linhas() {
  return [...container.querySelectorAll(".rail-item-row")].map((linha) => ({
    titulo: linha.querySelector(".rail-item-label")?.textContent ?? "",
    filha: linha.getAttribute("data-child") === "true"
  }));
}

describe("a conversa do bot na barra desenhada", () => {
  it("aparece logo abaixo da conversa que a criou, e marcada como filha", () => {
    monta();

    expect(linhas()).toEqual([
      { titulo: "página de vendas", filha: false },
      { titulo: "Código", filha: true },
      { titulo: "modelo de dados", filha: false }
    ]);
  });

  it("fica DENTRO do grupo do dono, e não solta na lista", () => {
    // É o que o recuo e o fio em "L" do CSS penduram. Sem o aninhamento na
    // marcação, o estilo cairia em todas as linhas ou em nenhuma.
    monta();

    const grupos = [...container.querySelectorAll(".rail-group")];
    expect(grupos).toHaveLength(2);
    expect(grupos[0]?.querySelectorAll(".rail-item-row")).toHaveLength(2);
    expect(grupos[1]?.querySelectorAll(".rail-item-row")).toHaveLength(1);
  });

  it("clicar nela abre a conversa DAQUELE bot", () => {
    // O pedido do dono do projeto: "eu poderia ir no chat do code e pedir pra
    // fazer um site completo" — sem passar pelo dono da conversa.
    monta();

    const filha = [...container.querySelectorAll<HTMLButtonElement>(".rail-item")].find(
      (botao) => botao.querySelector(".rail-item-label")?.textContent === "Código"
    );
    expect(filha).toBeDefined();

    act(() => {
      filha?.click();
    });

    expect(useApp.getState().session).toBe("s1-code");
  });

  it("a filha não oferece ramificar — ramo é da conversa raiz", () => {
    // Copiar a conversa de um bot para uma sessão solta criaria um bot órfão,
    // sem o pedido que o chamou.
    monta();

    const raizes = [...container.querySelectorAll('.rail-item-row:not([data-child="true"])')];
    const filhas = [...container.querySelectorAll('.rail-item-row[data-child="true"]')];

    expect(raizes.every((linha) => linha.querySelector(".rail-item-fork") !== null)).toBe(true);
    expect(filhas.every((linha) => linha.querySelector(".rail-item-fork") === null)).toBe(true);
  });

  it("cada linha mostra o retrato do SEU bot", () => {
    // É o retrato que diz DE QUEM a conversa é quando o título ainda não diz —
    // e na linha do bot ele vem do dono dela, não do especialista de quem
    // delegou.
    monta();

    expect(montados.map((avatar) => avatar.specialist)).toEqual(["chat", "code", "data"]);
  });

  it("o retrato da filha é menor, para o olho ler a hierarquia antes do texto", () => {
    monta();

    expect(montados.map((avatar) => avatar.size)).toEqual([22, 18, 22]);
  });
});

/**
 * As conversas ficam na barra em QUALQUER tela.
 *
 * O defeito era um aprisionamento: cair numa conversa de Design trocava a
 * lista inteira pelo trilho do ofício ("Camadas"), e a pessoa ficava sem como
 * abrir outra conversa — "estou preso na tela de design". A lista é a
 * navegação do app; o trilho do ofício é conteúdo daquela tela e mora abaixo.
 */
describe("a barra numa tela que não é de conversa", () => {
  it("mostra as conversas E o trilho do ofício, nesta ordem", () => {
    useApp.setState({ activeSpecialist: "design", activeSurface: "canvas" });
    monta();

    const titulos = [...container.querySelectorAll(".rail-kind")].map(
      (titulo) => titulo.textContent
    );
    expect(titulos).toEqual(["Conversas", "Camadas"]);
    // E a lista é a de verdade, com as três conversas clicáveis.
    expect(container.querySelectorAll(".rail-item-row")).toHaveLength(3);
  });

  it("na tela de conversa, a lista aparece UMA vez", () => {
    monta();

    const titulos = [...container.querySelectorAll(".rail-kind")].map(
      (titulo) => titulo.textContent
    );
    expect(titulos).toEqual(["Conversas"]);
  });

  it("tem os DOIS gestos de conversa nova: a do chat e a do ofício", () => {
    // "aparece 'novo schema' mas não tem botão 'nova conversa' para eu voltar
    // a falar com o chat" — e o "novo schema" deve PERMANECER nesta tela.
    useApp.setState({ activeSpecialist: "design", activeSurface: "canvas" });
    monta();

    const principal = container.querySelector<HTMLButtonElement>(".rail-new:not(.rail-new-bot)");
    expect(principal?.textContent).toContain("Nova conversa");

    const doOficio = container.querySelector<HTMLButtonElement>(".rail-new-bot");
    expect(doOficio).not.toBeNull();

    // O gesto do ofício abre a conversa já com o bot e FICA na tela dele.
    act(() => {
      doOficio?.click();
    });
    expect(useApp.getState().activeSpecialist).toBe("design");
    expect(useApp.getState().activeSurface).toBe("canvas");
    expect(useApp.getState().session).toBeNull();
  });

  it("na tela de conversa não há gesto do ofício — seria o mesmo botão duas vezes", () => {
    monta();

    expect(container.querySelector(".rail-new-bot")).toBeNull();
  });
});
