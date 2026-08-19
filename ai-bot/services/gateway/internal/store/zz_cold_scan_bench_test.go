// Benchmark TEMPORÁRIO de verificação de achado — apagar depois.
package store

import (
	"encoding/json"
	"testing"

	"aibot/gateway/internal/protocol"
)

// Log de ~10 MB: 15.000 envelopes na mistura do bench oficial (~680 B médios).
const coldLogSize = 15000

// BenchmarkColdSinceTail reproduz o primeiro history() pós-restart: store
// recém-aberto (índice em memória vazio) e Since(last-500) — a fase skipping
// varre do byte 0 com seqOfLine por linha.
func BenchmarkColdSinceTail(b *testing.B) {
	root := b.TempDir()
	seedLog(b, root, coldLogSize)

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		opened, err := Open(root)
		if err != nil {
			b.Fatalf("Open: %v", err)
		}
		from := uint64(coldLogSize - MaxEventBatch)
		events, err := opened.Since(benchSession, from, MaxEventBatch)
		if err != nil {
			b.Fatalf("Since: %v", err)
		}
		if len(events) != MaxEventBatch {
			b.Fatalf("esperava %d, obteve %d", MaxEventBatch, len(events))
		}
		if err := opened.Close(); err != nil {
			b.Fatalf("Close: %v", err)
		}
	}
}

// BenchmarkWarmSinceTail é a MESMA leitura com o índice já semeado pela
// primeira chamada — o custo de regime que o caminho frio deve ser comparado.
func BenchmarkWarmSinceTail(b *testing.B) {
	root := b.TempDir()
	seedLog(b, root, coldLogSize)
	opened, err := Open(root)
	if err != nil {
		b.Fatalf("Open: %v", err)
	}
	b.Cleanup(func() { _ = opened.Close() })
	from := uint64(coldLogSize - MaxEventBatch)
	if _, err := opened.Since(benchSession, from, MaxEventBatch); err != nil {
		b.Fatalf("Since (semeadura): %v", err)
	}

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		events, err := opened.Since(benchSession, from, MaxEventBatch)
		if err != nil {
			b.Fatalf("Since: %v", err)
		}
		if len(events) != MaxEventBatch {
			b.Fatalf("esperava %d, obteve %d", MaxEventBatch, len(events))
		}
	}
}

// BenchmarkSeqOfLineSmall/Large isolam o json.Unmarshal por linha da fase
// skipping, nos dois tamanhos da carga oficial.
func BenchmarkSeqOfLineSmall(b *testing.B) {
	envelope := benchEnvelope(protocol.KindMessage, benchSmallEnvelope)
	envelope.V, envelope.Seq, envelope.Session = 1, 42, benchSession
	line, err := json.Marshal(envelope)
	if err != nil {
		b.Fatal(err)
	}
	b.SetBytes(int64(len(line)))
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, ok := seqOfLine(line); !ok {
			b.Fatal("linha inválida")
		}
	}
}

func BenchmarkSeqOfLineLarge(b *testing.B) {
	envelope := benchEnvelope(protocol.KindMessage, benchLargeEnvelope)
	envelope.V, envelope.Seq, envelope.Session = 1, 42, benchSession
	line, err := json.Marshal(envelope)
	if err != nil {
		b.Fatal(err)
	}
	b.SetBytes(int64(len(line)))
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, ok := seqOfLine(line); !ok {
			b.Fatal("linha inválida")
		}
	}
}
