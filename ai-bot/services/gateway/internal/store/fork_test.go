// Testes do fork de sessão.
//
// As três garantias, em ordem de importância: o fork é o PREFIXO EXATO da
// origem (mesmos envelopes, mesmos seq); as duas sessões são independentes
// depois do corte (mensagem nova de um lado não vaza para o outro); e o
// `fromSeq` corta exatamente onde pediu.
package store

import (
	"strings"
	"testing"

	"aibot/gateway/internal/protocol"
)

// doneEnvelope fecha um turno — é o que o cabeçalho conta em Turns.
func doneEnvelope(turn string) *protocol.Envelope {
	envelope := &protocol.Envelope{
		ID:   "d-" + turn,
		Turn: turn,
		Kind: protocol.KindDone,
		From: protocol.Actor{Kind: protocol.ActorSupervisor},
	}
	_ = envelope.SetPayload(protocol.Done{Turn: turn})
	return envelope
}

func fork(t *testing.T, opened *Store, fromSeq uint64, title string) SessionMeta {
	t.Helper()
	meta, err := opened.ForkSession(testSession, fromSeq, title)
	if err != nil {
		t.Fatalf("ForkSession(%d): esperava sucesso, obteve erro: %v", fromSeq, err)
	}
	return meta
}

func TestForkCopiaOPrefixoExatoComOsMesmosSeq(t *testing.T) {
	opened, _ := newStoreWithSession(t)
	appendMessages(t, opened, "primeira", "segunda", "terceira")

	meta := fork(t, opened, 0, "")

	if meta.ID == testSession {
		t.Fatalf("o fork precisa ser uma sessão NOVA, veio o mesmo id %q", meta.ID)
	}
	if meta.LastSeq != 3 {
		t.Errorf("LastSeq do fork: esperava 3, obteve %d", meta.LastSeq)
	}

	source, err := opened.Since(testSession, 0, 0)
	if err != nil {
		t.Fatalf("Since na origem: %v", err)
	}
	forked, err := opened.Since(meta.ID, 0, 0)
	if err != nil {
		t.Fatalf("Since no fork: %v", err)
	}
	if len(forked) != len(source) {
		t.Fatalf("o fork precisa do prefixo inteiro: origem tem %d, fork tem %d", len(source), len(forked))
	}
	for index := range forked {
		got, want := forked[index], source[index]
		// O seq NÃO é renumerado: o fork é um prefixo idêntico, e é isso que
		// mantém replay e cursores válidos na sessão nova.
		if got.Seq != want.Seq {
			t.Errorf("envelope %d: seq %d no fork, %d na origem — o fork não renumera", index, got.Seq, want.Seq)
		}
		// A única reescrita permitida é o campo session.
		if got.Session != meta.ID {
			t.Errorf("envelope %d: session %q, esperava %q", index, got.Session, meta.ID)
		}
		if string(got.Payload) != string(want.Payload) {
			t.Errorf("envelope %d: o payload mudou na cópia:\n%s\n%s", index, got.Payload, want.Payload)
		}
	}
}

func TestForkHerdaCabecalhoEComecaDessincronizado(t *testing.T) {
	opened, _ := newStoreWithSession(t)
	if _, err := opened.UpdateSession(testSession, func(meta *SessionMeta) {
		meta.Specialist = "data"
		meta.CWD = "C:/projetos/cobranca"
		meta.ProjectID = "p-cobranca"
	}); err != nil {
		t.Fatalf("UpdateSession: %v", err)
	}
	appendMessages(t, opened, "primeira")
	if err := opened.MarkSynced(testSession, 1); err != nil {
		t.Fatalf("MarkSynced: %v", err)
	}

	meta := fork(t, opened, 0, "")

	if meta.Specialist != "data" || meta.CWD != "C:/projetos/cobranca" || meta.ProjectID != "p-cobranca" {
		t.Errorf("o fork precisa herdar especialista, pasta e projeto; obteve %+v", meta)
	}
	if !strings.HasPrefix(meta.Title, "fork: ") {
		t.Errorf("título padrão precisa ser \"fork: <original>\"; obteve %q", meta.Title)
	}
	// O espelho nunca viu a sessão nova: herdar o cursor faria o servidor pular
	// exatamente o prefixo que o fork acabou de criar.
	if meta.SyncedSeq != 0 {
		t.Errorf("SyncedSeq do fork precisa nascer em 0, obteve %d", meta.SyncedSeq)
	}
}

