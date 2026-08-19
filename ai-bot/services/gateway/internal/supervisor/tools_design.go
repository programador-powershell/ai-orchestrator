// A ferramenta de design do gateway — a réplica estruturada.
//
// O design.replicate nasceu em tools_web.go devolvendo TEXTO em seções, e o
// texto era o teto da tela: o CanvasSurface parseava o resultado por regex e
// perdia tudo o que não fosse cor/variável/fonte solta. A tela de Design foi
// escrita para consumir JSON (o mesmo contrato do orquestrador de referência:
// DesignReplicationResult com pages/tokens/analysis), então a ferramenta passa
// a devolver JSON ESTRUTURADO — o parse da tela lê `url`, `title` e o bloco
// `tokens` {colors, variables:[{name,value}], fonts}, e é EXATAMENTE isso que
// sai daqui, mais `pages` e `analysis` para o modelo e para as superfícies que
// chegam nas próximas ondas.
//
// O que NÃO sai daqui é o HTML da página: o resultado desta ferramenta entra
// no prompt do modelo (com teto de 20 KB no Tool Output Gateway — ver
// tool_gateway.go, que já lista design.replicate como contrato estruturado), e
// 2 MB de marcação afogariam a janela. Quem precisa do HTML cru — o "Clonar
// layout" da tela — usa a rota REST POST /v1/design/fetch do transporte, que
// não passa pelo prompt de ninguém.
//
// Os EXTRATORES (cores, variáveis, fontes, animações, sinais de layout,
// páginas do mesmo host) continuam em tools_web.go: são funções puras do
// pacote, cobertas por tools_web_test.go, e este arquivo só as REUSA — duas
// cópias de um extrator divergem, e a que diverge é a que ninguém testou.
package supervisor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
)

// designToolsInstall registra a ferramenta de design. Chamado por
// InstallExtraTools, no mesmo padrão do providerToolsInstall: toda ferramenta
// que um especialista promete nasce da Toolbox (invariante de
// tools_host_test.go).
//
// A descrição SOLETRA o formato de saída porque ela é o único contrato que o
// modelo vê — mesmo motivo de sql.render e schema.export em tools_extra.go.
func (t *Toolbox) designToolsInstall(registry *Registry) {
	registry.Register("design.replicate",
		"clona a linguagem visual de uma página e devolve JSON estruturado {url, title, "+
			"pages: [{title, url, blocks: [tags estruturais da página]}], "+
			"tokens: {colors: [cores por frequência], variables: [{name, value}], fonts, "+
			"spacing: [valores px/rem por frequência]}, analysis: string} — é este JSON que a "+
			"tela de Design lê para a faixa de tokens e a importação como nós do canvas. "+
			"args: {url, maxPages?} (maxPages LISTA, sem baixar, até 20 páginas do mesmo host)",
		t.designReplicateStructured)
}

/* ------------------------------ o resultado ------------------------------ */

// Os tipos abaixo são o CONTRATO com a tela, byte a byte. Os nomes dos campos
// JSON não são estética: o parse do CanvasSurface lê `root.url`, `root.title`,
// `tokens.colors`, `tokens.variables[].name/value` e `tokens.fonts` — mudar
// uma chave aqui deixa o painel de tokens vazio SEM erro nenhum, porque o
// parser da tela é tolerante de propósito.

type designReplicaVariable struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type designReplicaPage struct {
	Title string `json:"title"`
	URL   string `json:"url"`
	// Blocks são as tags ESTRUTURAIS presentes (header, nav, main…) — o
	// esqueleto que a importação para o canvas pode virar frames. Só a
	// primeira página tem blocos: as demais não foram baixadas.
	Blocks []string `json:"blocks"`
}

type designReplicaTokens struct {
	Colors    []string                `json:"colors"`
	Variables []designReplicaVariable `json:"variables"`
	Fonts     []string                `json:"fonts"`
	Spacing   []string                `json:"spacing"`
}

type designReplicaPayload struct {
	URL      string              `json:"url"`
	Title    string              `json:"title"`
	Pages    []designReplicaPage `json:"pages"`
	Tokens   designReplicaTokens `json:"tokens"`
	Analysis string              `json:"analysis"`
}

// designMaxSpacing limita os valores de espaçamento, pelo mesmo motivo dos
// outros tetos de tools_web.go: o resultado entra no prompt, e uma página real
// tem centenas de medidas.
const designMaxSpacing = 16

