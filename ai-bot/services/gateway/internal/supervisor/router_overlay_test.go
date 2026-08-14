// O roteador contra o catálogo PUBLICADO (trilha A de docs/atualizacao.md).
//
// Estes testes existem por causa de um defeito específico e silencioso: o
// roteador guarda em cache o catálogo de candidatos e os radicais já
// normalizados, montados uma vez. Sem reconstruir os dois na troca, a tela
// mostra o catálogo publicado e o roteador continua decidindo pelo compilado —
// e nada disso aparece como erro em lugar nenhum.
//
// Os dois caches falham de formas diferentes, e vale saber qual é qual:
//
//   - a lista de CANDIDATOS estraga o resultado. Route pontua e escolhe dentro
//     dela, então um especialista publicado que não esteja na lista nunca é
//     escolhido, por mais que o texto grite o nome dele;
//   - o mapa de RADICAIS estraga só o desempenho. `trigger()` cai para
//     Normalize no que não está em cache, então a decisão continua certa e o
//     que se perde é o atalho — dobrar ~150 radicais a cada primeiro input.
//
// Por isso há teste para os dois: o primeiro tipo de falha o `Route` pega, e o
// segundo só aparece se alguém olhar o cache.
package supervisor

import (
	"context"
	"encoding/json"
	"testing"

	"aibot/gateway/internal/protocol"
	"aibot/gateway/internal/specialist"
)

// publishCatalog aplica um catálogo publicado e desfaz no fim do teste.
func publishCatalog(t *testing.T, version string, definitions ...specialist.Definition) {
	t.Helper()
	raw, err := json.Marshal(map[string]any{
		"schemaVersion": specialist.OverlaySchemaVersion,
		"version":       version,
		"specialists":   definitions,
	})
	if err != nil {
		t.Fatalf("serializar o overlay: %v", err)
	}
	if err := specialist.LoadOverlay(raw); err != nil {
		t.Fatalf("LoadOverlay: %v", err)
	}
	t.Cleanup(specialist.ResetOverlay)
}

// publishedDefinition é um especialista válido montado no teste.
func publishedDefinition(id string, triggers ...string) specialist.Definition {
	return specialist.Definition{
		ID:          id,
		Name:        "Publicado " + id,
		Tagline:     "veio do servidor",
		Glyph:       "chat",
		Hue:         200,
		Surface:     specialist.SurfaceBoard,
		Rail:        specialist.RailTasks,
		System:      "Você é o especialista publicado.",
		Placeholder: "Escreva…",
		NewLabel:    "Novo",
		Triggers:    triggers,
		Avatar: specialist.Avatar{
			Seed: 7, Shape: "orb", Eyes: "dot", Mouth: "smile",
			Accessory: "none", Motion: "breathe", Hue: 200, Saturation: 62,
		},
	}
}

// O teste da ponta: um RADICAL que só existe no catálogo publicado pontua.
func TestScoreUsesTheTriggersOfThePublishedCatalog(t *testing.T) {
	const text = "preciso de uma apólice de resseguro para o cliente"

	// Antes: o radical não existe em lugar nenhum, e ninguém pontua.
	if scores := Score(text, specialist.All()); len(scores) != 0 {
		t.Fatalf("antes da publicação o texto já pontuava: %+v", scores)
	}

	publishCatalog(t, "0.2.0",
		publishedDefinition("chat", "pergunt", "duvid"),
		publishedDefinition("seguros", "apolice", "resseguro", "sinistro"),
	)

	scores := Score(text, specialist.All())
	if len(scores) == 0 {
		t.Fatal("nenhum especialista pontuou — o roteador continua com os radicais do catálogo compilado")
	}
	if scores[0].ID != "seguros" {
		t.Fatalf("o primeiro colocado foi %q, esperava o especialista publicado %q", scores[0].ID, "seguros")
	}
	if len(scores[0].Signals) == 0 {
		t.Error("o especialista publicado pontuou sem nenhum sinal registrado")
	}
	// A normalização vale para o radical publicado como vale para o compilado:
	// o texto tem "apólice" com acento e o radical é "apolice".
	found := false
	for _, signal := range scores[0].Signals {
		if signal == "apolice" {
			found = true
		}
	}
	if !found {
		t.Errorf("o radical acentuado não casou: sinais %v", scores[0].Signals)
	}
}

