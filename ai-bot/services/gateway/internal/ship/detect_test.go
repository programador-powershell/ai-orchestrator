// Testes da detecção.
//
// As regras puras (evaluate) são exercitadas com listas fabricadas — os mesmos
// casos da porta TypeScript de origem. `Detect` de verdade ganha os testes de
// disco: varrer, pular node_modules e ler manifesto são exatamente as partes
// que a versão TS recebia prontas de quem chamava.
package ship

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func packageJSON(deps map[string]string) string {
	var pairs []string
	for name, version := range deps {
		pairs = append(pairs, fmt.Sprintf("%q: %q", name, version))
	}
	return fmt.Sprintf(`{"name": "projeto", "dependencies": {%s}}`, strings.Join(pairs, ", "))
}

func matchIDs(matches []Match) []string {
	ids := make([]string, 0, len(matches))
	for _, match := range matches {
		ids = append(ids, match.ID)
	}
	return ids
}

func containsID(matches []Match, id string) bool {
	for _, match := range matches {
		if match.ID == id {
			return true
		}
	}
	return false
}

func indexOfID(matches []Match, id string) int {
	for index, match := range matches {
		if match.ID == id {
			return index
		}
	}
	return -1
}

func TestNextBeatsNodeInTheSameProject(t *testing.T) {
	// Os dois casam, e é assim em TODO projeto Node: o marcador de `node` é
	// `package.json`. Quem responde "como isto sobe?" é o framework (a porta,
	// a pasta de saída, o `next start`), não o "tem um package.json aqui".
	//
	// A stack `react` do port não entra nesta disputa porque não tem bloco de
	// detecção — é entrada de escolha manual. Quem se identifica sozinho é o
	// `cra`, pela dependência react-scripts.
	matches := evaluate(detectionInput{
		files:     []string{"package.json", "next.config.js", "src/App.tsx"},
		manifests: map[string]string{"package.json": packageJSON(map[string]string{"next": "15", "react": "19"})},
	})
	if len(matches) == 0 {
		t.Fatal("nada detectado")
	}
	if matches[0].ID != "nextjs" {
		t.Fatalf("o primeiro é %s, esperava nextjs (lista: %v)", matches[0].ID, matchIDs(matches))
	}
	if matches[0].Evidence != "next.config.js" {
		t.Errorf("a evidência é %q, esperava next.config.js", matches[0].Evidence)
	}
	if !containsID(matches, "node") {
		t.Error("node também casa e deveria estar na lista")
	}
	if indexOfID(matches, "node") <= 0 {
		t.Error("node deveria vir DEPOIS do framework")
	}
}

func TestMarkerWithoutSlashMustBeAtRoot(t *testing.T) {
	// `index.html` dentro de `public/` é rotina em projeto React — tratar
	// isso como site estático geraria a imagem errada.
	matches := evaluate(detectionInput{
		files:     []string{"package.json", "public/index.html"},
		manifests: map[string]string{"package.json": packageJSON(map[string]string{"react": "19", "react-scripts": "5"})},
	})
	if containsID(matches, "static") {
		t.Errorf("index.html aninhado virou site estático: %v", matchIDs(matches))
	}
	if !containsID(matches, "cra") {
		t.Errorf("react-scripts deveria denunciar o CRA: %v", matchIDs(matches))
	}
}

func TestMarkerWithSlashMatchesAtAnyLevel(t *testing.T) {
	matches := evaluate(detectionInput{files: []string{"backend/config/routes.rb", "Gemfile"}})
	if !containsID(matches, "rails") {
		t.Errorf("config/routes.rb aninhado + Gemfile deveria casar rails: %v", matchIDs(matches))
	}
}

