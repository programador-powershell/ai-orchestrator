// Testes das ferramentas que falam com o provedor.
//
// O provedor é um httptest em loopback: o que se testa aqui não é HTTP, é o que
// a ferramenta FAZ com a resposta — grava no lugar certo, devolve caminho
// relativo, recusa caminho local e não deixa a chave voltar no texto.
package supervisor

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"aibot/gateway/internal/modelrouter"
	"aibot/gateway/internal/protocol"
)

// providerRouter monta um roteador apontado para o servidor de mentira. Sem
// cofre: provedor sem SecretRef não exige chave, e o que está sob teste é o
// tratamento da resposta.
func providerRouter(base string) *modelrouter.Router {
	router := modelrouter.New(http.DefaultClient, nil)
	router.SetProviders([]modelrouter.Provider{
		{ID: "openai", Kind: modelrouter.KindOpenAI, BaseURL: base, Enabled: true},
	})
	router.SetModels([]modelrouter.Entry{
		{Model: protocol.Model{ID: "gpt-image-1", Provider: "openai", Label: "Imagem",
			Skills: []string{"image", "finetune"}}, ProviderID: "openai"},
	})
	return router
}

func TestImageGenerateGravaNoProjeto(t *testing.T) {
	png := append([]byte("\x89PNG\r\n\x1a\n"), []byte("recheio")...)
	encoded := base64.StdEncoding.EncodeToString(png)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/images/generations" {
			t.Errorf("caminho inesperado: %s", r.URL.Path)
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if count, _ := body["n"].(float64); count != 2 {
			t.Errorf("n esperado 2, veio %v", body["n"])
		}
		_, _ = w.Write([]byte(`{"data":[{"b64_json":"` + encoded + `"},{"b64_json":"` + encoded + `"}]}`))
	}))
	defer server.Close()

	root := t.TempDir()
	box := &Toolbox{Root: func(string) string { return root }, Models: providerRouter(server.URL)}

	out, err := box.imageGenerate(context.Background(), "s1",
		json.RawMessage(`{"prompt":"um gato","count":2}`))
	if err != nil {
		t.Fatalf("gerar: %v", err)
	}
	entries, err := os.ReadDir(filepath.Join(root, ".aibot", "imagens"))
	if err != nil {
		t.Fatalf("ler pasta: %v", err)
	}
	if len(entries) != 2 {
		t.Fatalf("esperava 2 arquivos, vieram %d", len(entries))
	}
	// O caminho devolvido é relativo: o absoluto entregaria ao modelo a
	// estrutura de disco de quem está usando o app.
	if !strings.Contains(out, ".aibot/imagens/imagem-") {
		t.Fatalf("saída sem caminho relativo:\n%s", out)
	}
	if strings.Contains(out, encoded) {
		t.Fatalf("a imagem voltou em base64 para dentro do prompt")
	}
}

func TestImageGenerateRecusas(t *testing.T) {
	box := &Toolbox{Root: func(string) string { return t.TempDir() }, Models: providerRouter("http://127.0.0.1:1")}

	if _, err := box.imageGenerate(context.Background(), "s1", json.RawMessage(`{"prompt":" "}`)); err == nil {
		t.Fatal("prompt vazio devia recusar")
	}
	if _, err := box.imageGenerate(context.Background(), "s1",
		json.RawMessage(`{"prompt":"x","count":9}`)); err == nil {
		t.Fatal("count acima do teto devia recusar, não ser cortado em silêncio")
	}

	semRoteador := &Toolbox{Root: func(string) string { return t.TempDir() }}
	if _, err := semRoteador.imageGenerate(context.Background(), "s1",
		json.RawMessage(`{"prompt":"x"}`)); err == nil {
		t.Fatal("sem roteador devia recusar com motivo")
	}
}

