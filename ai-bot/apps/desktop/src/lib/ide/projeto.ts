/**
 * projeto — o vocabulário de arquivos da tela de Código, PURO.
 *
 * As ferramentas fs.* do gateway devolvem TEXTO (o consumidor original é o
 * modelo), e a tela precisa de estrutura. Este módulo é a tradução: parsers do
 * formato exato que o Go escreve (supervisor/tools.go), a coleta recursiva que
 * alimenta o Quick Open e a classificação de extensão que escolhe o ícone.
 * Nada aqui toca rede nem estado — é o que torna cada regra testável sem
 * gateway e sem React.
 */

export interface EntradaProjeto {
  name: string;
  /** Caminho relativo à raiz do projeto da sessão, com `/`. */
  path: string;
  isDir: boolean;
  /** Em bytes; 0 quando a listagem não informou. */
  size: number;
}

export interface OcorrenciaBusca {
  path: string;
  /** 1-based, como o gateway numera. */
  line: number;
  preview: string;
}

/**
 * O tamanho vem entre parênteses no fim da linha — `nome (123 bytes)` — e o
 * sufixo é removido para reconstruir o nome real. Ancorado no FIM porque um
 * arquivo pode se chamar `notas (2 bytes) finais.txt` no meio.
 */
const SUFIXO_TAMANHO = / \((\d+) bytes\)$/;

/**
 * `fs.list` devolve uma linha por entrada: `pasta/` para diretório,
 * `arquivo (N bytes)` para arquivo, `(pasta vazia)` quando não há nada.
 *
 * A ordenação (pastas primeiro, depois alfabética) é daqui, não do gateway:
 * o os.ReadDir do Go ordena por nome misturando os dois tipos, e uma árvore
 * que intercala pasta e arquivo é mais difícil de varrer com o olho.
 */
export function parseListagem(saida: string, base: string): EntradaProjeto[] {
  const entradas: EntradaProjeto[] = [];
  for (const linhaBruta of saida.split("\n")) {
    const linha = linhaBruta.replace(/\r$/, "");
    if (linha === "" || linha === "(pasta vazia)") continue;
    if (linha.endsWith("/")) {
      const name = linha.slice(0, -1);
      entradas.push({ name, path: base === "" ? name : `${base}/${name}`, isDir: true, size: 0 });
      continue;
    }
    const tamanho = SUFIXO_TAMANHO.exec(linha);
    const name = tamanho ? linha.slice(0, -tamanho[0].length) : linha;
    entradas.push({
      name,
      path: base === "" ? name : `${base}/${name}`,
      isDir: false,
      size: tamanho ? Number(tamanho[1]) : 0
    });
  }
  return entradas.sort((a, b) =>
    a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1
  );
}

/**
 * `fs.search` devolve `caminho/relativo:linha: trecho` por ocorrência, ou uma
 * frase de resumo ("nenhuma ocorrência de …") quando não achou nada.
 *
 * O caminho não contém `:` (o gateway converte para `/` e o caminho é relativo),
 * então o primeiro `:dígitos:` da linha é a fronteira — e linha que não casa
 * com o formato é descartada em silêncio: é resumo, não resultado.
 */
const LINHA_DE_BUSCA = /^(.+?):(\d+): ?(.*)$/;

export function parseBusca(saida: string): OcorrenciaBusca[] {
  const ocorrencias: OcorrenciaBusca[] = [];
  for (const linhaBruta of saida.split("\n")) {
    const linha = linhaBruta.replace(/\r$/, "");
    const casada = LINHA_DE_BUSCA.exec(linha);
    if (!casada) continue;
    const [, path, numero, preview] = casada;
    if (path === undefined || numero === undefined) continue;
    ocorrencias.push({ path, line: Number(numero), preview: preview ?? "" });
  }
  return ocorrencias;
}

/**
 * Pastas geradas/pesadas fora da coleta do Quick Open — o MESMO conjunto que o
 * fs.search do gateway pula, para as duas buscas enxergarem o mesmo projeto.
 */
