// Testes do REGISTRO.
//
// Não é teste de tautologia: são os valores que o pipeline usa de verdade, e
// um erro de transcrição aqui manda o build para o diretório errado sem
// reclamar. Foi por isso que a porta original testava os valores, e a porta da
// porta testa de novo.
package ship

import (
	"encoding/json"
	"regexp"
	"strings"
	"testing"
)

func mustStack(t *testing.T, id string) Stack {
	t.Helper()
	stack, ok := StackByID(id)
	if !ok {
		t.Fatalf("a stack %q não existe no registro", id)
	}
	return stack
}

func TestCatalogCarriesTheWholePort(t *testing.T) {
	if len(StackIDs) != 47 {
		t.Fatalf("o port trouxe 47 stacks; StackIDs tem %d", len(StackIDs))
	}
	if len(Stacks) != 47 {
		t.Fatalf("o port trouxe 47 stacks; o mapa tem %d", len(Stacks))
	}
	if len(Languages) != 11 {
		t.Fatalf("o port trouxe 11 linguagens; o mapa tem %d", len(Languages))
	}
}

// StackIDs é uma lista PARALELA ao mapa — e lista paralela deriva. Este teste
// impede a stack registrada que nunca é varrida e o id varrido que não existe.
func TestStackIDsMatchTheMapExactly(t *testing.T) {
	seen := make(map[string]bool, len(StackIDs))
	for _, id := range StackIDs {
		if seen[id] {
			t.Errorf("id duplicado em StackIDs: %q", id)
		}
		seen[id] = true
		if _, ok := Stacks[id]; !ok {
			t.Errorf("StackIDs lista %q, que não existe no mapa", id)
		}
	}
	for id := range Stacks {
		if !seen[id] {
			t.Errorf("a stack %q está no mapa e fora de StackIDs — a detecção nunca a varre", id)
		}
	}
}

func TestEveryStackPointsToAnExistingLanguage(t *testing.T) {
	for id, stack := range Stacks {
		if _, ok := LanguageByID(stack.Language); !ok {
			t.Errorf("stack %s aponta para a linguagem %q, que não existe", id, stack.Language)
		}
	}
}

func TestEveryStackHasPortAndOutputDirectory(t *testing.T) {
	for id, stack := range Stacks {
		if stack.DefaultPort <= 0 {
			t.Errorf("stack %s sem porta padrão", id)
		}
		if stack.OutputDirectory == "" {
			t.Errorf("stack %s sem diretório de saída", id)
		}
		if stack.Name == "" {
			t.Errorf("stack %s sem nome", id)
		}
	}
}

func TestEverydayTruthValues(t *testing.T) {
	// Os casos que mais aparecem no dia. Um dígito trocado aqui e o deploy do
	// Next procura o build em `.dist` para sempre.
	if got := mustStack(t, "nextjs").OutputDirectory; got != ".next" {
		t.Errorf("nextjs sai em %q, esperava .next", got)
	}
	if got := mustStack(t, "nextjs").DefaultBuildCommand; got != "next build" {
		t.Errorf("build do nextjs é %q, esperava next build", got)
	}
	if got := mustStack(t, "nuxt").DefaultStartCommand; got != "node .output/server/index.mjs" {
		t.Errorf("start do nuxt é %q, esperava node .output/server/index.mjs", got)
	}
	if got := mustStack(t, "vite").DefaultPort; got != 5173 {
		t.Errorf("porta do vite é %d, esperava 5173", got)
	}
	if got := mustStack(t, "astro").DefaultPort; got != 4321 {
		t.Errorf("porta do astro é %d, esperava 4321", got)
	}
	if got := mustStack(t, "django").DefaultStartCommand; !strings.Contains(got, "gunicorn") {
		t.Errorf("start do django é %q, esperava gunicorn", got)
	}
	if got := mustStack(t, "go").DefaultPort; got != 8080 {
		t.Errorf("porta do go é %d, esperava 8080", got)
	}
	if got := mustStack(t, "rust").OutputDirectory; got != "target/release" {
		t.Errorf("rust sai em %q, esperava target/release", got)
	}
}

func TestRailsDeclaresGemfileAndAConfirmer(t *testing.T) {
	// A regra irregular do original: só `Gemfile` casaria com qualquer
	// projeto Ruby, e o Sinatra viraria Rails. A conjunção em si é testada em
	// detect_test.go; aqui se garante que os DADOS dela existem.
	rails := mustStack(t, "rails")
	if rails.Detection == nil {
		t.Fatal("rails sem bloco de detecção")
	}
	markers := strings.Join(rails.Detection.RootMarkers, " ")
	if !strings.Contains(markers, "Gemfile") {
		t.Error("os marcadores do rails não trazem Gemfile")
	}
	if !strings.Contains(markers, "config/routes.rb") {
		t.Error("os marcadores do rails não trazem config/routes.rb")
	}
}

