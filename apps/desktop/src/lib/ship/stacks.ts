/*
 * ---------------------------------------------------------------------------
 * ARQUIVO DERIVADO — contém código de terceiro, sob Apache License 2.0.
 *
 * Origem: openship — https://github.com/oblien/openship
 *         versão 0.6.5, commit 8443f1e, arquivo `packages/core/src/stacks.ts`
 *         Licenciado sob a Apache License, Version 2.0.
 *         Cópia da licença em `licenses/openship-Apache-2.0.txt`.
 *
 * MODIFICAÇÕES em relação ao original (exigidas pela §4b da licença):
 *  - traduzido para os tipos deste projeto e reduzido ao que a aba Code usa
 *    (registro de stacks e linguagens; o resto do módulo original ficou fora);
 *  - removida a constante `STACK_ICONS`, que apontava para um CDN externo
 *    (`cdn.jsdelivr.net/gh/devicons/devicon@latest`): buscar logo de marca em
 *    CDN entrega a um terceiro a lista de frameworks que o usuário tem,
 *    quebra o app offline e depende de uma URL móvel (`@latest`);
 *  - comentários reescritos em português, junto do resto do repositório.
 *
 * Os DADOS (nome, imagem, comando de build, porta, regra de detecção de cada
 * stack) são transcritos do original: é conhecimento operacional acumulado —
 * saber que o Nuxt sai em `.output` e que o Rails precisa de `Gemfile` MAIS
 * `config/routes.rb` — e reescrever de cabeça só produziria uma versão pior.
 * ---------------------------------------------------------------------------
 */

/** Linguagem base — decide a imagem de build e as ferramentas exigidas. */
export interface LanguageDefinition {
  name: string;
  buildImage: string;
  runtimeImage: string;
  packageManagers: readonly string[];
  requiredTools: readonly string[];
}

/**
 * Sinais que denunciam a stack.
 *
 * `rootMarkers` é arquivo na raiz (aceita caminho aninhado, como
 * `config/routes.rb`); `deps` é dependência declarada no manifesto;
 * `contentPatterns` é regex dentro de um arquivo — o que separa Spring Boot
 * de Quarkus, já que os dois têm `pom.xml`.
 */
export interface StackDetection {
  rootMarkers?: readonly string[];
  deps?: readonly string[];
  contentPatterns?: Readonly<Record<string, string>>;
}

export type StackCategory = "frontend" | "backend" | "fullstack" | "static" | "docker" | "services" | "generic";

export interface StackDefinition {
  name: string;
  language: string;
  category: StackCategory;
  buildImage?: string;
  runtimeImage?: string;
  outputDirectory: string;
  defaultPort: number;
  defaultBuildCommand: string;
  defaultStartCommand: string;
  requiredToolVersions?: Readonly<Record<string, string>>;
  requiredTools?: readonly string[];
  /** O que copiar para a imagem de runtime depois do build. */
  productionPaths?: readonly string[];
  cacheDirs?: readonly string[];
  /** Escritos em runtime — viram volume, senão o deploy apaga o dado. */
  persistentPaths?: readonly string[];
  defaultBuildStrategy?: "server" | "local";
  detection?: StackDetection;
}

