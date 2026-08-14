import { describe, expect, it } from "vitest";

import {
  buildImageFor,
  getLanguage,
  getStack,
  LANGUAGES,
  PACKAGE_ROOT_ONLY_EXCLUDES,
  runtimeImageFor,
  STACKS,
  STACK_IDS,
  STACK_ROOT_MARKERS,
  TRANSFER_EXCLUDES,
  type StackDefinition
} from "./stacks";
import { formatBuildEvent, generateDockerfile, parseBuildEvent, progressForStep } from "./dockerfile";

describe("registro de stacks", () => {
  it("trouxe o catálogo inteiro do port", () => {
    expect(STACK_IDS.length).toBeGreaterThanOrEqual(45);
    expect(Object.keys(LANGUAGES).length).toBeGreaterThanOrEqual(11);
  });

  it("toda stack aponta para uma linguagem que existe", () => {
    for (const [id, stack] of Object.entries(STACKS as Record<string, StackDefinition>)) {
      expect(getLanguage(stack.language), `stack ${id} → linguagem ${stack.language}`).toBeTruthy();
    }
  });

  it("toda stack tem porta e diretório de saída", () => {
    for (const [id, stack] of Object.entries(STACKS as Record<string, StackDefinition>)) {
      expect(typeof stack.outputDirectory, id).toBe("string");
      expect(stack.defaultPort, id).toBeGreaterThan(0);
    }
  });

  it("os casos que mais aparecem no dia estão certos", () => {
    // Não é teste de tautologia: são os valores que o pipeline usa de verdade,
    // e um erro de transcrição aqui manda o build para o diretório errado.
    expect(getStack("nextjs")?.outputDirectory).toBe(".next");
    expect(getStack("nextjs")?.defaultBuildCommand).toBe("next build");
    expect(getStack("nuxt")?.defaultStartCommand).toBe("node .output/server/index.mjs");
    expect(getStack("vite")?.defaultPort).toBe(5173);
    expect(getStack("astro")?.defaultPort).toBe(4321);
    expect(getStack("django")?.defaultStartCommand).toContain("gunicorn");
  });

  it("o Rails exige o Gemfile E um confirmador", () => {
    // A regra irregular do original: só `Gemfile` casaria com qualquer projeto
    // Ruby, e o Sinatra viraria Rails.
    const rails = getStack("rails");
    expect(rails?.detection?.rootMarkers).toContain("Gemfile");
    expect(rails?.detection?.rootMarkers).toContain("config/routes.rb");
  });

  it("o CRA se identifica pela dependência, não pelo layout", () => {
    // `public/` + `src/` é layout de meio mundo; `react-scripts` é o sinal.
    expect(getStack("cra")?.detection?.deps).toContain("react-scripts");
    expect(getStack("cra")?.detection?.rootMarkers).toBeUndefined();
  });

  it("o índice de marcadores cobre os arquivos-âncora conhecidos", () => {
    for (const marcador of ["next.config.js", "go.mod", "Cargo.toml", "manage.py", "Dockerfile", "artisan"]) {
      expect(STACK_ROOT_MARKERS.has(marcador), marcador).toBe(true);
    }
  });

  it("nunca transfere o que o install refaz do outro lado", () => {
    expect(TRANSFER_EXCLUDES).toContain("node_modules");
    expect(TRANSFER_EXCLUDES).toContain(".git");
    // `build` e `dist` também são podados, mas SÓ na raiz do pacote.
    expect(PACKAGE_ROOT_ONLY_EXCLUDES).toEqual(["build", "dist", "data"]);
  });

  it("nenhum logo de marca veio junto — e nenhuma URL para fora", () => {
    // O original trazia `STACK_ICONS` apontando para um CDN. Buscar logo de
    // marca lá fora entrega a um terceiro a lista de frameworks que o usuário
    // tem, quebra o app offline e depende de uma URL móvel (`@latest`).
    const bruto = JSON.stringify(STACKS);
    expect(bruto).not.toContain("jsdelivr");
    expect(bruto).not.toContain("devicon");
    // `http://0.0.0.0` é bind local do .NET, não busca de rede: o que não pode
    // aparecer é host de terceiro.
    const urls = bruto.match(/https?:\/\/[^"\\]+/g) ?? [];
    const externas = urls.filter((url) => !/^https?:\/\/(0\.0\.0\.0|127\.0\.0\.1|localhost)/.test(url));
    expect(externas).toEqual([]);
  });

  it("a imagem cai na da linguagem quando a stack não sobrescreve", () => {
    const nextjs = getStack("nextjs")!;
    expect(nextjs.buildImage).toBeUndefined();
    expect(buildImageFor(nextjs)).toBe(LANGUAGES.typescript.buildImage);
    expect(runtimeImageFor(nextjs)).toBe(LANGUAGES.typescript.runtimeImage);
  });
});

describe("Dockerfile gerado", () => {
  it("multi-estágio quando build e runtime diferem, e copia só o que produz", () => {
    const go = getStack("go")!;
    const saida = generateDockerfile({
      stack: go,
      installCommand: "go mod download",
      buildCommand: "go build -o app ."
    });
    expect(saida).toContain("AS builder");
    expect(saida).toContain("AS runtime");
    // `productionPaths` do Go é ["app"] — o binário, não a árvore inteira.
    expect(saida).toContain("COPY --from=builder /workspace/app /app/app");
    expect(saida).toContain("EXPOSE 8080");
  });

  it("estágio único quando as imagens são a mesma", () => {
    const saida = generateDockerfile({ stack: getStack("nextjs")!, buildCommand: "next build" });
    expect(saida).not.toContain("AS builder");
    expect(saida).toContain("EXPOSE 3000");
    expect(saida).toContain('CMD ["sh", "-c", "next start"]');
  });

  it("install e build ficam num RUN só, com as marcas de progresso", () => {
    const saida = generateDockerfile({
      stack: getStack("nextjs")!,
      installCommand: "npm ci",
      buildCommand: "next build"
    });
    const runs = saida.split("\n").filter((linha) => linha.startsWith("RUN "));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toContain("step=install status=running");
    expect(runs[0]).toContain("step=install status=completed");
    expect(runs[0]).toContain("step=build status=completed");
  });

  it("NO_COLOR entra sozinho e TERM fica de fora", () => {
    const saida = generateDockerfile({
      stack: getStack("nextjs")!,
      buildCommand: "next build",
      env: { TERM: "xterm-256color", API_URL: "https://exemplo" }
    });
    expect(saida).toContain("export NO_COLOR='1'");
    expect(saida).toContain("export API_URL='https://exemplo'");
    expect(saida).not.toContain("TERM=");
  });

  it("aspas simples no valor não escapam do shell", () => {
    const saida = generateDockerfile({
      stack: getStack("nextjs")!,
      buildCommand: "next build",
      env: { NOTA: "o'brien" }
    });
    expect(saida).toContain(`export NOTA='o'\\''brien'`);
  });

  it("subpasta de monorepo vira o WORKDIR do build", () => {
    const saida = generateDockerfile({
      stack: getStack("nextjs")!,
      sourceDir: "apps/web",
      buildCommand: "next build"
    });
    expect(saida).toContain("WORKDIR /workspace/apps/web");
  });

  it("sem comando de start não inventa CMD", () => {
    const saida = generateDockerfile({ stack: getStack("vite")!, buildCommand: "vite build" });
    expect(saida).not.toContain("CMD");
  });
});

describe("marcas de progresso", () => {
  it("a marca vai e volta", () => {
    const linha = formatBuildEvent("build", "completed");
    expect(parseBuildEvent(linha)).toEqual({ step: "build", status: "completed" });
  });

  it("linha comum não vira marca", () => {
    expect(parseBuildEvent("npm warn deprecated")).toBeNull();
    expect(parseBuildEvent("")).toBeNull();
  });

  it("o passo concluído vale dez pontos a mais", () => {
    expect(progressForStep("install")).toBe(30);
    expect(progressForStep("install", "completed")).toBe(40);
    expect(progressForStep("passo-que-nao-existe")).toBe(0);
  });
});
