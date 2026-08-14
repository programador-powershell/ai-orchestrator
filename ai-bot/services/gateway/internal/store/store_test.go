// Testes do log durável.
//
// O disco desta máquina é a FONTE DA VERDADE: o que este pacote errar não
// aparece como tela quebrada, aparece como conversa perdida ou como dois
// eventos com o mesmo número — que o replay entrega um pelo outro.
//
// Teste interno (package store) de propósito: `safeID` é o único ponto em que
// um id vindo do cliente encosta no sistema de arquivos e precisa de teste
// direto, não por dedução.
package store

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"

	"aibot/gateway/internal/protocol"
)

const testSession = "sessao-de-teste"

/* ------------------------------ auxiliares ------------------------------ */

func openStore(t *testing.T, root string) *Store {
	t.Helper()
	opened, err := Open(root)
	if err != nil {
		t.Fatalf("Open(%q): esperava sucesso, obteve erro: %v", root, err)
	}
	t.Cleanup(func() { _ = opened.Close() })
	return opened
}

// newStoreWithSession devolve um store novo, já com a sessão de teste criada, e
// a raiz em disco para os testes que precisam mexer nos arquivos.
func newStoreWithSession(t *testing.T) (*Store, string) {
	t.Helper()
	root := t.TempDir()
	opened := openStore(t, root)
	if _, err := opened.CreateSession(SessionMeta{ID: testSession, Title: "conversa de teste"}); err != nil {
		t.Fatalf("CreateSession(%q): esperava sucesso, obteve erro: %v", testSession, err)
	}
	return opened, root
}

func userMessage(text string) *protocol.Envelope {
	envelope := &protocol.Envelope{
		ID:   "e-" + text,
		Kind: protocol.KindMessage,
		From: protocol.Actor{Kind: protocol.ActorUser},
	}
	_ = envelope.SetPayload(protocol.Message{Role: "user", Text: text})
	return envelope
}

func appendMessages(t *testing.T, opened *Store, texts ...string) []uint64 {
	t.Helper()
	seqs := make([]uint64, 0, len(texts))
	for _, text := range texts {
		seq, err := opened.Append(testSession, userMessage(text))
		if err != nil {
			t.Fatalf("Append(%q): esperava sucesso, obteve erro: %v", text, err)
		}
		seqs = append(seqs, seq)
	}
	return seqs
}

func sessionFile(root, name string) string {
	return filepath.Join(root, "sessions", safeID(testSession), name)
}

func seqsOf(envelopes []protocol.Envelope) []uint64 {
	out := make([]uint64, 0, len(envelopes))
	for _, envelope := range envelopes {
		out = append(out, envelope.Seq)
	}
	return out
}

func sameSeqs(got, want []uint64) bool {
	if len(got) != len(want) {
		return false
	}
	for index := range got {
		if got[index] != want[index] {
			return false
		}
	}
	return true
}

/* -------------------------------- append -------------------------------- */

func TestAppendNumbersFromOneAndSinceReturnsInOrder(t *testing.T) {
	opened, _ := newStoreWithSession(t)

	seqs := appendMessages(t, opened, "primeira", "segunda", "terceira")
	if !sameSeqs(seqs, []uint64{1, 2, 3}) {
		t.Fatalf("Append: esperava os números [1 2 3], obteve %v", seqs)
	}

	events, err := opened.Since(testSession, 0, 0)
	if err != nil {
		t.Fatalf("Since(0): esperava sucesso, obteve erro: %v", err)
	}
	if got := seqsOf(events); !sameSeqs(got, []uint64{1, 2, 3}) {
		t.Fatalf("Since(0): esperava os envelopes [1 2 3] em ordem, obteve %v", got)
	}

	var first protocol.Message
	if err := events[0].Decode(&first); err != nil {
		t.Fatalf("Decode do primeiro envelope: esperava sucesso, obteve erro: %v", err)
	}
	if first.Text != "primeira" {
		t.Errorf("primeiro envelope: esperava o texto %q, obteve %q", "primeira", first.Text)
	}
	if events[0].Session != testSession {
		t.Errorf("primeiro envelope: esperava a sessão %q, obteve %q", testSession, events[0].Session)
	}
	if events[0].V != protocol.Version {
		t.Errorf("primeiro envelope: esperava a versão %d, obteve %d", protocol.Version, events[0].V)
	}
	if events[0].TS.IsZero() {
		t.Errorf("primeiro envelope: esperava carimbo de tempo preenchido, obteve zero")
	}
}

