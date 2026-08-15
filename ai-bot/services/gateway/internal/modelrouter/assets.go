// O que o provedor sabe fazer além de conversar: gerar imagem e treinar modelo.
//
// Isto mora no roteador, e não num cliente HTTP próprio, por um motivo de
// segurança e não de organização: a chave do provedor tem UMA porta de entrada
// (`authorize`, que a usa dentro do callback do cofre e nunca a devolve). Um
// segundo cliente seria uma segunda política de credencial para manter correta,
// e a segunda é sempre a que fica para trás — foi assim que o app anterior
// acabou com chave em log.
//
// A rota de imagem NÃO passa pelo netguard de propósito: o netguard existe para
// URL escolhida por terceiro (modelo, plugin, página), onde o risco é SSRF e
// rebinding. Aqui o destino é o `baseUrl` do catalog.json, escrito pelo admin,
// o mesmo que o turno de chat já usa. Quem baixa um link ESCOLHIDO PELO
// PROVEDOR (o caso `data[].url` da OpenAI) é a ferramenta, e essa sim passa
// pelo guarda.
package modelrouter

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// Capability é o que um provedor sabe fazer além de conversar. O valor é o
// mesmo texto que vai em `skills` no catalog.json — declarar a habilidade é
// configuração, não recompilação.
type Capability string

const (
	CapabilityChat     Capability = "chat"
	CapabilityImage    Capability = "image"
	CapabilityFinetune Capability = "finetune"
)

// maxProviderBody é o teto do corpo lido numa chamada genérica ao provedor.
// Sem teto, um provedor quebrado (ou um proxy no meio) enche a memória do
// processo com uma resposta só.
const maxProviderBody = 8 << 20

// maxImageBody é maior que o anterior porque imagem chega em base64, que infla
// ~33%, e a ferramenta permite até 4 de uma vez. Continua havendo teto: o que
// não pode existir é leitura sem limite.
const maxImageBody = 24 << 20

// ImageRequest é um pedido de desenho.
type ImageRequest struct {
	Prompt string
	Size   string
	Count  int
	// Model fixa o modelo. Vazio = o primeiro do catálogo que declara "image".
	Model string
}

// ImageResult é o que o provedor devolveu, já separado do dialeto dele.
type ImageResult struct {
	Model  string
	Images []GeneratedImage
}

// GeneratedImage é uma imagem. `Bytes` e `URL` são alternativos: a OpenAI
// devolve um dos dois conforme o modelo, e o Gemini sempre devolve bytes.
type GeneratedImage struct {
	Mime  string
	Bytes []byte
	URL   string
}

// ErrNoCapability diz que o catálogo não declara a habilidade pedida.
var ErrNoCapability = errors.New("nenhum modelo do catálogo declara a habilidade")

/* ------------------------------- habilidade ------------------------------- */

// ProviderFor devolve o provedor habilitado que atende a habilidade.
//
// Existe separado de GenerateImage porque fine-tuning não escolhe modelo do
// catálogo: o modelo do treino é o que a pessoa mandou treinar. O que se
// procura aqui é o PROVEDOR — quem tem chave e endereço para receber o job.
func (r *Router) ProviderFor(capability Capability) (Provider, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	_, provider, err := r.forCapability(capability, "")
	return provider, err
}

// forCapability exige trava de leitura já segurada.
func (r *Router) forCapability(capability Capability, preferred string) (Entry, Provider, error) {
	if preferred != "" {
		for _, entry := range r.models {
			if entry.ID == preferred && r.usable(entry) {
				return entry, r.providers[entry.ProviderID], nil
			}
		}
		return Entry{}, Provider{}, fmt.Errorf(
			"%w: %s não está no catálogo utilizável — confira o id e o provedor em catalog.json",
			ErrNoModel, preferred)
	}
	for _, entry := range r.models {
		if !r.usable(entry) || !containsFold(entry.Skills, string(capability)) {
			continue
		}
		return entry, r.providers[entry.ProviderID], nil
	}
	// A recusa diz ONDE se resolve. Um "não dá" sem endereço faz o modelo
	// tentar outra ferramenta em vez de a pessoa abrir o arquivo certo.
	return Entry{}, Provider{}, fmt.Errorf(
		"%w %q — declare-a em \"skills\" do modelo, no catalog.json, e habilite o provedor dele",
		ErrNoCapability, string(capability))
}

/* --------------------------------- imagem --------------------------------- */

