// Fusion adaptativo — o ORQUESTRADOR decide, por complexidade, quantos
// executores acionar e o foco de cada um.
//
// Porte de `apps/desktop/src/lib/fusionPlan.ts`. Nada é fixo: pergunta simples
// usa 1 executor; problema complexo abre um painel. É essa adaptação que impede
// o fusion de virar imposto — pagar três modelos para responder "que horas
// são?" seria o modo mais caro de fazer a coisa mais barata.
package fusion

import (
	"encoding/json"
	"regexp"
	"strings"

	"aibot/gateway/internal/modelrouter"
)

// ExecutorSpec é um executor planejado: o papel que aparece no cartão e o
// recorte exclusivo dele.
type ExecutorSpec struct {
	Role  string `json:"role"`
	Focus string `json:"focus"`
}

// Plan é o que o orquestrador decidiu.
type Plan struct {
	// Complexity vai de 0 a 1, estimada pelo orquestrador.
	Complexity float64        `json:"complexity"`
	Executors  []ExecutorSpec `json:"executors"`
}

var (
	multiTarefa = regexp.MustCompile(`(?i)\b(e também|além de|compare|comparar|vantagens e|prós e contras|passo a passo|arquitetura|trade-?offs?)\b`)
	analitico   = regexp.MustCompile(`(?i)\b(analis|avali|critiqu|revis|audit|risco|seguran)`)
	enumerativo = regexp.MustCompile(`(?i)\b(liste|enumere|várias|múltipl)`)
)

// ClassifyComplexity é a heurística barata (0..1), usada como PISO e como
// resposta quando o orquestrador não devolve JSON.
//
// Sinais: tamanho, conjunções de multi-tarefa, pedidos de comparação, análise ou
// código. Os pesos vieram do orquestrador sem alteração — mexer neles muda
// quantos modelos a pessoa paga por pergunta.
func ClassifyComplexity(question string) float64 {
	texto := strings.ToLower(question)
	score := 0.2
	if len(question) > 240 {
		score += 0.2
	}
	if len(question) > 800 {
		score += 0.2
	}
	if multiTarefa.MatchString(texto) {
		score += 0.2
	}
	if analitico.MatchString(texto) {
		score += 0.15
	}
	if strings.Count(texto, "?") > 1 {
		score += 0.1
	}
	if enumerativo.MatchString(texto) {
		score += 0.1
	}
	if score > 1 {
		return 1
	}
	return score
}

// SuggestedExecutorCount traduz complexidade em tamanho de painel.
func SuggestedExecutorCount(complexity float64, maxExecutors int) int {
	teto := maxExecutors
	if teto < 1 {
		teto = 1
	}
	switch {
	case complexity < 0.3:
		return 1
	case complexity < 0.6:
		return min(2, teto)
	case complexity < 0.85:
		return min(3, teto)
	default:
		return min(4, teto)
	}
}

// AdaptivePlanRequest pede o plano ao orquestrador.
func AdaptivePlanRequest(specialist, question string, maxExecutors int) []modelrouter.ChatMessage {
	policy := RolePolicy(specialist)
	teto := maxExecutors
	if teto < 1 {
		teto = 1
	}
	return []modelrouter.ChatMessage{
		{Role: "system", Content: policy.OrchestratorRole + "\n\n" +
			"Avalie a COMPLEXIDADE do pedido (0 a 1) e decida quantos executores acionar " +
			"(1 = pergunta simples; até " + itoa(teto) + " = problema complexo). " +
			"Para cada executor, defina um PAPEL curto e um FOCO exclusivo e complementar (sem sobreposição). " +
			"Responda APENAS com um bloco ```json: {\"complexity\": number, \"executors\": [{\"role\": \"...\", \"focus\": \"...\"}]}. " +
			"Não responda a pergunta — apenas o plano."},
		{Role: "user", Content: question},
	}
}

var cercado = regexp.MustCompile("(?s)```(?:json)?\\s*(.*?)```")

// ParsePlan lê o plano do orquestrador. Devolve false quando o texto não traz
// plano utilizável — aí o chamador usa FallbackPlan.
func ParsePlan(text string, maxExecutors int) (Plan, bool) {
	bruto := text
	if m := cercado.FindStringSubmatch(text); m != nil {
		bruto = m[1]
	}
	inicio := strings.Index(bruto, "{")
	fim := strings.LastIndex(bruto, "}")
	if inicio < 0 || fim <= inicio {
		return Plan{}, false
	}

	var lido struct {
		Complexity *float64       `json:"complexity"`
		Executors  []ExecutorSpec `json:"executors"`
	}
	if err := json.Unmarshal([]byte(bruto[inicio:fim+1]), &lido); err != nil {
		return Plan{}, false
	}

	teto := maxExecutors
	if teto < 1 {
		teto = 1
	}
	executores := make([]ExecutorSpec, 0, len(lido.Executors))
	for _, item := range lido.Executors {
		foco := strings.TrimSpace(item.Focus)
		if foco == "" {
			continue
		}
		papel := strings.TrimSpace(item.Role)
		if papel == "" {
			papel = "Executor"
		}
		executores = append(executores, ExecutorSpec{Role: papel, Focus: foco})
		if len(executores) == teto {
			break
		}
	}
	if len(executores) == 0 {
		return Plan{}, false
	}

	// Sem complexidade declarada, 0.5: o meio do caminho não vira nem "responde
	// direto" nem "abre o painel inteiro".
	complexidade := 0.5
	if lido.Complexity != nil {
		complexidade = *lido.Complexity
		if complexidade < 0 {
			complexidade = 0
		}
		if complexidade > 1 {
			complexidade = 1
		}
	}
	return Plan{Complexity: complexidade, Executors: executores}, true
}

// FallbackPlan é o plano determinístico de quando o orquestrador não colaborou.
//
// As quatro lentes são as do orquestrador, na mesma ordem: elas cobrem um
// problema por ângulos que não se repetem, que é a única coisa que importa aqui.
func FallbackPlan(question string, maxExecutors int) Plan {
	complexidade := ClassifyComplexity(question)
	quantos := SuggestedExecutorCount(complexidade, maxExecutors)
	lentes := []ExecutorSpec{
		{Role: "Núcleo", Focus: "o essencial da resposta, direto e correto"},
		{Role: "Riscos", Focus: "casos de borda, riscos e o que pode dar errado"},
		{Role: "Alternativas", Focus: "abordagens alternativas, comparações e trade-offs"},
		{Role: "Prática", Focus: "passos práticos de implementação e verificação"},
	}
	return Plan{Complexity: complexidade, Executors: lentes[:quantos]}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
