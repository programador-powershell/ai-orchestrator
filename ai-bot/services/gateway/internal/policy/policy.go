// Package policy liga a política do admin ao que o gateway realmente faz.
//
// Ele tem duas responsabilidades, e as duas nasceram do mesmo defeito: uma
// política que existe em struct mas não tem nenhum chamador é uma política
// decorativa. `permissions.Policy` já descrevia o que a estação pode, mas nada
// a buscava, e `AIBOT_MANAGED` só trocava o modo de aprovação — o BYOK local
// continuava disponível numa edição documentada como "sem BYOK direto e sem
// runtime local".
//
// As duas responsabilidades:
//
//  1. RestrictManaged — o padrão da edição gerenciada ENQUANTO não há política
//     remota. É restritivo por definição: derruba o provedor local e todo modelo
//     marcado como local. Subir aberto "só até sincronizar" é subir aberto — a
//     janela entre o boot e o primeiro sync é exatamente quando ninguém está
//     olhando.
//
//  2. Start — a busca da política remota, em segundo plano e com refresh
//     periódico. Falha de busca NÃO derruba o boot e NÃO relaxa nada: o padrão
//     restritivo do item 1 continua valendo. Indisponibilidade do servidor de
//     política não pode virar liberação, que é como a maioria dos sistemas de
//     política falha na prática.
//
// A URL da política vem de fora, então a busca passa pelo netguard como
// qualquer outra: um servidor de política apontado para 169.254.169.254 seria
// SSRF com crachá.
package policy

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"aibot/gateway/internal/modelrouter"
	"aibot/gateway/internal/permissions"
)

/* --------------------------- padrão gerenciado --------------------------- */

// RestrictManaged devolve os provedores e a lista de modelos permitidos da
// edição gerenciada.
//
// O corte é o BYOK local, e é feito em DOIS lugares de propósito:
//
//   - o provedor de Kind local sai desabilitado — é o corte que vale mesmo que
//     a política remota chegue depois liberando um id local;
//   - todo modelo com `Local: true` fica fora da lista permitida — é o corte que
//     pega o modelo local servido por um provedor "openai-compatible" apontado
//     para 127.0.0.1, que não tem Kind local nenhum.
//
// A lista devolvida é sempre não-nula, inclusive quando fica vazia: no
// vocabulário de modelrouter.SetAllowed, vazia significa "nenhum modelo", e é
// esse o desfecho correto para um catálogo que só tem modelo local numa estação
// gerenciada. Devolver nil ali liberaria o catálogo inteiro.
func RestrictManaged(providers []modelrouter.Provider, catalog []modelrouter.Entry) ([]modelrouter.Provider, []string) {
	out := make([]modelrouter.Provider, len(providers))
	copy(out, providers)
	local := make(map[string]bool, len(out))
	for i := range out {
		if out[i].Kind == modelrouter.KindLocal {
			local[out[i].ID] = true
			out[i].Enabled = false
		}
	}

	allowed := make([]string, 0, len(catalog))
	for _, entry := range catalog {
		if entry.Local || local[entry.ProviderID] {
			continue
		}
		allowed = append(allowed, entry.ID)
	}
	return out, allowed
}

/* ---------------------------- política remota ---------------------------- */

