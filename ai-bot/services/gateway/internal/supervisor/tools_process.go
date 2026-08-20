// A ferramenta de processo — e o ponto EXATO em que o ambiente de execução
// deixa de ser enfeite.
//
// O produto anterior tinha o mesmo seletor no rodapé e roteava só o TERMINAL:
// o agente compilava no servidor e lia os arquivos na estação, sem ninguém
// perceber que eram duas máquinas. O erro não era o seletor, era ele não
// alcançar o despacho da ferramenta. Aqui `proc.run` consulta o ambiente ativo
// da sessão ANTES de escolher o destino:
//
//   - `local`  -> aplicativo nativo (Rust), como sempre: é ele que tem Job
//     Object e ConPTY, e o Go não executa comando na estação de propósito;
//   - qualquer outro -> o Runner correspondente (docker/sbx, wsl, vps…), aqui.
//
// # Execução isolada por padrão no turno de trabalho
//
// A ideia do sandbox é NÃO INTERFERIR no computador da pessoa: o especialista
// que executa (Código, Equipe) instala dependência e builda DENTRO do
// container, agindo na cópia congelada do turno — a máquina dela não ganha nem
// node_modules. Por isso o PADRÃO do turno de trabalho mudou: com o Docker/sbx
// são, o proc.run vai para o sandbox sem ninguém pedir; o Local virou escolha
// explícita (o seletor do rodapé continua mandando — o que mudou é onde o
// comando cai por OMISSÃO). A prioridade completa vive em turnEnvironment:
// escolha explícita da pessoa > sandbox disponível > o padrão de sempre.
//
// Uma exceção vem ANTES do ambiente ativo: trabalho de container (comando com
// docker/docker-compose/container, ou pedido explícito do modelo) vai para o
// Docker Sandboxes — e vai ANUNCIADO com um KindNotice antes de rodar. Sem o
// sbx instalado o passo cai no ai-jail da VPS, também anunciado; o downgrade
// nunca é silencioso. Ver containerStep.
//
// E o resultado volta CARIMBADO com onde rodou. É barato e resolve a metade do
// problema que ninguém vê: o modelo lendo "código de saída 1" sem saber em qual
// máquina, e concluindo a coisa errada sobre o próprio projeto.
package supervisor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync/atomic"
	"time"

	"aibot/gateway/internal/protocol"
	"aibot/gateway/internal/sandbox"
	"aibot/gateway/internal/specialist"
)

// procTimeout limita UM comando no ambiente remoto.
//
// Igual ao prazo da ponte com o host (transport.hostToolTimeout) de propósito:
// um `cargo build` demora, mas um comando que nunca termina não pode segurar o
// turno para sempre — e o teto tem de ser o mesmo nos dois caminhos, senão
// trocar de ambiente muda em silêncio quanto tempo o modelo tem.
const procTimeout = 15 * time.Minute

// NoticePublisher entrega os avisos animados (KindNotice) a quem está olhando
// a sessão. É a assinatura do PublishEphemeral do eventbus — interface aqui, e
// não o *eventbus.Bus, para o teste medir a ORDEM aviso→execução com um
// barramento de mentira, sem store nem WebSocket.
type NoticePublisher interface {
	PublishEphemeral(sessionID string, envelope protocol.Envelope)
}

// installProcessTools registra o `proc.run`.
//
// A closure carrega o `registry` porque o caminho local precisa despachar ao
// host — e quem conhece a ponte é o registro, não o toolbox.
func (t *Toolbox) installProcessTools(registry *Registry) {
	registry.Register("proc.run",
		"roda um comando único no ambiente ativo da sessão (local, docker, wsl…), com aprovação. "+
			"args: {command, cwd?, env?} — env:\"docker\" pede explicitamente um container para este passo",
		func(ctx context.Context, sessionID string, raw json.RawMessage) (string, error) {
			return t.procRun(ctx, registry, sessionID, raw)
		})
}

