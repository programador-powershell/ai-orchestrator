// Detecção de stack: aplica as regras declaradas em stacks.go sobre a árvore
// do projeto e devolve os candidatos ordenados por especificidade.
//
// A detecção complementa o registro, não o substitui: lá está o CONHECIMENTO
// (que porta, que pasta de saída, que imagem); aqui está a PERGUNTA — "qual
// dessas 47 este projeto é?". A resposta alimenta o gerador de Dockerfile sem
// tradução no meio.
//
// ---------------------------------------------------------------------------
// ARQUIVO DERIVADO — lógica portada de código de terceiro, sob Apache 2.0.
//
// Origem: openship — https://github.com/oblien/openship (v0.6.5, 8443f1e),
// via a função `detectarFrameworks` da porta TypeScript
// `apps/desktop/src/lib/ship/stacks.ts` do repositório pai. Cópia da licença
// em `licenses/openship-APACHE-2.0.txt` (raiz do ai-bot); atribuição completa
// no `NOTICE`.
//
// MODIFICAÇÕES (§4b): portado para Go; `Detect(root)` agora VARRE a árvore e
// lê os manifestos sozinho (a versão TS recebia a lista pronta de quem chama);
// a conjunção do Rails — Gemfile E um confirmador — voltou a ser aplicada,
// como o stack-detector original fazia (a porta TS tratava os marcadores do
// Rails como OU, e um Gemfile solto virava Rails); o "deps gate" do detector
// original também voltou — marcador compartilhado entre stacks (go.mod,
// Cargo.toml, requirements.txt…) só conta para a stack que declara dependência
// ou padrão quando um deles confirma (na porta TS, um go.mod sem nada virava
// "Echo" pelo desempate alfabético); comentários em português.
// ---------------------------------------------------------------------------
package ship

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// Match é um framework detectado.
type Match struct {
	ID    string
	Stack Stack
	// Evidence é o que provou a detecção — quem lê o relatório vê o "por quê".
	Evidence string
	// Confidence vai de 0 a 1. Marcador de raiz vale mais que dependência
	// solta no manifesto.
	Confidence float64
}

// detectionInput é a matéria-prima da detecção, separada do disco para os
// testes exercitarem as regras sem montar árvore de verdade.
type detectionInput struct {
	// files são caminhos relativos à raiz, com "/".
	files []string
	// manifests é o conteúdo dos manifestos já lidos, por nome de arquivo.
	manifests map[string]string
}

// categoryWeight desempata categorias: mais específica ganha.
//
// `nextjs` e `node` casam no mesmo projeto — todo projeto Node tem
// `package.json`. Quem responde "como isto sobe?" é o framework (fullstack),
// não a biblioteca de UI nem o "tem um package.json aqui" — por isso o peso.
var categoryWeight = map[Category]int{
	CategoryFullstack: 5,
	CategoryBackend:   4,
	CategoryServices:  3,
	CategoryFrontend:  2,
	CategoryStatic:    1,
	CategoryDocker:    1,
	CategoryGeneric:   0,
}

// Confianças padronizadas: a razão dos degraus é comparativa, não absoluta —
// um arquivo de configuração na raiz é prova mais forte do que um nome de
// pacote no manifesto, e o padrão de conteúdo é o desempate fino que SOMA.
const (
	confidenceRootMarker = 0.9
	confidenceDependency = 0.6
	confidencePatternAdd = 0.2
)

// Detect varre a árvore a partir de root e devolve os frameworks detectados,
// do mais provável ao menos. Lista vazia significa "nenhum sinal conhecido" —
// não é erro: erro é reservado para raiz inexistente ou ilegível.
func Detect(root string) ([]Match, error) {
	if strings.TrimSpace(root) == "" {
		return nil, fmt.Errorf("informe a pasta do projeto a detectar")
	}
	info, err := os.Stat(root)
	if err != nil {
		return nil, fmt.Errorf("a pasta do projeto não pôde ser lida: %w", err)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("%q é um arquivo — a detecção precisa da PASTA raiz do projeto", root)
	}

	input, err := collectInput(root)
	if err != nil {
		return nil, err
	}
	return evaluate(input), nil
}

/* ------------------------------- varredura ------------------------------- */

// walkLimits mantêm a varredura barata: os marcadores moram na raiz ou perto
// dela, e um monorepo gigante não pode transformar a detecção num `du -a`.
const (
	walkMaxFiles    = 20000
	manifestMaxSize = 512 << 10
)

