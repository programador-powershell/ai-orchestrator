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
	"time"

	"aibot/gateway/internal/protocol"
	"aibot/gateway/internal/sandbox"
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
		environment = t.Environments.Active(ctx, sessionID)
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
