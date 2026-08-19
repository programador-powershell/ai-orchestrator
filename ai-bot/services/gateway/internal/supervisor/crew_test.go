// Testes das peças PURAS da equipe.
//
// `runCrew` e `runWorker` precisam de um supervisor inteiro (store, barramento,
// roteador de modelos) e não têm harness neste pacote; o que dá para fixar sem
// isso são as duas funções que decidem o SENTIDO do que aparece na tela e no
// relatório: quem escalou e o que o portão diz.
//
// Elas não são detalhe de formatação. `escalation` é o que separa "o trabalhador
// errou" de "o trabalhador perguntou", e `gateReason` é o texto sobre o qual uma
// pessoa clica em seguir, refazer ou abortar — dizer "falhou" para quem perguntou
// empurra para "refazer", que é a resposta errada.
package supervisor

import (
	"strings"
	"testing"
)

func TestEscalationDetectsThePrefix(t *testing.T) {
	cases := []struct {
		name         string
		answer       string
		wantQuestion string
		wantOK       bool
	}{
		{
			name:         "linha única",
			answer:       "ESCALAR: uso Postgres ou SQLite?",
			wantQuestion: "uso Postgres ou SQLite?",
			wantOK:       true,
		},
		{
			// O modelo quase sempre escreve alguma coisa antes de pedir ajuda.
			name:         "no meio da resposta",
			answer:       "Olhei o schema e não dá para decidir sozinho.\nESCALAR: qual banco?",
			wantQuestion: "qual banco?",
			wantOK:       true,
		},
		{
			name:         "com espaço à esquerda",
			answer:       "   ESCALAR: qual banco?",
			wantQuestion: "qual banco?",
			wantOK:       true,
		},
		{
			// Escalar sem dizer o que quer saber ainda é escalar: o trabalhador
			// parou. Devolver ok=false aqui faria a tarefa ser contada como falha,
			// que é exatamente a confusão que este caminho existe para desfazer.
			name:         "pergunta vazia ainda é escalação",
			answer:       "ESCALAR:",
			wantQuestion: "",
			wantOK:       true,
		},
		{
			name:         "sem o prefixo não é escalação",
			answer:       "Terminei: criei a tabela de clientes.",
			wantQuestion: "",
			wantOK:       false,
		},
		{
			// A palavra no meio da frase não conta — senão qualquer resposta que
			// FALE sobre escalar viraria uma escalação.
			name:         "a palavra no meio da linha não conta",
			answer:       "Se eu não souber, vou ESCALAR: é o combinado.",
			wantQuestion: "",
			wantOK:       false,
		},
	}

	for _, each := range cases {
		t.Run(each.name, func(t *testing.T) {
			question, ok := escalation(each.answer)
			if ok != each.wantOK {
				t.Fatalf("escalation(%q): esperava ok=%v, obteve %v (pergunta %q)",
					each.answer, each.wantOK, ok, question)
			}
			if question != each.wantQuestion {
				t.Errorf("escalation(%q): esperava a pergunta %q, obteve %q",
					each.answer, each.wantQuestion, question)
			}
		})
	}
}

