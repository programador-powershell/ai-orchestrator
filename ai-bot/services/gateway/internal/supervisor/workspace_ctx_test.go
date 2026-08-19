package supervisor

import (
	"context"

	"aibot/gateway/internal/workspace"
)

// ctxComRoot pendura no contexto uma execução v1 apontando para a pasta — é o
// que o supervisor faz no começo de cada turno (comWorkspace). Os testes de
// ferramenta usam isto no lugar do antigo Toolbox.Root: a ferramenta não
// calcula diretório, ela recebe a execução pronta.
func ctxComRoot(root string) context.Context {
	return workspace.WithExecution(context.Background(), &workspace.Execution{LocalRoot: root})
}
