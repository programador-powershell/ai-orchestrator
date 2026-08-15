package plugins

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"aibot/gateway/internal/mcphub"
	"aibot/gateway/internal/supervisor"
)

const KindMCPServer = "mcp.server"

type MCPServerConfig struct {
	Name      string        `json:"name,omitempty"`
	URL       string        `json:"url"`
	SecretRef string        `json:"secretRef,omitempty"`
	Enabled   *bool         `json:"enabled,omitempty"`
	Discover  bool          `json:"discover,omitempty"`
	Tools     []mcphub.Tool `json:"tools,omitempty"`
}

func RegisterMCP(runtime *Runtime, hub *mcphub.Hub, tools *supervisor.Registry) error {
	if runtime == nil || hub == nil || tools == nil {
		return fmt.Errorf("mcp.server exige runtime, hub e registro de ferramentas")
	}
	return runtime.RegisterKind(KindMCPServer,
		func(ctx context.Context, owner string, contribution Contribution) (Dispose, error) {
			var config MCPServerConfig
			if err := json.Unmarshal(contribution.Config, &config); err != nil {
				return nil, fmt.Errorf("config MCP ilegível: %w", err)
			}
			if config.Name == "" {
				config.Name = contribution.ID
			}
			for _, current := range hub.Servers() {
				if current.Name == config.Name {
					return nil, fmt.Errorf("servidor MCP %q já está registrado", config.Name)
				}
			}
			enabled := true
			if config.Enabled != nil {
				enabled = *config.Enabled
			}
			server := mcphub.Server{
				Name: config.Name, URL: config.URL, SecretRef: config.SecretRef,
				Enabled: enabled, Tools: config.Tools,
			}
			if err := hub.Register(server); err != nil {
				return nil, err
			}
			published := server.Tools
			if config.Discover {
				var err error
				published, err = hub.Discover(ctx, server.Name)
				if err != nil {
					hub.Unregister(server.Name)
					return nil, err
				}
			}

			var disposers []func()
			for _, tool := range published {
				qualified := tool.Name
				if !strings.HasPrefix(qualified, server.Name+".") {
					qualified = mcphub.Qualify(server.Name, qualified)
				}
				description := tool.Description
				if len(tool.InputSchema) > 0 {
					description += " args-schema: " + string(tool.InputSchema)
				}
				toolName := qualified
				dispose, err := tools.RegisterOwned("plugin:"+owner, toolName, description,
					func(callCtx context.Context, _ string, args json.RawMessage) (string, error) {
						result, err := hub.Call(callCtx, toolName, args)
						return string(result), err
					})
				if err != nil {
					for i := len(disposers) - 1; i >= 0; i-- {
						disposers[i]()
					}
					hub.Unregister(server.Name)
					return nil, err
				}
				disposers = append(disposers, dispose)
			}

			return func() error {
				for i := len(disposers) - 1; i >= 0; i-- {
					disposers[i]()
				}
				hub.Unregister(server.Name)
				return nil
			}, nil
		})
}
