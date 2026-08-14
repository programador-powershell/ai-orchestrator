// Package ship sabe COMO um projeto vira um container publicável.
//
// São três pedaços, e a ordem importa: o REGISTRO (este arquivo) guarda o
// conhecimento operacional de 47 stacks; a DETECÇÃO (detect.go) descobre qual
// delas é o projeto; o GERADOR (dockerfile.go) transforma a stack detectada num
// Dockerfile que sobe de verdade. O "publicar" do produto começa aqui — sem
// saber que o Nuxt sai em `.output` e que o Rails precisa de `Gemfile` MAIS
// `config/routes.rb`, todo deploy é chute.
//
// ---------------------------------------------------------------------------
// ARQUIVO DERIVADO — contém dado de terceiro, sob Apache License 2.0.
//
// Origem: openship — https://github.com/oblien/openship — versão 0.6.5,
// commit 8443f1e, arquivo `packages/core/src/stacks.ts`, via a porta
// TypeScript `apps/desktop/src/lib/ship/stacks.ts` do repositório pai deste
// produto. Cópia da licença em `licenses/openship-APACHE-2.0.txt` (raiz do
// ai-bot); atribuição completa no `NOTICE`.
//
// MODIFICAÇÕES em relação ao original (exigidas pela §4b da licença):
//   - portado de TypeScript para Go (gateway, somente biblioteca padrão);
//   - a constante STACK_ICONS continua FORA (apontava para um CDN externo:
//     buscar logo de marca lá fora entrega a lista de frameworks do usuário a
//     um terceiro e quebra o app offline);
//   - a conjunção do Rails (Gemfile E um confirmador) agora vive em detect.go,
//     como o stack-detector original fazia;
//   - comentários reescritos em português do Brasil.
//
// Os DADOS (nome, imagem, comando de build, porta, regra de detecção de cada
// stack) são transcritos do original: é conhecimento operacional acumulado, e
// reescrever de cabeça só produziria uma versão pior. Um erro de transcrição
// aqui manda o build para o diretório errado sem reclamar — por isso os testes
// conferem os valores de verdade, não só a forma.
// ---------------------------------------------------------------------------
package ship

// Language é a linguagem base — decide a imagem de build e as ferramentas
// exigidas quando a stack não sobrescreve.
type Language struct {
	Name            string
	BuildImage      string
	RuntimeImage    string
	PackageManagers []string
	RequiredTools   []string
}

// Detection são os sinais que denunciam a stack.
//
// `RootMarkers` é arquivo na raiz (aceita caminho aninhado, como
// `config/routes.rb`); `Deps` é dependência declarada no manifesto;
// `ContentPatterns` é regex dentro de um arquivo — o que separa Spring Boot
// de Quarkus, já que os dois têm `pom.xml`.
type Detection struct {
	RootMarkers     []string
	Deps            []string
	ContentPatterns map[string]string
}

// Category diz o papel do projeto — e pesa no desempate da detecção.
type Category string

const (
	CategoryFrontend  Category = "frontend"
	CategoryBackend   Category = "backend"
	CategoryFullstack Category = "fullstack"
	CategoryStatic    Category = "static"
	CategoryDocker    Category = "docker"
	CategoryServices  Category = "services"
	CategoryGeneric   Category = "generic"
)

// Stack é uma entrada do registro.
type Stack struct {
	Name     string
	Language string
	Category Category
	// BuildImage e RuntimeImage vazios caem na imagem da linguagem — ver
	// BuildImageFor e RuntimeImageFor.
	BuildImage           string
	RuntimeImage         string
	OutputDirectory      string
	DefaultPort          int
	DefaultBuildCommand  string
	DefaultStartCommand  string
	RequiredToolVersions map[string]string
	RequiredTools        []string
	// ProductionPaths é o que copiar para a imagem de runtime depois do build.
	ProductionPaths []string
	CacheDirs       []string
	// PersistentPaths são escritos em runtime — viram volume, senão o deploy
	// apaga o dado.
	PersistentPaths []string
	Detection       *Detection
}

