// Testes da leitura da resposta de imagem.
//
// São puros de propósito — sem rede, sem servidor de mentira. O que quebra
// nesse caminho não é o HTTP, é o FORMATO: o provedor troca `url` por
// `b64_json` conforme o modelo, o Gemini responde noutra chave, e um corpo de
// erro chega com 200 em alguns compatíveis. Testar isso com rede testaria o
// net/http da padrão.
package modelrouter

import (
	"context"
	"encoding/base64"
	"errors"
	"strings"
	"testing"
)

// pngBytes é um PNG mínimo: assinatura de 8 bytes mais recheio. Basta para o
// detector da padrão reconhecer o tipo, que é o que o teste verifica.
func pngBytes() []byte {
	return append([]byte("\x89PNG\r\n\x1a\n"), []byte("\x00\x00\x00\rIHDR-conteudo")...)
}

func TestDecodeOpenAIImagesURL(t *testing.T) {
	payload := []byte(`{"created":1,"data":[{"url":"https://cdn.exemplo/img-1.png"},` +
		`{"url":"https://cdn.exemplo/img-2.png"}]}`)

	images, err := decodeOpenAIImages(payload)
	if err != nil {
		t.Fatalf("decodificar: %v", err)
	}
	if len(images) != 2 {
		t.Fatalf("esperava 2 imagens, veio %d", len(images))
	}
	if images[0].URL != "https://cdn.exemplo/img-1.png" {
		t.Fatalf("url perdida: %q", images[0].URL)
	}
	if len(images[0].Bytes) != 0 {
		t.Fatalf("url não deve virar bytes inventados")
	}
}

func TestDecodeOpenAIImagesBase64(t *testing.T) {
	raw := pngBytes()
	payload := []byte(`{"data":[{"b64_json":"` + base64.StdEncoding.EncodeToString(raw) + `"}]}`)

	images, err := decodeOpenAIImages(payload)
	if err != nil {
		t.Fatalf("decodificar: %v", err)
	}
	if len(images) != 1 {
		t.Fatalf("esperava 1 imagem, veio %d", len(images))
	}
	if string(images[0].Bytes) != string(raw) {
		t.Fatalf("bytes não bateram")
	}
	// O tipo sai do CONTEÚDO, não do que o provedor disse: é ele que vira
	// extensão no disco.
	if images[0].Mime != "image/png" {
		t.Fatalf("tipo esperado image/png, veio %q", images[0].Mime)
	}
}

func TestDecodeGeminiImagesBase64(t *testing.T) {
	raw := pngBytes()
	payload := []byte(`{"predictions":[{"mimeType":"image/jpeg","bytesBase64Encoded":"` +
		base64.StdEncoding.EncodeToString(raw) + `"},{"bytesBase64Encoded":"` +
		base64.StdEncoding.EncodeToString(raw) + `"}]}`)

	images, err := decodeGeminiImages(payload)
	if err != nil {
		t.Fatalf("decodificar: %v", err)
	}
	if len(images) != 2 {
		t.Fatalf("esperava 2 imagens, veio %d", len(images))
	}
	// Quando o provedor DIZ o tipo, ele vale; quando cala, o conteúdo decide.
	if images[0].Mime != "image/jpeg" {
		t.Fatalf("tipo declarado ignorado: %q", images[0].Mime)
	}
	if images[1].Mime != "image/png" {
		t.Fatalf("tipo esperado image/png por conteúdo, veio %q", images[1].Mime)
	}
	if string(images[1].Bytes) != string(raw) {
		t.Fatalf("bytes não bateram")
	}
}

func TestDecodeImagesCorpoMalformado(t *testing.T) {
	cases := []struct {
		name    string
		payload string
		decode  func([]byte) ([]GeneratedImage, error)
	}{
		{"openai json quebrado", `{"data":[{"url":`, decodeOpenAIImages},
		{"openai sem imagem", `{"data":[]}`, decodeOpenAIImages},
		{"openai base64 sujo", `{"data":[{"b64_json":"não-é-base64!!"}]}`, decodeOpenAIImages},
		{"openai erro com 200", `{"error":{"message":"conteúdo recusado pela política"}}`, decodeOpenAIImages},
		{"gemini json quebrado", `{"predictions":`, decodeGeminiImages},
		{"gemini sem imagem", `{"predictions":[{"mimeType":"image/png"}]}`, decodeGeminiImages},
		{"gemini base64 sujo", `{"predictions":[{"bytesBase64Encoded":"???"}]}`, decodeGeminiImages},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			images, err := item.decode([]byte(item.payload))
			if err == nil {
				t.Fatalf("corpo inválido passou como sucesso com %d imagens", len(images))
			}
			if len(images) != 0 {
				t.Fatalf("erro não pode vir com imagem junto")
			}
		})
	}
}

// A recusa por catálogo é a que a pessoa vai ler quando nada estiver
// configurado; ela precisa dizer ONDE se resolve. Não toca a rede: o roteador
// desiste antes de montar requisição.
func TestGenerateImageSemCatalogo(t *testing.T) {
	router := New(nil, nil)
	router.SetProviders([]Provider{{ID: "openai", Kind: KindOpenAI, BaseURL: "https://exemplo", Enabled: true}})

	_, err := router.GenerateImage(context.Background(), ImageRequest{Prompt: "um gato"})
	if err == nil {
		t.Fatal("catálogo sem habilidade de imagem devia recusar")
	}
	if !errors.Is(err, ErrNoCapability) {
		t.Fatalf("erro não é o de habilidade ausente: %v", err)
	}
	for _, needle := range []string{"image", "catalog.json", "skills"} {
		if !strings.Contains(err.Error(), needle) {
			t.Fatalf("a recusa não diz %q: %v", needle, err)
		}
	}
}

func TestGenerateImageSemPrompt(t *testing.T) {
	if _, err := New(nil, nil).GenerateImage(context.Background(), ImageRequest{}); err == nil {
		t.Fatal("prompt vazio devia recusar")
	}
}

func TestAspectFromSize(t *testing.T) {
	cases := map[string]string{
		"1024x1024": "1:1",
		"1792x1024": "16:9",
		"1024x1792": "9:16",
		"":          "",
		"grande":    "",
	}
	for size, want := range cases {
		if got := aspectFromSize(size); got != want {
			t.Fatalf("aspectFromSize(%q) = %q, esperado %q", size, got, want)
		}
	}
}