func TestSinceSkipsWhatTheClientAlreadySaw(t *testing.T) {
	opened, _ := newStoreWithSession(t)
	appendMessages(t, opened, "um", "dois", "tres", "quatro")

	events, err := opened.Since(testSession, 2, 0)
	if err != nil {
		t.Fatalf("Since(2): esperava sucesso, obteve erro: %v", err)
	}
	if got := seqsOf(events); !sameSeqs(got, []uint64{3, 4}) {
		t.Fatalf("Since(2): esperava só o que veio depois — [3 4] —, obteve %v", got)
	}

	limited, err := opened.Since(testSession, 0, 2)
	if err != nil {
		t.Fatalf("Since(0, limite 2): esperava sucesso, obteve erro: %v", err)
	}
	if got := seqsOf(limited); !sameSeqs(got, []uint64{1, 2}) {
		t.Fatalf("Since(0, limite 2): esperava [1 2], obteve %v", got)
	}
}

func TestAppendRejectsUnknownSession(t *testing.T) {
	opened, _ := newStoreWithSession(t)

	_, err := opened.Append("sessao-que-nao-existe", userMessage("oi"))
	if err == nil {
		t.Fatalf("Append em sessão inexistente: esperava erro, obteve sucesso")
	}
	if !errors.Is(err, ErrNotFound) {
		t.Errorf("Append em sessão inexistente: esperava um erro de %q, obteve %q", ErrNotFound, err)
	}
}

/* ------------------------------- reabertura ------------------------------ */

func TestReopenRecoversLastSeqFromDisk(t *testing.T) {
	root := t.TempDir()
	first := openStore(t, root)
	if _, err := first.CreateSession(SessionMeta{ID: testSession, Title: "conversa de teste"}); err != nil {
		t.Fatalf("CreateSession: esperava sucesso, obteve erro: %v", err)
	}
	appendMessages(t, first, "um", "dois", "tres")
	if err := first.Close(); err != nil {
		t.Fatalf("Close: esperava sucesso, obteve erro: %v", err)
	}

	second := openStore(t, root)
	got, err := second.LastSeq(testSession)
	if err != nil {
		t.Fatalf("LastSeq depois de reabrir: esperava sucesso, obteve erro: %v", err)
	}
	if got != 3 {
		t.Fatalf("LastSeq depois de reabrir: esperava 3, obteve %d", got)
	}

	seq, err := second.Append(testSession, userMessage("quatro"))
	if err != nil {
		t.Fatalf("Append depois de reabrir: esperava sucesso, obteve erro: %v", err)
	}
	if seq != 4 {
		t.Errorf("Append depois de reabrir: esperava o número 4 (continuando o log), obteve %d", seq)
	}
}

// O cabeçalho pode estar atrás do log se o processo morreu entre uma escrita e
// outra. O log manda: ele é append-only e é a fonte.
func TestReopenPrefersLogOverStaleMeta(t *testing.T) {
	root := t.TempDir()
	first := openStore(t, root)
	if _, err := first.CreateSession(SessionMeta{ID: testSession, Title: "conversa de teste"}); err != nil {
		t.Fatalf("CreateSession: esperava sucesso, obteve erro: %v", err)
	}
	appendMessages(t, first, "um", "dois", "tres")
	if err := first.Close(); err != nil {
		t.Fatalf("Close: esperava sucesso, obteve erro: %v", err)
	}

	metaPath := sessionFile(root, "meta.json")
	var meta SessionMeta
	if err := readJSON(metaPath, &meta); err != nil {
		t.Fatalf("ler meta.json: esperava sucesso, obteve erro: %v", err)
	}
	meta.LastSeq = 0
	if err := writeJSONAtomic(metaPath, meta); err != nil {
		t.Fatalf("regravar meta.json atrasado: esperava sucesso, obteve erro: %v", err)
	}

	second := openStore(t, root)
	got, err := second.LastSeq(testSession)
	if err != nil {
		t.Fatalf("LastSeq com cabeçalho atrasado: esperava sucesso, obteve erro: %v", err)
	}
	if got != 3 {
		t.Fatalf("LastSeq com cabeçalho atrasado: esperava 3 (o log manda), obteve %d", got)
	}
}

