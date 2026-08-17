import { describe, expect, it } from "vitest";
import type { CanvasDoc, CanvasNode } from "./canvasDoc";
import {
  applySystem,
  checkConformance,
  colorDistance,
  designContract,
  emptySystem,
  isColorAllowed,
  isEmpty,
  luminance,
  nearestColor,
  paletteWarnings,
  normalizeHex,
  parseSystem,
  serializeSystem,
  systemFromTokens,
  toMarkdown,
  type DesignSystem
} from "./designSystem";

/** Sistema com paleta, escala e raios — o caso completo. */
function marca(): DesignSystem {
  return {
    ...emptySystem("Orchestrator"),
    colors: [
      { name: "primária", value: "#2563eb" },
      { name: "tinta", value: "#111827" },
      { name: "papel", value: "#ffffff" }
    ],
    fonts: ["Inter"],
    fontSizes: [12, 14, 16, 24, 32],
    radii: [4, 8, 16],
    principles: "Contraste mínimo AA em todo texto."
  };
}

const node = (partial: Partial<CanvasNode> & Pick<CanvasNode, "id" | "fill">): CanvasNode => ({
  type: "rect",
  x: 0,
  y: 0,
  w: 100,
  h: 50,
  ...partial
});

const docWith = (...nodes: CanvasNode[]): CanvasDoc => ({ name: "d", nodes });

describe("normalizeHex", () => {
  it("expande a forma curta", () => {
    expect(normalizeHex("#abc")).toBe("#aabbcc");
    expect(normalizeHex("#ABC")).toBe("#aabbcc");
  });

  it("mantém a forma longa em minúsculas", () => {
    expect(normalizeHex("#2563EB")).toBe("#2563eb");
  });

  it("o que não é hex devolve null", () => {
    expect(normalizeHex("rgb(1,2,3)")).toBeNull();
    expect(normalizeHex("azul")).toBeNull();
    expect(normalizeHex("")).toBeNull();
  });
});

