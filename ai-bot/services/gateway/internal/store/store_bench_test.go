// Benchmarks do caminho quente do log.
//
// Este pacote é o gargalo do gateway por construção: TODO envelope passa por
// `Append` e TODA reconexão relê o log por `Since`. Os números aqui existem
// para que uma regressão nesses dois caminhos apareça como medida, e não como
// "o app ficou estranho depois daquele commit".
//
// A carga é a de uma conversa de verdade, não a de um microteste: envelopes de
// ~400 B (a maioria) misturados a respostas de modelo de ~6 KB, e logs de 5.000
// envelopes — a ordem de grandeza de uma sessão longa.
package store

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"aibot/gateway/internal/protocol"
)

const benchSession = "sessao-de-bench"

// Tamanhos da carga. O envelope comum de uma conversa (prompt curto, delta,
// resultado de ferramenta pequeno) fica na casa dos 400 B; a resposta inteira
// de um modelo fica entre 4 e 12 KB.
const (
	benchSmallEnvelope = 400
	benchLargeEnvelope = 6 * 1024
	// benchLargeEvery: 1 em cada 20 envelopes é uma resposta inteira. Dá um log
	// de 5.000 envelopes com ~3,4 MB, que é o que uma sessão longa ocupa.
	benchLargeEvery = 20
	benchLogSize    = 5000
)

/* ------------------------------ auxiliares ------------------------------ */

// benchEnvelope monta um envelope cuja LINHA no log fica em ~size bytes.
//
// O preenchimento é calculado, não chutado: serializa uma sonda com os campos
// que o `Append` preenche (seq, sessão, versão, carimbo) e desconta. Chutar o
// tamanho faria o benchmark medir um envelope que não é o que se pretendia.
func benchEnvelope(kind protocol.Kind, size int) *protocol.Envelope {
	build := func(text string) *protocol.Envelope {
		envelope := &protocol.Envelope{
			ID:   "01JBENCHENVELOPE0000000000",
			Turn: "01JBENCHTURN00000000000000",
			Kind: kind,
			From: protocol.Actor{Kind: protocol.ActorSpecialist, ID: "codigo", Specialist: "codigo"},
		}
		_ = envelope.SetPayload(protocol.Message{Role: "assistant", Text: text, Specialist: "codigo"})
		return envelope
	}

	probe := build("")
	probe.V, probe.Seq, probe.Session, probe.TS = protocol.Version, benchLogSize, benchSession, time.Now().UTC()
	raw, err := json.Marshal(probe)
	if err != nil {
		panic(err)
	}
	padding := size - len(raw) - 1 // -1 pela quebra de linha
	if padding < 0 {
		padding = 0
	}
	return build(strings.Repeat("a", padding))
}

// benchStore devolve um store novo com a sessão de bench criada.
func benchStore(b *testing.B, root string) *Store {
	b.Helper()
	opened, err := Open(root)
	if err != nil {
		b.Fatalf("Open(%q): esperava sucesso, obteve erro: %v", root, err)
	}
	b.Cleanup(func() { _ = opened.Close() })
	if _, err := opened.CreateSession(SessionMeta{ID: benchSession, Title: "bench"}); err != nil {
		b.Fatalf("CreateSession: esperava sucesso, obteve erro: %v", err)
	}
	return opened
}

// seedLog escreve `count` envelopes DIRETO no disco, no mesmo formato do
// `Append`. Semear por `Append` custaria um fsync por linha e o preparo do
// benchmark demoraria mais que o benchmark — e o que se quer medir é a leitura,
// não a escrita da massa de teste.
func seedLog(b *testing.B, root string, count int) {
	b.Helper()
	directory := filepath.Join(root, "sessions", safeID(benchSession))
	if err := os.MkdirAll(directory, 0o700); err != nil {
		b.Fatalf("criar diretório da sessão: %v", err)
	}

	file, err := os.Create(filepath.Join(directory, "log.jsonl"))
	if err != nil {
		b.Fatalf("criar log: %v", err)
	}
	writer := bufio.NewWriterSize(file, 1<<20)

	small := benchEnvelope(protocol.KindMessage, benchSmallEnvelope)
	large := benchEnvelope(protocol.KindMessage, benchLargeEnvelope)
	now := time.Now().UTC()
	for seq := 1; seq <= count; seq++ {
		envelope := small
		if seq%benchLargeEvery == 0 {
			envelope = large
		}
		envelope.V = protocol.Version
		envelope.Seq = uint64(seq)
		envelope.Session = benchSession
		envelope.TS = now
		envelope.ID = fmt.Sprintf("01JBENCH%018d", seq)

		line, err := json.Marshal(envelope)
		if err != nil {
			b.Fatalf("serializar envelope %d: %v", seq, err)
		}
		if _, err := writer.Write(append(line, '\n')); err != nil {
			b.Fatalf("gravar envelope %d: %v", seq, err)
		}
	}
	if err := writer.Flush(); err != nil {
		b.Fatalf("descarregar log: %v", err)
	}
	if err := file.Close(); err != nil {
		b.Fatalf("fechar log: %v", err)
	}

	meta := SessionMeta{
		ID:        benchSession,
		Title:     "bench",
		CreatedAt: now,
		UpdatedAt: now,
		LastSeq:   uint64(count),
		Turns:     count / 8,
	}
	if err := writeJSONAtomic(filepath.Join(directory, "meta.json"), meta); err != nil {
		b.Fatalf("gravar cabeçalho: %v", err)
	}
}

