package plugins

import (
	"context"
	"encoding/json"
	"fmt"

	"aibot/gateway/internal/specialist"
)

const KindSpecialistOverlay = "specialist.overlay"

type SpecialistOverlayConfig struct {
	Overlay json.RawMessage `json:"overlay"`
}

// RegisterSpecialistOverlay transforma o catálogo de especialistas numa
// contribuição reversível. O checkpoint preserva camadas anteriores, como o
// sistema de efeitos do DeepSeek Harness, em vez de voltar sempre ao compilado.
func RegisterSpecialistOverlay(runtime *Runtime) error {
	if runtime == nil {
		return fmt.Errorf("specialist.overlay exige runtime")
	}
	return runtime.RegisterKind(KindSpecialistOverlay,
		func(_ context.Context, _ string, contribution Contribution) (Dispose, error) {
			var config SpecialistOverlayConfig
			if err := json.Unmarshal(contribution.Config, &config); err != nil {
				return nil, fmt.Errorf("config de especialistas ilegível: %w", err)
			}
			if len(config.Overlay) == 0 {
				return nil, fmt.Errorf("overlay de especialistas vazio")
			}
			before := specialist.Capture()
			if err := specialist.LoadOverlay(config.Overlay); err != nil {
				return nil, err
			}
			return func() error {
				specialist.Restore(before)
				return nil
			}, nil
		})
}
