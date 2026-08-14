/*
 * ---------------------------------------------------------------------------
 * ARQUIVO DERIVADO — contém código de terceiro, sob Apache License 2.0.
 *
 * Origem: openship — https://github.com/oblien/openship
 *         versão 0.6.5, commit 8443f1e,
 *         arquivo `packages/adapters/src/runtime/docker-build-plan.ts`.
 *         Cópia da licença em `licenses/openship-Apache-2.0.txt`.
 *
 * MODIFICAÇÕES em relação ao original (exigidas pela §4b da licença):
 *  - reescrito como função PURA de string, sem as dependências do original;
 *  - o prefixo do marcador de progresso passou a ser deste produto;
 *  - as receitas de PHP/FrankenPHP e de site estático não foram portadas;
 *  - comentários reescritos em português.
 * ---------------------------------------------------------------------------
 */

import { buildImageFor, runtimeImageFor, type StackDefinition } from "./stacks";

/**
 * Prefixo que o build imprime para a interface saber em que passo está.
 *
 * O truque é do original e é bom: o Docker não expõe progresso de dentro de um
 * `RUN`, então o próprio comando imprime a marca e quem lê o log a reconhece.
 * Sem isso, `docker build` é uma caixa preta que fica minutos calada.
 */
export const BUILD_EVENT_PREFIX = "[multiplike-build]";

export type BuildStep = "clone" | "install" | "build" | "deploy";
export type BuildStepStatus = "running" | "completed" | "skipped";

export function formatBuildEvent(step: BuildStep, status: BuildStepStatus): string {
  return `${BUILD_EVENT_PREFIX} step=${step} status=${status}`;
}

/** Lê a marca de volta do log. Devolve `null` para linha que não é marca. */
export function parseBuildEvent(linha: string): { step: BuildStep; status: BuildStepStatus } | null {
  if (!linha.includes(BUILD_EVENT_PREFIX)) return null;
  const step = /step=([a-z]+)/.exec(linha)?.[1];
  const status = /status=([a-z]+)/.exec(linha)?.[1];
  if (!step || !status) return null;
  return { step: step as BuildStep, status: status as BuildStepStatus };
}

/**
 * Progresso de cada passo, em porcentagem.
 *
 * Transcrito do `STEP_PROGRESS` do original. Os números não são lineares de
 * propósito: instalar dependência leva mais tempo de relógio do que clonar, e
 * uma barra que anda em passos iguais mente sobre o que falta.
 */
export const STEP_PROGRESS: Readonly<Record<string, number>> = {
  prepare: 3,
  clone: 10,
  install: 30,
  build: 55,
  deploy: 80
};

export function progressForStep(step: string, status?: BuildStepStatus): number {
  const base = STEP_PROGRESS[step] ?? 0;
  return status === "completed" ? base + 10 : base;
}

export interface DockerfilePlan {
  stack: StackDefinition;
  /** Subpasta do projeto, quando é monorepo. Vazio = raiz. */
  sourceDir?: string;
  installCommand?: string;
  buildCommand?: string;
  startCommand?: string;
  port?: number;
  /** Variáveis do BUILD (não do runtime) — segredo não entra aqui. */
  env?: Readonly<Record<string, string>>;
}

/**
 * Variáveis que NÃO viajam para o build.
 *
 * `FORCE_COLOR` e `TERM` fazem a ferramenta imprimir sequências de escape num
 * log que ninguém vai renderizar como terminal — vira lixo no meio da saída.
 */
const ENV_FORA = new Set(["FORCE_COLOR", "TERM"]);
const NOME_DE_ENV_VALIDO = /^[A-Za-z_][A-Za-z0-9_]*$/;

function prefixoDeEnv(env: Readonly<Record<string, string>> | undefined): string {
  const entradas = Object.entries(env ?? {}).filter(
    ([chave]) => !ENV_FORA.has(chave) && NOME_DE_ENV_VALIDO.test(chave)
  );
  // `NO_COLOR` entra quando ninguém pediu o contrário: log de build é texto.
  if (!entradas.some(([chave]) => chave === "NO_COLOR")) entradas.push(["NO_COLOR", "1"]);
  if (!entradas.length) return "";
  return `${entradas.map(([chave, valor]) => `export ${chave}='${valor.replace(/'/g, "'\\''")}'`).join(" && ")} && `;
}

/**
 * As linhas de install e build, num `RUN` só, com as marcas de progresso.
 *
 * Um `RUN` por passo pareceria mais limpo e custaria uma layer commitada por
 * passo — em imagem de Node isso é centenas de megabytes gravados à toa.
 */
function linhaDePassos(plan: DockerfilePlan): string {
  const partes: string[] = [];
  const push = (comando: string, step: BuildStep) => {
    partes.push(`printf '${formatBuildEvent(step, "running")}\\n'`);
    partes.push(comando);
    partes.push(`printf '${formatBuildEvent(step, "completed")}\\n'`);
  };
  if (plan.installCommand) push(plan.installCommand, "install");
  if (plan.buildCommand) push(plan.buildCommand, "build");
  if (!partes.length) return "";
  return `RUN ${prefixoDeEnv(plan.env)}${partes.join(" && ")}`;
}

/**
 * Gera o Dockerfile do projeto.
 *
 * Multi-estágio quando a imagem de build difere da de runtime: compilar com o
 * SDK e servir com o runtime enxuto é a diferença entre uma imagem de 1,2 GB e
 * uma de 90 MB.
 */
export function generateDockerfile(plan: DockerfilePlan): string {
  const { stack } = plan;
  const buildImage = buildImageFor(stack);
  const runtimeImage = runtimeImageFor(stack);
  const multiEstagio = buildImage !== runtimeImage;
  const sourceDir = plan.sourceDir ? `/workspace/${plan.sourceDir}` : "/workspace";
  const porta = plan.port ?? stack.defaultPort;
  const start = plan.startCommand ?? stack.defaultStartCommand;

  const linhas: string[] = [];
  linhas.push(`# Gerado por Multiplike-AI para a stack "${stack.name}".`);
  linhas.push(multiEstagio ? `FROM ${buildImage} AS builder` : `FROM ${runtimeImage}`);
  linhas.push("WORKDIR /workspace");
  linhas.push("COPY . /workspace");
  if (plan.sourceDir) linhas.push(`WORKDIR ${sourceDir}`);

  const passos = linhaDePassos(plan);
  if (passos) linhas.push(passos);

  if (multiEstagio) {
    linhas.push(`FROM ${runtimeImage} AS runtime`);
    /*
     * `productionPaths` diz o que interessa levar. Sem ele, copiar a pasta
     * inteira arrasta `node_modules` de desenvolvimento e o código-fonte para
     * dentro da imagem que vai para produção.
     */
    if (stack.productionPaths?.length) {
      for (const caminho of stack.productionPaths) {
        linhas.push(`COPY --from=builder ${sourceDir}/${caminho} /app/${caminho}`);
      }
    } else {
      linhas.push(`COPY --from=builder ${sourceDir} /app`);
    }
    linhas.push("WORKDIR /app");
  }

  linhas.push(`EXPOSE ${porta}`);
  if (start) linhas.push(`CMD ["sh", "-c", ${JSON.stringify(start)}]`);
  return `${linhas.join("\n")}\n`;
}
