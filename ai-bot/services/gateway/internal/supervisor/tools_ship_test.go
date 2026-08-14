// Testes das ferramentas de publicação.
//
// O que importa no nível da ferramenta não é a detecção em si (o pacote ship
// já a testa): é o CONTRATO com o modelo — confinamento à pasta da sessão,
// recusa com motivo acionável e nunca um sucesso vazio.
package supervisor

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func shipToolbox(t *testing.T) (*Registry, string) {
	t.Helper()
	root := t.TempDir()
	registry := NewRegistry()
	toolbox := &Toolbox{Root: func(string) string { return root }}
	toolbox.installShipTools(registry)
	return registry, root
}

func writeProjectFile(t *testing.T, root, relative, content string) {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(relative))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("criar pasta de %s: %v", relative, err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("gravar %s: %v", relative, err)
	}
}

func TestShipDetectReportsTheProjectStack(t *testing.T) {
	registry, root := shipToolbox(t)
	writeProjectFile(t, root, "package.json", `{"name":"x","dependencies":{"next":"15"}}`)
	writeProjectFile(t, root, "next.config.js", "module.exports = {}")

	output, err := registry.Call(context.Background(), "ship.detect", "s1", nil)
	if err != nil {
		t.Fatalf("ship.detect: %v", err)
	}
	if !strings.Contains(output, "Next.js") || !strings.Contains(output, "next.config.js") {
		t.Errorf("o relatório não diz a stack nem a evidência:\n%s", output)
	}
}

func TestShipDetectSaysWhatToDoWhenNothingMatches(t *testing.T) {
	registry, root := shipToolbox(t)
	writeProjectFile(t, root, "notas.md", "só texto")

	output, err := registry.Call(context.Background(), "ship.detect", "s1", nil)
	if err != nil {
		t.Fatalf("nada detectado não é erro de ferramenta: %v", err)
	}
	// Nunca sucesso vazio: a resposta orienta o próximo passo.
	if !strings.Contains(output, "nenhuma stack") || !strings.Contains(output, "ship.dockerfile") {
		t.Errorf("a resposta não orienta o que fazer:\n%s", output)
	}
}

func TestShipDetectStaysInsideTheProject(t *testing.T) {
	registry, _ := shipToolbox(t)
	args, _ := json.Marshal(map[string]string{"path": "../fora"})
	if _, err := registry.Call(context.Background(), "ship.detect", "s1", args); err == nil {
		t.Fatal("caminho fora do projeto foi aceito")
	}
}

func TestShipDetectRefusesSessionWithoutRoot(t *testing.T) {
	registry := NewRegistry()
	toolbox := &Toolbox{Root: func(string) string { return "" }}
	toolbox.installShipTools(registry)
	if _, err := registry.Call(context.Background(), "ship.detect", "s1", nil); err == nil {
		t.Fatal("sessão sem pasta de projeto deveria recusar com motivo")
	}
}

func TestShipDockerfileByExplicitStack(t *testing.T) {
	registry, _ := shipToolbox(t)
	args, _ := json.Marshal(map[string]string{"stack": "nextjs"})
	output, err := registry.Call(context.Background(), "ship.dockerfile", "s1", args)
	if err != nil {
		t.Fatalf("ship.dockerfile: %v", err)
	}
	if !strings.Contains(output, "FROM node:22") {
		t.Errorf("faltou a imagem do Node:\n%s", output)
	}
	if !strings.Contains(output, `CMD ["sh", "-c", "next start"]`) {
		t.Errorf("faltou o CMD do Next:\n%s", output)
	}
	// O install padrão da linguagem entra para o build compilar de verdade.
	if !strings.Contains(output, "npm install") {
		t.Errorf("faltou o passo de install:\n%s", output)
	}
}

func TestShipDockerfileDetectsWhenStackIsOmitted(t *testing.T) {
	registry, root := shipToolbox(t)
	writeProjectFile(t, root, "go.mod", "module exemplo\n\ngo 1.22\n")

	output, err := registry.Call(context.Background(), "ship.dockerfile", "s1", nil)
	if err != nil {
		t.Fatalf("ship.dockerfile: %v", err)
	}
	if !strings.Contains(output, "# stack detectada: Go (go)") {
		t.Errorf("o cabeçalho não diz o que foi detectado:\n%s", output)
	}
	if !strings.Contains(output, "FROM golang:1.22-alpine AS builder") {
		t.Errorf("faltou o estágio de build do Go:\n%s", output)
	}
}

func TestShipDockerfileRefusesUnknownStackWithGuidance(t *testing.T) {
	registry, _ := shipToolbox(t)
	args, _ := json.Marshal(map[string]string{"stack": "cobol-on-rails"})
	_, err := registry.Call(context.Background(), "ship.dockerfile", "s1", args)
	if err == nil {
		t.Fatal("stack inexistente foi aceita")
	}
	if !strings.Contains(err.Error(), "ship.detect") {
		t.Errorf("a recusa não aponta a saída (ship.detect): %v", err)
	}
}

func TestShipDockerfileRefusesWhenNothingIsDetected(t *testing.T) {
	registry, root := shipToolbox(t)
	writeProjectFile(t, root, "leia-me.txt", "nada aqui")

	_, err := registry.Call(context.Background(), "ship.dockerfile", "s1", nil)
	if err == nil {
		t.Fatal("sem stack e sem detecção deveria recusar com motivo")
	}
	if !strings.Contains(err.Error(), "{stack}") {
		t.Errorf("a recusa não diz como destravar: %v", err)
	}
}
