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
	KindOpenAI Kind = "openai"
	// KindXAI fala o dialeto OpenAI, mas fica explícito no catálogo para que a
	// interface ofereça a configuração pronta do Grok e para que ajustes
	// específicos da xAI (como afinidade de conversa) não vazem para todos os
	// provedores compatíveis.
	KindXAI        Kind = "xai"
	KindAnthropic  Kind = "anthropic"
	KindGemini     Kind = "gemini"
	KindCompatible Kind = "openai-compatible"
	// KindLocal é o servidor de modelo na própria estação. Fala OpenAI, mas
	// merece tipo próprio: ele não sai da máquina, então não passa por blocklist
	// nem conta custo — e confundir os dois faria o app cobrar por token local.
	KindLocal Kind = "local"
)

// AdapterOptions é o contrato entre um plugin de provedor e o roteador. O
// core conhece protocolos estáveis; nomes comerciais (xai, outro compatível)
// registram qual protocolo usam e ajustes estreitos, sem ganhar um switch novo.
type AdapterOptions struct {
	Protocol           string `json:"protocol"`
	ConversationHeader string `json:"conversationHeader,omitempty"`
	ImageProtocol      string `json:"imageProtocol,omitempty"`
}

const (
	ProtocolOpenAI    = "openai"
	ProtocolAnthropic = "anthropic"
	ProtocolGemini    = "gemini"
)

type adapterRegistration struct {
	options AdapterOptions
	owner   string
	token   uint64
}

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
	// ConversationID mantém chamadas da mesma conversa na mesma afinidade do
	// provedor quando ele oferece esse recurso. Não faz parte do corpo nem do
	// prompt e pode ficar vazio em classificadores e tarefas avulsas.
	ConversationID string
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
	// layers é a composição do catálogo. Provedores embutidos, plugins e a
	// configuração da pessoa vivem em camadas separadas; prioridade maior
	// sobrepõe a menor pelo id. Assim descarregar um plugin revela a camada de
	// baixo em vez de reconstruir o roteador inteiro.
	layers map[string]catalogLayer
	// adapters é a costura definição/provedor/consumidor: o catálogo declara o
	// kind, um plugin fornece o adaptador e Stream/GenerateImage o consomem.
	adapters   map[Kind]adapterRegistration
	adapterSeq uint64
	// allowed limita o catálogo ao que a política liberou. nil = ninguém
	// configurou (tudo passa); mapa vazio = a política liberou NADA. Ver
	// SetAllowed para o porquê de os dois não serem a mesma coisa.
	allowed map[string]bool
}

type catalogLayer struct {
	priority  int
	providers []Provider
	models    []Entry
}

const userCatalogLayer = "user-catalog"

// New monta o roteador.
func New(client *http.Client, keys KeyProvider) *Router {
	if client == nil {
		client = http.DefaultClient
	}
	router := &Router{
		client:    client,
		keys:      keys,
		providers: make(map[string]Provider),
		layers:    make(map[string]catalogLayer),
		adapters:  make(map[Kind]adapterRegistration),
	}
	router.registerCoreAdapter(KindOpenAI, AdapterOptions{Protocol: ProtocolOpenAI, ImageProtocol: ProtocolOpenAI})
	router.registerCoreAdapter(KindCompatible, AdapterOptions{Protocol: ProtocolOpenAI, ImageProtocol: ProtocolOpenAI})
	router.registerCoreAdapter(KindLocal, AdapterOptions{Protocol: ProtocolOpenAI, ImageProtocol: ProtocolOpenAI})
	router.registerCoreAdapter(KindAnthropic, AdapterOptions{Protocol: ProtocolAnthropic})
	router.registerCoreAdapter(KindGemini, AdapterOptions{Protocol: ProtocolGemini, ImageProtocol: ProtocolGemini})
	return router
}

func (r *Router) registerCoreAdapter(kind Kind, options AdapterOptions) {
	r.adapterSeq++
	r.adapters[kind] = adapterRegistration{options: options, owner: "core", token: r.adapterSeq}
}

// RegisterAdapter publica um dialeto com dono e devolve seu efeito reversível.
// Colisão é recusada para que a ordem de montagem não escolha silenciosamente
// qual implementação recebe prompt e credencial.
func (r *Router) RegisterAdapter(owner string, kind Kind, options AdapterOptions) (func(), error) {
	owner = strings.TrimSpace(owner)
	if owner == "" || strings.TrimSpace(string(kind)) == "" {
		return nil, errors.New("adaptador exige owner e kind")
	}
	switch options.Protocol {
	case ProtocolOpenAI, ProtocolAnthropic, ProtocolGemini:
	default:
		return nil, fmt.Errorf("protocolo de adaptador desconhecido: %q", options.Protocol)
	}
	if options.ImageProtocol != "" && options.ImageProtocol != ProtocolOpenAI && options.ImageProtocol != ProtocolGemini {
		return nil, fmt.Errorf("protocolo de imagem desconhecido: %q", options.ImageProtocol)
	}
	r.mu.Lock()
	if current, exists := r.adapters[kind]; exists {
		r.mu.Unlock()
		return nil, fmt.Errorf("adaptador %s já pertence a %s", kind, current.owner)
	}
	r.adapterSeq++
	token := r.adapterSeq
	r.adapters[kind] = adapterRegistration{options: options, owner: owner, token: token}
	r.mu.Unlock()
	return func() {
		r.mu.Lock()
		defer r.mu.Unlock()
		current, exists := r.adapters[kind]
		if exists && current.owner == owner && current.token == token {
			delete(r.adapters, kind)
		}
	}, nil
}

