package supervisor

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestOwnedToolRegistrationIsReversibleAndCollisionSafe(t *testing.T) {
	registry := NewRegistry()
	dispose, err := registry.RegisterOwned("plugin:a", "demo.echo", "eco",
		func(_ context.Context, _ string, raw json.RawMessage) (string, error) {
			return string(raw), nil
		})
	if err != nil {
		t.Fatalf("registrar: %v", err)
	}
	if !registry.Has("demo.echo") {
		t.Fatal("ferramenta registrada não apareceu")
	}
	if _, err := registry.RegisterOwned("plugin:b", "demo.echo", "outra", nil); err == nil ||
		!strings.Contains(err.Error(), "plugin:a") {
		t.Fatalf("colisão devia citar o dono atual: %v", err)
	}

	dispose()
	dispose() // efeito é idempotente
	if registry.Has("demo.echo") {
		t.Fatal("dispose não removeu a ferramenta")
	}
	if _, err := registry.Call(context.Background(), "demo.echo", "s", nil); err == nil {
		t.Fatal("ferramenta descarregada ainda executou")
	}
}

func TestOwnedDisposeDoesNotRemoveLaterCoreReplacement(t *testing.T) {
	registry := NewRegistry()
	dispose, err := registry.RegisterOwned("plugin:a", "demo.tool", "plugin", nil)
	if err != nil {
		t.Fatal(err)
	}
	registry.Register("demo.tool", "core", func(context.Context, string, json.RawMessage) (string, error) {
		return "core", nil
	})

	dispose()
	if !registry.Has("demo.tool") || registry.Describe("demo.tool") != "core" {
		t.Fatal("dispose antigo removeu uma geração posterior do registro")
	}
}
