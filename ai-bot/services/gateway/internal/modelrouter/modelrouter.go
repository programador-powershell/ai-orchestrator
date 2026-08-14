// Package modelrouter escolhe e chama o modelo.
//
// MUDANÇA DE PRODUTO em relação ao app anterior: lá o cliente mandava só o
// `mode` e o SERVIDOR decidia o modelo — escolher o modelo era escolher quanto
// gastar, e isso não era decisão do usuário. No AI-BOT o usuário escolhe, e a
// precedência ficou:
//
//	escolha do usuário  >  preferência do especialista  >  padrão do catálogo
//
// A política não sumiu: ela decide o que ENTRA no catálogo (`Allowed`). O
// usuário escolhe dentro do que o admin liberou, o que é diferente de escolher
// qualquer coisa — e diferente de não escolher nada.
//
// A chave do provedor NUNCA passa por aqui como valor. O roteador guarda uma
// referência e pede ao cofre que a use dentro de um callback; assim ela não
// entra em struct, log ou mensagem de erro.
package modelrouter

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"

	"aibot/gateway/internal/protocol"
	"aibot/gateway/internal/specialist"
)

// Kind é o dialeto do provedor.
type Kind string

const (
	KindOpenAI     Kind = "openai"
	KindAnthropic  Kind = "anthropic"
	KindGemini     Kind = "gemini"
	KindCompatible Kind = "openai-compatible"
	// KindLocal é o servidor de modelo na própria estação. Fala OpenAI, mas
	// merece tipo próprio: ele não sai da máquina, então não passa por blocklist
	// nem conta custo — e confundir os dois faria o app cobrar por token local.
	KindLocal Kind = "local"
)

// Provider é um endereço que serve modelos.
type Provider struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Kind    Kind   `json:"kind"`
	BaseURL string `json:"baseUrl"`
	// SecretRef é o NOME da chave no cofre. O valor não mora aqui.
	SecretRef string `json:"secretRef,omitempty"`
	Enabled   bool   `json:"enabled"`
}

// Entry é um modelo no catálogo, já ligado ao provedor.
type Entry struct {
	protocol.Model
	ProviderID string `json:"providerId"`
	// Default marca o modelo que atende quem não escolheu nada.
	Default bool `json:"default,omitempty"`
}

// KeyProvider é o cofre visto por este pacote: dá para usar o segredo, não para
// obtê-lo. `*secrets.Vault` satisfaz.
type KeyProvider interface {
	Use(ref string, fn func(secret string) error) error
	Has(ref string) bool
}

// ChatMessage é uma linha do histórico enviada ao modelo.
type ChatMessage struct {
	Role    string `json:"role"` // system | user | assistant
	Content string `json:"content"`
}

// Request é um turno de inferência.
type Request struct {
	Model       string
	Messages    []ChatMessage
	Temperature float64
	MaxTokens   int
}

// Usage é o que o turno custou.
type Usage struct {
	PromptTokens int `json:"promptTokens"`
	OutputTokens int `json:"outputTokens"`
}

// Sink recebe a resposta em pedaços.
//
// `Reasoning` é separado de `Delta` de propósito: raciocínio não é resposta, e
// concatenar os dois faz o app mostrar o rascunho do modelo como se fosse o que
// ele decidiu dizer.
type Sink interface {
	Delta(text string) error
	Reasoning(text string) error
}

// ErrNoModel diz que nada no catálogo atende.
var ErrNoModel = errors.New("nenhum modelo disponível")

// ErrTruncated é o corte no meio do stream.
//
// Existe como erro NOMEADO porque o modo de falha silencioso é o pior: o corpo
// SSE acaba sem `[DONE]` e sem `finish_reason`, e entregar isso como sucesso
// mostra meia resposta com cara de resposta inteira. O app anterior aprendeu
// isso em três lugares diferentes.
var ErrTruncated = errors.New("a resposta foi interrompida antes do fim")

// Router é o catálogo mais o cliente.
type Router struct {
	client *http.Client
	keys   KeyProvider

	mu        sync.RWMutex
	providers map[string]Provider
	models    []Entry
	// allowed limita o catálogo ao que a política liberou. nil = ninguém
	// configurou (tudo passa); mapa vazio = a política liberou NADA. Ver
	// SetAllowed para o porquê de os dois não serem a mesma coisa.
	allowed map[string]bool
}

