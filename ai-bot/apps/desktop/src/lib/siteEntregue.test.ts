/**
 * A sanitização do site entregue — a camada de TEXTO da defesa dupla (a outra
 * é o sandbox="" do iframe, coberto no teste de tela da aba Site).
 *
 * As afirmações fortes usam REPARSE: o srcdoc montado é parseado de novo, como
 * o iframe faria, e o que se confere é o documento resultante — não uma busca
 * de substring que um `<ScRiPt>` disfarçado enganaria.
 */

import { describe, expect, it } from "vitest";
import { cssLinksLocais, montarSiteEntregue, TETO_DE_ESTILOS, tituloDoSite } from "./siteEntregue";

/** Reparseia como o iframe faria — a verdade é o documento, não a string. */
function reparse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

function temHandler(doc: Document): boolean {
  return [...doc.querySelectorAll("*")].some((elemento) =>
    [...elemento.attributes].some((atributo) => atributo.name.toLowerCase().startsWith("on"))
  );
}

describe("montarSiteEntregue", () => {
  it("script não sobrevive — nem tag, nem handler, nem URL executável, nem moldura aninhada", () => {
    const html = `<!doctype html><html><head><title>App</title>
      <script src="app.js"></script>
      <link rel="stylesheet" href="style.css">
      <base href="https://mal.example/">
    </head><body onload="alert(1)">
      <h1 OnClick = "roubar()" style="color:#123abc">Olá</h1>
      <a href="javascript:alert(2)">entrar</a>
      <a href="  Java\tScript:alert(3)">disfarçado com controle</a>
      <ScRiPt>alert(4)</ScRiPt>
      <iframe src="https://mal.example"></iframe>
      <img src="data:text/html,<script>x</script>" alt="doc embutido">
      <img src="data:image/png;base64,AAA" alt="logo">
    </body></html>`;

    const saida = montarSiteEntregue(html, []);
    const doc = reparse(saida);

    expect(doc.querySelector("script, iframe, object, embed, base, link")).toBeNull();
    expect(temHandler(doc)).toBe(false);
    expect(saida.toLowerCase()).not.toContain("javascript:");
    expect(saida).not.toContain("data:text/html");
    // O conteúdo legítimo fica: texto, estilo inline e imagem embutida.
    expect(saida).toContain("Olá");
    expect(saida).toContain("color:#123abc");
    expect(saida).toContain("data:image/png");
    // Doctype na frente — sem ele o iframe renderiza em quirks mode.
    expect(saida.startsWith("<!doctype html>")).toBe(true);
  });

  it("o CSS local entra inline — e um </style> malicioso no CSS não fura a cerca", () => {
    const saida = montarSiteEntregue("<html><head></head><body><p>x</p></body></html>", [
      { path: "style.css", css: "body { color: #123; }</style><script>alert(1)</script>" }
    ]);
    const doc = reparse(saida);

    const estilo = doc.querySelector('style[data-origem="style.css"]');
    expect(estilo).not.toBeNull();
    expect(estilo?.textContent).toContain("color: #123");
    // A reparse — o que o iframe faria — não produz script nenhum: o `</` do
    // CSS foi escapado e o fechamento falso morreu dentro do texto do style.
    expect(doc.querySelector("script")).toBeNull();
  });
});

describe("cssLinksLocais", () => {
  it("só caminho local relativo passa; rede, absoluto, travessia e não-stylesheet ficam de fora", () => {
    const html = `
      <link rel="stylesheet" href="style.css">
      <link rel="stylesheet" href="css/app.css?v=2">
      <link rel="stylesheet" href="https://cdn.example/x.css">
      <link rel="stylesheet" href="//cdn.example/y.css">
      <link rel="stylesheet" href="/absoluto.css">
      <link rel="stylesheet" href="../fora-do-projeto.css">
      <link rel="icon" href="favicon.ico">
      <link rel="stylesheet" href="style.css">
    `;
    // A query sai (não é caminho no disco), a duplicata some, o resto é recusado.
    expect(cssLinksLocais(html)).toEqual(["style.css", "css/app.css"]);
  });

  it("respeita o teto — cada folha é um POST no gateway", () => {
    const html = Array.from(
      { length: TETO_DE_ESTILOS + 3 },
      (_, indice) => `<link rel="stylesheet" href="folha-${indice}.css">`
    ).join("\n");
    expect(cssLinksLocais(html)).toHaveLength(TETO_DE_ESTILOS);
  });
});

describe("tituloDoSite", () => {
  it("lê o <title>; sem ele, o primeiro <h1>; sem nada, vazio", () => {
    expect(tituloDoSite("<title> Meu App </title>")).toBe("Meu App");
    expect(tituloDoSite("<body><h1>Só o h1</h1></body>")).toBe("Só o h1");
    expect(tituloDoSite("<p>nada de título</p>")).toBe("");
  });
});
