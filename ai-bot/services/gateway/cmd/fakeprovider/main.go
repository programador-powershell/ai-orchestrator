// Comando fakeprovider — um provedor OpenAI-compatível de mentira, para o
// AI-BOT poder ser exercitado de ponta a ponta sem chave, sem rede e sem custo.
//
// Ele existe por um motivo prático: quase tudo o que este produto faz de
// interessante só acontece DEPOIS que um modelo responde — a rota é publicada, a
// tela troca de superfície, o ícone do especialista aparece na linha, as
// ferramentas são chamadas. Sem um provedor, a verificação para no "conectando…"
// e ninguém sabe se o resto funciona.
//
// Ele NÃO é um mock de teste unitário: fala SSE de verdade, no formato de verdade,
// com `finish_reason` e `[DONE]` nos lugares certos — inclusive o `usage` no
// chunk seguinte ao `finish_reason`, que é onde o cliente já errou antes.
//
// Uso:
//
//	go run ./cmd/fakeprovider            # escuta em 127.0.0.1:8790
//	go run ./cmd/fakeprovider -addr :9000
//
// E no catalog.json, um provedor de kind `local` apontando para
// http://127.0.0.1:8790/v1 com `enabled: true`:
//
//	{"providers":[{"id":"fake","kind":"local","label":"Mentira",
//	  "baseURL":"http://127.0.0.1:8790/v1","enabled":true}],
//	 "models":[{"id":"fake-1","provider":"fake","label":"Fake","context":32000,
//	  "skills":["chat","code","reasoning","tools","long-context"]}]}
//
// O kind é `local` — os valores aceitos são `openai`, `anthropic` e `local`, e
// não `openai-compatible`, que este comentário dizia e custou uma subida com
// "utilizaveis=0". `local` é também o semanticamente certo: é servidor de modelo
// na própria estação, e é o único kind que dispensa chave sem exceção.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:8790", "endereço de escuta")
	delay := flag.Duration("delay", 12*time.Millisecond, "intervalo entre pedaços do stream")
	flag.Parse()

	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/chat/completions", chatHandler(*delay))
	mux.HandleFunc("GET /v1/models", modelsHandler)
	mux.HandleFunc("POST /v1/images/generations", imagesHandler)

	log.Printf("provedor de mentira em http://%s/v1", *addr)
	server := &http.Server{Addr: *addr, Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	if err := server.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}

type chatRequest struct {
	Model    string `json:"model"`
	Stream   bool   `json:"stream"`
	Messages []struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	} `json:"messages"`
}

// chatHandler responde ao turno. Quando o pedido vem do MASTER (o prompt de
// sistema dele manda responder só um JSON de roteamento), devolve exatamente
// esse JSON — assim o degrau 3 da cascata também dá para exercitar.
func chatHandler(delay time.Duration) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var request chatRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			http.Error(w, `{"error":{"message":"corpo inválido"}}`, http.StatusBadRequest)
			return
		}

		answer := replyFor(request)

		if !request.Stream {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":     "fake-1",
				"object": "chat.completion",
				"model":  request.Model,
				"choices": []any{map[string]any{
					"index":         0,
					"message":       map[string]string{"role": "assistant", "content": answer},
					"finish_reason": "stop",
				}},
				"usage": map[string]int{"prompt_tokens": 100, "completion_tokens": len(answer) / 4},
			})
			return
		}

		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "sem streaming", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.WriteHeader(http.StatusOK)

		// Pedaços de tamanho irregular, como um provedor real entrega — pedaço de
		// tamanho fixo esconde o bug de fatia caindo no meio de um caractere
		// multibyte ou no meio de uma cerca de código.
		for _, piece := range chunks(answer) {
			emit(w, map[string]any{
				"id":      "fake-1",
				"object":  "chat.completion.chunk",
				"model":   request.Model,
				"choices": []any{map[string]any{"index": 0, "delta": map[string]string{"content": piece}}},
			})
			flusher.Flush()
			time.Sleep(delay)
		}

		// finish_reason primeiro…
		emit(w, map[string]any{
			"id":      "fake-1",
			"object":  "chat.completion.chunk",
			"choices": []any{map[string]any{"index": 0, "delta": map[string]any{}, "finish_reason": "stop"}},
		})
		// …e o usage DEPOIS, que é como o include_usage funciona de verdade. Um
		// cliente que parasse no finish_reason zeraria o custo do turno.
		emit(w, map[string]any{
			"id":      "fake-1",
			"object":  "chat.completion.chunk",
			"choices": []any{},
			"usage":   map[string]int{"prompt_tokens": 100, "completion_tokens": len(answer) / 4},
		})
		fmt.Fprint(w, "data: [DONE]\n\n")
		flusher.Flush()
	}
}

func emit(w http.ResponseWriter, payload any) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return
	}
	fmt.Fprintf(w, "data: %s\n\n", raw)
}

// replyFor decide o que responder a partir do prompt de sistema.
func replyFor(request chatRequest) string {
	var system, user strings.Builder
	for _, message := range request.Messages {
		switch message.Role {
		case "system":
			system.WriteString(message.Content)
			system.WriteString("\n")
		case "user":
			user.Reset()
			user.WriteString(message.Content)
		}
	}

	// O master pede JSON e só JSON.
	if strings.Contains(system.String(), "Você é o master do AI-BOT") {
		return classify(user.String())
	}

	return sample(user.String())
}

