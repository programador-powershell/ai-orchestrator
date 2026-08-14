// Busca na web e leitura da linguagem visual de uma página.
//
// As duas estavam registradas como "de host" e recusavam sempre. Voltaram para o
// gateway pelo mesmo critério das outras: nenhuma precisa de algo que só a
// estação tem. Busca é uma chamada HTTP com a chave do motor CONTRATADO pelo
// cliente; linguagem visual é varredura de texto sobre um HTML que o guarda de
// rede já sabe baixar sem abrir SSRF.
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

/* ================================ web.search ================================ */

// SearchBackend é o motor de busca configurado.
//
// Não existe "a" API de busca — existe a que o cliente contratou. Por isso o
// motor é configuração e não constante no binário: fixar um provedor padrão
// mandaria a consulta do usuário (que costuma trazer nome de cliente, de sistema
// e de projeto) para um terceiro que ninguém aprovou.
type SearchBackend struct {
	Kind     string `json:"kind"`     // "searxng" | "brave" | "tavily"
	Endpoint string `json:"endpoint"` // URL base
	// SecretRef é o NOME da chave no cofre, nunca a chave. Vazio no searxng, que
	// é auto-hospedado e não pede credencial.
	SecretRef string `json:"secretRef,omitempty"`
}

// Dialetos aceitos em Kind.
const (
	searchKindSearxng = "searxng"
	searchKindBrave   = "brave"
	searchKindTavily  = "tavily"
)

const (
	// searchDefaultLimit e searchMaxLimit existem para o resultado caber no
	// prompt: 40 resultados com trecho ocupam o contexto que o modelo precisa
	// para RESPONDER com eles.
	searchDefaultLimit = 8
	searchMaxLimit     = 20

	searchTitleMax   = 120
	searchSnippetMax = 240
)

// searchSetupHint é a recusa quando não há motor configurado.
//
// Ela diz o arquivo, o campo e os valores possíveis de propósito: o modelo lê
// uma recusa acionável e contorna (pergunta, usa web.fetch, avisa a pessoa),
// enquanto um sucesso vazio ele trata como "a web não tem isso".
const searchSetupHint = `a busca na web não está configurada: preencha o campo "search" em ` +
	`<AIBOT_DATA_DIR>/catalog.json com {"kind":"searxng|brave|tavily","endpoint":"<url base>",` +
	`"secretRef":"<referência da chave no cofre>"} e reinicie o gateway ` +
	`(no searxng o secretRef fica vazio)`

// searchResult é o resultado já normalizado — os três dialetos chamam os mesmos
// campos por nomes diferentes, e a diferença morre aqui.
type searchResult struct {
	Title   string
	URL     string
	Snippet string
}

func (t *Toolbox) webSearch(ctx context.Context, _ string, raw json.RawMessage) (string, error) {
	var args struct {
		Query string `json:"query"`
		Limit int    `json:"limit"`
	}
	if err := decodeArgs(raw, &args); err != nil {
		return "", err
	}
	query := strings.TrimSpace(args.Query)
	if query == "" {
		return "", errors.New("informe o que procurar em \"query\"")
	}
	limit := args.Limit
	if limit <= 0 {
		limit = searchDefaultLimit
	}
	if limit > searchMaxLimit {
		limit = searchMaxLimit
	}

	backend := t.Search
	kind := strings.ToLower(strings.TrimSpace(backend.Kind))
	// A barra final some aqui e não em cada dialeto: um endpoint colado do
	// navegador vem com ela, e "https://busca.interno/" + "/search" é um 404 que
	// parece falha do motor.
	endpoint := strings.TrimRight(strings.TrimSpace(backend.Endpoint), "/")
	// A checagem de configuração vem ANTES da de rede: quem precisa agir sobre
	// esta recusa é quem edita o catalog.json, e "a saída de rede não está
	// disponível" mandaria a pessoa olhar o lugar errado.
	if kind == "" || endpoint == "" {
		return "", errors.New(searchSetupHint)
	}

	// O dialeto é escolhido ANTES de tocar na rede: motor desconhecido é erro de
	// configuração, e quem precisa da recusa é quem edita o catalog.json. O erro
	// ecoa o valor COMO ESTÁ no arquivo, para a pessoa achá-lo lá.
	var dialect func(context.Context, SearchBackend, string, int) ([]searchResult, error)
	switch kind {
	case searchKindSearxng:
		dialect = t.searchSearxng
	case searchKindBrave:
		dialect = t.searchBrave
	case searchKindTavily:
		dialect = t.searchTavily
	default:
		return "", fmt.Errorf("motor de busca %q desconhecido — use searxng, brave ou tavily "+
			"no campo \"search\".\"kind\" de <AIBOT_DATA_DIR>/catalog.json", backend.Kind)
	}
	if t.Net == nil {
		return "", errors.New("a saída de rede não está disponível")
	}
	backend.Kind = kind
	backend.Endpoint = endpoint

	results, err := dialect(ctx, backend, query, limit)
	if err != nil {
		return "", err
	}
	if len(results) > limit {
		results = results[:limit]
	}
	return formatSearchResults(query, results), nil
}

