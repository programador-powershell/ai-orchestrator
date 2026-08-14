// Testes do envelope canônico.
//
// O envelope é o único vocabulário que atravessa o gateway: HTTP, WebSocket,
// ACP, MCP e CLI serializam o MESMO tipo. Um envelope malformado tem de morrer
// na borda — três camadas adiante ele vira um switch caindo no default em
// silêncio.
package protocol

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func sampleEnvelope() Envelope {
	return Envelope{
		V:       Version,
		ID:      "e-1",
		TS:      time.Date(2026, time.August, 14, 12, 30, 0, 0, time.UTC),
		Seq:     7,
		Session: "sessao-1",
		Turn:    "t-1",
		Kind:    KindPrompt,
		From:    Actor{Kind: ActorUser},
	}
}

/* -------------------------------- Validate ------------------------------- */

func TestValidateRejectsMalformedEnvelopes(t *testing.T) {
	cases := []struct {
		name        string
		mutate      func(*Envelope)
		wantMessage string
	}{
		{"versão errada", func(e *Envelope) { e.V = Version + 1 }, "versão"},
		{"versão zero", func(e *Envelope) { e.V = 0 }, "versão"},
		{"sessão vazia", func(e *Envelope) { e.Session = "" }, "sessão vazia"},
		{"verbo desconhecido", func(e *Envelope) { e.Kind = Kind("inventado") }, "verbo desconhecido"},
		{"verbo vazio", func(e *Envelope) { e.Kind = Kind("") }, "verbo desconhecido"},
		{"remetente sem tipo", func(e *Envelope) { e.From = Actor{ID: "code"} }, "remetente sem tipo"},
	}

	for _, each := range cases {
		t.Run(each.name, func(t *testing.T) {
			envelope := sampleEnvelope()
			each.mutate(&envelope)

			err := envelope.Validate()
			if err == nil {
				t.Fatalf("Validate: esperava erro contendo %q, obteve nil", each.wantMessage)
			}
			if !errors.Is(err, ErrInvalidEnvelope) {
				t.Errorf("Validate: esperava um erro de %q, obteve %q", ErrInvalidEnvelope, err)
			}
			if !strings.Contains(err.Error(), each.wantMessage) {
				t.Errorf("Validate: esperava erro contendo %q, obteve %q", each.wantMessage, err)
			}
		})
	}

	t.Run("envelope nulo", func(t *testing.T) {
		var missing *Envelope
		err := missing.Validate()
		if err == nil {
			t.Fatalf("Validate em ponteiro nulo: esperava erro, obteve nil")
		}
		if !errors.Is(err, ErrInvalidEnvelope) {
			t.Errorf("Validate em ponteiro nulo: esperava um erro de %q, obteve %q", ErrInvalidEnvelope, err)
		}
	})

	t.Run("envelope bem formado", func(t *testing.T) {
		envelope := sampleEnvelope()
		if err := envelope.Validate(); err != nil {
			t.Fatalf("Validate em envelope bem formado: esperava nil, obteve %q", err)
		}
	})
}

func TestKindValidRejectsUnknownVerbs(t *testing.T) {
	known := []Kind{
		KindHello, KindReady, KindError, KindDone,
		KindPrompt, KindRoute, KindDelta, KindMessage, KindThinking,
		KindToolCall, KindToolResult,
		KindApprovalRequest, KindApprovalDecision,
		KindTaskDispatch, KindTaskProgress, KindWorkerDone,
		KindEscalate, KindAsk, KindReply, KindGate,
		KindState,
	}
	for _, kind := range known {
		if !kind.Valid() {
			t.Errorf("Kind(%q).Valid(): esperava true, obteve false", kind)
		}
	}
	for _, kind := range []Kind{"", "prompt.novo", "TOOL.CALL", "inventado"} {
		if kind.Valid() {
			t.Errorf("Kind(%q).Valid(): esperava false, obteve true", kind)
		}
	}
}

/* --------------------------- payload ida e volta -------------------------- */

