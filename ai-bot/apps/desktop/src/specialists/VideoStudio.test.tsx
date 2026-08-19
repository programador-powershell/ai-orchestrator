/**
 * O estúdio de Vídeo DESENHADO: timeline com régua e playhead, aparo pelo
 * painel, overlays com preview posicional e o export que NÃO executa nada —
 * monta o comando e o entrega ao composer.
 *
 * A lógica pura (operações da timeline, montagem do ffmpeg) já é coberta em
 * lib/video; este arquivo monta o componente porque a entrega é de FIAÇÃO —
 * o clique virando seleção, o campo virando aparo grampeado, o botão virando
 * texto no composer. A lógica certa com a fiação errada seria o defeito de
 * sempre: uma tela que parece funcionar.
 *
 * Sem @testing-library: montagem `react-dom/client` crua com o `act` do
 * React 19, como nos outros testes de tela deste projeto.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { initialAppData, useApp } from "../lib/store";
import { VideoStudio, useVideoStudio } from "./VideoStudio";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
  useApp.setState({ ...initialAppData() });
  // O store é de MÓDULO (sobrevive à troca de aba de propósito, como no app);
  // aqui cada teste parte do projeto vazio para um não contaminar o outro.
  useVideoStudio.setState({ media: [], clips: [], texts: [], logos: [], selectedClipId: null, playbackEpoch: 0 });
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
    root.render(<VideoStudio />);
  });
}

/** Digita num input controlado sem biblioteca: o setter NATIVO de `value`
 *  seguido do evento `input` — setar `input.value` direto o React ignora. */
function digita(campo: HTMLInputElement | HTMLTextAreaElement, valor: string) {
  const proto = campo instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  act(() => {
    setter?.call(campo, valor);
    campo.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function botaoPorTexto(texto: string): HTMLButtonElement {
  const botao = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
    (item.textContent ?? "").includes(texto)
  );
  expect(botao, `botão "${texto}"`).toBeDefined();
  return botao as HTMLButtonElement;
}

/** Semeia o projeto direto no store: a importação de arquivo depende de
 *  URL.createObjectURL e do probe de metadado do <video>, que o jsdom não
 *  implementa — o que interessa aqui começa DEPOIS da importação. */
function semeia() {
  act(() => {
    const estado = useVideoStudio.getState();
    estado.adicionarMidia({ id: "m1", name: "abertura.mp4", kind: "video", duration: 10, url: "" });
    estado.adicionarMidia({ id: "m2", name: "corpo.mp4", kind: "video", duration: 5, url: "" });
    estado.adicionarMidia({ id: "img", name: "logo.png", kind: "image", duration: 0, url: "" });
    estado.adicionarClipe("m1");
    estado.adicionarClipe("m2");
  });
}

describe("o estúdio vazio", () => {
  it("convida a importar e o input de arquivo aceita vídeo E imagem", () => {
    monta();
    expect(container.textContent).toContain("Monte cortes sem sair do estúdio");
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input?.getAttribute("accept")).toBe("video/*,image/*");
    // Sem clipe não há o que dividir nem exportar — os botões dizem isso.
    expect(botaoPorTexto("Dividir no playhead").disabled).toBe(true);
    expect(botaoPorTexto("Exportar com o agente").disabled).toBe(true);
  });
});

describe("a timeline", () => {
  it("desenha um botão por clipe, a régua com marcações e o playhead", () => {
    semeia();
    monta();
    expect(container.querySelectorAll(".vid-clip")).toHaveLength(2);
    expect(container.querySelector(".vid-playhead")).not.toBeNull();
    // 15s de total → régua de passo 2 (~10 marcações), começando no zero.
    const ticks = [...container.querySelectorAll(".vid-tick")].map((tick) => tick.textContent);
    expect(ticks[0]).toBe("0:00.0");
    expect(ticks.length).toBeGreaterThan(5);
    expect(container.textContent).toContain("0:15.0 total");
  });

  it("clicar num clipe seleciona; o painel apara com grampo na mídia", () => {
    semeia();
    monta();
    const [primeiro] = container.querySelectorAll<HTMLButtonElement>(".vid-clip");
    act(() => {
      primeiro?.click();
    });
    expect(useVideoStudio.getState().selectedClipId).toBe(useVideoStudio.getState().clips[0]?.id);

    const entrada = container.querySelector<HTMLInputElement>('input[aria-label="Entrada (s)"]');
    expect(entrada).not.toBeNull();
    digita(entrada as HTMLInputElement, "2");
    expect(useVideoStudio.getState().clips[0]?.start).toBe(2);

    // Saída além da mídia (10s) grampeia nela — aparar nunca estica.
    const saida = container.querySelector<HTMLInputElement>('input[aria-label="Saída (s)"]');
    digita(saida as HTMLInputElement, "99");
    expect(useVideoStudio.getState().clips[0]?.end).toBe(10);
  });

  it("a transição escolhida no painel fica no clipe de ORIGEM", () => {
    semeia();
    monta();
    const [primeiro] = container.querySelectorAll<HTMLButtonElement>(".vid-clip");
    act(() => {
      primeiro?.click();
    });
    const select = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Transição para o próximo clipe"]'
    );
    expect(select).not.toBeNull();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
      setter?.call(select, "fade");
      select?.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(useVideoStudio.getState().clips[0]?.transition).toBe("fade");
    expect(useVideoStudio.getState().clips[1]?.transition).toBeUndefined();
  });

  it("dividir no meio do clipe passa pela MESMA ação do botão do transporte", () => {
    semeia();
    monta();
    act(() => {
      useVideoStudio.getState().dividirEm(4);
    });
    const { clips } = useVideoStudio.getState();
    expect(clips).toHaveLength(3);
    expect(clips[0]?.name).toContain("· A");
    expect(clips[1]?.name).toContain("· B");
    expect(container.querySelectorAll(".vid-clip")).toHaveLength(3);
  });
});

