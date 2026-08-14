// Testes do barramento.
//
// A ordem das duas metades não é intercambiável: PRIMEIRO grava no log durável
// (que atribui o seq), DEPOIS distribui. E assinante lento é DESCONECTADO, não
// esperado — segurar a produção porque uma janela minimizada parou de ler faz o
// modelo travar no meio da resposta por causa de quem não está olhando.
package eventbus

import (
	"fmt"
	"testing"
	"time"

	"aibot/gateway/internal/protocol"
	"aibot/gateway/internal/store"
)

const testSession = "sessao-de-teste"

// publishDeadline é prazo de segurança para o teste falhar em vez de pendurar;
// não é sincronização. A entrega em si é síncrona dentro de Publish.
const publishDeadline = 5 * time.Second

/* ------------------------------ auxiliares ------------------------------ */

func newBus(t *testing.T) (*Bus, *store.Store) {
	t.Helper()
	journal, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("store.Open: esperava sucesso, obteve erro: %v", err)
	}
	t.Cleanup(func() { _ = journal.Close() })
	if _, err := journal.CreateSession(store.SessionMeta{ID: testSession, Title: "conversa de teste"}); err != nil {
		t.Fatalf("CreateSession: esperava sucesso, obteve erro: %v", err)
	}
	return New(journal), journal
}

func envelopeOf(id string) *protocol.Envelope {
	return &protocol.Envelope{
		ID:   id,
		Kind: protocol.KindMessage,
		From: protocol.Actor{Kind: protocol.ActorSpecialist, ID: "code", Specialist: "code"},
	}
}

// receiveNow lê o que já está no canal. Não há espera porque o fanout acontece
// dentro do Publish: se não chegou quando ele voltou, não vai chegar.
func receiveNow(t *testing.T, subscription *Subscription, who string) protocol.Envelope {
	t.Helper()
	select {
	case envelope, ok := <-subscription.Events:
		if !ok {
			t.Fatalf("%s: esperava um envelope, obteve o canal fechado", who)
		}
		return envelope
	default:
		t.Fatalf("%s: esperava um envelope entregue, obteve o canal vazio", who)
		return protocol.Envelope{}
	}
}

/* -------------------------------- Publish -------------------------------- */

func TestPublishStoresAndDelivers(t *testing.T) {
	bus, journal := newBus(t)
	subscription := bus.Subscribe(testSession)
	defer subscription.Close()

	seq, err := bus.Publish(testSession, envelopeOf("e-1"))
	if err != nil {
		t.Fatalf("Publish: esperava sucesso, obteve erro: %v", err)
	}
	if seq != 1 {
		t.Fatalf("Publish: esperava o primeiro seq da sessão (1), obteve %d", seq)
	}

	delivered := receiveNow(t, subscription, "assinante")
	if delivered.ID != "e-1" {
		t.Errorf("envelope entregue: esperava o id %q, obteve %q", "e-1", delivered.ID)
	}
	if delivered.Seq != seq {
		t.Errorf("envelope entregue: esperava o seq %d atribuído pelo log, obteve %d", seq, delivered.Seq)
	}
	if delivered.Session != testSession {
		t.Errorf("envelope entregue: esperava a sessão %q, obteve %q", testSession, delivered.Session)
	}

	stored, err := journal.Since(testSession, 0, 0)
	if err != nil {
		t.Fatalf("Since: esperava sucesso, obteve erro: %v", err)
	}
	if len(stored) != 1 || stored[0].ID != "e-1" || stored[0].Seq != seq {
		t.Fatalf("log depois do Publish: esperava um envelope %q com seq %d, obteve %+v", "e-1", seq, stored)
	}
}

func TestTwoSubscribersReceiveTheSameEnvelope(t *testing.T) {
	bus, _ := newBus(t)
	first := bus.Subscribe(testSession)
	defer first.Close()
	second := bus.Subscribe(testSession)
	defer second.Close()

	if got := bus.Listeners(testSession); got != 2 {
		t.Fatalf("Listeners: esperava 2, obteve %d", got)
	}

	seq, err := bus.Publish(testSession, envelopeOf("e-1"))
	if err != nil {
		t.Fatalf("Publish: esperava sucesso, obteve erro: %v", err)
	}

	toFirst := receiveNow(t, first, "primeiro assinante")
	toSecond := receiveNow(t, second, "segundo assinante")
	if toFirst.ID != toSecond.ID || toFirst.Seq != toSecond.Seq {
		t.Errorf("os dois assinantes deveriam receber o mesmo envelope: obteve %q/%d e %q/%d",
			toFirst.ID, toFirst.Seq, toSecond.ID, toSecond.Seq)
	}
	if toFirst.Seq != seq {
		t.Errorf("envelope entregue: esperava o seq %d, obteve %d", seq, toFirst.Seq)
	}
}

