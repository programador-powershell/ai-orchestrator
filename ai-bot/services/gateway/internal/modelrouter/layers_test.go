package modelrouter

import (
	"testing"

	"aibot/gateway/internal/protocol"
)

func TestCatalogLayersOverrideAndRevealPreviousDefinition(t *testing.T) {
	router := New(nil, nil)
	router.SetProviders([]Provider{{ID: "shared", Name: "Configuração", Kind: KindOpenAI, Enabled: true}})
	router.SetModels([]Entry{{
		Model:      protocol.Model{ID: "shared-model", Provider: "shared", Label: "Configuração"},
		ProviderID: "shared",
	}})

	err := router.SetCatalogLayer("plugin:base", 10,
		[]Provider{
			{ID: "plugin-only", Name: "Só plugin", Kind: KindCompatible, Enabled: true},
			{ID: "shared", Name: "Padrão do plugin", Kind: KindCompatible, Enabled: false},
		},
		[]Entry{
			{Model: protocol.Model{ID: "plugin-model", Provider: "plugin-only", Label: "Plugin"}, ProviderID: "plugin-only"},
			{Model: protocol.Model{ID: "shared-model", Provider: "shared", Label: "Padrão do plugin"}, ProviderID: "shared"},
		},
	)
	if err != nil {
		t.Fatalf("montar camada: %v", err)
	}

	providers, models := router.Configuration()
	if len(providers) != 2 || len(models) != 2 {
		t.Fatalf("composição perdeu contribuições: providers=%v models=%v", providers, models)
	}
	shared, ok := router.ProviderConfig("shared")
	if !ok || shared.Name != "Configuração" || !shared.Enabled {
		t.Fatalf("a camada da pessoa não venceu o padrão do plugin: %+v", shared)
	}

	router.SetProviders(nil)
	router.SetModels(nil)
	shared, ok = router.ProviderConfig("shared")
	if !ok || shared.Name != "Padrão do plugin" || shared.Enabled {
		t.Fatalf("remover override não revelou a camada de baixo: %+v", shared)
	}

	router.RemoveCatalogLayer("plugin:base")
	providers, models = router.Configuration()
	if len(providers) != 0 || len(models) != 0 {
		t.Fatalf("dispose deixou resíduos: providers=%v models=%v", providers, models)
	}
}

func TestCatalogLayerCopiesCallerData(t *testing.T) {
	router := New(nil, nil)
	providers := []Provider{{ID: "p", Name: "Antes", Enabled: true}}
	models := []Entry{{
		Model: protocol.Model{ID: "m", Provider: "p", Skills: []string{"chat"}}, ProviderID: "p",
	}}
	if err := router.SetCatalogLayer("plugin:copy", 10, providers, models); err != nil {
		t.Fatal(err)
	}
	providers[0].Name = "Depois"
	models[0].Skills[0] = "mutado"

	gotProviders, gotModels := router.Configuration()
	if gotProviders[0].Name != "Antes" || gotModels[0].Skills[0] != "chat" {
		t.Fatalf("camada publicou fatia mutável: providers=%v models=%v", gotProviders, gotModels)
	}
}