func TestForkNaoVazaMensagensNovasEntreAsSessoes(t *testing.T) {
	opened, _ := newStoreWithSession(t)
	appendMessages(t, opened, "primeira", "segunda")

	meta := fork(t, opened, 0, "ramo postgres")

	// Futuros diferentes: um lado recebe uma mensagem, o outro recebe outra.
	if _, err := opened.Append(meta.ID, userMessage("só no fork")); err != nil {
		t.Fatalf("Append no fork: %v", err)
	}
	if _, err := opened.Append(testSession, userMessage("só na origem")); err != nil {
		t.Fatalf("Append na origem: %v", err)
	}

	assertTexts := func(session, mustHave, mustNotHave string) {
		t.Helper()
		envelopes, err := opened.Since(session, 0, 0)
		if err != nil {
			t.Fatalf("Since(%s): %v", session, err)
		}
		all := ""
		for _, envelope := range envelopes {
			all += string(envelope.Payload)
			// Nenhum envelope pode carregar o id da OUTRA sessão.
			if envelope.Session != session {
				t.Errorf("envelope %d de %s diz pertencer a %q", envelope.Seq, session, envelope.Session)
			}
		}
		if !strings.Contains(all, mustHave) {
			t.Errorf("%s: esperava conter %q", session, mustHave)
		}
		if strings.Contains(all, mustNotHave) {
			t.Errorf("%s: a mensagem %q vazou da outra sessão", session, mustNotHave)
		}
	}
	assertTexts(meta.ID, "só no fork", "só na origem")
	assertTexts(testSession, "só na origem", "só no fork")

	// E a numeração dos dois lados segue independente a partir do mesmo prefixo:
	// ambos tinham LastSeq 2, ambos ganharam a mensagem 3 — cada um a sua.
	forkLast, _ := opened.LastSeq(meta.ID)
	sourceLast, _ := opened.LastSeq(testSession)
	if forkLast != 3 || sourceLast != 3 {
		t.Errorf("LastSeq depois dos appends: fork %d, origem %d — esperava 3 e 3", forkLast, sourceLast)
	}
}

func TestForkCortaNoFromSeqPedido(t *testing.T) {
	opened, _ := newStoreWithSession(t)
	appendMessages(t, opened, "primeira", "segunda")
	if _, err := opened.Append(testSession, doneEnvelope("t1")); err != nil {
		t.Fatalf("Append(done): %v", err)
	}
	appendMessages(t, opened, "quarta", "quinta")

	meta := fork(t, opened, 3, "")

	if meta.LastSeq != 3 {
		t.Errorf("LastSeq do fork: esperava 3 (o corte), obteve %d", meta.LastSeq)
	}
	// O prefixo copiado carrega um turno fechado — e o cabeçalho precisa dizer
	// isso sem abrir o log, porque é ele que a barra lateral mostra.
	if meta.Turns != 1 {
		t.Errorf("Turns do fork: esperava 1, obteve %d", meta.Turns)
	}

	envelopes, err := opened.Since(meta.ID, 0, 0)
	if err != nil {
		t.Fatalf("Since no fork: %v", err)
	}
	if got := seqsOf(envelopes); !sameSeqs(got, []uint64{1, 2, 3}) {
		t.Fatalf("o corte em 3 precisa copiar exatamente [1 2 3]; obteve %v", got)
	}
	for _, envelope := range envelopes {
		var message protocol.Message
		if envelope.Kind == protocol.KindMessage {
			if err := envelope.Decode(&message); err != nil {
				t.Fatalf("Decode: %v", err)
			}
			if message.Text == "quarta" || message.Text == "quinta" {
				t.Errorf("mensagem depois do corte vazou para o fork: %q", message.Text)
			}
		}
	}

	// Corte além do fim não é erro: é "tudo o que existe agora".
	beyond := fork(t, opened, 99, "")
	if beyond.LastSeq != 5 {
		t.Errorf("corte além do fim precisa copiar o log inteiro (5), obteve %d", beyond.LastSeq)
	}
}

func TestForkDeSessaoVaziaNasceValido(t *testing.T) {
	opened, _ := newStoreWithSession(t)

	meta := fork(t, opened, 0, "")
	if meta.LastSeq != 0 || meta.Turns != 0 {
		t.Errorf("fork de sessão vazia: esperava LastSeq 0 e Turns 0, obteve %+v", meta)
	}
	// E a sessão nova aceita mensagens normalmente.
	if _, err := opened.Append(meta.ID, userMessage("primeira do ramo")); err != nil {
		t.Fatalf("Append no fork vazio: %v", err)
	}
}

func TestForkDeSessaoInexistenteRecusaComNotFound(t *testing.T) {
	opened := openStore(t, t.TempDir())
	if _, err := opened.ForkSession("nao-existe", 0, ""); err == nil {
		t.Fatal("esperava recusa para sessão inexistente, obteve sucesso")
	}
}