/* ------------------------------ concorrência ----------------------------- */

func TestConcurrentAppendsProduceUniqueContinuousSeq(t *testing.T) {
	opened, _ := newStoreWithSession(t)

	const writers = 2
	const perWriter = 100

	var wait sync.WaitGroup
	seqs := make(chan uint64, writers*perWriter)
	failures := make(chan error, writers*perWriter)

	for writer := 0; writer < writers; writer++ {
		wait.Add(1)
		go func(writer int) {
			defer wait.Done()
			for index := 0; index < perWriter; index++ {
				seq, err := opened.Append(testSession, userMessage(fmt.Sprintf("w%d-%d", writer, index)))
				if err != nil {
					failures <- err
					return
				}
				seqs <- seq
			}
		}(writer)
	}
	wait.Wait()
	close(seqs)
	close(failures)

	for err := range failures {
		t.Fatalf("Append concorrente: esperava sucesso, obteve erro: %v", err)
	}

	got := make([]uint64, 0, writers*perWriter)
	for seq := range seqs {
		got = append(got, seq)
	}
	if len(got) != writers*perWriter {
		t.Fatalf("Append concorrente: esperava %d números, obteve %d", writers*perWriter, len(got))
	}
	sort.Slice(got, func(i, j int) bool { return got[i] < got[j] })
	for index, seq := range got {
		if seq != uint64(index+1) {
			t.Fatalf("Append concorrente: esperava os números 1..%d sem buraco nem repetição, mas a posição %d trouxe %d",
				writers*perWriter, index, seq)
		}
	}

	events, err := opened.Since(testSession, 0, MaxEventBatch)
	if err != nil {
		t.Fatalf("Since depois da escrita concorrente: esperava sucesso, obteve erro: %v", err)
	}
	if len(events) != writers*perWriter {
		t.Errorf("Since depois da escrita concorrente: esperava %d envelopes no log, obteve %d",
			writers*perWriter, len(events))
	}
}

// Ler enquanto se escreve é o caso normal: o replay da reconexão pagina o log
// no meio de uma resposta que ainda está chegando. O índice de deslocamento é
// preenchido pelos DOIS lados ao mesmo tempo, então um marco fora de ordem aqui
// apareceria como envelope pulado no meio do replay.
func TestReplayWhileWritingNeverSkipsAnEnvelope(t *testing.T) {
	opened, _ := newStoreWithSession(t)

	const total = indexStride * 6

	var wait sync.WaitGroup
	wait.Add(1)
	go func() {
		defer wait.Done()
		for index := 0; index < total; index++ {
			if _, err := opened.Append(testSession, userMessage(fmt.Sprintf("m%d", index))); err != nil {
				t.Errorf("Append %d: esperava sucesso, obteve erro: %v", index, err)
				return
			}
		}
	}()

	var delivered uint64
	for delivered < total {
		batch, err := opened.Since(testSession, delivered, indexStride/2)
		if err != nil {
			t.Fatalf("Since(%d): esperava sucesso, obteve erro: %v", delivered, err)
		}
		for _, envelope := range batch {
			if envelope.Seq != delivered+1 {
				t.Fatalf("replay concorrente: depois do %d esperava o %d, obteve %d",
					delivered, delivered+1, envelope.Seq)
			}
			delivered = envelope.Seq
		}
	}
	wait.Wait()

	handle, err := opened.handle(testSession)
	if err != nil {
		t.Fatalf("handle: esperava sucesso, obteve erro: %v", err)
	}
	checkIndex(t, handle)
}

