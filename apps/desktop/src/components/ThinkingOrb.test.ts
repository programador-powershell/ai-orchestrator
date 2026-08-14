import { describe, expect, it } from "vitest";
import { MODE_DRAWS, STATE_TO_MODE, resolvePreset } from "thinking-orbs";

import { presetPara, thinkingKindFor, type ThinkingKind } from "./ThinkingOrb";

const ESTADOS: ThinkingKind[] = [
  "breathing",
  "composing",
  "connecting",
  "listening",
  "searching",
  "shaping",
  "solving",
  "weaving",
  "working"
];

describe("thinkingKindFor", () => {
  it("sem texto, respira", () => {
    expect(thinkingKindFor("")).toBe("breathing");
    expect(thinkingKindFor(null)).toBe("breathing");
    expect(thinkingKindFor(undefined)).toBe("breathing");
  });

  it("lê as etapas que as abas realmente escrevem", () => {
    expect(thinkingKindFor("Pesquisa profunda: coletando fontes…")).toBe("searching");
    expect(thinkingKindFor("Elaborando plano…")).toBe("weaving");
    expect(thinkingKindFor("Aplicando operações do canal ops:data")).toBe("working");
    expect(thinkingKindFor("Montando o fluxo · + Novo lead")).toBe("weaving");
    expect(thinkingKindFor("Revisão")).toBe("solving");
    expect(thinkingKindFor("Renderizando o quadro")).toBe("shaping");
  });

  it("a ORDEM das pistas resolve o caso ambíguo", () => {
    // "revisando o plano" tem as duas palavras. É conferência, não montagem —
    // e cairia em `weaving` se "plano" fosse testado antes de "revis".
    expect(thinkingKindFor("revisando o plano")).toBe("solving");
  });

  it("texto sem pista nenhuma respira em vez de chutar", () => {
    expect(thinkingKindFor("xyz")).toBe("breathing");
  });

  it("reconhece o id de ferramenta que o composer escreve em inglês", () => {
    // `setStage("Ferramenta: fs_read")` — sem verbo e sem português. Sem
    // estes ids, a maioria das ferramentas rodava mostrando REPOUSO.
    expect(thinkingKindFor("Ferramenta: fs_read")).toBe("searching");
    expect(thinkingKindFor("Ferramenta: fs_list")).toBe("searching");
    expect(thinkingKindFor("Ferramenta: web_search")).toBe("searching");
    expect(thinkingKindFor("Ferramenta: fs_write")).toBe("composing");
    expect(thinkingKindFor("Ferramenta: generate_image")).toBe("shaping");
    expect(thinkingKindFor("Ferramenta: terminal")).toBe("working");
    expect(thinkingKindFor("Ferramenta: fusion_executor")).toBe("weaving");
  });

  it("nenhuma etapa real do app cai em repouso por acidente", () => {
    // Amostra do que o app escreve de verdade em `setStage`.
    const reais = [
      "Elaborando plano…",
      "Pesquisa profunda: coletando fontes…",
      "Diagnóstico: src/App.tsx",
      "Fusion · complexidade 62% · 2 executor(es)",
      "Aplicando operações do canal ops:data",
      "Montando o fluxo · + Novo lead"
    ];
    for (const etapa of reais) {
      expect(thinkingKindFor(etapa), etapa).not.toBe("breathing");
    }
  });
});

describe("presetPara", () => {
  it("abaixo de 20px não há desenho tunado — fica o glifo", () => {
    expect(presetPara(11)).toBeNull();
    expect(presetPara(12)).toBeNull();
    expect(presetPara(13)).toBeNull();
    expect(presetPara(19)).toBeNull();
  });

  it("escala de texto a partir de 20", () => {
    expect(presetPara(20)).toBe(20);
    expect(presetPara(28)).toBe(20);
    expect(presetPara(39)).toBe(20);
  });

  it("escala grande a partir de 40", () => {
    expect(presetPara(40)).toBe(64);
    expect(presetPara(64)).toBe(64);
  });

  it("só devolve tamanho que a biblioteca conhece", () => {
    // `resolvePreset` indexa PRESETS[mode][size]: qualquer outro número
    // devolveria `undefined` e quebraria no desenho, sem erro antes disso.
    for (const size of [11, 12, 16, 20, 33, 40, 64, 96]) {
      const preset = presetPara(size);
      if (preset === null) continue;
      expect(() => resolvePreset("working", preset)).not.toThrow();
      expect(resolvePreset("working", preset).opts).toBeTruthy();
    }
  });
});