// formatSearchResults devolve TEXTO, não JSON: quem lê isto é o modelo, e uma
// linha por resultado com título, endereço e trecho é o que ele consegue citar
// sem reinterpretar estrutura.
//
// Zero resultado é uma resposta legítima da web e sai como frase — devolver erro
// faria o modelo tentar de novo com a mesma consulta.
func formatSearchResults(query string, results []searchResult) string {
	if len(results) == 0 {
		return fmt.Sprintf("a busca por %q não devolveu nenhum resultado", query)
	}
	var out strings.Builder
	fmt.Fprintf(&out, "%d resultado(s) para %q:\n", len(results), query)
	for index, item := range results {
		title := clip(flatten(item.Title), searchTitleMax)
		if title == "" {
			title = "(sem título)"
		}
		fmt.Fprintf(&out, "%d. %s — %s", index+1, title, flatten(item.URL))
		if snippet := clip(flatten(item.Snippet), searchSnippetMax); snippet != "" {
			fmt.Fprintf(&out, " — %s", snippet)
		}
		out.WriteString("\n")
	}
	return out.String()
}

// searchSearxng é o dialeto recomendado num ambiente corporativo.
//
// O motivo não é técnico e sim de dado: o searxng é AUTO-HOSPEDADO, então a
// consulta — que num dia normal cita cliente, sistema interno e número de
// chamado — não sai para um terceiro; ela morre numa instância da casa. É também
// o único dialeto sem chave, pela mesma razão: a instância é nossa.
// O limite não vai na URL: o contrato do dialeto é só `q`, e a lista é recortada
// depois, em webSearch, para os três motores do mesmo jeito.
func (t *Toolbox) searchSearxng(ctx context.Context, backend SearchBackend, query string, _ int) ([]searchResult, error) {
	target := backend.Endpoint + "/search?q=" + url.QueryEscape(query) + "&format=json&language=pt-BR"
	response, body, err := t.Net.Fetch(ctx, target, http.Header{"Accept": {"application/json"}})
	if err != nil {
		return nil, fmt.Errorf("consultar %s: %w", hostOnly(backend.Endpoint), err)
	}
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s respondeu %d à busca", hostOnly(backend.Endpoint), response.StatusCode)
	}
	return resultsWithContent(body, backend.Endpoint)
}

