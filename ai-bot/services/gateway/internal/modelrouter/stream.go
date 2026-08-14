// Leitura de SSE dos três dialetos.
//
// A regra que atravessa os três, e que o app anterior aprendeu em três lugares
// diferentes: o fim do corpo NÃO é o fim da resposta. Um proxy que corta, um
// provedor que encerra limpo antes da hora ou uma conexão que cai entregam um
// EOF idêntico ao do sucesso. Só há término quando o provedor DIZ que terminou
// — `[DONE]`, `finish_reason`, `message_stop`, `finishReason`. Sem sinal, o
// turno morre com ErrTruncated, porque mostrar meia resposta como resposta
// inteira é a falha mais cara que este caminho tem.
package modelrouter

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// maxErrorBody é quanto do corpo de erro entra na mensagem. O corpo inteiro
// pode trazer de volta o prompt (e o que estiver nele) para dentro de um log.
const maxErrorBody = 2048

// sseLimit é o teto de uma linha de evento. Sem teto, um provedor hostil (ou
// quebrado) enche a memória do processo com uma linha só.
const sseLimit = 8 << 20

// postJSON monta e dispara a requisição já autorizada.
func (r *Router) postJSON(
	ctx context.Context,
	provider Provider,
	url string,
	body any,
	authHeader, authPrefix string,
	extra map[string]string,
) (*http.Response, error) {
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("montar corpo: %w", err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		return nil, fmt.Errorf("montar requisição: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "text/event-stream")
	for key, value := range extra {
		request.Header.Set(key, value)
	}
	if err := r.authorize(provider, request, authHeader, authPrefix); err != nil {
		return nil, err
	}

	response, err := r.client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("chamar %s: %w", provider.ID, err)
	}
	if response.StatusCode < 200 || response.StatusCode > 299 {
		excerpt, _ := io.ReadAll(io.LimitReader(response.Body, maxErrorBody))
		_ = response.Body.Close()
		return nil, fmt.Errorf("provedor %s respondeu %d: %s",
			provider.ID, response.StatusCode, strings.TrimSpace(string(excerpt)))
	}
	return response, nil
}

// sseEvent é um evento do fluxo, já separado em nome e dados.
type sseEvent struct {
	Name string
	Data string
}

// readSSE percorre o corpo chamando `handle` a cada evento. Para quando `handle`
// devolve `stop=true` (sinal terminal do provedor) ou erro.
func readSSE(body io.Reader, handle func(sseEvent) (stop bool, err error)) (terminated bool, err error) {
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 0, 64*1024), sseLimit)

	var name string
	var data strings.Builder

	flush := func() (bool, error) {
		if data.Len() == 0 && name == "" {
			return false, nil
		}
		event := sseEvent{Name: name, Data: data.String()}
		name = ""
		data.Reset()
		return handle(event)
	}

	for scanner.Scan() {
		line := scanner.Text()
		// Fim de bloco: linha em branco fecha o evento acumulado.
		if strings.TrimSpace(line) == "" {
			stop, err := flush()
			if err != nil {
				return false, err
			}
			if stop {
				return true, nil
			}
			continue
		}
		if strings.HasPrefix(line, ":") {
			continue // comentário/keep-alive
		}
		field, value, found := strings.Cut(line, ":")
		if !found {
			field, value = line, ""
		}
		value = strings.TrimPrefix(value, " ")
		switch field {
		case "event":
			name = value
		case "data":
			// Um evento pode ter várias linhas `data:`; a RFC manda juntar com \n.
			if data.Len() > 0 {
				data.WriteByte('\n')
			}
			data.WriteString(value)
		}
	}
	if err := scanner.Err(); err != nil {
		return false, fmt.Errorf("ler fluxo: %w", err)
	}
	// EOF sem linha em branco final: ainda pode haver um evento pendente.
	stop, err := flush()
	if err != nil {
		return false, err
	}
	return stop, nil
}

/* -------------------------------- OpenAI -------------------------------- */