/**
 * Contexto 2D de mentira que anota o que foi desenhado.
 *
 * Existe porque a verificação que importa — "os nove estados desenham coisas
 * diferentes, e o desenho muda com o tempo" — não dá para fazer na tela: a
 * biblioteca congela a animação quando a página está oculta (comportamento
 * correto, e o que acontece em ambiente sem exibição).
 */
function contextoDeMentira() {
  const registro: string[] = [];
  const alvo = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    globalAlpha: 1,
    lineCap: "butt",
    lineJoin: "miter",
    setTransform: () => registro.push("setTransform"),
    clearRect: () => registro.push("clearRect"),
    beginPath: () => registro.push("beginPath"),
    closePath: () => registro.push("closePath"),
    save: () => registro.push("save"),
    restore: () => registro.push("restore"),
    translate: () => registro.push("translate"),
    rotate: () => registro.push("rotate"),
    scale: () => registro.push("scale"),
    arc: (x: number, y: number, r: number) => registro.push(`arc ${x.toFixed(2)} ${y.toFixed(2)} ${r.toFixed(2)}`),
    ellipse: (x: number, y: number) => registro.push(`ellipse ${x.toFixed(2)} ${y.toFixed(2)}`),
    moveTo: (x: number, y: number) => registro.push(`moveTo ${x.toFixed(2)} ${y.toFixed(2)}`),
    lineTo: (x: number, y: number) => registro.push(`lineTo ${x.toFixed(2)} ${y.toFixed(2)}`),
    quadraticCurveTo: (a: number, b: number, c: number, d: number) =>
      registro.push(`quad ${a.toFixed(2)} ${b.toFixed(2)} ${c.toFixed(2)} ${d.toFixed(2)}`),
    bezierCurveTo: (a: number, b: number, c: number, d: number, e: number, f: number) =>
      registro.push(`bezier ${a.toFixed(2)} ${b.toFixed(2)} ${c.toFixed(2)} ${d.toFixed(2)} ${e.toFixed(2)} ${f.toFixed(2)}`),
    rect: (x: number, y: number) => registro.push(`rect ${x.toFixed(2)} ${y.toFixed(2)}`),
    fill: () => registro.push(`fill ${String(alvo.fillStyle)}`),
    stroke: () => registro.push(`stroke ${String(alvo.strokeStyle)}`)
  };
  return { ctx: alvo as unknown as CanvasRenderingContext2D, registro };
}

/** Desenha um quadro e devolve a assinatura do que saiu. */
function quadro(state: ThinkingKind, t: number, dark = true): string {
  const { mode, opts } = resolvePreset(state, 20);
  const { ctx, registro } = contextoDeMentira();
  MODE_DRAWS[mode](ctx, 20, t, dark, opts);
  return registro.join("|");
}

describe("desenho da biblioteca", () => {
  it("os nove estados existem e cada um tem um modo de desenho", () => {
    for (const state of ESTADOS) {
      expect(STATE_TO_MODE[state], `estado ${state}`).toBeTruthy();
      expect(MODE_DRAWS[STATE_TO_MODE[state]], `modo de ${state}`).toBeInstanceOf(Function);
    }
  });

  it("cada estado desenha algo DIFERENTE dos outros", () => {
    const assinaturas = ESTADOS.map((state) => quadro(state, 1.5));
    for (const assinatura of assinaturas) expect(assinatura.length).toBeGreaterThan(0);
    expect(new Set(assinaturas).size).toBe(ESTADOS.length);
  });

  it("o desenho MUDA com o tempo — é animação, não figura parada", () => {
    for (const state of ESTADOS) {
      const a = quadro(state, 0);
      const b = quadro(state, 1.7);
      expect(a, `estado ${state} não se mexe`).not.toBe(b);
    }
  });

  it("tema escuro e claro trocam a tinta", () => {
    const escuro = quadro("working", 1, true);
    const claro = quadro("working", 1, false);
    expect(escuro).not.toBe(claro);
  });
});