func TestRailsRequiresGemfileAndAConfirmer(t *testing.T) {
	// A conjunção do stack-detector original, perdida na porta TS: um Gemfile
	// SOZINHO é qualquer projeto Ruby. Sem esta regra, o Sinatra vira Rails e
	// o build roda `rails assets:precompile` onde não existe Rails.
	alone := evaluate(detectionInput{files: []string{"Gemfile"}})
	if containsID(alone, "rails") {
		t.Errorf("Gemfile sozinho virou Rails: %v", matchIDs(alone))
	}
	// E o Sinatra também não aparece sem a gem declarada (deps gate): um
	// Gemfile mudo é projeto Ruby DESCONHECIDO, e dizer "sinatra" seria chute.
	if len(alone) != 0 {
		t.Errorf("Gemfile mudo não prova framework nenhum, veio %v", matchIDs(alone))
	}

	sinatra := evaluate(detectionInput{
		files:     []string{"Gemfile"},
		manifests: map[string]string{"Gemfile": "source 'https://rubygems.org'\ngem \"sinatra\"\n"},
	})
	if !containsID(sinatra, "sinatra") {
		t.Errorf("a gem sinatra declarada deveria confirmar o Sinatra: %v", matchIDs(sinatra))
	}

	confirmed := evaluate(detectionInput{files: []string{"Gemfile", "config/routes.rb"}})
	if !containsID(confirmed, "rails") {
		t.Errorf("Gemfile + config/routes.rb deveria casar rails: %v", matchIDs(confirmed))
	}

	viaBinRails := evaluate(detectionInput{files: []string{"Gemfile", "bin/rails"}})
	if !containsID(viaBinRails, "rails") {
		t.Errorf("Gemfile + bin/rails deveria casar rails: %v", matchIDs(viaBinRails))
	}

	// O confirmador SEM o Gemfile também não basta: pode ser uma cópia de
	// rotas dentro de outro projeto qualquer.
	orphan := evaluate(detectionInput{files: []string{"config/routes.rb"}})
	if containsID(orphan, "rails") {
		t.Errorf("config/routes.rb sem Gemfile virou Rails: %v", matchIDs(orphan))
	}
}

func TestSharedMarkerOnlyCountsWithItsDependency(t *testing.T) {
	// O deps gate do detector original: go.mod diz "é Go", não "é Echo". Sem
	// o gate, go/gin/fiber/echo empatavam em 0.9 e o desempate alfabético
	// respondia "Echo" para TODO projeto Go — com a porta 8080 do echo por
	// cima de qualquer coisa que o projeto realmente usasse.
	bare := evaluate(detectionInput{
		files:     []string{"go.mod", "main.go"},
		manifests: map[string]string{"go.mod": "module exemplo\n\ngo 1.22\n"},
	})
	ids := matchIDs(bare)
	if len(ids) != 1 || ids[0] != "go" {
		t.Fatalf("go.mod sem dependência é Go puro, veio %v", ids)
	}

	// Com a dependência declarada, a variante vence o genérico — e traz a
	// porta certa (Fiber escuta em 3000, não em 8080).
	fiber := evaluate(detectionInput{
		files:     []string{"go.mod", "main.go"},
		manifests: map[string]string{"go.mod": "module exemplo\n\nrequire github.com/gofiber/fiber/v2 v2.52.0\n"},
	})
	if len(fiber) == 0 || fiber[0].ID != "fiber" {
		t.Fatalf("go.mod com o Fiber declarado deveria dar fiber primeiro, veio %v", matchIDs(fiber))
	}
	if fiber[0].Stack.DefaultPort != 3000 {
		t.Errorf("a porta do fiber é %d, esperava 3000", fiber[0].Stack.DefaultPort)
	}

	// O mesmo gate segura o TanStack Start: vite.config.ts é marcador dos
	// dois, e sem a dependência do start todo projeto Vite virava TanStack.
	vite := evaluate(detectionInput{
		files:     []string{"package.json", "vite.config.ts"},
		manifests: map[string]string{"package.json": packageJSON(map[string]string{"vite": "5"})},
	})
	if containsID(vite, "tanstack-start") {
		t.Errorf("projeto Vite comum virou TanStack Start: %v", matchIDs(vite))
	}
	if len(vite) == 0 || vite[0].ID != "vite" {
		t.Errorf("esperava vite primeiro, veio %v", matchIDs(vite))
	}
}

