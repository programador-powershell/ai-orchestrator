import { describe, expect, it, vi } from "vitest";

import { dockerfilePlanFrom, dockerfileFor, temDockerfileProprio } from "./plan";
import { deploySteps, nomeDeImagem, referenciaDaImagem, tagDeVersao } from "./deployPipeline";
import { caminhoRelativoSeguro, DOCKERFILE_GERADO, writeDockerfile } from "./artifacts";
import { detectarFrameworks, getStack } from "./stacks";
import { detectStacks } from "./stack";

vi.mock("../fsx", () => ({ fsWrite: vi.fn(async () => undefined) }));
const { fsWrite } = await import("../fsx");

/** Um projeto Next.js com pnpm, como os dois detectores o veem. */
function projetoNext() {
  const files = ["package.json", "pnpm-lock.yaml", "next.config.js", "src/app/page.tsx"];
  const manifests = {
    "package.json": JSON.stringify({
      name: "site",
      scripts: { build: "next build", start: "next start" },
      dependencies: { next: "15.0.0", react: "19.0.0" }
    })
  };
  return {
    detectada: detectStacks({ files, manifests })[0],
    framework: detectarFrameworks({ arquivos: files, manifestos: manifests })[0]
  };
}

describe("dockerfilePlanFrom — o cruzamento dos dois detectores", () => {
  it("o install vem do detector de LINGUAGEM, que leu o lockfile", () => {
    /*
     * Este é o defeito que o módulo existe para corrigir. O painel montava o
     * plano sem `installCommand`, porque quem sabe instalar é o outro
     * detector: o Dockerfile rodava `next build` numa imagem sem
     * `node_modules` e quebrava no build, com o erro parecendo do projeto.
     */
    const { detectada, framework } = projetoNext();
    const plano = dockerfilePlanFrom(detectada, framework);

    expect(plano.installCommand).toBeTruthy();
    expect(plano.installCommand).toContain("pnpm");

    const saida = dockerfileFor(detectada, framework);
    const run = saida.split("\n").find((linha) => linha.startsWith("RUN "))!;
    expect(run).toContain(plano.installCommand!);
    // E na ORDEM certa: instalar antes de construir.
    expect(run.indexOf(plano.installCommand!)).toBeLessThan(run.indexOf(plano.buildCommand!));
  });

  it("o build prefere o SCRIPT do projeto, não o padrão da ferramenta", () => {
    /*
     * `pnpm run build` e não `next build`: o script declarado no
     * `package.json` é o que o projeto realmente executa, e ele costuma
     * carregar coisa que o comando cru da ferramenta não faz (gerar cliente
     * de ORM, copiar asset, rodar codegen). O padrão do framework é reserva.
     */
    const { detectada, framework } = projetoNext();
    const plano = dockerfilePlanFrom(detectada, framework);
    expect(plano.buildCommand).toBe("pnpm run build");
    expect(framework.stack.defaultBuildCommand).toBe("next build");
  });

  it("a porta e o start vêm do FRAMEWORK, que conhece o artefato", () => {
    const { detectada, framework } = projetoNext();
    const plano = dockerfilePlanFrom(detectada, framework);
    expect(plano.port).toBe(3000);
    expect(plano.startCommand).toBe("next start");
  });

  it("sem detector de linguagem, o build cai no padrão do framework", () => {
    const { framework } = projetoNext();
    const plano = dockerfilePlanFrom(undefined, framework);
    expect(plano.installCommand).toBeUndefined();
    expect(plano.buildCommand).toBe("next build");
  });

  it("segredo não entra: `env` é de BUILD e fica escrito na imagem", () => {
    const { detectada, framework } = projetoNext();
    expect(dockerfilePlanFrom(detectada, framework).env).toEqual({});
  });

  it("projeto com Dockerfile próprio é reconhecido", () => {
    const framework = detectarFrameworks({ arquivos: ["Dockerfile", "LEIAME.md"] })[0];
    expect(temDockerfileProprio(framework)).toBe(true);
    const next = detectarFrameworks({
      arquivos: ["package.json", "next.config.js"],
      manifestos: { "package.json": JSON.stringify({ dependencies: { next: "15" } }) }
    })[0];
    expect(temDockerfileProprio(next)).toBe(false);
  });

  it("subpasta de monorepo atravessa até o WORKDIR", () => {
    const { detectada, framework } = projetoNext();
    expect(dockerfileFor(detectada, framework, { sourceDir: "apps/web" })).toContain(
      "WORKDIR /workspace/apps/web"
    );
  });
});

