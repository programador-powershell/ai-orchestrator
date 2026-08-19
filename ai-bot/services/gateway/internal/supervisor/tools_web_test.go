// Testes dos extratores de linguagem visual e da recusa da busca.
//
// Nenhum teste daqui toca a rede: tudo o que importa em design.replicate é
// função PURA sobre o HTML, e o que importa em web.search antes da primeira
// chamada é a recusa por falta de configuração. O que sobra — o dialeto HTTP de
// cada motor — só se testa de verdade contra o motor de verdade, e um servidor
// falso dentro do teste só provaria que o teste concorda consigo mesmo.
package supervisor

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"testing"
)

func equalStrings(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for index := range got {
		if got[index] != want[index] {
			return false
		}
	}
	return true
}

/* --------------------------------- cores --------------------------------- */

func TestExtractColorsOrdersByFrequency(t *testing.T) {
	source := `<style>
  body { background: #0B1220; color: #FFF; }
  .a { border-color: #0b1220; }
  .b { outline-color: #0b1220; }
  .c { color: rgb(255, 0, 0); }
  .d { color: RGB(255,0,0); }
  .e { color: hsla(210, 50%, 40%, .5); }
</style>`

	got := extractColors(source)
	want := []string{"#0b1220", "rgb(255,0,0)", "#ffffff", "hsla(210,50%,40%,.5)"}
	if !equalStrings(got, want) {
		t.Fatalf("extractColors: esperava %v, obteve %v", want, got)
	}
}

func TestExtractColorsNormalizesShortForms(t *testing.T) {
	cases := []struct {
		source string
		want   string
		why    string
	}{
		{"color:#ABC;", "#aabbcc", "3 dígitos viram 6, em minúsculas"},
		{"color:#abcd;", "#aabbccdd", "4 dígitos viram 8 e preservam o alfa"},
		{"color:#0B1220;", "#0b1220", "6 dígitos só baixam a caixa"},
		{"color:#0b1220ff;", "#0b1220ff", "8 dígitos passam inteiros"},
		{"color:rgba( 0 , 0 , 0 , .4 );", "rgba(0,0,0,.4)", "espaço de formatação some"},
		{"color:rgb(255 0 0 / 50%);", "rgb(255 0 0 / 50%)", "espaço de sintaxe fica"},
		{"color:HSL(210,50%,40%);", "hsl(210,50%,40%)", "a função baixa a caixa"},
	}
	for _, each := range cases {
		got := extractColors(each.source)
		if len(got) != 1 || got[0] != each.want {
			t.Errorf("extractColors(%q): esperava [%s] (%s), obteve %v",
				each.source, each.want, each.why, got)
		}
	}
}

func TestExtractColorsIgnoresWhatIsNotColor(t *testing.T) {
	// `#top` não tem dígito hexadecimal suficiente e `toRgb(` é o fim de um
	// identificador, não uma cor.
	source := `<a href="#top">topo</a><script>const x = toRgb(1,2,3); const y = "#zz";</script>`
	if got := extractColors(source); len(got) != 0 {
		t.Fatalf("extractColors: esperava nenhuma cor, obteve %v", got)
	}
}

func TestExtractColorsRespectsCeiling(t *testing.T) {
	var source strings.Builder
	for index := 1; index <= designMaxColors+10; index++ {
		fmt.Fprintf(&source, ".c%d{color:#%06x}\n", index, index)
	}
	got := extractColors(source.String())
	if len(got) != designMaxColors {
		t.Fatalf("extractColors: esperava o teto de %d cores, obteve %d", designMaxColors, len(got))
	}
}

/* ------------------------------- variáveis -------------------------------- */

func TestExtractCSSVariablesReadsDeclarationsOnly(t *testing.T) {
	source := `:root { --bg: #0b1220; --fg : #ffffff; --shadow: 0 1px 2px rgba(0,0,0,.4) }
.x { color: var(--bg); background: var(--fg) }
:root { --bg: #000 }`

	got := extractCSSVariables(source)
	want := []cssVariable{
		{Name: "--bg", Value: "#0b1220"},
		{Name: "--fg", Value: "#ffffff"},
		{Name: "--shadow", Value: "0 1px 2px rgba(0,0,0,.4)"},
	}
	if len(got) != len(want) {
		t.Fatalf("extractCSSVariables: esperava %d variáveis, obteve %d (%v)", len(want), len(got), got)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Errorf("variável %d: esperava %+v, obteve %+v", index, want[index], got[index])
		}
	}
}

func TestExtractCSSVariablesRespectsCeiling(t *testing.T) {
	var source strings.Builder
	source.WriteString(":root{")
	for index := 0; index < designMaxVariables+12; index++ {
		fmt.Fprintf(&source, "--token-%d: %dpx;", index, index)
	}
	source.WriteString("}")
	got := extractCSSVariables(source.String())
	if len(got) != designMaxVariables {
		t.Fatalf("extractCSSVariables: esperava o teto de %d, obteve %d", designMaxVariables, len(got))
	}
}

