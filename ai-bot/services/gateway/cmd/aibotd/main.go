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
//	aibotd pack       instala/lista/remove pacotes corporativos (internal/pack)
//	aibotd restore    restaura um backup para uma pasta NOVA e imprime o caminho
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
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"aibot/gateway/internal/backup"
	"aibot/gateway/internal/config"
	"aibot/gateway/internal/eventbus"
	"aibot/gateway/internal/mcphub"
	"aibot/gateway/internal/memory"
	"aibot/gateway/internal/modelrouter"
	"aibot/gateway/internal/needle"
	"aibot/gateway/internal/netguard"
	"aibot/gateway/internal/pack"
	"aibot/gateway/internal/permissions"
	"aibot/gateway/internal/plugins"
	"aibot/gateway/internal/policy"
	"aibot/gateway/internal/protocol"
	"aibot/gateway/internal/sandbox"
	"aibot/gateway/internal/schedule"
	"aibot/gateway/internal/secrets"
	"aibot/gateway/internal/specialist"
	"aibot/gateway/internal/store"
	"aibot/gateway/internal/supervisor"
	"aibot/gateway/internal/transport"
	"aibot/gateway/internal/update"
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
	case "pack":
		if err := runPackCommand(os.Args[2:]); err != nil {
			fmt.Fprintf(os.Stderr, "aibotd: %v\n", err)
			os.Exit(1)
		}
	case "restore":
		if len(os.Args) < 3 {
			fmt.Fprintln(os.Stderr, "uso: aibotd restore <arquivo.tar>")
			os.Exit(2)
		}
		// A restauração vai SEMPRE para uma pasta nova — nunca por cima do
		// diretório vivo. Sobrescrever transformaria um backup bom em dois
		// dados ruins quando o tar está truncado: o vivo morre no meio da
		// escrita e o backup era a única cópia íntegra. Trocar as pastas é
		// gesto da pessoa, com o gateway parado (ver internal/backup).
		destination, err := backup.Restore(os.Args[2])
		if err != nil {
			fmt.Fprintf(os.Stderr, "aibotd: %v\n", err)
			os.Exit(1)
		}
		// O caminho novo sai no stdout (para script ler); a instrução, no stderr.
		fmt.Println(destination)
		fmt.Fprintln(os.Stderr, "restaurado numa pasta NOVA — o diretório vivo não foi tocado. "+
			"Para usar: pare o gateway e aponte AIBOT_DATA_DIR para a pasta acima, ou troque as pastas na mão. "+
			"A master.key e o token não viajam no backup; eles continuam na estação (ou no cofre da empresa).")
	case "version", "-v", "--version":
		fmt.Printf("AI-BOT gateway %s\n", Version)
	default:
		fmt.Fprintf(os.Stderr, "aibotd: subcomando desconhecido %q\n", command)
		os.Exit(2)
	}
}

/* --------------------------- pacotes corporativos -------------------------- */