export const LANGUAGES = {
  javascript: {
    name: "JavaScript",
    buildImage: "node:22",
    runtimeImage: "node:22",
    packageManagers: ["npm", "yarn", "pnpm", "bun"],
    requiredTools: ["node", "npm"],
  },
  typescript: {
    name: "TypeScript",
    buildImage: "node:22",
    runtimeImage: "node:22",
    packageManagers: ["npm", "yarn", "pnpm", "bun"],
    requiredTools: ["node", "npm"],
  },
  go: {
    name: "Go",
    buildImage: "golang:1.22-alpine",
    runtimeImage: "alpine:3.19",
    packageManagers: ["go"],
    requiredTools: ["go"],
  },
  rust: {
    name: "Rust",
    buildImage: "rust:1.77-slim",
    runtimeImage: "debian:bookworm-slim",
    packageManagers: ["cargo"],
    requiredTools: ["rustc", "cargo"],
  },
  python: {
    name: "Python",
    buildImage: "python:3.12-slim",
    runtimeImage: "python:3.12-slim",
    packageManagers: ["pip", "poetry", "pipenv", "uv"],
    requiredTools: ["python3", "pip"],
  },
  ruby: {
    name: "Ruby",
    buildImage: "ruby:3.3-slim",
    runtimeImage: "ruby:3.3-slim",
    packageManagers: ["bundler"],
    requiredTools: ["ruby", "bundler"],
  },
  php: {
    name: "PHP",
    buildImage: "php:8.4-cli",
    // FrankenPHP, not php:*-fpm. An fpm image is a FastCGI backend, not a
    // process host: it ships no web server, and pairing it with an apt nginx
    // means two processes under a shell that swallows SIGTERM — a container stop
    // then kills in-flight work instead of draining it. FrankenPHP is ONE
    // process that owns both the HTTP server and PHP, so signals land where they
    // should with no supervision tree, it runs fine as a non-root user, and its
    // docroot convention (`/app/public`) is already the layout our recipes emit.
    runtimeImage: "dunglas/frankenphp:1-php8.4-bookworm",
    packageManagers: ["composer"],
    requiredTools: ["php", "composer"],
  },
  java: {
    name: "Java",
    // Maven image bundles both `mvn` and JDK 21, so the generated Dockerfile
    // builds Maven projects out of the box; Gradle/Kotlin projects build via
    // their `./gradlew` wrapper (needs only the JDK, which this image has).
    buildImage: "maven:3.9-eclipse-temurin-21",
    runtimeImage: "eclipse-temurin:21-jre-alpine",
    packageManagers: ["maven", "gradle"],
    requiredTools: ["java", "javac"],
  },
  csharp: {
    name: "C#",
    buildImage: "mcr.microsoft.com/dotnet/sdk:8.0",
    runtimeImage: "mcr.microsoft.com/dotnet/aspnet:8.0",
    packageManagers: ["dotnet"],
    requiredTools: ["dotnet"],
  },
  elixir: {
    name: "Elixir",
    buildImage: "elixir:1.16-alpine",
    runtimeImage: "elixir:1.16-alpine",
    packageManagers: ["mix"],
    requiredTools: ["elixir", "mix"],
  },
  multi: {
    name: "Multi-language",
    buildImage: "ubuntu:22.04",
    runtimeImage: "ubuntu:22.04",
    packageManagers: [],
    requiredTools: [],
  },
} as const satisfies Record<string, LanguageDefinition>;

