import { describe, expect, it } from "vitest";
import {
  absolutizeHtml,
  docFromSnapshots,
  droppedCount,
  isTransparent,
  MAX_NODES,
  sanitizeForPreview,
  snapshotToNode,
  toHex,
  type ElementSnapshot
} from "./siteLayout";

const snap = (partial: Partial<ElementSnapshot> = {}): ElementSnapshot => ({
  tag: "div",
  x: 10,
  y: 20,
  w: 200,
  h: 50,
  background: "rgb(255, 255, 255)",
  color: "rgb(17, 24, 39)",
  fontSize: 16,
  text: "",
  radius: 0,
  depth: 1,
  ...partial
});

describe("absolutizeHtml", () => {
  const base = "https://exemplo.com/blog/post";

  /** Sem isto o CSS não carrega no iframe e o clone vira blocos empilhados. */
  it("resolve caminho relativo de href e src", () => {
    const html = '<link href="/css/app.css"><img src="../img/logo.png">';
    const out = absolutizeHtml(html, base);
    expect(out).toContain('href="https://exemplo.com/css/app.css"');
    expect(out).toContain('src="https://exemplo.com/img/logo.png"');
  });

  it("resolve url() dentro de CSS embutido", () => {
    const out = absolutizeHtml('<style>.a{background:url(fundo.jpg)}</style>', base);
    expect(out).toContain("url(https://exemplo.com/blog/fundo.jpg)");
  });

  it("aspas simples também são tratadas", () => {
    const out = absolutizeHtml("<img src='/a.png'>", base);
    expect(out).toContain("src='https://exemplo.com/a.png'");
  });

  it("não mexe no que já é absoluto, âncora ou dado embutido", () => {
    const html =
      '<a href="https://outro.com/x"></a><a href="#topo"></a><img src="data:image/png;base64,AAA"><a href="//cdn.com/y">';
    expect(absolutizeHtml(html, base)).toBe(html);
  });

  it("URL base inválida devolve o HTML intacto em vez de estourar", () => {
    const html = '<img src="/a.png">';
    expect(absolutizeHtml(html, "não é url")).toBe(html);
  });

  it("valor malformado não derruba o restante", () => {
    const out = absolutizeHtml('<img src="ht tp://quebrado"><img src="/ok.png">', base);
    expect(out).toContain("https://exemplo.com/ok.png");
  });
});

describe("sanitizeForPreview", () => {
  /** O iframe entra sem permissão de script — a tag só engordaria o HTML. */
  it("remove script e base", () => {
    const html = '<base href="/x"><script>alert(1)</script><p>fica</p>';
    const out = sanitizeForPreview(html);
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<base");
    expect(out).toContain("<p>fica</p>");
  });

  it("script com atributo e maiúsculas também sai", () => {
    expect(sanitizeForPreview('<SCRIPT src="x.js"></SCRIPT>')).toBe("");
  });
});

describe("toHex", () => {
  it("converte rgb e rgba do navegador", () => {
    expect(toHex("rgb(17, 24, 39)")).toBe("#111827");
    expect(toHex("rgba(255, 0, 0, 0.5)")).toBe("#ff0000");
  });

  it("valor já hexadecimal passa direto", () => {
    expect(toHex("#abcdef")).toBe("#abcdef");
  });

  it("lixo vira preto em vez de quebrar o SVG", () => {
    expect(toHex("")).toBe("#000000");
    expect(toHex("rgb(a, b, c)")).toBe("#000000");
  });
});

describe("isTransparent", () => {
  it("reconhece as formas de transparente", () => {
    expect(isTransparent("rgba(0, 0, 0, 0)")).toBe(true);
    expect(isTransparent("transparent")).toBe(true);
    expect(isTransparent("")).toBe(true);
  });

  it("cor sólida não é transparente", () => {
    expect(isTransparent("rgb(255,255,255)")).toBe(false);
    expect(isTransparent("rgba(0,0,0,0.5)")).toBe(false);
  });
});

describe("snapshotToNode", () => {
  it("elemento com texto vira nó de texto com a cor da fonte", () => {
    const node = snapshotToNode(snap({ text: "Bem-vindo", color: "rgb(17, 24, 39)" }), "n1");
    expect(node).toMatchObject({ type: "text", text: "Bem-vindo", fill: "#111827", x: 10, y: 20 });
  });

  it("elemento com fundo vira retângulo, com raio quando houver", () => {
    const node = snapshotToNode(snap({ background: "rgb(37, 99, 235)", radius: 8 }), "n1");
    expect(node).toMatchObject({ type: "rect", fill: "#2563eb", radius: 8 });
  });

  /** Sem este filtro o canvas recebe milhares de div de layout sem pixel. */
  it("sem texto e sem fundo não vira nada", () => {
    expect(snapshotToNode(snap({ background: "rgba(0,0,0,0)" }), "n1")).toBeNull();
  });

  it("elemento minúsculo é descartado", () => {
    expect(snapshotToNode(snap({ w: 2, h: 100, text: "x" }), "n1")).toBeNull();
    expect(snapshotToNode(snap({ w: 100, h: 1 }), "n1")).toBeNull();
  });

  it("texto gigante é cortado para não travar o canvas", () => {
    const node = snapshotToNode(snap({ text: "a".repeat(1000) }), "n1");
    expect(node?.text?.length).toBe(240);
  });

  it("fonte inválida cai num tamanho legível", () => {
    const node = snapshotToNode(snap({ text: "x", fontSize: Number.NaN }), "n1");
    expect(node?.fontSize).toBe(14);
  });

  it("coordenadas são arredondadas — o canvas trabalha em inteiros", () => {
    const node = snapshotToNode(snap({ x: 10.7, y: 20.2, text: "x" }), "n1");
    expect(node).toMatchObject({ x: 11, y: 20 });
  });
});

describe("docFromSnapshots", () => {
  /** Mesmo empilhamento do navegador: fundo atrás do conteúdo. */
  it("ordena por profundidade, do mais raso ao mais fundo", () => {
    const doc = docFromSnapshots("Home", [
      snap({ depth: 3, text: "fundo" }),
      snap({ depth: 1, text: "raso" }),
      snap({ depth: 2, text: "meio" })
    ]);
    expect(doc.nodes.map((node) => node.text)).toEqual(["raso", "meio", "fundo"]);
  });

  it("respeita o teto de nós", () => {
    const muitos = Array.from({ length: MAX_NODES + 50 }, (_, i) => snap({ text: `t${i}`, depth: i }));
    const doc = docFromSnapshots("Grande", muitos);
    expect(doc.nodes).toHaveLength(MAX_NODES);
    expect(droppedCount(muitos, doc)).toBe(50);
  });

  it("descartados contam, para a UI poder avisar", () => {
    const entrada = [snap({ text: "vale" }), snap({ background: "rgba(0,0,0,0)" })];
    const doc = docFromSnapshots("X", entrada);
    expect(doc.nodes).toHaveLength(1);
    expect(droppedCount(entrada, doc)).toBe(1);
  });

  it("lista vazia devolve documento vazio com o nome", () => {
    const doc = docFromSnapshots("Vazio", []);
    expect(doc).toEqual({ name: "Vazio", nodes: [] });
  });

  it("ids são únicos e sequenciais", () => {
    const doc = docFromSnapshots("X", [snap({ text: "a" }), snap({ text: "b" })]);
    expect(doc.nodes.map((node) => node.id)).toEqual(["n1", "n2"]);
  });
});
