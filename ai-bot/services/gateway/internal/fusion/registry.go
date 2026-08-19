package fusion

import (
	"strings"
	"sync"
)

// Prefixo do valor que diz "este especialista responde com fusion".
//
// A escolha de modelo e a de fusion dividem o MESMO campo por especialista,
// porque na vida real elas são a mesma decisão: ou o bot responde com um modelo,
// ou responde com um painel. Dois campos permitiriam configurar os dois e
// deixariam a pergunta "qual vence?" para o código responder em silêncio.
//
// A convenção veio do orquestrador, onde a seleção de motor é
// `fusion:<id do preset>`.
const AssignPrefix = "fusion:"

// AssignedPreset extrai o id do preset de um valor de atribuição.
func AssignedPreset(value string) (string, bool) {
	if !strings.HasPrefix(value, AssignPrefix) {
		return "", false
	}
	id := strings.TrimSpace(strings.TrimPrefix(value, AssignPrefix))
	return id, id != ""
}

// Registry guarda os presets e quem usa cada um.
//
// Vive no processo e é trocado a quente pela rota do catálogo — a mesma ideia
// do roteador de modelos: o arquivo é a fonte, e o que decide o turno é o que
// está carregado.
type Registry struct {
	mu       sync.RWMutex
	presets  map[string]Preset
	ordem    []string
	atribuic map[string]string
}

// NewRegistry devolve um registro vazio: sem preset configurado, todo turno
// segue com um modelo só, que é o padrão do produto.
func NewRegistry() *Registry {
	return &Registry{presets: map[string]Preset{}, atribuic: map[string]string{}}
}

// SetPresets troca a lista inteira, preservando a ordem em que veio (é a ordem
// que a tela mostra).
func (r *Registry) SetPresets(list []Preset) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.presets = make(map[string]Preset, len(list))
	r.ordem = r.ordem[:0]
	for _, preset := range list {
		id := strings.TrimSpace(preset.ID)
		if id == "" {
			continue
		}
		preset.ID = id
		if !preset.Strategy.Valid() {
			preset.Strategy = StrategyMerge
		}
		if _, repetido := r.presets[id]; repetido {
			continue
		}
		r.presets[id] = preset
		r.ordem = append(r.ordem, id)
	}
}

// SetAssignments recebe o mapa especialista → valor (modelo ou `fusion:<id>`).
// Só as entradas de fusion interessam aqui; as de modelo são do roteador.
func (r *Registry) SetAssignments(byID map[string]string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.atribuic = make(map[string]string, len(byID))
	for specialist, valor := range byID {
		if id, ok := AssignedPreset(valor); ok {
			r.atribuic[strings.TrimSpace(specialist)] = id
		}
	}
}

// Presets devolve a lista na ordem de exibição.
func (r *Registry) Presets() []Preset {
	r.mu.RLock()
	defer r.mu.RUnlock()
	saida := make([]Preset, 0, len(r.ordem))
	for _, id := range r.ordem {
		saida = append(saida, r.presets[id])
	}
	return saida
}

// Has diz se o preset existe — é o que a borda usa para recusar uma atribuição
// que nasceria morta.
func (r *Registry) Has(id string) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	_, ok := r.presets[id]
	return ok
}

// PresetFor devolve o preset do especialista.
//
// Preset que sumiu depois de atribuído devolve `false`, e o turno segue com um
// modelo só: configuração velha não pode derrubar conversa.
func (r *Registry) PresetFor(specialist string) (Preset, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	id, atribuido := r.atribuic[specialist]
	if !atribuido {
		return Preset{}, false
	}
	preset, existe := r.presets[id]
	return preset, existe
}