export const STACKS = {

  // ── JavaScript / TypeScript - Frontend & Fullstack ─────────────────────────

  nextjs: {
    name: "Next.js",
    language: "typescript",
    category: "fullstack",
    outputDirectory: ".next",
    defaultPort: 3000,
    defaultBuildCommand: "next build",
    defaultStartCommand: "next start",
    requiredToolVersions: { node: "20.9.0" },
    cacheDirs: [".next/cache"],    detection: {
      rootMarkers: ["next.config.js", "next.config.mjs", "next.config.ts"],
      deps: ["next"],
    },
  },
  nuxt: {
    name: "Nuxt",
    language: "typescript",
    category: "fullstack",
    outputDirectory: ".output",
    defaultPort: 3000,
    defaultBuildCommand: "nuxt build",
    defaultStartCommand: "node .output/server/index.mjs",
    cacheDirs: [".nuxt"],    detection: {
      rootMarkers: ["nuxt.config.js", "nuxt.config.ts", "nuxt.config.mjs"],
      deps: ["nuxt", "@nuxt/core"],
    },
  },
  sveltekit: {
    name: "SvelteKit",
    language: "typescript",
    category: "fullstack",
    outputDirectory: ".svelte-kit",
    defaultPort: 3000,
    defaultBuildCommand: "vite build",
    defaultStartCommand: "node build/index.js",    detection: {
      rootMarkers: ["svelte.config.js", "svelte.config.mjs"],
      deps: ["svelte", "@sveltejs/kit"],
    },
  },
  remix: {
    name: "Remix",
    language: "typescript",
    category: "fullstack",
    outputDirectory: "build",
    defaultPort: 3000,
    defaultBuildCommand: "remix build",
    defaultStartCommand: "remix-serve build/index.js",    detection: {
      rootMarkers: ["remix.config.js", "remix.config.ts"],
      deps: ["@remix-run/react", "@remix-run/node", "remix"],
    },
  },
  "tanstack-start": {
    name: "TanStack Start",
    language: "typescript",
    category: "fullstack",
    outputDirectory: ".output",
    defaultPort: 3000,
    defaultBuildCommand: "vite build",
    defaultStartCommand: "node .output/server/index.mjs",
    // Nitro/Vinxi server bundle is self-contained under .output — same shape as Nuxt.
    productionPaths: [".output"],
    detection: {
      // TanStack Start is Vite/Rsbuild-based; app.config.* is the older
      // framework-specific marker, while current apps commonly ship vite.config.*
      // or rsbuild.config.* plus the start package dep.
      rootMarkers: [
        "app.config.ts",
        "app.config.js",
        "app.config.mjs",
        "vite.config.ts",
        "vite.config.js",
        "vite.config.mjs",
        "rsbuild.config.ts",
        "rsbuild.config.js",
        "rsbuild.config.mjs",
      ],
      deps: ["@tanstack/react-start", "@tanstack/start"],
    },
  },
  astro: {
    name: "Astro",
    language: "typescript",
    category: "frontend",
    outputDirectory: "dist",
    defaultPort: 4321,
    defaultBuildCommand: "astro build",
    defaultStartCommand: "node dist/server/entry.mjs",    detection: {
      rootMarkers: ["astro.config.mjs", "astro.config.js", "astro.config.ts"],
      deps: ["astro"],
    },
  },
  vite: {
    name: "Vite",
    language: "typescript",
    category: "frontend",
    outputDirectory: "dist",
    defaultPort: 5173,
    defaultBuildCommand: "vite build",
    defaultStartCommand: "",    detection: {
      rootMarkers: ["vite.config.js", "vite.config.ts", "vite.config.mjs"],
      deps: ["vite"],
    },
  },
  angular: {
    name: "Angular",
    language: "typescript",
    category: "frontend",
    outputDirectory: "dist",
    defaultPort: 4200,
    defaultBuildCommand: "ng build --configuration production",
    defaultStartCommand: "",    detection: {
      rootMarkers: ["angular.json"],
      deps: ["@angular/core"],
    },
  },
  gatsby: {
    name: "Gatsby",
    language: "javascript",
    category: "frontend",
    outputDirectory: "public",
    defaultPort: 8000,
    defaultBuildCommand: "gatsby build",
    defaultStartCommand: "gatsby serve",
    cacheDirs: [".cache"],    detection: {
      rootMarkers: ["gatsby-config.js", "gatsby-config.ts"],
      deps: ["gatsby"],
    },
  },
  cra: {
    name: "Create React App",
    language: "javascript",
    category: "frontend",
    outputDirectory: "build",
    defaultPort: 3000,
    defaultBuildCommand: "react-scripts build",
    defaultStartCommand: "",    detection: {
      // CRA's only durable signal is the react-scripts dep; the public+src
      // layout is shared with many other React setups.
      deps: ["react-scripts"],
    },
  },
  vue: {
    name: "Vue CLI",
    language: "javascript",
    category: "frontend",
    outputDirectory: "dist",
    defaultPort: 8080,
    defaultBuildCommand: "vue-cli-service build",
    defaultStartCommand: "",    detection: {
      rootMarkers: ["vue.config.js", "vue.config.ts"],
      // Note: deps gate is the disambiguator vs. Nuxt - checked in stack-detector.
      deps: ["vue"],
    },
  },
  react: {
    name: "React",
    language: "javascript",
    category: "frontend",
    outputDirectory: "build",
    defaultPort: 3000,
    defaultBuildCommand: "",
    defaultStartCommand: "",  },

  // ── JavaScript / TypeScript - Backend ──────────────────────────────────────

  express: {
    name: "Express",
    language: "javascript",
    category: "backend",
    outputDirectory: "dist",
    defaultPort: 3000,
    defaultBuildCommand: "",
    defaultStartCommand: "node index.js",    detection: {
      deps: ["express"],
    },
  },
  fastify: {
    name: "Fastify",
    language: "typescript",
    category: "backend",
    outputDirectory: "dist",
    defaultPort: 3000,
    defaultBuildCommand: "",
    defaultStartCommand: "node dist/index.js",    detection: {
      deps: ["fastify"],
    },
  },
  hono: {
    name: "Hono",
    language: "typescript",
    category: "backend",
    outputDirectory: "dist",
    defaultPort: 3000,
    defaultBuildCommand: "",
    defaultStartCommand: "node dist/index.js",    detection: {
      deps: ["hono"],
    },
  },
  nestjs: {
    name: "NestJS",
    language: "typescript",
    category: "backend",
    outputDirectory: "dist",
    defaultPort: 3000,
    defaultBuildCommand: "nest build",
    defaultStartCommand: "node dist/main.js",    detection: {
      rootMarkers: ["nest-cli.json"],
      deps: ["@nestjs/core"],
    },
  },
  koa: {
    name: "Koa",
    language: "javascript",
    category: "backend",
    outputDirectory: "dist",
    defaultPort: 3000,
    defaultBuildCommand: "",
    defaultStartCommand: "node index.js",    detection: {
      deps: ["koa"],
    },
  },
  adonis: {
    name: "AdonisJS",
    language: "typescript",
    category: "fullstack",
    outputDirectory: "build",
    defaultPort: 3333,
    defaultBuildCommand: "node ace build --production",
    defaultStartCommand: "node build/server.js",    detection: {
      rootMarkers: ["ace.js", ".adonisrc.json", "adonisrc.ts"],
      deps: ["@adonisjs/core"],
    },
  },
  elysia: {
    name: "Elysia",
    language: "typescript",
    category: "backend",
    outputDirectory: "dist",
    defaultPort: 3000,
    defaultBuildCommand: "",
    defaultStartCommand: "bun dist/index.js",    detection: {
      deps: ["elysia"],
    },
  },

  // ── Go ─────────────────────────────────────────────────────────────────────

  go: {
    name: "Go",
    language: "go",
    category: "backend",
    outputDirectory: ".",
    defaultPort: 8080,
    defaultBuildCommand: "go build -o app .",
    defaultStartCommand: "./app",
    productionPaths: ["app"],
    detection: {
      rootMarkers: ["go.mod"],
    },
  },
  gin: {
    name: "Gin",
    language: "go",
    category: "backend",
    outputDirectory: ".",
    defaultPort: 8080,
    defaultBuildCommand: "go build -o app .",
    defaultStartCommand: "./app",
    productionPaths: ["app"],
    detection: {
      rootMarkers: ["go.mod"],
      deps: ["github.com/gin-gonic/gin"],
    },
  },
  fiber: {
    name: "Fiber",
    language: "go",
    category: "backend",
    outputDirectory: ".",
    defaultPort: 3000,
    defaultBuildCommand: "go build -o app .",
    defaultStartCommand: "./app",
    productionPaths: ["app"],
    detection: {
      rootMarkers: ["go.mod"],
      deps: ["github.com/gofiber/fiber"],
    },
  },
  echo: {
    name: "Echo",
    language: "go",
    category: "backend",
    outputDirectory: ".",
    defaultPort: 8080,
    defaultBuildCommand: "go build -o app .",
    defaultStartCommand: "./app",
    productionPaths: ["app"],
    detection: {
      rootMarkers: ["go.mod"],
      deps: ["github.com/labstack/echo"],
    },
  },

  // ── Rust ───────────────────────────────────────────────────────────────────

  rust: {
    name: "Rust",
    language: "rust",
    category: "backend",
    outputDirectory: "target/release",
    defaultPort: 8080,
    defaultBuildCommand: "cargo build --release",
    defaultStartCommand: "./target/release/app",
    productionPaths: ["target/release/app"],
    detection: {
      rootMarkers: ["Cargo.toml"],
    },
  },
  actix: {
    name: "Actix Web",
    language: "rust",
    category: "backend",
    outputDirectory: "target/release",
    defaultPort: 8080,
    defaultBuildCommand: "cargo build --release",
    defaultStartCommand: "./target/release/app",
    productionPaths: ["target/release/app"],
    detection: {
      rootMarkers: ["Cargo.toml"],
      deps: ["actix-web"],
    },
  },
  axum: {
    name: "Axum",
    language: "rust",
    category: "backend",
    outputDirectory: "target/release",
    defaultPort: 3000,
    defaultBuildCommand: "cargo build --release",
    defaultStartCommand: "./target/release/app",
    productionPaths: ["target/release/app"],
    detection: {
      rootMarkers: ["Cargo.toml"],
      deps: ["axum"],
    },
  },
  rocket: {
    name: "Rocket",
    language: "rust",
    category: "backend",
    outputDirectory: "target/release",
    defaultPort: 8000,
    defaultBuildCommand: "cargo build --release",
    defaultStartCommand: "./target/release/app",
    productionPaths: ["target/release/app"],
    detection: {
      rootMarkers: ["Cargo.toml"],
      deps: ["rocket"],
    },
  },

  // ── Python ─────────────────────────────────────────────────────────────────

  python: {
    name: "Python",
    language: "python",
    category: "backend",
    outputDirectory: ".",
    defaultPort: 8000,
    defaultBuildCommand: "pip install -r requirements.txt",
    defaultStartCommand: "python app.py",
    detection: {
      rootMarkers: ["requirements.txt", "pyproject.toml", "Pipfile", "setup.py"],
    },
  },
  django: {
    name: "Django",
    language: "python",
    category: "fullstack",
    outputDirectory: ".",
    defaultPort: 8000,
    defaultBuildCommand: "pip install -r requirements.txt && python manage.py collectstatic --noinput",
    defaultStartCommand: "gunicorn config.wsgi:application --bind 0.0.0.0:8000",
    detection: {
      rootMarkers: ["manage.py"],
    },
  },
  flask: {
    name: "Flask",
    language: "python",
    category: "backend",
    outputDirectory: ".",
    defaultPort: 5000,
    defaultBuildCommand: "pip install -r requirements.txt",
    defaultStartCommand: "gunicorn app:app --bind 0.0.0.0:5000",
    detection: {
      rootMarkers: ["requirements.txt", "pyproject.toml", "Pipfile"],
      deps: ["flask", "Flask"],
    },
  },
  fastapi: {
    name: "FastAPI",
    language: "python",
    category: "backend",
    outputDirectory: ".",
    defaultPort: 8000,
    defaultBuildCommand: "pip install -r requirements.txt",
    defaultStartCommand: "uvicorn main:app --host 0.0.0.0 --port 8000",
    detection: {
      rootMarkers: ["requirements.txt", "pyproject.toml", "Pipfile"],
      deps: ["fastapi", "FastAPI"],
    },
  },

  // ── Ruby ───────────────────────────────────────────────────────────────────

  rails: {
    name: "Ruby on Rails",
    language: "ruby",
    category: "fullstack",
    outputDirectory: ".",
    defaultPort: 3000,
    defaultBuildCommand: "bundle install && bundle exec rails assets:precompile",
    defaultStartCommand: "bundle exec rails server -b 0.0.0.0",
    detection: {
      // Rails: Gemfile is required; bin/rails or config/routes.rb confirms.
      // The conjunction is encoded as an override in stack-detector.
      rootMarkers: ["Gemfile", "bin/rails", "config/routes.rb"],
    },
  },
  sinatra: {
    name: "Sinatra",
    language: "ruby",
    category: "backend",
    outputDirectory: ".",
    defaultPort: 4567,
    defaultBuildCommand: "bundle install",
    defaultStartCommand: "ruby app.rb",
    detection: {
      rootMarkers: ["Gemfile"],
      deps: ["sinatra"],
    },
  },

  // ── PHP ────────────────────────────────────────────────────────────────────

  // PHP stacks serve `public/` from FrankenPHP (see LANGUAGES.php). `exec` hands
  // the container's PID to frankenphp so SIGTERM drains in-flight requests
  // instead of being swallowed by the shell; SERVER_NAME carries the injected
  // $PORT (a bare `:port` also keeps Caddy's automatic HTTPS out of the way —
  // TLS terminates at the edge). No build command: `composer install` is the
  // INSTALL step, and the build step is where a JS asset pipeline goes (the
  // detector fills it in when the repo has one).
  laravel: {
    name: "Laravel",
    language: "php",
    category: "fullstack",
    outputDirectory: "public",
    defaultPort: 8000,
    defaultBuildCommand: "",
    defaultStartCommand:
      'SERVER_NAME=":$PORT" exec frankenphp run --config /etc/frankenphp/Caddyfile --adapter caddyfile',
    // Everything a stock Laravel app writes lives here: uploads
    // (storage/app), sessions + cache when the drivers are `file`, and the
    // framework's own scratch space. `database/` is deliberately NOT persisted —
    // it holds migrations, so mounting over it would hide the ones a later
    // release adds. A SQLite app should point DB_DATABASE at a persisted path or
    // (better) use a database service.
    persistentPaths: ["storage"],
    detection: {
      rootMarkers: ["artisan", "composer.json"],
      deps: ["laravel/framework"],
    },
  },
  symfony: {
    name: "Symfony",
    language: "php",
    category: "fullstack",
    outputDirectory: "public",
    defaultPort: 8000,
    defaultBuildCommand: "",
    defaultStartCommand:
      'SERVER_NAME=":$PORT" exec frankenphp run --config /etc/frankenphp/Caddyfile --adapter caddyfile',
    // No persistentPaths: Symfony's `var/` is cache + logs, both regenerated,
    // and it has no convention for where user uploads land.
    detection: {
      rootMarkers: ["composer.json", "symfony.lock"],
      deps: ["symfony/framework-bundle"],
    },
  },

  // ── Java / JVM ─────────────────────────────────────────────────────────────

  springboot: {
    name: "Spring Boot",
    language: "java",
    category: "backend",
    outputDirectory: "target",
    defaultPort: 8080,
    defaultBuildCommand: "mvn clean package -DskipTests",
    defaultStartCommand: "java -jar target/*.jar",
    productionPaths: ["target"],    // Predominantly a Maven stack; bare-metal builds need `mvn` ensured. Gradle
    // Spring Boot projects still build via their `./gradlew` wrapper (JDK-only).
    requiredTools: ["java", "javac", "maven"],
    detection: {
      rootMarkers: ["pom.xml", "build.gradle", "build.gradle.kts"],
      deps: ["org.springframework.boot:spring-boot-starter-web", "spring-boot"],
      contentPatterns: {
        "pom.xml": "spring[-.]boot",
        "build.gradle": "spring[-.]boot",
        "build.gradle.kts": "spring[-.]boot",
      },
    },
  },
  quarkus: {
    name: "Quarkus",
    language: "java",
    category: "backend",
    outputDirectory: "target",
    defaultPort: 8080,
    defaultBuildCommand: "mvn clean package -DskipTests",
    defaultStartCommand: "java -jar target/quarkus-app/quarkus-run.jar",
    productionPaths: ["target"],    requiredTools: ["java", "javac", "maven"],
    detection: {
      rootMarkers: ["pom.xml", "build.gradle", "build.gradle.kts"],
      deps: ["io.quarkus:quarkus-core", "quarkus"],
      contentPatterns: {
        "pom.xml": "io\\.quarkus",
        "build.gradle": "io\\.quarkus",
        "build.gradle.kts": "io\\.quarkus",
      },
    },
  },

  // ── Kotlin (JVM, Gradle) ─────────────────────────────────────────────────
  // Plain Kotlin/JVM services (Ktor, http4k, or a bare `main`). A Kotlin *Spring
  // Boot* project still matches `springboot` first (its content pattern wins in
  // the rule order), so this catches Kotlin projects that aren't Spring/Quarkus.

  kotlin: {
    name: "Kotlin",
    language: "java",
    category: "backend",
    outputDirectory: "build/libs",
    defaultPort: 8080,
    defaultBuildCommand: "gradle build -x test",
    defaultStartCommand: "java -jar build/libs/*.jar",
    productionPaths: ["build/libs"],    // Gradle-based; bare-metal builds need `gradle` ensured (or the `./gradlew`
    // wrapper, which the detector prefers when present).
    requiredTools: ["java", "javac", "gradle"],
    detection: {
      rootMarkers: ["build.gradle.kts", "build.gradle"],
      contentPatterns: {
        "build.gradle.kts": "kotlin\\s*\\(|org\\.jetbrains\\.kotlin",
        "build.gradle": "org\\.jetbrains\\.kotlin|kotlin[- ]",
      },
    },
  },

  // ── C# / .NET ──────────────────────────────────────────────────────────────

  dotnet: {
    name: ".NET",
    language: "csharp",
    category: "backend",
    // Build runs `dotnet publish -c Release -o publish`, so the artifact is ./publish.
    outputDirectory: "publish",
    defaultPort: 5000,
    defaultBuildCommand: "dotnet publish -c Release -o publish",
    // .NET reads ASPNETCORE_URLS (not $PORT) and defaults to :8080, so bind it
    // explicitly to the injected port. The detector rewrites `app.dll` to the
    // real assembly name (from the .csproj); `app` is the fallback.
    defaultStartCommand: "ASPNETCORE_URLS=http://0.0.0.0:$PORT dotnet publish/app.dll",
    productionPaths: ["publish"],
    detection: {
      // .csproj/.fsproj/.sln are detected by suffix; rootMarkers is decorative
      // here since the suffix-match lives in stack-detector.
    },
  },
  blazor: {
    name: "Blazor",
    language: "csharp",
    // Blazor WebAssembly compiles to a static bundle under publish/wwwroot —
    // it's served as files, not a running server (Blazor Server folds into `dotnet`).
    category: "static",
    outputDirectory: "publish/wwwroot",
    defaultPort: 5000,
    defaultBuildCommand: "dotnet publish -c Release -o publish",
    defaultStartCommand: "",
    productionPaths: ["publish/wwwroot"],
    detection: {
      deps: ["Microsoft.AspNetCore.Components.WebAssembly"],
    },
  },

  // ── Elixir ─────────────────────────────────────────────────────────────────

  phoenix: {
    name: "Phoenix",
    language: "elixir",
    category: "fullstack",
    outputDirectory: "_build/prod/rel",
    defaultPort: 4000,
    defaultBuildCommand: "MIX_ENV=prod mix do deps.get, compile, assets.deploy, release",
    defaultStartCommand: "_build/prod/rel/app/bin/app start",
    productionPaths: ["_build/prod/rel"],
    detection: {
      rootMarkers: ["mix.exs"],
      deps: ["phoenix"],
    },
  },

  // ── Generic ────────────────────────────────────────────────────────────────

  node: {
    name: "Node.js",
    language: "javascript",
    category: "backend",
    outputDirectory: "dist",
    defaultPort: 3000,
    defaultBuildCommand: "",
    defaultStartCommand: "node index.js",    detection: {
      rootMarkers: ["package.json"],
    },
  },
  static: {
    name: "Static Site",
    language: "multi",
    category: "static",
    buildImage: "node:22",
    outputDirectory: ".",
    defaultPort: 3000,
    defaultBuildCommand: "",
    defaultStartCommand: "",    detection: {
      rootMarkers: ["index.html"],
    },
  },
  docker: {
    name: "Dockerfile",
    language: "multi",
    category: "docker",
    outputDirectory: ".",
    defaultPort: 3000,
    defaultBuildCommand: "",
    defaultStartCommand: "",
    detection: {
      rootMarkers: ["Dockerfile"],
    },
  },
  "docker-compose": {
    name: "Docker Compose",
    language: "multi",
    category: "services",
    outputDirectory: ".",
    defaultPort: 3000,
    defaultBuildCommand: "",
    defaultStartCommand: "",
    detection: {
      rootMarkers: ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"],
    },
  },
  unknown: {
    name: "Unknown",
    language: "multi",
    category: "generic",
    outputDirectory: "dist",
    defaultPort: 3000,
    defaultBuildCommand: "",
    defaultStartCommand: "",
  },

  // ── Opinionated openship installs (commands fixed by the runner) ───────────

  webmail: {
    name: "Webmail",
    language: "typescript",
    category: "fullstack",
    outputDirectory: "client/build",
    defaultPort: 4080,
    defaultBuildCommand: "bun run build",
    defaultStartCommand: "bun run src/main.ts",
    // Runs on bun, not node - the toolchain layer installs bun from the catalog.
    requiredTools: ["bun"],
    requiredToolVersions: { bun: "1.2.0" },
  },
} as const satisfies Record<string, StackDefinition>;


