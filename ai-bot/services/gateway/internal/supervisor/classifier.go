// O degrau 3 do roteamento: o modelo master.
//
// Ele só é chamado quando o classificador léxico não teve folga para decidir —
// e é por isso que ele pode ser caro. Se rodasse em toda mensagem, cada linha
// da conversa pagaria uma ida à rede ANTES de a resposta começar a aparecer.
package supervisor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"aibot/gateway/internal/modelrouter"
	"aibot/gateway/internal/specialist"
)

// classifierMaxTokens é curto de propósito: a resposta é um JSON de três
// campos. Teto baixo também impede o modelo de "explicar" em vez de classificar.
const classifierMaxTokens = 200

// ModelClassifier pergunta a um modelo qual especialista atende.
type ModelClassifier struct {
	models *modelrouter.Router
	// model fixa o modelo do master. Vazio = o roteador escolhe (normalmente o
	// mais barato que atenda, porque classificar não precisa do modelo grande).
	model string
}

// NewModelClassifier monta o classificador.
func NewModelClassifier(models *modelrouter.Router, model string) *ModelClassifier {
	return &ModelClassifier{models: models, model: model}
}

// Classify devolve o veredito do master.
func (c *ModelClassifier) Classify(
	ctx context.Context,
	prompt string,
	candidates []specialist.Definition,
) (ClassifierVerdict, error) {
	if c.models == nil {
		return ClassifierVerdict{}, errors.New("roteador de modelos indisponível")
	}
	if len(candidates) == 0 {
		return ClassifierVerdict{}, errors.New("nenhum especialista candidato")
	}

	entry, _, err := c.models.Resolve(specialist.MasterID, c.model)
	if err != nil {
		return ClassifierVerdict{}, err
	}

	var catalog strings.Builder
	for _, definition := range candidates {
		fmt.Fprintf(&catalog, "- %s: %s. %s\n", definition.ID, definition.Name, definition.Tagline)
	}

	answer, _, err := c.models.Complete(ctx, modelrouter.Request{
		Model:     entry.Model.ID,
		MaxTokens: classifierMaxTokens,
		Messages: []modelrouter.ChatMessage{
			{Role: "system", Content: specialist.Master.System},
			{Role: "system", Content: "Especialistas disponíveis:\n" + catalog.String()},
			{Role: "user", Content: prompt},
		},
	})
	if err != nil {
		return ClassifierVerdict{}, err
	}

	verdict, err := parseVerdict(answer)
	if err != nil {
		return ClassifierVerdict{}, err
	}
	if !specialist.Exists(verdict.Specialist) {
		return ClassifierVerdict{}, fmt.Errorf("o master indicou um especialista que não existe: %q", verdict.Specialist)
	}
	return verdict, nil
}

// parseVerdict extrai o JSON mesmo quando o modelo o embrulha em cerca ou
// escreve uma frase antes.
//
// Instruir "responda só JSON" reduz o desvio, não o elimina — e um master que
// falha porque o modelo disse "Claro!" antes do objeto derruba o roteamento
// inteiro por um problema de etiqueta.
func parseVerdict(answer string) (ClassifierVerdict, error) {
	text := strings.TrimSpace(answer)
	if text == "" {
		return ClassifierVerdict{}, errors.New("o master respondeu vazio")
	}
	start := strings.Index(text, "{")
	end := strings.LastIndex(text, "}")
	if start < 0 || end <= start {
		return ClassifierVerdict{}, fmt.Errorf("o master não devolveu JSON: %q", truncate(text, 200))
	}
	var verdict ClassifierVerdict
	if err := json.Unmarshal([]byte(text[start:end+1]), &verdict); err != nil {
		return ClassifierVerdict{}, fmt.Errorf("json do master inválido: %w", err)
	}
	verdict.Specialist = strings.TrimSpace(strings.ToLower(verdict.Specialist))
	if verdict.Specialist == "" {
		return ClassifierVerdict{}, errors.New("o master não indicou especialista")
	}
	return verdict, nil
}
