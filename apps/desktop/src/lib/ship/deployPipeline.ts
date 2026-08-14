/**
 * Os passos que transformam o build num ARTEFATO — a imagem.
 *
 * O pipeline de hoje termina em "empacotar": instala, constrói, testa. O que
 * sai disso é uma pasta na estação. Um deploy precisa de uma imagem, e a
 * imagem precisa de um Dockerfile — que o app já sabe gerar e até então só
 * exibia na tela.
 *
 * ## Uma linha por comando, sem `&&` e sem heredoc
 *
 * Os dois executores têm teto de 8.192 caracteres por comando, e o local roda
 * via `cmd.exe`, onde `&&` e here-doc não se comportam como no shell POSIX. Um
 * comando por passo também é o que faz o pipeline conseguir dizer QUAL passo
 * falhou — encadear três coisas num `&&` devolve um código de saída só.
 */

/** Caracteres aceitos numa tag/nome de imagem Docker. */
const INVALIDO = /[^a-z0-9._-]+/g;

/**
 * Nome de imagem a partir do nome do projeto.
 *
 * O Docker recusa maiúscula no nome do repositório e aceita um conjunto
 * estreito de símbolos. Um nome de pasta com espaço ou acento — que é comum —
 * faria o `docker build` falhar com uma mensagem sobre "invalid reference
 * format", que não diz a ninguém que o problema era o nome da pasta.
 */
export function nomeDeImagem(bruto: string): string {
  const limpo = bruto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(INVALIDO, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 60);
  return limpo || "app";
}

/**
 * Tag a partir da versão do ship (`V.1.2` → `1.2`).
 *
 * O prefixo `V.` é a convenção das notas de release deste repositório, não do
 * Docker — e uma tag começando com ponto é inválida.
 */
export function tagDeVersao(versao: string): string {
  const semPrefixo = versao.trim().replace(/^v\.?/i, "");
  const limpo = semPrefixo.replace(INVALIDO, "-").replace(/^[-._]+|[-._]+$/g, "").slice(0, 120);
  return limpo || "latest";
}

export interface OpcoesDaImagem {
  /** Nome do projeto — vira o nome da imagem. */
  projeto: string;
  /** Versão do ship (`V.1.2`). */
  versao: string;
  /** Caminho RELATIVO do Dockerfile, como `writeDockerfile` devolveu. */
  dockerfile: string;
  /** Contexto do build. Padrão `.` (a raiz do projeto). */
  contexto?: string;
}

export interface PassoDeDeploy {
  step: string;
  command: string;
}

/** A referência completa da imagem — `nome:tag`. */
export function referenciaDaImagem(opcoes: OpcoesDaImagem): string {
  return `${nomeDeImagem(opcoes.projeto)}:${tagDeVersao(opcoes.versao)}`;
}

/**
 * Os passos de imagem, na ordem.
 *
 * Hoje é um só. Fica como lista porque o próximo (enviar para um registry,
 * subir no servidor) entra aqui sem mudar quem chama — e porque o pipeline já
 * trabalha com lista de passos.
 */
export function deploySteps(opcoes: OpcoesDaImagem): PassoDeDeploy[] {
  const referencia = referenciaDaImagem(opcoes);
  const contexto = opcoes.contexto?.trim() || ".";
  return [
    {
      step: "Imagem",
      command: `docker build -f ${opcoes.dockerfile} -t ${referencia} ${contexto}`
    }
  ];
}