export type StackId = keyof typeof STACKS;
export type LanguageId = keyof typeof LANGUAGES;

export const STACK_IDS = Object.keys(STACKS) as StackId[];

/**
 * Todo `rootMarker` conhecido, em minúsculas.
 *
 * Serve para varrer a pasta UMA vez e perguntar "este arquivo interessa a
 * alguém?", em vez de rodar 47 regras contra cada entrada do diretório.
 */
export const STACK_ROOT_MARKERS: ReadonlySet<string> = new Set(
  Object.values(STACKS).flatMap((stack) => [...((stack as StackDefinition).detection?.rootMarkers ?? [])])
);

/**
 * O que NUNCA sobe junto do código-fonte.
 *
 * Mandar `node_modules` para o servidor é transferir centenas de megabytes
 * do que o `install` vai refazer do outro lado.
 */
export const TRANSFER_EXCLUDES: readonly string[] = [
  ".git",
  "node_modules",
  "vendor",
  ".next",
  ".vite",
  ".turbo",
  ".cache",
  ".react-router",
  ".nuxt",
  ".svelte-kit",
  ".astro",
  ".output",
  ".nx",
  "dist",
  "build",
  "data"
];

/**
 * Podados só na RAIZ do pacote.
 *
 * Casar `build`/`dist` por nome em qualquer profundidade apagaria pasta de
 * fonte legítima — `src/build/` existe em projeto que ninguém imagina.
 */
