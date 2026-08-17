// Pergunta ou pedido — a distinção que o assunto sozinho não faz.
//
// O caso que originou este arquivo: "qual a sintaxe correta de um for em
// python?" tem `python` no meio e o léxico o entregava ao Código. A pessoa não
// pediu código; tirou uma dúvida. E o custo do engano não é uma resposta ruim —
// o modo fica GRAVADO na conversa e tudo o que vier depois vai para o executor
// errado.
package supervisor

import (
	"context"
	"testing"
)

func donoDe(t *testing.T, texto string) string {
	t.Helper()
	return NewRouter(nil, nil).Route(context.Background(), RouteInput{Text: texto}).Specialist
}

func TestPerguntaVaiParaAConversaMesmoComAssuntoDeOutro(t *testing.T) {
	perguntas := []string{
		"qual a sintaxe correta de um for em python?",
		"o que é injeção de SQL",
		"me tira uma dúvida sobre o schema de cobrança",
		"como funciona o roteamento em cascata",
		"qual a diferença entre docker e wsl",
		"vale a pena usar postgres aqui?",
		"o que significa esse erro de compilação",
		"qual a melhor prática para nomear tabela",
	}
	for _, pergunta := range perguntas {
		t.Run(pergunta, func(t *testing.T) {
			if dono := donoDe(t, pergunta); dono != "chat" {
				t.Errorf("%q foi para %q — é PERGUNTA, quem responde é a Conversa", pergunta, dono)
			}
		})
	}
}

// O verbo de ação vence a cara de pergunta: quem manda fazer, mandou fazer.
func TestPedidoComCaraDePerguntaContinuaPedido(t *testing.T) {
	casos := []struct{ texto, dono string }{
		{"como eu corrijo esse bug de compilação?", "code"},
		{"pode criar uma aplicação em next.js?", "code"},
		{"você consegue desenhar o banco de cobrança?", "data"},
		{"dá pra exportar essa apresentação em pptx?", "office"},
	}
	for _, caso := range casos {
		t.Run(caso.texto, func(t *testing.T) {
			if dono := donoDe(t, caso.texto); dono != caso.dono {
				t.Errorf("%q foi para %q; esperava %q — tem verbo de ação, é pedido",
					caso.texto, dono, caso.dono)
			}
		})
	}
}

// Pedido puro segue pedido — a regra da pergunta não pode engolir o produto.
func TestPedidoDiretoNaoViraConversa(t *testing.T) {
	casos := []struct{ texto, dono string }{
		{"crie uma aplicação em next.js completa", "code"},
		{"corrige o bug de compilação no parser", "code"},
		{"desenhe o banco de dados de cobrança", "data"},
		{"faça uma auditoria de segurança no repositório", "security"},
	}
	for _, caso := range casos {
		t.Run(caso.texto, func(t *testing.T) {
			if dono := donoDe(t, caso.texto); dono != caso.dono {
				t.Errorf("%q foi para %q; esperava %q", caso.texto, dono, caso.dono)
			}
		})
	}
}

// Pergunta não tem elenco: o elenco é o formato de um plano, e dúvida não
// produz artefato para ninguém trabalhar em cima.
func TestPerguntaNaoConvocaElenco(t *testing.T) {
	rota := NewRouter(nil, nil).Route(context.Background(), RouteInput{
		Text: "o que é injeção de SQL",
	})
	if len(rota.Standby) != 0 {
		t.Errorf("pergunta não convoca ninguém: %+v", rota.Standby)
	}
}

// `/mode` e o sticky passam na frente: quem escolheu na mão já disse o que quer.
func TestPerguntaNaoDesviaConversaQueJaTemDono(t *testing.T) {
	rota := NewRouter(nil, nil).Route(context.Background(), RouteInput{
		Text:    "qual a sintaxe correta de um for em python?",
		Current: "code",
	})
	if rota.Specialist != "code" {
		t.Errorf("conversa de código não vira Conversa por causa de uma pergunta: %q", rota.Specialist)
	}
}

func TestIntentOfSeparaOsDoisCasos(t *testing.T) {
	casos := []struct {
		texto  string
		espera Intent
	}{
		{"qual a sintaxe correta de um for em python?", IntentQuestion},
		{"o que e injecao de sql", IntentQuestion},
		{"me tira uma duvida", IntentQuestion},
		{"crie uma aplicacao", IntentRequest},
		{"como eu corrijo esse bug?", IntentRequest},
		{"", IntentRequest},
	}
	for _, caso := range casos {
		if got := IntentOf(Normalize(caso.texto)); got != caso.espera {
			t.Errorf("IntentOf(%q) = %q; esperava %q", caso.texto, got, caso.espera)
		}
	}
}
