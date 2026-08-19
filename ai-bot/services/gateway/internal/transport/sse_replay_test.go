// O replay do SSE tem de entregar o histórico INTEIRO, não o primeiro lote.
//
// MaxEventBatch é tamanho de página do store, não teto do replay: uma sessão
// com mais envelopes que isso precisa de paginação, como o WebSocket já faz
// (stream.go, replay). Sem ela, o `aibot watch` que abre uma sessão longa
// recebe os 500 primeiros envelopes e depois só o que nasce ao vivo — tudo
// entre o lote e o presente some sem erro, porque o log antigo não passa pelo
// bus e o filtro `seq <= from` do laço ao vivo não o cobre.
package transport

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"aibot/gateway/internal/protocol"
	"aibot/gateway/internal/store"
)

func TestSSEReplayEntregaHistoricoMaiorQueUmLote(t *testing.T) {
	web, dataStore := newStreamHarness(t)

	const sessionID = "sse-historico-longo"
	if _, err := dataStore.CreateSession(store.SessionMeta{ID: sessionID}); err != nil {
		t.Fatalf("criar a sessão: %v", err)
	}
	// Mais de dois lotes cheios + um resto: cobre a página cheia do meio (que
	// obriga a continuar) e a página parcial do fim (que encerra o laço).
	total := 2*store.MaxEventBatch + 137
	for i := 1; i <= total; i++ {
		envelope := protocol.Envelope{
			ID:      fmt.Sprintf("e-%d", i),
			Kind:    protocol.KindDelta,
			From:    protocol.Actor{Kind: "specialist"},
			Payload: json.RawMessage(`{"text":"pedaço"}`),
		}
		if _, err := dataStore.Append(sessionID, &envelope); err != nil {
			t.Fatalf("gravar envelope %d: %v", i, err)
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(
		ctx, http.MethodGet, web.URL+"/v1/sessions/"+sessionID+"/sse", nil)
	if err != nil {
		t.Fatalf("montar a requisição: %v", err)
	}
	request.Header.Set("Authorization", "Bearer "+streamTestToken)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("abrir o SSE: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("esperava 200, veio %d", response.StatusCode)
	}

	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	next := uint64(1)
	for next <= uint64(total) && scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue // linha de evento, separador ou o ": ping" do heartbeat
		}
		var envelope protocol.Envelope
		if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &envelope); err != nil {
			t.Fatalf("payload ilegível no seq %d: %v", next, err)
		}
		if envelope.Seq != next {
			t.Fatalf("replay quebrou a ordem: esperava seq %d, veio %d", next, envelope.Seq)
		}
		next++
	}
	if next != uint64(total)+1 {
		t.Fatalf("replay parou no seq %d de %d — o histórico além do primeiro lote não chegou",
			next-1, total)
	}
}