export const PACKAGE_ROOT_ONLY_EXCLUDES: readonly string[] = ["build", "dist", "data"];

export function getStack(id: string): StackDefinition | undefined {
  return (STACKS as Record<string, StackDefinition>)[id];
}

export function getLanguage(id: string): LanguageDefinition | undefined {
  return (LANGUAGES as Record<string, LanguageDefinition>)[id];
}

/** Imagem de build da stack, caindo na da linguagem quando ela não sobrescreve. */
export function buildImageFor(stack: StackDefinition): string {
  return stack.buildImage ?? getLanguage(stack.language)?.buildImage ?? "ubuntu:22.04";
}

export function runtimeImageFor(stack: StackDefinition): string {
  return stack.runtimeImage ?? getLanguage(stack.language)?.runtimeImage ?? "ubuntu:22.04";
}

/* ------------------------- detecção do framework ------------------------ */

export interface FrameworkDetectado {
  id: StackId;
  stack: StackDefinition;
  /** O que provou a detecção — a UI mostra o "por quê". */
  evidencia: string;
  /** 0..1. Marcador de raiz vale mais que dependência solta no manifesto. */
  confianca: number;
}

export interface EntradaDeDeteccao {
  /** Caminhos relativos à raiz, com "/" — como `collectFiles` devolve. */
  arquivos: readonly string[];
  /** Conteúdo dos manifestos já lidos, por nome de arquivo. */
  manifestos?: Readonly<Record<string, string>>;
}