// searchBrave usa chave no header `X-Subscription-Token`. O limite é aplicado no
// recorte da lista, como no searxng.
func (t *Toolbox) searchBrave(ctx context.Context, backend SearchBackend, query string, _ int) ([]searchResult, error) {
	target := backend.Endpoint + "/res/v1/web/search?q=" + url.QueryEscape(query)

	var results []searchResult
	// O header é montado e a chamada é feita DENTRO do callback do cofre: assim a
	// chave não existe em nenhuma variável deste escopo e não há como ela vazar
	// no retorno nem num erro montado depois.
	err := t.useSearchKey(backend, func(secret string) error {
		header := http.Header{
			"Accept":               {"application/json"},
			"X-Subscription-Token": {secret},
		}
		response, body, err := t.Net.Fetch(ctx, target, header)
		if err != nil {
			return fmt.Errorf("consultar %s: %w", hostOnly(backend.Endpoint), err)
		}
		if response.StatusCode != http.StatusOK {
			// Só o host e o código. O corpo de um 401 costuma repetir a chave
			// enviada, e ele iria inteiro para o histórico da conversa.
			return fmt.Errorf("%s respondeu %d à busca", hostOnly(backend.Endpoint), response.StatusCode)
		}
		var parsed struct {
			Web struct {
				Results []struct {
					Title       string `json:"title"`
					URL         string `json:"url"`
					Description string `json:"description"`
				} `json:"results"`
			} `json:"web"`
		}
		if err := json.Unmarshal(body, &parsed); err != nil {
			return fmt.Errorf("resposta inesperada de %s: %w", hostOnly(backend.Endpoint), err)
		}
		for _, item := range parsed.Web.Results {
			results = append(results, searchResult{Title: item.Title, URL: item.URL, Snippet: item.Description})
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return results, nil
}

// searchTavily manda a chave no CORPO, então o corpo é montado dentro do cofre.
func (t *Toolbox) searchTavily(ctx context.Context, backend SearchBackend, query string, limit int) ([]searchResult, error) {
	target := backend.Endpoint + "/search"

	var results []searchResult
	err := t.useSearchKey(backend, func(secret string) error {
		// A chave vai no JSON, não no header: se o corpo fosse montado fora do
		// callback, o segredo estaria numa fatia de bytes viva no escopo de fora,
		// que é exatamente o que o cofre existe para impedir.
		body, err := json.Marshal(map[string]any{
			"api_key":     secret,
			"query":       query,
			"max_results": limit,
		})
		if err != nil {
			return fmt.Errorf("montar a consulta: %w", err)
		}
		response, payload, err := t.Net.Post(ctx, target, body)
		if err != nil {
			return fmt.Errorf("consultar %s: %w", hostOnly(backend.Endpoint), err)
		}
		if response.StatusCode != http.StatusOK {
			return fmt.Errorf("%s respondeu %d à busca", hostOnly(backend.Endpoint), response.StatusCode)
		}
		results, err = resultsWithContent(payload, backend.Endpoint)
		return err
	})
	if err != nil {
		return nil, err
	}
	return results, nil
}

// resultsWithContent lê o formato {"results":[{title,url,content}]}, que searxng
// e tavily compartilham.
func resultsWithContent(payload []byte, endpoint string) ([]searchResult, error) {
	var parsed struct {
		Results []struct {
			Title   string `json:"title"`
			URL     string `json:"url"`
			Content string `json:"content"`
		} `json:"results"`
	}
	if err := json.Unmarshal(payload, &parsed); err != nil {
		return nil, fmt.Errorf("resposta inesperada de %s: %w", hostOnly(endpoint), err)
	}
	results := make([]searchResult, 0, len(parsed.Results))
	for _, item := range parsed.Results {
		results = append(results, searchResult{Title: item.Title, URL: item.URL, Snippet: item.Content})
	}
	return results, nil
}

// useSearchKey entrega a chave do motor ao callback, recusando com motivo quando
// ela não está cadastrada. A chave nunca é devolvida — este pacote só a USA.
func (t *Toolbox) useSearchKey(backend SearchBackend, fn func(secret string) error) error {
	reference := strings.TrimSpace(backend.SecretRef)
	if reference == "" {
		return fmt.Errorf("o motor %s exige chave: cadastre-a no cofre e aponte a referência em "+
			"\"search\".\"secretRef\" de <AIBOT_DATA_DIR>/catalog.json", backend.Kind)
	}
	if t.Secrets == nil {
		return errors.New("o cofre não está disponível")
	}
	if !t.Secrets.Has(reference) {
		return fmt.Errorf("não há chave cadastrada sob %q — cadastre-a no cofre antes de usar a busca", reference)
	}
	return t.Secrets.Use(reference, fn)
}

// hostOnly reduz uma URL ao host para a mensagem de erro.
//
// O endpoint pode carregar caminho e query, e o erro cru de um cliente HTTP
// costuma trazer a URL inteira. Como o mesmo texto vai para o log e para o
// histórico da conversa, o que sai daqui é só o host.
func hostOnly(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" {
		return "o motor de busca"
	}
	return parsed.Host
}

/* ============================= design.replicate ============================= */

// Os tetos existem para o resultado caber no prompt. Uma página real tem
// centenas de cores e variáveis; despejar todas gastaria o contexto que o modelo
// precisa para USAR o que leu.
const (
	designMaxColors     = 32
	designMaxVariables  = 48
	designMaxFonts      = 12
	designMaxAnimations = 20
	designMaxPages      = 20

	// designMaxSource limita o que é varrido. Além disso o que existe num HTML é
	// carga de renderização (JSON embutido, base64 de imagem), não linguagem
	// visual — e cada extrator faz uma passada sobre o texto.
	designMaxSource = 2 << 20

	// designMaxAnchors limita a varredura de links: numa listagem paginada há
	// milhares deles, e o teto de páginas é 20.
	designMaxAnchors = 500

	designValueWindow    = 160
	designVariableWindow = 96
	designFunctionWindow = 96
)

// cssVariable é um par `--nome: valor`.
type cssVariable struct {
	Name  string
	Value string
}

func (t *Toolbox) designReplicate(ctx context.Context, _ string, raw json.RawMessage) (string, error) {
	if t.Net == nil {
		return "", errors.New("a saída de rede não está disponível")
	}
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

	response, body, err := t.Net.Fetch(ctx, args.URL, http.Header{"Accept": {"text/html"}})
	if err != nil {
		return "", err
	}
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("a página respondeu %d", response.StatusCode)
	}
	// Só HTML. Um PDF, um JSON ou uma imagem passariam pela varredura sem erro e
	// devolveriam uma lista de "cores" tirada de bytes binários — resultado
	// inventado é pior que recusa, porque o modelo acredita nele.
	contentType := strings.ToLower(strings.TrimSpace(response.Header.Get("Content-Type")))
	if !strings.Contains(contentType, "text/html") {
		return "", fmt.Errorf("a linguagem visual é extraída de html e a resposta veio como %s",
			orDefault(contentType, "conteúdo sem tipo declarado"))
	}

	// A base dos links relativos é a URL FINAL, depois dos redirecionamentos: um
	// http:// que vira https://www. resolveria `/precos` no host errado.
	base := response.Request.URL
	if base == nil {
		if parsed, err := url.Parse(args.URL); err == nil {
			base = parsed
		}
	}

	source := clipBytes(string(body), designMaxSource)
	return formatDesign(base, source, args.MaxPages), nil
}

// formatDesign monta o texto em seções. Separado da ferramenta porque é função
// pura sobre o HTML — o que permite testá-la sem rede.
func formatDesign(base *url.URL, source string, maxPages int) string {
	var out strings.Builder

	address := "a página"
	if base != nil {
		address = base.String()
	}
	fmt.Fprintf(&out, "linguagem visual de %s", address)
	if title := extractTitle(source); title != "" {
		fmt.Fprintf(&out, " — %s", title)
	}
	out.WriteString("\n\n")

	colors := extractColors(source)
	fmt.Fprintf(&out, "## Cores (%d, da mais frequente para a menos)\n", len(colors))
	writeList(&out, colors, "(nenhuma cor reconhecida)")

	variables := extractCSSVariables(source)
	fmt.Fprintf(&out, "\n## Variáveis CSS (%d)\n", len(variables))
	if len(variables) == 0 {
		out.WriteString("(nenhuma)\n")
	}
	for _, variable := range variables {
		fmt.Fprintf(&out, "%s: %s\n", variable.Name, variable.Value)
	}

	fonts := extractFonts(source)
	fmt.Fprintf(&out, "\n## Fontes (%d)\n", len(fonts))
	writeList(&out, fonts, "(nenhuma declarada)")

	animations := extractKeyframes(source)
	fmt.Fprintf(&out, "\n## Animações (%d)\n", len(animations))
	writeList(&out, animations, "(nenhuma)")

	out.WriteString("\n## Layout\n")
	signals := layoutSignals(source)
	fmt.Fprintf(&out, "sinais: %s\n", listOr(signals, "nenhum dos observados"))
	fmt.Fprintf(&out, "folhas de estilo ligadas: %d; blocos <style>: %d\n",
		countStylesheets(source), countStyleBlocks(source))

	pages := sameHostPages(base, source, maxPages)
	fmt.Fprintf(&out, "\n## Páginas do mesmo host (%d)\n", len(pages))
	writeList(&out, pages, "(nenhuma)")
	out.WriteString("as páginas acima NÃO foram baixadas — só listadas\n")

	return out.String()
}

func writeList(out *strings.Builder, values []string, empty string) {
	if len(values) == 0 {
		out.WriteString(empty + "\n")
		return
	}
	for _, value := range values {
		out.WriteString(value + "\n")
	}
}

func listOr(values []string, empty string) string {
	if len(values) == 0 {
		return empty
	}
	return strings.Join(values, ", ")
}

/* ------------------------------- extratores -------------------------------- */
//
// Tudo daqui para baixo é VARREDURA de string, sem parser de HTML e sem regexp
// sobre a página inteira. O alvo são TOKENS — uma cor, um nome de variável, um
// nome de fonte, um nome de animação —, e nenhum deles depende de quem é pai de
// quem no documento. Montar a árvore só seria necessário para remontar o layout,
// que não é o objetivo; para token, varredura basta, roda numa passada e não traz
// dependência de terceiro para o processo que guarda chave de provedor.

// extractColors devolve as cores por frequência decrescente.
//
// A ordenação é a informação: a cor que aparece 200 vezes é a identidade da
// página; a que aparece uma vez é acidente (um ícone, um estado de erro). Cortar
// as 32 primeiras de uma lista alfabética entregaria o acidente e esconderia a
// identidade.
func extractColors(source string) []string {
	counts := make(map[string]int)
	first := make(map[string]int)

	for index := 0; index < len(source); index++ {
		var (
			value string
			width int
		)
		switch source[index] {
		case '#':
			value, width = hexColorAt(source, index)
		case 'r', 'R', 'h', 'H':
			value, width = functionalColorAt(source, index)
		}
		if width == 0 {
			continue
		}
		if _, seen := counts[value]; !seen {
			first[value] = index
		}
		counts[value]++
		// -1 porque o próprio laço avança um byte.
		index += width - 1
	}

	ordered := make([]string, 0, len(counts))
	for value := range counts {
		ordered = append(ordered, value)
	}
	sort.Slice(ordered, func(a, b int) bool {
		if counts[ordered[a]] != counts[ordered[b]] {
			return counts[ordered[a]] > counts[ordered[b]]
		}
		// Empate pela ordem de aparição, e não pelo alfabeto: mantém o resultado
		// estável entre execuções e coloca antes o que a página mostra primeiro.
		return first[ordered[a]] < first[ordered[b]]
	})
	if len(ordered) > designMaxColors {
		ordered = ordered[:designMaxColors]
	}
	return ordered
}

// hexColorAt lê a cor hexadecimal que começa no '#' de `index` e devolve o valor
// normalizado e quantos bytes ela ocupou.
//
// As formas curtas são EXPANDIDAS (#ABC vira #aabbcc) porque a mesma cor escrita
// de dois jeitos precisa contar como uma só — senão a ordenação por frequência
// mente. A de 4 dígitos vira 8 e não 6: o quarto dígito é o alfa, e
// transparência é decisão de design, não ruído a descartar.
func hexColorAt(source string, index int) (string, int) {
	digits := 0
	for digits < 8 && index+1+digits < len(source) && isHexDigit(source[index+1+digits]) {
		digits++
	}
	size := 0
	switch {
	case digits >= 8:
		size = 8
	case digits >= 6:
		size = 6
	case digits >= 4:
		size = 4
	case digits >= 3:
		size = 3
	default:
		return "", 0
	}

	raw := asciiLower(source[index+1 : index+1+size])
	if size == 3 || size == 4 {
		var expanded strings.Builder
		for position := 0; position < size; position++ {
			expanded.WriteByte(raw[position])
			expanded.WriteByte(raw[position])
		}
		raw = expanded.String()
	}
	return "#" + raw, size + 1
}

// colorFunctions são as notações funcionais reconhecidas, em minúsculas.
var colorFunctions = []string{"rgba(", "rgb(", "hsla(", "hsl("}

// functionalColorAt lê `rgb()/rgba()/hsl()/hsla()` começando em `index`.
func functionalColorAt(source string, index int) (string, int) {
	// Um caractere de nome logo antes indica que isto é o fim de um
	// identificador (`--brand-rgb(`, `toRgb(`), não uma cor.
	if index > 0 && isNameByte(source[index-1]) {
		return "", 0
	}
	for _, prefix := range colorFunctions {
		if !asciiHasPrefix(source[index:], prefix) {
			continue
		}
		window := source[index:min(len(source), index+designFunctionWindow)]
		end := strings.IndexByte(window, ')')
		if end < 0 {
			return "", 0
		}
		return normalizeFunctional(window[:end+1]), end + 1
	}
	return "", 0
}

// normalizeFunctional deixa `rgb(255, 0, 0)` e `RGB(255,0,0)` idênticos.
//
// O espaço some junto de '(' e ',' — onde é só formatação — e sobrevive no meio
// dos componentes, onde a sintaxe moderna o usa como separador
// (`rgb(255 0 0 / 50%)`). Apagar todos juntaria os números num valor inventado.
func normalizeFunctional(raw string) string {
	lower := asciiLower(raw)
	out := make([]byte, 0, len(lower))
	pending := false
	for position := 0; position < len(lower); position++ {
		symbol := lower[position]
		if isSpaceByte(symbol) {
			pending = true
			continue
		}
		if pending && len(out) > 0 {
			previous := out[len(out)-1]
			if previous != '(' && previous != ',' && symbol != ')' && symbol != ',' {
				out = append(out, ' ')
			}
		}
		pending = false
		out = append(out, symbol)
	}
	return string(out)
}

// extractCSSVariables lê as declarações `--nome: valor`.
//
// O ':' precisa vir logo depois do nome (até quatro caracteres de espaço) — é o
// que separa uma DECLARAÇÃO de um USO: `var(--cor-de-fundo)` tem o mesmo começo
// e nenhum valor a oferecer.
func extractCSSVariables(source string) []cssVariable {
	var out []cssVariable
	seen := make(map[string]bool)

	for index := 0; index+1 < len(source); {
		found := strings.Index(source[index:], "--")
		if found < 0 {
			break
		}
		start := index + found + 2
		index = start

		length := 0
		for start+length < len(source) && isNameByte(source[start+length]) {
			length++
		}
		if length < 2 {
			continue
		}
		rest := source[start+length:]
		colon := strings.IndexByte(rest[:min(len(rest), 5)], ':')
		if colon < 0 {
			continue
		}
		value := clipBytes(rest[colon+1:], designVariableWindow)
		if end := strings.IndexAny(value, ";}"); end >= 0 {
			value = value[:end]
		}
		value = flatten(value)
		if value == "" {
			continue
		}
		name := "--" + source[start:start+length]
		if seen[name] {
			continue
		}
		seen[name] = true
		out = append(out, cssVariable{Name: name, Value: value})
		if len(out) >= designMaxVariables {
			break
		}
	}
	return out
}

// genericFonts são as famílias que cada máquina resolve como quiser. Aparecem em
// quase toda pilha e não dizem nada sobre a identidade da página — deixá-las
// entrar gastaria as 12 vagas com "sans-serif".
var genericFonts = map[string]bool{
	"serif":      true,
	"sans-serif": true,
	"monospace":  true,
	"system-ui":  true,
}

// extractFonts separa a pilha de `font-family:` em nomes.
func extractFonts(source string) []string {
	var out []string
	seen := make(map[string]bool)

	for _, stack := range scanValues(source, "font-family:", designValueWindow) {
		for _, candidate := range strings.Split(stack, ",") {
			// As aspas são do CSS, não do nome: `"Helvetica Neue"` e
			// `Helvetica Neue` são a mesma fonte e precisam contar como uma.
			name := flatten(strings.Trim(strings.TrimSpace(candidate), `"'`))
			if name == "" {
				continue
			}
			key := strings.ToLower(name)
			if genericFonts[key] || seen[key] {
				continue
			}
			seen[key] = true
			out = append(out, name)
			if len(out) >= designMaxFonts {
				return out
			}
		}
	}
	return out
}

// extractKeyframes devolve os nomes das animações declaradas.
func extractKeyframes(source string) []string {
	var out []string
	seen := make(map[string]bool)

	for index := 0; index < len(source); {
		found := indexFold(source[index:], "@keyframes")
		if found < 0 {
			break
		}
		start := index + found + len("@keyframes")
		index = start

		cursor := start
		for cursor < len(source) && isSpaceByte(source[cursor]) {
			cursor++
		}
		end := cursor
		for end < len(source) && isNameByte(source[end]) {
			end++
		}
		if end == cursor {
			continue
		}
		name := source[cursor:end]
		key := strings.ToLower(name)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, name)
		if len(out) >= designMaxAnimations {
			break
		}
	}
	return out
}