func (t *Toolbox) designReplicateStructured(ctx context.Context, _ string, raw json.RawMessage) (string, error) {
	if t.Net == nil {
		return "", errors.New("a saída de rede não está disponível")
	}
	// O contrato de entrada é o MESMO da versão em texto ({url, maxPages?}):
	// quem já chamava a ferramenta continua chamando igual — só a saída mudou.
	var args struct {
		URL      string `json:"url"`
		MaxPages int    `json:"maxPages"`
	}
	if err := decodeArgs(raw, &args); err != nil {
		return "", err
	}
	if strings.TrimSpace(args.URL) == "" {
		return "", errors.New("informe o endereço da página em \"url\"")
	}

	// A busca sai pelo netguard (t.Net), NUNCA por http.Get: a URL vem do
	// modelo, e sem o guarda um prompt vira SSRF contra a rede interna.
	response, body, err := t.Net.Fetch(ctx, args.URL, http.Header{"Accept": {"text/html"}})
	if err != nil {
		return "", err
	}
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("a página respondeu %d", response.StatusCode)
	}
	// Só HTML — mesma recusa da versão em texto: varrer um PDF ou uma imagem
	// devolveria "cores" tiradas de bytes binários, e resultado inventado é
	// pior que recusa, porque o modelo acredita nele.
	contentType := strings.ToLower(strings.TrimSpace(response.Header.Get("Content-Type")))
	if !strings.Contains(contentType, "text/html") {
		return "", fmt.Errorf("a linguagem visual é extraída de html e a resposta veio como %s",
			orDefault(contentType, "conteúdo sem tipo declarado"))
	}

	// A base dos links relativos é a URL FINAL, depois dos redirecionamentos:
	// um http:// que vira https://www. resolveria `/precos` no host errado.
	base := response.Request.URL
	if base == nil {
		if parsed, err := url.Parse(args.URL); err == nil {
			base = parsed
		}
	}

	source := clipBytes(string(body), designMaxSource)
	out, err := json.Marshal(designReplica(base, source, args.MaxPages))
	if err != nil {
		return "", fmt.Errorf("montar o resultado: %w", err)
	}
	return string(out), nil
}

// designReplica monta o resultado estruturado. Separada da ferramenta porque é
// função pura sobre o HTML — o que permite testá-la sem rede, como o
// formatDesign da versão em texto.
func designReplica(base *url.URL, source string, maxPages int) designReplicaPayload {
	address := ""
	if base != nil {
		address = base.String()
	}
	title := extractTitle(source)

	extracted := extractCSSVariables(source)
	// O cssVariable de tools_web.go não tem tag de JSON (sairia Name/Value em
	// caixa alta, que o parse da tela não lê); a conversão para o tipo com tag
	// acontece aqui, uma vez, em vez de arriscar a serialização por acidente.
	variables := make([]designReplicaVariable, 0, len(extracted))
	for _, variable := range extracted {
		variables = append(variables, designReplicaVariable{Name: variable.Name, Value: variable.Value})
	}

	listed := sameHostPages(base, source, maxPages)
	blocks := structuralBlocks(source)
	pageTitle := title
	if pageTitle == "" {
		pageTitle = address
	}
	pages := make([]designReplicaPage, 0, len(listed)+1)
	if len(listed) == 0 {
		// Sem base não há URL para listar, mas a página LIDA existe — um
		// `pages` vazio faria a tela concluir que a réplica não achou nada.
		pages = append(pages, designReplicaPage{Title: pageTitle, URL: address, Blocks: blocks})
	} else {
		pages = append(pages, designReplicaPage{Title: pageTitle, URL: listed[0], Blocks: blocks})
		for _, extra := range listed[1:] {
			// O título da página não baixada é a própria URL: inventar um
			// título a partir do caminho seria dado fabricado, e a tela já
			// trata `title || url` como rótulo.
			pages = append(pages, designReplicaPage{Title: extra, URL: extra, Blocks: []string{}})
		}
	}

	return designReplicaPayload{
		URL:   address,
		Title: title,
		Pages: pages,
		Tokens: designReplicaTokens{
			Colors:    nonNilStrings(extractColors(source)),
			Variables: variables,
			Fonts:     nonNilStrings(extractFonts(source)),
			Spacing:   nonNilStrings(extractSpacing(source)),
		},
		// `analysis` é STRING, não objeto: quem a lê primeiro é o modelo, que
		// cita frases; a tela só a exibe. Estrutura aqui seria contrato a mais
		// para manter sem ninguém consumindo os campos.
		Analysis: designAnalysis(source, len(pages)-1),
	}
}

// designAnalysis resume o que a varredura viu do LAYOUT — os mesmos sinais da
// versão em texto, agora numa frase só.
func designAnalysis(source string, extraPages int) string {
	parts := []string{
		"sinais de layout: " + listOr(layoutSignals(source), "nenhum dos observados"),
		fmt.Sprintf("folhas de estilo ligadas: %d", countStylesheets(source)),
		fmt.Sprintf("blocos <style>: %d", countStyleBlocks(source)),
		"animações: " + listOr(extractKeyframes(source), "nenhuma"),
	}
	if extraPages > 0 {
		// O aviso de "não baixadas" sobrevive à mudança de formato de
		// propósito: sem ele o modelo trata a lista como conteúdo lido e
		// responde sobre páginas que ninguém abriu.
		parts = append(parts, fmt.Sprintf(
			"%d página(s) do mesmo host apenas LISTADAS, não baixadas — peça outra chamada para ler alguma",
			extraPages))
	}
	return strings.Join(parts, "; ")
}

/* ----------------------------- blocos da página ---------------------------- */