/* --------------------------------- fontes --------------------------------- */

func TestExtractFontsSplitsStackAndDropsGenerics(t *testing.T) {
	source := `body { font-family: "Helvetica Neue", Inter, sans-serif; }
h1 { FONT-FAMILY: 'Space Grotesk', Inter, monospace }
code { font-family: system-ui, serif; }`

	got := extractFonts(source)
	want := []string{"Helvetica Neue", "Inter", "Space Grotesk"}
	if !equalStrings(got, want) {
		t.Fatalf("extractFonts: esperava %v, obteve %v", want, got)
	}
}

func TestExtractFontsRespectsCeiling(t *testing.T) {
	var source strings.Builder
	for index := 0; index < designMaxFonts+5; index++ {
		fmt.Fprintf(&source, ".f%d{font-family: Fonte%d, sans-serif}\n", index, index)
	}
	got := extractFonts(source.String())
	if len(got) != designMaxFonts {
		t.Fatalf("extractFonts: esperava o teto de %d, obteve %d", designMaxFonts, len(got))
	}
}

/* -------------------------------- animações ------------------------------- */

func TestExtractKeyframesDeduplicates(t *testing.T) {
	source := `@keyframes fadeIn { from { opacity: 0 } }
@KEYFRAMES   slide-up { to { transform: none } }
@keyframes fadeIn { from { opacity: 0 } }`

	got := extractKeyframes(source)
	want := []string{"fadeIn", "slide-up"}
	if !equalStrings(got, want) {
		t.Fatalf("extractKeyframes: esperava %v, obteve %v", want, got)
	}
}

func TestExtractKeyframesRespectsCeiling(t *testing.T) {
	var source strings.Builder
	for index := 0; index < designMaxAnimations+7; index++ {
		fmt.Fprintf(&source, "@keyframes anim%d{}\n", index)
	}
	got := extractKeyframes(source.String())
	if len(got) != designMaxAnimations {
		t.Fatalf("extractKeyframes: esperava o teto de %d, obteve %d", designMaxAnimations, len(got))
	}
}

/* --------------------------------- layout --------------------------------- */

func TestLayoutSignalsIgnoresWhitespace(t *testing.T) {
	source := `.a{display: grid}.b{display:flex}.c{position :
	sticky}@media (min-width: 40rem){.d{font-size: clamp(1rem, 2vw, 2rem)}}`

	got := layoutSignals(source)
	want := []string{"display:grid", "display:flex", "position:sticky", "@media", "clamp("}
	if !equalStrings(got, want) {
		t.Fatalf("layoutSignals: esperava %v, obteve %v", want, got)
	}
}

func TestLayoutSignalsEmptyWhenAbsent(t *testing.T) {
	if got := layoutSignals(`<p>texto sem estilo nenhum</p>`); len(got) != 0 {
		t.Fatalf("layoutSignals: esperava nenhum sinal, obteve %v", got)
	}
}

func TestCountsStylesheetsAndStyleBlocks(t *testing.T) {
	source := `<link rel="stylesheet" href="a.css">
<link rel=preload as=style href="b.css">
<LINK REL="Stylesheet" HREF="c.css">
<style>a{}</style><style type="text/css">b{}</style>
<p>a palavra stylesheet aqui não conta</p>`

	if got := countStylesheets(source); got != 2 {
		t.Errorf("countStylesheets: esperava 2, obteve %d", got)
	}
	if got := countStyleBlocks(source); got != 2 {
		t.Errorf("countStyleBlocks: esperava 2, obteve %d", got)
	}
}

/* --------------------------------- páginas -------------------------------- */

const pageLinks = `
<a href="/precos">Preços</a>
<a href='/precos'>de novo</a>
<a href="https://exemplo.com/sobre">Sobre</a>
<a href="https://outro.com/x">Outro host</a>
<a href="mailto:alguem@exemplo.com">E-mail</a>
<a href="#topo">Topo</a>
<article><a href=/contato class="cta">Contato</a></article>
`

func TestSameHostPagesKeepsOnlyTheSameHost(t *testing.T) {
	base, err := url.Parse("https://exemplo.com/inicio")
	if err != nil {
		t.Fatalf("url de teste inválida: %v", err)
	}
	got := sameHostPages(base, pageLinks, 3)
	want := []string{
		"https://exemplo.com/inicio",
		"https://exemplo.com/precos",
		"https://exemplo.com/sobre",
	}
	if !equalStrings(got, want) {
		t.Fatalf("sameHostPages: esperava %v, obteve %v", want, got)
	}
}

func TestSameHostPagesDefaultListsOnlyTheOwnPage(t *testing.T) {
	base, err := url.Parse("https://exemplo.com/inicio")
	if err != nil {
		t.Fatalf("url de teste inválida: %v", err)
	}
	// maxPages ausente (0) vira 1: o padrão é NÃO listar as outras páginas.
	got := sameHostPages(base, pageLinks, 0)
	want := []string{"https://exemplo.com/inicio"}
	if !equalStrings(got, want) {
		t.Fatalf("sameHostPages: esperava %v, obteve %v", want, got)
	}
}