func TestFinetuneSubmitRecusaCaminhoLocal(t *testing.T) {
	box := &Toolbox{Root: func(string) string { return t.TempDir() }, Models: providerRouter("http://127.0.0.1:1")}

	for _, candidate := range []string{"./dados/treino.jsonl", "treino.jsonl", `C:\dados\treino.jsonl`, "/tmp/t.json"} {
		args := json.RawMessage(`{"model":"gpt-4o-mini","trainingFile":"` +
			strings.ReplaceAll(candidate, `\`, `\\`) + `"}`)
		_, err := box.finetuneSubmit(context.Background(), "s1", args)
		if err == nil {
			t.Fatalf("%q passou como id de arquivo do provedor", candidate)
		}
		// A recusa precisa dizer o que fazer no lugar; um "não posso" seco faz
		// o modelo tentar de novo com o mesmo caminho.
		if !strings.Contains(err.Error(), "id") {
			t.Fatalf("recusa sem saída acionável para %q: %v", candidate, err)
		}
	}
}

func TestFinetuneStatusNaoEcoaChave(t *testing.T) {
	// A chave PARCIAL vem dentro de um job que falhou — e esse job chega com
	// HTTP 200. Status 2xx não torna o conteúdo do provedor confiável.
	const vazamento = "sk-abcdefghijklmnopqrstuvwx"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/ftjob-1") {
			t.Errorf("caminho inesperado: %s", r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"id":"ftjob-1","model":"gpt-4o-mini","status":"failed","created_at":1755000000,` +
			`"error":{"message":"Incorrect API key provided: ` + vazamento + `"}}`))
	}))
	defer server.Close()

	box := &Toolbox{Root: func(string) string { return t.TempDir() }, Models: providerRouter(server.URL)}
	out, err := box.finetuneStatus(context.Background(), "s1", json.RawMessage(`{"jobId":"ftjob-1"}`))
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if strings.Contains(out, vazamento) {
		t.Fatalf("a chave ecoada pelo provedor saiu no texto do modelo:\n%s", out)
	}
	if !strings.Contains(out, "failed") {
		t.Fatalf("o estado do treino sumiu junto com a limpeza:\n%s", out)
	}
}

func TestFinetuneStatusResume(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.RawQuery != "limit=20" {
			t.Errorf("listagem sem limite: %s", r.URL.RawQuery)
		}
		_, _ = w.Write([]byte(`{"data":[{"id":"ftjob-1","model":"gpt-4o-mini","status":"succeeded",` +
			`"created_at":1755000000,"fine_tuned_model":"ft:gpt-4o-mini:acme"}]}`))
	}))
	defer server.Close()

	box := &Toolbox{Root: func(string) string { return t.TempDir() }, Models: providerRouter(server.URL)}
	out, err := box.finetuneStatus(context.Background(), "s1", nil)
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	for _, needle := range []string{"ftjob-1", "gpt-4o-mini", "succeeded", "2025-08-12", "ft:gpt-4o-mini:acme"} {
		if !strings.Contains(out, needle) {
			t.Fatalf("o resumo não traz %q:\n%s", needle, out)
		}
	}
}

func TestFinetuneStatusIDInvalido(t *testing.T) {
	box := &Toolbox{Root: func(string) string { return t.TempDir() }, Models: providerRouter("http://127.0.0.1:1")}
	// O id entra no CAMINHO da URL; deixar passar "../" trocaria a rota chamada
	// com a chave do provedor no cabeçalho.
	if _, err := box.finetuneStatus(context.Background(), "s1",
		json.RawMessage(`{"jobId":"../../models"}`)); err == nil {
		t.Fatal("id com barra devia ser recusado")
	}
}

func TestLooksLikePath(t *testing.T) {
	for _, value := range []string{"file-abc123", "ftjob-9", "abc"} {
		if looksLikePath(value) {
			t.Fatalf("%q é id de arquivo e foi tratado como caminho", value)
		}
	}
	for _, value := range []string{"dados/treino.jsonl", `..\treino.csv`, "~/treino.json", "D:treino"} {
		if !looksLikePath(value) {
			t.Fatalf("%q é caminho e passou como id", value)
		}
	}
}