// Quem não lê é desconectado e se recupera pelo replay — é para isso que o log
// é numerado. O que não pode acontecer é o Publish esperar por ele.
func TestSlowSubscriberIsDroppedAndPublishDoesNotBlock(t *testing.T) {
	bus, _ := newBus(t)
	subscription := bus.Subscribe(testSession)
	defer subscription.Close()

	// Enche a folga do assinante sem tocar no disco: o que importa aqui é o
	// canal cheio, não como ele encheu.
	for index := 0; index < bufferSize; index++ {
		bus.PublishEphemeral(testSession, protocol.Envelope{
			V:       protocol.Version,
			ID:      fmt.Sprintf("e-%d", index),
			Session: testSession,
			Kind:    protocol.KindDelta,
			From:    protocol.Actor{Kind: protocol.ActorSpecialist, ID: "code"},
		})
	}

	select {
	case <-subscription.Lagged:
		t.Fatalf("o assinante foi desconectado com a folga ainda cabendo (%d envelopes)", bufferSize)
	default:
	}

	// O envelope que não cabe: Publish precisa voltar mesmo assim.
	failed := make(chan error, 1)
	go func() {
		_, err := bus.Publish(testSession, envelopeOf("e-transbordo"))
		failed <- err
	}()

	select {
	case err := <-failed:
		if err != nil {
			t.Fatalf("Publish com assinante lento: esperava sucesso, obteve erro: %v", err)
		}
	case <-time.After(publishDeadline):
		t.Fatalf("Publish travou por causa de um assinante que parou de ler")
	}

	select {
	case <-subscription.Lagged:
	default:
		t.Fatalf("assinante lento: esperava o canal Lagged fechado (desconectado), obteve aberto")
	}
	if got := bus.Listeners(testSession); got != 0 {
		t.Errorf("Listeners depois de derrubar o assinante lento: esperava 0, obteve %d", got)
	}

	// O canal de eventos também fecha: quem estava lendo descobre pelo range.
	received := 0
	for range subscription.Events {
		received++
	}
	if received != bufferSize {
		t.Errorf("envelopes entregues antes da desconexão: esperava %d, obteve %d", bufferSize, received)
	}
}

/* --------------------------------- Close --------------------------------- */

func TestCloseCancelsSubscriptionAndIsIdempotent(t *testing.T) {
	bus, _ := newBus(t)
	subscription := bus.Subscribe(testSession)
	other := bus.Subscribe(testSession)
	defer other.Close()

	if got := bus.Listeners(testSession); got != 2 {
		t.Fatalf("Listeners: esperava 2, obteve %d", got)
	}

	subscription.Close()
	if got := bus.Listeners(testSession); got != 1 {
		t.Fatalf("Listeners depois do Close: esperava 1, obteve %d", got)
	}

	select {
	case <-subscription.Lagged:
	default:
		t.Errorf("Close: esperava o canal Lagged fechado, obteve aberto")
	}
	if _, ok := <-subscription.Events; ok {
		t.Errorf("Close: esperava o canal Events fechado, obteve um envelope")
	}

	// Fechar duas vezes é seguro — e não derruba a assinatura de mais ninguém.
	subscription.Close()
	subscription.Close()

	var missing *Subscription
	missing.Close()

	if got := bus.Listeners(testSession); got != 1 {
		t.Fatalf("Listeners depois de fechar de novo: esperava 1, obteve %d", got)
	}
	if _, err := bus.Publish(testSession, envelopeOf("e-1")); err != nil {
		t.Fatalf("Publish depois do Close: esperava sucesso, obteve erro: %v", err)
	}
	delivered := receiveNow(t, other, "assinante que continuou")
	if delivered.ID != "e-1" {
		t.Errorf("envelope entregue ao assinante restante: esperava o id %q, obteve %q", "e-1", delivered.ID)
	}
}
