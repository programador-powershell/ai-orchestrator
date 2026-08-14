// Comando aibotd — o cérebro do AI-BOT.
//
// Sobe como sidecar do aplicativo Tauri (o caso normal) ou sozinho num servidor
// (o caso do time). Nos dois a interface é a mesma, porque o protocolo é o
// mesmo: o que muda é quem se conecta.
//
// Subcomandos:
//
//	aibotd            sobe o servidor
//	aibotd serve      idem, explícito
//	aibotd token      imprime o token da sessão local (para o app nativo ler)
//	aibotd specialists  lista os especialistas em JSON
//	aibotd version    imprime a versão
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"aibot/gateway/internal/config"
	"aibot/gateway/internal/eventbus"
	"aibot/gateway/internal/mcphub"
	"aibot/gateway/internal/memory"
	"aibot/gateway/internal/modelrouter"
	"aibot/gateway/internal/needle"
	"aibot/gateway/internal/netguard"
	"aibot/gateway/internal/permissions"
	"aibot/gateway/internal/protocol"
	"aibot/gateway/internal/schedule"
	"aibot/gateway/internal/secrets"
	"aibot/gateway/internal/specialist"
	"aibot/gateway/internal/store"
	"aibot/gateway/internal/supervisor"
	"aibot/gateway/internal/transport"
	"aibot/gateway/internal/worktree"
)

// Version é gravada no build com -ldflags "-X main.Version=…".
var Version = "0.1.0"

func main() {
	command := "serve"
	if len(os.Args) > 1 {
		command = os.Args[1]
	}

	switch command {
	case "serve":
		if err := serve(); err != nil {
			fmt.Fprintf(os.Stderr, "aibotd: %v\n", err)
			os.Exit(1)
		}
	case "token":
		if err := printToken(); err != nil {
			fmt.Fprintf(os.Stderr, "aibotd: %v\n", err)
			os.Exit(1)
		}
	case "specialists":
		raw, err := json.MarshalIndent(append(specialist.All(), specialist.Master), "", "  ")
		if err != nil {
			fmt.Fprintf(os.Stderr, "aibotd: %v\n", err)
			os.Exit(1)
		}
		fmt.Println(string(raw))
	case "version", "-v", "--version":
		fmt.Printf("AI-BOT gateway %s\n", Version)
	default:
		fmt.Fprintf(os.Stderr, "aibotd: subcomando desconhecido %q\n", command)
		os.Exit(2)
	}
}

func printToken() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	fmt.Println(cfg.Token)
	return nil
}

