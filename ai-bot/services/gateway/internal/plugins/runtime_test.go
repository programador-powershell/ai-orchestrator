package plugins

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func contribution(kind, id string) Contribution {
	return Contribution{Kind: kind, ID: id, Config: []byte(`{}`)}
}

func manifest(name string, requires []string, contributions ...Contribution) Manifest {
	return Manifest{
		SchemaVersion: SchemaVersion,
		Name:          name,
		Version:       "1.0.0",
		Requires:      requires,
		Contributes:   contributions,
	}
}

func TestMountRollsBackEffectsAtomically(t *testing.T) {
	runtime := NewRuntime()
	var events []string
	if err := runtime.RegisterKind("working", func(_ context.Context, owner string, _ Contribution) (Dispose, error) {
		events = append(events, "+"+owner)
		return func() error {
			events = append(events, "-"+owner)
			return nil
		}, nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := runtime.RegisterKind("broken", func(context.Context, string, Contribution) (Dispose, error) {
		return nil, errors.New("falha esperada")
	}); err != nil {
		t.Fatal(err)
	}

	err := runtime.Mount(context.Background(), manifest("atomic", nil,
		contribution("working", "first"), contribution("broken", "second")))
	if err == nil {
		t.Fatal("plugin parcialmente inválido devia falhar")
	}
	if want := []string{"+atomic", "-atomic"}; !reflect.DeepEqual(events, want) {
		t.Fatalf("rollback não foi reverso e completo: got %v want %v", events, want)
	}
	if mounted := runtime.Mounted(); len(mounted) != 0 {
		t.Fatalf("plugin falho apareceu como montado: %v", mounted)
	}
}

func TestProfileResolvesDependenciesAndCloseUnwindsLeavesFirst(t *testing.T) {
	runtime := NewRuntime()
	var events []string
	if err := runtime.RegisterKind("capability", func(_ context.Context, owner string, _ Contribution) (Dispose, error) {
		events = append(events, "+"+owner)
		return func() error {
			events = append(events, "-"+owner)
			return nil
		}, nil
	}); err != nil {
		t.Fatal(err)
	}
	available := map[string]Manifest{
		"base": manifest("base", nil, contribution("capability", "base")),
		"leaf": manifest("leaf", []string{"base"}, contribution("capability", "leaf")),
	}
	profile := Profile{SchemaVersion: SchemaVersion, Name: "default", Plugins: []string{"leaf"}}
	if err := runtime.MountProfile(context.Background(), profile, available); err != nil {
		t.Fatal(err)
	}
	if err := runtime.Unmount("base"); err == nil {
		t.Fatal("dependência ainda usada não podia ser descarregada")
	}
	if err := runtime.Close(); err != nil {
		t.Fatal(err)
	}
	want := []string{"+base", "+leaf", "-leaf", "-base"}
	if !reflect.DeepEqual(events, want) {
		t.Fatalf("ordem do ciclo de vida: got %v want %v", events, want)
	}
}

func TestLoadProfileRejectsDuplicateActivation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "default.json")
	if err := os.WriteFile(path, []byte(`{
  "schemaVersion": 1,
  "name": "default",
  "plugins": ["grok", "grok"]
}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadProfile(path); err == nil {
		t.Fatal("perfil duplicado devia ser recusado")
	}
}

func TestBuiltinGrokIsAValidCatalogPlugin(t *testing.T) {
	grok, err := Builtin("grok")
	if err != nil {
		t.Fatal(err)
	}
	providers, models, err := CatalogsOf(grok)
	if err != nil {
		t.Fatal(err)
	}
	if len(providers) != 1 || providers[0].ID != "xai" || providers[0].Enabled {
		t.Fatalf("provedor Grok inesperado: %+v", providers)
	}
	if len(models) != 2 || models[0].ProviderID != "xai" || !models[0].Default {
		t.Fatalf("modelos Grok inesperados: %+v", models)
	}
}