// runPackCommand é o `aibotd pack <install|list|remove>` — o caminho pelo qual
// a TI instala UMA vez e todo mundo da estação ganha.
//
// O subcomando roda num processo PRÓPRIO, separado do gateway que está no ar:
// ele valida e PERSISTE o pacote na pasta de dados; quem aplica de verdade é o
// boot seguinte do serve(). É por isso que o install termina mandando
// reiniciar — aplicar por fora num processo que morre em seguida fingiria um
// efeito que ninguém recebeu.
func runPackCommand(args []string) error {
	if len(args) == 0 {
		return errors.New("uso: aibotd pack install <diretório ou .tar> | aibotd pack list | aibotd pack remove <nome>")
	}
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	switch args[0] {
	case "install":
		if len(args) < 2 {
			return errors.New("uso: aibotd pack install <diretório ou .tar>")
		}
		loaded, err := pack.Load(args[1])
		if err != nil {
			return err
		}
		defer loaded.Cleanup()

		// O install do subcomando valida DE VERDADE o que dá para validar sem
		// gateway: o overlay passa pelo specialist.LoadOverlay (o mesmo parser
		// e as mesmas recusas do boot) e cada conector passa pelo Register de
		// um hub descartável (nome, URL, esquema). Se algo recusar aqui, o
		// pacote não persiste — e o boot de amanhã não herda um pacote quebrado.
		throwaway := mcphub.NewHub(nil, nil)
		err = pack.Install(loaded, pack.Deps{
			DataDir:      cfg.DataDir,
			ApplyOverlay: specialist.LoadOverlay,
			RegisterMCP: func(server pack.MCPServer) error {
				return throwaway.Register(mcphub.Server{
					Name: server.Name, URL: server.URL, SecretRef: server.SecretRef, Enabled: true,
				})
			},
		})
		if err != nil {
			return err
		}
		fmt.Printf("pacote %s v%s instalado em %s\n", loaded.Name, loaded.Version, cfg.DataDir)
		fmt.Println("reinicie o gateway (ou o aplicativo) para o pacote valer — o boot aplica o que está persistido.")
		return nil

	case "list":
		packs, problems := pack.Discover(cfg.DataDir)
		if problems != nil {
			fmt.Fprintf(os.Stderr, "aviso: pacote(s) recusado(s): %v\n", problems)
		}
		if len(packs) == 0 {
			fmt.Println("nenhum pacote instalado — instale com `aibotd pack install <diretório ou .tar>`")
			return nil
		}
		fmt.Println(pack.Describe(packs))
		return nil

	case "remove":
		if len(args) < 2 {
			return errors.New("uso: aibotd pack remove <nome>")
		}
		// O Discover ancora o Remove na pasta de dados desta configuração.
		if _, problems := pack.Discover(cfg.DataDir); problems != nil {
			fmt.Fprintf(os.Stderr, "aviso: pacote(s) ilegível(is) ignorado(s): %v\n", problems)
		}
		if err := pack.Remove(args[1]); err != nil {
			return err
		}
		fmt.Printf("pacote %s removido — o gateway esquece o que ele aplicou no próximo boot.\n", args[1])
		return nil

	default:
		return fmt.Errorf("subcomando de pack desconhecido %q — use install, list ou remove", args[0])
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

	/* ------------------------------- backup ------------------------------- */

	// O produto anterior ADIOU backup por decisão; aqui ele entra. Snapshot
	// periódico do que mora no DataDir (sessões, memória, agenda, catálogo e o
	// cofre SELADO — ciphertext, seguro de copiar) num tar local, com espelho
	// opcional em outro disco via AIBOT_BACKUP_MIRROR. Há um snapshot também
	// no encerramento, lá embaixo. A restauração é o subcomando `aibotd
	// restore`, que nunca escreve por cima do vivo — ver internal/backup.
	backups := backup.New(cfg.DataDir, backup.OptionsFromEnv(log))
	backups.SetLogger(log)
	backupCtx, stopBackup := context.WithCancel(context.Background())
	// Parar E esperar: cancelar só impede a próxima volta do relógio, e um
	// snapshot já em andamento seguiria montando o tar depois de o processo ter
	// dado o encerramento por concluído.
	defer func() {
		stopBackup()
		backups.Wait()
	}()
	backups.Start(backupCtx)

	/* ------------------------------ política ----------------------------- */

	sessionPolicy := permissions.DefaultPolicy()
	if cfg.Managed {
		// Na edição gerenciada a política do servidor manda. Enquanto ela não
		// chega, o padrão é o MAIS restritivo — não o mais permissivo: subir
		// aberto "só até sincronizar" é subir aberto.
		sessionPolicy.Mode = permissions.ModeAsk
	}
	gate := permissions.NewGate(sessionPolicy)

	/* ------------------------------- modelos ----------------------------- */

	models := modelrouter.New(&http.Client{Timeout: 5 * time.Minute}, vault)
	// O caminho é calculado UMA vez e vai também ao transporte: as rotas de
	// catálogo regravam o mesmo arquivo, e dois joins independentes seriam dois
	// lugares para divergirem no dia em que o nome mudar.
	catalogPath := filepath.Join(cfg.DataDir, "catalog.json")
	providers, catalog, searchBackend, vpsConfig, err := loadCatalog(catalogPath)
	if err != nil {
		return err
	}
	if cfg.Managed {
		// A outra metade da edição gerenciada, que faltava: "sem BYOK direto e
		// sem runtime local" precisa DERRUBAR o BYOK local, não só trocar o modo
		// de aprovação. O corte é o padrão enquanto não há política remota — e
		// continua sendo o padrão sempre que a busca dela falhar.
		providers, sessionPolicy.AllowedModels = policy.RestrictManaged(providers, catalog)
		gate.SetPolicy(sessionPolicy)
		log.Info("edição gerenciada: o runtime local está desligado e só os modelos de provedor remoto ficam disponíveis",
			"modelos_liberados", len(sessionPolicy.AllowedModels))
	}
	models.SetProviders(providers)
	models.SetModels(catalog)
	// O portão do catálogo. Sem esta linha, `AllowedModels` seria mais uma
	// política que existe em struct e não tem chamador — que é como a anterior
	// virou decoração.
	models.SetAllowed(sessionPolicy.AllowedModels)

	// O microkernel aplica capacidades como efeitos reversíveis. Grok é o
	// primeiro plugin embutido: o adaptador xAI continua atrás do contrato do
	// roteador, enquanto provedor e modelos vêm do manifesto declarativo.
	pluginRuntime := plugins.NewRuntime()
	defer func() {
		if err := pluginRuntime.Close(); err != nil {
			log.Warn("plugin(s) não descarregado(s) por completo", "motivo", err)
		}
	}()
	if err := plugins.RegisterLLMCatalog(pluginRuntime, models); err != nil {
		return err
	}
	if err := plugins.RegisterLLMAdapter(pluginRuntime, models); err != nil {
		return err
	}
	builtinPlugins, err := plugins.Builtins()
	if err != nil {
		return err
	}
	if grok, ok := builtinPlugins["grok"]; !ok {
		return errors.New("o build não contém o plugin embutido grok")
	} else if err := pluginRuntime.Mount(context.Background(), grok); err != nil {
		return fmt.Errorf("montar plugin grok: %w", err)
	}
	log.Info("catálogo carregado", "provedores", len(providers), "modelos", len(catalog),
		"utilizaveis", len(models.Catalog()))

	/* ----------------------------- ferramentas --------------------------- */

	guard := netguard.New(func() []string { return gate.Policy().BlockedDomains })

	/* --------------------------- política remota ------------------------- */

	// AIBOT_POLICY_URL é endereço de FORA, então a busca sai pelo netguard como
	// qualquer outra: um servidor de política apontado para 169.254.169.254 seria
	// SSRF com crachá.
	//
	// A busca é em segundo plano e NÃO bloqueia o boot porque o app precisa abrir
	// offline — no notebook em viagem, na VPN caída, no dia da manutenção do
	// servidor de política. O preço é a janela entre subir e sincronizar, e é
	// exatamente por isso que o padrão gerenciado acima já sobe restritivo.
	// Falhar na busca mantém esse padrão: indisponibilidade não é liberação.
	policyCtx, stopPolicy := context.WithCancel(context.Background())
	defer stopPolicy()
	policy.Start(policyCtx, policy.Options{
		URL:     cfg.PolicyURL,
		Base:    sessionPolicy,
		Fetcher: guard,
		Gate:    gate,
		Models:  models,
		Log:     log,
	})

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

	// Os ambientes de execução, na ORDEM em que a tela os mostra. O local vem
	// primeiro porque é o piso que não depende de nada instalado; a VPS agora
	// tem executor de verdade (OpenSSH do sistema + ai-jail) e, configurada no
	// catalog.json e respondendo, vira o PADRÃO das sessões novas. A nuvem
	// segue declarada e sem executor — aparece cinza com o motivo, em vez de
	// sumir e a pessoa procurar.
	//
	// Nada do Docker é distribuído com o AI-BOT: o `sbx` é dirigido de onde
	// estiver instalado. Ver o cabeçalho de internal/sandbox/sandbox.go.
	environments := sandbox.NewRegistry(
		sandbox.NewLocalRunner(),
		sandbox.NewDockerRunner(sandbox.DockerOptions{EnvFile: sandboxEnvFile(log)}),
		sandbox.NewWSLRunner(),
		sandbox.NewVPSRunner(vpsConfig),
		sandbox.NewCloudRunner(),
	)

	registry := supervisor.NewRegistry()
	toolbox := &supervisor.Toolbox{
		Root:      func(sessionID string) string { return sessionRoot(durable, sessionID) },
		Memory:    recall,
		Net:       guard,
		MCP:       hub,
		Worktrees: worktrees,
		Secrets:   vault,
		Schedule:  agenda,
		// O MESMO registro que o transporte publica no `ready`: se fossem dois,
		// a tela mostraria um ambiente e o `proc.run` rodaria em outro — que é
		// exatamente a falha que este seletor existe para não repetir.
		Environments: environments,
		// O mesmo roteador do turno: imagem e fine-tuning falam com o provedor
		// pela credencial que já está configurada, sem um segundo caminho.
		Models: models,
		// O motor de busca vem do catalog.json. Vazio = `web.search` recusa
		// dizendo o que configurar — melhor do que mandar a consulta da pessoa
		// para um buscador que ninguém escolheu.
		Search: searchBackend,
		// O aviso animado ("este passo vai rodar num container") sai pelo
		// barramento, EFÊMERO, antes de o DockerRunner rodar — anunciar depois
		// seria narrar o passado. Ver supervisor/tools_process.go.
		Notices: bus,
		// O especialista ativo, para o popup desenhar o avatar certo.
		Specialist: func(sessionID string) string { return sessionSpecialist(durable, sessionID) },
	}
	toolbox.Install(registry)

	// O catálogo publicado (trilha A) declara ferramentas por nome, e um nome
	// que não existe no registro faz o especialista prometer ao modelo uma
	// permissão que ninguém executa. Quem sabe o que existe é o registro, que
	// só agora está montado — por isso a validação é ligada aqui, e não dentro
	// do pacote de especialistas (que o registro importa, e não o contrário).
	specialist.SetToolChecker(registry.Has)

	// MCP e especialistas entram no MESMO kernel depois de seus consumidores
	// existirem. Um mcp.server publica cada tool no registro do supervisor; ao
	// descarregar, ferramentas e servidor desaparecem juntos.
	if err := plugins.RegisterMCP(pluginRuntime, hub, registry); err != nil {
		return err
	}
	if err := plugins.RegisterSpecialistOverlay(pluginRuntime); err != nil {
		return err
	}
	if err := mountPluginProfile(context.Background(), cfg.DataDir, pluginRuntime, builtinPlugins, log); err != nil {
		return err
	}

	/* ------------------------- pacotes corporativos ------------------------ */

	// Os ganchos declarativos dos pacotes (audit/webhook/deny). O despacho de
	// webhook REUSA o webhook.post do registro: mesma censura de segredo, mesma
	// regra de que a URL mora no cofre — um segundo caminho de saída seria uma
	// segunda superfície para vazar credencial.
	hookRunner := supervisor.NewHookRunner(cfg.DataDir,
		func(ctx context.Context, secretRef string, body json.RawMessage) error {
			args, err := json.Marshal(map[string]any{"secretRef": secretRef, "body": body})
			if err != nil {
				return err
			}
			_, err = registry.Call(ctx, "webhook.post", "", args)
			return err
		}, log)

	// Os pacotes persistidos (aibotd pack install) aplicam AGORA, depois do
	// registro de ferramentas (o overlay deles valida ferramenta por nome) e
	// antes do transporte (o catálogo e as políticas têm de valer quando a
	// primeira janela conectar). Pacote quebrado fica de fora com o motivo no
	// log — não derruba o boot, igual às outras fontes de dado publicado.
	installedPacks, packProblems := pack.Discover(cfg.DataDir)
	if packProblems != nil {
		log.Warn("pacote(s) corporativo(s) recusado(s) no boot", "motivo", packProblems)
	}
	packDeps := pack.Deps{
		DataDir:      cfg.DataDir,
		ApplyOverlay: specialist.LoadOverlay,
		RegisterMCP: func(server pack.MCPServer) error {
			return hub.Register(mcphub.Server{
				Name: server.Name, URL: server.URL, SecretRef: server.SecretRef, Enabled: true,
			})
		},
		RegisterHooks: func(name string, hooks []pack.HookSpec) error {
			converted := make([]supervisor.Hook, 0, len(hooks))
			for _, hook := range hooks {
				converted = append(converted, supervisor.Hook{
					On:        supervisor.HookEvent(hook.On),
					Tool:      hook.Tool,
					Action:    hook.Action,
					SecretRef: hook.SecretRef,
				})
			}
			hookRunner.Register(name, converted)
			return nil
		},
		Gate: gate,
	}
	for _, corporate := range installedPacks {
		if err := pack.Install(corporate, packDeps); err != nil {
			log.Warn("pacote corporativo não aplicado", "pacote", corporate.Name, "motivo", err)
			continue
		}
		log.Info("pacote corporativo aplicado", "pacote", corporate.Name, "versao", corporate.Version)
	}

	/* ----------------------------- supervisor ---------------------------- */

	// A cascata: fast router (Go puro) → Needle (local, cgo) → modelo grande.
	// O degrau local é OPCIONAL — sem a tag de build `needle` ou sem o arquivo
	// de pesos ele não existe, e a cascata encurta em vez de falhar.
	//
	// O cérebro do degrau é o Needle Router Pro: o modelo do harness de pesquisa
	// (needle-router-pro/), treinado SÓ para entender o contexto do primeiro
	// input e chamar o especialista dono. A descoberta procura o `.cact` no
	// caminho apontado, no diretório de dados e ao lado do executável — e o log
	// abaixo separa os DOIS pré-requisitos (arquivo de pesos e binding nativo),
	// porque "indisponível" sem dizer qual dos dois falta manda a pessoa
	// depurar o lado errado.
	modelPath, modelFound := needle.ResolveModelPath(os.Getenv("AIBOT_NEEDLE_MODEL"), cfg.DataDir)
	localRouter, err := supervisor.NewNeedleClassifier(needle.Options{
		ModelPath: modelPath,
		MaxTokens: 96,
	})
	if err != nil {
		modelState := "presente em " + modelPath
		if !modelFound {
			modelState = "AUSENTE — instale o needle-router-pro.cact em " + modelPath
		}
		log.Info("roteador local indisponível — o primeiro input vai do fast router direto ao modelo grande",
			"motivo", err, "biblioteca", needle.Version(), "modelo", modelState)
	} else {
		log.Info("roteador local pronto", "biblioteca", needle.Version(), "modelo", modelPath)
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
		// Os ganchos e os prompts dos pacotes corporativos. Por função para o
		// supervisor não importar internal/pack — a dependência aponta para cá.
		Hooks:      hookRunner,
		PackPrompt: pack.PromptFor,
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

	/* ----------------------------- atualização --------------------------- */

	// As trilhas A (dado) e C (o próprio aibotd) — ver docs/atualizacao.md.
	//
	// Fica DEPOIS do supervisor por dois motivos: a busca sai pelo `guard`, que
	// já existe, e o aviso precisa do barramento e do supervisor para dizer o
	// `busy` certo de cada sessão. Fica ANTES do transporte porque o catálogo
	// publicado tem de estar valendo quando a primeira janela pedir a lista de
	// especialistas.
	//
	// Nada aqui bloqueia o boot: o app precisa abrir offline, e a primeira
	// passada acontece em segundo plano.
	updateCtx, stopUpdate := context.WithCancel(context.Background())
	defer stopUpdate()
	updates := update.NewService(update.Options{
		ManifestURL: cfg.UpdateManifestURL,
		PublicKey:   cfg.UpdatePublicKey,
		Channel:     cfg.UpdateChannel,
		Version:     Version,
		// A casca se identifica quando quer. Vazio é "não sei" e não bloqueia
		// nada — ver update.Options.ShellVersion.
		ShellVersion: strings.TrimSpace(os.Getenv("AIBOT_SHELL_VERSION")),
		Fetcher:      update.NewFetcher(guard, filepath.Join(cfg.DataDir, "updates")),
		ApplyData: map[string]func([]byte) error{
			// O catálogo publicado SOBREPÕE o compilado, e a recusa é do
			// documento inteiro: meio catálogo aplicado é pior que nenhum.
			update.ArtifactSpecialists: specialist.LoadOverlay,
		},
		Announce: announceUpdate(bus, sup, log),
		Log:      log,
	})
	if err := updates.Start(updateCtx); err != nil {
		// Não é falha de boot. Um gateway que não se atualiza sozinho continua
		// sendo um gateway inteiro; um que sobe aceitando manifesto sem chave
		// seria um problema muito maior. O motivo vai para o log porque "o app
		// nunca atualiza" precisa ter uma linha que explique.
		log.Info("serviço de atualização desligado", "motivo", err)
	} else {
		log.Info("serviço de atualização no ar", "canal", cfg.UpdateChannel,
			"catalogo", specialist.Origin())
	}

	/* ------------------------------ transporte --------------------------- */

	// O cofre e o caminho do catálogo entram aqui para as rotas de
	// /v1/catalog: a chave do provedor vai ao cofre e o arquivo é regravado e
	// aplicado a quente sem reiniciar o processo.
	server := transport.NewServer(cfg, durable, bus, sup, models, gate, environments, vault, catalogPath, log)
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
	err = httpServer.Shutdown(ctx)

	// Snapshot de ENCERRAMENTO: com os sockets fechados nada mais escreve, e é
	// o momento mais barato de copiar. Falha aqui não muda o desfecho — o
	// snapshot periódico cobre a próxima janela e o motivo fica no log.
	if path, snapErr := backups.Snapshot(); snapErr != nil {
		log.Warn("backup de encerramento falhou", "erro", snapErr)
	} else {
		log.Info("backup de encerramento gravado", "arquivo", path)
	}
	return err
}

/* -------------------------------- apoio --------------------------------- */

// announceUpdate monta o `state` da atualização para CADA sessão aberta.
//
// O aviso não pertence a conversa nenhuma — "há versão nova pronta" é do
// aplicativo —, então ele vai por broadcast efêmero: quem está olhando recebe,
// e o histórico não guarda um aviso que amanhã já não vale.
//
// O `busy` é remontado por sessão, e isso não é zelo: o cliente aplica
// `state.busy` como veio (apps/desktop/src/lib/store.ts), então um envelope com
// `busy:false` entregue a quem está no meio de um turno apagaria o indicador de
// atividade e liberaria o campo de texto com o modelo ainda respondendo.
func announceUpdate(bus *eventbus.Bus, sup *supervisor.Supervisor, log *slog.Logger) func(protocol.State) {
	var counter atomic.Uint64
	return func(state protocol.State) {
		bus.Broadcast(func(sessionID string) (protocol.Envelope, bool) {
			envelope := protocol.Envelope{
				V:       protocol.Version,
				ID:      fmt.Sprintf("upd%d%d", time.Now().UnixNano()/1e6, counter.Add(1)),
				TS:      time.Now().UTC(),
				Session: sessionID,
				Kind:    protocol.KindState,
				From:    protocol.Actor{Kind: protocol.ActorSystem},
			}
			state.Busy = sup.Busy(sessionID)
			if err := envelope.SetPayload(state); err != nil {
				log.Warn("não foi possível anunciar a atualização", "erro", err)
				return protocol.Envelope{}, false
			}
			return envelope, true
		})
	}
}

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

// sessionSpecialist devolve o especialista em que a sessão parou. Vazio quando
// a sessão não existe ou ainda não roteou — o aviso animado sai com o bot
// padrão em vez de não sair.
func sessionSpecialist(durable *store.Store, sessionID string) string {
	if sessionID == "" {
		return ""
	}
	meta, err := durable.GetSession(sessionID)
	if err != nil {
		return ""
	}
	return meta.Specialist
}

// sandboxEnvFile acha o `.sbxenv.yaml` — a declaração do nosso sandbox do
// Docker (workspace, rede, limites, e nenhum segredo).
//
// Ele é NOSSO e mora no repositório; o que não mora aqui é qualquer arquivo do
// Docker. A busca começa pelo que a estação mandou (AIBOT_SBX_ENV_FILE), passa
// pela raiz do repositório e termina na pasta corrente.
//
// Não achar NÃO é erro: sem o arquivo, o `sbx` usa a configuração que ele mesmo
// encontrar, e o ambiente continua utilizável. O aviso vai para o log porque
// rodar sem a nossa declaração significa rodar sem os limites que ela impõe —
// silenciar isso seria o pior dos dois mundos.
func sandboxEnvFile(log *slog.Logger) string {
	if declared := os.Getenv("AIBOT_SBX_ENV_FILE"); declared != "" {
		if _, err := os.Stat(declared); err == nil {
			return declared
		}
		log.Warn("AIBOT_SBX_ENV_FILE aponta para um arquivo que não existe", "caminho", declared)
	}

	candidates := make([]string, 0, 2)
	if repoRoot := os.Getenv("AIBOT_REPO_ROOT"); repoRoot != "" {
		candidates = append(candidates, filepath.Join(repoRoot, ".sbxenv.yaml"))
	}
	if current, err := os.Getwd(); err == nil {
		candidates = append(candidates, filepath.Join(current, ".sbxenv.yaml"))
	}
	for _, candidate := range candidates {
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	log.Info("sem .sbxenv.yaml — o ambiente Docker roda com a configuração padrão do sbx, sem os nossos limites")
	return ""
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
	// VPS é o servidor da TI ({host, port, user, workdir, fingerprint}). Nasce
	// vazio: sem ele o ambiente aparece cinza dizendo o que preencher, e o
	// padrão de execução continua no local. Preenchido E respondendo, a VPS
	// vira o PADRÃO das sessões novas — ver sandbox.Registry.DefaultEnvironment.
	// A fingerprint (SHA256:…) é conferida a cada uso; ver internal/sandbox/vps.go.
	VPS sandbox.VPSConfig `json:"vps"`
}

// loadCatalog lê providers/models do disco, criando um arquivo comentado na
// primeira execução.
//
// O arquivo nasce com todos os provedores DESLIGADOS e sem chave: um gateway
// que sobe já falando com a internet, antes de alguém configurar, é um gateway
// que manda o primeiro prompt para onde o padrão apontar. A VPS nasce vazia
// pelo mesmo princípio: apontar servidor é decisão da TI, não default nosso.
func loadCatalog(path string) ([]modelrouter.Provider, []modelrouter.Entry, supervisor.SearchBackend, sandbox.VPSConfig, error) {
	var empty supervisor.SearchBackend
	var noVPS sandbox.VPSConfig

	raw, err := os.ReadFile(path)
	if err == nil {
		var parsed catalogFile
		if err := json.Unmarshal(raw, &parsed); err != nil {
			return nil, nil, empty, noVPS, fmt.Errorf("ler %s: %w", path, err)
		}
		return parsed.Providers, parsed.Models, parsed.Search, parsed.VPS, nil
	}
	if !os.IsNotExist(err) {
		return nil, nil, empty, noVPS, fmt.Errorf("ler %s: %w", path, err)
	}

	seed, err := defaultCatalog()
	if err != nil {
		return nil, nil, empty, noVPS, err
	}
	pretty, err := json.MarshalIndent(seed, "", "  ")
	if err != nil {
		return nil, nil, empty, noVPS, err
	}
	if err := os.WriteFile(path, pretty, 0o600); err != nil {
		return nil, nil, empty, noVPS, fmt.Errorf("gravar %s: %w", path, err)
	}
	return seed.Providers, seed.Models, seed.Search, seed.VPS, nil
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

func defaultCatalog() (catalogFile, error) {
	seed := catalogFile{
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
				ProviderID: "anthropic",
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
	grok, err := plugins.Builtin("grok")
	if err != nil {
		return catalogFile{}, err
	}
	providers, models, err := plugins.CatalogsOf(grok)
	if err != nil {
		return catalogFile{}, err
	}
	seed.Providers = append(seed.Providers, providers...)
	seed.Models = append(seed.Models, models...)
	return seed, nil
}

// mountPluginProfile carrega extensões locais somente quando o perfil default
// as escolhe. Copiar uma pasta para DataDir/plugins não executa nada por
// acidente; a ativação fica auditável em profiles/default.json.
func mountPluginProfile(ctx context.Context, dataDir string, runtime *plugins.Runtime,
	builtins map[string]plugins.Manifest, log *slog.Logger) error {
	available := make(map[string]plugins.Manifest, len(builtins))
	for name, manifest := range builtins {
		available[name] = manifest
	}
	external, discoverErr := plugins.Discover(filepath.Join(dataDir, "plugins"))
	if discoverErr != nil {
		log.Warn("plugin(s) local(is) recusado(s)", "motivo", discoverErr)
	}
	for name, manifest := range external {
		if _, reserved := available[name]; reserved {
			log.Warn("plugin local não pode substituir plugin embutido", "plugin", name)
			continue
		}
		available[name] = manifest
	}

	profilePath := filepath.Join(dataDir, "profiles", "default.json")
	profile, err := plugins.LoadProfile(profilePath)
	if errors.Is(err, os.ErrNotExist) {
		if len(external) > 0 {
			log.Info("plugins locais descobertos, mas não ativados — crie profiles/default.json",
				"quantidade", len(external))
		}
		return nil
	}
	if err != nil {
		return err
	}
	if err := runtime.MountProfile(ctx, profile, available); err != nil {
		return fmt.Errorf("montar perfil de plugins %s: %w", profile.Name, err)
	}
	log.Info("perfil de plugins montado", "perfil", profile.Name, "plugins", len(runtime.Mounted()))
	return nil
}