// Languages são as 11 linguagens base do port.
var Languages = map[string]Language{
	"javascript": {
		Name:            "JavaScript",
		BuildImage:      "node:22",
		RuntimeImage:    "node:22",
		PackageManagers: []string{"npm", "yarn", "pnpm", "bun"},
		RequiredTools:   []string{"node", "npm"},
	},
	"typescript": {
		Name:            "TypeScript",
		BuildImage:      "node:22",
		RuntimeImage:    "node:22",
		PackageManagers: []string{"npm", "yarn", "pnpm", "bun"},
		RequiredTools:   []string{"node", "npm"},
	},
	"go": {
		Name:            "Go",
		BuildImage:      "golang:1.22-alpine",
		RuntimeImage:    "alpine:3.19",
		PackageManagers: []string{"go"},
		RequiredTools:   []string{"go"},
	},
	"rust": {
		Name:            "Rust",
		BuildImage:      "rust:1.77-slim",
		RuntimeImage:    "debian:bookworm-slim",
		PackageManagers: []string{"cargo"},
		RequiredTools:   []string{"rustc", "cargo"},
	},
	"python": {
		Name:            "Python",
		BuildImage:      "python:3.12-slim",
		RuntimeImage:    "python:3.12-slim",
		PackageManagers: []string{"pip", "poetry", "pipenv", "uv"},
		RequiredTools:   []string{"python3", "pip"},
	},
	"ruby": {
		Name:            "Ruby",
		BuildImage:      "ruby:3.3-slim",
		RuntimeImage:    "ruby:3.3-slim",
		PackageManagers: []string{"bundler"},
		RequiredTools:   []string{"ruby", "bundler"},
	},
	"php": {
		Name:       "PHP",
		BuildImage: "php:8.4-cli",
		// FrankenPHP, e não php:*-fpm. Imagem fpm é backend FastCGI, não
		// hospedeiro de processo: não traz servidor web, e emparelhá-la com um
		// nginx do apt são dois processos sob um shell que engole SIGTERM — o
		// stop do container mata requisição em voo em vez de drená-la. O
		// FrankenPHP é UM processo dono do HTTP e do PHP: sinal chega onde
		// deve, roda como usuário comum, e a convenção de docroot dele
		// (`/app/public`) já é o layout que as receitas emitem.
		RuntimeImage:    "dunglas/frankenphp:1-php8.4-bookworm",
		PackageManagers: []string{"composer"},
		RequiredTools:   []string{"php", "composer"},
	},
	"java": {
		Name: "Java",
		// A imagem do Maven traz `mvn` E o JDK 21, então o Dockerfile gerado
		// compila projeto Maven sem mais nada; projeto Gradle/Kotlin compila
		// pelo próprio wrapper `./gradlew` (só precisa do JDK, que está aqui).
		BuildImage:      "maven:3.9-eclipse-temurin-21",
		RuntimeImage:    "eclipse-temurin:21-jre-alpine",
		PackageManagers: []string{"maven", "gradle"},
		RequiredTools:   []string{"java", "javac"},
	},
	"csharp": {
		Name:            "C#",
		BuildImage:      "mcr.microsoft.com/dotnet/sdk:8.0",
		RuntimeImage:    "mcr.microsoft.com/dotnet/aspnet:8.0",
		PackageManagers: []string{"dotnet"},
		RequiredTools:   []string{"dotnet"},
	},
	"elixir": {
		Name:            "Elixir",
		BuildImage:      "elixir:1.16-alpine",
		RuntimeImage:    "elixir:1.16-alpine",
		PackageManagers: []string{"mix"},
		RequiredTools:   []string{"elixir", "mix"},
	},
	"multi": {
		Name:            "Multi-language",
		BuildImage:      "ubuntu:22.04",
		RuntimeImage:    "ubuntu:22.04",
		PackageManagers: []string{},
		RequiredTools:   []string{},
	},
}

