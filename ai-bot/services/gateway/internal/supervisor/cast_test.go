// O elenco do primeiro input, cenário por cenário.
//
// Estes testes são a tabela que a revisão pediu: para cada pedido, QUEM atende,
// quem fica em espera e em que FORMA — paralelo (trabalha junto) ou série
// (trabalha sobre o que o dono produziu). O que eles guardam é a diferença entre
// "o motor escolheu um bot" e "o motor entendeu o pedido": escolher o dono nunca
// foi o trabalho todo.
package supervisor

import (
	"context"
	"strings"
	"testing"
)

// elenco roda a rota e devolve os companheiros separados por forma.
func elenco(t *testing.T, texto string) (dono string, paralelo, serie []string) {
	t.Helper()
	rota := NewRouter(nil, nil).Route(context.Background(), RouteInput{Text: texto})
	for _, apoio := range rota.Standby {
		if apoio.When == "parallel" {
			paralelo = append(paralelo, apoio.Specialist)
		} else {
			serie = append(serie, apoio.Specialist)
		}
	}
	return rota.Specialist, paralelo, serie
}

func contem(lista []string, id string) bool {
	for _, item := range lista {
		if item == id {
			return true
		}
	}
	return false
}

/* --------------------------- os cenários pedidos -------------------------- */

// Dois em PARALELO e um em SÉRIE — a forma mais comum de um pedido de produto.
//
// O Design pode definir o visual enquanto o Código monta o esqueleto; a
// Segurança precisa de código para revisar. Paralelizar a revisão produziria um
// parecer sobre um repositório vazio; serializar o Design dobraria o tempo por
// nada.
func TestAplicacaoCompletaChamaDesignEmParaleloESegurancaDepois(t *testing.T) {
	dono, paralelo, serie := elenco(t, "crie uma aplicação em next.js completa")

	if dono != "code" {
		t.Fatalf("dono: esperava code, veio %q", dono)
	}
	if !contem(paralelo, "design") {
		t.Errorf("o pedido tem interface — o Design tinha de entrar em PARALELO; paralelo=%v", paralelo)
	}
	if !contem(serie, "security") {
		t.Errorf("aplicação nova pede revisão DEPOIS de existir código; série=%v", serie)
	}
	if contem(paralelo, "security") {
		t.Error("Segurança em paralelo revisaria um repositório vazio")
	}
}

// O ENTREGÁVEL manda mais que a contagem de radicais.
//
// "Crie uma api ... com banco postgres" pontua 1,00 em Dados (banco, postgres —
// dois radicais longos) e 0,25 em Código (api — três letras). Mesmo assim o dono
// é o Código: a API é o que foi PEDIDO, o banco é o que ela usa.
func TestApiComBancoTemCodigoComoDonoEDadosEmEspera(t *testing.T) {
	dono, paralelo, serie := elenco(t, "crie uma api rest de cobrança com login e banco postgres")

	if dono != "code" {
		t.Fatalf("dono: esperava code (a API é o entregável), veio %q", dono)
	}
	if !contem(paralelo, "data") {
		t.Errorf("há banco no pedido — Dados tinha de entrar em paralelo; paralelo=%v", paralelo)
	}
	if !contem(serie, "security") {
		t.Errorf("api com login pede revisão depois; série=%v", serie)
	}
}

// Sem interface e sem aplicação, ninguém entra. Companheiro incondicional vira
// ruído, e ruído ensina a pessoa a ignorar o aviso.
func TestCorrecaoDeBugNaoConvocaNinguem(t *testing.T) {
	dono, paralelo, serie := elenco(t, "corrige o bug de compilação no parser")

	if dono != "code" {
		t.Fatalf("dono: esperava code, veio %q", dono)
	}
	if len(paralelo)+len(serie) != 0 {
		t.Errorf("uma correção de bug não convoca elenco; paralelo=%v série=%v", paralelo, serie)
	}
}

