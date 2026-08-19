package fusion

import "testing"

// A atribuicao e o preset dividem o mesmo campo por especialista: ou modelo, ou
// painel. Estes testes guardam a convencao e o que acontece quando ela envelhece.
func TestAtribuicaoSoLeValorDeFusion(t *testing.T) {
	r := NewRegistry()
	r.SetPresets([]Preset{{ID: "trio", Strategy: StrategyMerge, Orchestrator: "a"}})
	r.SetAssignments(map[string]string{
		"code":     "fusion:trio",
		"design":   "gpt-5",
		"security": "fusion:",
	})

	if _, ok := r.PresetFor("code"); !ok {
		t.Fatal("code foi atribuido a um preset e devia encontrar")
	}
	if _, ok := r.PresetFor("design"); ok {
		t.Fatal("design tem MODELO, nao preset — nao pode virar fusion")
	}
	if _, ok := r.PresetFor("security"); ok {
		t.Fatal("prefixo sem id nao e atribuicao")
	}
}

// Preset removido depois de atribuido nao pode derrubar a conversa.
func TestPresetQueSumiuDevolveFalse(t *testing.T) {
	r := NewRegistry()
	r.SetPresets([]Preset{{ID: "trio", Orchestrator: "a"}})
	r.SetAssignments(map[string]string{"code": "fusion:trio"})
	r.SetPresets(nil)

	if _, ok := r.PresetFor("code"); ok {
		t.Fatal("o preset sumiu; PresetFor tinha de dizer que nao ha")
	}
}

// Estrategia invalida vira merge em vez de quebrar o turno.
func TestEstrategiaInvalidaViraMerge(t *testing.T) {
	r := NewRegistry()
	r.SetPresets([]Preset{{ID: "x", Strategy: Strategy("banana"), Orchestrator: "a"}})
	r.SetAssignments(map[string]string{"chat": "fusion:x"})

	preset, ok := r.PresetFor("chat")
	if !ok {
		t.Fatal("preset devia existir")
	}
	if preset.Strategy != StrategyMerge {
		t.Fatalf("estrategia invalida devia virar merge, veio %q", preset.Strategy)
	}
}

// A ordem da lista e a da tela.
func TestPresetsPreservamAOrdem(t *testing.T) {
	r := NewRegistry()
	r.SetPresets([]Preset{{ID: "c", Orchestrator: "m"}, {ID: "a", Orchestrator: "m"}, {ID: "b", Orchestrator: "m"}})
	var ids []string
	for _, p := range r.Presets() {
		ids = append(ids, p.ID)
	}
	if len(ids) != 3 || ids[0] != "c" || ids[1] != "a" || ids[2] != "b" {
		t.Fatalf("a ordem mudou: %v", ids)
	}
}