// Stacks são as 47 stacks do port, indexadas pelo id.
//
// Mapa em Go não tem ordem — a ordem de definição (que decide a exibição e a
// varredura determinística da detecção) vive em StackIDs, logo abaixo.
var Stacks = map[string]Stack{

	// ── JavaScript / TypeScript — frontend e fullstack ──────────────────────

	"nextjs": {
		Name:                 "Next.js",
		Language:             "typescript",
		Category:             CategoryFullstack,
		OutputDirectory:      ".next",
		DefaultPort:          3000,
		DefaultBuildCommand:  "next build",
		DefaultStartCommand:  "next start",
		RequiredToolVersions: map[string]string{"node": "20.9.0"},
		CacheDirs:            []string{".next/cache"},
		Detection: &Detection{
			RootMarkers: []string{"next.config.js", "next.config.mjs", "next.config.ts"},
			Deps:        []string{"next"},
		},
	},
	"nuxt": {
		Name:                "Nuxt",
		Language:            "typescript",
		Category:            CategoryFullstack,
		OutputDirectory:     ".output",
		DefaultPort:         3000,
		DefaultBuildCommand: "nuxt build",
		DefaultStartCommand: "node .output/server/index.mjs",
		CacheDirs:           []string{".nuxt"},
		Detection: &Detection{
			RootMarkers: []string{"nuxt.config.js", "nuxt.config.ts", "nuxt.config.mjs"},
			Deps:        []string{"nuxt", "@nuxt/core"},
		},
	},
	"sveltekit": {
		Name:                "SvelteKit",
		Language:            "typescript",
		Category:            CategoryFullstack,
		OutputDirectory:     ".svelte-kit",
		DefaultPort:         3000,
		DefaultBuildCommand: "vite build",
		DefaultStartCommand: "node build/index.js",
		Detection: &Detection{
			RootMarkers: []string{"svelte.config.js", "svelte.config.mjs"},
			Deps:        []string{"svelte", "@sveltejs/kit"},
		},
	},
	"remix": {
		Name:                "Remix",
		Language:            "typescript",
		Category:            CategoryFullstack,
		OutputDirectory:     "build",
		DefaultPort:         3000,
		DefaultBuildCommand: "remix build",
		DefaultStartCommand: "remix-serve build/index.js",
		Detection: &Detection{
			RootMarkers: []string{"remix.config.js", "remix.config.ts"},
			Deps:        []string{"@remix-run/react", "@remix-run/node", "remix"},
		},
	},
	"tanstack-start": {
		Name:                "TanStack Start",
		Language:            "typescript",
		Category:            CategoryFullstack,
		OutputDirectory:     ".output",
		DefaultPort:         3000,
		DefaultBuildCommand: "vite build",
		DefaultStartCommand: "node .output/server/index.mjs",
		// O bundle do servidor Nitro/Vinxi é autossuficiente em .output — o
		// mesmo formato do Nuxt.
		ProductionPaths: []string{".output"},
		Detection: &Detection{
			// TanStack Start é baseado em Vite/Rsbuild; app.config.* é o
			// marcador antigo do framework, e app atual costuma trazer
			// vite.config.* ou rsbuild.config.* mais a dependência do start.
			RootMarkers: []string{
				"app.config.ts",
				"app.config.js",
				"app.config.mjs",
				"vite.config.ts",
				"vite.config.js",
				"vite.config.mjs",
				"rsbuild.config.ts",
				"rsbuild.config.js",
				"rsbuild.config.mjs",
			},
			Deps: []string{"@tanstack/react-start", "@tanstack/start"},
		},
	},
	"astro": {
		Name:                "Astro",
		Language:            "typescript",
		Category:            CategoryFrontend,
		OutputDirectory:     "dist",
		DefaultPort:         4321,
		DefaultBuildCommand: "astro build",
		DefaultStartCommand: "node dist/server/entry.mjs",
		Detection: &Detection{
			RootMarkers: []string{"astro.config.mjs", "astro.config.js", "astro.config.ts"},
			Deps:        []string{"astro"},
		},
	},
	"vite": {
		Name:                "Vite",
		Language:            "typescript",
		Category:            CategoryFrontend,
		OutputDirectory:     "dist",
		DefaultPort:         5173,
		DefaultBuildCommand: "vite build",
		DefaultStartCommand: "",
		Detection: &Detection{
			RootMarkers: []string{"vite.config.js", "vite.config.ts", "vite.config.mjs"},
			Deps:        []string{"vite"},
		},
	},
	"angular": {
		Name:                "Angular",
		Language:            "typescript",
		Category:            CategoryFrontend,
		OutputDirectory:     "dist",
		DefaultPort:         4200,
		DefaultBuildCommand: "ng build --configuration production",
		DefaultStartCommand: "",
		Detection: &Detection{
			RootMarkers: []string{"angular.json"},
			Deps:        []string{"@angular/core"},
		},
	},
	"gatsby": {
		Name:                "Gatsby",
		Language:            "javascript",
		Category:            CategoryFrontend,
		OutputDirectory:     "public",
		DefaultPort:         8000,
		DefaultBuildCommand: "gatsby build",
		DefaultStartCommand: "gatsby serve",
		CacheDirs:           []string{".cache"},
		Detection: &Detection{
			RootMarkers: []string{"gatsby-config.js", "gatsby-config.ts"},
			Deps:        []string{"gatsby"},
		},
	},
	"cra": {
		Name:                "Create React App",
		Language:            "javascript",
		Category:            CategoryFrontend,
		OutputDirectory:     "build",
		DefaultPort:         3000,
		DefaultBuildCommand: "react-scripts build",
		DefaultStartCommand: "",
		Detection: &Detection{
			// O único sinal durável do CRA é a dependência react-scripts; o
			// layout public/ + src/ é compartilhado com meio mundo React.
			Deps: []string{"react-scripts"},
		},
	},
	"vue": {
		Name:                "Vue CLI",
		Language:            "javascript",
		Category:            CategoryFrontend,
		OutputDirectory:     "dist",
		DefaultPort:         8080,
		DefaultBuildCommand: "vue-cli-service build",
		DefaultStartCommand: "",
		Detection: &Detection{
			RootMarkers: []string{"vue.config.js", "vue.config.ts"},
			// Quem desambigua Vue de Nuxt é a ordenação: o marcador do Nuxt
			// vale 0.9 e a dependência solta `vue` vale 0.6.
			Deps: []string{"vue"},
		},
	},
	"react": {
		Name:                "React",
		Language:            "javascript",
		Category:            CategoryFrontend,
		OutputDirectory:     "build",
		DefaultPort:         3000,
		DefaultBuildCommand: "",
		DefaultStartCommand: "",
		// Sem bloco Detection: é entrada de escolha manual. Quem se identifica
		// sozinho é o `cra`, pela dependência react-scripts.
	},

	// ── JavaScript / TypeScript — backend ───────────────────────────────────

	"express": {
		Name:                "Express",
		Language:            "javascript",
		Category:            CategoryBackend,
		OutputDirectory:     "dist",
		DefaultPort:         3000,
		DefaultBuildCommand: "",
		DefaultStartCommand: "node index.js",
		Detection: &Detection{
			Deps: []string{"express"},
		},
	},
	"fastify": {
		Name:                "Fastify",
		Language:            "typescript",
		Category:            CategoryBackend,
		OutputDirectory:     "dist",
		DefaultPort:         3000,
		DefaultBuildCommand: "",
		DefaultStartCommand: "node dist/index.js",
		Detection: &Detection{
			Deps: []string{"fastify"},
		},
	},
	"hono": {
		Name:                "Hono",
		Language:            "typescript",
		Category:            CategoryBackend,
		OutputDirectory:     "dist",
		DefaultPort:         3000,
		DefaultBuildCommand: "",
		DefaultStartCommand: "node dist/index.js",
		Detection: &Detection{
			Deps: []string{"hono"},
		},
	},
	"nestjs": {
		Name:                "NestJS",
		Language:            "typescript",
		Category:            CategoryBackend,
		OutputDirectory:     "dist",
		DefaultPort:         3000,
		DefaultBuildCommand: "nest build",
		DefaultStartCommand: "node dist/main.js",
		Detection: &Detection{
			RootMarkers: []string{"nest-cli.json"},
			Deps:        []string{"@nestjs/core"},
		},
	},
	"koa": {
		Name:                "Koa",
		Language:            "javascript",
		Category:            CategoryBackend,
		OutputDirectory:     "dist",
		DefaultPort:         3000,
		DefaultBuildCommand: "",
		DefaultStartCommand: "node index.js",
		Detection: &Detection{
			Deps: []string{"koa"},
		},
	},
	"adonis": {
		Name:                "AdonisJS",
		Language:            "typescript",
		Category:            CategoryFullstack,
		OutputDirectory:     "build",
		DefaultPort:         3333,
		DefaultBuildCommand: "node ace build --production",
		DefaultStartCommand: "node build/server.js",
		Detection: &Detection{
			RootMarkers: []string{"ace.js", ".adonisrc.json", "adonisrc.ts"},
			Deps:        []string{"@adonisjs/core"},
		},
	},
	"elysia": {
		Name:                "Elysia",
		Language:            "typescript",
		Category:            CategoryBackend,
		OutputDirectory:     "dist",
		DefaultPort:         3000,
		DefaultBuildCommand: "",
		DefaultStartCommand: "bun dist/index.js",
		Detection: &Detection{
			Deps: []string{"elysia"},
		},
	},

	// ── Go ──────────────────────────────────────────────────────────────────

	"go": {
		Name:                "Go",
		Language:            "go",
		Category:            CategoryBackend,
		OutputDirectory:     ".",
		DefaultPort:         8080,
		DefaultBuildCommand: "go build -o app .",
		DefaultStartCommand: "./app",
		ProductionPaths:     []string{"app"},
		Detection: &Detection{
			RootMarkers: []string{"go.mod"},
		},
	},
	"gin": {
		Name:                "Gin",
		Language:            "go",
		Category:            CategoryBackend,
		OutputDirectory:     ".",
		DefaultPort:         8080,
		DefaultBuildCommand: "go build -o app .",
		DefaultStartCommand: "./app",
		ProductionPaths:     []string{"app"},
		Detection: &Detection{
			RootMarkers: []string{"go.mod"},
			Deps:        []string{"github.com/gin-gonic/gin"},
		},
	},
	"fiber": {
		Name:                "Fiber",
		Language:            "go",
		Category:            CategoryBackend,
		OutputDirectory:     ".",
		DefaultPort:         3000,
		DefaultBuildCommand: "go build -o app .",
		DefaultStartCommand: "./app",
		ProductionPaths:     []string{"app"},
		Detection: &Detection{
			RootMarkers: []string{"go.mod"},
			Deps:        []string{"github.com/gofiber/fiber"},
		},
	},
	"echo": {
		Name:                "Echo",
		Language:            "go",
		Category:            CategoryBackend,
		OutputDirectory:     ".",
		DefaultPort:         8080,
		DefaultBuildCommand: "go build -o app .",
		DefaultStartCommand: "./app",
		ProductionPaths:     []string{"app"},
		Detection: &Detection{
			RootMarkers: []string{"go.mod"},
			Deps:        []string{"github.com/labstack/echo"},
		},
	},

	// ── Rust ────────────────────────────────────────────────────────────────

	"rust": {
		Name:                "Rust",
		Language:            "rust",
		Category:            CategoryBackend,
		OutputDirectory:     "target/release",
		DefaultPort:         8080,
		DefaultBuildCommand: "cargo build --release",
		DefaultStartCommand: "./target/release/app",
		ProductionPaths:     []string{"target/release/app"},
		Detection: &Detection{
			RootMarkers: []string{"Cargo.toml"},
		},
	},
	"actix": {
		Name:                "Actix Web",
		Language:            "rust",
		Category:            CategoryBackend,
		OutputDirectory:     "target/release",
		DefaultPort:         8080,
		DefaultBuildCommand: "cargo build --release",
		DefaultStartCommand: "./target/release/app",
		ProductionPaths:     []string{"target/release/app"},
		Detection: &Detection{
			RootMarkers: []string{"Cargo.toml"},
			Deps:        []string{"actix-web"},
		},
	},
	"axum": {
		Name:                "Axum",
		Language:            "rust",
		Category:            CategoryBackend,
		OutputDirectory:     "target/release",
		DefaultPort:         3000,
		DefaultBuildCommand: "cargo build --release",
		DefaultStartCommand: "./target/release/app",
		ProductionPaths:     []string{"target/release/app"},
		Detection: &Detection{
			RootMarkers: []string{"Cargo.toml"},
			Deps:        []string{"axum"},
		},
	},
	"rocket": {
		Name:                "Rocket",
		Language:            "rust",
		Category:            CategoryBackend,
		OutputDirectory:     "target/release",
		DefaultPort:         8000,
		DefaultBuildCommand: "cargo build --release",
		DefaultStartCommand: "./target/release/app",
		ProductionPaths:     []string{"target/release/app"},
		Detection: &Detection{
			RootMarkers: []string{"Cargo.toml"},
			Deps:        []string{"rocket"},
		},
	},

	// ── Python ──────────────────────────────────────────────────────────────

	"python": {
		Name:                "Python",
		Language:            "python",
		Category:            CategoryBackend,
		OutputDirectory:     ".",
		DefaultPort:         8000,
		DefaultBuildCommand: "pip install -r requirements.txt",
		DefaultStartCommand: "python app.py",
		Detection: &Detection{
			RootMarkers: []string{"requirements.txt", "pyproject.toml", "Pipfile", "setup.py"},
		},
	},
	"django": {
		Name:                "Django",
		Language:            "python",
		Category:            CategoryFullstack,
		OutputDirectory:     ".",
		DefaultPort:         8000,
		DefaultBuildCommand: "pip install -r requirements.txt && python manage.py collectstatic --noinput",
		DefaultStartCommand: "gunicorn config.wsgi:application --bind 0.0.0.0:8000",
		Detection: &Detection{
			RootMarkers: []string{"manage.py"},
		},
	},
	"flask": {
		Name:                "Flask",
		Language:            "python",
		Category:            CategoryBackend,
		OutputDirectory:     ".",
		DefaultPort:         5000,
		DefaultBuildCommand: "pip install -r requirements.txt",
		DefaultStartCommand: "gunicorn app:app --bind 0.0.0.0:5000",
		Detection: &Detection{
			RootMarkers: []string{"requirements.txt", "pyproject.toml", "Pipfile"},
			Deps:        []string{"flask", "Flask"},
		},
	},
	"fastapi": {
		Name:                "FastAPI",
		Language:            "python",
		Category:            CategoryBackend,
		OutputDirectory:     ".",
		DefaultPort:         8000,
		DefaultBuildCommand: "pip install -r requirements.txt",
		DefaultStartCommand: "uvicorn main:app --host 0.0.0.0 --port 8000",
		Detection: &Detection{
			RootMarkers: []string{"requirements.txt", "pyproject.toml", "Pipfile"},
			Deps:        []string{"fastapi", "FastAPI"},
		},
	},

	// ── Ruby ────────────────────────────────────────────────────────────────

	"rails": {
		Name:                "Ruby on Rails",
		Language:            "ruby",
		Category:            CategoryFullstack,
		OutputDirectory:     ".",
		DefaultPort:         3000,
		DefaultBuildCommand: "bundle install && bundle exec rails assets:precompile",
		DefaultStartCommand: "bundle exec rails server -b 0.0.0.0",
		Detection: &Detection{
			// Rails: o Gemfile é obrigatório; bin/rails ou config/routes.rb
			// confirma. A conjunção está codificada como exceção em detect.go —
			// só `Gemfile` casaria com qualquer projeto Ruby, e o Sinatra
			// viraria Rails.
			RootMarkers: []string{"Gemfile", "bin/rails", "config/routes.rb"},
		},
	},
	"sinatra": {
		Name:                "Sinatra",
		Language:            "ruby",
		Category:            CategoryBackend,
		OutputDirectory:     ".",
		DefaultPort:         4567,
		DefaultBuildCommand: "bundle install",
		DefaultStartCommand: "ruby app.rb",
		Detection: &Detection{
			RootMarkers: []string{"Gemfile"},
			Deps:        []string{"sinatra"},
		},
	},

	// ── PHP ─────────────────────────────────────────────────────────────────
	//
	// As stacks PHP servem `public/` pelo FrankenPHP (ver Languages["php"]).
	// O `exec` entrega o PID do container ao frankenphp, então o SIGTERM drena
	// requisição em voo em vez de ser engolido pelo shell; SERVER_NAME carrega
	// o $PORT injetado (`:porta` seco também afasta o HTTPS automático do
	// Caddy — TLS termina na borda). Sem comando de build: `composer install`
	// é o passo de INSTALL, e o build é onde entra pipeline de asset JS.

	"laravel": {
		Name:                "Laravel",
		Language:            "php",
		Category:            CategoryFullstack,
		OutputDirectory:     "public",
		DefaultPort:         8000,
		DefaultBuildCommand: "",
		DefaultStartCommand: `SERVER_NAME=":$PORT" exec frankenphp run --config /etc/frankenphp/Caddyfile --adapter caddyfile`,
		// Tudo o que um Laravel de fábrica escreve mora aqui: uploads
		// (storage/app), sessão e cache quando os drivers são `file`, e o
		// rascunho do próprio framework. `database/` fica de fora de propósito:
		// guarda migrações, e montar volume por cima esconderia as que uma
		// release futura adiciona.
		PersistentPaths: []string{"storage"},
		Detection: &Detection{
			RootMarkers: []string{"artisan", "composer.json"},
			Deps:        []string{"laravel/framework"},
		},
	},
	"symfony": {
		Name:                "Symfony",
		Language:            "php",
		Category:            CategoryFullstack,
		OutputDirectory:     "public",
		DefaultPort:         8000,
		DefaultBuildCommand: "",
		DefaultStartCommand: `SERVER_NAME=":$PORT" exec frankenphp run --config /etc/frankenphp/Caddyfile --adapter caddyfile`,
		// Sem PersistentPaths: o `var/` do Symfony é cache e log, ambos
		// regenerados, e não há convenção de onde cai upload de usuário.
		Detection: &Detection{
			RootMarkers: []string{"composer.json", "symfony.lock"},
			Deps:        []string{"symfony/framework-bundle"},
		},
	},

	// ── Java / JVM ──────────────────────────────────────────────────────────

	"springboot": {
		Name:                "Spring Boot",
		Language:            "java",
		Category:            CategoryBackend,
		OutputDirectory:     "target",
		DefaultPort:         8080,
		DefaultBuildCommand: "mvn clean package -DskipTests",
		DefaultStartCommand: "java -jar target/*.jar",
		ProductionPaths:     []string{"target"},
		// Predominantemente Maven; build em máquina crua precisa do `mvn`.
		// Projeto Spring Boot em Gradle compila pelo wrapper (só JDK).
		RequiredTools: []string{"java", "javac", "maven"},
		Detection: &Detection{
			RootMarkers: []string{"pom.xml", "build.gradle", "build.gradle.kts"},
			Deps:        []string{"org.springframework.boot:spring-boot-starter-web", "spring-boot"},
			ContentPatterns: map[string]string{
				"pom.xml":          "spring[-.]boot",
				"build.gradle":     "spring[-.]boot",
				"build.gradle.kts": "spring[-.]boot",
			},
		},
	},
	"quarkus": {
		Name:                "Quarkus",
		Language:            "java",
		Category:            CategoryBackend,
		OutputDirectory:     "target",
		DefaultPort:         8080,
		DefaultBuildCommand: "mvn clean package -DskipTests",
		DefaultStartCommand: "java -jar target/quarkus-app/quarkus-run.jar",
		ProductionPaths:     []string{"target"},
		RequiredTools:       []string{"java", "javac", "maven"},
		Detection: &Detection{
			RootMarkers: []string{"pom.xml", "build.gradle", "build.gradle.kts"},
			Deps:        []string{"io.quarkus:quarkus-core", "quarkus"},
			ContentPatterns: map[string]string{
				"pom.xml":          `io\.quarkus`,
				"build.gradle":     `io\.quarkus`,
				"build.gradle.kts": `io\.quarkus`,
			},
		},
	},

	// ── Kotlin (JVM, Gradle) ────────────────────────────────────────────────
	// Serviço Kotlin/JVM puro (Ktor, http4k ou um `main` seco). Kotlin com
	// Spring Boot continua casando `springboot` primeiro (o padrão de conteúdo
	// dele soma na ordenação), então isto pega o que não é Spring/Quarkus.

	"kotlin": {
		Name:                "Kotlin",
		Language:            "java",
		Category:            CategoryBackend,
		OutputDirectory:     "build/libs",
		DefaultPort:         8080,
		DefaultBuildCommand: "gradle build -x test",
		DefaultStartCommand: "java -jar build/libs/*.jar",
		ProductionPaths:     []string{"build/libs"},
		// Baseado em Gradle; máquina crua precisa do `gradle` (ou do wrapper
		// `./gradlew`, que o detector prefere quando existe).
		RequiredTools: []string{"java", "javac", "gradle"},
		Detection: &Detection{
			RootMarkers: []string{"build.gradle.kts", "build.gradle"},
			ContentPatterns: map[string]string{
				"build.gradle.kts": `kotlin\s*\(|org\.jetbrains\.kotlin`,
				"build.gradle":     `org\.jetbrains\.kotlin|kotlin[- ]`,
			},
		},
	},

	// ── C# / .NET ───────────────────────────────────────────────────────────

	"dotnet": {
		Name:     ".NET",
		Language: "csharp",
		Category: CategoryBackend,
		// O build roda `dotnet publish -c Release -o publish`, então o
		// artefato é ./publish.
		OutputDirectory:     "publish",
		DefaultPort:         5000,
		DefaultBuildCommand: "dotnet publish -c Release -o publish",
		// O .NET lê ASPNETCORE_URLS (não $PORT) e cai em :8080 por padrão,
		// então o bind na porta injetada é explícito. `app.dll` é o fallback —
		// um detector mais fino trocaria pelo nome real do assembly.
		DefaultStartCommand: "ASPNETCORE_URLS=http://0.0.0.0:$PORT dotnet publish/app.dll",
		ProductionPaths:     []string{"publish"},
		// .csproj/.fsproj/.sln se detectam por sufixo, que a regra declarativa
		// não expressa — o bloco fica vazio de propósito, como no original.
		Detection: &Detection{},
	},
	"blazor": {
		Name:     "Blazor",
		Language: "csharp",
		// Blazor WebAssembly compila para um bundle estático em
		// publish/wwwroot — vira arquivo servido, não servidor rodando
		// (Blazor Server cai em `dotnet`).
		Category:            CategoryStatic,
		OutputDirectory:     "publish/wwwroot",
		DefaultPort:         5000,
		DefaultBuildCommand: "dotnet publish -c Release -o publish",
		DefaultStartCommand: "",
		ProductionPaths:     []string{"publish/wwwroot"},
		Detection: &Detection{
			Deps: []string{"Microsoft.AspNetCore.Components.WebAssembly"},
		},
	},

	// ── Elixir ──────────────────────────────────────────────────────────────

	"phoenix": {
		Name:                "Phoenix",
		Language:            "elixir",
		Category:            CategoryFullstack,
		OutputDirectory:     "_build/prod/rel",
		DefaultPort:         4000,
		DefaultBuildCommand: "MIX_ENV=prod mix do deps.get, compile, assets.deploy, release",
		DefaultStartCommand: "_build/prod/rel/app/bin/app start",
		ProductionPaths:     []string{"_build/prod/rel"},
		Detection: &Detection{
			RootMarkers: []string{"mix.exs"},
			Deps:        []string{"phoenix"},
		},
	},

	// ── Genéricas ───────────────────────────────────────────────────────────

	"node": {
		Name:                "Node.js",
		Language:            "javascript",
		Category:            CategoryBackend,
		OutputDirectory:     "dist",
		DefaultPort:         3000,
		DefaultBuildCommand: "",
		DefaultStartCommand: "node index.js",
		Detection: &Detection{
			RootMarkers: []string{"package.json"},
		},
	},
	"static": {
		Name:                "Static Site",
		Language:            "multi",
		Category:            CategoryStatic,
		BuildImage:          "node:22",
		OutputDirectory:     ".",
		DefaultPort:         3000,
		DefaultBuildCommand: "",
		DefaultStartCommand: "",
		Detection: &Detection{
			RootMarkers: []string{"index.html"},
		},
	},
	"docker": {
		Name:                "Dockerfile",
		Language:            "multi",
		Category:            CategoryDocker,
		OutputDirectory:     ".",
		DefaultPort:         3000,
		DefaultBuildCommand: "",
		DefaultStartCommand: "",
		Detection: &Detection{
			RootMarkers: []string{"Dockerfile"},
		},
	},
	"docker-compose": {
		Name:                "Docker Compose",
		Language:            "multi",
		Category:            CategoryServices,
		OutputDirectory:     ".",
		DefaultPort:         3000,
		DefaultBuildCommand: "",
		DefaultStartCommand: "",
		Detection: &Detection{
			RootMarkers: []string{"docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"},
		},
	},
	"unknown": {
		Name:                "Unknown",
		Language:            "multi",
		Category:            CategoryGeneric,
		OutputDirectory:     "dist",
		DefaultPort:         3000,
		DefaultBuildCommand: "",
		DefaultStartCommand: "",
	},

	// ── Instalações opinativas do openship (comandos fixados pelo runner) ───

	"webmail": {
		Name:                "Webmail",
		Language:            "typescript",
		Category:            CategoryFullstack,
		OutputDirectory:     "client/build",
		DefaultPort:         4080,
		DefaultBuildCommand: "bun run build",
		DefaultStartCommand: "bun run src/main.ts",
		// Roda em bun, não em node — a camada de toolchain instala o bun.
		RequiredTools:        []string{"bun"},
		RequiredToolVersions: map[string]string{"bun": "1.2.0"},
	},
}