// A recusa NÃO pode sair como sucesso — "Não posso ajudar" com ✓ entra em
// `results` e vira o upstream das tarefas dependentes, que constroem em cima do
// nada. E a detecção tem que ser conservadora no outro sentido também: resposta
// técnica diz "não" o tempo todo e continua sendo trabalho entregue; reprová-la
// joga fora trabalho feito, que é pior e não avisa.
func TestRefusalReprovaARecusaPuraEDeixaPassarOTrabalho(t *testing.T) {
	cases := []struct {
		name   string
		answer string
		want   bool
	}{
		{name: "recusa seca", answer: "Não posso ajudar com isso.", want: true},
		{name: "recusa com desculpa", answer: "Desculpe, mas não posso ajudar com esse pedido.", want: true},
		{name: "recusa com dois preâmbulos", answer: "Sinto muito, eu não posso fazer isso.", want: true},
		{name: "recusa de assistente", answer: "Como modelo de linguagem, não posso atender a esse pedido.", want: true},
		{name: "recusa em caixa alta", answer: "NÃO POSSO AJUDAR", want: true},
		{name: "recusa sem acento", answer: "Nao posso ajudar com essa tarefa.", want: true},
		{name: "recusa explícita", answer: "Me recuso a realizar essa tarefa.", want: true},
		{name: "recusa em inglês", answer: "I can't help with that request.", want: true},
		{
			name:   "resposta técnica com 'não' passa",
			answer: "A rota /pagamentos não aceitava POST; ajustei o handler e os testes passam.",
			want:   false,
		},
		{
			name:   "constatação negativa não é recusa",
			answer: "Não há ocorrências de contratante no documento — o texto já usa cliente.",
			want:   false,
		},
		{
			// Começa igual à recusa, mas o verbo é técnico e a frase termina em
			// trabalho feito. É exatamente o falso positivo que o marcador
			// estreito existe para não cometer.
			name:   "impedimento técnico seguido de solução passa",
			answer: "Não posso alterar o arquivo de config sem aprovação, então apliquei a mudança no exemplo e documentei.",
			want:   false,
		},
		{
			// Longa demais para ser recusa pura: quem recusa e segue explicando
			// alternativas entregou conteúdo que o orquestrador sabe ler.
			name: "recusa longa com alternativa passa",
			answer: "Não posso ajudar com a assinatura do contrato em si, mas mapeei o que falta: " +
				"o anexo B está sem a cláusula de rescisão, o prazo do item 4 conflita com o item 9 " +
				"e a testemunha indicada não consta no cadastro. Sugiro corrigir os três pontos e " +
				"repassar o documento pelo jurídico antes de qualquer assinatura, com registro em ata.",
			want: false,
		},
		{name: "resposta vazia não é recusa", answer: "   ", want: false},
	}

	for _, each := range cases {
		t.Run(each.name, func(t *testing.T) {
			if got := refusal(each.answer); got != each.want {
				t.Errorf("refusal(%q) = %v, esperava %v", each.answer, got, each.want)
			}
		})
	}
}

// O portão pergunta "seguir, refazer ou abortar?", e quem responde precisa saber
// sobre o quê. Escalação não pode entrar no texto como falha: o que resolve uma
// pergunta é responder, não refazer.
func TestGateReasonSeparatesFailureFromQuestion(t *testing.T) {
	cases := []struct {
		name        string
		failures    int
		escalations int
		mustContain []string
		mustNotHave []string
	}{
		{
			name:        "só falha",
			failures:    2,
			escalations: 0,
			mustContain: []string{"2", "falharam"},
			mustNotHave: []string{"escalaram"},
		},
		{
			name:        "só escalação",
			failures:    0,
			escalations: 1,
			mustContain: []string{"1", "escalaram", "esperam resposta"},
			mustNotHave: []string{"falharam"},
		},
		{
			name:        "os dois juntos",
			failures:    1,
			escalations: 2,
			mustContain: []string{"1", "falharam", "2", "escalaram"},
		},
	}

	for _, each := range cases {
		t.Run(each.name, func(t *testing.T) {
			reason := gateReason(3, each.failures, each.escalations)

			if !strings.Contains(reason, "onda 3") {
				t.Errorf("gateReason: esperava a onda no texto, obteve %q", reason)
			}
			// Sem as três saídas escritas, o portão não diz o que se pode fazer com
			// ele — e a tela desenha os três botões de qualquer jeito.
			for _, want := range []string{"seguir", "refazer", "abortar"} {
				if !strings.Contains(reason, want) {
					t.Errorf("gateReason: esperava %q no texto, obteve %q", want, reason)
				}
			}
			for _, want := range each.mustContain {
				if !strings.Contains(reason, want) {
					t.Errorf("gateReason(%d falhas, %d escalações): esperava %q em %q",
						each.failures, each.escalations, want, reason)
				}
			}
			for _, unwanted := range each.mustNotHave {
				if strings.Contains(reason, unwanted) {
					t.Errorf("gateReason(%d falhas, %d escalações): NÃO esperava %q em %q",
						each.failures, each.escalations, unwanted, reason)
				}
			}
		})
	}
}