// New monta o roteador.
func New(client *http.Client, keys KeyProvider) *Router {
	if client == nil {
		client = http.DefaultClient
	}
	return &Router{
		client:    client,
		keys:      keys,
		providers: make(map[string]Provider),
	}
}

/* ------------------------------- catálogo ------------------------------- */

// SetProviders substitui a lista de provedores.
func (r *Router) SetProviders(list []Provider) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.providers = make(map[string]Provider, len(list))
	for _, provider := range list {
		r.providers[provider.ID] = provider
	}
}

// SetModels substitui o catálogo.
func (r *Router) SetModels(list []Entry) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.models = make([]Entry, len(list))
	copy(r.models, list)
	sort.SliceStable(r.models, func(i, j int) bool {
		if r.models[i].ProviderID != r.models[j].ProviderID {
			return r.models[i].ProviderID < r.models[j].ProviderID
		}
		return r.models[i].Label < r.models[j].Label
	})
}

// SetAllowed limita o catálogo ao que a política liberou.
//
// A diferença entre `nil` e lista VAZIA é deliberada, e é a mesma que
// config.allowOrigins faz com a variável de ambiente: `nil` é "ninguém
// configurou política" e libera tudo; uma lista vazia DECLARADA é a política
// dizendo "nenhum modelo", e aí nenhum passa.
//
// Tratar as duas como "tudo" tem um caso concreto de falha: na edição
// gerenciada a lista permitida é o catálogo MENOS o BYOK local, e um catálogo
// só de modelos locais produz legitimamente uma lista vazia — que, com a regra
// antiga, abriria de volta o catálogo inteiro. Indisponibilidade de política
// não pode virar liberação.
func (r *Router) SetAllowed(ids []string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if ids == nil {
		r.allowed = nil
		return
	}
	r.allowed = make(map[string]bool, len(ids))
	for _, id := range ids {
		if id = strings.TrimSpace(id); id != "" {
			r.allowed[id] = true
		}
	}
}

// Catalog devolve o que o usuário pode escolher — já filtrado pela política e
// pelo que tem provedor habilitado com chave.
func (r *Router) Catalog() []protocol.Model {
	r.mu.RLock()
	defer r.mu.RUnlock()

	out := make([]protocol.Model, 0, len(r.models))
	for _, entry := range r.models {
		if !r.usable(entry) {
			continue
		}
		out = append(out, entry.Model)
	}
	return out
}

// usable exige trava de leitura já segurada.
func (r *Router) usable(entry Entry) bool {
	if r.allowed != nil && !r.allowed[entry.ID] {
		return false
	}
	provider, ok := r.providers[entry.ProviderID]
	if !ok || !provider.Enabled {
		return false
	}
	// Provedor local não tem chave — e exigir chave dele tiraria do catálogo
	// justamente o modelo que funciona sem rede.
	if provider.Kind == KindLocal || provider.SecretRef == "" {
		return true
	}
	return r.keys != nil && r.keys.Has(provider.SecretRef)
}

// Resolve escolhe o modelo do turno.
//
// A ordem é a regra do produto: o que o usuário pediu vence; sem pedido, o que
// o especialista prefere; sem preferência atendível, o padrão do catálogo.
func (r *Router) Resolve(specialistID, userChoice string) (Entry, Provider, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	if len(r.models) == 0 {
		return Entry{}, Provider{}, ErrNoModel
	}

	if userChoice != "" {
		for _, entry := range r.models {
			if entry.ID == userChoice && r.usable(entry) {
				return entry, r.providers[entry.ProviderID], nil
			}
		}
		// Escolha inválida NÃO derruba o turno: ela pode ter sido gravada numa
		// conversa antiga, ou removida do catálogo pelo admin depois. Cai para a
		// preferência do especialista — e o `state` seguinte conta ao cliente
		// qual modelo realmente atendeu.
	}

	definition := specialist.GetOrDefault(specialistID)
	for _, skill := range definition.PreferredSkills {
		for _, entry := range r.models {
			if !r.usable(entry) {
				continue
			}
			if containsFold(entry.Skills, skill) {
				return entry, r.providers[entry.ProviderID], nil
			}
		}
	}

	for _, entry := range r.models {
		if entry.Default && r.usable(entry) {
			return entry, r.providers[entry.ProviderID], nil
		}
	}
	for _, entry := range r.models {
		if r.usable(entry) {
			return entry, r.providers[entry.ProviderID], nil
		}
	}
	return Entry{}, Provider{}, ErrNoModel
}