// StackIDs é a ordem de definição do registro — a mesma do original.
//
// Em Go o mapa não tem ordem, e a detecção precisa varrer sempre na mesma
// sequência para o resultado ser determinístico (o desempate final é por
// confiança, peso e nome, mas ninguém quer um relatório que muda entre duas
// execuções iguais).
var StackIDs = []string{
	"nextjs", "nuxt", "sveltekit", "remix", "tanstack-start", "astro", "vite",
	"angular", "gatsby", "cra", "vue", "react",
	"express", "fastify", "hono", "nestjs", "koa", "adonis", "elysia",
	"go", "gin", "fiber", "echo",
	"rust", "actix", "axum", "rocket",
	"python", "django", "flask", "fastapi",
	"rails", "sinatra",
	"laravel", "symfony",
	"springboot", "quarkus", "kotlin",
	"dotnet", "blazor",
	"phoenix",
	"node", "static", "docker", "docker-compose", "unknown",
	"webmail",
}

// StackRootMarkers é todo RootMarker conhecido.
//
// Serve para varrer a pasta UMA vez e perguntar "este arquivo interessa a
// alguém?", em vez de rodar 47 regras contra cada entrada do diretório.
var StackRootMarkers = buildRootMarkerIndex()

func buildRootMarkerIndex() map[string]bool {
	index := make(map[string]bool)
	for _, stack := range Stacks {
		if stack.Detection == nil {
			continue
		}
		for _, marker := range stack.Detection.RootMarkers {
			index[marker] = true
		}
	}
	return index
}

