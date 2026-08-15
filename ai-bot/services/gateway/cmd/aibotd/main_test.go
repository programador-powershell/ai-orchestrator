package main

import (
	"testing"

	"aibot/gateway/internal/modelrouter"
)

func TestDefaultCatalogIncludesGrokProviderAndModels(t *testing.T) {
	catalog, err := defaultCatalog()
	if err != nil {
		t.Fatal(err)
	}

	var foundProvider bool
	for _, provider := range catalog.Providers {
		if provider.ID != "xai" {
			continue
		}
		foundProvider = true
		if provider.Kind != modelrouter.KindXAI || provider.BaseURL != "https://api.x.ai/v1" {
			t.Fatalf("provedor xAI incorreto: %+v", provider)
		}
		if provider.Enabled || provider.SecretRef != "provider:xai" {
			t.Fatalf("xAI deve nascer seguro e configurável: %+v", provider)
		}
	}
	if !foundProvider {
		t.Fatal("catálogo semente não trouxe o provedor xAI")
	}

	models := make(map[string]modelrouter.Entry)
	for _, entry := range catalog.Models {
		models[entry.ID] = entry
	}
	if grok, ok := models["grok-4.5"]; !ok {
		t.Fatal("catálogo semente não trouxe grok-4.5")
	} else if grok.ProviderID != "xai" || grok.Context != 500000 || !grok.Default {
		t.Fatalf("grok-4.5 incorreto: %+v", grok)
	}
	if imagine, ok := models["grok-imagine-image-quality"]; !ok {
		t.Fatal("catálogo semente não trouxe Grok Imagine")
	} else if imagine.ProviderID != "xai" {
		t.Fatalf("Grok Imagine aponta para o provedor errado: %+v", imagine)
	}
}