describe("colorDistance e nearestColor", () => {
  it("cor idêntica tem distância zero", () => {
    expect(colorDistance("#2563eb", "#2563EB")).toBe(0);
  });

  /**
   * A ponderação existe porque a distância crua em RGB erra: o olho não vê
   * azul e verde igualmente distantes só porque os números são parecidos.
   */
  it("o verde pesa mais que o azul na distância", () => {
    const dVerde = colorDistance("#000000", "#00ff00");
    const dAzul = colorDistance("#000000", "#0000ff");
    expect(dVerde).toBeGreaterThan(dAzul);
  });

  it("escolhe o token mais parecido", () => {
    // #2f6ff0 é um azul próximo da primária
    expect(nearestColor(marca(), "#2f6ff0")?.name).toBe("primária");
    expect(nearestColor(marca(), "#0b0f18")?.name).toBe("tinta");
  });

  it("paleta vazia não sugere nada", () => {
    expect(nearestColor(emptySystem(), "#123456")).toBeNull();
  });

  it("valor ilegível não derruba a comparação", () => {
    expect(colorDistance("azul", "#000000")).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("isColorAllowed", () => {
  it("aceita o que está na paleta, em qualquer caixa", () => {
    expect(isColorAllowed(marca(), "#2563EB")).toBe(true);
  });

  it("recusa o que está fora", () => {
    expect(isColorAllowed(marca(), "#ff0000")).toBe(false);
  });

  /** Sistema sem paleta não cobra cor — senão o time é punido por não ter definido. */
  it("paleta vazia aceita tudo", () => {
    expect(isColorAllowed(emptySystem(), "#ff0000")).toBe(true);
  });

  /** Formato que não sabemos julgar não pode virar apontamento falso. */
  it("formato não-hex não vira violação", () => {
    expect(isColorAllowed(marca(), "rgba(0,0,0,.5)")).toBe(true);
  });
});

describe("checkConformance", () => {
  it("aponta cor fora da paleta com a sugestão mais próxima", () => {
    const [v] = checkConformance(docWith(node({ id: "n1", fill: "#2f6ff0" })), marca());
    expect(v.kind).toBe("cor");
    expect(v.suggestion).toBe("#2563eb");
    expect(v.message).toContain("primária");
    // A categoria NÃO se repete na mensagem: a etiqueta da UI já a mostra.
    expect(v.message).not.toMatch(/^cor /);
  });

  it("aponta tamanho de fonte fora da escala", () => {
    const doc = docWith(node({ id: "n1", fill: "#111827", type: "text", text: "x", fontSize: 19 }));
    const [v] = checkConformance(doc, marca());
    expect(v.kind).toBe("fonte");
    expect(v.suggestion).toBe("16px"); // 19 está mais perto de 16 que de 24
  });

  it("aponta raio fora do sistema", () => {
    const [v] = checkConformance(docWith(node({ id: "n1", fill: "#ffffff", radius: 7 })), marca());
    expect(v.kind).toBe("raio");
    expect(v.suggestion).toBe("8px");
  });

  it("documento conforme não gera apontamento", () => {
    const doc = docWith(
      node({ id: "n1", fill: "#2563eb", radius: 8 }),
      node({ id: "n2", fill: "#111827", type: "text", text: "x", fontSize: 16 })
    );
    expect(checkConformance(doc, marca())).toEqual([]);
  });

  /**
   * A regra que impede o contrato de virar ruído: categoria que o time NÃO
   * padronizou não pode encher a tela de reclamação.
   */
  it("categoria vazia no sistema não gera apontamento", () => {
    const soCor: DesignSystem = { ...emptySystem(), colors: marca().colors };
    const doc = docWith(node({ id: "n1", fill: "#2563eb", type: "text", text: "x", fontSize: 99, radius: 99 }));
    expect(checkConformance(doc, soCor)).toEqual([]);
  });

  it("raio zero não é violação", () => {
    expect(checkConformance(docWith(node({ id: "n1", fill: "#ffffff", radius: 0 })), marca())).toEqual([]);
  });

  it("aponta cada nó separadamente", () => {
    const doc = docWith(node({ id: "n1", fill: "#ff0000" }), node({ id: "n2", fill: "#00ff00" }));
    expect(checkConformance(doc, marca()).map((v) => v.nodeId)).toEqual(["n1", "n2"]);
  });
});

describe("applySystem", () => {
  /** Aproxima em vez de zerar: o desenho continua reconhecível. */
  it("aproxima a cor solta do token mais parecido", () => {
    const out = applySystem(docWith(node({ id: "n1", fill: "#2f6ff0" })), marca());
    expect(out.nodes[0].fill).toBe("#2563eb");
  });

  it("ajusta fonte e raio para o mais próximo da escala", () => {
    const doc = docWith(node({ id: "n1", fill: "#111827", type: "text", text: "x", fontSize: 19, radius: 7 }));
    const out = applySystem(doc, marca());
    expect(out.nodes[0].fontSize).toBe(16);
    expect(out.nodes[0].radius).toBe(8);
  });

  /** Sem mudança, o histórico de desfazer não pode ganhar entrada vazia. */
  it("documento já conforme sai como a MESMA referência", () => {
    const doc = docWith(node({ id: "n1", fill: "#2563eb", radius: 8 }));
    expect(applySystem(doc, marca())).toBe(doc);
  });

  it("sistema vazio não mexe em nada", () => {
    const doc = docWith(node({ id: "n1", fill: "#ff0000" }));
    expect(applySystem(doc, emptySystem())).toBe(doc);
  });

  it("não muta o documento original", () => {
    const doc = docWith(node({ id: "n1", fill: "#2f6ff0" }));
    applySystem(doc, marca());
    expect(doc.nodes[0].fill).toBe("#2f6ff0");
  });
});

describe("systemFromTokens", () => {
  it("semeia a paleta a partir dos tokens do site", () => {
    const system = systemFromTokens("Clonado", {
      colors: [{ value: "#2563EB" }, { value: "#111827" }],
      fonts: ["Inter", "Georgia"]
    });
    expect(system.colors.map((token) => token.value)).toEqual(["#2563eb", "#111827"]);
    expect(system.fonts).toEqual(["Inter", "Georgia"]);
  });

  /** rgba e gradiente são uso pontual, não token de marca. */
  it("descarta o que não é hex", () => {
    const system = systemFromTokens("X", {
      colors: [{ value: "rgba(0,0,0,.4)" }, { value: "#fff" }, { value: "linear-gradient(...)" }],
      fonts: []
    });
    expect(system.colors.map((token) => token.value)).toEqual(["#ffffff"]);
  });

  it("remove duplicata em formatos diferentes", () => {
    const system = systemFromTokens("X", { colors: [{ value: "#abc" }, { value: "#AABBCC" }], fonts: [] });
    expect(system.colors).toHaveLength(1);
  });

  it("respeita o teto da paleta", () => {
    const muitas = Array.from({ length: 30 }, (_, i) => ({ value: `#${i.toString(16).padStart(6, "0")}` }));
    expect(systemFromTokens("X", { colors: muitas, fonts: [] }).colors).toHaveLength(8);
  });
});

describe("designContract", () => {
  /** Sem isto na frente de CADA pedido, o modelo esquece a marca no terceiro. */
  it("lista a paleta e marca as regras como inegociáveis", () => {
    const texto = designContract(marca());
    expect(texto).toContain("INEGOCIÁVEIS");
    expect(texto).toContain("primária: #2563eb");
    expect(texto).toContain("SOMENTE");
    expect(texto).toContain("Contraste mínimo AA");
  });

  it("escala e raios saem ordenados", () => {
    const bagunçado: DesignSystem = { ...marca(), fontSizes: [24, 12, 16], radii: [16, 4] };
    const texto = designContract(bagunçado);
    expect(texto).toContain("12, 16, 24");
    expect(texto).toContain("4, 16");
  });

  /** Sistema vazio não injeta bloco vazio no prompt. */
  it("sistema vazio devolve string vazia", () => {
    expect(designContract(emptySystem())).toBe("");
  });

  it("só princípios já vale contrato", () => {
    const so = { ...emptySystem(), principles: "Nada de sombra." };
    expect(isEmpty(so)).toBe(false);
    expect(designContract(so)).toContain("Nada de sombra");
  });
});

describe("persistência", () => {
  it("faz round-trip", () => {
    expect(parseSystem(serializeSystem(marca()))).toEqual(marca());
  });

  it("recusa nulo, lixo e versão errada", () => {
    expect(parseSystem(null)).toBeNull();
    expect(parseSystem("não é json")).toBeNull();
    expect(parseSystem(JSON.stringify({ schemaVersion: 2 }))).toBeNull();
  });

  it("descarta entradas corrompidas em vez de quebrar", () => {
    const bruto = JSON.stringify({
      schemaVersion: 1,
      colors: [{ name: "ok", value: "#fff" }, { name: 5 }, null],
      fontSizes: [12, "grande", -4],
      fonts: ["Inter", 7]
    });
    const system = parseSystem(bruto);
    expect(system?.colors).toHaveLength(1);
    expect(system?.fontSizes).toEqual([12]);
    expect(system?.fonts).toEqual(["Inter"]);
  });
});

describe("toMarkdown", () => {
  it("exporta as seções preenchidas", () => {
    const md = toMarkdown(marca());
    expect(md).toContain("# Orchestrator");
    expect(md).toContain("**primária** — `#2563eb`");
    expect(md).toContain("## Princípios");
  });

  it("sistema vazio vira só o título — sem cabeçalho órfão", () => {
    expect(toMarkdown(emptySystem("Vazio"))).toBe("# Vazio");
  });
});

describe("paletteWarnings", () => {
  /**
   * O caso real que motivou este aviso: paleta só com tons escuros fez o
   * texto branco de um botão ser "aproximado" para azul sobre fundo azul —
   * o texto sumiu. O algoritmo está certo; a paleta é que está incompleta.
   */
  it("avisa quando a paleta não tem cor clara e escura", () => {
    const escura: DesignSystem = {
      ...emptySystem(),
      colors: [
        { name: "a", value: "#2563eb" },
        { name: "b", value: "#111827" }
      ]
    };
    expect(paletteWarnings(escura)[0]).toContain("eliminar contraste");
  });

  it("paleta com claro e escuro não gera aviso", () => {
    expect(paletteWarnings(marca())).toEqual([]);
  });

  it("uma cor só é o caso mais grave e tem aviso próprio", () => {
    const uma: DesignSystem = { ...emptySystem(), colors: [{ name: "a", value: "#2563eb" }] };
    expect(paletteWarnings(uma)[0]).toContain("uma cor só");
  });

  it("paleta vazia não avisa — ela nem cobra cor", () => {
    expect(paletteWarnings(emptySystem())).toEqual([]);
  });

  it("luminância separa branco de preto na escala do WCAG", () => {
    expect(luminance("#ffffff")).toBeCloseTo(1, 2);
    expect(luminance("#000000")).toBeCloseTo(0, 2);
    expect(luminance("azul")).toBe(0);
  });
});