type openAIRequest struct {
	Model         string         `json:"model"`
	Messages      []ChatMessage  `json:"messages"`
	Stream        bool           `json:"stream"`
	StreamOptions *streamOptions `json:"stream_options,omitempty"`
	Temperature   *float64       `json:"temperature,omitempty"`
	MaxTokens     *int           `json:"max_tokens,omitempty"`
}

type streamOptions struct {
	IncludeUsage bool `json:"include_usage"`
}

type openAIChunk struct {
	Choices []struct {
		Delta struct {
			Content          string `json:"content"`
			ReasoningContent string `json:"reasoning_content"`
			Reasoning        string `json:"reasoning"`
			Thinking         string `json:"thinking"`
		} `json:"delta"`
		FinishReason *string `json:"finish_reason"`
	} `json:"choices"`
	Usage *struct {
		PromptTokens     int `json:"prompt_tokens"`
		CompletionTokens int `json:"completion_tokens"`
	} `json:"usage"`
}

func (r *Router) streamOpenAI(
	ctx context.Context,
	provider Provider,
	entry Entry,
	request Request,
	sink Sink,
) (Usage, error) {
	body := openAIRequest{
		Model:    entry.Model.ID,
		Messages: request.Messages,
		Stream:   true,
		// include_usage é o que faz o provedor mandar o consumo no último chunk.
		// Sem ele o relatório de custo fica zerado e ninguém percebe até a fatura.
		StreamOptions: &streamOptions{IncludeUsage: true},
	}
	if request.Temperature > 0 {
		body.Temperature = &request.Temperature
	}
	if request.MaxTokens > 0 {
		body.MaxTokens = &request.MaxTokens
	}

	// O provedor local fala OpenAI mas o modelo dele é o arquivo carregado; o id
	// do catálogo é o nome do GGUF e vai assim mesmo.
	response, err := r.postJSON(ctx, provider,
		endpoint(provider.BaseURL, "/chat/completions"), body,
		"Authorization", "Bearer ", nil)
	if err != nil {
		return Usage{}, err
	}
	defer response.Body.Close()

	var usage Usage
	// Dois sinais terminais, e os dois precisam existir. `[DONE]` é o da
	// OpenAI e para o laço na hora. `finish_reason` é o único que alguns
	// compatíveis emitem — mas NÃO pode parar o laço, porque com include_usage
	// o consumo vem no chunk SEGUINTE, e parar ali zeraria o custo do turno.
	// Por isso ele só marca que houve fim legítimo, e o EOF passa a ser aceito.
	sawFinish := false
	terminated, err := readSSE(response.Body, func(event sseEvent) (bool, error) {
		payload := strings.TrimSpace(event.Data)
		if payload == "" {
			return false, nil
		}
		if payload == "[DONE]" {
			return true, nil
		}
		var chunk openAIChunk
		if err := json.Unmarshal([]byte(payload), &chunk); err != nil {
			// Chunk ilegível não é motivo para derrubar a resposta inteira; o
			// provedor às vezes intercala keep-alive fora do formato.
			return false, nil
		}
		if chunk.Usage != nil {
			usage.PromptTokens = chunk.Usage.PromptTokens
			usage.OutputTokens = chunk.Usage.CompletionTokens
		}
		for _, choice := range chunk.Choices {
			if reasoning := firstNonEmpty(
				choice.Delta.ReasoningContent, choice.Delta.Reasoning, choice.Delta.Thinking,
			); reasoning != "" {
				if err := sink.Reasoning(reasoning); err != nil {
					return false, err
				}
			}
			if choice.Delta.Content != "" {
				if err := sink.Delta(choice.Delta.Content); err != nil {
					return false, err
				}
			}
			if choice.FinishReason != nil && *choice.FinishReason != "" {
				sawFinish = true
			}
		}
		return false, nil
	})
	if err != nil {
		return usage, err
	}
	if !terminated && !sawFinish {
		return usage, ErrTruncated
	}
	return usage, nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

/* ------------------------------- Anthropic ------------------------------ */

type anthropicRequest struct {
	Model       string             `json:"model"`
	MaxTokens   int                `json:"max_tokens"`
	System      string             `json:"system,omitempty"`
	Messages    []anthropicMessage `json:"messages"`
	Stream      bool               `json:"stream"`
	Temperature *float64           `json:"temperature,omitempty"`
}

type anthropicMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type anthropicEvent struct {
	Type  string `json:"type"`
	Delta struct {
		Type     string `json:"type"`
		Text     string `json:"text"`
		Thinking string `json:"thinking"`
	} `json:"delta"`
	Message *struct {
		Usage struct {
			InputTokens  int `json:"input_tokens"`
			OutputTokens int `json:"output_tokens"`
		} `json:"usage"`
	} `json:"message"`
	Usage *struct {
		OutputTokens int `json:"output_tokens"`
	} `json:"usage"`
	Error *struct {
		Type    string `json:"type"`
		Message string `json:"message"`
	} `json:"error"`
}

func (r *Router) streamAnthropic(
	ctx context.Context,
	provider Provider,
	entry Entry,
	request Request,
	sink Sink,
) (Usage, error) {
	// A Anthropic separa o system do histórico; juntar tudo em `messages` faria
	// o prompt de sistema virar uma fala do usuário — e o modelo tratá-lo como
	// pedido, não como regra.
	var system strings.Builder
	messages := make([]anthropicMessage, 0, len(request.Messages))
	for _, message := range request.Messages {
		if message.Role == "system" {
			if system.Len() > 0 {
				system.WriteString("\n\n")
			}
			system.WriteString(message.Content)
			continue
		}
		messages = append(messages, anthropicMessage{Role: message.Role, Content: message.Content})
	}

	maxTokens := request.MaxTokens
	if maxTokens <= 0 {
		// A API EXIGE max_tokens; sem valor a chamada é recusada com 400.
		maxTokens = 4096
	}
	body := anthropicRequest{
		Model:     entry.Model.ID,
		MaxTokens: maxTokens,
		System:    system.String(),
		Messages:  messages,
		Stream:    true,
	}
	if request.Temperature > 0 {
		body.Temperature = &request.Temperature
	}

	response, err := r.postJSON(ctx, provider,
		endpoint(provider.BaseURL, "/messages"), body,
		"x-api-key", "",
		map[string]string{"anthropic-version": "2023-06-01"})
	if err != nil {
		return Usage{}, err
	}
	defer response.Body.Close()

	var usage Usage
	terminated, err := readSSE(response.Body, func(event sseEvent) (bool, error) {
		payload := strings.TrimSpace(event.Data)
		if payload == "" {
			return false, nil
		}
		var parsed anthropicEvent
		if err := json.Unmarshal([]byte(payload), &parsed); err != nil {
			return false, nil
		}
		kind := parsed.Type
		if kind == "" {
			kind = event.Name
		}
		switch kind {
		case "message_start":
			if parsed.Message != nil {
				usage.PromptTokens = parsed.Message.Usage.InputTokens
				usage.OutputTokens = parsed.Message.Usage.OutputTokens
			}
		case "content_block_delta":
			switch parsed.Delta.Type {
			case "thinking_delta":
				if parsed.Delta.Thinking != "" {
					if err := sink.Reasoning(parsed.Delta.Thinking); err != nil {
						return false, err
					}
				}
			default:
				if parsed.Delta.Text != "" {
					if err := sink.Delta(parsed.Delta.Text); err != nil {
						return false, err
					}
				}
			}
		case "message_delta":
			if parsed.Usage != nil {
				usage.OutputTokens = parsed.Usage.OutputTokens
			}
		case "message_stop":
			return true, nil
		case "error":
			if parsed.Error != nil {
				return false, fmt.Errorf("provedor %s: %s", provider.ID, parsed.Error.Message)
			}
			return false, fmt.Errorf("provedor %s devolveu erro sem detalhe", provider.ID)
		}
		return false, nil
	})
	if err != nil {
		return usage, err
	}
	if !terminated {
		return usage, ErrTruncated
	}
	return usage, nil
}

/* -------------------------------- Gemini -------------------------------- */

type geminiRequest struct {
	Contents          []geminiContent  `json:"contents"`
	SystemInstruction *geminiContent   `json:"systemInstruction,omitempty"`
	GenerationConfig  geminiGeneration `json:"generationConfig"`
}

type geminiContent struct {
	Role  string       `json:"role,omitempty"`
	Parts []geminiPart `json:"parts"`
}

type geminiPart struct {
	Text string `json:"text"`
}

type geminiGeneration struct {
	Temperature     *float64 `json:"temperature,omitempty"`
	MaxOutputTokens *int     `json:"maxOutputTokens,omitempty"`
}

type geminiChunk struct {
	Candidates []struct {
		Content struct {
			Parts []geminiPart `json:"parts"`
		} `json:"content"`
		FinishReason string `json:"finishReason"`
	} `json:"candidates"`
	UsageMetadata *struct {
		PromptTokenCount     int `json:"promptTokenCount"`
		CandidatesTokenCount int `json:"candidatesTokenCount"`
	} `json:"usageMetadata"`
}

func (r *Router) streamGemini(
	ctx context.Context,
	provider Provider,
	entry Entry,
	request Request,
	sink Sink,
) (Usage, error) {
	var system strings.Builder
	contents := make([]geminiContent, 0, len(request.Messages))
	for _, message := range request.Messages {
		if message.Role == "system" {
			if system.Len() > 0 {
				system.WriteString("\n\n")
			}
			system.WriteString(message.Content)
			continue
		}
		// O Gemini chama de "model" o que os outros chamam de "assistant".
		role := message.Role
		if role == "assistant" {
			role = "model"
		}
		contents = append(contents, geminiContent{
			Role:  role,
			Parts: []geminiPart{{Text: message.Content}},
		})
	}

	body := geminiRequest{Contents: contents}
	if system.Len() > 0 {
		body.SystemInstruction = &geminiContent{Parts: []geminiPart{{Text: system.String()}}}
	}
	if request.Temperature > 0 {
		body.GenerationConfig.Temperature = &request.Temperature
	}
	if request.MaxTokens > 0 {
		body.GenerationConfig.MaxOutputTokens = &request.MaxTokens
	}

	// A chave vai no CABEÇALHO, nunca na query: URL entra em log de proxy, em
	// histórico e em mensagem de erro.
	url := endpoint(provider.BaseURL, "/models/"+entry.Model.ID+":streamGenerateContent?alt=sse")
	response, err := r.postJSON(ctx, provider, url, body, "x-goog-api-key", "", nil)
	if err != nil {
		return Usage{}, err
	}
	defer response.Body.Close()

	var usage Usage
	terminated, err := readSSE(response.Body, func(event sseEvent) (bool, error) {
		payload := strings.TrimSpace(event.Data)
		if payload == "" {
			return false, nil
		}
		var chunk geminiChunk
		if err := json.Unmarshal([]byte(payload), &chunk); err != nil {
			return false, nil
		}
		if chunk.UsageMetadata != nil {
			usage.PromptTokens = chunk.UsageMetadata.PromptTokenCount
			usage.OutputTokens = chunk.UsageMetadata.CandidatesTokenCount
		}
		finished := false
		for _, candidate := range chunk.Candidates {
			for _, part := range candidate.Content.Parts {
				if part.Text == "" {
					continue
				}
				if err := sink.Delta(part.Text); err != nil {
					return false, err
				}
			}
			if candidate.FinishReason != "" {
				finished = true
			}
		}
		return finished, nil
	})
	if err != nil {
		return usage, err
	}
	if !terminated {
		return usage, ErrTruncated
	}
	return usage, nil
}