// detectSkipDirs corta o que nunca contém marcador legítimo. A lista nasce de
// TransferExcludes — se não vale a pena transferir, não vale a pena varrer —
// mais as pastas de ambiente que o transfer não vê.
func detectSkipDirs(name string) bool {
	for _, excluded := range TransferExcludes {
		if name == excluded {
			return true
		}
	}
	switch name {
	case ".venv", "__pycache__", ".idea", ".vscode":
		return true
	}
	return false
}

// manifestFiles são os arquivos lidos por inteiro para a busca de dependência.
// A lista é fechada de propósito: ler qualquer arquivo da raiz colocaria um
// SQLite de 2 GB na memória porque alguém o deixou do lado do package.json.
var manifestFiles = []string{
	"package.json",
	"pyproject.toml",
	"Pipfile",
	"requirements.txt",
	"setup.py",
	"Gemfile",
	"go.mod",
	"Cargo.toml",
	"composer.json",
	"mix.exs",
	"pom.xml",
	"build.gradle",
	"build.gradle.kts",
	"symfony.lock",
}

func collectInput(root string) (detectionInput, error) {
	input := detectionInput{manifests: make(map[string]string)}

	walkErr := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			// Pasta sem permissão não derruba a detecção inteira: os sinais
			// que interessam quase sempre estão em outro lugar.
			return nil
		}
		if path == root {
			return nil
		}
		relative, relErr := filepath.Rel(root, path)
		if relErr != nil {
			return nil
		}
		relative = filepath.ToSlash(relative)

		if entry.IsDir() {
			if detectSkipDirs(entry.Name()) {
				return filepath.SkipDir
			}
			return nil
		}
		if len(input.files) >= walkMaxFiles {
			return filepath.SkipAll
		}
		input.files = append(input.files, relative)
		return nil
	})
	if walkErr != nil {
		return input, fmt.Errorf("varrer %s: %w", root, walkErr)
	}

	// Manifesto só da RAIZ: dependência declarada num pacote três níveis
	// abaixo descreve aquele pacote, não o projeto que vai para o container.
	for _, name := range manifestFiles {
		readManifest(root, name, input.manifests)
	}
	// .csproj/.fsproj não têm nome fixo — é o sufixo que identifica. Entram
	// como manifesto para a dependência do Blazor
	// (Microsoft.AspNetCore.Components.WebAssembly) ser visível.
	for _, file := range input.files {
		if strings.Contains(file, "/") {
			continue
		}
		if strings.HasSuffix(file, ".csproj") || strings.HasSuffix(file, ".fsproj") {
			readManifest(root, file, input.manifests)
		}
	}
	return input, nil
}

// readManifest lê um manifesto da raiz para o mapa, ignorando ausência e
// recusando gigantes — manifesto de verdade tem quilobytes, não megas.
func readManifest(root, name string, manifests map[string]string) {
	path := filepath.Join(root, name)
	info, err := os.Stat(path)
	if err != nil || info.IsDir() || info.Size() > manifestMaxSize {
		return
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return
	}
	manifests[name] = string(content)
}

/* -------------------------------- avaliação ------------------------------- */

// markerOwnerCount diz quantas stacks reivindicam cada marcador.
//
// É a base do "deps gate": `next.config.js` pertence só ao Next e identifica o
// framework sozinho; `go.mod` pertence a go/gin/fiber/echo e identifica só o
// ECOSSISTEMA. Computar a partir do próprio registro (em vez de manter uma
// lista à mão) faz a regra acompanhar qualquer stack nova sem ninguém lembrar
// de atualizar um segundo lugar.
var markerOwnerCount = buildMarkerOwnerCount()

func buildMarkerOwnerCount() map[string]int {
	count := make(map[string]int)
	for _, stack := range Stacks {
		if stack.Detection == nil {
			continue
		}
		for _, marker := range stack.Detection.RootMarkers {
			count[strings.ReplaceAll(marker, "\\", "/")]++
		}
	}
	return count
}