// layoutMarkers são os sinais de COMO a página se organiza. É uma lista fechada
// de propósito: sinal presente é fato, e uma lista aberta viraria adivinhação.
var layoutMarkers = []string{
	"display:grid",
	"display:flex",
	"position:sticky",
	"container-type",
	"@media",
	"backdrop-filter",
	"clamp(",
}

// layoutSignals devolve os marcadores presentes.
//
// A busca é feita sobre o texto sem espaço nenhum: `display : grid` e
// `display:grid` são a mesma decisão escrita de dois jeitos, e um minificador não
// é obrigado a concordar com o autor sobre onde cabe espaço.
func layoutSignals(source string) []string {
	squeezed := squeeze(source)
	var out []string
	for _, marker := range layoutMarkers {
		if strings.Contains(squeezed, marker) {
			out = append(out, marker)
		}
	}
	return out
}

// countStylesheets conta as tags <link> que trazem "stylesheet".
//
// Contar a palavra solta no documento (o que a versão anterior fazia) infla o
// número com qualquer menção em script ou comentário.
func countStylesheets(source string) int {
	count := 0
	for index := 0; index < len(source); {
		found := indexFold(source[index:], "<link")
		if found < 0 {
			break
		}
		start := index + found + len("<link")
		index = start
		tag := clipBytes(source[start:], 800)
		if end := strings.IndexByte(tag, '>'); end >= 0 {
			tag = tag[:end]
			index = start + end
		}
		if indexFold(tag, "stylesheet") >= 0 {
			count++
		}
	}
	return count
}

