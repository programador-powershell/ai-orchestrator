// Testes do design.replicate estruturado.
//
// Como em tools_web_test.go, nada aqui toca a rede: o que importa na
// ferramenta é a função PURA que monta o payload (designReplica) e as recusas
// antes da primeira conexão. O contrato com a tela é verificado pelo JSON
// SERIALIZADO — é o texto que atravessa o protocolo, e um campo com a caixa
// errada deixaria o painel de tokens vazio sem erro nenhum.
package supervisor

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"testing"

	"aibot/gateway/internal/netguard"
)

const paginaDeAmostra = `<html><head><title> Casa  Exemplo </title>
<link rel="stylesheet" href="a.css">
<style>
:root{--bg:#0b1220;--fg:#ffffff}
body{background:#0b1220;color:#0b1220;font-family:Inter,sans-serif;display:flex;margin:16px;padding:16px}
h1{font-size:1.5rem;margin:16px 8px}
@keyframes fadeIn{from{opacity:0}}
</style></head>
<body><header>x</header><nav>y</nav><main><section>z</section></main>
<a href="/precos">preços</a><a href="https://exemplo.com/sobre">sobre</a></body></html>`

func baseDeTeste(t *testing.T) *url.URL {
	t.Helper()
	base, err := url.Parse("https://exemplo.com/inicio")
	if err != nil {
		t.Fatalf("url de teste inválida: %v", err)
	}
	return base
}

/* ------------------------------ o contrato ------------------------------- */

