/**
 * O SITE ENTREGUE da sessão — sanitização e montagem do srcdoc da aba Site.
 *
 * O HTML que chega aqui saiu de um MODELO (o projeto que o bot construiu no
 * sandbox e a promoção entregou ao workspace). É texto que ninguém revisou, e
 * ele vai para dentro de um iframe na MESMA janela do app Tauri — a janela que
 * carrega a ponte para o sistema de arquivos e para os comandos do host.
 *
 * A defesa tem DUAS camadas, de propósito:
 *
 * 1. o iframe leva sandbox="" (vazio — nega script, formulário, popup,
 *    navegação do topo), a mesma decisão da prévia replicada do CanvasSurface;
 * 2. o HTML é SANEADO antes do srcdoc: <script>, handlers on* e URLs perigosas
 *    saem do texto. A camada 2 existe porque atributo de sandbox é UM ponto de
 *    falha (um refactor que troca o iframe, um copy/paste do srcdoc para outro
 *    lugar) — o teste tranca que script não sobrevive NO TEXTO, não só que o
 *    atributo está lá.
 *
 * A sanitização usa DOMParser, não regex: `<ScRiPt>`, atributo com espaço em
 * volta do `=`, tag não fechada — o parser normaliza tudo isso de graça, e é
 * exatamente onde sanitizador de regex historicamente falha. parseFromString
 * NÃO executa script nem carrega recurso durante o parse. Este módulo precisa
 * de DOM, então mora fora da fachada lib/canvas (que promete Node puro).
 */

/** Um CSS local do projeto que o index.html referencia, já lido do gateway. */
export interface EstiloDoSite {
  path: string;
  css: string;
}

/** Quantos <link rel="stylesheet"> locais a aba lê — cada um é um POST. */
export const TETO_DE_ESTILOS = 3;

/**
 * Elementos que saem INTEIROS do documento entregue:
 * - script: código; a razão de este módulo existir;
 * - iframe/frame/frameset/object/embed: conteúdo aninhado que escaparia da
 *   sanitização (o sandbox do pai não desce garantido para o que eles engolem);
 * - base: reescreve o destino de TODO link/recurso relativo do documento;
 * - link: busca recurso EXTERNO (folha de estilo, ícone) — a moldura promete
 *   "sem rede", e o CSS local do projeto entra inline pelo caminho controlado.
 */
const TAGS_PROIBIDAS = new Set(["script", "iframe", "frame", "frameset", "object", "embed", "base", "link"]);

/** Atributos que carregam URL — os únicos onde `javascript:` executa de fato. */
const ATRIBUTOS_DE_URL = new Set(["href", "src", "srcset", "action", "formaction", "poster", "background", "xlink:href", "data"]);

/**
 * URL que não pode sobreviver: esquema executável ou data: que embute
 * documento. `data:image/` fica — é como um site entregue embute o próprio
 * logo sem tocar a rede. Controles (\t\n\r) saem antes da comparação porque
 * `java\tscript:` é o truque clássico contra comparação ingênua.
 */
function urlPerigosa(valor: string): boolean {
  const limpo = valor.toLowerCase().replace(/[\s\u0000-\u001f]+/g, "");
  if (limpo.startsWith("javascript:") || limpo.startsWith("vbscript:")) return true;
  return limpo.startsWith("data:") && !limpo.startsWith("data:image/");
}

/**
 * Remove do documento (JÁ parseado) tudo que executa ou busca fora: as tags
 * proibidas, todo handler on* e toda URL perigosa. Muta o documento — é o
 * passo do meio de montarSiteEntregue e do cssLinksLocais não precisa.
 */
function sanearDocumento(doc: Document): void {
  // Snapshot em array: remover nós enquanto se itera um HTMLCollection vivo
  // pula elementos — o clássico "sanitizei metade".
  for (const elemento of [...doc.querySelectorAll("*")]) {
    if (TAGS_PROIBIDAS.has(elemento.tagName.toLowerCase())) {
      elemento.remove();
      continue;
    }
    for (const atributo of [...elemento.attributes]) {
      const nome = atributo.name.toLowerCase();
      // Todo on* sai, sem lista de nomes: onclick, onload, onpointerrawupdate…
      // a lista de eventos cresce a cada spec e uma allowlist ficaria velha.
      if (nome.startsWith("on")) {
        elemento.removeAttribute(atributo.name);
        continue;
      }
      // http-equiv cobre refresh (navegação) e set-cookie; nenhum tem lugar
      // numa moldura estática.
      if (nome === "http-equiv") {
        elemento.removeAttribute(atributo.name);
        continue;
      }
      if (ATRIBUTOS_DE_URL.has(nome) && urlPerigosa(atributo.value)) {
        elemento.removeAttribute(atributo.name);
      }
    }
  }
}

/**
 * Os <link rel="stylesheet"> LOCAIS do HTML entregue, na ordem, com teto.
 *
 * Só caminho relativo do projeto passa: URL com esquema, protocolo relativo
 * (`//cdn…`) e caminho absoluto são rede/fora do workspace, e `..` tentaria
 * escapar da pasta da sessão — o gateway recusaria, mas nem o pedido sai.
 */
export function cssLinksLocais(html: string): string[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const vistos = new Set<string>();
  const caminhos: string[] = [];
  for (const link of doc.querySelectorAll("link")) {
    const rel = (link.getAttribute("rel") ?? "").toLowerCase();
    if (!rel.split(/\s+/).includes("stylesheet")) continue;
    const href = (link.getAttribute("href") ?? "").trim();
    if (href === "" || href.startsWith("/") || href.startsWith("//")) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
    // A âncora/query não fazem parte do caminho no disco.
    const [caminho] = href.split(/[?#]/);
    if (caminho === undefined || caminho === "") continue;
    if (caminho.split(/[\\/]/).includes("..")) continue;
    if (vistos.has(caminho)) continue;
    vistos.add(caminho);
    caminhos.push(caminho);
    if (caminhos.length >= TETO_DE_ESTILOS) break;
  }
  return caminhos;
}

/**
 * O srcdoc da aba Site: o HTML entregue SANEADO, com os CSS locais do projeto
 * inline no <head> — o <link> original foi removido pela sanitização (link
 * busca rede), então o estilo volta pelo único caminho controlado: lido pelo
 * gateway (fs.read) e embutido como <style>.
 *
 * No CSS embutido, `</` vira `<\/` (escape legítimo de CSS): style é elemento
 * de texto cru, e um css com `</style><script>` no meio quebraria a cerca na
 * REPARSE do srcdoc — o iframe parseia o texto serializado de novo.
 */
export function montarSiteEntregue(html: string, estilos: EstiloDoSite[]): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  sanearDocumento(doc);
  for (const estilo of estilos) {
    const bloco = doc.createElement("style");
    bloco.setAttribute("data-origem", estilo.path);
    bloco.textContent = estilo.css.replace(/<\//g, "<\\/");
    doc.head.appendChild(bloco);
  }
  // O doctype entra na mão: outerHTML não o carrega, e sem ele o iframe
  // renderiza em quirks mode — layout entregue com medidas de 2001.
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}

/** O título do site entregue — o <title>, senão o primeiro <h1>, senão "". */
export function tituloDoSite(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const titulo = doc.title.trim();
  if (titulo !== "") return titulo;
  return doc.querySelector("h1")?.textContent?.trim() ?? "";
}
