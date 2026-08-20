/**
 * O ANCORAMENTO do composer, fixado em teste.
 *
 * O defeito era de tela: o composer flutuava sobre o palco (position:absolute)
 * e, nas superfícies de trabalho, COBRIA o rodapé de quem trabalha — na IDE a
 * saída, os chips e a statusbar do editor sumiam atrás do campo. O conserto
 * portou o padrão do AI-Orchestrator: o composer é IRMÃO da superfície no
 * fluxo da coluna do palco (main.app-stage), um dock de rodapé — o mesmo
 * desenho do TerminalDock.
 *
 * CSS não se testa em jsdom (a folha nem é aplicada): o que este arquivo fixa
 * é a ESTRUTURA — classes e ordem no DOM — da qual o CSS novo depende. Se o
 * composer voltar a ser filho direto do shell (a âncora da versão flutuante),
 * ou sair da coluna do palco, estes testes quebram ANTES de alguém precisar
 * abrir a tela para ver a saída da IDE coberta de novo.
 *
 * Sem @testing-library, como nos vizinhos: react-dom/client cru + act.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { initialAppData, useApp } from "./lib/store";
import { zerarIde } from "./lib/ide/ideStore";
import App from "./App";

/*
 * O avatar carrega o módulo do Lab por URL, e jsdom não tem de onde buscá-lo.
 * O dublê devolve um controlador inerte — a animação em si tem teste próprio.
 */
vi.mock("./avatar/grok_professional_avatar_v3", async (original) => {
  const real = await original<typeof import("./avatar/grok_professional_avatar_v3")>();
  return {
    ...real,
    mountGrokSpecialistAvatar: () =>
      Promise.resolve({
        setSpecialist: () => {},
        setState: () => {},
        destroy: () => {}
      })
  };
});

/* jsdom não implementa `element.scrollTo`, e a conversa rola ao montar. */
if (typeof Element.prototype.scrollTo !== "function") {
  Element.prototype.scrollTo = (() => {}) as typeof Element.prototype.scrollTo;
}

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: Root;

function monta(): void {
  act(() => {
    root.render(<App />);
  });
}

/**
 * As superfícies do palco são `lazy`: o import dinâmico só resolve em
 * macrotask, então esperar microtasks (o `assentar` dos vizinhos) não basta.
 * O laço dá tempo real ao Suspense e falha com o NOME do que não apareceu.
 */
async function esperarPor(seletor: string): Promise<Element> {
  for (let tentativa = 0; tentativa < 100; tentativa += 1) {
    const alvo = container.querySelector(seletor);
    if (alvo) return alvo;
    await act(async () => {
      await new Promise((resolver) => setTimeout(resolver, 10));
    });
  }
  throw new Error(`nunca apareceu no DOM: ${seletor}`);
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
  useApp.setState({
    ...initialAppData(),
    status: "ready",
    session: "s-dock",
    // O App chama connect() ao montar; o dublê evita abrir um WebSocket de
    // verdade — conectividade não é o assunto deste arquivo.
    connect: () => {}
  });
  zerarIde();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
});

describe("o composer é um dock no fluxo da coluna do palco", () => {
  it("na conversa: irmão da superfície dentro de main.app-stage, nunca filho direto do shell", async () => {
    monta();
    // A superfície de conversa terminou de carregar quando o scroller existe.
    await esperarPor(".stage-scroll");

    const palco = container.querySelector("main.app-stage");
    const stage = container.querySelector("main.app-stage > section.stage");
    const composer = container.querySelector(".composer-wrap");

    expect(palco).not.toBeNull();
    expect(stage).not.toBeNull();
    expect(composer).not.toBeNull();

    // O ancoramento novo: o composer PARTICIPA do fluxo da coluna do palco.
    // (parentElement é a prova de estrutura que o jsdom alcança; o CSS que
    //  depende dela — .stage flex:1 encolhe, .composer-wrap flex:none — está
    //  em shell.css.)
    expect(composer?.parentElement).toBe(palco);
    // …e vem DEPOIS da superfície: dock de rodapé, não cabeçalho.
    expect(stage?.nextElementSibling).toBe(composer);

    // A âncora antiga (filho direto de .app-shell, flutuando por cima do
    // palco) não pode voltar em silêncio.
    expect(container.querySelector(".app-shell > .composer-wrap")).toBeNull();

    // Um campo só no app inteiro — homogêneo é UM composer, não um por tela.
    expect(document.querySelectorAll(".composer-wrap")).toHaveLength(1);
  });

  it("na IDE: saída, statusbar do editor e TerminalDock continuam renderizados ACIMA do composer", async () => {
    useApp.setState({ activeSurface: "editor" });
    monta();
    // A IDE terminou de carregar quando o painel de saída existe.
    await esperarPor(".editor-output");

    const stage = container.querySelector('section.stage[data-surface="editor"]');
    expect(stage).not.toBeNull();

    // O rodapé da PRÓPRIA superfície — exatamente o que a flutuação cobria.
    const saida = container.querySelector(".stage .editor-output");
    const statusDoEditor = container.querySelector(".stage .surface-status");
    const dockDoTerminal = container.querySelector(".stage .term-dock");
    expect(saida).not.toBeNull();
    expect(statusDoEditor).not.toBeNull();
    expect(dockDoTerminal).not.toBeNull();

    // O composer é irmão da superfície, DEPOIS dela no fluxo: tudo que a IDE
    // desenha no pé (saída, statusbar, terminal) termina antes de o composer
    // começar — nada fica por baixo dele.
    const composer = container.querySelector(".composer-wrap");
    expect(composer?.parentElement).toBe(container.querySelector("main.app-stage"));
    expect(stage?.nextElementSibling).toBe(composer);
    const posicao = dockDoTerminal!.compareDocumentPosition(composer!);
    expect(posicao & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);

    // Sem duplo rodapé: a conversa-espelho da direita usa o MESMO composer do
    // app (não desenha um seu), e o rodapé do shell continua sendo um só.
    expect(container.querySelector(".split-aside .composer-wrap")).toBeNull();
    expect(document.querySelectorAll(".composer-wrap")).toHaveLength(1);
    expect(document.querySelectorAll("footer.statusbar")).toHaveLength(1);
  });
});