// O parse do CanvasSurface lê `url`, `title`, `tokens.colors`,
// `tokens.variables[].name/value` e `tokens.fonts` — este teste desserializa o
// JSON REAL e confere cada chave onde a tela a procura.
func TestDesignReplicaCasaComOParseDaTela(t *testing.T) {
	payload := designReplica(baseDeTeste(t), paginaDeAmostra, 3)
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("serializar: %v", err)
	}

	var parsed struct {
		URL   string `json:"url"`
		Title string `json:"title"`
		Pages []struct {
			Title  string   `json:"title"`
			URL    string   `json:"url"`
			Blocks []string `json:"blocks"`
		} `json:"pages"`
		Tokens struct {
			Colors    []string `json:"colors"`
			Variables []struct {
				Name  string `json:"name"`
				Value string `json:"value"`
			} `json:"variables"`
			Fonts   []string `json:"fonts"`
			Spacing []string `json:"spacing"`
		} `json:"tokens"`
		Analysis string `json:"analysis"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatalf("o JSON não desserializa no contrato: %v\n%s", err, raw)
	}

	if parsed.URL != "https://exemplo.com/inicio" {
		t.Errorf("url: esperava a URL final, obteve %q", parsed.URL)
	}
	if parsed.Title != "Casa Exemplo" {
		t.Errorf("title: esperava o <title> achatado, obteve %q", parsed.Title)
	}

	// Cores por frequência: #0b1220 aparece 3×, #ffffff 1×.
	if !equalStrings(parsed.Tokens.Colors, []string{"#0b1220", "#ffffff"}) {
		t.Errorf("tokens.colors: esperava ordem por frequência, obteve %v", parsed.Tokens.Colors)
	}
	if len(parsed.Tokens.Variables) != 2 ||
		parsed.Tokens.Variables[0].Name != "--bg" || parsed.Tokens.Variables[0].Value != "#0b1220" {
		t.Errorf("tokens.variables: esperava [{--bg #0b1220} {--fg #ffffff}], obteve %v", parsed.Tokens.Variables)
	}
	if !equalStrings(parsed.Tokens.Fonts, []string{"Inter"}) {
		t.Errorf("tokens.fonts: esperava [Inter], obteve %v", parsed.Tokens.Fonts)
	}
	// 16px 3×; empate 1× entre 1.5rem e 8px decidido pela ordem de aparição.
	if !equalStrings(parsed.Tokens.Spacing, []string{"16px", "1.5rem", "8px"}) {
		t.Errorf("tokens.spacing: esperava [16px 1.5rem 8px], obteve %v", parsed.Tokens.Spacing)
	}

	if len(parsed.Pages) != 3 {
		t.Fatalf("pages: esperava a própria página + 2 do mesmo host, obteve %d (%v)", len(parsed.Pages), parsed.Pages)
	}
	if parsed.Pages[0].Title != "Casa Exemplo" || parsed.Pages[0].URL != "https://exemplo.com/inicio" {
		t.Errorf("pages[0]: esperava a página lida com título, obteve %+v", parsed.Pages[0])
	}
	if !equalStrings(parsed.Pages[0].Blocks, []string{"header", "nav", "main", "section"}) {
		t.Errorf("pages[0].blocks: esperava os blocos estruturais presentes, obteve %v", parsed.Pages[0].Blocks)
	}
	// As páginas listadas não foram baixadas: título = URL e blocos vazios.
	if parsed.Pages[1].Title != parsed.Pages[1].URL || len(parsed.Pages[1].Blocks) != 0 {
		t.Errorf("pages[1]: página não baixada tinha de vir sem blocos e com a URL de título: %+v", parsed.Pages[1])
	}

	for _, marker := range []string{"display:flex", "folhas de estilo ligadas: 1", "fadeIn", "não baixadas"} {
		if !strings.Contains(parsed.Analysis, marker) {
			t.Errorf("analysis não trouxe %q:\n%s", marker, parsed.Analysis)
		}
	}
}

// Página vazia ainda entrega o contrato inteiro: array vazio, nunca null — a
// tela promete listas, e `null` num campo prometido como lista é surpresa que
// só aparece no cliente.
func TestDesignReplicaVaziaEntregaArraysENaoNull(t *testing.T) {
	raw, err := json.Marshal(designReplica(nil, "<p>oi</p>", 0))
	if err != nil {
		t.Fatalf("serializar: %v", err)
	}
	texto := string(raw)
	for _, marker := range []string{`"colors":[]`, `"variables":[]`, `"fonts":[]`, `"spacing":[]`, `"blocks":[]`} {
		if !strings.Contains(texto, marker) {
			t.Errorf("o JSON não trouxe %s:\n%s", marker, texto)
		}
	}
	if strings.Contains(texto, "null") {
		t.Errorf("o JSON trouxe null onde o contrato promete lista:\n%s", texto)
	}
	// A própria página lida SEMPRE existe em pages, mesmo sem base para dar URL.
	if !strings.Contains(texto, `"pages":[{`) {
		t.Errorf("o JSON saiu sem a própria página em pages:\n%s", texto)
	}
}

/* ------------------------------ espaçamento ------------------------------- */

func TestExtractSpacingOrdenaPorFrequencia(t *testing.T) {
	source := `.a{margin:16px;padding:16px 8px}.b{gap:16px;font-size:1.5rem}`
	got := extractSpacing(source)
	// 16px 3×; empate 1× entre 8px e 1.5rem decidido pela aparição.
	want := []string{"16px", "8px", "1.5rem"}
	if !equalStrings(got, want) {
		t.Fatalf("extractSpacing: esperava %v, obteve %v", want, got)
	}
}

func TestExtractSpacingIgnoraOQueNaoEhMedida(t *testing.T) {
	cases := []struct {
		source string
		want   []string
		why    string
	}{
		{"margin:0px;padding:0.0rem", []string{}, "zero não é decisão de espaçamento"},
		{"class=\"grid2px\"", []string{}, "dígito colado em identificador não é medida"},
		{"width:16pxx", []string{}, "a unidade precisa terminar a palavra"},
		{"margin:-16px", []string{"16px"}, "margem negativa conta"},
		{"margin:.5px", []string{"5px"}, "fração sem inteiro conta"},
		{"MARGIN:16PX", []string{"16px"}, "a unidade sai normalizada em minúsculas"},
	}
	for _, each := range cases {
		got := extractSpacing(each.source)
		if !equalStrings(got, each.want) {
			t.Errorf("extractSpacing(%q): esperava %v (%s), obteve %v", each.source, each.want, each.why, got)
		}
	}
}

func TestExtractSpacingRespeitaTeto(t *testing.T) {
	var source strings.Builder
	for index := 1; index <= designMaxSpacing+9; index++ {
		fmt.Fprintf(&source, ".s%d{margin:%dpx}\n", index, index)
	}
	if got := extractSpacing(source.String()); len(got) != designMaxSpacing {
		t.Fatalf("extractSpacing: esperava o teto de %d, obteve %d", designMaxSpacing, len(got))
	}
}

/* --------------------------------- blocos --------------------------------- */

func TestStructuralBlocksExigeFronteiraDeNome(t *testing.T) {
	// `<sectioned>` não é `<section>`; `<BUTTON` conta apesar da caixa.
	source := `<div><sectioned>x</sectioned><BUTTON>ok</BUTTON><nav id="menu">y</nav></div>`
	got := structuralBlocks(source)
	// A ordem é a da lista fechada (nav antes de button), não a do documento.
	want := []string{"nav", "button"}
	if !equalStrings(got, want) {
		t.Fatalf("structuralBlocks: esperava %v, obteve %v", want, got)
	}
}

/* -------------------------------- recusas --------------------------------- */

func TestDesignReplicateStructuredRecusaSemRedeESemURL(t *testing.T) {
	semRede := &Toolbox{}
	if _, err := semRede.designReplicateStructured(context.Background(), "s",
		json.RawMessage(`{"url":"https://exemplo.com"}`)); err == nil ||
		!strings.Contains(err.Error(), "rede") {
		t.Fatalf("sem Net tinha de recusar citando a rede, obteve %v", err)
	}

	comRede := &Toolbox{Net: netguard.New(nil)}
	if _, err := comRede.designReplicateStructured(context.Background(), "s",
		json.RawMessage(`{"url":"  "}`)); err == nil ||
		!strings.Contains(err.Error(), "url") {
		t.Fatalf("sem url tinha de recusar citando o campo, obteve %v", err)
	}
}

// A URL interna morre no netguard ANTES de qualquer conexão — determinístico e
// sem rede: "localhost" é recusado pelo nome, antes até do DNS.
func TestDesignReplicateStructuredRecusaDestinoInterno(t *testing.T) {
	toolbox := &Toolbox{Net: netguard.New(nil)}
	_, err := toolbox.designReplicateStructured(context.Background(), "s",
		json.RawMessage(`{"url":"http://localhost/admin"}`))
	if err == nil || !strings.Contains(err.Error(), "bloqueado") {
		t.Fatalf("destino interno tinha de voltar bloqueado, obteve %v", err)
	}
}

/* -------------------------------- catálogo -------------------------------- */

// O registro sai da Toolbox (via InstallExtraTools → designToolsInstall) e a
// descrição soletra o JSON: ela é o único contrato que o modelo vê.
func TestDesignReplicateRegistradoComContratoJSON(t *testing.T) {
	registry := NewRegistry()
	(&Toolbox{}).Install(registry)

	if !registry.Has("design.replicate") {
		t.Fatal("design.replicate sumiu do catálogo — o especialista de design a promete")
	}
	description := registry.Describe("design.replicate")
	for _, marker := range []string{"JSON", "tokens", "pages", "analysis", "{url, maxPages?}"} {
		if !strings.Contains(description, marker) {
			t.Errorf("a descrição não anuncia %q — o modelo decide a chamada por ela: %q", marker, description)
		}
	}
}