func serve() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	log := newLogger(cfg.LogLevel)
	log.Info("subindo o AI-BOT", "versao", Version, "config", cfg.String())

	/* ---------------------------- durabilidade --------------------------- */

	durable, err := store.Open(cfg.DataDir)
	if err != nil {
		return err
	}
	defer durable.Close()

	bus := eventbus.New(durable)

	vault, err := secrets.Open(filepath.Join(cfg.DataDir, "vault.json"), cfg.MasterKey)
	if err != nil {
		return err
	}

	recall, err := memory.Open(filepath.Join(cfg.DataDir, "memory.json"))
	if err != nil {
		return err
	}

	agenda, err := schedule.Open(filepath.Join(cfg.DataDir, "schedule.json"))
	if err != nil {
		return err
	}

	/* ------------------------------ política ----------------------------- */

	policy := permissions.DefaultPolicy()
	if cfg.Managed {
		// Na edição gerenciada a política do servidor manda. Enquanto ela não
		// chega, o padrão é o MAIS restritivo — não o mais permissivo: subir
		// aberto "só até sincronizar" é subir aberto.
		policy.Mode = permissions.ModeAsk
	}
	gate := permissions.NewGate(policy)

	/* ------------------------------- modelos ----------------------------- */

	models := modelrouter.New(&http.Client{Timeout: 5 * time.Minute}, vault)
	providers, catalog, searchBackend, err := loadCatalog(cfg.DataDir)
	if err != nil {
		return err
	}
	models.SetProviders(providers)
	models.SetModels(catalog)
	log.Info("catálogo carregado", "provedores", len(providers), "modelos", len(catalog),
		"utilizaveis", len(models.Catalog()))

	/* ----------------------------- ferramentas --------------------------- */

	guard := netguard.New(func() []string { return gate.Policy().BlockedDomains })

	hub := mcphub.NewHub(&http.Client{Timeout: 60 * time.Second},
		func(secretRef string, request *http.Request) error {
			// O segredo é usado DENTRO do callback e não volta para cá: assim
			// ele não entra em struct, log nem mensagem de erro.
			return vault.Use(secretRef, func(secret string) error {
				request.Header.Set("Authorization", "Bearer "+secret)
				return nil
			})
		})

	// Um gerente de cópias isoladas para os DOIS caminhos: a ferramenta que o
	// modelo pede e o isolamento que o supervisor faz por conta dele. Dois
	// gerentes sobre o mesmo repositório teriam um semáforo cada e voltariam a
	// disputar o index.lock — o erro de trava que ele existe para não acontecer.
	worktrees := openWorktrees(cfg, log)

	registry := supervisor.NewRegistry()
	toolbox := &supervisor.Toolbox{
		Root:      func(sessionID string) string { return sessionRoot(durable, sessionID) },
		Memory:    recall,
		Net:       guard,
		MCP:       hub,
		Worktrees: worktrees,
		Secrets:   vault,
		Schedule:  agenda,
		// O mesmo roteador do turno: imagem e fine-tuning falam com o provedor
		// pela credencial que já está configurada, sem um segundo caminho.
		Models: models,
		// O motor de busca vem do catalog.json. Vazio = `web.search` recusa
		// dizendo o que configurar — melhor do que mandar a consulta da pessoa
		// para um buscador que ninguém escolheu.
		Search: searchBackend,
	}
	toolbox.Install(registry)

	/* ----------------------------- supervisor ---------------------------- */

	// A cascata: fast router (Go puro) → Needle (local, cgo) → modelo grande.
	// O degrau local é OPCIONAL — sem a tag de build `needle` ou sem o arquivo
	// de pesos ele não existe, e a cascata encurta em vez de falhar.
	localRouter, err := supervisor.NewNeedleClassifier(needle.Options{
		ModelPath: os.Getenv("AIBOT_NEEDLE_MODEL"),
		MaxTokens: 96,
	})
	if err != nil {
		log.Info("roteador local indisponível — o primeiro input vai do fast router direto ao modelo grande",
			"motivo", err, "biblioteca", needle.Version())
	} else {
		log.Info("roteador local pronto", "biblioteca", needle.Version())
		defer localRouter.Close()
	}

	router := supervisor.NewRouter(localRouter, supervisor.NewModelClassifier(models, ""))
	sup := supervisor.New(supervisor.Deps{
		Store:     durable,
		Bus:       bus,
		Models:    models,
		Gate:      gate,
		Memory:    recall,
		Tools:     registry,
		Router:    router,
		Worktrees: worktrees,
	})
	sup.InstallCrewTools(registry)

	// O relógio da agenda. Vive enquanto o processo vive; o cancelamento sai no
	// encerramento, antes do Shutdown do servidor.
	agendaCtx, stopAgenda := context.WithCancel(context.Background())
	defer stopAgenda()
	schedule.NewRunner(agenda, func(ctx context.Context, sessionID, prompt string) error {
		// Turno em andamento é PESSOA escrevendo. O supervisor cancela o turno
		// anterior quando chega outro prompt, então disparar aqui mataria a
		// resposta que ela está lendo. O gatilho perde a janela e volta na
		// próxima: perder uma execução é melhor que interromper a conversa.
		if sup.Busy(sessionID) {
			return errors.New("a sessão está no meio de um turno")
		}
		return sup.Prompt(ctx, sessionID, protocol.Prompt{Text: prompt})
	}, log).Start(agendaCtx)

	/* ------------------------------ transporte --------------------------- */

	server := transport.NewServer(cfg, durable, bus, sup, models, gate, log)
	// A ponte fecha o ciclo: as ferramentas de máquina saem daqui para o
	// aplicativo nativo e voltam pelo mesmo protocolo.
	registry.SetBridge(server)

	httpServer := &http.Server{
		Addr:              cfg.Bind,
		Handler:           server.Handler(),
		ReadHeaderTimeout: 15 * time.Second,
		// Sem WriteTimeout: SSE e WebSocket são conexões longas por natureza, e
		// um prazo de escrita global cortaria a resposta no meio.
		IdleTimeout: 5 * time.Minute,
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)

	errs := make(chan error, 1)
	go func() {
		log.Info("ouvindo", "endereco", cfg.Bind)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errs <- err
		}
	}()

	select {
	case err := <-errs:
		return err
	case <-stop:
		log.Info("encerrando")
	}

	// Prazo de encerramento: dá tempo de fechar os sockets sem esperar um turno
	// de trinta minutos terminar. O log é append-only e o cliente sabe pedir
	// replay, então cortar aqui não perde nada.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return httpServer.Shutdown(ctx)
}