// evaluate aplica as regras de stacks.go sobre a entrada. É a alma da porta:
// mesma semântica da `detectarFrameworks` de origem, mais a conjunção do Rails
// e o deps gate que a porta TS havia perdido.
func evaluate(input detectionInput) []Match {
	rootFiles := make(map[string]bool)
	anywhere := make(map[string]bool, len(input.files))
	for _, raw := range input.files {
		file := strings.ReplaceAll(raw, "\\", "/")
		anywhere[file] = true
		if !strings.Contains(file, "/") {
			rootFiles[file] = true
		}
	}
	files := make([]string, 0, len(anywhere))
	for file := range anywhere {
		files = append(files, file)
	}
	declared := declaredDependencies(input.manifests)

	// markerHit responde se UM marcador casa. Marcador com barra
	// (`config/routes.rb`) é caminho: aceita em qualquer nível. Sem barra, tem
	// de estar na RAIZ — `index.html` dentro de `public/` não faz de um
	// projeto React um site estático.
	markerHit := func(marker string) bool {
		target := strings.ReplaceAll(marker, "\\", "/")
		if strings.Contains(target, "/") {
			if anywhere[target] {
				return true
			}
			suffix := "/" + target
			for _, file := range files {
				if strings.HasSuffix(file, suffix) {
					return true
				}
			}
			return false
		}
		return rootFiles[target]
	}

	var matches []Match
	for _, id := range StackIDs {
		stack := Stacks[id]
		detection := stack.Detection
		if detection == nil {
			continue
		}

		// Os sinais fracos vêm ANTES dos marcadores porque o deps gate
		// precisa saber se a stack foi confirmada por dependência ou padrão.
		depEvidence := ""
		for _, dep := range detection.Deps {
			if declared[dep] {
				depEvidence = "dependência " + dep
				break
			}
		}

		// Padrão de conteúdo é o desempate fino (Spring Boot vs Quarkus, que
		// compartilham `pom.xml`). Iteração em ordem de nome para o relatório
		// não mudar entre execuções.
		patternEvidence := ""
		patternFiles := make([]string, 0, len(detection.ContentPatterns))
		for file := range detection.ContentPatterns {
			patternFiles = append(patternFiles, file)
		}
		sort.Strings(patternFiles)
		for _, file := range patternFiles {
			content, ok := input.manifests[file]
			if !ok {
				continue
			}
			pattern := detection.ContentPatterns[file]
			expression, err := regexp.Compile(pattern)
			if err != nil {
				// Padrão quebrado é defeito do REGISTRO, não do projeto da
				// pessoa — os testes o pegam; em produção ele só não pontua.
				continue
			}
			if expression.MatchString(content) {
				patternEvidence = fmt.Sprintf("%s (%s)", file, pattern)
				break
			}
		}
		confirmed := depEvidence != "" || patternEvidence != ""

		confidence := 0.0
		evidence := ""

		if id == "rails" {
			// A regra irregular, herdada do stack-detector original: o
			// Gemfile é obrigatório E um confirmador (bin/rails ou
			// config/routes.rb) também. Tratar como OU — o que a porta TS
			// fazia — promove qualquer projeto Ruby a Rails, e o build roda
			// `rails assets:precompile` num Sinatra.
			if markerHit("Gemfile") {
				for _, confirmer := range []string{"bin/rails", "config/routes.rb"} {
					if markerHit(confirmer) {
						confidence = confidenceRootMarker
						evidence = "Gemfile + " + confirmer
						break
					}
				}
			}
		} else {
			for _, marker := range detection.RootMarkers {
				if !markerHit(marker) {
					continue
				}
				target := strings.ReplaceAll(marker, "\\", "/")
				// O deps gate: marcador reivindicado por MAIS de uma stack
				// (go.mod, Cargo.toml, requirements.txt, vite.config.ts…)
				// situa o ecossistema, não o framework — para stack que
				// declara dependência ou padrão, ele só conta confirmado.
				// Sem o gate, um go.mod sem dependência nenhuma virava
				// "Echo" (todas as variantes empatavam em 0.9 e o desempate
				// alfabético escolhia por nome), e todo projeto Vite virava
				// "TanStack Start".
				gated := markerOwnerCount[target] > 1 &&
					(len(detection.Deps) > 0 || len(detection.ContentPatterns) > 0)
				if gated && !confirmed {
					continue
				}
				if confidence < confidenceRootMarker {
					confidence = confidenceRootMarker
				}
				if evidence == "" {
					evidence = target
					if gated {
						// O "por quê" honesto: o marcador sozinho não provou
						// nada, a dupla provou.
						if depEvidence != "" {
							evidence = target + " + " + depEvidence
						} else {
							evidence = target + " + " + patternEvidence
						}
					}
				}
			}
		}

		if depEvidence != "" {
			if confidence < confidenceDependency {
				confidence = confidenceDependency
			}
			if evidence == "" {
				evidence = depEvidence
			}
		}

		// O padrão SOMA em vez de só empatar — é o que separa o projeto
		// Spring de um pom.xml qualquer.
		if patternEvidence != "" {
			base := confidence
			if base < confidenceDependency {
				base = confidenceDependency
			}
			confidence = base + confidencePatternAdd
			if confidence > 1 {
				confidence = 1
			}
			if evidence == "" {
				evidence = patternEvidence
			}
		}

		if confidence > 0 {
			matches = append(matches, Match{ID: id, Stack: stack, Evidence: evidence, Confidence: confidence})
		}
	}

	// `docker` e `static` só aparecem se nada mais casar — um projeto Next.js
	// com Dockerfile é Next.js, e o marcador `index.html` existe em quase toda
	// pasta `public`.
	generic := map[string]bool{"docker": true, "static": true, "unknown": true}
	specific := matches[:0:0]
	for _, match := range matches {
		if !generic[match.ID] {
			specific = append(specific, match)
		}
	}
	if len(specific) > 0 {
		matches = specific
	}

	sort.SliceStable(matches, func(i, j int) bool {
		if matches[i].Confidence != matches[j].Confidence {
			return matches[i].Confidence > matches[j].Confidence
		}
		// No empate de confiança, quem nomeia só a LINGUAGEM perde para quem
		// nomeia o framework — e isso vem antes do peso de categoria, porque
		// `node` é backend (peso 4) e ganharia de todo frontend (peso 2): a
		// porta TS respondia "Node.js" para projeto Angular e Vite por causa
		// dessa dobra.
		fallbackI := languageFallback[matches[i].ID]
		fallbackJ := languageFallback[matches[j].ID]
		if fallbackI != fallbackJ {
			return !fallbackI
		}
		weightI := categoryWeight[matches[i].Stack.Category]
		weightJ := categoryWeight[matches[j].Stack.Category]
		if weightI != weightJ {
			return weightI > weightJ
		}
		return matches[i].Stack.Name < matches[j].Stack.Name
	})
	return matches
}