func TestSameHostPagesClampsCeiling(t *testing.T) {
	base, err := url.Parse("https://exemplo.com/inicio")
	if err != nil {
		t.Fatalf("url de teste inválida: %v", err)
	}
	// 99 é cortado em 20; aqui só existem 4 destinos únicos do mesmo host.
	got := sameHostPages(base, pageLinks, 99)
	want := []string{
		"https://exemplo.com/inicio",
		"https://exemplo.com/precos",
		"https://exemplo.com/sobre",
		"https://exemplo.com/contato",
	}
	if !equalStrings(got, want) {
		t.Fatalf("sameHostPages: esperava %v, obteve %v", want, got)
	}
}

func TestSameHostPagesCeilingCutsTheList(t *testing.T) {
	base, err := url.Parse("https://exemplo.com/inicio")
	if err != nil {
		t.Fatalf("url de teste inválida: %v", err)
	}
	var source strings.Builder
	for index := 0; index < 40; index++ {
		fmt.Fprintf(&source, `<a href="/p%d">p%d</a>`, index, index)
	}
	if got := sameHostPages(base, source.String(), 99); len(got) != designMaxPages {
		t.Fatalf("sameHostPages: esperava o teto de %d, obteve %d", designMaxPages, len(got))
	}
}

/* ------------------------------- web.search -------------------------------- */
// (Os testes do relatório em TEXTO do design.replicate morreram junto com o
// formatDesign: a versão estruturada, que o substituiu, tem cobertura própria
// em tools_design_test.go.)

func TestWebSearchRefusesWithoutBackend(t *testing.T) {
	toolbox := &Toolbox{}
	_, err := toolbox.webSearch(context.Background(), "sessao", json.RawMessage(`{"query":"prazo do fgts"}`))
	if err == nil {
		t.Fatal("webSearch: esperava recusa sem motor configurado")
	}
	// A recusa precisa ser ACIONÁVEL: arquivo, campo e valores possíveis.
	for _, marker := range []string{"catalog.json", `"search"`, "searxng", "brave", "tavily"} {
		if !strings.Contains(err.Error(), marker) {
			t.Errorf("a recusa não cita %q: %v", marker, err)
		}
	}
}

func TestWebSearchRefusesUnknownKind(t *testing.T) {
	toolbox := &Toolbox{Search: SearchBackend{Kind: "duckduckgo", Endpoint: "https://exemplo.com"}}
	_, err := toolbox.webSearch(context.Background(), "sessao", json.RawMessage(`{"query":"x"}`))
	if err == nil {
		t.Fatal("webSearch: esperava recusa com motor desconhecido")
	}
	if !strings.Contains(err.Error(), "duckduckgo") || !strings.Contains(err.Error(), "catalog.json") {
		t.Errorf("a recusa não diz o que está errado nem onde arrumar: %v", err)
	}
}

func TestWebSearchRefusesEmptyQuery(t *testing.T) {
	toolbox := &Toolbox{Search: SearchBackend{Kind: "searxng", Endpoint: "https://busca.exemplo.com"}}
	if _, err := toolbox.webSearch(context.Background(), "sessao", json.RawMessage(`{"query":"   "}`)); err == nil {
		t.Fatal("webSearch: esperava recusa com consulta vazia")
	}
}

func TestFormatSearchResultsIsOneLinePerResult(t *testing.T) {
	results := []searchResult{
		{Title: "Primeiro\n  resultado", URL: "https://a.exemplo.com/1", Snippet: "trecho\tcom  espaço"},
		{Title: "", URL: "https://b.exemplo.com/2"},
	}
	text := formatSearchResults("consulta", results)
	lines := strings.Split(strings.TrimRight(text, "\n"), "\n")
	if len(lines) != 3 {
		t.Fatalf("esperava cabeçalho e uma linha por resultado, obteve %d linhas:\n%s", len(lines), text)
	}
	if !strings.HasPrefix(lines[1], "1. Primeiro resultado — https://a.exemplo.com/1 — trecho com espaço") {
		t.Errorf("linha do primeiro resultado fora do formato: %q", lines[1])
	}
	if !strings.HasPrefix(lines[2], "2. (sem título) — https://b.exemplo.com/2") {
		t.Errorf("linha do segundo resultado fora do formato: %q", lines[2])
	}
}

func TestFormatSearchResultsEmptyIsAnAnswer(t *testing.T) {
	// Zero resultado é resposta da web, não erro: como erro, o modelo repete a
	// mesma consulta esperando outro desfecho.
	text := formatSearchResults("consulta improvável", nil)
	if !strings.Contains(text, "não devolveu nenhum resultado") {
		t.Fatalf("esperava a frase de busca sem resultado, obteve %q", text)
	}
}