/* -------------------------------- apoio --------------------------------- */

func newLogger(level string) *slog.Logger {
	var parsed slog.Level
	switch level {
	case "debug":
		parsed = slog.LevelDebug
	case "warn":
		parsed = slog.LevelWarn
	case "error":
		parsed = slog.LevelError
	default:
		parsed = slog.LevelInfo
	}
	return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: parsed}))
}

// sessionRoot devolve a pasta de projeto da sessão. Vazio quando ela não tem —
// e aí as ferramentas de arquivo recusam, o que é melhor que cair na pasta do
// processo (que é onde mora o binário do gateway).
func sessionRoot(durable *store.Store, sessionID string) string {
	if sessionID == "" {
		return ""
	}
	meta, err := durable.GetSession(sessionID)
	if err != nil {
		return ""
	}
	return meta.CWD
}

// openWorktrees liga o gerenciador de cópias isoladas quando o gateway roda
// dentro de um repositório. Fora de um repo ele fica nil, e as ferramentas
// dizem isso em vez de falhar com erro do git.
func openWorktrees(cfg config.Config, log *slog.Logger) *worktree.Manager {
	repoRoot := os.Getenv("AIBOT_REPO_ROOT")
	if repoRoot == "" {
		current, err := os.Getwd()
		if err != nil {
			return nil
		}
		repoRoot = current
	}
	manager, err := worktree.NewManager(repoRoot, cfg.WorktreeRoot)
	if err != nil {
		log.Info("sem gerenciador de cópias isoladas", "motivo", err)
		return nil
	}
	return manager
}

/* ------------------------------- catálogo -------------------------------- */

type catalogFile struct {
	Providers []modelrouter.Provider `json:"providers"`
	Models    []modelrouter.Entry    `json:"models"`
	// Search é o motor de busca da ferramenta `web.search`. Nasce vazio: sem ele
	// a ferramenta recusa dizendo o que configurar, e recusar é melhor do que
	// mandar a consulta do usuário para um buscador que ninguém escolheu.
	Search supervisor.SearchBackend `json:"search"`
}

