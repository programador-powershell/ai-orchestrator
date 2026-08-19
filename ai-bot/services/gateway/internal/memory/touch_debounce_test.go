package memory

import (
	"path/filepath"
	"testing"
	"time"
)

// O Touch saiu do caminho da resposta: os contadores valem em memória na hora
// e chegam ao disco pelo debounce (ou de carona em qualquer outra gravação).
func TestTouchDebounceChegaAoDisco(t *testing.T) {
	arquivo := filepath.Join(t.TempDir(), "memoria.json")
	store, err := Open(arquivo)
	if err != nil {
		t.Fatal(err)
	}
	added, err := store.Add(Item{Kind: "fact", Title: "t", Content: "conteúdo"})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Touch([]string{added.ID}); err != nil {
		t.Fatal(err)
	}

	// Em memória o contador já vale — o Search desta sessão o vê.
	hits := store.Search("conteúdo", 1)
	if len(hits) != 1 || hits[0].Item.Uses != 1 {
		t.Fatalf("o contador não valeu em memória: %+v", hits)
	}

	// Espera o flush do debounce e reabre do disco.
	deadline := time.Now().Add(2 * time.Second)
	for {
		reopened, err := Open(arquivo)
		if err != nil {
			t.Fatal(err)
		}
		persisted := reopened.Search("conteúdo", 1)
		if len(persisted) == 1 && persisted[0].Item.Uses == 1 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("o contador nunca chegou ao disco: %+v", persisted)
		}
		time.Sleep(50 * time.Millisecond)
	}
}
