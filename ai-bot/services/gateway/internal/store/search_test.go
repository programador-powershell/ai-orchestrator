// Testes da busca por conteúdo (search.go).
package store

import (
	"fmt"
	"strings"
	"testing"

	"aibot/gateway/internal/protocol"
)

// searchStore monta um store com duas sessões cheias de mensagens conhecidas.
func searchStore(t *testing.T) *Store {
	t.Helper()
	opened := openStore(t, t.TempDir())
	for _, id := range []string{"conversa-a", "conversa-b"} {
		if _, err := opened.CreateSession(SessionMeta{ID: id, Title: "título de " + id}); err != nil {
			t.Fatalf("CreateSession(%q): %v", id, err)
		}
	}
	grava := func(session, turn, role, text string) {
		envelope := &protocol.Envelope{
			Kind: protocol.KindMessage,
			Turn: turn,
			From: protocol.Actor{Kind: protocol.ActorUser},
		}
		_ = envelope.SetPayload(protocol.Message{Role: role, Text: text})
		if _, err := opened.Append(session, envelope); err != nil {
			t.Fatalf("Append em %q: %v", session, err)
		}
	}
	grava("conversa-a", "t1", "user", "Como faço um Deploy no Kubernetes?")
	grava("conversa-a", "t1", "assistant", "O deploy sai por pipeline, nunca à mão.")
	grava("conversa-b", "t9", "user", "Escreva um poema sobre café.")
	return opened
}

func TestSearchAchaSemDiferenciarMaiusculas(t *testing.T) {
	opened := searchStore(t)

	hits, err := opened.SearchSessions("dEpLoY", 0)
	if err != nil {
		t.Fatalf("SearchSessions: %v", err)
	}
	if len(hits) != 2 {
		t.Fatalf("esperava 2 trechos com 'deploy', obteve %d", len(hits))
	}
	for _, hit := range hits {
		if hit.Session != "conversa-a" {
			t.Fatalf("trecho na conversa errada: %q", hit.Session)
		}
		if !strings.Contains(strings.ToLower(hit.Snippet), "deploy") {
			t.Fatalf("o trecho não contém o termo: %q", hit.Snippet)
		}
		if hit.Seq == 0 || hit.Turn != "t1" {
			t.Fatalf("trecho sem âncora de replay: seq=%d turn=%q", hit.Seq, hit.Turn)
		}
	}
}

func TestSearchRespeitaOLimiteEATetoPorSessao(t *testing.T) {
	opened := searchStore(t)
	// Uma conversa monotemática não pode engolir a lista: mais menções que o
	// teto por sessão, e a resposta devolve só searchHitsPerSession dela.
	for i := 0; i < searchHitsPerSession+3; i++ {
		envelope := &protocol.Envelope{Kind: protocol.KindMessage, From: protocol.Actor{Kind: protocol.ActorUser}}
		_ = envelope.SetPayload(protocol.Message{Role: "user", Text: fmt.Sprintf("café %d", i)})
		if _, err := opened.Append("conversa-b", envelope); err != nil {
			t.Fatalf("Append: %v", err)
		}
	}

	hits, err := opened.SearchSessions("café", 0)
	if err != nil {
		t.Fatalf("SearchSessions: %v", err)
	}
	porSessao := 0
	for _, hit := range hits {
		if hit.Session == "conversa-b" {
			porSessao++
		}
	}
	if porSessao != searchHitsPerSession {
		t.Fatalf("teto por sessão: esperava %d, obteve %d", searchHitsPerSession, porSessao)
	}

	um, err := opened.SearchSessions("café", 1)
	if err != nil || len(um) != 1 {
		t.Fatalf("limite total: esperava 1 trecho, obteve %d (erro: %v)", len(um), err)
	}
}

func TestSearchComQueryVaziaDevolveNada(t *testing.T) {
	opened := searchStore(t)
	hits, err := opened.SearchSessions("   ", 0)
	if err != nil {
		t.Fatalf("SearchSessions vazia: %v", err)
	}
	if len(hits) != 0 {
		t.Fatalf("query vazia devolveu %d trechos", len(hits))
	}
}

func TestSnippetAroundCortaEmFronteiraDeRune(t *testing.T) {
	texto := strings.Repeat("çã", 80) + " ALVO " + strings.Repeat("éõ", 80)
	at := strings.Index(texto, "ALVO")
	trecho := snippetAround(texto, at, len("ALVO"))
	if !strings.Contains(trecho, "ALVO") {
		t.Fatalf("o trecho perdeu o termo: %q", trecho)
	}
	if strings.ContainsRune(trecho, '�') {
		t.Fatalf("o corte partiu um caractere: %q", trecho)
	}
	if !strings.HasPrefix(trecho, "…") || !strings.HasSuffix(trecho, "…") {
		t.Fatalf("trecho do meio sem reticências nas pontas: %q", trecho)
	}
}