describe("nome e tag da imagem", () => {
  it("nome de pasta com acento e espaço vira referência válida", () => {
    // Sem isto o `docker build` falha com "invalid reference format", que não
    // diz a ninguém que o problema era o nome da pasta.
    expect(nomeDeImagem("Orçamento Web")).toBe("orcamento-web");
    expect(nomeDeImagem("MEU-APP")).toBe("meu-app");
    expect(nomeDeImagem("---")).toBe("app");
    expect(nomeDeImagem("")).toBe("app");
  });

  it("o prefixo V. das notas de release sai da tag", () => {
    // Tag começando com ponto é inválida no Docker.
    expect(tagDeVersao("V.1")).toBe("1");
    expect(tagDeVersao("V.1.2.3")).toBe("1.2.3");
    expect(tagDeVersao("v2")).toBe("2");
    expect(tagDeVersao("")).toBe("latest");
  });

  it("a referência junta os dois", () => {
    expect(referenciaDaImagem({ projeto: "Meu App", versao: "V.11", dockerfile: "x" })).toBe(
      "meu-app:11"
    );
  });
});

describe("deploySteps", () => {
  it("um comando por passo, sem && e sem heredoc", () => {
    /*
     * Os dois executores têm teto de 8.192 caracteres, e o local roda por
     * `cmd.exe`, onde `&&` e here-doc não se comportam como no POSIX. Um
     * comando por passo também é o que permite dizer QUAL passo falhou.
     */
    const passos = deploySteps({
      projeto: "site",
      versao: "V.11",
      dockerfile: DOCKERFILE_GERADO
    });
    expect(passos).toHaveLength(1);
    expect(passos[0].step).toBe("Imagem");
    expect(passos[0].command).toBe("docker build -f Dockerfile.orchestrator -t site:11 .");
    expect(passos[0].command).not.toContain("&&");
    expect(passos[0].command.length).toBeLessThan(8192);
  });

  it("o contexto é configurável e cai em `.`", () => {
    const passos = deploySteps({
      projeto: "site",
      versao: "V.1",
      dockerfile: "Dockerfile",
      contexto: "apps/web"
    });
    expect(passos[0].command).toContain(" apps/web");
  });
});

describe("writeDockerfile", () => {
  it("recusa caminho que o lado remoto recusaria", () => {
    /*
     * Na rota SSH o `root` local é IGNORADO e `safe_remote_path` recusa
     * absoluto, `~`, `:` e `..`. Um caminho com a raiz do Windows passa no
     * ambiente local e falha só contra o VPS — o pior lugar para descobrir.
     */
    expect(caminhoRelativoSeguro("Dockerfile.orchestrator")).toBe(true);
    expect(caminhoRelativoSeguro("apps/web/Dockerfile")).toBe(true);
    expect(caminhoRelativoSeguro("C:\\Users\\x\\Dockerfile")).toBe(false);
    expect(caminhoRelativoSeguro("/etc/Dockerfile")).toBe(false);
    expect(caminhoRelativoSeguro("~/Dockerfile")).toBe(false);
    expect(caminhoRelativoSeguro("../fora/Dockerfile")).toBe(false);
    expect(caminhoRelativoSeguro(" espaco")).toBe(false);
    expect(caminhoRelativoSeguro("")).toBe(false);
  });

  it("grava com quebra de linha final e devolve o caminho do build", async () => {
    vi.mocked(fsWrite).mockClear();
    const saida = await writeDockerfile("C:/proj", "FROM node:22\nEXPOSE 3000");
    expect(saida).toEqual({ caminho: "Dockerfile.orchestrator", gravado: true });
    expect(vi.mocked(fsWrite)).toHaveBeenCalledWith(
      "C:/proj",
      "Dockerfile.orchestrator",
      "FROM node:22\nEXPOSE 3000\n"
    );
  });

  it("NÃO sobrescreve o Dockerfile do projeto", async () => {
    vi.mocked(fsWrite).mockClear();
    const saida = await writeDockerfile("C:/proj", "qualquer coisa", { jaTemProprio: true });
    expect(saida).toEqual({ caminho: "Dockerfile", gravado: false });
    expect(vi.mocked(fsWrite)).not.toHaveBeenCalled();
  });
});