// loadCatalog lê providers/models do disco, criando um arquivo comentado na
// primeira execução.
//
// O arquivo nasce com todos os provedores DESLIGADOS e sem chave: um gateway
// que sobe já falando com a internet, antes de alguém configurar, é um gateway
// que manda o primeiro prompt para onde o padrão apontar.
func loadCatalog(dataDir string) ([]modelrouter.Provider, []modelrouter.Entry, supervisor.SearchBackend, error) {
	path := filepath.Join(dataDir, "catalog.json")
	var empty supervisor.SearchBackend

	raw, err := os.ReadFile(path)
	if err == nil {
		var parsed catalogFile
		if err := json.Unmarshal(raw, &parsed); err != nil {
			return nil, nil, empty, fmt.Errorf("ler %s: %w", path, err)
		}
		return parsed.Providers, parsed.Models, parsed.Search, nil
	}
	if !os.IsNotExist(err) {
		return nil, nil, empty, fmt.Errorf("ler %s: %w", path, err)
	}

	seed := defaultCatalog()
	pretty, err := json.MarshalIndent(seed, "", "  ")
	if err != nil {
		return nil, nil, empty, err
	}
	if err := os.WriteFile(path, pretty, 0o600); err != nil {
		return nil, nil, empty, fmt.Errorf("gravar %s: %w", path, err)
	}
	return seed.Providers, seed.Models, seed.Search, nil
}

// protocolModel encurta a montagem do catálogo semente. Os ids são editáveis no
// catalog.json — modelo é coisa que muda de nome sem avisar, e travar a lista no
// binário obrigaria a recompilar o gateway para trocar de versão de modelo.
func protocolModel(id, provider, label string, window int, skills []string, local bool) protocol.Model {
	return protocol.Model{
		ID:       id,
		Provider: provider,
		Label:    label,
		Context:  window,
		Skills:   skills,
		Local:    local,
	}
}

func defaultCatalog() catalogFile {
	return catalogFile{
		Providers: []modelrouter.Provider{
			{
				ID: "anthropic", Name: "Anthropic", Kind: modelrouter.KindAnthropic,
				BaseURL: "https://api.anthropic.com/v1", SecretRef: "provider:anthropic", Enabled: false,
			},
			{
				ID: "openai", Name: "OpenAI", Kind: modelrouter.KindOpenAI,
				BaseURL: "https://api.openai.com/v1", SecretRef: "provider:openai", Enabled: false,
			},
			{
				ID: "gemini", Name: "Google Gemini", Kind: modelrouter.KindGemini,
				BaseURL: "https://generativelanguage.googleapis.com/v1beta", SecretRef: "provider:gemini", Enabled: false,
			},
			{
				// O runtime local do aplicativo fala OpenAI em 127.0.0.1. Já nasce
				// habilitado: ele não sai da máquina, então não há segredo nem
				// custo em deixá-lo disponível — só não haverá modelo carregado.
				ID: "local", Name: "Runtime local", Kind: modelrouter.KindLocal,
				BaseURL: "http://127.0.0.1:8788/v1", Enabled: true,
			},
		},
		Models: []modelrouter.Entry{
			{
				Model: protocolModel("claude-opus-5", "anthropic", "Claude Opus 5", 200000,
					[]string{"chat", "code", "reasoning", "tools", "long-context", "vision"}, false),
				ProviderID: "anthropic", Default: true,
			},
			{
				Model: protocolModel("claude-sonnet-5", "anthropic", "Claude Sonnet 5", 200000,
					[]string{"chat", "code", "reasoning", "tools", "long-context", "vision"}, false),
				ProviderID: "anthropic",
			},
			{
				Model: protocolModel("claude-haiku-4-5-20251001", "anthropic", "Claude Haiku 4.5", 200000,
					[]string{"chat", "tools"}, false),
				ProviderID: "anthropic",
			},
			{
				Model: protocolModel("gpt-5", "openai", "GPT-5", 400000,
					[]string{"chat", "code", "reasoning", "tools", "vision"}, false),
				ProviderID: "openai",
			},
			{
				Model: protocolModel("gemini-2.5-pro", "gemini", "Gemini 2.5 Pro", 1000000,
					[]string{"chat", "code", "long-context", "vision"}, false),
				ProviderID: "gemini",
			},
			{
				Model: protocolModel("local-gguf", "local", "Modelo local", 32768,
					[]string{"chat"}, true),
				ProviderID: "local",
			},
		},
	}
}
