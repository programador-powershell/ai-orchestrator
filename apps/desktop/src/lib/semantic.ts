/**
 * Busca semântica na memória — vetores quando dá, morfologia sempre.
 *
 * A busca da memória era **léxica exata**: só encontrava quem repetisse a
 * mesma palavra. "como publico o sistema" não achava uma memória escrita como
 * "procedimento de deploy", e o usuário concluía que a memória não guardou
 * nada — o pior tipo de falha, porque é silenciosa.
 *
 * Aqui existem duas camadas, e as duas são reais:
 *
 * 1. **Vetores** do gateway (`/embeddings`), quando o workspace tem provedor
 *    com essa capacidade. É a semântica de verdade: aproxima por sentido.
 * 2. **Morfológica**, sempre disponível e sem rede: radicaliza a palavra
 *    (plural, `-ção`, `-mente`, `-ing`), pesa termo raro mais que termo comum
 *    (IDF) e compara por trigramas, o que segura erro de digitação.
 *
 * A camada 2 não é semântica de verdade e o módulo não finge que é — ela cobre
 * variação de forma, não de sentido. Mas ela roda offline e é o que impede a
 * memória de virar inútil quando o gateway não tem embeddings.
 *
 * Módulo puro: sem rede, sem DOM. Coberto por semantic.test.ts.
 */

/* ---------------------------- Radicalização ---------------------------- */

/**
 * Sufixos removidos, do mais longo para o mais curto — a ordem importa.
 *
 * `acao`/`acoes` vêm antes de `cao`/`coes` de propósito: é o que faz
 * "publicação" e "publicar" chegarem ao mesmo radical (`public`). Cortar só
 * `cao` pararia em "publica" e a consulta nominal não acharia o verbo.
 *
 * Não há `res` na lista: ele levaria o "r" junto e "servidores" viraria
 * "servido", que não bate com "servidor". Quem cobre o plural é `es`.
 */
const SUFIXOS = [
  "amentos",
  "imentos",
  "amento",
  "imento",
  "acoes",
  "icoes",
  "coes",
  "acao",
  "icao",
  "cao",
  "sao",
  "mente",
  "idade",
  "ismo",
  "ista",
  "ings",
  "ing",
  "ados",
  "adas",
  "ado",
  "ada",
  "eis",
  "ais",
  "ois",
  "es",
  "ed",
  "s",
  // Infinitivos por último: só cortam o que sobrou, e o piso de 4 impede
  // que "lugar" ou "fazer" percam a cauda.
  "ar",
  "er",
  "ir"
];

/** Tira acento e caixa; é o que faz "publicação" e "publicacao" baterem. */
export function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/**
 * Radical aproximado (PT + EN).
 *
 * Não é um Porter completo — é um corte de sufixo com piso de tamanho. O piso
 * existe porque radicalizar demais junta palavras que não têm relação: sem
 * ele, "casa" e "caso" virariam o mesmo token e a busca pioraria.
 */
export function stem(token: string): string {
  const base = normalize(token);
  if (base.length <= 4) return base;
  for (const sufixo of SUFIXOS) {
    if (base.length - sufixo.length >= 4 && base.endsWith(sufixo)) {
      return base.slice(0, base.length - sufixo.length);
    }
  }
  return base;
}

/** Palavras que aparecem em tudo e não distinguem nada. */
const VAZIAS = new Set([
  "para",
  "como",
  "que",
  "com",
  "dos",
  "das",
  "uma",
  "por",
  "sobre",
  "pelo",
  "pela",
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that"
]);

export function tokens(text: string): string[] {
  return normalize(text)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2 && !VAZIAS.has(token));
}

export function stems(text: string): string[] {
  return tokens(text).map(stem);
}

/* ------------------------------ Trigramas ------------------------------ */

export function trigrams(text: string): Set<string> {
  const base = ` ${normalize(text).replace(/[^a-z0-9]+/g, " ").trim()} `;
  const saida = new Set<string>();
  for (let i = 0; i + 3 <= base.length; i += 1) saida.add(base.slice(i, i + 3));
  return saida;
}

/**
 * Similaridade de Dice entre dois conjuntos de trigramas.
 *
 * É o que segura erro de digitação: "orquestardor" e "orquestrador" compartilham
 * quase todos os trigramas, embora nenhum token bata exatamente.
 */
export function diceSimilarity(a: string, b: string): number {
  const x = trigrams(a);
  const y = trigrams(b);
  if (!x.size || !y.size) return 0;
  let comum = 0;
  for (const item of x) if (y.has(item)) comum += 1;
  return (2 * comum) / (x.size + y.size);
}