// O cache em si, que é o que o gancho de specialist.OnChange reconstrói.
//
// Este é o teste que pega a falha silenciosa: sem o gancho, os candidatos
// continuam sendo os compilados (e aí `Route` nunca escolhe o publicado) e o
// mapa de radicais continua sem os radicais novos (e aí todo primeiro input
// paga a normalização que o cache existe para evitar).
func TestCatalogCacheIsRebuiltOnPublish(t *testing.T) {
	before := activeCatalog()
	if _, cached := before.normalized["resseguro"]; cached {
		t.Fatal("o radical do teste já existia no catálogo compilado; escolha outro")
	}

	publishCatalog(t, "0.5.0",
		publishedDefinition("chat", "pergunt"),
		publishedDefinition("seguros", "resseguro"),
	)

	after := activeCatalog()
	if after == before {
		t.Fatal("o cache do roteador não foi reconstruído na publicação")
	}
	if _, cached := after.normalized["resseguro"]; !cached {
		t.Error("o radical publicado não entrou no cache de radicais")
	}
	ids := make([]string, 0, len(after.candidates))
	for _, definition := range after.candidates {
		ids = append(ids, definition.ID)
	}
	if len(ids) != 2 || ids[1] != "seguros" {
		t.Errorf("os candidatos do roteador são %v, esperava os do catálogo publicado", ids)
	}
	// A ordem do catálogo é a ordem de exibição, e o roteador a preserva: o
	// desempate por confiança igual usa o id, mas a lista que vai ao Needle
	// (shortlistFor) completa na ordem do catálogo.
	if ids[0] != "chat" {
		t.Errorf("o primeiro candidato é %q, esperava a ordem publicada", ids[0])
	}
}

// A volta ao compilado também precisa chegar ao cache: um cache que só é
// reconstruído para frente deixaria o roteador com um catálogo que não vale
// mais.
func TestScoreForgetsThePublishedTriggersAfterReset(t *testing.T) {
	const text = "abrir sinistro"

	publishCatalog(t, "0.2.0",
		publishedDefinition("chat", "pergunt"),
		publishedDefinition("seguros", "sinistro"),
	)
	if scores := Score(text, specialist.All()); len(scores) == 0 || scores[0].ID != "seguros" {
		t.Fatalf("a publicação não valeu: %+v", scores)
	}

	specialist.ResetOverlay()

	if scores := Score(text, specialist.All()); len(scores) != 0 {
		t.Errorf("depois da volta ao compilado o radical publicado continuou pontuando: %+v", scores)
	}
}

// Route inteira, não só Score: o candidato publicado tem de ser elegível, e a
// superfície que a rota carrega tem de ser a DELE — é ela que a tela monta.
func TestRouteChoosesAPublishedSpecialist(t *testing.T) {
	publishCatalog(t, "0.3.0",
		publishedDefinition("chat", "pergunt"),
		publishedDefinition("seguros", "apolice", "resseguro", "sinistro", "corretora"),
	)

	// O degrau do modelo é PROIBIDO: com o catálogo publicado, o léxico tem
	// sinal de sobra e a decisão não pode custar uma ida à rede.
	router := NewRouter(nil, forbiddenClassifier{t: t})
	route := router.Route(context.Background(), RouteInput{
		Text: "revisa a apólice e o sinistro da corretora",
	})

	if route.Specialist != "seguros" {
		t.Fatalf("a rota foi para %q, esperava o especialista publicado", route.Specialist)
	}
	if route.Reason != protocol.RouteHeuristic {
		t.Errorf("motivo %q, esperava %q — o léxico tinha sinal de sobra", route.Reason, protocol.RouteHeuristic)
	}
	if route.Surface != string(specialist.SurfaceBoard) {
		t.Errorf("a rota carregou a superfície %q, esperava %q — a tela monta pelo que vem aqui",
			route.Surface, specialist.SurfaceBoard)
	}
}

// O catálogo publicado também governa quem pode RECEBER delegação. Sem isso o
// orquestrador ofereceria ao modelo especialistas que não existem mais.
func TestDelegableSpecialistsFollowsThePublishedCatalog(t *testing.T) {
	publishCatalog(t, "0.4.0",
		publishedDefinition("chat"),
		publishedDefinition("seguros"),
	)

	ids := make([]string, 0, 2)
	for _, definition := range delegableSpecialists("chat", nil) {
		ids = append(ids, definition.ID)
	}
	if len(ids) != 1 || ids[0] != "seguros" {
		t.Errorf("delegáveis = %v, esperava só o especialista publicado que não é o remetente", ids)
	}
}
