// O contrato do raciocínio no fio (streamSink.Reasoning).
//
// O que se prova: raciocínio e rótulo de etapa saem pelo MESMO verbo
// (KindThinking) e a única coisa que os separa é a marca `Reasoning` — se ela
// sumir de um dos lados, o cliente volta a piscar o raciocínio no orbe e a
// jogá-lo fora, que era o defeito original.
package supervisor

import (
	"testing"
	"time"

	"aibot/gateway/internal/eventbus"
	"aibot/gateway/internal/protocol"
	"aibot/gateway/internal/store"
)

// nextThinking espera o próximo KindThinking da assinatura.
func nextThinking(t *testing.T, events <-chan protocol.Envelope) protocol.Thinking {
	t.Helper()
	select {
	case envelope := <-events:
		if envelope.Kind != protocol.KindThinking {
			t.Fatalf("esperava thinking, veio %s", envelope.Kind)
		}
		var payload protocol.Thinking
		if err := envelope.Decode(&payload); err != nil {
			t.Fatalf("decodificar thinking: %v", err)
		}
		return payload
	case <-time.After(2 * time.Second):
		t.Fatal("nenhum envelope chegou pela assinatura")
		return protocol.Thinking{}
	}
}

func TestReasoningSaiMarcadoEEtapaSaiSemMarca(t *testing.T) {
	dataStore, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("abrir o store: %v", err)
	}
	t.Cleanup(func() { _ = dataStore.Close() })

	bus := eventbus.New(dataStore)
	sup := New(Deps{Store: dataStore, Bus: bus})

	subscription := bus.Subscribe("s-raciocinio")
	t.Cleanup(subscription.Close)

	actor := protocol.Actor{Kind: protocol.ActorSpecialist, ID: "code", Specialist: "code"}
	sink := &streamSink{supervisor: sup, session: "s-raciocinio", turn: "t1", actor: actor}

	if err := sink.Reasoning("preciso ler o arquivo antes"); err != nil {
		t.Fatalf("Reasoning: %v", err)
	}
	raciocinio := nextThinking(t, subscription.Events)
	if !raciocinio.Reasoning {
		t.Fatal("o texto de raciocínio saiu SEM a marca — o cliente não tem como separá-lo do rótulo")
	}
	if raciocinio.Label != "preciso ler o arquivo antes" {
		t.Fatalf("o texto do raciocínio não viajou inteiro: %q", raciocinio.Label)
	}

	// O rótulo de etapa continua saindo SEM a marca: é ele que o orbe mostra.
	sup.thinking("s-raciocinio", "t1", actor, "lendo o código", false)
	etapa := nextThinking(t, subscription.Events)
	if etapa.Reasoning {
		t.Fatal("o rótulo de etapa saiu marcado como raciocínio")
	}
	if etapa.Label != "lendo o código" {
		t.Fatalf("rótulo de etapa errado: %q", etapa.Label)
	}
}

func TestThinkingAntigoDecodificaSemAMarca(t *testing.T) {
	// Decode tolerante: payload de gateway antigo (sem o campo) tem de cair em
	// `false`, nunca em erro — senão a marca nova quebraria replay antigo.
	envelope := protocol.Envelope{Kind: protocol.KindThinking}
	if err := envelope.SetPayload(map[string]any{"label": "pensando"}); err != nil {
		t.Fatalf("SetPayload: %v", err)
	}
	var payload protocol.Thinking
	if err := envelope.Decode(&payload); err != nil {
		t.Fatalf("payload antigo não decodifica mais: %v", err)
	}
	if payload.Reasoning || payload.Label != "pensando" {
		t.Fatalf("payload antigo mudou de sentido: %+v", payload)
	}
}