func TestCRAIdentifiesByDependencyNotLayout(t *testing.T) {
	// `public/` + `src/` é layout de meio mundo; `react-scripts` é o sinal.
	cra := mustStack(t, "cra")
	if cra.Detection == nil {
		t.Fatal("cra sem bloco de detecção")
	}
	found := false
	for _, dep := range cra.Detection.Deps {
		if dep == "react-scripts" {
			found = true
		}
	}
	if !found {
		t.Error("o cra não se identifica por react-scripts")
	}
	if len(cra.Detection.RootMarkers) != 0 {
		t.Errorf("o cra não deveria ter marcador de raiz, tem %v", cra.Detection.RootMarkers)
	}
}

func TestRootMarkerIndexCoversKnownAnchors(t *testing.T) {
	for _, marker := range []string{"next.config.js", "go.mod", "Cargo.toml", "manage.py", "Dockerfile", "artisan"} {
		if !StackRootMarkers[marker] {
			t.Errorf("o índice de marcadores não cobre %q", marker)
		}
	}
}

func TestNeverTransfersWhatInstallRebuilds(t *testing.T) {
	excludes := strings.Join(TransferExcludes, " ")
	if !strings.Contains(excludes, "node_modules") {
		t.Error("TransferExcludes não poda node_modules")
	}
	if !strings.Contains(excludes, ".git") {
		t.Error("TransferExcludes não poda .git")
	}
	// `build` e `dist` também são podados, mas SÓ na raiz do pacote.
	want := []string{"build", "dist", "data"}
	if len(PackageRootOnlyExcludes) != len(want) {
		t.Fatalf("PackageRootOnlyExcludes é %v, esperava %v", PackageRootOnlyExcludes, want)
	}
	for index, value := range want {
		if PackageRootOnlyExcludes[index] != value {
			t.Fatalf("PackageRootOnlyExcludes é %v, esperava %v", PackageRootOnlyExcludes, want)
		}
	}
}

func TestNoBrandLogosAndNoExternalURLs(t *testing.T) {
	// O original trazia STACK_ICONS apontando para um CDN. Buscar logo de
	// marca lá fora entrega a um terceiro a lista de frameworks que o usuário
	// tem, quebra o app offline e depende de uma URL móvel (`@latest`).
	raw, err := json.Marshal(Stacks)
	if err != nil {
		t.Fatalf("serializar o registro: %v", err)
	}
	text := string(raw)
	if strings.Contains(text, "jsdelivr") || strings.Contains(text, "devicon") {
		t.Fatal("o registro voltou a carregar ícone de CDN")
	}
	// `http://0.0.0.0` é bind local do .NET, não busca de rede: o que não
	// pode aparecer é host de terceiro.
	urls := regexp.MustCompile(`https?://[^"\\ ]+`).FindAllString(text, -1)
	local := regexp.MustCompile(`^https?://(0\.0\.0\.0|127\.0\.0\.1|localhost)`)
	for _, url := range urls {
		if !local.MatchString(url) {
			t.Errorf("URL externa dentro do registro: %s", url)
		}
	}
}

func TestImageFallsBackToTheLanguage(t *testing.T) {
	nextjs := mustStack(t, "nextjs")
	if nextjs.BuildImage != "" {
		t.Fatalf("o nextjs não deveria sobrescrever a imagem de build, tem %q", nextjs.BuildImage)
	}
	typescript, ok := LanguageByID("typescript")
	if !ok {
		t.Fatal("a linguagem typescript sumiu do registro")
	}
	if got := BuildImageFor(nextjs); got != typescript.BuildImage {
		t.Errorf("BuildImageFor(nextjs) = %q, esperava %q", got, typescript.BuildImage)
	}
	if got := RuntimeImageFor(nextjs); got != typescript.RuntimeImage {
		t.Errorf("RuntimeImageFor(nextjs) = %q, esperava %q", got, typescript.RuntimeImage)
	}
}

func TestDefaultInstallCommandPerLanguage(t *testing.T) {
	cases := map[string]string{
		"nextjs":  "npm install",
		"go":      "go mod download",
		"laravel": "composer install",
		// Instalação embutida no build: devolver vazio é correto.
		"rails":  "",
		"python": "",
		"dotnet": "",
	}
	for id, want := range cases {
		if got := DefaultInstallCommand(mustStack(t, id)); got != want {
			t.Errorf("DefaultInstallCommand(%s) = %q, esperava %q", id, got, want)
		}
	}
}
