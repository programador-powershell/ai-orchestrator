import { describe, expect, it } from "vitest";
import {
  addNode,
  boundsOf,
  createDoc,
  createNode,
  escapeXml,
  exportSvg,
  hitTest,
  MIN_NODE_SIZE,
  nextId,
  normalizeNode,
  parseDoc,
  removeNode,
  reorder,
  updateNode,
  type CanvasDoc,
  type CanvasNode
} from "./canvasDoc";

const rect = (id: string, x = 0, y = 0, w = 100, h = 50): CanvasNode => ({
  id,
  type: "rect",
  x,
  y,
  w,
  h,
  fill: "#ff0000"
});

describe("createDoc", () => {
  it("cria documento mínimo com um único frame vazio 'Frame 1'", () => {
    const doc = createDoc();
    expect(doc.nodes).toHaveLength(1);
    expect(doc.nodes[0]).toMatchObject({ id: "frame-1", type: "frame", text: "Frame 1" });
    expect(doc.nodes[0].w).toBeGreaterThan(0);
    expect(doc.nodes[0].h).toBeGreaterThan(0);
  });
});

describe("createNode / nextId", () => {
  it("gera ids sequenciais únicos por tipo", () => {
    let doc = createDoc();
    const a = createNode(doc, "rect", { x: 0, y: 0, w: 10, h: 10 });
    doc = addNode(doc, a);
    const b = createNode(doc, "rect", { x: 0, y: 0, w: 10, h: 10 });
    expect(a.id).toBe("rect-1");
    expect(b.id).toBe("rect-2");
    expect(nextId(doc, "frame")).toBe("frame-2");
  });

  it("aplica defaults por tipo (texto ganha conteúdo e fontSize)", () => {
    const doc = createDoc();
    const text = createNode(doc, "text", { x: 5, y: 5, w: 120, h: 24 });
    expect(text.text).toBe("Texto");
    expect(text.fontSize).toBe(16);
    const frame = createNode(doc, "frame", { x: 0, y: 0, w: 100, h: 100 });
    expect(frame.text).toMatch(/^Frame /);
  });
});

describe("addNode / updateNode / removeNode (imutáveis)", () => {
  it("addNode acrescenta sem mutar o doc original", () => {
    const doc = createDoc();
    const next = addNode(doc, rect("rect-1"));
    expect(next.nodes).toHaveLength(2);
    expect(doc.nodes).toHaveLength(1);
    expect(next).not.toBe(doc);
  });

  it("updateNode aplica patch preservando id/type e não muta", () => {
    const doc = addNode(createDoc(), rect("rect-1"));
    const next = updateNode(doc, "rect-1", { x: 30, fill: "#00ff00" });
    const node = next.nodes.find((n) => n.id === "rect-1");
    expect(node).toMatchObject({ x: 30, fill: "#00ff00", type: "rect" });
    expect(doc.nodes.find((n) => n.id === "rect-1")?.x).toBe(0);
  });

  it("updateNode com id desconhecido devolve o mesmo doc", () => {
    const doc = createDoc();
    expect(updateNode(doc, "nope", { x: 10 })).toBe(doc);
  });

  it("normaliza tamanho mínimo e valores negativos de raio/fonte", () => {
    const doc = addNode(createDoc(), rect("rect-1"));
    const next = updateNode(doc, "rect-1", { w: 1, h: -20, radius: -4, fontSize: 1 });
    const node = next.nodes.find((n) => n.id === "rect-1");
    expect(node?.w).toBe(MIN_NODE_SIZE);
    expect(node?.h).toBe(MIN_NODE_SIZE);
    expect(node?.radius).toBe(0);
    expect(node?.fontSize).toBe(4);
  });

  it("removeNode remove apenas o alvo", () => {
    const doc = addNode(addNode(createDoc(), rect("rect-1")), rect("rect-2"));
    const next = removeNode(doc, "rect-1");
    expect(next.nodes.map((n) => n.id)).toEqual(["frame-1", "rect-2"]);
    expect(removeNode(next, "nope")).toBe(next);
  });
});

describe("reorder", () => {
  const doc: CanvasDoc = { name: "t", nodes: [rect("a"), rect("b"), rect("c")] };

  it("move o nó para o índice pedido", () => {
    expect(reorder(doc, "a", 2).nodes.map((n) => n.id)).toEqual(["b", "c", "a"]);
    expect(reorder(doc, "c", 0).nodes.map((n) => n.id)).toEqual(["c", "a", "b"]);
  });

  it("faz clamp do índice e ignora id desconhecido", () => {
    expect(reorder(doc, "a", 99).nodes.map((n) => n.id)).toEqual(["b", "c", "a"]);
    expect(reorder(doc, "zz", 1)).toBe(doc);
  });
});

