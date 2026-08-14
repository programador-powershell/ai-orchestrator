// Testes do portão de política no caminho de USO do modelo.
//
// O defeito que estes testes travam é o mesmo que já apareceu no app anterior
// com o `byokAllowed`: a política filtrava a LISTA e não a CHAMADA. Quem manda
// o id direto — conversa antiga, campo `model` do protocolo, caminho interno —
// não passa pela lista, então o portão precisa estar em `resolveExact`.
package modelrouter

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"aibot/gateway/internal/protocol"
)

// fakeKeys responde pelo cofre sem ter cofre nenhum.
type fakeKeys struct {
	present map[string]bool
}

func (k fakeKeys) Has(ref string) bool { return k.present[ref] }

func (k fakeKeys) Use(ref string, fn func(string) error) error {
	if !k.present[ref] {
		return fmt.Errorf("sem chave para %s", ref)
	}
	return fn("chave-de-mentira")
}

// collector junta o que o stream entregou.
type collector struct{ text strings.Builder }

func (c *collector) Delta(text string) error     { c.text.WriteString(text); return nil }
func (c *collector) Reasoning(text string) error { return nil }

// openAIStub é um provedor de mentira que responde uma linha de SSE. Existe
// para o caso POSITIVO: sem ele o teste do modelo liberado não distinguiria
// "passou pelo portão" de "falhou na rede".
func openAIStub(t *testing.T, answer string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		chunk, err := json.Marshal(map[string]any{
			"choices": []map[string]any{{"delta": map[string]any{"content": answer}}},
		})
		if err != nil {
			t.Errorf("montar o chunk: %v", err)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprintf(w, "data: %s\n\n", chunk)
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
}

// twoModelRouter monta um roteador com dois modelos do mesmo provedor
// habilitado — a diferença entre eles vem SÓ da política.
func twoModelRouter(base string) *Router {
	router := New(&http.Client{Timeout: 5 * time.Second}, nil)
	router.SetProviders([]Provider{
		{ID: "fake", Name: "Provedor de mentira", Kind: KindOpenAI, BaseURL: base, Enabled: true},
	})
	router.SetModels([]Entry{
		{Model: protocol.Model{ID: "liberado", Provider: "fake", Label: "Liberado"}, ProviderID: "fake", Default: true},
		{Model: protocol.Model{ID: "bloqueado", Provider: "fake", Label: "Bloqueado"}, ProviderID: "fake"},
	})
	return router
}

// Este é o teste que falha sem o portão em resolveExact: o provedor está
// habilitado, o modelo existe no catálogo e a política não o liberou. Antes da
// correção o Stream chamava o provedor assim mesmo.
func TestStreamRecusaModeloForaDaPolitica(t *testing.T) {
	stub := openAIStub(t, "não deveria responder")
	defer stub.Close()

	router := twoModelRouter(stub.URL)
	router.SetAllowed([]string{"liberado"})

	sink := &collector{}
	_, err := router.Stream(context.Background(), Request{
		Model:    "bloqueado",
		Messages: []ChatMessage{{Role: "user", Content: "oi"}},
	}, sink)
	if !errors.Is(err, ErrNoModel) {
		t.Fatalf("Stream em modelo fora da política: esperava ErrNoModel, obteve %v", err)
	}
	if sink.text.Len() != 0 {
		t.Fatalf("o provedor respondeu apesar da política: %q", sink.text.String())
	}
}

// Complete é o caminho do classificador e das ferramentas de provedor. Passa
// pelo mesmo Stream, e o teste existe para que uma otimização futura que o
// separe não perca o portão junto.
func TestCompleteRecusaModeloForaDaPolitica(t *testing.T) {
	stub := openAIStub(t, "não deveria responder")
	defer stub.Close()

	router := twoModelRouter(stub.URL)
	router.SetAllowed([]string{"liberado"})

	text, _, err := router.Complete(context.Background(), Request{
		Model:    "bloqueado",
		Messages: []ChatMessage{{Role: "user", Content: "oi"}},
	})
	if !errors.Is(err, ErrNoModel) {
		t.Fatalf("Complete em modelo fora da política: esperava ErrNoModel, obteve %v", err)
	}
	if text != "" {
		t.Fatalf("o provedor respondeu apesar da política: %q", text)
	}
}

// O contrapeso: o portão não pode recusar quem a política liberou.
func TestStreamAceitaModeloLiberado(t *testing.T) {
	stub := openAIStub(t, "resposta")
	defer stub.Close()

	router := twoModelRouter(stub.URL)
	router.SetAllowed([]string{"liberado"})

	sink := &collector{}
	if _, err := router.Stream(context.Background(), Request{
		Model:    "liberado",
		Messages: []ChatMessage{{Role: "user", Content: "oi"}},
	}, sink); err != nil {
		t.Fatalf("Stream no modelo liberado: %v", err)
	}
	if sink.text.String() != "resposta" {
		t.Fatalf("resposta perdida: %q", sink.text.String())
	}
}

// Lista vazia DECLARADA é a política dizendo "nenhum modelo". Sem a distinção
// entre nil e vazio, este teste passa a liberar o catálogo inteiro — que é o
// caso da estação gerenciada cujo catálogo só tem modelo local.
func TestSetAllowedListaVaziaNaoLiberaTudo(t *testing.T) {
	stub := openAIStub(t, "não deveria responder")
	defer stub.Close()

	router := twoModelRouter(stub.URL)
	router.SetAllowed([]string{})

	if catalog := router.Catalog(); len(catalog) != 0 {
		t.Fatalf("catálogo com política vazia: esperava nenhum modelo, obteve %v", catalog)
	}
	if _, err := router.Stream(context.Background(), Request{Model: "liberado"}, &collector{}); !errors.Is(err, ErrNoModel) {
		t.Fatalf("Stream com política vazia: esperava ErrNoModel, obteve %v", err)
	}

	// nil é o outro caso: política não configurada libera tudo.
	router.SetAllowed(nil)
	if catalog := router.Catalog(); len(catalog) != 2 {
		t.Fatalf("catálogo sem política: esperava os 2 modelos, obteve %v", catalog)
	}
}

// Chave ausente é indisponibilidade, não permissão: sem o portão em
// resolveExact o turno saía para o provedor sem `Authorization` e voltava 401,
// que é a mesma recusa contada de um jeito que ninguém entende.
func TestStreamRecusaProvedorSemChave(t *testing.T) {
	stub := openAIStub(t, "não deveria responder")
	defer stub.Close()

	router := New(&http.Client{Timeout: 5 * time.Second}, fakeKeys{present: map[string]bool{}})
	router.SetProviders([]Provider{
		{ID: "fake", Kind: KindOpenAI, BaseURL: stub.URL, SecretRef: "provider:fake", Enabled: true},
	})
	router.SetModels([]Entry{
		{Model: protocol.Model{ID: "modelo", Provider: "fake", Label: "Modelo"}, ProviderID: "fake"},
	})

	if _, err := router.Stream(context.Background(), Request{Model: "modelo"}, &collector{}); !errors.Is(err, ErrNoModel) {
		t.Fatalf("Stream sem chave no cofre: esperava ErrNoModel, obteve %v", err)
	}
}

// Provedor desligado continua recusando — o comportamento antigo não pode ter
// sumido junto com a correção.
func TestStreamRecusaProvedorDesabilitado(t *testing.T) {
	router := twoModelRouter("http://127.0.0.1:1")
	router.SetProviders([]Provider{
		{ID: "fake", Kind: KindOpenAI, BaseURL: "http://127.0.0.1:1", Enabled: false},
	})

	if _, err := router.Stream(context.Background(), Request{Model: "liberado"}, &collector{}); !errors.Is(err, ErrNoModel) {
		t.Fatalf("Stream com provedor desligado: esperava ErrNoModel, obteve %v", err)
	}
}