/* ------------------------------- corrupção ------------------------------- */

// Queda de energia no meio de uma escrita deixa a ÚLTIMA linha partida. Abortar
// a leitura ali perderia todo o histórico anterior a ela.
func TestCorruptedTailLineDoesNotHideEarlierEvents(t *testing.T) {
	opened, root := newStoreWithSession(t)
	appendMessages(t, opened, "um", "dois")

	logPath := sessionFile(root, "log.jsonl")
	file, err := os.OpenFile(logPath, os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		t.Fatalf("abrir o log para simular a linha partida: esperava sucesso, obteve erro: %v", err)
	}
	if _, err := file.WriteString(`{"v":1,"seq":3,"kind":"mess`); err != nil {
		_ = file.Close()
		t.Fatalf("gravar a linha partida: esperava sucesso, obteve erro: %v", err)
	}
	if err := file.Close(); err != nil {
		t.Fatalf("fechar o log: esperava sucesso, obteve erro: %v", err)
	}

	events, err := opened.Since(testSession, 0, 0)
	if err != nil {
		t.Fatalf("Since com linha partida no fim: esperava sucesso, obteve erro: %v", err)
	}
	if got := seqsOf(events); !sameSeqs(got, []uint64{1, 2}) {
		t.Fatalf("Since com linha partida no fim: esperava [1 2] (as anteriores continuam legíveis), obteve %v", got)
	}
}

/* ----------------------------- índice de leitura -------------------------- */

// checkIndex confere marco por marco: posiciona o arquivo no deslocamento
// guardado e exige encontrar ali o começo da linha do `seq` prometido.
//
// Sem esta conferência, um marco errado passaria despercebido — `Since` cai
// para a varredura completa quando a promessa falha e devolveria a resposta
// certa mesmo com o índice quebrado, ou seja, o teste de leitura passaria com o
// índice inútil.
func checkIndex(t *testing.T, handle *sessionHandle) int {
	t.Helper()
	file, err := os.Open(handle.path)
	if err != nil {
		t.Fatalf("abrir o log: esperava sucesso, obteve erro: %v", err)
	}
	defer file.Close()

	handle.mu.Lock()
	marks := append([]logOffset(nil), handle.index...)
	handle.mu.Unlock()

	previous := uint64(0)
	for _, mark := range marks {
		if mark.seq <= previous {
			t.Fatalf("índice fora de ordem: %d veio depois de %d", mark.seq, previous)
		}
		previous = mark.seq
		if _, err := file.Seek(mark.offset, 0); err != nil {
			t.Fatalf("posicionar em %d: esperava sucesso, obteve erro: %v", mark.offset, err)
		}
		line, err := bufio.NewReader(file).ReadBytes('\n')
		if err != nil {
			t.Fatalf("ler a linha do marco %d: esperava sucesso, obteve erro: %v", mark.seq, err)
		}
		got, ok := seqOfLine(line[:len(line)-1])
		if !ok {
			t.Fatalf("marco do seq %d: o byte %d não começa uma linha legível", mark.seq, mark.offset)
		}
		if got != mark.seq {
			t.Fatalf("marco do seq %d: o byte %d começa a linha do seq %d", mark.seq, mark.offset, got)
		}
	}
	return len(marks)
}