func containsFold(list []string, needle string) bool {
	for _, item := range list {
		if strings.EqualFold(item, needle) {
			return true
		}
	}
	return false
}

/* ------------------------------- inferência ----------------------------- */

// Stream chama o modelo e alimenta o sink. `Usage` sai preenchido quando o
// provedor informa; zero quando não informa (estimar aqui seria inventar número
// que depois vira relatório de custo).
func (r *Router) Stream(ctx context.Context, request Request, sink Sink) (Usage, error) {
	entry, provider, err := r.resolveExact(request.Model)
	if err != nil {
		return Usage{}, err
	}
	if sink == nil {
		return Usage{}, errors.New("sink nulo")
	}

	switch provider.Kind {
	case KindAnthropic:
		return r.streamAnthropic(ctx, provider, entry, request, sink)
	case KindGemini:
		return r.streamGemini(ctx, provider, entry, request, sink)
	case KindOpenAI, KindCompatible, KindLocal:
		return r.streamOpenAI(ctx, provider, entry, request, sink)
	default:
		return Usage{}, fmt.Errorf("provedor de tipo desconhecido: %s", provider.Kind)
	}
}

// Complete junta o stream num texto só. Usado pelo classificador master e por
// qualquer caminho que precise da resposta inteira antes de agir.
func (r *Router) Complete(ctx context.Context, request Request) (string, Usage, error) {
	var builder strings.Builder
	usage, err := r.Stream(ctx, request, sinkFunc(func(text string) error {
		builder.WriteString(text)
		return nil
	}))
	return builder.String(), usage, err
}

// sinkFunc adapta uma função a Sink, ignorando o raciocínio.
type sinkFunc func(string) error

func (f sinkFunc) Delta(text string) error { return f(text) }
func (f sinkFunc) Reasoning(string) error  { return nil }

// resolveExact acha o modelo pelo id, sem cair em substituto: quem chegou aqui
// já passou por Resolve e mandar outro modelo silenciosamente faria o `state`
// mentir sobre quem respondeu.
//
// O portão é o MESMO `usable` do Catalog, e é aqui que ele precisa estar: este
// é o ponto em que o modelo é USADO, enquanto o Catalog é só onde ele é
// listado. Um id chega até aqui sem ter passado pela lista de três maneiras
// normais — gravado numa conversa antiga, mandado direto no campo `model` do
// protocolo, ou vindo de um caminho interno como o classificador. Conferir só
// `provider.Enabled`, como esta função fazia, deixava a política do admin
// valendo apenas para o que a tela desenha: decorativa.
func (r *Router) resolveExact(id string) (Entry, Provider, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	for _, entry := range r.models {
		if entry.ID != id {
			continue
		}
		if !r.usable(entry) {
			// A frase é uma só para os três motivos (política, provedor
			// desligado, chave ausente) de propósito: dizer qual deles reprovou
			// conta ao chamador o que o admin bloqueou, e quem pergunta pelo
			// modelo pelo id não precisa dessa informação.
			return Entry{}, Provider{}, fmt.Errorf("%w: %s não está disponível nesta estação", ErrNoModel, id)
		}
		return entry, r.providers[entry.ProviderID], nil
	}
	return Entry{}, Provider{}, fmt.Errorf("%w: %s", ErrNoModel, id)
}

// authorize põe a credencial no request sem que ela apareça aqui.
func (r *Router) authorize(provider Provider, request *http.Request, header string, prefix string) error {
	if provider.SecretRef == "" || provider.Kind == KindLocal {
		return nil
	}
	if r.keys == nil {
		return fmt.Errorf("cofre indisponível para o provedor %s", provider.ID)
	}
	return r.keys.Use(provider.SecretRef, func(secret string) error {
		request.Header.Set(header, prefix+secret)
		return nil
	})
}

// endpoint junta a base com o caminho sem duplicar barra.
func endpoint(baseURL, path string) string {
	return strings.TrimRight(baseURL, "/") + path
}