// Pedido de banco é do banco: nem todo pedido vira projeto de software.
func TestPedidoDeBancoFicaComDados(t *testing.T) {
	dono, _, _ := elenco(t, "desenhe o banco de dados de cobrança e exporte o SQL")
	if dono != "data" {
		t.Errorf("dono: esperava data, veio %q", dono)
	}
}

// O verbo de construção decide QUAL substantivo é o pedido. Aqui há "portal"
// (Código) e "relatório em pdf" (Documentos) na mesma frase, e quem vem logo
// depois do verbo é o portal.
func TestPortalComRelatorioTemCodigoComoDono(t *testing.T) {
	dono, _, _ := elenco(t, "monte um portal com cadastro de clientes e relatório em pdf")
	if dono != "code" {
		t.Errorf("dono: esperava code (o portal é o entregável), veio %q", dono)
	}
}

// Um pedido de apresentação continua sendo de Documentos — a regra do
// entregável não puxa tudo para o Código.
func TestApresentacaoContinuaComDocumentos(t *testing.T) {
	dono, _, _ := elenco(t, "monte a apresentação do trimestre em pptx")
	if dono != "office" {
		t.Errorf("dono: esperava office, veio %q", dono)
	}
}

/* ---------------------------- as invariantes ------------------------------ */

// O elenco é do PRIMEIRO input. Recalculá-lo a cada mensagem trocaria a barra
// lateral debaixo de quem está trabalhando.
func TestConversaComDonoNaoRecalculaOElenco(t *testing.T) {
	rota := NewRouter(nil, nil).Route(context.Background(), RouteInput{
		Text:    "crie uma aplicação em next.js completa",
		Current: "code",
	})
	if rota.Reason != "sticky" {
		t.Fatalf("esperava rota sticky, veio %q", rota.Reason)
	}
	if len(rota.Standby) != 0 {
		t.Errorf("conversa que já tem dono não remonta elenco: %+v", rota.Standby)
	}
}

// Um bot em espera que a política não libera seria uma promessa que o portão
// quebra depois.
func TestElencoRespeitaAPoliticaDaSessao(t *testing.T) {
	rota := NewRouter(nil, nil).Route(context.Background(), RouteInput{
		Text:    "crie uma aplicação em next.js completa",
		Allowed: []string{"code", "chat"},
	})
	for _, apoio := range rota.Standby {
		if apoio.Specialist != "code" && apoio.Specialist != "chat" {
			t.Errorf("o elenco convocou %q, que a política não liberou", apoio.Specialist)
		}
	}
}

// Cada bot em espera precisa dizer POR QUE apareceu — a frase é para a pessoa
// ler, não para o log.
func TestCadaBotEmEsperaExplicaPorQueEntrou(t *testing.T) {
	rota := NewRouter(nil, nil).Route(context.Background(), RouteInput{
		Text: "crie uma aplicação em next.js completa",
	})
	if len(rota.Standby) == 0 {
		t.Fatal("o cenário precisa de elenco para testar as frases")
	}
	for _, apoio := range rota.Standby {
		if strings.TrimSpace(apoio.Why) == "" {
			t.Errorf("%s entrou em espera sem dizer por quê", apoio.Specialist)
		}
		if apoio.When != "parallel" && apoio.When != "after" {
			t.Errorf("%s entrou com forma inválida %q", apoio.Specialist, apoio.When)
		}
	}
}

// Dois entregáveis na mesma frase é empate DE VERDADE, e empate sobe a cascata
// em vez de ser resolvido no grito.
func TestDoisEntregaveisNaoDecidemNoGrito(t *testing.T) {
	scores := Score("crie o aplicativo e o banco de dados", candidatesFor(nil))
	achados := 0
	for _, score := range scores {
		if score.Deliverable {
			achados++
		}
	}
	if achados < 2 {
		t.Skipf("o cenário depende de dois entregáveis; achei %d", achados)
	}
	if _, unico := soleDeliverable(scores); unico {
		t.Error("com dois entregáveis não pode haver dono único pela regra")
	}
}