// GenerateImage desenha pelo provedor e devolve a imagem já decodificada.
func (r *Router) GenerateImage(ctx context.Context, request ImageRequest) (ImageResult, error) {
	if strings.TrimSpace(request.Prompt) == "" {
		return ImageResult{}, errors.New("informe o que desenhar")
	}
	count := request.Count
	if count <= 0 {
		count = 1
	}

	r.mu.RLock()
	entry, provider, err := r.forCapability(CapabilityImage, request.Model)
	r.mu.RUnlock()
	if err != nil {
		return ImageResult{}, err
	}
	adapter, ok := r.adapterFor(provider.Kind)
	if !ok {
		return ImageResult{}, fmt.Errorf("nenhum plugin fornece adaptador para o provedor %s (%s)", provider.ID, provider.Kind)
	}

	var (
		url  string
		body any
	)
	switch adapter.ImageProtocol {
	case ProtocolOpenAI:
		url = endpoint(provider.BaseURL, "/images/generations")
		payload := openAIImageRequest{Model: entry.Model.ID, Prompt: request.Prompt, N: count}
		// `size` só vai quando pedido: cada modelo tem um padrão próprio e um
		// tamanho inválido é 400, não é aproximação.
		if request.Size != "" {
			payload.Size = request.Size
		}
		body = payload
	case ProtocolGemini:
		url = endpoint(provider.BaseURL, "/models/"+entry.Model.ID+":predict")
		body = geminiImageRequest{
			Instances:  []geminiImageInstance{{Prompt: request.Prompt}},
			Parameters: geminiImageParameters{SampleCount: count, AspectRatio: aspectFromSize(request.Size)},
		}
	default:
		return ImageResult{}, fmt.Errorf("o provedor %s (%s) não tem rota de imagem implementada",
			provider.ID, provider.Kind)
	}

	header, prefix, extra := providerAuth(provider.Kind)
	if extra == nil {
		extra = make(map[string]string, 1)
	}
	// Sobrepõe o Accept de SSE que o postJSON põe para o caminho de chat: aqui
	// a resposta é um JSON só, e alguns provedores negociam pelo cabeçalho.
	extra["Accept"] = "application/json"

	response, err := r.postJSON(ctx, provider, url, body, header, prefix, extra)
	if err != nil {
		return ImageResult{}, err
	}
	defer response.Body.Close()

	payload, err := readCapped(response.Body, maxImageBody)
	if err != nil {
		return ImageResult{}, fmt.Errorf("ler resposta de %s: %w", provider.ID, err)
	}

	var images []GeneratedImage
	if adapter.ImageProtocol == ProtocolGemini {
		images, err = decodeGeminiImages(payload)
	} else {
		images, err = decodeOpenAIImages(payload)
	}
	if err != nil {
		return ImageResult{}, fmt.Errorf("provedor %s: %w", provider.ID, err)
	}
	return ImageResult{Model: entry.Model.ID, Images: images}, nil
}

type openAIImageRequest struct {
	Model  string `json:"model"`
	Prompt string `json:"prompt"`
	N      int    `json:"n"`
	Size   string `json:"size,omitempty"`
}

type geminiImageRequest struct {
	Instances  []geminiImageInstance `json:"instances"`
	Parameters geminiImageParameters `json:"parameters"`
}

type geminiImageInstance struct {
	Prompt string `json:"prompt"`
}

type geminiImageParameters struct {
	SampleCount int    `json:"sampleCount"`
	AspectRatio string `json:"aspectRatio,omitempty"`
}

// aspectFromSize traduz o "1024x1024" da OpenAI para a proporção que o Gemini
// entende. Mandar o tamanho cru derrubaria a chamada com 400, e ignorar o
// pedido devolveria uma imagem quadrada para quem pediu paisagem.
func aspectFromSize(size string) string {
	width, height, found := strings.Cut(strings.ToLower(strings.TrimSpace(size)), "x")
	if !found {
		return ""
	}
	switch {
	case width == height:
		return "1:1"
	case width == "1792" && height == "1024", width == "1536" && height == "1024":
		return "16:9"
	case width == "1024" && height == "1792", width == "1024" && height == "1536":
		return "9:16"
	default:
		return ""
	}
}