describe("hitTest", () => {
  const doc: CanvasDoc = {
    name: "t",
    nodes: [
      rect("baixo", 0, 0, 200, 200),
      rect("topo", 50, 50, 100, 100),
      { id: "circ", type: "ellipse", x: 300, y: 0, w: 100, h: 100, fill: "#000" }
    ]
  };

  it("devolve o nó mais ao topo sob o ponto", () => {
    expect(hitTest(doc, 60, 60)?.id).toBe("topo");
    expect(hitTest(doc, 10, 10)?.id).toBe("baixo");
    expect(hitTest(doc, 500, 500)).toBeNull();
  });

  it("elipse usa a equação da elipse (canto do bounding box fica fora)", () => {
    expect(hitTest(doc, 350, 50)?.id).toBe("circ");
    expect(hitTest(doc, 302, 2)).toBeNull();
  });
});

describe("exportSvg", () => {
  it("gera SVG válido com dimensões cobrindo todos os nós", () => {
    let doc = createDoc();
    doc = { ...doc, nodes: [{ ...doc.nodes[0], w: 480, h: 320 }] };
    doc = addNode(doc, rect("rect-1", 400, 300, 200, 100));
    const svg = exportSvg(doc);
    expect(svg.startsWith("<svg xmlns=\"http://www.w3.org/2000/svg\"")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).toContain('width="600"');
    expect(svg).toContain('height="400"');
    expect(svg).toContain('viewBox="0 0 600 400"');
  });

  it("inclui cada tipo de nó com atributos corretos", () => {
    const doc: CanvasDoc = {
      name: "t",
      nodes: [
        { id: "r", type: "rect", x: 10, y: 20, w: 100, h: 50, fill: "#ff0000", radius: 8 },
        { id: "e", type: "ellipse", x: 0, y: 0, w: 40, h: 20, fill: "#00ff00" },
        { id: "t", type: "text", x: 5, y: 5, w: 80, h: 20, fill: "#0000ff", text: "Olá", fontSize: 14 }
      ]
    };
    const svg = exportSvg(doc);
    expect(svg).toContain('<rect x="10" y="20" width="100" height="50" fill="#ff0000" rx="8"/>');
    expect(svg).toContain('<ellipse cx="20" cy="10" rx="20" ry="10" fill="#00ff00"/>');
    expect(svg).toContain('font-size="14"');
    expect(svg).toContain(">Olá</text>");
  });

  it("escapa texto e fill contra injeção de markup", () => {
    const doc: CanvasDoc = {
      name: "t",
      nodes: [
        { id: "t", type: "text", x: 0, y: 0, w: 80, h: 20, fill: '"><script>', text: '<b>&"tag"</b>', fontSize: 12 }
      ]
    };
    const svg = exportSvg(doc);
    expect(svg).not.toContain("<script>");
    expect(svg).not.toContain("<b>");
    expect(svg).toContain("&lt;b&gt;&amp;&quot;tag&quot;&lt;/b&gt;");
  });

  it("respeita origem negativa no viewBox", () => {
    const doc: CanvasDoc = { name: "t", nodes: [rect("a", -50, -20, 100, 40)] };
    expect(exportSvg(doc)).toContain('viewBox="-50 -20 100 40"');
  });

  it("doc vazio exporta 1x1 sem nós", () => {
    const svg = exportSvg({ name: "t", nodes: [] });
    expect(svg).toContain('width="1"');
    expect(svg).not.toContain("<rect");
  });
});

describe("escapeXml / boundsOf / normalizeNode", () => {
  it("escapeXml cobre os cinco caracteres reservados", () => {
    expect(escapeXml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&apos;");
  });

  it("boundsOf calcula a caixa envolvente", () => {
    const doc: CanvasDoc = { name: "t", nodes: [rect("a", 10, 10, 50, 50), rect("b", 100, 5, 20, 20)] };
    expect(boundsOf(doc)).toEqual({ x: 10, y: 5, w: 110, h: 55 });
  });

  it("normalizeNode arredonda coordenadas", () => {
    const node = normalizeNode(rect("a", 1.4, 1.6, 99.7, 50.2));
    expect(node).toMatchObject({ x: 1, y: 2, w: 100, h: 50 });
  });
});

describe("parseDoc", () => {
  it("restaura um doc serializado válido", () => {
    const doc = addNode(createDoc(), rect("rect-1"));
    const restored = parseDoc(JSON.stringify(doc));
    expect(restored).toEqual(doc);
  });

  it("rejeita JSON malformado ou com shape inválido", () => {
    expect(parseDoc("not json")).toBeNull();
    expect(parseDoc('{"name":"x"}')).toBeNull();
    expect(parseDoc('{"name":"x","nodes":[{"id":"a"}]}')).toBeNull();
    expect(parseDoc('{"name":"x","nodes":[{"id":"a","type":"blob","x":0,"y":0,"w":1,"h":1,"fill":"#000"}]}')).toBeNull();
  });
});
