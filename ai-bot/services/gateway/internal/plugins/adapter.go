package plugins

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"aibot/gateway/internal/modelrouter"
)

const KindLLMAdapter = "llm.adapter"

type LLMAdapterConfig struct {
	Kind modelrouter.Kind `json:"kind"`
	modelrouter.AdapterOptions
}

// RegisterLLMAdapter liga nomes de provedor a protocolos do roteador. Assim
// xAI/Grok pode ser montado e desmontado inteiro: adaptador, catálogo e modelos.
func RegisterLLMAdapter(runtime *Runtime, router *modelrouter.Router) error {
	if runtime == nil || router == nil {
		return fmt.Errorf("llm.adapter exige runtime e router")
	}
	return runtime.RegisterKind(KindLLMAdapter,
		func(_ context.Context, owner string, contribution Contribution) (Dispose, error) {
			var config LLMAdapterConfig
			if err := json.Unmarshal(contribution.Config, &config); err != nil {
				return nil, fmt.Errorf("config de adaptador ilegível: %w", err)
			}
			if strings.TrimSpace(string(config.Kind)) == "" {
				return nil, fmt.Errorf("adaptador sem kind")
			}
			dispose, err := router.RegisterAdapter("plugin:"+owner, config.Kind, config.AdapterOptions)
			if err != nil {
				return nil, err
			}
			return func() error {
				dispose()
				return nil
			}, nil
		})
}