/* --------------------------------- IDF --------------------------------- */

/**
 * Peso por raridade. Um termo presente em todos os documentos não diz nada
 * sobre qual deles interessa; um termo que só aparece num deles diz tudo.
 */
export function buildIdf(documents: readonly string[]): Map<string, number> {
  const total = Math.max(1, documents.length);
  const frequencia = new Map<string, number>();
  for (const documento of documents) {
    for (const radical of new Set(stems(documento))) {
      frequencia.set(radical, (frequencia.get(radical) ?? 0) + 1);
    }
  }
  const idf = new Map<string, number>();
  for (const [radical, contagem] of frequencia) {
    // +1 no numerador e no denominador: evita divisão por zero e mantém o
    // valor positivo mesmo para o termo presente em todos.
    idf.set(radical, Math.log((total + 1) / (contagem + 1)) + 1);
  }
  return idf;
}

/** A partir daqui dois radicais são considerados a mesma palavra mal digitada. */
const FUZZY_MIN = 0.62;
/** Quanto vale um casamento aproximado — menos que o exato, de propósito. */
const FUZZY_PESO = 0.6;

/**
 * Casamento aproximado de UM radical contra os do documento.
 *
 * A tolerância a erro de digitação precisa acontecer aqui, no token, e não na
 * comparação do texto inteiro: "prodicao" radicaliza para `prod` e "producao"
 * para `produ` — o erro mudou onde o sufixo termina. Comparando o documento
 * todo, essa diferença some no meio das outras palavras e a nota não sobe o
 * suficiente para o item aparecer.
 */
function fuzzyHit(radical: string, doDocumento: readonly string[]): boolean {
  for (const outro of doDocumento) {
    // Guarda barata: tamanhos muito diferentes nunca passariam do limiar, e
    // pular o cálculo de trigramas aqui evita o custo quadrático.
    if (Math.abs(outro.length - radical.length) > 3) continue;
    if (diceSimilarity(radical, outro) >= FUZZY_MIN) return true;
  }
  return false;
}

/**
 * Sobreposição de radicais pesada por IDF, normalizada pelo peso da consulta.
 * Devolve de 0 a 1.
 */
export function weightedOverlap(
  query: string,
  document: string,
  idf: Map<string, number>
): number {
  const daConsulta = [...new Set(stems(query))];
  if (!daConsulta.length) return 0;
  const listaDoc = [...new Set(stems(document))];
  const doDocumento = new Set(listaDoc);
  let total = 0;
  let casou = 0;
  for (const radical of daConsulta) {
    const peso = idf.get(radical) ?? 1;
    total += peso;
    if (doDocumento.has(radical)) casou += peso;
    else if (fuzzyHit(radical, listaDoc)) casou += peso * FUZZY_PESO;
  }
  return total > 0 ? casou / total : 0;
}

/* -------------------------------- Vetores ------------------------------- */

/** Cosseno entre dois vetores. Fora de tamanho ou nulo devolve 0. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let produto = 0;
  let normaA = 0;
  let normaB = 0;
  for (let i = 0; i < a.length; i += 1) {
    produto += a[i] * b[i];
    normaA += a[i] * a[i];
    normaB += b[i] * b[i];
  }
  if (normaA === 0 || normaB === 0) return 0;
  return produto / (Math.sqrt(normaA) * Math.sqrt(normaB));
}

/* ------------------------------ Pontuação ------------------------------ */

export interface SemanticInput {
  query: string;
  document: string;
  idf: Map<string, number>;
  /** Cosseno já calculado com o vetor do documento, quando existir. */
  vector?: number;
}

/**
 * Nota combinada, de 0 a 1.
 *
 * Quando há vetor ele domina (é a única camada que entende sentido), mas a
 * morfológica continua entrando: o vetor erra em nome próprio e identificador
 * de código, justamente onde a correspondência literal acerta.
 */
export function semanticScore(input: SemanticInput): number {
  const lexical = weightedOverlap(input.query, input.document, input.idf);
  const difuso = diceSimilarity(input.query, input.document);
  const semVetor = lexical * 0.75 + difuso * 0.25;
  if (input.vector === undefined) return semVetor;
  // O cosseno vem de -1 a 1; abaixo de zero não há relação nenhuma.
  const vetor = Math.max(0, input.vector);
  return vetor * 0.65 + semVetor * 0.35;
}

/** Texto que representa a memória para busca — título pesa por repetição. */
export function memoryText(item: { title: string; content: string; tags: string[] }): string {
  return `${item.title} ${item.title} ${item.content} ${item.tags.join(" ")}`;
}
