import { describe, expect, it } from "vitest";
import type { CanvasDoc, CanvasNode } from "./canvasDoc";
import {
  buildStencil,
  connectorGeometry,
  connectorsToSvg,
  edgePoint,
  pruneConnectors,
  stencilInsertPosition,
  STENCILS,
  type Connector
} from "./stencils";

const node = (id: string, x: number, y: number, w = 100, h = 60): CanvasNode => ({
  id,
  type: "rect",
  x,
  y,
  w,
  h,
  fill: "#fff"
});

describe("catálogo de stencils", () => {
  it("todo stencil da paleta constrói alguma coisa", () => {
    for (const spec of STENCILS) {
      const nodes = buildStencil(spec.id, 0, 0, "s1");
      expect(nodes.length, spec.id).toBeGreaterThan(0);
    }
  });

  it("cobre os três grupos da paleta (formulário, layout, fluxograma)", () => {
    const grupos = new Set(STENCILS.map((spec) => spec.group));
    expect(grupos).toEqual(new Set(["Formulário", "Layout", "Fluxograma"]));
  });

  it("ids são únicos dentro do stencil e prefixados pela semente", () => {
    const nodes = buildStencil("card", 0, 0, "abc");
    const ids = nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith("abc-"))).toBe(true);
  });

  /** Dois stencils no mesmo documento não podem compartilhar id. */
  it("sementes diferentes não colidem", () => {
    const a = buildStencil("button", 0, 0, "s1").map((n) => n.id);
    const b = buildStencil("button", 0, 0, "s2").map((n) => n.id);
    expect(a.some((id) => b.includes(id))).toBe(false);
  });

  it("o stencil nasce na posição pedida", () => {
    const nodes = buildStencil("button", 300, 200, "s1");
    expect(nodes[0]).toMatchObject({ x: 300, y: 200 });
    // e tudo fica dentro da caixa declarada na paleta
    const spec = STENCILS.find((s) => s.id === "button")!;
    for (const n of nodes) {
      expect(n.x).toBeGreaterThanOrEqual(300);
      expect(n.x + n.w).toBeLessThanOrEqual(300 + spec.w + 1);
    }
  });

  /** Hex literal, nunca custom property: o export SVG roda fora do DOM. */
  it("todo nó sai com cor concreta — o export SVG depende disso", () => {
    for (const spec of STENCILS) {
      for (const n of buildStencil(spec.id, 0, 0, "s1")) {
        expect(n.fill, `${spec.id}/${n.id}`).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });

  it("stencils de formulário trazem rótulo legível", () => {
    expect(buildStencil("button", 0, 0, "s")).toContainEqual(
      expect.objectContaining({ type: "text", text: "Botão" })
    );
    expect(buildStencil("checkbox", 0, 0, "s")).toContainEqual(
      expect.objectContaining({ type: "text", text: "Opção" })
    );
  });
});

describe("stencilInsertPosition", () => {
  it("insere em cascata — dois cliques produzem duas peças visíveis", () => {
    expect(stencilInsertPosition(0)).toEqual({ x: 60, y: 60 });
    expect(stencilInsertPosition(1)).toEqual({ x: 84, y: 84 });
    expect(stencilInsertPosition(5)).toEqual({ x: 180, y: 180 });
  });

  it("recicla a diagonal a cada 6 para não fugir da área visível", () => {
    expect(stencilInsertPosition(6)).toEqual(stencilInsertPosition(0));
    expect(stencilInsertPosition(13)).toEqual(stencilInsertPosition(1));
  });
});

