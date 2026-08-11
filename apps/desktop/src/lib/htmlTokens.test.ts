import { describe, expect, it } from "vitest";
import { extractTokens } from "./htmlTokens";

describe("extractTokens — cores", () => {
  it("conta e ordena cores por frequência (desc)", () => {
    const { colors } = extractTokens(".a{color:#111}.b{color:#222}.c{color:#111}");
    expect(colors[0]).toEqual({ value: "#111", count: 2 });
    expect(colors[1]).toEqual({ value: "#222", count: 1 });
  });

  it("normaliza hex para minúsculas (mesma cor = mesma entrada)", () => {
    const { colors } = extractTokens("color:#ABCDEF; background:#abcdef;");
    expect(colors).toEqual([{ value: "#abcdef", count: 2 }]);
  });

  it("captura hex de 3, 4, 6 e 8 dígitos sem cortar pela metade", () => {
    const { colors } = extractTokens("#abc #abcd #a1b2c3 #a1b2c3d4");
    expect(colors.map((c) => c.value)).toEqual(expect.arrayContaining(["#abc", "#abcd", "#a1b2c3", "#a1b2c3d4"]));
    expect(colors).toHaveLength(4);
  });

  it("normaliza rgb/rgba/hsl/hsla removendo espaços", () => {
    const { colors } = extractTokens("color: rgb(10, 20, 30); border-color: RGB(10,20,30); background: hsla(200, 50%, 40%, .5)");
    expect(colors[0]).toEqual({ value: "rgb(10,20,30)", count: 2 });
    expect(colors[1].value).toBe("hsla(200,50%,40%,.5)");
  });

  it("empates preservam a ordem de aparição", () => {
    const { colors } = extractTokens("#111 #222 #333");
    expect(colors.map((c) => c.value)).toEqual(["#111", "#222", "#333"]);
  });
});

describe("extractTokens — fontes", () => {
  it("extrai famílias únicas, sem aspas, na ordem de aparição", () => {
    const source = `
      body { font-family: "Inter", Arial, sans-serif; }
      h1 { font-family: 'Playfair Display', serif; }
      p { font-family: Inter, sans-serif; }
    `;
    const { fonts } = extractTokens(source);
    expect(fonts).toEqual(["Inter", "Arial", "sans-serif", "Playfair Display", "serif"]);
  });

  it("funciona com style inline em HTML e ignora keywords/var()", () => {
    const source = '<div style="font-family: Roboto, var(--fallback), inherit">x</div>';
    const { fonts } = extractTokens(source);
    expect(fonts).toEqual(["Roboto"]);
  });
});

describe("extractTokens — espaçamento", () => {
  it("conta px/rem por frequência e ignora zero", () => {
    const source = ".a{padding:16px;margin:16px 8px;gap:1.5rem}.b{margin:0px;padding:16px}";
    const { spacing } = extractTokens(source);
    expect(spacing[0]).toEqual({ value: "16px", count: 3 });
    expect(spacing.map((s) => s.value)).toContain("1.5rem");
    expect(spacing.map((s) => s.value)).not.toContain("0px");
  });
});

describe("extractTokens — fonte real colada", () => {
  it("processa um trecho de página real (html + style + inline)", () => {
    const source = `
      <html><head><style>
        :root { --brand: #0ea5e9; }
        body { font-family: "Segoe UI", system-ui, sans-serif; color: #1f2937; background: #fff; }
        .btn { background: #0ea5e9; padding: 12px 24px; border-radius: 8px; color: rgba(255, 255, 255, 0.9); }
        .card { margin: 24px; padding: 24px; box-shadow: 0 4px 12px rgba(0,0,0,.1); }
      </style></head>
      <body><h1 style="font-family: Georgia, serif; color: #0ea5e9">Título</h1></body></html>
    `;
    const tokens = extractTokens(source);
    expect(tokens.colors[0]).toEqual({ value: "#0ea5e9", count: 3 });
    expect(tokens.fonts).toEqual(["Segoe UI", "system-ui", "sans-serif", "Georgia", "serif"]);
    expect(tokens.spacing[0]).toEqual({ value: "24px", count: 3 });
    expect(tokens.spacing.map((s) => s.value)).toContain("12px");
  });

  it("fonte vazia devolve listas vazias", () => {
    expect(extractTokens("")).toEqual({ colors: [], fonts: [], spacing: [] });
  });
});
