// O orçamento de contexto: o que entra no prompt quando a conversa não cabe.
//
// O defeito que estes testes guardam não era um turno que falha — era uma
// conversa que MORRE. A colagem grande voltava inteira em TODO turno seguinte
// (o corte era por contagem, nunca por tamanho), e o "oi" do turno 2 falhava com
// o mesmo 400 do turno 1, para sempre.
package supervisor

import (
	"strings"
	"testing"

	"aibot/gateway/internal/modelrouter"
)

func system(content string) modelrouter.ChatMessage {
	return modelrouter.ChatMessage{Role: "system", Content: content}
}

func user(content string) modelrouter.ChatMessage {
	return modelrouter.ChatMessage{Role: "user", Content: content}
}

func TestFitToContextNuncaDescartaSystem(t *testing.T) {
	// Política do admin + contratos: o que não pode sumir por falta de espaço,
	// porque sumir seria transformar "a conversa ficou longa" na saída barata da
	// política.
	messages := []modelrouter.ChatMessage{
		system("POLITICA-DO-ADMIN"),
		system("CONTRATO-DE-FERRAMENTA"),
		user(strings.Repeat("a", 400_000)),
		user("e agora?"),
	}
	out := fitToContext(messages, 8192)

	corpo := ""
	for _, message := range out {
		corpo += message.Content
	}
	if !strings.Contains(corpo, "POLITICA-DO-ADMIN") || !strings.Contains(corpo, "CONTRATO-DE-FERRAMENTA") {
		t.Fatal("mensagem de sistema foi descartada para caber — a política não é negociável")
	}
	if !strings.Contains(corpo, "e agora?") {
		t.Error("a pergunta atual precisa sobreviver ao corte; sem ela o modelo responde a outra coisa")
	}
}

func TestFitToContextTruncaAColagemEmVezDeDerrubarOTurno(t *testing.T) {
	colagem := strings.Repeat("LOG ", 40_000) // ~160 KB, sozinha maior que a janela
	messages := []modelrouter.ChatMessage{
		system("sys"),
		user(colagem),
	}
	janela := 8192
	out := fitToContext(messages, janela)

	if len(out) != 2 {
		t.Fatalf("esperava sistema + a colagem truncada, vieram %d mensagens", len(out))
	}
	entregue := out[1].Content
	if len(entregue) >= len(colagem) {
		t.Error("a colagem entrou inteira — é isso que mata a conversa em definitivo")
	}
	if !strings.Contains(entregue, "colagem cortada") {
		t.Error("o corte precisa deixar marca: sem ela o modelo lê o texto cortado como se " +
			"fosse o fim do arquivo e responde com confiança sobre o que não recebeu")
	}
	if approxTokens(entregue) > int(float64(janela)*promptShare)+floorTokens {
		t.Errorf("o texto truncado ainda estoura o orçamento: %d tokens", approxTokens(entregue))
	}
}

func TestFitToContextCortaPeloComecoDaConversa(t *testing.T) {
	messages := []modelrouter.ChatMessage{
		system("sys"),
		user("PRIMEIRA-" + strings.Repeat("x", 20_000)),
		user("SEGUNDA-" + strings.Repeat("y", 20_000)),
		user("PERGUNTA-ATUAL"),
	}
	out := fitToContext(messages, 8192)

	corpo := ""
	for _, message := range out {
		corpo += message.Content
	}
	if !strings.Contains(corpo, "PERGUNTA-ATUAL") {
		t.Fatal("a pergunta atual sumiu — o corte foi pelo lado errado")
	}
	if strings.Contains(corpo, "PRIMEIRA-") {
		t.Error("o começo da conversa devia ter sido cortado antes do fim")
	}
}

func TestFitToContextDeixaAConversaInteiraQuandoCabe(t *testing.T) {
	messages := []modelrouter.ChatMessage{
		system("sys"), user("oi"), {Role: "assistant", Content: "olá"}, user("tudo bem?"),
	}
	out := fitToContext(messages, 128_000)
	if len(out) != len(messages) {
		t.Errorf("nada precisava ser cortado; esperava %d mensagens, vieram %d", len(messages), len(out))
	}
}

func TestFitToContextSemJanelaConhecidaUsaOPadrao(t *testing.T) {
	// Catálogo sem `context` não pode virar "janela infinita": era assim que a
	// colagem passava.
	messages := []modelrouter.ChatMessage{system("sys"), user(strings.Repeat("z", 400_000))}
	out := fitToContext(messages, 0)
	if len(out[1].Content) >= 400_000 {
		t.Error("sem janela informada o orçamento tem de cair no padrão conservador")
	}
}