// decodeOpenAIImages lê `data[]`, que traz `url` OU `b64_json` conforme o
// modelo. É função pura para poder ser testada sem rede — o formato do provedor
// é justamente a parte que muda sem aviso.
func decodeOpenAIImages(payload []byte) ([]GeneratedImage, error) {
	var parsed struct {
		Data []struct {
			URL     string `json:"url"`
			B64JSON string `json:"b64_json"`
		} `json:"data"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(payload, &parsed); err != nil {
		return nil, fmt.Errorf("resposta ilegível: %w", err)
	}
	if parsed.Error != nil && strings.TrimSpace(parsed.Error.Message) != "" {
		return nil, errors.New(strings.TrimSpace(parsed.Error.Message))
	}

	images := make([]GeneratedImage, 0, len(parsed.Data))
	for index, item := range parsed.Data {
		switch {
		case item.B64JSON != "":
			raw, err := base64.StdEncoding.DecodeString(item.B64JSON)
			if err != nil {
				return nil, fmt.Errorf("imagem %d veio em base64 ilegível: %w", index+1, err)
			}
			images = append(images, GeneratedImage{Mime: sniffImageMime(raw), Bytes: raw})
		case item.URL != "":
			images = append(images, GeneratedImage{URL: item.URL})
		}
	}
	if len(images) == 0 {
		return nil, errors.New("a resposta não trouxe imagem nenhuma")
	}
	return images, nil
}

// decodeGeminiImages lê `predictions[].bytesBase64Encoded`.
func decodeGeminiImages(payload []byte) ([]GeneratedImage, error) {
	var parsed struct {
		Predictions []struct {
			Bytes    string `json:"bytesBase64Encoded"`
			MimeType string `json:"mimeType"`
		} `json:"predictions"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(payload, &parsed); err != nil {
		return nil, fmt.Errorf("resposta ilegível: %w", err)
	}
	if parsed.Error != nil && strings.TrimSpace(parsed.Error.Message) != "" {
		return nil, errors.New(strings.TrimSpace(parsed.Error.Message))
	}

	images := make([]GeneratedImage, 0, len(parsed.Predictions))
	for index, item := range parsed.Predictions {
		if item.Bytes == "" {
			continue
		}
		raw, err := base64.StdEncoding.DecodeString(item.Bytes)
		if err != nil {
			return nil, fmt.Errorf("imagem %d veio em base64 ilegível: %w", index+1, err)
		}
		mime := item.MimeType
		if mime == "" {
			mime = sniffImageMime(raw)
		}
		images = append(images, GeneratedImage{Mime: mime, Bytes: raw})
	}
	if len(images) == 0 {
		return nil, errors.New("a resposta não trouxe imagem nenhuma")
	}
	return images, nil
}

// sniffImageMime confia no conteúdo, não no que o provedor disse. O tipo vira
// extensão de arquivo no disco, e um `.png` que é JPEG só dá problema na hora
// em que alguém abre.
func sniffImageMime(raw []byte) string {
	mime := http.DetectContentType(raw)
	if !strings.HasPrefix(mime, "image/") {
		// Formato que o detector da padrão não conhece (avif, por exemplo)
		// existe; chutar "png" aqui gravaria a extensão errada.
		return "application/octet-stream"
	}
	return mime
}

/* --------------------------- chamada genérica ----------------------------- */

// ProviderFetch faz uma chamada autenticada ao provedor e devolve status e
// corpo crus.
//
// É o que fine-tuning precisa (/fine_tuning/jobs, /files) sem que cada
// ferramenta remonte a política de credencial. Status fora de 2xx NÃO é erro
// aqui: o corpo do provedor explica o que houve, e quem chamou sabe formatar
// isso melhor que este pacote. Erro é só o que impediu a chamada de acontecer.
func (r *Router) ProviderFetch(
	ctx context.Context,
	providerID, method, path string,
	body []byte,
) (int, []byte, error) {
	r.mu.RLock()
	provider, ok := r.providers[providerID]
	r.mu.RUnlock()
	if !ok {
		return 0, nil, fmt.Errorf("provedor desconhecido: %s", providerID)
	}
	if !provider.Enabled {
		return 0, nil, fmt.Errorf("o provedor %s está desabilitado no catalog.json", providerID)
	}

	method = strings.ToUpper(strings.TrimSpace(method))
	if method == "" {
		method = http.MethodGet
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}

	var reader io.Reader
	if len(body) > 0 {
		reader = bytes.NewReader(body)
	}
	request, err := http.NewRequestWithContext(ctx, method, endpoint(provider.BaseURL, path), reader)
	if err != nil {
		return 0, nil, fmt.Errorf("montar requisição: %w", err)
	}
	if len(body) > 0 {
		request.Header.Set("Content-Type", "application/json")
	}
	request.Header.Set("Accept", "application/json")

	header, prefix, extra := providerAuth(provider.Kind)
	for key, value := range extra {
		request.Header.Set(key, value)
	}
	if err := r.authorize(provider, request, header, prefix); err != nil {
		return 0, nil, err
	}

	response, err := r.client.Do(request)
	if err != nil {
		// O erro do cliente é reescrito com o ID do provedor: o original traz a
		// URL inteira, e URL de provedor às vezes carrega parâmetro de conta.
		return 0, nil, fmt.Errorf("chamar %s: %w", providerID, err)
	}
	defer response.Body.Close()

	payload, err := readCapped(response.Body, maxProviderBody)
	if err != nil {
		return response.StatusCode, nil, fmt.Errorf("ler resposta de %s: %w", providerID, err)
	}
	return response.StatusCode, payload, nil
}

// providerAuth diz onde a credencial entra em cada dialeto.
//
// Está numa função só porque errar isto é mandar a chave no cabeçalho errado —
// o provedor responde 401, que parece "chave inválida" e faz a pessoa trocar
// uma chave que estava boa.
func providerAuth(kind Kind) (header, prefix string, extra map[string]string) {
	switch kind {
	case KindAnthropic:
		return "x-api-key", "", map[string]string{"anthropic-version": "2023-06-01"}
	case KindGemini:
		return "x-goog-api-key", "", nil
	default:
		return "Authorization", "Bearer ", nil
	}
}

// readCapped lê até `limit` e RECUSA o que passar disso, em vez de cortar.
// Corpo cortado vira JSON inválido e a mensagem sairia "resposta ilegível" —
// que manda investigar o formato quando o problema era o tamanho.
func readCapped(body io.Reader, limit int64) ([]byte, error) {
	payload, err := io.ReadAll(io.LimitReader(body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(payload)) > limit {
		return nil, fmt.Errorf("a resposta passou do teto de %d MiB", limit>>20)
	}
	return payload, nil
}