// countStyleBlocks conta os blocos <style>.
func countStyleBlocks(source string) int {
	count := 0
	for index := 0; index < len(source); {
		found := indexFold(source[index:], "<style")
		if found < 0 {
			break
		}
		start := index + found + len("<style")
		index = start
		// `<styles>` não é bloco de estilo: o que vem depois do nome da tag tem
		// de separá-la do atributo.
		if start < len(source) && isNameByte(source[start]) {
			continue
		}
		count++
	}
	return count
}

// sameHostPages lista os links do MESMO host — e só LISTA.
//
// Baixar as N páginas seria trivial e é justamente o que não se faz: um prompt
// viraria, sozinho, um rastreador contra um site de terceiro saindo do IP da
// empresa. Quem quiser outra página pede outra chamada, e ela passa pelo portão
// de permissão de novo.
//
// A primeira entrada é a própria página lida — por isso o padrão de 1 devolve só
// ela, que é a forma de dizer "não quero listagem".
func sameHostPages(base *url.URL, source string, maxPages int) []string {
	if base == nil {
		return nil
	}
	if maxPages < 1 {
		maxPages = 1
	}
	if maxPages > designMaxPages {
		maxPages = designMaxPages
	}

	origin := *base
	origin.Fragment = ""
	pages := []string{origin.String()}
	if maxPages == 1 {
		return pages
	}
	seen := map[string]bool{origin.RequestURI(): true}

	for _, href := range scanAnchorHrefs(source) {
		target, err := origin.Parse(href)
		if err != nil {
			continue
		}
		if target.Scheme != "http" && target.Scheme != "https" {
			continue
		}
		if !strings.EqualFold(target.Host, origin.Host) {
			continue
		}
		target.Fragment = ""
		key := target.RequestURI()
		if seen[key] {
			continue
		}
		seen[key] = true
		pages = append(pages, target.String())
		if len(pages) >= maxPages {
			break
		}
	}
	return pages
}