func (t *Toolbox) procRun(
	ctx context.Context,
	registry *Registry,
	sessionID string,
	raw json.RawMessage,
) (string, error) {
	var args struct {
		Command string `json:"command"`
		CWD     string `json:"cwd"`
		// Env é o pedido EXPLÍCITO do modelo por um ambiente pontual
		// ("docker"). Opcional — sem ele vale o ambiente ativo da sessão.
		Env string `json:"env"`
	}
	if err := decodeArgs(raw, &args); err != nil {
		return "", err
	}
	if strings.TrimSpace(args.Command) == "" {
		return "", errors.New("informe o comando em \"command\"")
	}

	// A decisão do container vem ANTES do ambiente ativo da sessão: trabalho
	// de docker/compose/container vai para o sandbox — e vai ANUNCIADO. O
	// padrão de trabalho é a VPS com o ai-jail; o Docker é a exceção que se
	// conta na tela quando acontece.
	if t.Environments != nil {
		if reason, wants := containerIntent(args.Command, args.Env); wants {
			if output, handled, err := t.containerStep(ctx, sessionID, args.Command, args.CWD, reason); handled {
				return output, err
			}
			// Nem container nem VPS nesta máquina: o aviso do containerStep já
			// explicou, e o comando segue o fluxo normal do ambiente ativo.
		}
	}

	environment := protocol.EnvLocal
	if t.Environments != nil {
		environment = t.turnEnvironment(ctx, sessionID)
	}

	if environment == protocol.EnvLocal {
		// O caminho de sempre: quem executa na estação é o Rust. Os argumentos
		// vão INTOCADOS (o `raw` original), e não remontados a partir da struct
		// acima — o host pode entender campos que este pacote nem lê, e
		// reserializar aqui os apagaria em silêncio.
		return registry.CallHost(ctx, sessionID, "proc.run", raw)
	}
	return t.runInEnvironment(ctx, sessionID, environment, args.CWD, args.Command)
}

// runInEnvironment despacha o comando ao Runner do ambiente, com as mesmas
// conferências para todos: executor existe, ambiente disponível, pasta
// confinada, teto de tempo.
func (t *Toolbox) runInEnvironment(
	ctx context.Context,
	sessionID string,
	environment protocol.Environment,
	cwd, command string,
) (string, error) {
	runner, ok := t.Environments.Runner(environment)
	if !ok {
		return "", fmt.Errorf("o ambiente %q não tem executor neste gateway", environment)
	}
	// Disponibilidade pelo registro, que tem cache curto: perguntar direto ao
	// runner dispararia um `sbx version` a cada comando.
	if available, detail := t.Environments.Availability(ctx, environment); !available {
		return "", fmt.Errorf("o ambiente %s não está disponível: %s", environment, detail)
	}

	// A VPS não usa pasta LOCAL nenhuma: o confinamento dela é o workdir do
	// catalog.json, dentro do servidor (o ai-jail faz o `cd`). Exigir raiz de
	// projeto local aqui impediria a sessão recém-criada — que nasce no padrão
	// VPS e ainda não abriu pasta — de rodar o próprio primeiro comando. Um
	// `cwd` relativo também não tem a que se referir lá, então é recusado com
	// o caminho alternativo, em vez de ignorado em silêncio.
	workdir := ""
	if environment == protocol.EnvVPS {
		if strings.TrimSpace(cwd) != "" {
			return "", errors.New("o ambiente vps roda sempre no workdir configurado pela TI — " +
				"ponha o `cd` dentro do próprio comando em vez de usar \"cwd\"")
		}
	} else {
		resolved, err := t.workdir(ctx, cwd)
		if err != nil {
			return "", err
		}
		workdir = resolved
	}

	ctx, cancel := context.WithTimeout(ctx, procTimeout)
	defer cancel()

	result, err := runner.Run(ctx, workdir, command)
	if err != nil {
		return "", fmt.Errorf("ambiente %s: %w", environment, err)
	}
	return formatProcResult(environment, result), nil
}

/* ---------------------- o padrão do turno de trabalho --------------------- */

// sandboxUnavailable é o começo do aviso de degradação. Fixo e acionável — diz
// O QUE instalar; o resto da frase diz onde o comando vai rodar em vez disso.
const sandboxUnavailable = "execução isolada indisponível — instale o Docker Desktop e o sbx"

// turnEnvironment decide ONDE o proc.run deste turno roda, nesta prioridade:
//
//  1. a escolha EXPLÍCITA da pessoa (o seletor do rodapé) manda sempre — quem
//     fixou Local fixou Local, e um padrão "inteligente" que passa por cima da
//     escolha é o seletor de enfeite de novo;
//  2. o SANDBOX são (Docker/sbx respondendo) é o padrão do turno de TRABALHO:
//     instalar dependência, buildar e scaffoldar acontecem dentro do container,
//     agindo na cópia do turno — a máquina da pessoa não ganha nem node_modules;
//  3. o padrão de sempre (VPS configurada pela TI, senão Local) para o turno de
//     conversa e para a máquina sem sandbox.
//
// A disponibilidade vem do REGISTRO, que sonda com prazo curto (probeTimeout)
// e guarda o resultado por 30s (availabilityTTL): sondar o Docker a cada
// proc.run seria pagar o frio da sondagem toda hora.
func (t *Toolbox) turnEnvironment(ctx context.Context, sessionID string) protocol.Environment {
	if chosen, ok := t.Environments.Chosen(sessionID); ok {
		return chosen
	}
	if !t.workTurn(ctx, sessionID) {
		return t.Environments.Active(ctx, sessionID)
	}
	if ok, _ := t.Environments.Availability(ctx, protocol.EnvDocker); ok {
		return protocol.EnvDocker
	}
	// DEGRADAÇÃO HONESTA: sem sandbox o turno de trabalho segue no padrão de
	// sempre — com o funil de aprovação intacto — e a pessoa fica sabendo UMA
	// vez por turno. Uma porque o turno chama proc.run dezenas de vezes, e
	// repetir o aviso a cada comando ensinaria a ignorá-lo; nenhuma seria
	// perder o isolamento em silêncio, que é pior.
	fallback := t.Environments.Active(ctx, sessionID)
	if warnSandboxOnce(ctx) {
		t.thinkingNotice(sessionID, fmt.Sprintf("%s; rodando %s com aprovação",
			sandboxUnavailable, environmentName(fallback)))
	}
	return fallback
}