func TestGenericsOnlyAppearWhenNothingSpecificMatches(t *testing.T) {
	dockerOnly := evaluate(detectionInput{files: []string{"Dockerfile", "README.md"}})
	ids := matchIDs(dockerOnly)
	if len(ids) != 1 || ids[0] != "docker" {
		t.Fatalf("só o Dockerfile no projeto deveria dar [docker], deu %v", ids)
	}

	// Com framework de verdade no projeto, o Dockerfile deixa de ser resposta.
	withFramework := evaluate(detectionInput{
		files:     []string{"Dockerfile", "package.json", "next.config.js"},
		manifests: map[string]string{"package.json": packageJSON(map[string]string{"next": "15"})},
	})
	if containsID(withFramework, "docker") {
		t.Errorf("docker apareceu mesmo com framework detectado: %v", matchIDs(withFramework))
	}
}

func TestProjectWithNoSignalsReturnsEmpty(t *testing.T) {
	matches := evaluate(detectionInput{files: []string{"LEIAME.txt", "notas.md"}})
	if len(matches) != 0 {
		t.Errorf("esperava lista vazia, veio %v", matchIDs(matches))
	}
}

func TestDependencyIsReadFromNonJSONManifest(t *testing.T) {
	// pyproject.toml não é JSON e escrever um parser de TOML aqui seria
	// desproporcional — o que importa é o nome aparecer declarado.
	matches := evaluate(detectionInput{
		files:     []string{"pyproject.toml"},
		manifests: map[string]string{"pyproject.toml": "[project]\ndependencies = [\"fastapi>=0.110\", \"uvicorn\"]\n"},
	})
	if !containsID(matches, "fastapi") {
		t.Errorf("fastapi declarado no pyproject não foi visto: %v", matchIDs(matches))
	}
}

func TestDependencyNameDoesNotMatchAsSubstring(t *testing.T) {
	matches := evaluate(detectionInput{
		files:     []string{"pyproject.toml"},
		manifests: map[string]string{"pyproject.toml": "dependencies = [\"django-extensions\"]\n"},
	})
	// "django" está DENTRO de "django-extensions" — não é declaração de Django.
	if containsID(matches, "django") {
		t.Errorf("django casou como pedaço de django-extensions: %v", matchIDs(matches))
	}
}

func TestBrokenManifestDoesNotKillMarkerDetection(t *testing.T) {
	matches := evaluate(detectionInput{
		files:     []string{"package.json", "next.config.js"},
		manifests: map[string]string{"package.json": "{ isto não é json"},
	})
	if len(matches) == 0 || matches[0].ID != "nextjs" {
		t.Errorf("o marcador deveria bastar com manifesto quebrado: %v", matchIDs(matches))
	}
}

func TestContentPatternDisambiguatesSpringFromQuarkus(t *testing.T) {
	// Os dois têm pom.xml; quem decide é o padrão de conteúdo. Com o deps
	// gate, o pom.xml sozinho não pontua para nenhum dos dois — o Spring some
	// da lista do projeto Quarkus em vez de empatar com ele.
	matches := evaluate(detectionInput{
		files:     []string{"pom.xml"},
		manifests: map[string]string{"pom.xml": "<project><groupId>io.quarkus</groupId></project>"},
	})
	if len(matches) == 0 {
		t.Fatal("nada detectado")
	}
	if matches[0].ID != "quarkus" {
		t.Fatalf("o primeiro é %s, esperava quarkus (lista: %v)", matches[0].ID, matchIDs(matches))
	}
	if containsID(matches, "springboot") {
		t.Errorf("springboot apareceu num projeto Quarkus: %v", matchIDs(matches))
	}
	// Marcador confirmado (0.9) + padrão (+0.2) satura em 1.0.
	if matches[0].Confidence != 1.0 {
		t.Errorf("confiança do quarkus é %.2f, esperava 1.0", matches[0].Confidence)
	}
}