// languageFallback marca as stacks que respondem "qual é a linguagem?" e não
// "qual é o framework?" — o marcador delas é o manifesto do ecossistema, que
// TODO projeto da linguagem tem. Elas continuam na lista (o pipeline usa), mas
// nunca na frente de um framework confirmado com a mesma confiança.
var languageFallback = map[string]bool{"node": true, "python": true, "go": true, "rust": true}

/* ------------------------------ dependências ------------------------------ */

// declaredDependencies extrai os nomes declarados nos manifestos, seja qual
// for o ecossistema.
func declaredDependencies(manifests map[string]string) map[string]bool {
	names := make(map[string]bool)

	if packageJSON, ok := manifests["package.json"]; ok {
		var parsed struct {
			Dependencies     map[string]json.RawMessage `json:"dependencies"`
			DevDependencies  map[string]json.RawMessage `json:"devDependencies"`
			PeerDependencies map[string]json.RawMessage `json:"peerDependencies"`
		}
		// Manifesto quebrado não derruba a detecção: os marcadores de raiz
		// continuam valendo.
		if err := json.Unmarshal([]byte(packageJSON), &parsed); err == nil {
			for _, group := range []map[string]json.RawMessage{
				parsed.Dependencies, parsed.DevDependencies, parsed.PeerDependencies,
			} {
				for name := range group {
					names[name] = true
				}
			}
		}
	}

	// Nos outros ecossistemas o manifesto não é JSON, e escrever um parser de
	// TOML/YAML aqui seria desproporcional: o que interessa é se o NOME
	// aparece declarado. A borda `[^\w-]` evita que "django" case dentro de
	// "django-extensions" e vice-versa.
	for file, content := range manifests {
		if file == "package.json" {
			continue
		}
		for _, id := range StackIDs {
			detection := Stacks[id].Detection
			if detection == nil {
				continue
			}
			for _, dep := range detection.Deps {
				if names[dep] {
					continue
				}
				expression, err := regexp.Compile(`(?m)(^|[^\w-])` + regexp.QuoteMeta(dep) + `([^\w-]|$)`)
				if err != nil {
					continue
				}
				if expression.MatchString(content) {
					names[dep] = true
				}
			}
		}
	}
	return names
}
