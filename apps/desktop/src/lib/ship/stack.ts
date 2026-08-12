/**
 * Detecção de stack — identifica a tecnologia do projeto pelos arquivos-âncora
 * e devolve os comandos reais de instalar/build/testar/rodar.
 *
 * Puro: recebe a lista de arquivos e o conteúdo de manifestos já lidos. Quem
 * chama faz o IO. Assim dá para testar cada stack sem tocar em disco.
 */

export type StackId =
  | "node"
  | "python"
  | "go"
  | "rust"
  | "php"
  | "ruby"
  | "java"
  | "dotnet"
  | "docker"
  | "static"
  | "unknown";

export interface StackCommands {
  install?: string;
  build?: string;
  test?: string;
  run?: string;
  /** Comando que produz o artefato distribuível, quando difere do build. */
  package?: string;
}

export interface DetectedStack {
  id: StackId;
  label: string;
  /** Arquivo que provou a detecção — mostrado na UI ("por quê"). */
  evidence: string;
  /** Gerenciador/variante identificada (pnpm, poetry, maven…). */
  variant?: string;
  commands: StackCommands;
  /** Confiança 0..1 — âncora forte (lockfile) vale mais que extensão solta. */
  confidence: number;
}

const has = (files: string[], name: string) => files.some((file) => file === name || file.endsWith(`/${name}`));

/** Gerenciador Node pelo lockfile — muda install/build de verdade. */
function nodeVariant(files: string[]): { variant: string; run: string } {
  if (has(files, "pnpm-lock.yaml")) return { variant: "pnpm", run: "pnpm" };
  if (has(files, "yarn.lock")) return { variant: "yarn", run: "yarn" };
  if (has(files, "bun.lockb")) return { variant: "bun", run: "bun" };
  return { variant: "npm", run: "npm" };
}

/** Scripts declarados no package.json — evita inventar comando que não existe. */
function nodeScripts(manifest: string | undefined): Set<string> {
  if (!manifest) return new Set();
  try {
    const parsed = JSON.parse(manifest) as { scripts?: Record<string, string> };
    return new Set(Object.keys(parsed.scripts ?? {}));
  } catch {
    return new Set();
  }
}

export interface DetectInput {
  files: string[];
  /** Conteúdo de manifestos já lidos (package.json, pyproject.toml…). */
  manifests?: Record<string, string>;
}

/**
 * Detecta as stacks presentes, da mais confiável para a menos. Um projeto pode
 * ter mais de uma (ex.: Node + Docker) — a UI mostra todas e o usuário escolhe.
 */