// O índice é o que impede o replay de ser quadrático: cada página relia tudo o
// que as anteriores já tinham lido. Um marco errado, porém, é pior que marco
// nenhum — entrega o pedaço errado da conversa.
func TestOffsetIndexPointsToTheRightLines(t *testing.T) {
	opened, _ := newStoreWithSession(t)

	const total = indexStride*3 + 7
	for index := 0; index < total; index++ {
		if _, err := opened.Append(testSession, userMessage(fmt.Sprintf("m%d", index))); err != nil {
			t.Fatalf("Append %d: esperava sucesso, obteve erro: %v", index, err)
		}
	}

	handle, err := opened.handle(testSession)
	if err != nil {
		t.Fatalf("handle: esperava sucesso, obteve erro: %v", err)
	}
	if marks := checkIndex(t, handle); marks == 0 {
		t.Fatalf("escrita de %d envelopes: esperava marcos no índice, obteve nenhum", total)
	}

	// Paginar de indexStride em indexStride passa por todos os marcos.
	var delivered uint64
	var got []uint64
	for {
		batch, err := opened.Since(testSession, delivered, indexStride)
		if err != nil {
			t.Fatalf("Since(%d): esperava sucesso, obteve erro: %v", delivered, err)
		}
		if len(batch) == 0 {
			break
		}
		got = append(got, seqsOf(batch)...)
		delivered = batch[len(batch)-1].Seq
	}

	want := make([]uint64, 0, total)
	for seq := uint64(1); seq <= total; seq++ {
		want = append(want, seq)
	}
	if !sameSeqs(got, want) {
		t.Fatalf("replay paginado: esperava 1..%d sem buraco nem repetição, obteve %v", total, got)
	}
	checkIndex(t, handle)
}

// Marco furado (log mexido por fora, disco mentindo) tem de degradar para
// varredura completa, nunca para replay entregando o envelope errado.
func TestSinceIgnoresAnIndexMarkThatLies(t *testing.T) {
	opened, _ := newStoreWithSession(t)
	appendMessages(t, opened, "um", "dois", "tres", "quatro", "cinco")

	handle, err := opened.handle(testSession)
	if err != nil {
		t.Fatalf("handle: esperava sucesso, obteve erro: %v", err)
	}
	handle.mu.Lock()
	handle.index = []logOffset{{seq: 3, offset: 7}} // deslocamento no meio de uma linha
	handle.mu.Unlock()

	events, err := opened.Since(testSession, 2, 0)
	if err != nil {
		t.Fatalf("Since(2) com marco furado: esperava sucesso, obteve erro: %v", err)
	}
	if got := seqsOf(events); !sameSeqs(got, []uint64{3, 4, 5}) {
		t.Fatalf("Since(2) com marco furado: esperava [3 4 5], obteve %v", got)
	}
}

/* ---------------------------- cabeçalho em cache -------------------------- */

// O cabeçalho é gravado em janela, não a cada envelope. Fechar o app TEM de
// descarregar o pendente: senão a barra lateral abre com a conversa velha.
func TestCloseFlushesThePendingHeader(t *testing.T) {
	root := t.TempDir()
	opened, err := Open(root)
	if err != nil {
		t.Fatalf("Open: esperava sucesso, obteve erro: %v", err)
	}
	if _, err := opened.CreateSession(SessionMeta{ID: testSession, Title: "conversa de teste"}); err != nil {
		t.Fatalf("CreateSession: esperava sucesso, obteve erro: %v", err)
	}
	appendMessages(t, opened, "um", "dois")
	done := &protocol.Envelope{Kind: protocol.KindDone, From: protocol.Actor{Kind: protocol.ActorSpecialist, Specialist: "codigo"}}
	if _, err := opened.Append(testSession, done); err != nil {
		t.Fatalf("Append do done: esperava sucesso, obteve erro: %v", err)
	}
	if err := opened.Close(); err != nil {
		t.Fatalf("Close: esperava sucesso, obteve erro: %v", err)
	}

	var meta SessionMeta
	if err := readJSON(sessionFile(root, "meta.json"), &meta); err != nil {
		t.Fatalf("ler meta.json depois do Close: esperava sucesso, obteve erro: %v", err)
	}
	if meta.LastSeq != 3 {
		t.Errorf("meta.json depois do Close: esperava LastSeq 3, obteve %d", meta.LastSeq)
	}
	if meta.Turns != 1 {
		t.Errorf("meta.json depois do Close: esperava 1 turno, obteve %d", meta.Turns)
	}
	if meta.Specialist != "codigo" {
		t.Errorf("meta.json depois do Close: esperava o especialista %q, obteve %q", "codigo", meta.Specialist)
	}
}