describe("overlays", () => {
  it("«Adicionar texto» cria o overlay e o preview posicional aparece no player", () => {
    semeia();
    monta();
    act(() => {
      botaoPorTexto("Adicionar texto").click();
    });
    expect(useVideoStudio.getState().texts).toHaveLength(1);
    const preview = container.querySelector<HTMLElement>(".vid-text-preview");
    expect(preview?.textContent).toBe("Texto");
    // 48px do quadro nominal de 1280 → 3.75% da largura do player.
    expect(preview?.style.left).toBe("3.75%");

    const campo = container.querySelector<HTMLInputElement>(
      'input[aria-label="Conteúdo do texto sobre o vídeo"]'
    );
    digita(campo as HTMLInputElement, "Cena d'água: take 2");
    expect(useVideoStudio.getState().texts[0]?.text).toBe("Cena d'água: take 2");
    expect(container.querySelector(".vid-text-preview")?.textContent).toBe("Cena d'água: take 2");
  });

  it("logo só nasce de imagem importada, com janela e posição próprias", () => {
    semeia();
    monta();
    act(() => {
      useVideoStudio.getState().adicionarLogo("m1"); // vídeo: recusado
      useVideoStudio.getState().adicionarLogo("img"); // imagem: entra
    });
    const { logos } = useVideoStudio.getState();
    expect(logos).toHaveLength(1);
    expect(logos[0]).toMatchObject({ mediaId: "img", x: 24, y: 24 });
    expect(container.querySelector(".vid-logo-preview")).not.toBeNull();
  });
});

describe("exportar com o agente", () => {
  it("monta o comando com os NOMES reais, pede a pasta e entrega ao composer — sem executar nada", () => {
    semeia();
    monta();
    act(() => {
      botaoPorTexto("Adicionar texto").click();
    });
    act(() => {
      const texto = useVideoStudio.getState().texts[0];
      if (texto) useVideoStudio.getState().patchTexto(texto.id, { text: "Cena d'água: take 2" });
    });
    act(() => {
      botaoPorTexto("Exportar com o agente").click();
    });

    const input = useApp.getState().input;
    // O comando vai com os nomes dos arquivos — nunca os object URLs.
    expect(input).toContain("ffmpeg -y -i abertura.mp4 -i corpo.mp4");
    expect(input).toContain("corte-final.mp4");
    expect(input).not.toContain("blob:");
    // O texto pede a confirmação da PASTA: o estúdio só conhece os nomes.
    expect(input).toContain("PASTA");
    expect(input).toContain("abertura.mp4, corpo.mp4");
    // O escape do drawtext atravessa inteiro: apóstrofo tipográfico e `\:`.
    expect(input).toContain("text='Cena d’água\\: take 2'");
    // E o aviso da fonte (não há fontFile) chega junto para quem vai aprovar.
    expect(input).toContain("arquivo de fonte");
  });

  it("recusa da montagem vira nota na tela, não comando quebrado no composer", () => {
    semeia();
    monta();
    // Transição impossível: maior que o clipe vizinho de 5s.
    act(() => {
      const clip = useVideoStudio.getState().clips[0];
      if (clip) useVideoStudio.getState().patchClipe(clip.id, { transition: "fade", transitionDuration: 8 });
    });
    act(() => {
      botaoPorTexto("Exportar com o agente").click();
    });
    expect(useApp.getState().input).toBe("");
    expect(container.textContent).toContain("maior que o clipe");
  });
});