export const PASTAS_IGNORADAS = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
  "build",
  ".next",
  "vendor",
  ".venv",
  "__pycache__"
]);

export interface LimitesColeta {
  /** Máximo de arquivos coletados (padrão 500). */
  maxEntries?: number;
  /** Profundidade máxima de diretórios (padrão 4; raiz = 0). */
  maxDepth?: number;
}

/**
 * Coleta recursiva (BFS) dos arquivos do projeto para o índice do Quick Open.
 *
 * Os limites existem porque cada nível é um POST no gateway: sem teto, um
 * monorepo profundo viraria centenas de chamadas na primeira abertura da
 * paleta. Erro na RAIZ sobe (sem raiz não há índice — a paleta mostra o
 * motivo); erro numa subpasta é pulado: uma pasta sem permissão não pode
 * derrubar o índice inteiro.
 */
export async function coletarArquivos(
  listar: (sub: string) => Promise<EntradaProjeto[]>,
  limites: LimitesColeta = {}
): Promise<EntradaProjeto[]> {
  const maxEntries = limites.maxEntries ?? 500;
  const maxDepth = limites.maxDepth ?? 4;
  const arquivos: EntradaProjeto[] = [];
  const fila: Array<{ sub: string; depth: number }> = [{ sub: "", depth: 0 }];
  while (fila.length > 0 && arquivos.length < maxEntries) {
    const atual = fila.shift();
    if (!atual) break;
    let entradas: EntradaProjeto[];
    try {
      entradas = await listar(atual.sub);
    } catch (causa) {
      if (atual.sub === "") throw causa;
      continue;
    }
    for (const entrada of entradas) {
      if (entrada.isDir) {
        if (atual.depth + 1 <= maxDepth && !PASTAS_IGNORADAS.has(entrada.name)) {
          fila.push({ sub: entrada.path, depth: atual.depth + 1 });
        }
        continue;
      }
      arquivos.push(entrada);
      if (arquivos.length >= maxEntries) break;
    }
  }
  return arquivos;
}

export function nomeBase(path: string): string {
  const partes = path.split(/[\\/]/);
  return partes[partes.length - 1] ?? path;
}

/**
 * A família do arquivo, para o ícone da árvore. É uma STRING, e não o ícone,
 * de propósito: a regra fica pura e testável em Node, e quem desenha (o rail)
 * decide qual componente Lucide cada família ganha.
 */
export type TipoDeArquivo =
  | "codigo"
  | "json"
  | "texto"
  | "estilo"
  | "imagem"
  | "dados"
  | "config"
  | "shell"
  | "outro";

const TIPO_POR_EXTENSAO: Record<string, TipoDeArquivo> = {
  ts: "codigo", tsx: "codigo", js: "codigo", jsx: "codigo", mjs: "codigo", cjs: "codigo",
  go: "codigo", rs: "codigo", py: "codigo", java: "codigo", cs: "codigo", php: "codigo",
  rb: "codigo", c: "codigo", h: "codigo", cpp: "codigo", hpp: "codigo",
  json: "json",
  md: "texto", markdown: "texto", txt: "texto", rst: "texto",
  css: "estilo", scss: "estilo", less: "estilo",
  png: "imagem", jpg: "imagem", jpeg: "imagem", gif: "imagem", svg: "imagem", webp: "imagem", ico: "imagem",
  sql: "dados", db: "dados", sqlite: "dados", csv: "dados", parquet: "dados",
  toml: "config", yaml: "config", yml: "config", ini: "config", conf: "config",
  env: "config", lock: "config", gitignore: "config", editorconfig: "config",
  sh: "shell", ps1: "shell", bat: "shell", cmd: "shell"
};

export function tipoDoArquivo(name: string): TipoDeArquivo {
  const ponto = name.lastIndexOf(".");
  // `.gitignore` e afins: o nome inteiro depois do ponto inicial É a extensão.
  const extensao = ponto >= 0 ? name.slice(ponto + 1).toLowerCase() : "";
  return TIPO_POR_EXTENSAO[extensao] ?? "outro";
}
