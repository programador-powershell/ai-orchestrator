// Gerador de Dockerfile: transforma uma stack do registro num arquivo que
// constrói E roda — as duas metades importam, e as correções recentes existem
// porque a segunda metade era a que mentia.
//
// ---------------------------------------------------------------------------
// ARQUIVO DERIVADO — lógica portada de código de terceiro, sob Apache 2.0.
//
// Origem: openship — https://github.com/oblien/openship (v0.6.5, 8443f1e),
// arquivo `packages/adapters/src/runtime/docker-build-plan.ts`, via a porta
// TypeScript `apps/desktop/src/lib/ship/dockerfile.ts` do repositório pai.
// Cópia da licença em `licenses/openship-APACHE-2.0.txt` (raiz do ai-bot);
// atribuição completa no `NOTICE`.
//
// MODIFICAÇÕES (§4b): portado para Go como função pura de string; valor de
// variável de build com quebra de linha agora é RECUSADO com erro (a porta TS
// trocava por espaço em silêncio — valor mudado sem aviso é um bug atrás de
// outro); quando o site estático precisa do servidor de arquivos e a imagem
// de runtime não tem npm (Blazor/aspnet, site solto/ubuntu), o estágio de
// runtime passa a ser node:22 — antes o `RUN npm install` quebrava o build;
// comentários em português.
//
// Consertos herdados da revisão do repositório pai (com teste que falha sem
// cada um): site estático ganha CMD com http-server (antes a imagem terminava
// o `docker run` na hora); `ENV PORT` declarado no runtime (antes o start com
// `$PORT` escutava em ":" e morria na largada); env de build sanitizado.
// ---------------------------------------------------------------------------
package ship

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// BuildEventPrefix é o que o build imprime para a interface saber em que passo
// está.
//
// O truque é do original e é bom: o Docker não expõe progresso de dentro de um
// `RUN`, então o próprio comando imprime a marca e quem lê o log a reconhece.
// Sem isso, `docker build` é uma caixa preta que fica minutos calada.
const BuildEventPrefix = "[aibot-build]"

// BuildStep é um passo do build que imprime marca.
type BuildStep string

const (
	StepClone   BuildStep = "clone"
	StepInstall BuildStep = "install"
	StepBuild   BuildStep = "build"
	StepDeploy  BuildStep = "deploy"
)

// BuildStepStatus é o estado que a marca carrega.
type BuildStepStatus string

const (
	StatusRunning   BuildStepStatus = "running"
	StatusCompleted BuildStepStatus = "completed"
	StatusSkipped   BuildStepStatus = "skipped"
)

// FormatBuildEvent monta a marca que vai para o log.
func FormatBuildEvent(step BuildStep, status BuildStepStatus) string {
	return fmt.Sprintf("%s step=%s status=%s", BuildEventPrefix, step, status)
}

var (
	buildEventStep   = regexp.MustCompile(`step=([a-z]+)`)
	buildEventStatus = regexp.MustCompile(`status=([a-z]+)`)
)

// ParseBuildEvent lê a marca de volta do log. O terceiro retorno é falso para
// linha que não é marca.
func ParseBuildEvent(line string) (BuildStep, BuildStepStatus, bool) {
	if !strings.Contains(line, BuildEventPrefix) {
		return "", "", false
	}
	step := buildEventStep.FindStringSubmatch(line)
	status := buildEventStatus.FindStringSubmatch(line)
	if step == nil || status == nil {
		return "", "", false
	}
	return BuildStep(step[1]), BuildStepStatus(status[1]), true
}

// StepProgress é o progresso de cada passo, em porcentagem.
//
// Transcrito do STEP_PROGRESS do original. Os números não são lineares de
// propósito: instalar dependência leva mais tempo de relógio do que clonar, e
// uma barra que anda em passos iguais mente sobre o que falta.
var StepProgress = map[string]int{
	"prepare": 3,
	"clone":   10,
	"install": 30,
	"build":   55,
	"deploy":  80,
}

// ProgressForStep devolve a porcentagem do passo; concluído vale dez a mais.
func ProgressForStep(step string, status BuildStepStatus) int {
	base := StepProgress[step]
	if status == StatusCompleted {
		return base + 10
	}
	return base
}

// Options parametriza a geração. Campo vazio cai no padrão da stack.
type Options struct {
	// SourceDir é a subpasta do projeto, quando é monorepo. Vazio = raiz.
	SourceDir      string
	InstallCommand string
	BuildCommand   string
	StartCommand   string
	Port           int
	// Env são variáveis do BUILD (não do runtime) — segredo não entra aqui.
	Env map[string]string
}

