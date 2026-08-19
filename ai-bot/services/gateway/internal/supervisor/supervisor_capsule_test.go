// A cápsula de ponta a ponta no supervisor: o turno dobra, o próximo turno lê.
package supervisor

import (
	"strings"
	"testing"

	"aibot/gateway/internal/eventbus"
	"aibot/gateway/internal/protocol"
	"aibot/gateway/internal/store"
)

// O que estava além da janela recente SUMIA do contexto; agora vira estado. O
// teste encena a sequência real: turno acontece → foldCapsule (o defer do
// runTurn) → capsuleMessage entrega o destilado para o prompt seguinte.
func TestCapsulaDobraNoFimDoTurnoEVoltaNoProximo(t *testing.T) {
	dataStore, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("abrir o store: %v", err)
	}
	defer dataStore.Close()
	if _, err := dataStore.CreateSession(store.SessionMeta{ID: "s1", Title: "API de cobrança"}); err != nil {
		t.Fatalf("criar sessão: %v", err)
	}

	supervisor := New(Deps{Store: dataStore, Bus: eventbus.New(dataStore)})

	// Antes de qualquer dobra, a cápsula não gasta janela.
	if rendered := supervisor.capsuleMessage("s1"); rendered != "" {
		t.Fatalf("sessão nova rendeu cápsula: %q", rendered)
	}

	// O turno acontece: pedido, rota, uma ferramenta que falhou e passou.
	_ = supervisor.emit("s1", "t1", protocol.KindMessage,
		protocol.Actor{Kind: protocol.ActorUser}, protocol.Message{Role: "user", Text: "crie a API de cobrança"})
	_ = supervisor.emit("s1", "t1", protocol.KindRoute,
		protocol.Actor{Kind: protocol.ActorSupervisor}, protocol.Route{Specialist: "code", Reason: "heuristic"})
	_ = supervisor.emit("s1", "t1", protocol.KindToolResult,
		protocol.Actor{Kind: protocol.ActorSpecialist, Specialist: "code"},
		protocol.ToolResult{CallID: "c1", Tool: "proc.run", OK: false, Error: "faltou o pacote X"})

	supervisor.foldCapsule("s1")

	rendered := supervisor.capsuleMessage("s1")
	if !strings.Contains(rendered, "crie a API de cobrança") {
		t.Errorf("o objetivo não chegou à cápsula:\n%s", rendered)
	}
	if !strings.Contains(rendered, "proc.run: faltou o pacote X") {
		t.Errorf("o erro ABERTO não chegou à cápsula:\n%s", rendered)
	}

	// O turno seguinte resolve o erro; a dobra incremental o marca.
	_ = supervisor.emit("s1", "t2", protocol.KindToolResult,
		protocol.Actor{Kind: protocol.ActorSpecialist, Specialist: "code"},
		protocol.ToolResult{CallID: "c2", Tool: "proc.run", OK: true, Output: "compilado"})
	supervisor.foldCapsule("s1")

	if depois := supervisor.capsuleMessage("s1"); strings.Contains(depois, "AINDA ABERTOS") {
		t.Errorf("o erro resolvido continuou aberto:\n%s", depois)
	}
}
