/**
 * Gravar o Dockerfile no projeto — o passo que faltava entre "ver" e "usar".
 *
 * ## Por que o nome é fixo e o caminho é RELATIVO
 *
 * Na rota SSH, `fsWrite` cai em `ssh.write`, que **ignora o `root` local** e
 * resolve o caminho sob o `remoteWorkdir` do servidor. Do outro lado,
 * `safe_remote_path` recusa caminho absoluto, `~`, `:` e `..`. Um caminho
 * montado com a raiz do Windows (`C:\Users\...`) passa no ambiente local e
 * falha só em produção, contra o VPS — o pior lugar para descobrir.
 *
 * ## Por que não sobrescreve o `Dockerfile`
 *
 * Projeto que já tem `Dockerfile` tem uma decisão tomada, com as
 * particularidades que levaram alguém a escrevê-lo. O nosso vai para um nome
 * próprio, e quem constrói escolhe qual usar com `-f`.
 */

import { fsWrite } from "../fsx";

/** Nome do arquivo gerado. Fixo: o comando de build precisa saber qual é. */
export const DOCKERFILE_GERADO = "Dockerfile.multiplike";

/** Nome do arquivo que o projeto já trazia. */
export const DOCKERFILE_PROPRIO = "Dockerfile";

/**
 * Rejeita caminho que o outro lado recusaria.
 *
 * Escrito aqui e não só no Rust porque a falha remota volta como uma string de
 * erro genérica: validar antes transforma "PATH_UNSAFE" numa frase que diz o
 * que fazer.
 */
export function caminhoRelativoSeguro(caminho: string): boolean {
  if (!caminho || caminho !== caminho.trim()) return false;
  if (/^[/\\]/.test(caminho)) return false; // absoluto POSIX ou UNC
  if (/^[A-Za-z]:/.test(caminho)) return false; // absoluto Windows
  if (caminho.startsWith("~")) return false;
  if (caminho.split(/[/\\]/).includes("..")) return false;
  return true;
}

export interface ArtefatoGravado {
  /** Caminho relativo à raiz do projeto — é o que vai no `docker build -f`. */
  caminho: string;
  /** false quando o projeto já tinha Dockerfile e nada foi escrito. */
  gravado: boolean;
}

/**
 * Grava o Dockerfile gerado e devolve o caminho a usar no build.
 *
 * `jaTemProprio` vem do detector (`temDockerfileProprio`): nesse caso nada é
 * escrito e o caminho devolvido é o do projeto.
 */
export async function writeDockerfile(
  root: string,
  conteudo: string,
  opcoes: { jaTemProprio?: boolean } = {}
): Promise<ArtefatoGravado> {
  if (opcoes.jaTemProprio) {
    return { caminho: DOCKERFILE_PROPRIO, gravado: false };
  }
  if (!caminhoRelativoSeguro(DOCKERFILE_GERADO)) {
    // Defesa contra alguém trocar a constante por um caminho absoluto.
    throw new Error(`caminho de artefato inseguro: ${DOCKERFILE_GERADO}`);
  }
  // A quebra de linha final não é estética: ferramenta que lê linha a linha
  // costuma descartar a última quando ela não termina.
  const texto = conteudo.endsWith("\n") ? conteudo : `${conteudo}\n`;
  await fsWrite(root, DOCKERFILE_GERADO, texto);
  return { caminho: DOCKERFILE_GERADO, gravado: true };
}