/**
 * Categorias mais específicas ganham no empate.
 *
 * `nextjs` e `react` casam no mesmo projeto: os dois veem `react` nas
 * dependências. Quem responde a pergunta "como isto sobe?" é o framework
 * (fullstack), não a biblioteca de UI (frontend) — por isso o peso.
 */
const PESO_DA_CATEGORIA: Readonly<Record<StackCategory, number>> = {
  fullstack: 5,
  backend: 4,
  services: 3,
  frontend: 2,
  static: 1,
  docker: 1,
  generic: 0
};

/** Nomes de dependência declarados no manifesto, seja qual for o ecossistema. */
function dependenciasDeclaradas(manifestos: Readonly<Record<string, string>>): Set<string> {
  const nomes = new Set<string>();

  const packageJson = manifestos["package.json"];
  if (packageJson) {
    try {
      const parsed = JSON.parse(packageJson) as Record<string, Record<string, string> | undefined>;
      for (const campo of ["dependencies", "devDependencies", "peerDependencies"]) {
        for (const nome of Object.keys(parsed[campo] ?? {})) nomes.add(nome);
      }
    } catch {
      // manifesto quebrado não derruba a detecção: os marcadores de raiz
      // continuam valendo
    }
  }

  /*
   * Nos outros ecossistemas o manifesto não é JSON, e escrever um parser de
   * TOML/YAML aqui seria desproporcional: o que interessa é se o NOME aparece
   * declarado. A borda `[^\w-]` evita que "django" case dentro de
   * "django-extensions" e vice-versa.
   */
  for (const [arquivo, conteudo] of Object.entries(manifestos)) {
    if (arquivo === "package.json") continue;
    for (const stack of Object.values(STACKS) as StackDefinition[]) {
      for (const dep of stack.detection?.deps ?? []) {
        if (nomes.has(dep)) continue;
        const escapada = dep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (new RegExp(`(^|[^\\w-])${escapada}([^\\w-]|$)`, "m").test(conteudo)) nomes.add(dep);
      }
    }
  }

  return nomes;
}

