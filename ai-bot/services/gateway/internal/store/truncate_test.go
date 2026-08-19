// Testes do corte durável (truncate.go).
//
// O que está em jogo aqui é a invariante do pacote inteiro: seq contínuo 1..N.
// Um corte que deixasse buraco — ou que deixasse o Append seguinte numerar por
// cima do que sobrou — faria o replay entregar um envelope pelo outro, que é
// exatamente a corrupção silenciosa que o log existe para impedir.
package store

import (
	"testing"

	"aibot/gateway/internal/protocol"
)

// doneOf fabrica o envelope que fecha um turno — é ele que conta em Turns.
func doneOf(turn string) *protocol.Envelope {
	envelope := &protocol.Envelope{
		ID:   "d-" + turn,
		Turn: turn,
		Kind: protocol.KindDone,
		From: protocol.Actor{Kind: protocol.ActorSupervisor},
	}
	_ = envelope.SetPayload(protocol.Done{Turn: turn})
	return envelope
}

// turnMessage fabrica uma mensagem carimbada com o turno — o que o
// FirstSeqOfTurn procura.
func turnMessage(turn, text string) *protocol.Envelope {
	envelope := userMessage(text)
	envelope.Turn = turn
	return envelope
}

func appendOrFail(t *testing.T, opened *Store, envelope *protocol.Envelope) uint64 {
	t.Helper()
	seq, err := opened.Append(testSession, envelope)
	if err != nil {
		t.Fatalf("Append: esperava sucesso, obteve erro: %v", err)
	}
	return seq
}

func TestTruncateBeforeCortaDuravelEContinuaANumeracao(t *testing.T) {
	opened, _ := newStoreWithSession(t)

	// Dois turnos completos: pergunta + done, pergunta + done.
	appendOrFail(t, opened, turnMessage("t1", "primeira pergunta"))
	appendOrFail(t, opened, doneOf("t1"))
	cutAt := appendOrFail(t, opened, turnMessage("t2", "segunda pergunta"))
	appendOrFail(t, opened, doneOf("t2"))

	meta, err := opened.TruncateBefore(testSession, cutAt)
	if err != nil {
		t.Fatalf("TruncateBefore(%d): esperava sucesso, obteve erro: %v", cutAt, err)
	}
	if meta.LastSeq != cutAt-1 {
		t.Fatalf("LastSeq depois do corte: esperava %d, obteve %d", cutAt-1, meta.LastSeq)
	}
	if meta.Turns != 1 {
		t.Fatalf("Turns depois do corte: esperava 1 (só o t1 sobrou), obteve %d", meta.Turns)
	}

	// O replay devolve SÓ o prefixo — o segundo turno morreu de verdade.
	events, err := opened.Since(testSession, 0, 0)
	if err != nil {
		t.Fatalf("Since depois do corte: %v", err)
	}
	if len(events) != int(cutAt-1) {
		t.Fatalf("replay depois do corte: esperava %d envelopes, obteve %d", cutAt-1, len(events))
	}
	for _, envelope := range events {
		if envelope.Turn == "t2" {
			t.Fatalf("o turno cortado ainda aparece no replay (seq %d)", envelope.Seq)
		}
	}

	// O Append seguinte continua do novo fim — sem buraco e sem colisão.
	next := appendOrFail(t, opened, turnMessage("t3", "pergunta refeita"))
	if next != cutAt {
		t.Fatalf("seq depois do corte: esperava %d (continua do novo fim), obteve %d", cutAt, next)
	}
}

func TestTruncateSobreviveAoReabrirOStore(t *testing.T) {
	opened, root := newStoreWithSession(t)
	appendMessages(t, opened, "fica", "fica também", "sai")

	if _, err := opened.TruncateBefore(testSession, 3); err != nil {
		t.Fatalf("TruncateBefore: %v", err)
	}
	if err := opened.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	// Reaberto do zero, o log tem de contar a mesma história: o corte foi ao
	// disco, não só ao cache do processo.
	reopened := openStore(t, root)
	seq, err := reopened.LastSeq(testSession)
	if err != nil {
		t.Fatalf("LastSeq reaberto: %v", err)
	}
	if seq != 2 {
		t.Fatalf("LastSeq reaberto: esperava 2, obteve %d", seq)
	}
	events, err := reopened.Since(testSession, 0, 0)
	if err != nil || len(events) != 2 {
		t.Fatalf("replay reaberto: esperava 2 envelopes, obteve %d (erro: %v)", len(events), err)
	}
}

func TestTruncateAlemDoFimENoOp(t *testing.T) {
	opened, _ := newStoreWithSession(t)
	appendMessages(t, opened, "única")

	meta, err := opened.TruncateBefore(testSession, 99)
	if err != nil {
		t.Fatalf("corte além do fim: esperava no-op, obteve erro: %v", err)
	}
	if meta.LastSeq != 1 {
		t.Fatalf("no-op mexeu no LastSeq: esperava 1, obteve %d", meta.LastSeq)
	}
}

func TestTruncateRecusaCorteEmZero(t *testing.T) {
	opened, _ := newStoreWithSession(t)
	if _, err := opened.TruncateBefore(testSession, 0); err == nil {
		t.Fatal("corte em zero: esperava recusa, obteve sucesso")
	}
}

func TestTruncateRebaixaOCursorDeSincronizacao(t *testing.T) {
	opened, _ := newStoreWithSession(t)
	appendMessages(t, opened, "a", "b", "c")
	if err := opened.MarkSynced(testSession, 3); err != nil {
		t.Fatalf("MarkSynced: %v", err)
	}

	meta, err := opened.TruncateBefore(testSession, 2)
	if err != nil {
		t.Fatalf("TruncateBefore: %v", err)
	}
	// O espelho não pode apontar para além do que existe: seq 1 é o novo fim.
	if meta.SyncedSeq != 1 {
		t.Fatalf("SyncedSeq depois do corte: esperava 1, obteve %d", meta.SyncedSeq)
	}
}

func TestFirstSeqOfTurnAchaOComecoDoTurno(t *testing.T) {
	opened, _ := newStoreWithSession(t)
	appendOrFail(t, opened, turnMessage("t1", "pergunta"))
	appendOrFail(t, opened, doneOf("t1"))
	inicio := appendOrFail(t, opened, turnMessage("t2", "outra"))
	appendOrFail(t, opened, doneOf("t2"))

	seq, err := opened.FirstSeqOfTurn(testSession, "t2")
	if err != nil {
		t.Fatalf("FirstSeqOfTurn: %v", err)
	}
	if seq != inicio {
		t.Fatalf("FirstSeqOfTurn(t2): esperava %d, obteve %d", inicio, seq)
	}

	missing, err := opened.FirstSeqOfTurn(testSession, "t-fantasma")
	if err != nil || missing != 0 {
		t.Fatalf("turno inexistente: esperava (0, nil), obteve (%d, %v)", missing, err)
	}
}
