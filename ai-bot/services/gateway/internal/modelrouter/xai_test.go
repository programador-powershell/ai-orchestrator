package modelrouter

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"aibot/gateway/internal/protocol"
)

type xaiKeys struct{ value string }

func (k xaiKeys) Has(ref string) bool { return ref == "provider:xai" && k.value != "" }
func (k xaiKeys) Use(ref string, fn func(string) error) error {
	if !k.Has(ref) {
		return fmt.Errorf("sem chave para %s", ref)
	}
	return fn(k.value)
}

type xaiSink struct {
	answer    strings.Builder
	reasoning strings.Builder
}

func (s *xaiSink) Delta(text string) error     { s.answer.WriteString(text); return nil }
func (s *xaiSink) Reasoning(text string) error { s.reasoning.WriteString(text); return nil }

func registerXAIAdapter(t *testing.T, router *Router) {
	t.Helper()
	if _, err := router.RegisterAdapter("test:grok", KindXAI, AdapterOptions{
		Protocol: ProtocolOpenAI, ConversationHeader: "x-grok-conv-id", ImageProtocol: ProtocolOpenAI,
	}); err != nil {
		t.Fatal(err)
	}
}

func TestXAIStreamsChatWithBearerAndConversationAffinity(t *testing.T) {
	const key = "xai-chave-de-teste"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/completions" {
			t.Errorf("rota = %q, esperava /chat/completions", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer "+key {
			t.Errorf("Authorization = %q", got)
		}
		if got := r.Header.Get("x-grok-conv-id"); got != "sessao-42" {
			t.Errorf("x-grok-conv-id = %q", got)
		}

		var body struct {
			Model  string `json:"model"`
			Stream bool   `json:"stream"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("corpo ilegível: %v", err)
		}
		if body.Model != "grok-4.5" || !body.Stream {
			t.Errorf("corpo inesperado: %+v", body)
		}

		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"checando\"}}]}\n\n")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"pronto\"},\"finish_reason\":\"stop\"}]}\n\n")
		fmt.Fprint(w, "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":3}}\n\n")
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer server.Close()

	router := New(server.Client(), xaiKeys{value: key})
	registerXAIAdapter(t, router)
	router.SetProviders([]Provider{{
		ID: "xai", Kind: KindXAI, BaseURL: server.URL, SecretRef: "provider:xai", Enabled: true,
	}})
	router.SetModels([]Entry{{
		Model: protocol.Model{ID: "grok-4.5", Provider: "xai", Label: "Grok 4.5"}, ProviderID: "xai",
	}})

	sink := &xaiSink{}
	usage, err := router.Stream(context.Background(), Request{
		Model: "grok-4.5", Messages: []ChatMessage{{Role: "user", Content: "oi"}}, ConversationID: "sessao-42",
	}, sink)
	if err != nil {
		t.Fatalf("stream xAI: %v", err)
	}
	if sink.answer.String() != "pronto" || sink.reasoning.String() != "checando" {
		t.Fatalf("stream separado incorretamente: resposta=%q raciocínio=%q",
			sink.answer.String(), sink.reasoning.String())
	}
	if usage.PromptTokens != 7 || usage.OutputTokens != 3 {
		t.Fatalf("uso perdido: %+v", usage)
	}
}

func TestXAIGeneratesImagineImage(t *testing.T) {
	const key = "xai-chave-de-imagem"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/images/generations" {
			t.Errorf("rota = %q", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer "+key {
			t.Errorf("Authorization = %q", got)
		}
		var body openAIImageRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("corpo ilegível: %v", err)
		}
		if body.Model != "grok-imagine-image-quality" || body.Prompt != "um robô brasileiro" || body.N != 1 {
			t.Errorf("pedido de imagem inesperado: %+v", body)
		}
		fmt.Fprint(w, `{"data":[{"url":"https://imgen.x.ai/resultado.jpeg"}]}`)
	}))
	defer server.Close()

	router := New(server.Client(), xaiKeys{value: key})
	registerXAIAdapter(t, router)
	router.SetProviders([]Provider{{
		ID: "xai", Kind: KindXAI, BaseURL: server.URL, SecretRef: "provider:xai", Enabled: true,
	}})
	router.SetModels([]Entry{{
		Model: protocol.Model{
			ID: "grok-imagine-image-quality", Provider: "xai", Label: "Grok Imagine", Skills: []string{"image"},
		},
		ProviderID: "xai",
	}})

	result, err := router.GenerateImage(context.Background(), ImageRequest{Prompt: "um robô brasileiro"})
	if err != nil {
		t.Fatalf("gerar imagem xAI: %v", err)
	}
	if result.Model != "grok-imagine-image-quality" || len(result.Images) != 1 ||
		result.Images[0].URL != "https://imgen.x.ai/resultado.jpeg" {
		t.Fatalf("resultado inesperado: %+v", result)
	}
}
