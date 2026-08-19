/**
 * A linha do tempo pura: leitura de tempo e operações imutáveis.
 *
 * O que importa fixar aqui é o CONTRATO de imutabilidade — operação que muda
 * devolve array novo, operação que não muda devolve a MESMA referência (é o
 * que faz o set do store virar no-op) — e as bordas do corte/aparo, porque é
 * nelas que a timeline vira lixo em silêncio.
 */

import { describe, expect, it } from "vitest";

import {
  addClip,
  buildTicks,
  clipAt,
  clipDuration,
  clipOffsets,
  formatTime,
  MIN_CLIP_SEC,
  moveClip,
  removeClip,
  splitClipAt,
  tickStep,
  totalDuration,
  trimClip,
  type VideoClip,
  type VideoMedia
} from "./timeline";

const video = (over: Partial<VideoMedia> = {}): VideoMedia => ({
  id: "m1",
  name: "abertura.mp4",
  kind: "video",
  duration: 10,
  ...over
});

const clip = (over: Partial<VideoClip> = {}): VideoClip => ({
  id: "c1",
  mediaId: "m1",
  name: "abertura",
  start: 0,
  end: 10,
  ...over
});

describe("leitura de tempo", () => {
  it("soma as durações e calcula o começo de cada clipe", () => {
    const clips = [clip(), clip({ id: "c2", start: 2, end: 5 })];
    expect(totalDuration(clips)).toBe(13);
    expect(clipOffsets(clips)).toEqual([0, 10]);
    expect(clipDuration(clips[1] as VideoClip)).toBe(3);
  });

  it("acha o clipe sob o instante, com o tempo interno dele", () => {
    const clips = [clip(), clip({ id: "c2", start: 0, end: 5 })];
    expect(clipAt(clips, 3)).toEqual({ index: 0, inner: 3 });
    expect(clipAt(clips, 12)).toEqual({ index: 1, inner: 2 });
  });

  it("grampeia o instante: antes de zero cai no começo, depois do fim cai no último", () => {
    const clips = [clip(), clip({ id: "c2", end: 5 })];
    expect(clipAt(clips, -4)).toEqual({ index: 0, inner: 0 });
    const fim = clipAt(clips, 99);
    expect(fim?.index).toBe(1);
    // Fica DENTRO do último clipe (total - epsilon), nunca além dele.
    expect(fim && fim.inner < 5).toBe(true);
  });

  it("devolve null para a timeline vazia — o transporte sabe que não há o que tocar", () => {
    expect(clipAt([], 3)).toBeNull();
  });

  it("formata minutos e décimos para a régua e o transporte", () => {
    expect(formatTime(0)).toBe("0:00.0");
    expect(formatTime(65.25)).toBe("1:05.3");
    expect(formatTime(-3)).toBe("0:00.0");
  });

  it("a régua mira ~10 marcações em qualquer duração", () => {
    expect(tickStep(4)).toBe(0.5);
    expect(tickStep(90)).toBe(10);
    expect(buildTicks(10)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(buildTicks(0)).toEqual([]);
  });
});

describe("addClip", () => {
  it("acrescenta um clipe cobrindo a mídia inteira, sem a extensão no nome", () => {
    const clips = addClip([], video(), "novo");
    expect(clips).toEqual([{ id: "novo", mediaId: "m1", name: "abertura", start: 0, end: 10 }]);
  });

  it("recusa imagem — ela é overlay, não clipe de base", () => {
    const antes: VideoClip[] = [];
    const depois = addClip(antes, video({ kind: "image", duration: 0, name: "logo.png" }), "novo");
    expect(depois).toBe(antes);
  });

  it("não muta a lista original", () => {
    const antes = [clip()];
    const depois = addClip(antes, video({ id: "m2", name: "corpo.mp4" }), "novo");
    expect(antes).toHaveLength(1);
    expect(depois).toHaveLength(2);
  });
});

describe("splitClipAt", () => {
  it("divide no meio do clipe: A fica com o começo, B com o fim, no MESMO ponto da mídia", () => {
    const clips = splitClipAt([clip({ start: 2, end: 8 })], 4, "b1");
    expect(clips).toHaveLength(2);
    expect(clips[0]).toMatchObject({ id: "c1", name: "abertura · A", start: 2, end: 6 });
    expect(clips[1]).toMatchObject({ id: "b1", name: "abertura · B", start: 6, end: 8 });
    // Nada se perde nem se duplica: as metades somam o clipe original.
    expect(totalDuration(clips)).toBe(6);
  });

  it("corta o SEGUNDO clipe quando o instante cai nele", () => {
    const clips = splitClipAt([clip({ end: 4 }), clip({ id: "c2", start: 0, end: 6 })], 7, "b1");
    expect(clips).toHaveLength(3);
    expect(clips[1]).toMatchObject({ id: "c2", end: 3 });
    expect(clips[2]).toMatchObject({ id: "b1", start: 3, end: 6 });
  });

  it("a transição fica só na metade DIREITA — a emenda interna é corte seco", () => {
    const clips = splitClipAt([clip({ transition: "fade", transitionDuration: 1 })], 5, "b1");
    expect(clips[0]?.transition).toBeUndefined();
    expect(clips[1]).toMatchObject({ transition: "fade", transitionDuration: 1 });
  });

  it("recusa cortar rente à borda — a lasca nem tocaria nem exportaria", () => {
    const antes = [clip()];
    expect(splitClipAt(antes, 0.05, "b1")).toBe(antes);
    expect(splitClipAt(antes, 9.95, "b1")).toBe(antes);
    expect(splitClipAt([], 1, "b1")).toEqual([]);
  });
});

describe("trimClip", () => {
  it("apara as duas bordas dentro da mídia", () => {
    const clips = trimClip([clip()], "c1", { start: 2, end: 7 }, 10);
    expect(clips[0]).toMatchObject({ start: 2, end: 7 });
  });

  it("grampeia: início nunca negativo, fim nunca além da mídia", () => {
    const clips = trimClip([clip({ start: 2, end: 8 })], "c1", { start: -5, end: 99 }, 10);
    expect(clips[0]).toMatchObject({ start: 0, end: 10 });
  });

  it("nunca deixa o clipe menor que o mínimo — aparar não é apagar", () => {
    const clips = trimClip([clip()], "c1", { start: 5, end: 5 }, 10);
    expect(clips[0]).toMatchObject({ start: 5, end: 5 + MIN_CLIP_SEC });
  });

  it("mídia sem duração conhecida não deixa o clipe esticar, só encolher", () => {
    const estica = trimClip([clip({ end: 6 })], "c1", { end: 9 }, 0);
    expect(estica[0]?.end).toBe(6);
    const encolhe = trimClip([clip({ end: 6 })], "c1", { end: 4 }, 0);
    expect(encolhe[0]?.end).toBe(4);
  });

  it("aparo sem efeito devolve a MESMA referência (set do store vira no-op)", () => {
    const antes = [clip()];
    expect(trimClip(antes, "c1", { start: 0 }, 10)).toBe(antes);
    expect(trimClip(antes, "nao-existe", { start: 3 }, 10)).toBe(antes);
  });
});

describe("removeClip / moveClip", () => {
  it("remove por id e preserva os vizinhos", () => {
    const clips = removeClip([clip(), clip({ id: "c2" })], "c1");
    expect(clips.map((item) => item.id)).toEqual(["c2"]);
  });

  it("remover id inexistente devolve a mesma referência", () => {
    const antes = [clip()];
    expect(removeClip(antes, "x")).toBe(antes);
  });

  it("move o clipe para o índice pedido", () => {
    const antes = [clip(), clip({ id: "c2" }), clip({ id: "c3" })];
    expect(moveClip(antes, "c3", 0).map((item) => item.id)).toEqual(["c3", "c1", "c2"]);
    expect(moveClip(antes, "c1", 2).map((item) => item.id)).toEqual(["c2", "c3", "c1"]);
  });

  it("grampeia o destino e devolve a mesma referência quando nada muda", () => {
    const antes = [clip(), clip({ id: "c2" })];
    // 99 grampeia no último índice — onde o c2 já está: nada muda.
    expect(moveClip(antes, "c2", 99)).toBe(antes);
    expect(moveClip(antes, "c1", -5)).toBe(antes);
    expect(moveClip(antes, "c1", 99).map((item) => item.id)).toEqual(["c2", "c1"]);
    expect(moveClip(antes, "nao-existe", 1)).toBe(antes);
  });
});