// excludedEnv são variáveis que NÃO viajam para o build.
//
// `FORCE_COLOR` e `TERM` fazem a ferramenta imprimir sequências de escape num
// log que ninguém vai renderizar como terminal — vira lixo no meio da saída.
var excludedEnv = map[string]bool{"FORCE_COLOR": true, "TERM": true}

var validEnvName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// envPrefix monta o `export A='x' && export B='y' && ` que precede os passos.
//
// Quebra de linha, retorno de carro ou nulo no VALOR é RECUSADO: quebra de
// linha encerra a instrução `RUN` no meio, e o que vem depois passa a ser lido
// como instrução Dockerfile por conta própria — na melhor hipótese um arquivo
// inválido, na pior uma diretiva que ninguém escreveu ali. Aspas simples não
// salvariam: o parser do Dockerfile corta a linha ANTES de o shell enxergar a
// aspa. E trocar por espaço em silêncio — o comportamento antigo — entrega um
// valor diferente do pedido sem ninguém saber.
func envPrefix(env map[string]string) (string, error) {
	names := make([]string, 0, len(env))
	for name := range env {
		if excludedEnv[name] || !validEnvName.MatchString(name) {
			continue
		}
		names = append(names, name)
	}
	// Ordem estável: mapa de Go embaralha, e um Dockerfile que muda entre duas
	// gerações iguais suja diff e invalida cache de layer à toa.
	sort.Strings(names)

	entries := make([]string, 0, len(names)+1)
	hasNoColor := false
	for _, name := range names {
		value := env[name]
		if strings.ContainsAny(value, "\n\r\x00") {
			return "", fmt.Errorf(
				"a variável de build %s tem quebra de linha (ou caractere de controle) no valor — "+
					"isso encerraria a instrução RUN e o resto viraria diretiva do Dockerfile; "+
					"remova a quebra de linha do valor ou passe-o em uma linha só", name)
		}
		if name == "NO_COLOR" {
			hasNoColor = true
		}
		entries = append(entries, fmt.Sprintf("export %s='%s'", name, escapeSingleQuotes(value)))
	}
	// `NO_COLOR` entra quando ninguém pediu o contrário: log de build é texto.
	if !hasNoColor {
		entries = append(entries, "export NO_COLOR='1'")
	}
	if len(entries) == 0 {
		return "", nil
	}
	return strings.Join(entries, " && ") + " && ", nil
}

// escapeSingleQuotes fecha a aspa, emite uma escapada e reabre — o único
// escape que existe dentro de aspas simples de shell.
func escapeSingleQuotes(value string) string {
	return strings.ReplaceAll(value, "'", `'\''`)
}

// stepsLine monta as linhas de install e build, num `RUN` só, com as marcas
// de progresso.
//
// Um `RUN` por passo pareceria mais limpo e custaria uma layer commitada por
// passo — em imagem de Node isso é centenas de megabytes gravados à toa.
func stepsLine(options Options) (string, error) {
	var parts []string
	push := func(command string, step BuildStep) {
		parts = append(parts, fmt.Sprintf("printf '%s\\n'", FormatBuildEvent(step, StatusRunning)))
		parts = append(parts, command)
		parts = append(parts, fmt.Sprintf("printf '%s\\n'", FormatBuildEvent(step, StatusCompleted)))
	}
	if options.InstallCommand != "" {
		push(options.InstallCommand, StepInstall)
	}
	if options.BuildCommand != "" {
		push(options.BuildCommand, StepBuild)
	}
	if len(parts) == 0 {
		return "", nil
	}
	prefix, err := envPrefix(options.Env)
	if err != nil {
		return "", err
	}
	return "RUN " + prefix + strings.Join(parts, " && "), nil
}

// staticServerImage é a imagem que serve site estático quando a de runtime da
// stack não tem npm. O http-server vem do npm DENTRO do build, e instalá-lo
// numa imagem sem npm (aspnet do Blazor, ubuntu do site solto) quebrava o
// `docker build` no RUN — um Dockerfile gerado que não constrói é pior do que
// nenhum.
const staticServerImage = "node:22"