// scanAnchorHrefs devolve o href de cada <a>, na ordem do documento.
func scanAnchorHrefs(source string) []string {
	var hrefs []string
	for index := 0; index < len(source); {
		found := indexFold(source[index:], "<a")
		if found < 0 {
			break
		}
		start := index + found + len("<a")
		index = start
		// `<article` e `<aside` também começam com `<a`.
		if start < len(source) && isNameByte(source[start]) {
			continue
		}
		end := strings.IndexByte(source[start:], '>')
		if end < 0 {
			break
		}
		tag := source[start : start+end]
		index = start + end
		if value, ok := attributeValue(tag, "href"); ok {
			hrefs = append(hrefs, value)
		}
		if len(hrefs) >= designMaxAnchors {
			break
		}
	}
	return hrefs
}

// attributeValue lê o valor de um atributo dentro do texto de uma tag, aceitando
// aspas duplas, simples ou nenhuma.
func attributeValue(tag, name string) (string, bool) {
	for index := 0; index < len(tag); {
		found := indexFold(tag[index:], name)
		if found < 0 {
			return "", false
		}
		at := index + found
		index = at + len(name)
		// `data-href` e `xlink:href` não são o atributo procurado.
		if at > 0 && isNameByte(tag[at-1]) {
			continue
		}
		cursor := index
		for cursor < len(tag) && isSpaceByte(tag[cursor]) {
			cursor++
		}
		if cursor >= len(tag) || tag[cursor] != '=' {
			continue
		}
		cursor++
		for cursor < len(tag) && isSpaceByte(tag[cursor]) {
			cursor++
		}
		if cursor >= len(tag) {
			return "", false
		}
		var value string
		switch tag[cursor] {
		case '"', '\'':
			quote := tag[cursor]
			cursor++
			end := strings.IndexByte(tag[cursor:], quote)
			if end < 0 {
				return "", false
			}
			value = tag[cursor : cursor+end]
		default:
			end := cursor
			for end < len(tag) && !isSpaceByte(tag[end]) {
				end++
			}
			value = tag[cursor:end]
		}
		// `&amp;` é a única entidade que aparece de rotina dentro de uma URL em
		// HTML, e deixá-la passar quebraria a query do link.
		value = strings.TrimSpace(strings.ReplaceAll(value, "&amp;", "&"))
		return value, value != ""
	}
	return "", false
}

