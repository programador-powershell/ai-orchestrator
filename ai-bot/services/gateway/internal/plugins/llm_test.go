package plugins

import (
	"context"
	"testing"

	"aibot/gateway/internal/modelrouter"
)

func TestLLMCatalogContributionAppearsAndDisappearsAsALayer(t *testing.T) {
	router := modelrouter.New(nil, nil)
	runtime := NewRuntime()
	if err := RegisterLLMAdapter(runtime, router); err != nil {
		t.Fatal(err)
	}
	if err := RegisterLLMCatalog(runtime, router); err != nil {
		t.Fatal(err)
	}
	grok, err := Builtin("grok")
	if err != nil {
		t.Fatal(err)
	}
	if err := runtime.Mount(context.Background(), grok); err != nil {
		t.Fatal(err)
	}
	providers, models := router.Configuration()
	if len(providers) != 1 || providers[0].ID != "xai" || len(models) != 2 {
		t.Fatalf("catálogo do plugin não foi composto: providers=%+v models=%+v", providers, models)
	}
	if _, err := router.RegisterAdapter("collision", modelrouter.KindXAI,
		modelrouter.AdapterOptions{Protocol: modelrouter.ProtocolOpenAI}); err == nil {
		t.Fatal("plugin montado devia possuir o adaptador xai")
	}
	if err := runtime.Unmount("grok"); err != nil {
		t.Fatal(err)
	}
	providers, models = router.Configuration()
	if len(providers) != 0 || len(models) != 0 {
		t.Fatalf("catálogo ficou depois do unload: providers=%+v models=%+v", providers, models)
	}
	dispose, err := router.RegisterAdapter("after-unload", modelrouter.KindXAI,
		modelrouter.AdapterOptions{Protocol: modelrouter.ProtocolOpenAI})
	if err != nil {
		t.Fatalf("unload não removeu o adaptador xai: %v", err)
	}
	dispose()
}