func (r *Router) adapterFor(kind Kind) (AdapterOptions, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	adapter, ok := r.adapters[kind]
	return adapter.options, ok
}

/* ------------------------------- catálogo ------------------------------- */

// SetProviders substitui a lista de provedores.
func (r *Router) SetProviders(list []Provider) {
	r.mu.Lock()
	defer r.mu.Unlock()
	layer := r.layers[userCatalogLayer]
	layer.priority = 100
	layer.providers = cloneProviders(list)
	r.layers[userCatalogLayer] = layer
	r.rebuildCatalogLocked()
}

// SetModels substitui o catálogo.
func (r *Router) SetModels(list []Entry) {
	r.mu.Lock()
	defer r.mu.Unlock()
	layer := r.layers[userCatalogLayer]
	layer.priority = 100
	layer.models = cloneEntries(list)
	r.layers[userCatalogLayer] = layer
	r.rebuildCatalogLocked()
}

// SetCatalogLayer monta ou substitui uma camada inteira do catálogo.
//
// É a costura usada pelo kernel de plugins. A contribuição é copiada antes de
// ser publicada, e provider/model com o mesmo id numa camada de prioridade
// maior substitui a definição de baixo. Nome vazio é recusado para que toda
// contribuição tenha um dono descarregável.
func (r *Router) SetCatalogLayer(name string, priority int, providers []Provider, models []Entry) error {
	name = strings.TrimSpace(name)
	if name == "" || name == userCatalogLayer {
		return fmt.Errorf("camada de catálogo inválida: %q", name)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.layers[name] = catalogLayer{
		priority: priority, providers: cloneProviders(providers), models: cloneEntries(models),
	}
	r.rebuildCatalogLocked()
	return nil
}

// RemoveCatalogLayer descarrega uma contribuição. É idempotente: o `dispose`
// do plugin pode ser repetido durante recuperação de erro sem remover outra
// camada por acidente.
func (r *Router) RemoveCatalogLayer(name string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.layers, strings.TrimSpace(name))
	r.rebuildCatalogLocked()
}

// Configuration devolve a composição completa, inclusive itens ainda sem
// chave. A tela administrativa usa esta visão; Catalog continua sendo a lista
// utilizável que o seletor de modelo enxerga.
func (r *Router) Configuration() ([]Provider, []Entry) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	providers := make([]Provider, 0, len(r.providers))
	for _, provider := range r.providers {
		providers = append(providers, provider)
	}
	sort.Slice(providers, func(i, j int) bool { return providers[i].ID < providers[j].ID })
	return providers, cloneEntries(r.models)
}

// ProviderConfig devolve um provedor da composição sem expor segredo (a struct
// só carrega SecretRef). Permite à tela materializar um override de um
// provedor trazido por plugin quando a pessoa salva chave/estado.
func (r *Router) ProviderConfig(id string) (Provider, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	provider, ok := r.providers[id]
	return provider, ok
}

func (r *Router) rebuildCatalogLocked() {
	type namedLayer struct {
		name string
		catalogLayer
	}
	layers := make([]namedLayer, 0, len(r.layers))
	for name, layer := range r.layers {
		layers = append(layers, namedLayer{name: name, catalogLayer: layer})
	}
	sort.SliceStable(layers, func(i, j int) bool {
		if layers[i].priority != layers[j].priority {
			return layers[i].priority < layers[j].priority
		}
		return layers[i].name < layers[j].name
	})

	providers := make(map[string]Provider)
	models := make(map[string]Entry)
	for _, layer := range layers {
		for _, provider := range layer.providers {
			providers[provider.ID] = provider
		}
		for _, entry := range layer.models {
			models[entry.ID] = entry
		}
	}
	r.providers = providers
	r.models = make([]Entry, 0, len(models))
	for _, entry := range models {
		r.models = append(r.models, entry)
	}
	sort.SliceStable(r.models, func(i, j int) bool {
		if r.models[i].ProviderID != r.models[j].ProviderID {
			return r.models[i].ProviderID < r.models[j].ProviderID
		}
		return r.models[i].Label < r.models[j].Label
	})
}

func cloneProviders(list []Provider) []Provider {
	if len(list) == 0 {
		return nil
	}
	out := make([]Provider, len(list))
	copy(out, list)
	return out
}

func cloneEntries(list []Entry) []Entry {
	if len(list) == 0 {
		return nil
	}
	out := make([]Entry, len(list))
	copy(out, list)
	for i := range out {
		out[i].Skills = append([]string(nil), list[i].Skills...)
	}
	return out
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

	adapter, ok := r.adapterFor(provider.Kind)
	if !ok {
		return Usage{}, fmt.Errorf("nenhum plugin fornece adaptador para o provedor %s (%s)", provider.ID, provider.Kind)
	}
	switch adapter.Protocol {
	case ProtocolAnthropic:
		return r.streamAnthropic(ctx, provider, entry, request, sink)
	case ProtocolGemini:
		return r.streamGemini(ctx, provider, entry, request, sink)
	case ProtocolOpenAI:
		return r.streamOpenAI(ctx, provider, entry, request, sink, adapter)
	default:
		return Usage{}, fmt.Errorf("plugin do provedor %s registrou protocolo desconhecido: %s", provider.ID, adapter.Protocol)
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
