package contextrt

import (
	"encoding/json"
	"strings"
	"testing"

	"aibot/gateway/internal/protocol"
)

func envelope(seq uint64, kind protocol.Kind, payload any) protocol.Envelope {
	raw, _ := json.Marshal(payload)
	return protocol.Envelope{V: 1, Seq: seq, Kind: kind, Payload: raw}
}

// A dobra transforma HISTÓRIA em ESTADO: o exemplo canônico da especificação —
// "rodei, deu erro, corrigi, funcionou" vira um erro RESOLVIDO, não quatro
// mensagens.
func TestFoldTransformaHistoriaEmEstado(t *testing.T) {
	capsule := New()
	capsule.Fold([]protocol.Envelope{
		envelope(1, protocol.KindMessage, protocol.Message{Role: "user", Text: "crie a API de cobrança"}),
		envelope(2, protocol.KindRoute, protocol.Route{Specialist: "code", Reason: "heuristic"}),
		envelope(3, protocol.KindToolCall, protocol.ToolCall{CallID: "c1", Tool: "fs.write",
			Args: json.RawMessage(`{"path":"api/cobranca.go"}`)}),
		envelope(4, protocol.KindToolResult, protocol.ToolResult{CallID: "c1", Tool: "fs.write", OK: false,
			Error: "pasta inexistente"}),
		envelope(5, protocol.KindToolCall, protocol.ToolCall{CallID: "c2", Tool: "fs.write",
			Args: json.RawMessage(`{"path":"api/cobranca.go"}`)}),
		envelope(6, protocol.KindToolResult, protocol.ToolResult{CallID: "c2", Tool: "fs.write", OK: true}),
		envelope(7, protocol.KindDelegate, protocol.Delegate{From: "code", To: "data", Goal: "modele as tabelas"}),
		envelope(8, protocol.KindDelegate, protocol.Delegate{From: "code", To: "data", Goal: "modele as tabelas",
			Done: true, Result: "cobranca(id, valor)"}),
	})

	if capsule.Goal != "crie a API de cobrança" {
		t.Errorf("objetivo: %q", capsule.Goal)
	}
	if capsule.Cursor != 8 {
		t.Errorf("cursor: %d", capsule.Cursor)
	}
	// O erro do fs.write foi RESOLVIDO pelo sucesso posterior da mesma ferramenta.
	for _, failure := range capsule.Errors {
		if failure.Status == "open" {
			t.Errorf("não devia sobrar erro aberto: %+v", failure)
		}
	}
	// O arquivo tocado aparece UMA vez, como modificado.
	if len(capsule.Files) != 1 || capsule.Files[0].Status != "modified" {
		t.Errorf("arquivos: %+v", capsule.Files)
	}
	// A delegação virou DUAS decisões: quem entrou e o que entregou.
	texto := capsule.Render()
	if !strings.Contains(texto, "delegou a data") || !strings.Contains(texto, "data entregou") {
		t.Errorf("as decisões da delegação não estão no render:\n%s", texto)
	}
}

// A dobra é INCREMENTAL e idempotente por cursor: reprocessar os mesmos
// envelopes não duplica nada — é o que protege contra a dobra dupla de um
// turno substituído terminando junto com o substituto.
func TestFoldIdempotentePorCursor(t *testing.T) {
	lote := []protocol.Envelope{
		envelope(1, protocol.KindMessage, protocol.Message{Role: "user", Text: "oi"}),
		envelope(2, protocol.KindRoute, protocol.Route{Specialist: "chat", Reason: "heuristic"}),
	}
	capsule := New()
	capsule.Fold(lote)
	decisoes := len(capsule.Decisions)
	capsule.Fold(lote)
	if len(capsule.Decisions) != decisoes {
		t.Fatalf("a redobra duplicou decisões: %d → %d", decisoes, len(capsule.Decisions))
	}
	if capsule.Telemetry.Folds != 2 {
		t.Fatalf("as dobras contam mesmo vazias: %d", capsule.Telemetry.Folds)
	}
}

// Os tetos valem: a cápsula é working set, e o excedente cai pelo MAIS ANTIGO.
func TestFoldRespeitaOsTetos(t *testing.T) {
	capsule := New()
	lote := make([]protocol.Envelope, 0, 40)
	for seq := uint64(1); seq <= 40; seq++ {
		lote = append(lote, envelope(seq, protocol.KindDelegate,
			protocol.Delegate{From: "a", To: "b", Goal: strings.Repeat("x", 10) + string(rune('a'+seq%26))}))
	}
	capsule.Fold(lote)
	if len(capsule.Decisions) > maxDecisions {
		t.Fatalf("decisões acima do teto: %d", len(capsule.Decisions))
	}
}

// Ilegível não derruba: cápsula corrompida vira cápsula nova, e as dobras
// seguintes a refazem — o log continua sendo a fonte.
func TestLoadTolerante(t *testing.T) {
	if capsule := Load([]byte("{quebrado")); capsule == nil || capsule.Cursor != 0 {
		t.Fatal("cápsula corrompida tinha de virar uma nova")
	}
	if capsule := Load(nil); capsule == nil {
		t.Fatal("vazio tinha de virar uma nova")
	}
}

// Render vazio para sessão sem nada: conversa nova não paga por estado que
// não tem.
func TestRenderVazioSemDobra(t *testing.T) {
	if texto := New().Render(); texto != "" {
		t.Fatalf("cápsula vazia rendeu texto: %q", texto)
	}
}