describe("edgePoint", () => {
  /** Sem isto a linha entra até o centro e some atrás da forma. */
  it("para na borda, não no centro", () => {
    const alvo = { x: 500, y: 30 }; // à direita
    const ponto = edgePoint(node("a", 0, 0, 100, 60), alvo);
    expect(ponto.x).toBeCloseTo(100, 5);
    expect(ponto.y).toBeCloseTo(30, 5);
  });

  it("sai pela borda de cima quando o alvo está acima", () => {
    const ponto = edgePoint(node("a", 0, 100, 100, 60), { x: 50, y: 0 });
    expect(ponto.y).toBeCloseTo(100, 5);
    expect(ponto.x).toBeCloseTo(50, 5);
  });

  it("alvo no próprio centro não divide por zero", () => {
    const alvo = { x: 50, y: 30 };
    expect(edgePoint(node("a", 0, 0, 100, 60), alvo)).toEqual(alvo);
  });
});

describe("connectorGeometry", () => {
  const doc: CanvasDoc = { name: "d", nodes: [node("a", 0, 0), node("b", 300, 0)] };

  it("liga duas formas de borda a borda", () => {
    const [linha] = connectorGeometry(doc, [{ id: "c1", from: "a", to: "b" }]);
    expect(linha!.x1).toBe(100); // borda direita de A
    expect(linha!.x2).toBe(300); // borda esquerda de B
    expect(linha!.mx).toBe(200);
  });

  /**
   * O ponto de guardar IDs: a linha acompanha a forma quando ela se move.
   * Com pontos fixos, o diagrama viraria mentira no primeiro arrasto.
   */
  it("a linha acompanha a forma quando ela se move", () => {
    const antes = connectorGeometry(doc, [{ id: "c1", from: "a", to: "b" }])[0]!;
    const movido: CanvasDoc = { ...doc, nodes: [node("a", 0, 0), node("b", 600, 0)] };
    const depois = connectorGeometry(movido, [{ id: "c1", from: "a", to: "b" }])[0]!;
    expect(depois.x2).not.toBe(antes.x2);
    expect(depois.x2).toBe(600);
  });

  /** Apagar uma forma não pode deixar linha apontando para o nada. */
  it("conector com ponta inexistente é descartado", () => {
    expect(connectorGeometry(doc, [{ id: "c1", from: "a", to: "fantasma" }])).toHaveLength(0);
  });

  it("conector de um nó para ele mesmo é ignorado", () => {
    expect(connectorGeometry(doc, [{ id: "c1", from: "a", to: "a" }])).toHaveLength(0);
  });

  it("carrega o rótulo quando existe", () => {
    const [linha] = connectorGeometry(doc, [{ id: "c1", from: "a", to: "b", label: "sim" }]);
    expect(linha!.label).toBe("sim");
  });
});

describe("pruneConnectors", () => {
  it("remove os que perderam alguma ponta", () => {
    const doc: CanvasDoc = { name: "d", nodes: [node("a", 0, 0)] };
    const conectores: Connector[] = [
      { id: "c1", from: "a", to: "b" },
      { id: "c2", from: "a", to: "a" }
    ];
    expect(pruneConnectors(doc, conectores).map((c) => c.id)).toEqual(["c2"]);
  });

  it("lista vazia continua vazia", () => {
    expect(pruneConnectors({ name: "d", nodes: [] }, [])).toEqual([]);
  });
});

describe("connectorsToSvg", () => {
  const doc: CanvasDoc = { name: "d", nodes: [node("a", 0, 0), node("b", 300, 0)] };

  it("gera linha com seta", () => {
    const svg = connectorsToSvg(connectorGeometry(doc, [{ id: "c1", from: "a", to: "b" }]));
    expect(svg).toContain("<line");
    expect(svg).toContain("marker-end");
    expect(svg).toContain("<marker");
  });

  it("rótulo é escapado — senão quebra o SVG", () => {
    const svg = connectorsToSvg(
      connectorGeometry(doc, [{ id: "c1", from: "a", to: "b", label: "A & <B>" }])
    );
    expect(svg).toContain("A &amp; &lt;B&gt;");
    expect(svg).not.toContain("<B>");
  });

  it("sem conector não emite marcador à toa", () => {
    expect(connectorsToSvg([])).toBe("");
  });
});