// seededStore prepara raiz + log semeado e abre o store por cima.
func seededStore(b *testing.B) *Store {
	b.Helper()
	root := b.TempDir()
	seedLog(b, root, benchLogSize)
	opened, err := Open(root)
	if err != nil {
		b.Fatalf("Open(%q): esperava sucesso, obteve erro: %v", root, err)
	}
	b.Cleanup(func() { _ = opened.Close() })
	return opened
}

/* -------------------------------- escrita -------------------------------- */

// BenchmarkAppend mede o caminho DURÁVEL: um envelope que a pessoa não pode
// perder. É o custo por mensagem gravada.
func BenchmarkAppend(b *testing.B) {
	opened := benchStore(b, b.TempDir())
	envelope := benchEnvelope(protocol.KindMessage, benchSmallEnvelope)

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		envelope.TS = time.Time{}
		if _, err := opened.Append(benchSession, envelope); err != nil {
			b.Fatalf("Append: esperava sucesso, obteve erro: %v", err)
		}
	}
}

// BenchmarkAppendEphemeralKinds mede o caminho NÃO durável (delta de
// streaming). Usa o MESMO tamanho de envelope do durável de propósito: assim a
// única diferença entre os dois números é a ida ao disco, e não o payload.
func BenchmarkAppendEphemeralKinds(b *testing.B) {
	opened := benchStore(b, b.TempDir())
	envelope := benchEnvelope(protocol.KindDelta, benchSmallEnvelope)

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		envelope.TS = time.Time{}
		if _, err := opened.Append(benchSession, envelope); err != nil {
			b.Fatalf("Append: esperava sucesso, obteve erro: %v", err)
		}
	}
}

/* -------------------------------- leitura -------------------------------- */

// BenchmarkSinceFromStart mede UMA página do começo do log.
func BenchmarkSinceFromStart(b *testing.B) {
	opened := seededStore(b)

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		events, err := opened.Since(benchSession, 0, MaxEventBatch)
		if err != nil {
			b.Fatalf("Since: esperava sucesso, obteve erro: %v", err)
		}
		if len(events) != MaxEventBatch {
			b.Fatalf("Since: esperava %d envelopes, obteve %d", MaxEventBatch, len(events))
		}
	}
}

// BenchmarkSinceReplayAll é o cenário REAL da reconexão: o transporte pagina o
// log inteiro de 500 em 500 (internal/transport/stream.go). Se cada página
// reler o que as anteriores já leram, o custo é quadrático no tamanho do log —
// e é justamente isso que este benchmark expõe.
func BenchmarkSinceReplayAll(b *testing.B) {
	opened := seededStore(b)

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		var delivered uint64
		var total int
		for {
			batch, err := opened.Since(benchSession, delivered, MaxEventBatch)
			if err != nil {
				b.Fatalf("Since: esperava sucesso, obteve erro: %v", err)
			}
			if len(batch) == 0 {
				break
			}
			delivered = batch[len(batch)-1].Seq
			total += len(batch)
			if len(batch) < MaxEventBatch {
				break
			}
		}
		if total != benchLogSize {
			b.Fatalf("replay: esperava %d envelopes, obteve %d", benchLogSize, total)
		}
	}
}

/* ------------------------------- abertura -------------------------------- */

// BenchmarkOpenSession mede abrir o store e resolver a sessão com um log de
// 5.000 já no disco — o que acontece toda vez que o app sobe.
func BenchmarkOpenSession(b *testing.B) {
	root := b.TempDir()
	seedLog(b, root, benchLogSize)

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		opened, err := Open(root)
		if err != nil {
			b.Fatalf("Open: esperava sucesso, obteve erro: %v", err)
		}
		seq, err := opened.LastSeq(benchSession)
		if err != nil {
			b.Fatalf("LastSeq: esperava sucesso, obteve erro: %v", err)
		}
		if seq != benchLogSize {
			b.Fatalf("LastSeq: esperava %d, obteve %d", benchLogSize, seq)
		}
		if err := opened.Close(); err != nil {
			b.Fatalf("Close: esperava sucesso, obteve erro: %v", err)
		}
	}
}
