// O Tool Output Gateway e a recuperação sob demanda, de ponta a ponta.
package supervisor

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"aibot/gateway/internal/store"
)

func gatewayHarness(t *testing.T) (*Supervisor, *store.Store) {
	t.Helper()
	dataStore, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("abrir o store: %v", err)
	}
	t.Cleanup(func() { _ = dataStore.Close() })
	if _, err := dataStore.CreateSession(store.SessionMeta{ID: "s1", Title: "t"}); err != nil {
		t.Fatalf("criar sessão: %v", err)
	}
	return New(Deps{Store: dataStore}), dataStore
}

// Saída pequena passa INTACTA: o gateway só existe para o que não cabe.
func TestProjecaoDeixaSaidaPequenaEmPaz(t *testing.T) {
	supervisor, _ := gatewayHarness(t)

	projected, ref, raw, truncated := supervisor.projectToolOutput("s1", "fs.read", "conteúdo curto")
	if projected != "conteúdo curto" || ref != "" || truncated || raw != len("conteúdo curto") {
		t.Fatalf("saída pequena foi mexida: %q ref=%q raw=%d trunc=%v", projected, ref, raw, truncated)
	}
}

// Saída grande vira artefato + projeção início/fim — e o modelo recebe a
// instrução de como pedir o resto. É o "4 MB nunca entram no prompt" da
// especificação.
func TestProjecaoGuardaOIntegralEProjeta(t *testing.T) {
	supervisor, dataStore := gatewayHarness(t)

	comeco := "PRIMEIRA LINHA DO BUILD\n"
	fim := "\nERRO FINAL: faltou o pacote X"
	saida := comeco + strings.Repeat("linha intermediária de log\n", 3000) + fim

	projected, ref, raw, truncated := supervisor.projectToolOutput("s1", "proc.run", saida)
	if !truncated || ref == "" || raw != len(saida) {
		t.Fatalf("a saída grande tinha de ser projetada: ref=%q raw=%d trunc=%v", ref, raw, truncated)
	}
	if len(projected) >= len(saida)/2 {
		t.Fatalf("a projeção não encolheu de verdade: %d de %d bytes", len(projected), len(saida))
	}
	// Começo e FIM sobrevivem — em proc.run o erro final mora no fim.
	if !strings.Contains(projected, "PRIMEIRA LINHA") || !strings.Contains(projected, "ERRO FINAL") {
		t.Fatalf("a projeção perdeu as pontas:\n%s", projected[:400])
	}
	if !strings.Contains(projected, ref) || !strings.Contains(projected, "context.fetch") {
		t.Fatal("a projeção não ensina a pedir o resto")
	}

	// O integral é recuperável em fatias.
	cauda, total, err := dataStore.ReadArtifact("s1", ref, -len(fim), 1000)
	if err != nil || total != len(saida) || cauda != fim {
		t.Fatalf("o integral não voltou do artefato: %q total=%d err=%v", cauda, total, err)
	}
}

// A ferramenta context.fetch fecha o ciclo: o MODELO pede a fatia.
func TestContextFetchLeAFatia(t *testing.T) {
	_, dataStore := gatewayHarness(t)
	ref, err := dataStore.SaveArtifact("s1", "proc.run", []byte("0123456789"))
	if err != nil {
		t.Fatal(err)
	}

	registry := NewRegistry()
	(&Toolbox{Artifacts: dataStore}).Install(registry)

	args, _ := json.Marshal(map[string]any{"ref": ref, "offset": 2, "maxBytes": 4})
	output, err := registry.Call(ctxComRoot(""), "context.fetch", "s1", args)
	if err != nil {
		t.Fatalf("context.fetch: %v", err)
	}
	if !strings.Contains(output, "2345") || !strings.Contains(output, "de 10") {
		t.Fatalf("fatia errada: %q", output)
	}

	// Sem referência, recusa com exemplo — não com silêncio.
	if _, err := registry.Call(ctxComRoot(""), "context.fetch", "s1", json.RawMessage(`{}`)); err == nil {
		t.Fatal("faltou recusar a chamada sem ref")
	}
}

// fs.read por FAIXA: sessenta linhas certas em vez do arquivo inteiro.
func TestFsReadPorFaixa(t *testing.T) {
	root := t.TempDir()
	linhas := make([]string, 0, 100)
	for index := 1; index <= 100; index++ {
		linhas = append(linhas, fmt.Sprintf("linha %d", index))
	}
	writeProjectFile(t, root, "grande.txt", strings.Join(linhas, "\n"))

	registry := NewRegistry()
	(&Toolbox{}).Install(registry)

	args, _ := json.Marshal(map[string]any{"path": "grande.txt", "offset": 40, "limit": 3})
	output, err := registry.Call(ctxComRoot(root), "fs.read", "s1", args)
	if err != nil {
		t.Fatalf("fs.read por faixa: %v", err)
	}
	if !strings.Contains(output, "linhas 40-42 de 100") ||
		!strings.Contains(output, "linha 40") || strings.Contains(output, "linha 43") {
		t.Fatalf("faixa errada:\n%s", output)
	}

	// Sem faixa continua sendo o arquivo inteiro — o comportamento de sempre.
	inteiro, err := registry.Call(ctxComRoot(root), "fs.read", "s1",
		json.RawMessage(`{"path":"grande.txt"}`))
	if err != nil || !strings.Contains(inteiro, "linha 1") || !strings.Contains(inteiro, "linha 100") {
		t.Fatalf("a leitura inteira mudou: %v", err)
	}
}