// classify imita o veredito do master com uma heurística boba — o objetivo é
// exercitar o CAMINHO, não acertar a classificação.
func classify(prompt string) string {
	lower := strings.ToLower(prompt)
	specialist := "chat"
	switch {
	case strings.Contains(lower, "codig") || strings.Contains(lower, "bug") || strings.Contains(lower, "refator"):
		specialist = "code"
	case strings.Contains(lower, "docx") || strings.Contains(lower, "contrato") || strings.Contains(lower, "document"):
		specialist = "office"
	case strings.Contains(lower, "design") || strings.Contains(lower, "paleta") || strings.Contains(lower, "interface"):
		specialist = "design"
	case strings.Contains(lower, "tabela") || strings.Contains(lower, "schema") || strings.Contains(lower, "sql"):
		specialist = "data"
	case strings.Contains(lower, "tarefa") || strings.Contains(lower, "automa"):
		specialist = "work"
	case strings.Contains(lower, "seguranc") || strings.Contains(lower, "vulnerab"):
		specialist = "security"
	case strings.Contains(lower, "equipe") || strings.Contains(lower, "orquestr"):
		specialist = "agent"
	case strings.Contains(lower, "fluxo") || strings.Contains(lower, "pipeline"):
		specialist = "fluxo"
	case strings.Contains(lower, "treino") || strings.Contains(lower, "dataset"):
		specialist = "tune"
	}
	return fmt.Sprintf(`{"specialist":%q,"confidence":0.93,"why":"provedor de mentira"}`, specialist)
}

// sample devolve uma resposta com markdown de verdade — títulos, cerca de código,
// lista e ênfase —, porque é isso que exercita o renderizador em streaming.
// O roteiro da DELEGAÇÃO.
//
// Um provedor que só devolve prosa exercita metade do produto: a outra metade só
// aparece quando um especialista chama outro. Estas três respostas encenam o
// caminho inteiro — o dono fala e delega, o convidado responde, o dono conclui —
// para dar para VER na tela o popup abrindo, o ícone do delegado na linha dele e
// a conclusão voltando assinada por quem atendeu.
const delegateGoal = "defina a identidade visual: paleta, tipografia e espaçamento"

func buildsSomething(prompt string) bool {
	lower := strings.ToLower(prompt)
	for _, verb := range []string{"crie", "criar", "monte", "montar", "faca", "faça", "construa"} {
		if !strings.Contains(lower, verb) {
			continue
		}
		for _, thing := range []string{"aplicac", "aplicação", "app", "site", "landing", "next"} {
			if strings.Contains(lower, thing) {
				return true
			}
		}
	}
	return false
}

func sample(prompt string) string {
	trimmed := strings.TrimSpace(prompt)

	// 3ª volta: o resultado do delegado voltou; o dono conclui.
	if strings.HasPrefix(trimmed, "Resultado da delegação") {
		return "## Pronto\n\nEstrutura criada e visual aplicado.\n\n" +
			"- `app/layout.tsx` e `app/page.tsx` com App Router;\n" +
			"- `app/globals.css` com os tokens que o **Design** definiu;\n" +
			"- `package.json` com `next`, `react` e `react-dom`.\n\n" +
			"```bash\nnpm install && npm run dev\n```\n\n" +
			"Falta você dizer se quer TypeScript estrito e qual gerenciador de pacotes.\n"
	}

	// 2ª volta: é o DELEGADO respondendo — o prompt dele é o objetivo.
	if strings.Contains(trimmed, "identidade visual") {
		return "Paleta: `#0B0F14` de fundo, `#E6EDF3` de texto, `#3FB950` de acento.\n" +
			"Tipografia: Inter 16/24, títulos em 28/34. Espaçamento base de 8px.\n"
	}

	// 1ª volta de um pedido de construção: fala e CHAMA o design.
	if buildsSomething(trimmed) {
		return "Vou montar o esqueleto do projeto e chamar o **Design** para o visual.\n\n" +
			"```aibot:delegate\n{\"specialist\":\"design\",\"goal\":\"" + delegateGoal + "\"}\n```\n"
	}

	return "## Resposta de mentira\n\n" +
		"Este texto vem do `fakeprovider`, não de um modelo. O pedido foi:\n\n> " +
		trimmed + "\n\n" +
		"Alguns pontos:\n\n" +
		"- o **streaming** está funcionando (você viu o texto aparecer aos poucos);\n" +
		"- o *markdown* é renderizado de forma incremental;\n" +
		"- a cerca abaixo tem linha em branco no meio, de propósito:\n\n" +
		"```go\nfunc exemplo() {\n\n\treturn nil\n}\n```\n\n" +
		"### Fim\n\nAcentuação para conferir UTF-8 partido: ação, ünïcödé, 日本語.\n"
}

// chunks parte o texto em pedaços de tamanho irregular.
func chunks(text string) []string {
	runes := []rune(text)
	sizes := []int{3, 7, 1, 12, 5, 2, 9}
	var out []string
	for index, step := 0, 0; index < len(runes); step++ {
		size := sizes[step%len(sizes)]
		end := index + size
		if end > len(runes) {
			end = len(runes)
		}
		out = append(out, string(runes[index:end]))
		index = end
	}
	return out
}

func modelsHandler(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"object": "list",
		"data":   []any{map[string]string{"id": "fake-1", "object": "model"}},
	})
}

func imagesHandler(w http.ResponseWriter, _ *http.Request) {
	// 1×1 PNG transparente, para `image.generate` ter o que gravar.
	const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk" +
		"YPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"created": time.Now().Unix(),
		"data":    []any{map[string]string{"b64_json": pixel}},
	})
}