// extractTitle devolve o <title> da página, achatado.
func extractTitle(source string) string {
	open := indexFold(source, "<title")
	if open < 0 {
		return ""
	}
	start := strings.IndexByte(source[open:], '>')
	if start < 0 {
		return ""
	}
	start += open + 1
	end := indexFold(source[start:], "</title>")
	if end < 0 {
		return ""
	}
	return clip(flatten(source[start:start+end]), 160)
}

// scanValues devolve o valor de cada ocorrência de `marker` (em minúsculas) até
// ';' ou '}', com janela limitada.
func scanValues(source, marker string, window int) []string {
	var values []string
	for index := 0; index < len(source); {
		found := indexFold(source[index:], marker)
		if found < 0 {
			break
		}
		start := index + found + len(marker)
		index = start

		value := clipBytes(source[start:], window)
		if end := strings.IndexAny(value, ";}"); end >= 0 {
			value = value[:end]
		}
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			values = append(values, trimmed)
		}
		// O teto é de VALORES lidos, não de resultados: sem ele uma página
		// minificada com milhares de declarações faria uma passada inútil.
		if len(values) >= 64 {
			break
		}
	}
	return values
}

/* ---------------------------------- apoio ---------------------------------- */

// asciiLower baixa a caixa PRESERVANDO o comprimento em bytes.
//
// strings.ToLower não serve onde o índice importa: ele conhece Unicode, e um 'İ'
// vira dois runes — todo índice achado na cópia passaria a apontar para o lugar
// errado no original.
func asciiLower(text string) string {
	out := []byte(text)
	for position := range out {
		out[position] = lowerByte(out[position])
	}
	return string(out)
}