// Enquanto a janela do debounce não fecha, o disco está atrás — e a listagem
// não pode mostrar a conversa em andamento como se ela não tivesse andado.
func TestListSessionsPrefersTheOpenSessionOverDisk(t *testing.T) {
	opened, _ := newStoreWithSession(t)
	appendMessages(t, opened, "um", "dois")

	list, err := opened.ListSessions()
	if err != nil {
		t.Fatalf("ListSessions: esperava sucesso, obteve erro: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("ListSessions: esperava 1 sessão, obteve %d", len(list))
	}
	if list[0].LastSeq != 2 {
		t.Errorf("ListSessions durante a conversa: esperava LastSeq 2, obteve %d", list[0].LastSeq)
	}
}

// Uma gravação de cabeçalho já agendada não pode ressuscitar uma sessão
// apagada.
func TestDeleteSessionDoesNotResurrectTheHeader(t *testing.T) {
	opened, root := newStoreWithSession(t)
	appendMessages(t, opened, "um")

	handle, err := opened.handle(testSession)
	if err != nil {
		t.Fatalf("handle: esperava sucesso, obteve erro: %v", err)
	}
	if err := opened.DeleteSession(testSession); err != nil {
		t.Fatalf("DeleteSession: esperava sucesso, obteve erro: %v", err)
	}

	// Dispara à mão o que o agendamento faria se tivesse escapado da corrida.
	handle.flushMetaAsync()

	if _, err := os.Stat(filepath.Dir(sessionFile(root, "meta.json"))); !os.IsNotExist(err) {
		t.Fatalf("depois de apagar a sessão: esperava o diretório inexistente, obteve %v", err)
	}
}

/* ------------------------- último seq pelo fim do log --------------------- */

// `lastSeqOnDisk` lê o FIM do log. Precisa continuar certo quando a última
// linha é gigante (resposta de modelo passa dos 64 KiB lidos de sonda) e
// quando a última linha está partida.
func TestLastSeqOnDiskReadsTheTailOfBigAndBrokenLines(t *testing.T) {
	opened, root := newStoreWithSession(t)
	appendMessages(t, opened, "um", "dois")
	if _, err := opened.Append(testSession, userMessage(strings.Repeat("g", 300*1024))); err != nil {
		t.Fatalf("Append da resposta gigante: esperava sucesso, obteve erro: %v", err)
	}

	logPath := sessionFile(root, "log.jsonl")
	got, err := lastSeqOnDisk(logPath)
	if err != nil {
		t.Fatalf("lastSeqOnDisk: esperava sucesso, obteve erro: %v", err)
	}
	if got != 3 {
		t.Fatalf("lastSeqOnDisk com última linha gigante: esperava 3, obteve %d", got)
	}

	file, err := os.OpenFile(logPath, os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		t.Fatalf("abrir o log para simular a linha partida: esperava sucesso, obteve erro: %v", err)
	}
	if _, err := file.WriteString(`{"v":1,"seq":4,"kind":"mess`); err != nil {
		_ = file.Close()
		t.Fatalf("gravar a linha partida: esperava sucesso, obteve erro: %v", err)
	}
	if err := file.Close(); err != nil {
		t.Fatalf("fechar o log: esperava sucesso, obteve erro: %v", err)
	}

	got, err = lastSeqOnDisk(logPath)
	if err != nil {
		t.Fatalf("lastSeqOnDisk com linha partida: esperava sucesso, obteve erro: %v", err)
	}
	if got != 3 {
		t.Fatalf("lastSeqOnDisk com linha partida no fim: esperava 3 (a última COMPLETA), obteve %d", got)
	}
}

/* --------------------------------- trava --------------------------------- */

// Dois processos sobre a mesma pasta gerariam dois eventos com o mesmo número.
// Falhar na subida é melhor que corromper em silêncio.
//
// O que este teste realmente cobre é o stale(): o pid gravado na trava é o do
// PRÓPRIO processo de teste, que obviamente está vivo. Se stale() responder
// "órfã" para um processo vivo, o segundo Open rouba a trava e o Open passa —
// e é exatamente por isso que a asserção aqui é sucesso == defeito.
func TestOpenTwiceReturnsErrLocked(t *testing.T) {
	root := t.TempDir()
	openStore(t, root)

	second, err := Open(root)
	if err == nil {
		_ = second.Close()
		t.Fatalf("Open no mesmo diretório: esperava %q, obteve sucesso", ErrLocked)
	}
	if second != nil {
		t.Errorf("Open recusado: esperava store nil, obteve %#v", second)
	}
	if !errors.Is(err, ErrLocked) {
		t.Errorf("Open no mesmo diretório: esperava um erro de %q, obteve %q", ErrLocked, err)
	}
}

func TestOpenRejectsEmptyRoot(t *testing.T) {
	if _, err := Open(""); err == nil {
		t.Fatalf("Open(\"\"): esperava erro, obteve sucesso")
	}
}

/* -------------------------------- safeID --------------------------------- */

func TestSafeIDNeverLeavesTheDataDirectory(t *testing.T) {
	// Os esperados são montados com strings.Repeat para o número de "_" ser
	// óbvio: cada caractere fora de [a-zA-Z0-9-_] vira um sublinhado, um a um.
	cases := []struct {
		in   string
		want string
	}{
		{"../../fora", strings.Repeat("_", 6) + "fora"},
		{`..\..\fora`, strings.Repeat("_", 6) + "fora"},
		{"sessao-1_2", "sessao-1_2"},
		{"C:/Windows/System32", "C" + strings.Repeat("_", 2) + "Windows_System32"},
		{"sessão nova", "sess" + strings.Repeat("_", 1) + "o_nova"},
		{"", "sessao"},
	}

	for _, each := range cases {
		if got := safeID(each.in); got != each.want {
			t.Errorf("safeID(%q): esperava %q, obteve %q", each.in, each.want, got)
		}
	}

	long := safeID(strings.Repeat("a", 200))
	if len(long) != 96 {
		t.Errorf("safeID de id gigante: esperava 96 caracteres, obteve %d", len(long))
	}
}

func TestSessionDirStaysInsideTheDataDirectory(t *testing.T) {
	opened, root := newStoreWithSession(t)

	const escaping = "../../fora"
	directory := opened.sessionDir(escaping)
	sessions := filepath.Join(root, "sessions")
	if !strings.HasPrefix(directory, sessions+string(filepath.Separator)) {
		t.Fatalf("sessionDir(%q): esperava um caminho dentro de %q, obteve %q", escaping, sessions, directory)
	}
	if strings.Contains(filepath.ToSlash(directory), "../") {
		t.Fatalf("sessionDir(%q): esperava um caminho sem \"..\", obteve %q", escaping, directory)
	}

	if _, err := opened.CreateSession(SessionMeta{ID: escaping, Title: "fuga"}); err != nil {
		t.Fatalf("CreateSession(%q): esperava sucesso, obteve erro: %v", escaping, err)
	}
	if _, err := opened.Append(escaping, userMessage("escrita")); err != nil {
		t.Fatalf("Append(%q): esperava sucesso, obteve erro: %v", escaping, err)
	}

	if _, err := os.Stat(filepath.Join(directory, "log.jsonl")); err != nil {
		t.Errorf("esperava o log dentro de %q, obteve erro ao procurá-lo: %v", directory, err)
	}
	// Sem safeID, root/sessions/../../fora cairia um nível ACIMA da raiz de dados.
	outside := filepath.Join(filepath.Dir(root), "fora")
	if _, err := os.Stat(outside); err == nil {
		t.Errorf("esperava nada escrito em %q, mas o caminho existe", outside)
	}
}