func TestSetPayloadAndDecodeRoundTrip(t *testing.T) {
	envelope := sampleEnvelope()
	envelope.Kind = KindToolCall
	envelope.From = Actor{Kind: ActorSpecialist, ID: "code", Specialist: "code"}

	want := ToolCall{
		CallID: "c-1",
		Tool:   "fs.write",
		Args:   json.RawMessage(`{"path":"src/main.go","content":"pacote"}`),
		Digest: "deadbeefcafe",
	}
	if err := envelope.SetPayload(want); err != nil {
		t.Fatalf("SetPayload: esperava sucesso, obteve erro: %v", err)
	}
	if len(envelope.Payload) == 0 {
		t.Fatalf("SetPayload: esperava o payload preenchido, obteve vazio")
	}

	// Ida e volta pelo transporte, que é o caminho real do envelope.
	raw, err := json.Marshal(envelope)
	if err != nil {
		t.Fatalf("Marshal do envelope: esperava sucesso, obteve erro: %v", err)
	}
	var arrived Envelope
	if err := json.Unmarshal(raw, &arrived); err != nil {
		t.Fatalf("Unmarshal do envelope: esperava sucesso, obteve erro: %v", err)
	}

	if arrived.V != envelope.V || arrived.ID != envelope.ID || arrived.Seq != envelope.Seq {
		t.Errorf("cabeçalho do envelope: esperava v=%d id=%q seq=%d, obteve v=%d id=%q seq=%d",
			envelope.V, envelope.ID, envelope.Seq, arrived.V, arrived.ID, arrived.Seq)
	}
	if arrived.Session != envelope.Session || arrived.Turn != envelope.Turn || arrived.Kind != envelope.Kind {
		t.Errorf("envelope: esperava sessão=%q turno=%q verbo=%q, obteve sessão=%q turno=%q verbo=%q",
			envelope.Session, envelope.Turn, envelope.Kind, arrived.Session, arrived.Turn, arrived.Kind)
	}
	if !arrived.TS.Equal(envelope.TS) {
		t.Errorf("carimbo de tempo: esperava %s, obteve %s", envelope.TS, arrived.TS)
	}
	if arrived.From != envelope.From {
		t.Errorf("remetente: esperava %+v, obteve %+v", envelope.From, arrived.From)
	}

	var got ToolCall
	if err := arrived.Decode(&got); err != nil {
		t.Fatalf("Decode: esperava sucesso, obteve erro: %v", err)
	}
	if got.CallID != want.CallID || got.Tool != want.Tool || got.Digest != want.Digest {
		t.Errorf("payload: esperava callId=%q tool=%q digest=%q, obteve callId=%q tool=%q digest=%q",
			want.CallID, want.Tool, want.Digest, got.CallID, got.Tool, got.Digest)
	}
	if string(got.Args) != string(want.Args) {
		t.Errorf("args do payload: esperava %s, obteve %s", want.Args, got.Args)
	}
}

func TestDecodeRejectsMissingAndBrokenPayload(t *testing.T) {
	envelope := sampleEnvelope()

	var prompt Prompt
	if err := envelope.Decode(&prompt); err == nil {
		t.Fatalf("Decode sem payload: esperava erro, obteve nil")
	} else if !errors.Is(err, ErrInvalidEnvelope) {
		t.Errorf("Decode sem payload: esperava um erro de %q, obteve %q", ErrInvalidEnvelope, err)
	}

	envelope.Payload = json.RawMessage(`{"text":`)
	if err := envelope.Decode(&prompt); err == nil {
		t.Fatalf("Decode com payload quebrado: esperava erro, obteve nil")
	} else if !errors.Is(err, ErrInvalidEnvelope) {
		t.Errorf("Decode com payload quebrado: esperava um erro de %q, obteve %q", ErrInvalidEnvelope, err)
	}
}

func TestSetPayloadNilClearsThePayload(t *testing.T) {
	envelope := sampleEnvelope()
	if err := envelope.SetPayload(Prompt{Text: "oi"}); err != nil {
		t.Fatalf("SetPayload: esperava sucesso, obteve erro: %v", err)
	}
	if err := envelope.SetPayload(nil); err != nil {
		t.Fatalf("SetPayload(nil): esperava sucesso, obteve erro: %v", err)
	}
	if envelope.Payload != nil {
		t.Errorf("SetPayload(nil): esperava o payload nil, obteve %s", envelope.Payload)
	}
}

/* ------------------------------ serialização ----------------------------- */

// `To` é ponteiro justamente para "sem destino" — o caso comum, que é o
// broadcast para a UI — serializar como ausente. `omitempty` em struct não
// omite nada: o campo sairia como {"kind":""} em todo envelope.
func TestToDisappearsFromJSONWhenNil(t *testing.T) {
	envelope := sampleEnvelope()
	if envelope.To != nil {
		t.Fatalf("o envelope de exemplo deveria nascer sem destino")
	}

	raw, err := json.Marshal(envelope)
	if err != nil {
		t.Fatalf("Marshal: esperava sucesso, obteve erro: %v", err)
	}
	encoded := string(raw)
	if strings.Contains(encoded, `"to"`) {
		t.Errorf("Marshal com To nil: esperava o campo \"to\" ausente, obteve %s", encoded)
	}
	if strings.Contains(encoded, `"payload"`) {
		t.Errorf("Marshal sem payload: esperava o campo \"payload\" ausente, obteve %s", encoded)
	}

	envelope.To = &Actor{Kind: ActorUser}
	raw, err = json.Marshal(envelope)
	if err != nil {
		t.Fatalf("Marshal com destino: esperava sucesso, obteve erro: %v", err)
	}
	if !strings.Contains(string(raw), `"to":{"kind":"user"}`) {
		t.Errorf("Marshal com destino: esperava %q no JSON, obteve %s", `"to":{"kind":"user"}`, raw)
	}
}
