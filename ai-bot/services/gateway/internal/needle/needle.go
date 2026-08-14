// Package needle é o segundo degrau do roteamento: um modelo de linguagem
// MINÚSCULO rodando dentro do processo Go, na máquina da pessoa.
//
// Por que existe um degrau entre o léxico e o modelo grande. O fast router
// acerta o pedido escrito de forma previsível ("corrige o bug de compilação") e
// erra o escrito de qualquer outro jeito ("isso aqui tá estourando quando eu
// clico"). Mandar esse caso para o modelo grande funciona e custa: uma ida à
// rede, alguns segundos ANTES de a primeira letra da resposta aparecer, tokens
// cobrados, e uma dependência de conectividade para uma decisão que é de
// classificação, não de raciocínio.
//
// O Needle 2 (cactus-compute/needle) é um modelo de 45 M de parâmetros, ~14 MB,
// que roda uma sessão em torno de 28 MB de RAM e faz chamada de ferramenta no
// formato function-calling da OpenAI. Para "escolher entre cinco opções a
// partir de uma frase", isso é exatamente do tamanho do problema — e roda em
// milissegundos, offline, sem custo por token.
//
// A biblioteca é NATIVA (needle.dll / libneedle.so / libneedle.dylib) e entra
// por cgo. Duas consequências que este arquivo trata de propósito:
//
//  1. Ela NÃO faz parte do build padrão. O binding de verdade está em
//     session_cgo.go, sob a tag `needle`; sem a tag, o que compila é o esboço
//     de session_stub.go, `Ready()` devolve false e a cascata pula o degrau.
//     Assim o gateway continua compilando e rodando numa máquina sem a
//     biblioteca — e `CGO_ENABLED=0` continua produzindo um binário estático.
//
//  2. É dependência de TERCEIRO em processo que decide roteamento. Pela
//     política da casa (item 4) e pela regra do próprio repositório, ela precisa
//     passar por TI/SI antes de virar padrão. A tag de build é também isso: um
//     interruptor que ninguém liga por engano.
//
// Ver docs/arquitetura.md e docs/creditos-inspiracao.md.
package needle

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"

	"aibot/gateway/internal/specialist"
)

// ErrUnavailable diz que a biblioteca nativa não está no binário ou não carregou.
var ErrUnavailable = errors.New("o roteador local (Needle) não está disponível neste build")

// Options configura a sessão.
type Options struct {
	// ModelPath é o arquivo do modelo. Vazio = o caminho padrão ao lado do
	// executável (models/needle2.bin).
	ModelPath string
	// Threads limita o paralelismo. Zero = decisão da biblioteca.
	Threads int
	// MaxTokens limita a resposta. O veredito é um objeto de três campos; teto
	// baixo impede o modelo de "explicar" em vez de classificar.
	MaxTokens int
}

// Verdict é o que o roteador local devolve.
type Verdict struct {
	Specialist string  `json:"specialist"`
	Confidence float64 `json:"confidence"`
}

// Tool é uma ferramenta declarada ao modelo, no formato function-calling.
//
// Um especialista vira UMA ferramenta sem argumento: o nome dela É a decisão.
// Alternativa considerada e descartada: uma única ferramenta `route` com um
// argumento enum. Ela cabe em qualquer número de especialistas, mas joga a
// escolha para dentro de um campo de string livre — enquanto o esquema de
// ferramentas vira gramática na decodificação, e gramática não permite que o
// modelo invente um nome que não existe.
type Tool struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Parameters  map[string]any `json:"parameters"`
}

// ToolsFor converte os especialistas candidatos em ferramentas.
//
// A descrição é o que o modelo lê para decidir, então ela junta o nome, a
// vocação e os radicais que o fast router usa: os radicais são exatamente o
// vocabulário do domínio, e repeti-los aqui dá ao modelo o mesmo sinal que a
// heurística tinha, em prosa.
func ToolsFor(candidates []specialist.Definition) []Tool {
	tools := make([]Tool, 0, len(candidates))
	for _, definition := range candidates {
		description := definition.Name + " — " + definition.Tagline
		if len(definition.Triggers) > 0 {
			sample := definition.Triggers
			if len(sample) > 12 {
				sample = sample[:12]
			}
			description += ". Assuntos: " + strings.Join(sample, ", ")
		}
		tools = append(tools, Tool{
			Name:        definition.ID,
			Description: description,
			// Sem argumento: a escolha é o nome da ferramenta. Um objeto vazio,
			// e não `nil`, porque o formato function-calling espera um esquema.
			Parameters: map[string]any{"type": "object", "properties": map[string]any{}},
		})
	}
	return tools
}