// Document é a forma do JSON servido em AIBOT_POLICY_URL: os campos de
// permissions.Policy mais `allowedModels`.
//
// Campo AUSENTE mantém o que já valia — e o que já valia é o padrão restritivo
// do RestrictManaged. Essa regra é o que impede o modo de falha clássico: um
// documento incompleto (ou truncado, ou de uma versão mais nova do servidor)
// não pode zerar restrição que estava de pé.
type Document struct {
	Mode               string   `json:"mode"`
	AllowedSpecialists []string `json:"allowedSpecialists"`
	// AllowedModels distingue ausente de vazio pelo mesmo motivo do campo
	// homônimo em permissions.Policy: `{}` mantém a lista atual, `[]` é o admin
	// dizendo "nenhum modelo". encoding/json entrega nil no primeiro caso e uma
	// fatia de tamanho zero no segundo, então a diferença sobrevive ao parse.
	AllowedModels  []string `json:"allowedModels"`
	DeniedTools    []string `json:"deniedTools"`
	BlockedDomains []string `json:"blockedDomains"`
	// AgentTools é ponteiro porque o zero de bool é "nenhuma ferramenta": um
	// documento que esquece o campo desligaria o produto inteiro em silêncio.
	AgentTools  *bool `json:"agentTools"`
	MaxDepth    int   `json:"maxDepth"`
	MaxChildren int   `json:"maxChildren"`
	MaxTotal    int   `json:"maxTotal"`
}

// Apply sobrepõe o documento à política base e devolve a política resultante.
// É pura: o teste dela não precisa de rede, e o Start só a chama.
func (d Document) Apply(base permissions.Policy) permissions.Policy {
	if mode := strings.ToLower(strings.TrimSpace(d.Mode)); mode != "" {
		// Modo desconhecido NÃO é rejeitado aqui: permissions.Evaluate já trata
		// o que não reconhece como "perguntar sempre". Filtrar por uma lista
		// fechada neste ponto faria um modo novo do servidor cair no modo BASE,
		// que pode ser mais frouxo do que o desconhecido.
		base.Mode = permissions.Mode(mode)
	}
	if d.AllowedSpecialists != nil {
		base.AllowedSpecialists = d.AllowedSpecialists
	}
	if d.AllowedModels != nil {
		base.AllowedModels = d.AllowedModels
	}
	if d.DeniedTools != nil {
		base.DeniedTools = d.DeniedTools
	}
	if d.BlockedDomains != nil {
		base.BlockedDomains = d.BlockedDomains
	}
	if d.AgentTools != nil {
		base.AgentTools = *d.AgentTools
	}
	// Teto zero ou negativo é campo ausente, não "sem teto": delegação sem teto é
	// recursão dirigida por modelo, e o custo de uma execução deixa de ter fim
	// conhecido.
	if d.MaxDepth > 0 {
		base.MaxDepth = d.MaxDepth
	}
	if d.MaxChildren > 0 {
		base.MaxChildren = d.MaxChildren
	}
	if d.MaxTotal > 0 {
		base.MaxTotal = d.MaxTotal
	}
	return base
}

// Fetcher é o netguard visto daqui: só o GET guardado. Interface, e não o tipo
// concreto, para o teste poder falar com um httptest — que escuta em loopback e
// seria (corretamente) recusado pelo guarda de verdade.
type Fetcher interface {
	Fetch(ctx context.Context, url string, header http.Header) (*http.Response, []byte, error)
}

// PolicySink recebe a política de ferramentas. `*permissions.Gate` satisfaz.
type PolicySink interface {
	SetPolicy(permissions.Policy)
}

// ModelSink recebe a lista de modelos liberados. `*modelrouter.Router` satisfaz.
type ModelSink interface {
	SetAllowed([]string)
}

// Options é o que o Start precisa saber.
type Options struct {
	// URL é AIBOT_POLICY_URL. Vazia desliga a busca.
	URL string
	// Base é o que vale enquanto (e sempre que) a busca falha. Em estação
	// gerenciada é o resultado do RestrictManaged.
	Base    permissions.Policy
	Fetcher Fetcher
	Gate    PolicySink
	Models  ModelSink
	// Interval é o refresh. Zero cai em DefaultInterval.
	Interval time.Duration
	Log      *slog.Logger
}

// DefaultInterval é o refresh da política. Quinze minutos é curto o bastante
// para uma revogação valer no mesmo turno de trabalho e longo o bastante para
// mil estações não virarem carga no servidor de política.
const DefaultInterval = 15 * time.Minute

