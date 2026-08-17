// O orçamento de contexto: o que cabe na janela do modelo.
//
// O defeito que este arquivo existe para impedir não era um turno que falha — era
// uma conversa que MORRE. Alguém cola 116 KB de log e pede "explique". A fala vai
// inteira para o log, e o histórico a devolve inteira em TODO turno seguinte,
// porque o corte era por CONTAGEM (40 mensagens) e nunca por tamanho. O turno 1
// falha com 400 do provedor; o turno 2 ("oi") falha com o MESMO 400, e o 3
// também. O erro saía com `retryable=false` e não havia saída de dentro da
// conversa: ela ficava permanentemente morta, e nada dizia por quê.
//
// A janela já existia no catálogo (`protocol.Model.Context`) e não era lida em
// lugar nenhum do gateway.
package supervisor

import (
	"fmt"
	"strings"

	"aibot/gateway/internal/modelrouter"
)

const (
	// charsPerToken é a regra de bolso para estimar tokens sem tokenizador.
	//
	// Quatro erra para os dois lados — código denso gasta mais, prosa em
	// português com acento gasta menos —, e é por isso que ela vem acompanhada da
	// margem abaixo em vez de sozinha. Tokenizar de verdade exigiria o vocabulário
	// de cada provedor dentro do processo: peso e acoplamento para uma decisão que
	// só precisa estar na ordem de grandeza certa.
	charsPerToken = 4

	// promptShare é quanto da janela o PROMPT pode ocupar. O resto é da resposta:
	// encher a janela até a borda deixa o modelo sem espaço para responder, e o
	// erro que volta é o mesmo do estouro — o que faria a correção parecer não ter
	// funcionado.
	promptShare = 0.65

	// defaultContextTokens é a janela assumida quando o catálogo não informa a do
	// modelo. Conservadora de propósito: subestimar corta contexto que caberia,
	// superestimar traz de volta exatamente o defeito.
	defaultContextTokens = 8192

	// minKeptMessages é quanto do fim da conversa é preservado mesmo quando o
	// orçamento aperta. Sem um piso, uma colagem enorme engoliria a pergunta
	// atual e o modelo responderia a outra coisa.
	minKeptMessages = 2

	// floorTokens é o mínimo que a pergunta atual recebe mesmo sem orçamento —
	// um turno apertado ainda responde; um turno sem a pergunta, não.
	floorTokens = 256
)

// approxTokens estima o custo de um texto.
func approxTokens(text string) int {
	if text == "" {
		return 0
	}
	return len(text)/charsPerToken + 1
}

// truncateForContext corta um texto para caber em `tokens`, deixando a marca do
// corte NO TEXTO.
//
// A marca não é cosmética: sem ela o modelo lê um log que termina no meio como se
// aquele fosse o fim do arquivo, e responde com confiança sobre a metade que não
// recebeu. O corte é no MEIO — começo e fim de uma colagem carregam mais
// informação que o miolo (o cabeçalho e o stack trace final, por exemplo).
func truncateForContext(text string, tokens int) string {
	limit := tokens * charsPerToken
	if limit <= 0 || len(text) <= limit {
		return text
	}
	head := limit / 2
	tail := limit - head
	if head <= 0 || tail <= 0 {
		return text[:limit]
	}
	omitted := (len(text) - head - tail) / 1024
	return text[:head] +
		fmt.Sprintf("\n\n[…colagem cortada para caber na janela do modelo: %d KB omitidos…]\n\n", omitted) +
		text[len(text)-tail:]
}

// fitToContext corta as mensagens para caberem na janela do modelo.
//
// Duas regras carregam o desenho:
//
//  1. Mensagem `system` NUNCA é descartada. Ela é a política do admin, o system
//     do especialista e os contratos de ferramenta; jogá-la fora para caber seria
//     transformar "a conversa ficou longa" na saída barata da política.
//
//  2. O que sobra é cortado pelo COMEÇO. O fim da conversa é a pergunta atual, e
//     cortar por lá responderia à mensagem errada.
//
// Quando uma única mensagem já não cabe sozinha, ela entra TRUNCADA em vez de
// derrubar o turno — é isso que mantém a conversa viva depois de uma colagem
// grande demais.
func fitToContext(messages []modelrouter.ChatMessage, contextTokens int) []modelrouter.ChatMessage {
	if contextTokens <= 0 {
		contextTokens = defaultContextTokens
	}
	budget := int(float64(contextTokens) * promptShare)
	if budget <= 0 {
		return messages
	}

	spent := 0
	for _, message := range messages {
		if message.Role == "system" {
			spent += approxTokens(message.Content)
		}
	}

	// O que sobra para a conversa. Pode ficar negativo quando os contratos de
	// sistema já enchem a janela — e aí o piso abaixo ainda garante a pergunta
	// atual, truncada se preciso.
	remaining := budget - spent

	kept := make([]modelrouter.ChatMessage, 0, len(messages))
	for index := len(messages) - 1; index >= 0; index-- {
		message := messages[index]
		if message.Role == "system" {
			continue
		}
		cost := approxTokens(message.Content)
		if cost <= remaining {
			remaining -= cost
			kept = append(kept, message)
			continue
		}
		// Não coube. Enquanto não houver o mínimo guardado, entra TRUNCADA; depois
		// disso para aqui — daqui para trás é o começo da conversa, que é o que
		// menos importa para o próximo turno.
		if len(kept) < minKeptMessages {
			room := remaining
			if room < floorTokens {
				room = floorTokens
			}
			message.Content = truncateForContext(message.Content, room)
			kept = append(kept, message)
			remaining = 0
			continue
		}
		break
	}

	// Remonta na ordem original: os `system` primeiro, na ordem em que vieram, e
	// depois a conversa do mais antigo ao mais novo.
	out := make([]modelrouter.ChatMessage, 0, len(kept)+4)
	for _, message := range messages {
		if message.Role == "system" {
			out = append(out, message)
		}
	}
	for index := len(kept) - 1; index >= 0; index-- {
		out = append(out, kept[index])
	}
	return out
}

// toolEvidence monta a linha sintética que devolve ao histórico o RESULTADO de
// uma ferramenta.
//
// Mesmo formato que o laço do turno usa em memória, para o modelo não ver dois
// dialetos do mesmo fato entre um turno e o seguinte.
func toolEvidence(tool, output string) string {
	return "Resultado das ferramentas:\n\n" + tool + " =>\n" + strings.TrimSpace(output)
}