export function detectStacks(input: DetectInput): DetectedStack[] {
  const { files } = input;
  const manifests = input.manifests ?? {};
  const found: DetectedStack[] = [];

  if (has(files, "package.json")) {
    const { variant, run } = nodeVariant(files);
    const scripts = nodeScripts(manifests["package.json"]);
    found.push({
      id: "node",
      label: "Node.js",
      evidence: "package.json",
      variant,
      confidence: 0.95,
      commands: {
        install: `${run} install`,
        ...(scripts.has("build") ? { build: `${run} run build` } : {}),
        ...(scripts.has("test") ? { test: `${run} test` } : {}),
        ...(scripts.has("start") ? { run: `${run} start` } : scripts.has("dev") ? { run: `${run} run dev` } : {})
      }
    });
  }

  if (has(files, "pyproject.toml") || has(files, "requirements.txt") || has(files, "setup.py")) {
    const poetry = (manifests["pyproject.toml"] ?? "").includes("[tool.poetry]");
    const evidence = has(files, "pyproject.toml") ? "pyproject.toml" : has(files, "requirements.txt") ? "requirements.txt" : "setup.py";
    found.push({
      id: "python",
      label: "Python",
      evidence,
      variant: poetry ? "poetry" : "pip",
      confidence: 0.9,
      commands: poetry
        ? { install: "poetry install", test: "poetry run pytest", build: "poetry build" }
        : {
            install: has(files, "requirements.txt") ? "pip install -r requirements.txt" : "pip install -e .",
            test: "python -m pytest",
            build: "python -m build"
          }
    });
  }

  if (has(files, "go.mod")) {
    found.push({
      id: "go",
      label: "Go",
      evidence: "go.mod",
      confidence: 0.95,
      commands: { install: "go mod download", build: "go build ./...", test: "go test ./...", run: "go run ." }
    });
  }

  if (has(files, "Cargo.toml")) {
    found.push({
      id: "rust",
      label: "Rust",
      evidence: "Cargo.toml",
      confidence: 0.95,
      commands: { build: "cargo build --release", test: "cargo test", run: "cargo run", package: "cargo build --release" }
    });
  }

  if (has(files, "composer.json")) {
    found.push({
      id: "php",
      label: "PHP",
      evidence: "composer.json",
      variant: "composer",
      confidence: 0.9,
      commands: { install: "composer install", test: "composer test" }
    });
  }

  if (has(files, "Gemfile")) {
    found.push({
      id: "ruby",
      label: "Ruby",
      evidence: "Gemfile",
      variant: "bundler",
      confidence: 0.9,
      commands: { install: "bundle install", test: "bundle exec rspec" }
    });
  }

  if (has(files, "pom.xml") || has(files, "build.gradle") || has(files, "build.gradle.kts")) {
    const maven = has(files, "pom.xml");
    found.push({
      id: "java",
      label: "Java",
      evidence: maven ? "pom.xml" : "build.gradle",
      variant: maven ? "maven" : "gradle",
      confidence: 0.9,
      commands: maven
        ? { build: "mvn -B package", test: "mvn -B test", package: "mvn -B package" }
        : { build: "./gradlew build", test: "./gradlew test", package: "./gradlew assemble" }
    });
  }

  const csproj = files.find((file) => /\.(csproj|sln|fsproj)$/i.test(file));
  if (csproj) {
    found.push({
      id: "dotnet",
      label: ".NET",
      evidence: csproj.split("/").pop() ?? csproj,
      confidence: 0.9,
      commands: {
        install: "dotnet restore",
        build: "dotnet build -c Release",
        test: "dotnet test",
        package: "dotnet publish -c Release"
      }
    });
  }

  if (has(files, "Dockerfile") || has(files, "docker-compose.yml") || has(files, "compose.yaml")) {
    const compose = has(files, "docker-compose.yml") || has(files, "compose.yaml");
    found.push({
      id: "docker",
      label: "Docker",
      evidence: compose ? "docker-compose.yml" : "Dockerfile",
      variant: compose ? "compose" : "dockerfile",
      confidence: 0.85,
      commands: compose
        ? { build: "docker compose build", run: "docker compose up -d" }
        : { build: "docker build -t app .", run: "docker run --rm app", package: "docker build -t app ." }
    });
  }

  // Site estático só conta quando não há stack real — senão é o público do build.
  if (!found.length && has(files, "index.html")) {
    found.push({
      id: "static",
      label: "Site estático",
      evidence: "index.html",
      confidence: 0.5,
      commands: {}
    });
  }

  if (!found.length) {
    return [{ id: "unknown", label: "Não identificada", evidence: "", confidence: 0, commands: {} }];
  }

  return found.sort((a, b) => b.confidence - a.confidence);
}

/** Manifestos que vale a pena ler para refinar a detecção. */
export const MANIFEST_FILES = ["package.json", "pyproject.toml", "composer.json", "Cargo.toml"];

/** Etapas de um pipeline, na ordem, para a stack escolhida. */
export function pipelineFor(stack: DetectedStack): Array<{ step: string; command: string }> {
  const order: Array<[keyof StackCommands, string]> = [
    ["install", "Instalar dependências"],
    ["build", "Build"],
    ["test", "Testes"],
    ["package", "Empacotar"]
  ];
  return order
    .filter(([key]) => Boolean(stack.commands[key]))
    .map(([key, step]) => ({ step, command: stack.commands[key] as string }));
}
