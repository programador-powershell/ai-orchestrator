/**
 * O plano do Dockerfile — onde os DOIS detectores se encontram.
 *
 * O app descobre a tecnologia de um projeto por dois caminhos, e cada um
 * responde metade da pergunta:
 *
 * - `stack.ts` diz a LINGUAGEM e os comandos do pipeline: `npm ci`,
 *   `pip install -r requirements.txt`, `cargo build --release`. Ele lê o
 *   lockfile e sabe qual gerenciador o projeto usa de verdade.
 * - `stacks.ts` (o port do openship) diz o FRAMEWORK: porta, pasta de saída,
 *   comando de start, imagem base, o que copiar para a imagem de runtime.
 *
 * Um projeto é "node" para o primeiro e "Next.js" para o segundo, ao mesmo
 * tempo. Nenhum dos dois sozinho monta um Dockerfile que funciona.
 *
 * ## O que estava faltando
 *
 * O painel montava o plano à mão com `{ stack, buildCommand, startCommand }` —
 * **sem `installCommand`**, porque quem sabe instalar é o outro detector. O
 * Dockerfile gerado rodava `next build` numa imagem sem `node_modules`: ele
 * não ficava "incompleto", ele quebrava no build, e o erro chegava como falha
 * do projeto e não como falha nossa.
 */

import { generateDockerfile, type DockerfilePlan } from "./dockerfile";
import type { DetectedStack } from "./stack";
import type { FrameworkDetectado } from "./stacks";

export interface OpcoesDoPlano {
  /** Subpasta do projeto, quando é monorepo. */
  sourceDir?: string;
  /** Porta, quando a pessoa sobrescreve a padrão do framework. */
  port?: number;
}

/**
 * Cruza os dois detectores num plano que o gerador aceita.
 *
 * A precedência de cada campo tem motivo:
 *
 * - **install** vem SÓ do `DetectedStack`. O framework não sabe se o projeto
 *   usa pnpm, yarn ou npm — quem leu o lockfile foi o outro.
 * - **build** prefere o do `DetectedStack` porque ele saiu dos scripts
 *   declarados no manifesto (`package.json`), que é o que o projeto realmente
 *   tem; o do framework é o padrão da ferramenta, usado como reserva.
 * - **start** vem do framework, que é quem conhece o artefato produzido
 *   (`node .output/server/index.mjs`, `gunicorn app.wsgi`).
 */
export function dockerfilePlanFrom(
  detectada: DetectedStack | undefined,
  framework: FrameworkDetectado,
  opcoes: OpcoesDoPlano = {}
): DockerfilePlan {
  const stack = framework.stack;
  return {
    stack,
    sourceDir: opcoes.sourceDir,
    installCommand: detectada?.commands.install || undefined,
    buildCommand: detectada?.commands.build || stack.defaultBuildCommand || undefined,
    startCommand: stack.defaultStartCommand || undefined,
    port: opcoes.port ?? stack.defaultPort,
    /*
     * Vazio, e é uma decisão: `DockerfilePlan.env` são variáveis de BUILD, que
     * ficam escritas no Dockerfile e portanto na imagem. Segredo não entra
     * aqui nunca — variável de runtime é do orquestrador do servidor.
     */
    env: {}
  };
}

/** Atalho: cruza os detectores e já devolve o arquivo. */
export function dockerfileFor(
  detectada: DetectedStack | undefined,
  framework: FrameworkDetectado,
  opcoes: OpcoesDoPlano = {}
): string {
  return generateDockerfile(dockerfilePlanFrom(detectada, framework, opcoes));
}

/**
 * O projeto traz o próprio Dockerfile?
 *
 * Nesse caso o certo é usar o dele. Gerar um por cima substituiria em silêncio
 * a decisão de quem escreveu — e o nosso não sabe nada das particularidades
 * que levaram alguém a escrever aquele.
 */
export function temDockerfileProprio(framework: FrameworkDetectado): boolean {
  return framework.stack.category === "docker";
}