// Dockerfile gera o Dockerfile do projeto.
//
// Multi-estágio quando a imagem de build difere da de runtime: compilar com o
// SDK e servir com o runtime enxuto é a diferença entre uma imagem de 1,2 GB e
// uma de 90 MB.
func Dockerfile(stack Stack, options Options) (string, error) {
	if stack.Name == "" {
		return "", fmt.Errorf("stack vazia — busque-a no registro com StackByID antes de gerar")
	}

	buildImage := BuildImageFor(stack)
	runtimeImage := RuntimeImageFor(stack)

	start := options.StartCommand
	if start == "" {
		start = stack.DefaultStartCommand
	}
	port := options.Port
	if port <= 0 {
		port = stack.DefaultPort
	}

	// A decisão do servidor de arquivos vem ANTES das linhas FROM porque ela
	// pode trocar a imagem de runtime (ver staticServerImage).
	needsFileServer := start == "" && stack.Category != CategoryDocker
	if needsFileServer && !strings.HasPrefix(runtimeImage, "node:") {
		runtimeImage = staticServerImage
	}
	multiStage := buildImage != runtimeImage

	sourceDir := "/workspace"
	if options.SourceDir != "" {
		sourceDir = "/workspace/" + options.SourceDir
	}

	var lines []string
	lines = append(lines, fmt.Sprintf("# Gerado por AI-BOT para a stack %q.", stack.Name))
	if multiStage {
		lines = append(lines, fmt.Sprintf("FROM %s AS builder", buildImage))
	} else {
		lines = append(lines, fmt.Sprintf("FROM %s", runtimeImage))
	}
	lines = append(lines, "WORKDIR /workspace")
	lines = append(lines, "COPY . /workspace")
	if options.SourceDir != "" {
		lines = append(lines, fmt.Sprintf("WORKDIR %s", sourceDir))
	}

	steps, err := stepsLine(options)
	if err != nil {
		return "", err
	}
	if steps != "" {
		lines = append(lines, steps)
	}

	if multiStage {
		lines = append(lines, fmt.Sprintf("FROM %s AS runtime", runtimeImage))
		// ProductionPaths diz o que interessa levar. Sem ele, copiar a pasta
		// inteira arrasta `node_modules` de desenvolvimento e o código-fonte
		// para dentro da imagem que vai para produção.
		if len(stack.ProductionPaths) > 0 {
			for _, path := range stack.ProductionPaths {
				lines = append(lines, fmt.Sprintf("COPY --from=builder %s/%s /app/%s", sourceDir, path, path))
			}
		} else {
			lines = append(lines, fmt.Sprintf("COPY --from=builder %s /app", sourceDir))
		}
		lines = append(lines, "WORKDIR /app")
	}

	lines = append(lines, fmt.Sprintf("EXPOSE %d", port))
	// `PORT` precisa EXISTIR no runtime.
	//
	// Três stacks portadas (dotnet, laravel, symfony) trazem `$PORT` dentro do
	// comando de start — vindo do openship, onde a plataforma injeta a
	// variável. Aqui ninguém injetava: o container subia com
	// `ASPNETCORE_URLS=http://0.0.0.0:` e o servidor morria na largada, ou o
	// FrankenPHP escutava em `:` e o deploy ficava "no ar" sem responder nada.
	// Declarar aqui também dá o valor certo para quem lê `PORT` por conta
	// própria (Node, Rails, Django), sem obrigar cada receita a saber disso.
	lines = append(lines, fmt.Sprintf("ENV PORT=%d", port))

	switch {
	case start != "":
		lines = append(lines, fmt.Sprintf(`CMD ["sh", "-c", %s]`, jsonString(start)))
	case stack.Category == CategoryDocker:
		// O projeto tem Dockerfile próprio. Gerar um por cima seria substituir
		// a decisão de quem escreveu o dele — quem chama deve usar o do
		// repositório.
		lines = append(lines, "# Este projeto traz o próprio Dockerfile — use o do repositório.")
	default:
		// Stack sem comando de start é site ESTÁTICO (Vite, Angular, CRA, Vue,
		// React, Blazor wasm, HTML solto): o build produz OutputDirectory e
		// não existe processo para subir. Antes o gerador simplesmente não
		// emitia CMD, e a imagem terminava o `docker run` na hora — um deploy
		// que "funciona" e não serve nada.
		//
		// `http-server` vem do npm no próprio build, então a imagem não
		// depende de rede para subir. `-s` faz o fallback para `index.html`,
		// sem o qual toda rota de SPA que não seja a raiz devolve 404 ao
		// recarregar a página.
		folder := "."
		if stack.OutputDirectory != "" && stack.OutputDirectory != "." {
			folder = stack.OutputDirectory
		}
		lines = append(lines, "RUN npm install -g http-server@14")
		lines = append(lines, fmt.Sprintf(`CMD ["sh", "-c", %s]`, jsonString(fmt.Sprintf("http-server %s -p $PORT -s", folder))))
	}

	return strings.Join(lines, "\n") + "\n", nil
}

// jsonString cita a string como o JSON.stringify da origem: o CMD em forma
// exec precisa de aspas duplas e escapes válidos de JSON, e montar isso na mão
// é reinventar o Marshal com menos casos cobertos.
func jsonString(value string) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		// Marshal de string não falha; o desvio existe para o compilador.
		return `""`
	}
	return string(encoded)
}