// TransferExcludes é o que NUNCA sobe junto do código-fonte.
//
// Mandar `node_modules` para o servidor é transferir centenas de megabytes do
// que o `install` vai refazer do outro lado.
var TransferExcludes = []string{
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
	"data",
}

// PackageRootOnlyExcludes são podados só na RAIZ do pacote.
//
// Casar `build`/`dist` por nome em qualquer profundidade apagaria pasta de
// fonte legítima — `src/build/` existe em projeto que ninguém imagina.
var PackageRootOnlyExcludes = []string{"build", "dist", "data"}

// StackByID busca a stack pelo id. O segundo retorno distingue "não existe" de
// "veio zerada" — uma stack zerada tem porta 0 e o gerador produziria lixo.
func StackByID(id string) (Stack, bool) {
	stack, ok := Stacks[id]
	return stack, ok
}

// LanguageByID busca a linguagem base.
func LanguageByID(id string) (Language, bool) {
	language, ok := Languages[id]
	return language, ok
}

// fallbackImage segura o caso de stack apontando para linguagem inexistente —
// que os testes do registro impedem, mas o gerador não pode devolver FROM "".
const fallbackImage = "ubuntu:22.04"

// BuildImageFor devolve a imagem de build da stack, caindo na da linguagem
// quando ela não sobrescreve.
func BuildImageFor(stack Stack) string {
	if stack.BuildImage != "" {
		return stack.BuildImage
	}
	if language, ok := Languages[stack.Language]; ok && language.BuildImage != "" {
		return language.BuildImage
	}
	return fallbackImage
}

// RuntimeImageFor devolve a imagem de runtime da stack, com o mesmo fallback.
func RuntimeImageFor(stack Stack) string {
	if stack.RuntimeImage != "" {
		return stack.RuntimeImage
	}
	if language, ok := Languages[stack.Language]; ok && language.RuntimeImage != "" {
		return language.RuntimeImage
	}
	return fallbackImage
}

// DefaultInstallCommand é o passo de INSTALL que o registro não guarda por
// stack — no produto de origem quem preenchia isso era o fluxo de deploy, e a
// ferramenta `ship.dockerfile` precisa de um padrão são para gerar um arquivo
// que compila.
//
// Só entra aqui o que a origem afirmava: `composer install` é o install do
// PHP, `go mod download` era o exemplo canônico do Go, e `npm install` é o
// denominador comum do ecossistema Node (npm ci exigiria lockfile garantido).
// As demais linguagens embutem a instalação no próprio comando de build
// (pip/bundle/mvn/dotnet/mix) — devolver vazio é correto, não preguiça.
func DefaultInstallCommand(stack Stack) string {
	switch stack.Language {
	case "javascript", "typescript":
		return "npm install"
	case "go":
		return "go mod download"
	case "php":
		return "composer install"
	}
	return ""
}
