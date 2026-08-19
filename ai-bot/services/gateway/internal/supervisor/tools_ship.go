// As ferramentas de publicação: detecção de stack e geração de Dockerfile.
//
// São o começo do "publicar" que o openship dava: antes de subir qualquer
// coisa, o especialista precisa saber O QUE o projeto é (ship.detect) e COMO
// ele vira container (ship.dockerfile). As duas ficam no gateway porque são
// leitura de árvore e função pura de string — nada aqui precisa da máquina,
// e um servidor sem interface publica igual.
package supervisor

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"aibot/gateway/internal/ship"
)

// installShipTools registra a dupla de publicação.
func (t *Toolbox) installShipTools(registry *Registry) {
	registry.Register("ship.detect",
		"identifica a stack do projeto (framework, porta, pasta de saída). args: {path?}", t.shipDetect)
	registry.Register("ship.dockerfile",
		"gera o Dockerfile de publicação da stack detectada ou informada. args: {stack?, path?}", t.shipDockerfile)
}

func (t *Toolbox) shipDetect(ctx context.Context, sessionID string, raw json.RawMessage) (string, error) {
	var args struct {
		Path string `json:"path"`
	}
	if err := decodeArgs(raw, &args); err != nil {
		return "", err
	}
	// O mesmo confinamento das ferramentas de arquivo: detectar stack fora da
	// pasta do projeto seria ler o disco da pessoa com outro nome.
	root, err := resolveInside(t.root(ctx), args.Path)
	if err != nil {
		return "", err
	}
	matches, err := ship.Detect(root)
	if err != nil {
		return "", err
	}
	if len(matches) == 0 {
		// Resultado legítimo, não recusa: a varredura RODOU e nada casou. O
		// texto diz o que fazer a seguir em vez de devolver lista vazia muda.
		return "nenhuma stack conhecida foi detectada — confira se o caminho aponta para a RAIZ " +
			"do projeto (onde ficam package.json, go.mod, Gemfile…) ou informe a stack " +
			"explicitamente em ship.dockerfile {stack}", nil
	}
	lines := make([]string, 0, len(matches))
	for position, match := range matches {
		lines = append(lines, fmt.Sprintf("%d. %s (%s) — evidência: %s — confiança %.2f — porta %d, saída %s",
			position+1, match.Stack.Name, match.ID, match.Evidence, match.Confidence,
			match.Stack.DefaultPort, match.Stack.OutputDirectory))
	}
	return strings.Join(lines, "\n"), nil
}

func (t *Toolbox) shipDockerfile(ctx context.Context, sessionID string, raw json.RawMessage) (string, error) {
	var args struct {
		Stack string `json:"stack"`
		Path  string `json:"path"`
	}
	if err := decodeArgs(raw, &args); err != nil {
		return "", err
	}

	var stack ship.Stack
	header := ""
	if args.Stack != "" {
		found, ok := ship.StackByID(args.Stack)
		if !ok {
			// A recusa lista o caminho de saída: ou o id certo, ou a detecção.
			return "", fmt.Errorf("a stack %q não existe no registro — use ship.detect para "+
				"descobrir a do projeto, ou um id conhecido (ex.: nextjs, go, rails, laravel, dotnet)",
				args.Stack)
		}
		stack = found
	} else {
		root, err := resolveInside(t.root(ctx), args.Path)
		if err != nil {
			return "", err
		}
		matches, err := ship.Detect(root)
		if err != nil {
			return "", err
		}
		if len(matches) == 0 {
			return "", fmt.Errorf("nenhuma stack foi detectada no projeto — informe {stack} " +
				"explicitamente (ex.: nextjs, go, rails) ou aponte {path} para a raiz onde " +
				"ficam os manifestos")
		}
		best := matches[0]
		stack = best.Stack
		header = fmt.Sprintf("# stack detectada: %s (%s) — evidência: %s\n", best.Stack.Name, best.ID, best.Evidence)
	}

	// Os comandos padrão do registro: o install vem da linguagem (a origem
	// preenchia isso no fluxo de deploy) e o build vem da stack. Quem precisar
	// de comando diferente edita o arquivo gerado — ele é texto, não contrato.
	output, err := ship.Dockerfile(stack, ship.Options{
		InstallCommand: ship.DefaultInstallCommand(stack),
		BuildCommand:   stack.DefaultBuildCommand,
	})
	if err != nil {
		return "", err
	}
	return header + output, nil
}
