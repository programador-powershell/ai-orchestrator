package plugins

import (
	"context"
	"encoding/json"
	"fmt"

	"aibot/gateway/internal/modelrouter"
)

const KindLLMCatalog = "llm.catalog"

type LLMCatalog struct {
	Priority  int                    `json:"priority,omitempty"`
	Providers []modelrouter.Provider `json:"providers"`
	Models    []modelrouter.Entry    `json:"models"`
}

func RegisterLLMCatalog(runtime *Runtime, router *modelrouter.Router) error {
	if runtime == nil || router == nil {
		return fmt.Errorf("llm.catalog exige runtime e router")
	}
	return runtime.RegisterKind(KindLLMCatalog,
		func(_ context.Context, owner string, contribution Contribution) (Dispose, error) {
			catalog, err := DecodeLLMCatalog(contribution)
			if err != nil {
				return nil, err
			}
			layer := "plugin:" + owner + ":" + contribution.ID
			priority := catalog.Priority
			if priority == 0 {
				priority = 10
			}
			if err := router.SetCatalogLayer(layer, priority, catalog.Providers, catalog.Models); err != nil {
				return nil, err
			}
			return func() error {
				router.RemoveCatalogLayer(layer)
				return nil
			}, nil
		})
}

func DecodeLLMCatalog(contribution Contribution) (LLMCatalog, error) {
	var catalog LLMCatalog
	if err := json.Unmarshal(contribution.Config, &catalog); err != nil {
		return catalog, fmt.Errorf("config de catálogo ilegível: %w", err)
	}
	providerIDs := make(map[string]bool, len(catalog.Providers))
	for _, provider := range catalog.Providers {
		if provider.ID == "" || provider.Kind == "" || provider.BaseURL == "" {
			return catalog, fmt.Errorf("provedor incompleto: %+v", provider)
		}
		if providerIDs[provider.ID] {
			return catalog, fmt.Errorf("provedor repetido: %s", provider.ID)
		}
		providerIDs[provider.ID] = true
	}
	modelIDs := make(map[string]bool, len(catalog.Models))
	for _, model := range catalog.Models {
		if model.ID == "" || model.ProviderID == "" {
			return catalog, fmt.Errorf("modelo incompleto: %+v", model)
		}
		if modelIDs[model.ID] {
			return catalog, fmt.Errorf("modelo repetido: %s", model.ID)
		}
		modelIDs[model.ID] = true
	}
	return catalog, nil
}

func CatalogsOf(manifests ...Manifest) ([]modelrouter.Provider, []modelrouter.Entry, error) {
	var providers []modelrouter.Provider
	var models []modelrouter.Entry
	for _, manifest := range manifests {
		for _, contribution := range manifest.Contributes {
			if contribution.Kind != KindLLMCatalog {
				continue
			}
			catalog, err := DecodeLLMCatalog(contribution)
			if err != nil {
				return nil, nil, fmt.Errorf("plugin %s: %w", manifest.Name, err)
			}
			providers = append(providers, catalog.Providers...)
			models = append(models, catalog.Models...)
		}
	}
	return providers, models, nil
}
