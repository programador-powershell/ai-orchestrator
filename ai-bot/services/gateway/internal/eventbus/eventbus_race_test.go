// A corrida que derrubava o gateway: fanout enviando por uma cópia solta
// enquanto um Close() concorrente fechava o canal — send em canal fechado é
// pânico, e pânico numa goroutine mata o processo inteiro.
//
// O teste não é determinístico por natureza (é uma corrida), mas com o código
// antigo ele estourava com frequência; com o envio sob a trava de leitura, o
// pânico é impossível por construção — o drop só roda depois da remoção sob a
// trava de escrita.
package eventbus

import (
	"sync"
	"testing"

	"aibot/gateway/internal/protocol"
	"aibot/gateway/internal/store"
)

func TestFanoutNaoEscreveEmCanalFechado(t *testing.T) {
	dataStore, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("abrir o store: %v", err)
	}
	defer dataStore.Close()

	bus := New(dataStore)
	const sessao = "s-corrida"

	var wg sync.WaitGroup
	// Publicador em rajada: efêmero para não pagar disco — o alvo é o fanout.
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 5000; i++ {
			bus.PublishEphemeral(sessao, protocol.Envelope{V: 1, Kind: protocol.KindThinking})
		}
	}()
	// Assinantes abrindo e fechando no meio da rajada — é a troca de sessão
	// (re-hello) e a aba fechada acontecendo durante o streaming.
	for worker := 0; worker < 4; worker++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 500; i++ {
				subscription := bus.Subscribe(sessao)
				// Drena um pouco para o buffer não decidir o teste.
				select {
				case <-subscription.Events:
				default:
				}
				subscription.Close()
			}
		}()
	}
	wg.Wait()
}