func TestDetectionOutputFeedsDockerfileDirectly(t *testing.T) {
	// É o ponto do módulo: a detecção alimenta o gerador sem tradução.
	matches := evaluate(detectionInput{
		files:     []string{"package.json", "next.config.js"},
		manifests: map[string]string{"package.json": packageJSON(map[string]string{"next": "15"})},
	})
	if len(matches) == 0 {
		t.Fatal("nada detectado")
	}
	found := matches[0]
	output, err := Dockerfile(found.Stack, Options{BuildCommand: found.Stack.DefaultBuildCommand})
	if err != nil {
		t.Fatalf("Dockerfile: %v", err)
	}
	if !strings.Contains(output, fmt.Sprintf("EXPOSE %d", found.Stack.DefaultPort)) {
		t.Errorf("o Dockerfile não expôs a porta da stack detectada:\n%s", output)
	}
	if !strings.Contains(output, "CMD [") {
		t.Errorf("o Dockerfile saiu sem CMD:\n%s", output)
	}
}

/* ------------------------------ Detect no disco ------------------------------ */

func writeFile(t *testing.T, root string, relative string, content string) {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(relative))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("criar pasta de %s: %v", relative, err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("gravar %s: %v", relative, err)
	}
}

func TestDetectWalksTheTreeAndReadsManifests(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "package.json", packageJSON(map[string]string{"next": "15"}))
	writeFile(t, root, "next.config.js", "module.exports = {}")
	writeFile(t, root, "src/App.tsx", "export default () => null")

	matches, err := Detect(root)
	if err != nil {
		t.Fatalf("Detect: %v", err)
	}
	if len(matches) == 0 || matches[0].ID != "nextjs" {
		t.Fatalf("esperava nextjs primeiro, veio %v", matchIDs(matches))
	}
}

func TestDetectIgnoresDependencyFolders(t *testing.T) {
	// Um Gemfile + rotas DENTRO de node_modules é biblioteca de alguém, não o
	// projeto da pessoa. Sem a poda, todo projeto JS com uma dependência Ruby
	// embarcada viraria Rails.
	root := t.TempDir()
	writeFile(t, root, "index.html", "<!doctype html>")
	writeFile(t, root, "node_modules/pacote/Gemfile", "gem 'rails'")
	writeFile(t, root, "node_modules/pacote/config/routes.rb", "Rails.application.routes.draw {}")

	matches, err := Detect(root)
	if err != nil {
		t.Fatalf("Detect: %v", err)
	}
	if containsID(matches, "rails") {
		t.Errorf("marcador dentro de node_modules contou como projeto: %v", matchIDs(matches))
	}
	if !containsID(matches, "static") {
		t.Errorf("o index.html da raiz deveria casar o site estático: %v", matchIDs(matches))
	}
}

func TestDetectSeesBlazorThroughTheCsproj(t *testing.T) {
	// .csproj não tem nome fixo — entra como manifesto pelo sufixo, senão a
	// dependência do Blazor fica invisível.
	root := t.TempDir()
	writeFile(t, root, "app.csproj",
		`<Project><ItemGroup><PackageReference Include="Microsoft.AspNetCore.Components.WebAssembly" Version="8.0.0" /></ItemGroup></Project>`)

	matches, err := Detect(root)
	if err != nil {
		t.Fatalf("Detect: %v", err)
	}
	if !containsID(matches, "blazor") {
		t.Errorf("a dependência do Blazor no csproj não foi vista: %v", matchIDs(matches))
	}
}

func TestDetectRefusesWhatItCannotRead(t *testing.T) {
	if _, err := Detect(""); err == nil {
		t.Error("raiz vazia deveria ser recusada com motivo")
	}
	if _, err := Detect(filepath.Join(t.TempDir(), "nao-existe")); err == nil {
		t.Error("pasta inexistente deveria ser recusada com motivo")
	}
	file := filepath.Join(t.TempDir(), "arquivo.txt")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatalf("preparar arquivo: %v", err)
	}
	if _, err := Detect(file); err == nil {
		t.Error("arquivo no lugar da pasta deveria ser recusado com motivo")
	}
}

func TestDetectEmptyProjectReturnsEmptyListNotError(t *testing.T) {
	matches, err := Detect(t.TempDir())
	if err != nil {
		t.Fatalf("pasta vazia não é erro de leitura: %v", err)
	}
	if len(matches) != 0 {
		t.Errorf("pasta vazia detectou %v", matchIDs(matches))
	}
}
