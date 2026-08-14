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
//   - qualquer outro -> o Runner correspondente (docker/sbx, wsl…), aqui.
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

// installProcessTools registra o `proc.run`.
//
// A closure carrega o `registry` porque o caminho local precisa despachar ao
// host — e quem conhece a ponte é o registro, não o toolbox.
func (t *Toolbox) installProcessTools(registry *Registry) {
	registry.Register("proc.run",
		"roda um comando único no ambiente ativo da sessão (local, docker, wsl…), com aprovação. args: {command, cwd?}",
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
	}
	if err := decodeArgs(raw, &args); err != nil {
		return "", err
	}
	if strings.TrimSpace(args.Command) == "" {
		return "", errors.New("informe o comando em \"command\"")
	}

	environment := protocol.EnvLocal
	if t.Environments != nil {
		environment = t.Environments.Active(sessionID)
	}

	if environment == protocol.EnvLocal {
		// O caminho de sempre: quem executa na estação é o Rust. Os argumentos
		// vão INTOCADOS (o `raw` original), e não remontados a partir da struct
		// acima — o host pode entender campos que este pacote nem lê, e
		// reserializar aqui os apagaria em silêncio.
		return registry.CallHost(ctx, sessionID, "proc.run", raw)
	}

	runner, ok := t.Environments.Runner(environment)
	if !ok {
		return "", fmt.Errorf("o ambiente %q não tem executor neste gateway", environment)
	}
	// Disponibilidade pelo registro, que tem cache curto: perguntar direto ao
	// runner dispararia um `sbx version` a cada comando.
	if available, detail := t.Environments.Availability(ctx, environment); !available {
		return "", fmt.Errorf("o ambiente %s não está disponível: %s", environment, detail)
	}

	workdir, err := t.workdir(sessionID, args.CWD)
	if err != nil {
		return "", err
	}

	ctx, cancel := context.WithTimeout(ctx, procTimeout)
	defer cancel()

	result, err := runner.Run(ctx, workdir, args.Command)
	if err != nil {
		return "", fmt.Errorf("ambiente %s: %w", environment, err)
	}
	return formatProcResult(environment, result), nil
}

// workdir devolve a pasta a partir da qual o comando roda, confinada à raiz do
// projeto pelas mesmas três checagens das ferramentas de arquivo (texto,
// prefixo e symlink — ver resolveInside).
//
// Sem raiz de projeto o comando é RECUSADO em vez de rodar na pasta do
// processo, que é onde mora o binário do gateway. No ambiente local isto não
// aparece porque quem resolve o diretório é o host.
func (t *Toolbox) workdir(sessionID, relative string) (string, error) {
	root := t.root(sessionID)
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