func lowerByte(symbol byte) byte {
	if symbol >= 'A' && symbol <= 'Z' {
		return symbol + ('a' - 'A')
	}
	return symbol
}

// asciiHasPrefix compara com um prefixo JÁ em minúsculas, sem alocar.
func asciiHasPrefix(text, prefix string) bool {
	if len(text) < len(prefix) {
		return false
	}
	for position := 0; position < len(prefix); position++ {
		if lowerByte(text[position]) != prefix[position] {
			return false
		}
	}
	return true
}

// indexFold acha `marker` (já em minúsculas) ignorando a caixa do ASCII, sem
// criar uma cópia minúscula do documento a cada chamada.
func indexFold(text, marker string) int {
	if marker == "" {
		return 0
	}
	for position := 0; position+len(marker) <= len(text); position++ {
		if lowerByte(text[position]) != marker[0] {
			continue
		}
		if asciiHasPrefix(text[position:], marker) {
			return position
		}
	}
	return -1
}

// squeeze devolve o texto em minúsculas e sem espaço nenhum.
func squeeze(source string) string {
	out := make([]byte, 0, len(source))
	for position := 0; position < len(source); position++ {
		symbol := source[position]
		if isSpaceByte(symbol) {
			continue
		}
		out = append(out, lowerByte(symbol))
	}
	return string(out)
}

// flatten junta o texto numa linha só. Título e trecho vindos de HTML trazem
// quebra e indentação, e uma linha por resultado deixa de ser uma linha.
func flatten(text string) string {
	return strings.Join(strings.Fields(text), " ")
}

// clip corta anunciando o corte com reticências, para o modelo saber que o
// trecho continua.
func clip(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	return strings.TrimSpace(clipBytes(text, limit)) + "…"
}

// clipBytes corta em fronteira de rune e sem avisar.
//
// A fronteira não é preciosismo: o HTML vem de uma página que alguém apontou, e
// um acento ou emoji atravessando o limite viraria U+FFFD no meio de um valor.
func clipBytes(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	cut := limit
	for cut > 0 && !isRuneStart(text[cut]) {
		cut--
	}
	return text[:cut]
}

func isHexDigit(symbol byte) bool {
	return (symbol >= '0' && symbol <= '9') ||
		(symbol >= 'a' && symbol <= 'f') ||
		(symbol >= 'A' && symbol <= 'F')
}

// isNameByte cobre o que forma um identificador em CSS e em HTML.
func isNameByte(symbol byte) bool {
	return (symbol >= 'a' && symbol <= 'z') ||
		(symbol >= 'A' && symbol <= 'Z') ||
		(symbol >= '0' && symbol <= '9') ||
		symbol == '-' || symbol == '_'
}

func isSpaceByte(symbol byte) bool {
	switch symbol {
	case ' ', '\t', '\n', '\r', '\f', '\v':
		return true
	default:
		return false
	}
}