// Response é o formato que o Needle devolve, no dialeto function-calling.
type Response struct {
	Type          string `json:"type"`
	FunctionCalls []struct {
		Name      string         `json:"name"`
		Arguments map[string]any `json:"arguments"`
	} `json:"function_calls"`
	Confidence float64 `json:"confidence"`
	// Content vem quando o modelo respondeu texto em vez de chamar ferramenta —
	// que aqui é uma não-resposta e sobe para o degrau seguinte.
	Content string `json:"content"`
}

// ParseResponse traduz a resposta bruta em veredito.
//
// Exportada e pura para ter teste sem a biblioteca nativa: o formato é o que
// mais tende a mudar entre versões do modelo, e é o que dá para fixar por teste
// sem carregar 14 MB de pesos.
func ParseResponse(raw string, allowed []specialist.Definition) (Verdict, error) {
	response, err := decodeResponse(raw)
	if err != nil {
		return Verdict{}, err
	}
	if len(response.FunctionCalls) == 0 {
		return Verdict{}, fmt.Errorf("o roteador local não escolheu ferramenta: %q", truncate(response.Content, 160))
	}

	chosen := strings.ToLower(strings.TrimSpace(response.FunctionCalls[0].Name))
	if !containsID(allowed, chosen) {
		// O modelo escolheu algo fora da lista declarada. Não é para acontecer
		// (a gramática restringe), mas confiar nisso é confiar num detalhe de
		// implementação de terceiro sobre a decisão de roteamento do produto.
		return Verdict{}, fmt.Errorf("o roteador local indicou %q, que não estava entre os candidatos", chosen)
	}

	confidence := response.Confidence
	switch {
	case confidence <= 0:
		// Sem número, o veredito não é comparável ao limiar. Tratar ausência
		// como certeza faria toda resposta sem `confidence` passar direto.
		confidence = 0
	case confidence > 1:
		confidence = 1
	}
	return Verdict{Specialist: chosen, Confidence: confidence}, nil
}

// decodeResponse extrai o objeto JSON mesmo quando o modelo escreve algo antes
// ou embrulha em cerca de código.
//
// Modelo pequeno desvia do formato com mais frequência que modelo grande, e
// falhar o roteamento inteiro porque vieram três palavras antes da chave seria
// desperdiçar uma decisão que já estava certa.
func decodeResponse(raw string) (Response, error) {
	text := strings.TrimSpace(raw)
	if text == "" {
		return Response{}, errors.New("o roteador local respondeu vazio")
	}
	start := strings.Index(text, "{")
	end := strings.LastIndex(text, "}")
	if start < 0 || end <= start {
		return Response{}, fmt.Errorf("o roteador local não devolveu JSON: %q", truncate(text, 160))
	}
	var response Response
	if err := json.Unmarshal([]byte(text[start:end+1]), &response); err != nil {
		return Response{}, fmt.Errorf("json do roteador local inválido: %w", err)
	}
	return response, nil
}

func containsID(list []specialist.Definition, id string) bool {
	for _, definition := range list {
		if definition.ID == id {
			return true
		}
	}
	return false
}

// SortByName deixa a lista de ferramentas estável entre execuções. Ordem de
// ferramenta influencia a decodificação; sem ordem fixa, o mesmo pedido pode
// cair em especialistas diferentes entre duas execuções — e isso é o tipo de
// não-determinismo que ninguém consegue depurar depois.
func SortByName(tools []Tool) {
	sort.SliceStable(tools, func(i, j int) bool { return tools[i].Name < tools[j].Name })
}

func truncate(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	cut := limit
	for cut > 0 && text[cut]&0xC0 == 0x80 {
		cut--
	}
	return text[:cut] + "…"
}

// Classify é a operação completa: declara os candidatos como ferramentas, chama
// o modelo e traduz a resposta.
//
// O adaptador para a interface do supervisor NÃO mora aqui — ele está em
// internal/supervisor/needle.go. A direção da dependência é essa de propósito:
// o pacote de baixo não conhece quem o usa, e assim ele compila e é testável
// sozinho, com ou sem cgo.
func (s *Session) Classify(
	ctx context.Context,
	prompt string,
	candidates []specialist.Definition,
) (Verdict, error) {
	if s == nil || !s.Ready() {
		return Verdict{}, ErrUnavailable
	}
	tools := ToolsFor(candidates)
	SortByName(tools)

	raw, err := s.Call(ctx, prompt, tools)
	if err != nil {
		return Verdict{}, err
	}
	return ParseResponse(raw, candidates)
}
