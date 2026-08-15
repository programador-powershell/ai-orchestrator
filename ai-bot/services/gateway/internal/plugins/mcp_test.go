package plugins

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"aibot/gateway/internal/mcphub"
	"aibot/gateway/internal/supervisor"
)

func TestMCPContributionPublishesToolsAndUnloadsThemTogether(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var call mcphub.Request
		if err := json.NewDecoder(r.Body).Decode(&call); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%v,"result":{"content":[{"type":"text","text":"ok"}]}}`, call.ID)
	}))
	defer server.Close()

	hub := mcphub.NewHub(server.Client(), nil)
	tools := supervisor.NewRegistry()
	runtime := NewRuntime()
	if err := RegisterMCP(runtime, hub, tools); err != nil {
		t.Fatal(err)
	}
	config, err := json.Marshal(MCPServerConfig{
		Name: "demo", URL: server.URL,
		Tools: []mcphub.Tool{{Name: "echo", Description: "eco"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	plugin := manifest("connector", nil, Contribution{Kind: KindMCPServer, ID: "demo", Config: config})
	if err := runtime.Mount(context.Background(), plugin); err != nil {
		t.Fatal(err)
	}
	if !tools.Has("demo.echo") || len(hub.Servers()) != 1 {
		t.Fatalf("conector não publicou a capacidade: tools=%v servers=%v", tools.Names(), hub.Servers())
	}
	result, err := tools.Call(context.Background(), "demo.echo", "", json.RawMessage(`{"message":"oi"}`))
	if err != nil {
		t.Fatal(err)
	}
	if result == "" {
		t.Fatal("ferramenta MCP não devolveu o result")
	}
	if err := runtime.Unmount("connector"); err != nil {
		t.Fatal(err)
	}
	if tools.Has("demo.echo") || len(hub.Servers()) != 0 {
		t.Fatalf("unload deixou efeito órfão: tools=%v servers=%v", tools.Names(), hub.Servers())
	}
}
