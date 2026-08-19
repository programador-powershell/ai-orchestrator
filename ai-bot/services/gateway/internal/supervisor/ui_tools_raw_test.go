// A interface recebe o INTEGRAL — a projeção é da janela do modelo.
//
// O defeito que este teste mata era GRAVE: fs.read entre 12 KiB e 512 KiB
// voltava à rota como projeção (início + "[… omitidos …]" + fim), o editor
// abria o arquivo CORROMPIDO, e salvar gravaria o picote por cima do real.
package supervisor

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"aibot/gateway/internal/eventbus"
	"aibot/gateway/internal/permissions"
	"aibot/gateway/internal/store"
	"aibot/gateway/internal/workspace"
)

func TestCallToolFromUIDevolveOIntegralDeSaidaGrande(t *testing.T) {
	dataStore, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("abrir o store: %v", err)
	}
	defer dataStore.Close()

	projeto := t.TempDir()
	// 60 KiB: bem acima do teto inline de 12 KiB do Tool Output Gateway e bem
	// abaixo do maxReadBytes do fs.read — a faixa exata do defeito.
	conteudo := strings.Repeat("linha de código que não pode se perder\n", 1500)
	if err := os.WriteFile(filepath.Join(projeto, "grande.ts"), []byte(conteudo), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := dataStore.CreateSession(store.SessionMeta{ID: "s1", Title: "t", CWD: projeto, Specialist: "code"}); err != nil {
		t.Fatal(err)
	}

	registry := NewRegistry()
	(&Toolbox{Artifacts: dataStore}).Install(registry)
	supervisor := New(Deps{
		Store: dataStore,
		Bus:   eventbus.New(dataStore),
		Gate:  permissions.NewGate(permissions.DefaultPolicy()),
		Tools: registry,
		Workspaces: workspace.NewManager(func(id string) string {
			meta, err := dataStore.GetSession(id)
			if err != nil {
				return ""
			}
			return meta.CWD
		}),
	})

	args, _ := json.Marshal(map[string]string{"path": "grande.ts"})
	resultado, err := supervisor.CallToolFromUI(context.Background(), "s1", "fs.read", args)
	if err != nil {
		t.Fatalf("chamada: %v", err)
	}
	if !resultado.OK {
		t.Fatalf("fs.read falhou: %s", resultado.Error)
	}
	if resultado.Output != conteudo {
		t.Fatalf("a interface não recebeu o INTEGRAL: %d bytes de %d, começo %q",
			len(resultado.Output), len(conteudo), resultado.Output[:80])
	}
	if strings.Contains(resultado.Output, "omitidos") {
		t.Fatal("a projeção vazou para a interface")
	}

	// E o LOG continua com a projeção — a janela do modelo não paga o dump.
	envelopes, _ := dataStore.Since("s1", 0, 1000)
	projetado := false
	for _, envelope := range envelopes {
		if envelope.Kind == "tool.result" && strings.Contains(string(envelope.Payload), "artifact://") {
			projetado = true
		}
	}
	if !projetado {
		t.Fatal("o log devia guardar a projeção com a referência do artefato")
	}
}