/**
 * Identifica o framework do projeto pelos sinais declarados em `STACKS`.
 *
 * Complementa `stack.ts`, não substitui: lá se descobre a LINGUAGEM e os
 * comandos do pipeline (instalar, testar, empacotar); aqui se descobre o
 * FRAMEWORK, que é quem sabe a porta, a pasta de saída, o comando de start e a
 * imagem base — o que o `generateDockerfile` precisa. Um projeto é "node" para
 * o pipeline e "Next.js" para o container ao mesmo tempo.
 *
 * Devolve a lista ordenada por confiança; vazia quando nada casa. `docker` e
 * `static` só aparecem se nada mais casar — um projeto Next.js com Dockerfile
 * é Next.js, e o marcador `index.html` existe em quase toda pasta `public`.
 */
export function detectarFrameworks(entrada: EntradaDeDeteccao): FrameworkDetectado[] {
  const arquivos = entrada.arquivos.map((caminho) => caminho.replace(/\\/g, "/"));
  const naRaiz = new Set(arquivos.filter((caminho) => !caminho.includes("/")));
  const emQualquerLugar = new Set(arquivos);
  const deps = dependenciasDeclaradas(entrada.manifestos ?? {});

  const achados: FrameworkDetectado[] = [];
  for (const [id, stack] of Object.entries(STACKS) as Array<[StackId, StackDefinition]>) {
    const deteccao = stack.detection;
    if (!deteccao) continue;

    let confianca = 0;
    let evidencia = "";

    for (const marcador of deteccao.rootMarkers ?? []) {
      const alvo = marcador.replace(/\\/g, "/");
      // Marcador com barra (`config/routes.rb`) é caminho: aceita em qualquer
      // nível. Sem barra, tem de estar na RAIZ — `index.html` dentro de
      // `public/` não faz de um projeto React um site estático.
      const bateu = alvo.includes("/")
        ? emQualquerLugar.has(alvo) || arquivos.some((caminho) => caminho.endsWith(`/${alvo}`))
        : naRaiz.has(alvo);
      if (bateu) {
        confianca = Math.max(confianca, 0.9);
        evidencia ||= alvo;
      }
    }

    for (const dep of deteccao.deps ?? []) {
      if (deps.has(dep)) {
        confianca = Math.max(confianca, 0.6);
        evidencia ||= `dependência ${dep}`;
      }
    }

    for (const [arquivo, padrao] of Object.entries(deteccao.contentPatterns ?? {})) {
      const conteudo = entrada.manifestos?.[arquivo];
      if (conteudo && new RegExp(padrao).test(conteudo)) {
        // Padrão de conteúdo é o desempate fino (Spring Boot vs Quarkus, que
        // compartilham `pom.xml`) — por isso soma em vez de só empatar.
        confianca = Math.min(1, Math.max(confianca, 0.6) + 0.2);
        evidencia ||= `${arquivo} (${padrao})`;
      }
    }

    if (confianca > 0) achados.push({ id, stack, evidencia, confianca });
  }

  const genericas = new Set<StackId>(["docker", "static", "unknown"] as StackId[]);
  const especificas = achados.filter((achado) => !genericas.has(achado.id));
  const lista = especificas.length ? especificas : achados;

  return lista.sort(
    (a, b) =>
      b.confianca - a.confianca ||
      PESO_DA_CATEGORIA[b.stack.category] - PESO_DA_CATEGORIA[a.stack.category] ||
      a.stack.name.localeCompare(b.stack.name)
  );
}