// fetchTimeout limita UMA busca. Sem ele, um servidor de política que aceita a
// conexão e nunca responde prende a goroutine até o fim do processo — e o
// refresh nunca mais acontece.
const fetchTimeout = 20 * time.Second

// Start dispara a sincronização em segundo plano e devolve na hora.
//
// NÃO é bloqueante no boot, e isso é decisão de produto, não preguiça: o app
// precisa abrir offline. Um gateway que espera a política para escutar na porta
// é um gateway que não sobe no notebook em viagem, na VPN caída ou no dia em
// que o servidor de política está em manutenção — e o efeito prático seria o
// usuário desligar AIBOT_MANAGED para conseguir trabalhar, que é o pior desfecho
// possível para a política.
//
// O preço dessa escolha é a janela entre o boot e o primeiro sync, e é por isso
// que o padrão gerenciado precisa ser restritivo: durante a janela vale a Base.
func Start(ctx context.Context, opts Options) {
	if opts.URL == "" || opts.Fetcher == nil {
		return
	}
	if opts.Interval <= 0 {
		opts.Interval = DefaultInterval
	}
	log := opts.Log
	if log == nil {
		log = slog.Default()
	}

	go func() {
		ticker := time.NewTicker(opts.Interval)
		defer ticker.Stop()
		for {
			syncOnce(ctx, opts, log)
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
}

// syncOnce é uma passada com o resultado no log. A parte testável é o Sync, que
// devolve erro em vez de escrever.
func syncOnce(ctx context.Context, opts Options, log *slog.Logger) {
	policy, err := Sync(ctx, opts)
	if err != nil {
		// A URL não vai para o log: link de política costuma carregar token na
		// query, e o log de boot vira anexo de chamado.
		log.Warn("política remota indisponível — seguindo com o padrão local restritivo",
			"motivo", err, "modelos_liberados", describeAllowed(opts.Base.AllowedModels))
		return
	}
	log.Info("política remota aplicada",
		"modo", string(policy.Mode), "modelos_liberados", describeAllowed(policy.AllowedModels))
}

// Sync busca, aplica e devolve a política em vigor. Erro significa que NADA foi
// aplicado — o estado anterior continua de pé.
//
// Cada passada aplica o documento sobre a Base ORIGINAL, nunca sobre o resultado
// da passada anterior. É o que faz uma restrição sumir do documento remoto
// voltar ao padrão restritivo em vez de manter o valor mais frouxo de quinze
// minutos atrás — política acumulada só sabe afrouxar.
func Sync(ctx context.Context, opts Options) (permissions.Policy, error) {
	if opts.URL == "" {
		return opts.Base, nil
	}
	if opts.Fetcher == nil {
		return opts.Base, fmt.Errorf("sem canal de rede guardado para buscar a política")
	}

	fetchCtx, cancel := context.WithTimeout(ctx, fetchTimeout)
	defer cancel()

	header := http.Header{}
	header.Set("Accept", "application/json")
	response, body, err := opts.Fetcher.Fetch(fetchCtx, opts.URL, header)
	if err != nil {
		return opts.Base, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return opts.Base, fmt.Errorf("o servidor de política respondeu %d", response.StatusCode)
	}

	var document Document
	if err := json.Unmarshal(body, &document); err != nil {
		// Documento ilegível é indisponibilidade, não permissão: cai fora sem
		// aplicar nada e a Base segue valendo.
		return opts.Base, fmt.Errorf("ler a política: %w", err)
	}

	applied := document.Apply(opts.Base)
	if opts.Gate != nil {
		opts.Gate.SetPolicy(applied)
	}
	if opts.Models != nil {
		opts.Models.SetAllowed(applied.AllowedModels)
	}
	return applied, nil
}

// describeAllowed conta a lista sem despejá-la inteira no log.
func describeAllowed(list []string) string {
	if list == nil {
		return "todos"
	}
	if len(list) == 0 {
		return "nenhum"
	}
	return fmt.Sprintf("%d", len(list))
}
