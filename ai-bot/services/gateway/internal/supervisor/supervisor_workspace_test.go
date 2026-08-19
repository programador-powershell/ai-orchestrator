// A migração das ferramentas para o workspace: o turno congela o plano e a
// ferramenta lê a execução do contexto — nenhuma calcula diretório sozinha.
//
// Este teste guarda a EMENDA da migração: os testes de ferramenta provam cada
// ferramenta com uma execução de mentira, e o pacote workspace prova o gerente
// — mas se o comWorkspace não pendurasse a execução no contexto do turno, tudo
// isso passaria e, em produção, todo fs.read recusaria em silêncio.
package supervisor

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"aibot/gateway/internal/store"
	"aibot/gateway/internal/workspace"
)

func TestTurnoPenduraOWorkspaceDaSessao(t *testing.T) {
	dataStore, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("abrir o store: %v", err)
	}
	defer dataStore.Close()

	// A pasta de projeto da sessão, com um arquivo dentro.
	projeto := t.TempDir()
	if err := os.WriteFile(filepath.Join(projeto, "leia.txt"), []byte("conteúdo do projeto"), 0o644); err != nil {
		t.Fatalf("preparar o projeto: %v", err)
	}
	const sessionID = "s-workspace"
	if _, err := dataStore.CreateSession(store.SessionMeta{ID: sessionID, CWD: projeto}); err != nil {
		t.Fatalf("criar sessão: %v", err)
	}

	registry := NewRegistry()
	(&Toolbox{}).Install(registry)
	supervisor := New(Deps{
		Store: dataStore,
		Tools: registry,
		Workspaces: workspace.NewManager(func(id string) string {
			meta, err := dataStore.GetSession(id)
			if err != nil {
				return ""
			}
			return meta.CWD
		}),
	})

	// O que o runTurn faz no começo — e o que a ferramenta enxerga na ponta.
	ctx := supervisor.comWorkspace(context.Background(), sessionID, "", "")

	execution, err := workspace.Require(ctx)
	if err != nil {
		t.Fatalf("o turno não pendurou a execução: %v", err)
	}
	if execution.Plan.WorkerID != workspace.LocalWorker || execution.Plan.LeaseEpoch != 1 {
		t.Fatalf("o plano v1 devia ser local/época 1: %s", execution.Plan)
	}

	args, _ := json.Marshal(map[string]string{"path": "leia.txt"})
	output, err := registry.Call(ctx, "fs.read", sessionID, args)
	if err != nil {
		t.Fatalf("fs.read pelo workspace: %v", err)
	}
	if !strings.Contains(output, "conteúdo do projeto") {
		t.Fatalf("a ferramenta não leu pela execução: %q", output)
	}

	// Sessão SEM pasta: o plano congela, a materialização produz root vazio e a
	// ferramenta recusa com motivo — nunca cai na pasta do processo.
	if _, err := dataStore.CreateSession(store.SessionMeta{ID: "s-sem-pasta"}); err != nil {
		t.Fatalf("criar sessão sem pasta: %v", err)
	}
	semPasta := supervisor.comWorkspace(context.Background(), "s-sem-pasta", "", "")
	if _, err := registry.Call(semPasta, "fs.read", "s-sem-pasta", args); err == nil {
		t.Fatal("sessão sem pasta de projeto tinha de recusar a leitura")
	}
}