// designBlockTags é a lista FECHADA de blocos estruturais, na ordem em que
// saem no resultado. Fechada pelo mesmo motivo dos layoutMarkers: tag presente
// é fato; uma lista aberta viraria adivinhação sobre o que é "estrutura".
var designBlockTags = []string{
	"header", "nav", "main", "section", "article", "aside", "footer", "form", "button", "table",
}

// structuralBlocks devolve as tags estruturais presentes no documento.
func structuralBlocks(source string) []string {
	out := make([]string, 0, len(designBlockTags))
	for _, tag := range designBlockTags {
		if hasOpeningTag(source, tag) {
			out = append(out, tag)
		}
	}
	return out
}

// hasOpeningTag procura `<tag` seguida de fim de nome — `<sectioned>` não é
// `<section>`, e sem esta guarda qualquer prefixo contaria (a mesma armadilha
// que countStyleBlocks já trata para `<styles>`).
func hasOpeningTag(source, tag string) bool {
	marker := "<" + tag
	for index := 0; index < len(source); {
		found := indexFold(source[index:], marker)
		if found < 0 {
			return false
		}
		after := index + found + len(marker)
		index = after
		if after >= len(source) || !isNameByte(source[after]) {
			return true
		}
	}
	return false
}

/* ------------------------------- espaçamento ------------------------------- */

// extractSpacing devolve os valores px/rem por frequência decrescente.
//
// A frequência é a informação, como nas cores: o `16px` que aparece 80 vezes é
// a unidade da grade; o `13.7px` que aparece uma vez é acidente. Zero fica de
// fora porque `0px` não é decisão de espaçamento — é ausência dele.
//
// Varredura de bytes, sem regexp, pelo mesmo motivo dos outros extratores
// (ver o bloco de comentário em tools_web.go): o alvo é um token isolado e a
// página inteira é varrida numa passada.
func extractSpacing(source string) []string {
	counts := make(map[string]int)
	first := make(map[string]int)

	for index := 0; index < len(source); index++ {
		if !isDigitByte(source[index]) {
			continue
		}
		// Dígito colado num identificador (`grid2px`, `h1px`) não é medida.
		// O `-` e o `.` NÃO barram: `-16px` é margem negativa e `.5px` é
		// fração sem inteiro — os dois são espaçamento legítimo.
		if index > 0 && isWordByte(source[index-1]) {
			for index+1 < len(source) && isDigitByte(source[index+1]) {
				index++
			}
			continue
		}

		start := index
		end := index
		nonzero := false
		for end < len(source) && isDigitByte(source[end]) {
			if source[end] != '0' {
				nonzero = true
			}
			end++
		}
		// Fração só com dígito depois do ponto: em `5.px` o número acaba no 5.
		if end+1 < len(source) && source[end] == '.' && isDigitByte(source[end+1]) {
			end++
			for end < len(source) && isDigitByte(source[end]) {
				if source[end] != '0' {
					nonzero = true
				}
				end++
			}
		}

		unit := ""
		if asciiHasPrefix(source[end:], "px") {
			unit = "px"
		} else if asciiHasPrefix(source[end:], "rem") {
			unit = "rem"
		}
		if unit == "" || !nonzero {
			index = end - 1
			continue
		}
		// `16pxx` não é medida: a unidade precisa terminar a palavra.
		next := end + len(unit)
		if next < len(source) && isWordByte(source[next]) {
			index = end - 1
			continue
		}

		// A unidade sai normalizada em minúsculas para `16PX` e `16px`
		// contarem como o mesmo valor — senão a ordenação por frequência mente.
		value := source[start:end] + unit
		if _, seen := counts[value]; !seen {
			first[value] = start
		}
		counts[value]++
		index = next - 1
	}

	ordered := make([]string, 0, len(counts))
	for value := range counts {
		ordered = append(ordered, value)
	}
	sort.Slice(ordered, func(a, b int) bool {
		if counts[ordered[a]] != counts[ordered[b]] {
			return counts[ordered[a]] > counts[ordered[b]]
		}
		// Empate pela ordem de aparição, como em extractColors: resultado
		// estável entre execuções, e o que a página usa primeiro vem antes.
		return first[ordered[a]] < first[ordered[b]]
	})
	if len(ordered) > designMaxSpacing {
		ordered = ordered[:designMaxSpacing]
	}
	return ordered
}

/* ---------------------------------- apoio ---------------------------------- */

func isDigitByte(symbol byte) bool {
	return symbol >= '0' && symbol <= '9'
}

// isWordByte é a fronteira de palavra usada pelo espaçamento: letra, dígito ou
// sublinhado. Mais estreita que isNameByte de propósito — o `-` de CSS separa
// palavras (`margin-16px` conta), não as une.
func isWordByte(symbol byte) bool {
	return (symbol >= 'a' && symbol <= 'z') ||
		(symbol >= 'A' && symbol <= 'Z') ||
		isDigitByte(symbol) ||
		symbol == '_'
}

// nonNilStrings troca nil por lista vazia ANTES do Marshal: os extratores de
// tools_web.go devolvem nil quando não acham nada, e nil vira `null` no JSON —
// o parse da tela tolera, mas o contrato promete array, e `null` num campo
// prometido como lista é o tipo de surpresa que só aparece no cliente.
func nonNilStrings(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}
