package modelrouter

import (
	"net/http"
	"testing"
	"time"

	"aibot/gateway/internal/protocol"
)

// O roteador da tela de Configurações → Motores: um modelo fixado por
// especialista.
//
// A ordem é a regra do produto, e é ela que estes testes guardam:
//
//	escolha do turno  >  modelo fixado do especialista  >  preferência por
//	skill da definição  >  padrão do catálogo
//
// Quem digitou agora manda mais que uma configuração de ontem; uma configuração
// de ontem manda mais que um padrão de fábrica.
func routerComTresModelos() *Router {
	router := New(&http.Client{Timeout: 5 * time.Second}, nil)
	router.SetProviders([]Provider{
		{ID: "fake", Name: "Provedor de mentira", Kind: KindOpenAI, BaseURL: "http://127.0.0.1:1", Enabled: true},
	})
	router.SetModels([]Entry{
		{Model: protocol.Model{ID: "barato", Provider: "fake", Label: "Barato"}, ProviderID: "fake", Default: true},
		{Model: protocol.Model{ID: "caro", Provider: "fake", Label: "Caro"}, ProviderID: "fake"},
		{Model: protocol.Model{ID: "outro", Provider: "fake", Label: "Outro"}, ProviderID: "fake"},
	})
	return router
}

func TestModeloFixadoVenceOPadraoDoCatalogo(t *testing.T) {
	router := routerComTresModelos()
	router.SetSpecialistModels(map[string]string{"code": "caro"})

	entry, _, err := router.Resolve("code", "")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if entry.ID != "caro" {
		t.Fatalf("o especialista code foi fixado em %q, mas o turno resolveu %q", "caro", entry.ID)
	}

	// Especialista sem escolha continua no padrão do catálogo.
	outro, _, err := router.Resolve("design", "")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if outro.ID != "barato" {
		t.Fatalf("design não foi fixado e deveria cair no padrão %q, veio %q", "barato", outro.ID)
	}
}

func TestEscolhaDoTurnoVenceOModeloFixado(t *testing.T) {
	router := routerComTresModelos()
	router.SetSpecialistModels(map[string]string{"code": "caro"})

	entry, _, err := router.Resolve("code", "outro")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if entry.ID != "outro" {
		t.Fatalf("quem escolheu no turno pediu %q e recebeu %q", "outro", entry.ID)
	}
}

// Modelo que saiu do catálogo depois de configurado não pode derrubar o turno:
// a configuração fica velha sozinha quando o admin remove um modelo.
func TestModeloFixadoQueSumiuCaiParaOPadrao(t *testing.T) {
	router := routerComTresModelos()
	router.SetSpecialistModels(map[string]string{"code": "modelo-que-nao-existe"})

	entry, _, err := router.Resolve("code", "")
	if err != nil {
		t.Fatalf("Resolve devia cair para o padrão, e falhou: %v", err)
	}
	if entry.ID != "barato" {
		t.Fatalf("esperava o padrão %q depois de um fixado inválido, veio %q", "barato", entry.ID)
	}
}

// Soltar é a mesma porta: mapa sem a chave devolve o especialista ao automático.
func TestSoltarDevolveAoAutomatico(t *testing.T) {
	router := routerComTresModelos()
	router.SetSpecialistModels(map[string]string{"code": "caro"})
	router.SetSpecialistModels(map[string]string{})

	if lista := router.SpecialistModels(); len(lista) != 0 {
		t.Fatalf("depois de soltar, o mapa deveria estar vazio, veio %v", lista)
	}
	entry, _, err := router.Resolve("code", "")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if entry.ID != "barato" {
		t.Fatalf("solto, o code deveria cair no padrão %q, veio %q", "barato", entry.ID)
	}
}

// A cópia é cópia: mexer no que SpecialistModels devolveu não pode mexer no
// roteador.
func TestSpecialistModelsDevolveCopia(t *testing.T) {
	router := routerComTresModelos()
	router.SetSpecialistModels(map[string]string{"code": "caro"})

	roubada := router.SpecialistModels()
	roubada["code"] = "outro"
	roubada["design"] = "outro"

	entry, _, err := router.Resolve("code", "")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if entry.ID != "caro" {
		t.Fatalf("mexer na cópia mudou o roteador: code resolveu %q", entry.ID)
	}
}