// workTurn diz se ESTE turno é de trabalho: o especialista ativo da sessão
// EXECUTA (tem proc.run na própria lista — Código, Equipe). O turno de
// conversa não muda de padrão: o chat nem tem a ferramenta, e mudar onde a
// conversa roda sem ninguém pedir seria o oposto da previsibilidade.
//
// Sem raiz de projeto também não é trabalho: o sandbox age na cópia congelada
// do turno, e um turno sem pasta não tem o que montar no container — segue o
// caminho de sempre em vez de morrer numa recusa de workdir.
func (t *Toolbox) workTurn(ctx context.Context, sessionID string) bool {
	if t.root(ctx) == "" {
		return false
	}
	return specialist.GetOrDefault(t.specialistOf(sessionID)).AllowsTool("proc.run")
}

// environmentName é o nome do ambiente como a pessoa o lê no rodapé. Só o
// aviso precisa disso; o carimbo da saída continua com o id cru, que é o que o
// modelo compara.
func environmentName(id protocol.Environment) string {
	if id == protocol.EnvLocal {
		return "Local"
	}
	return string(id)
}

// sandboxWarnedKey guarda o marcador "o aviso de degradação já saiu". Vive no
// CONTEXTO porque o turno é o escopo certo do aviso: tudo que deriva do
// contexto do turno — sub-turnos delegados inclusive — compartilha o mesmo
// marcador, e o mapa por sessão que seria a alternativa nunca saberia quando
// um turno terminou para zerar.
type sandboxWarnedKey struct{}

// withSandboxWarning arma o marcador. Chamado UMA vez por turno (runTurn).
func withSandboxWarning(ctx context.Context) context.Context {
	return context.WithValue(ctx, sandboxWarnedKey{}, new(atomic.Bool))
}

// warnSandboxOnce devolve true só na PRIMEIRA chamada do turno. Contexto sem
// marcador avisa sempre: calar por falta de encanamento esconderia a
// degradação, e o defeito barulhento é o que se conserta.
func warnSandboxOnce(ctx context.Context) bool {
	flag, ok := ctx.Value(sandboxWarnedKey{}).(*atomic.Bool)
	if !ok {
		return true
	}
	return flag.CompareAndSwap(false, true)
}

// thinkingNotice publica um rótulo de etapa (KindThinking) pelo mesmo canal
// dos avisos animados. EFÊMERO como todo rótulo: o replay de um "sandbox
// indisponível" de ontem descreveria a máquina de ontem.
func (t *Toolbox) thinkingNotice(sessionID, label string) {
	if t.Notices == nil {
		return
	}
	t.Notices.PublishEphemeral(sessionID, protocol.Envelope{
		V:       protocol.Version,
		TS:      time.Now().UTC(),
		Session: sessionID,
		Kind:    protocol.KindThinking,
		From:    protocol.Actor{Kind: protocol.ActorSupervisor, Specialist: t.specialistOf(sessionID)},
		Payload: mustPayload(protocol.Thinking{Label: label}),
	})
}

/* ---------------------- a decisão anunciada do Docker --------------------- */

// containerIntent diz se ESTE comando é trabalho de container, e por quê.
//
// Duas portas: o pedido explícito do modelo (env:"docker" nos argumentos) e o
// léxico do próprio comando (docker, docker-compose, container). É heurística
// de roteamento, não segurança — o pior caso de um falso positivo é o comando
// rodar no sandbox anunciado, que é o lugar MAIS confinado da lista.
func containerIntent(command, env string) (string, bool) {
	if strings.EqualFold(strings.TrimSpace(env), "docker") {
		return "o modelo pediu explicitamente um container para este passo", true
	}
	for _, field := range strings.Fields(strings.ToLower(command)) {
		// Tira a pontuação de shell colada na palavra ("docker;", "(docker").
		token := strings.Trim(field, "\"'`()[]{};&|<>")
		switch {
		case token == "docker" || strings.HasPrefix(token, "docker-compose"):
			return fmt.Sprintf("o comando usa %s", token), true
		case strings.Contains(token, "container"):
			return "o comando mexe com container", true
		}
	}
	return "", false
}

