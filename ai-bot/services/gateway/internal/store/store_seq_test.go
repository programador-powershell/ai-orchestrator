package store

import (
	"encoding/json"
	"testing"
)

// O fast-path do seqOfLine tem de concordar com o caminho completo em toda
// linha que o escritor real produz — e cair no lento para o resto.
func TestSeqOfLineFastPathConcordaComOLento(t *testing.T) {
	casos := []string{
		`{"v":1,"id":"e1","ts":"2026-08-19T12:00:00Z","seq":42,"session":"s","kind":"delta","from":{"kind":"user"}}`,
		`{"v":1,"id":"e2","ts":"2026-08-19T12:00:00Z","seq":1,"session":"s","kind":"done","from":{"kind":"user"}}`,
		`{"v":1,"id":"e3","ts":"2026-08-19T12:00:00Z","seq":18446744073709551615,"session":"s","kind":"x","from":{"kind":"user"}}`,
	}
	for _, linha := range casos {
		rapido, okRapido := seqOfLine([]byte(linha))
		var head struct {
			Seq uint64 `json:"seq"`
		}
		if err := json.Unmarshal([]byte(linha), &head); err != nil {
			t.Fatalf("caso inválido no teste: %v", err)
		}
		if !okRapido || rapido != head.Seq {
			t.Errorf("fast-path divergiu: %d vs %d em %s", rapido, head.Seq, linha)
		}
	}

	// Linha com "seq" em outra posição/forma cai no caminho lento e ainda acerta.
	torto := `{"seq": 7, "v":1}` // espaço depois dos dois-pontos: o literal não casa
	if seq, ok := seqOfLine([]byte(torto)); !ok || seq != 7 {
		t.Errorf("o caminho lento tinha de resolver a linha torta: %d %v", seq, ok)
	}
	if _, ok := seqOfLine([]byte(`{"v":1}`)); ok {
		t.Error("linha sem seq não pode passar")
	}
	if _, ok := seqOfLine(nil); ok {
		t.Error("linha vazia não pode passar")
	}
}