// containerStep decide ONDE o trabalho de container roda e ANUNCIA antes.
//
// A ordem aviso→execução não é cosmética: o popup existe para a pessoa ver
// "isto vai para um container" ANTES de o container subir — anunciar depois é
// narrar o passado. E o downgrade nunca é silencioso: sem o sbx instalado, o
// aviso diz o porquê e o comando cai no ai-jail da VPS; sem VPS também, o
// aviso diz isso e o fluxo normal (handled=false) assume.
func (t *Toolbox) containerStep(
	ctx context.Context,
	sessionID, command, cwd, reason string,
) (string, bool, error) {
	specialist := t.specialistOf(sessionID)

	dockerOK, dockerDetail := t.Environments.Availability(ctx, protocol.EnvDocker)
	if dockerOK {
		t.notify(sessionID, protocol.Notice{
			Icon:       "docker",
			Title:      "Este passo vai rodar num container",
			Detail:     reason,
			Specialist: specialist,
		})
		output, err := t.runInEnvironment(ctx, sessionID, protocol.EnvDocker, cwd, command)
		return output, true, err
	}

	if vpsOK, _ := t.Environments.Availability(ctx, protocol.EnvVPS); vpsOK {
		t.notify(sessionID, protocol.Notice{
			Icon:  "docker",
			Title: "Sem container nesta máquina — este passo cai no ai-jail da VPS",
			Detail: fmt.Sprintf("%s; %s. O ai-jail limita tempo, memória e pasta, mas não é isolamento de kernel.",
				reason, dockerDetail),
			Specialist: specialist,
		})
		output, err := t.runInEnvironment(ctx, sessionID, protocol.EnvVPS, cwd, command)
		return output, true, err
	}

	t.notify(sessionID, protocol.Notice{
		Icon:  "docker",
		Title: "Sem container e sem VPS — este passo segue no ambiente ativo",
		Detail: fmt.Sprintf("%s; %s e a VPS não está disponível.",
			reason, dockerDetail),
		Specialist: specialist,
	})
	return "", false, nil
}

// specialistOf devolve o especialista ativo da sessão, ou "" quando ninguém
// sabe — o popup sai com o bot padrão em vez de não sair.
func (t *Toolbox) specialistOf(sessionID string) string {
	if t.Specialist == nil {
		return ""
	}
	return t.Specialist(sessionID)
}

// notify publica o aviso animado. EFÊMERO de propósito: o replay de um "vai
// rodar num container" de ontem reencenaria o popup ao abrir a conversa — o
// aviso só faz sentido antes do passo que ele anuncia.
func (t *Toolbox) notify(sessionID string, notice protocol.Notice) {
	if t.Notices == nil {
		return
	}
	t.Notices.PublishEphemeral(sessionID, protocol.Envelope{
		V:       protocol.Version,
		TS:      time.Now().UTC(),
		Session: sessionID,
		Kind:    protocol.KindNotice,
		From:    protocol.Actor{Kind: protocol.ActorSupervisor, Specialist: notice.Specialist},
		Payload: mustPayload(notice),
	})
}

// workdir devolve a pasta a partir da qual o comando roda, confinada à raiz do
// projeto pelas mesmas três checagens das ferramentas de arquivo (texto,
// prefixo e symlink — ver resolveInside).
//
// Sem raiz de projeto o comando é RECUSADO em vez de rodar na pasta do
// processo, que é onde mora o binário do gateway. No ambiente local isto não
// aparece porque quem resolve o diretório é o host.
func (t *Toolbox) workdir(ctx context.Context, relative string) (string, error) {
	root := t.root(ctx)
	if root == "" {
		return "", errNoRoot
	}
	if strings.TrimSpace(relative) == "" {
		return root, nil
	}
	return resolveInside(root, relative)
}

// formatProcResult monta o texto que volta ao modelo.
//
// O ambiente vai na PRIMEIRA linha porque é a informação que faltava no produto
// anterior: sem ela, "código de saída 1" é indistinguível entre a estação e o
// container, e o modelo passa a depurar a máquina errada.
//
// Código diferente de zero NÃO vira erro da ferramenta: vira este texto. Erro
// faria o supervisor dizer "a ferramenta falhou" para um teste que apenas
// reprovou, e o modelo tentaria rodar de novo em vez de ler a saída.
func formatProcResult(environment protocol.Environment, result sandbox.Result) string {
	output := strings.TrimSpace(result.Combined())
	if output == "" {
		output = "(sem saída)"
	}
	return fmt.Sprintf("[ambiente: %s] código de saída %d em %s\n%s",
		environment, result.ExitCode, result.Elapsed.Round(time.Millisecond), truncate(output, 20000))
}
