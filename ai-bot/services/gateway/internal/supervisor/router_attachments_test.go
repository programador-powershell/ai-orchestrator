// Testes do degrau de ANEXOS do roteador.
//
// A regra de produto é uma frase: EXTENSÃO VENCE RADICAL. Quem manda um .docx
// escrito "corrige isso" quer trabalhar no documento — o texto fala DO arquivo,
// não de código. Cada teste fixa uma face disso: o anexo decide contra o texto,
// o anexo não ressuscita quem a política barrou, o anexo NÃO reclassifica
// conversa em andamento, e prompt sem anexo roteia exatamente como antes.
//
// Os classificadores ficam PROIBIDOS na maioria dos cenários pelo mesmo motivo
// dos testes de sticky: anexo decisivo tem de sair no degrau barato — se um
// modelo for consultado, a economia (e a garantia) sumiu.
package supervisor

import (
	"context"
	"fmt"
	"testing"

	"aibot/gateway/internal/protocol"
	"aibot/gateway/internal/specialist"
)

// requireLexiconPrefers garante que o TEXTO do cenário realmente puxa para o
// especialista dado — senão o teste de "anexo vence radical" passaria com um
// texto que não disputa nada.
func requireLexiconPrefers(t *testing.T, text, id string) {
	t.Helper()
	scores := Score(text, specialist.All())
	if len(scores) == 0 || scores[0].ID != id {
		t.Fatalf("o cenário exige o léxico puxando %q para %q, mas o ranking foi: %s",
			text, id, describeScores(scores))
	}
}

func TestRouteDocxAttachmentBeatsCodeRadicals(t *testing.T) {
	requireLexiconPrefers(t, bugText, "code")

	// Nome com maiúscula, espaço e acento de propósito: é assim que arquivo de
	// gente chega. Só a extensão importa, e ela é dobrada para minúscula.
	router := NewRouter(forbiddenIntent{t: t}, forbiddenClassifier{t: t})
	route := router.Route(context.Background(), RouteInput{
		Text:        bugText,
		Attachments: []string{"Relatório Final.DOCX"},
	})

	if route.Specialist != "office" {
		t.Fatalf("Route(%q + .docx): esperava %q — extensão vence radical —, obteve %q (motivo %q)",
			bugText, "office", route.Specialist, route.Reason)
	}
	if route.Reason != protocol.RouteHeuristic {
		t.Errorf("Route com anexo decisivo: esperava o motivo %q (decisão local, sem modelo), obteve %q",
			protocol.RouteHeuristic, route.Reason)
	}
	if route.Confidence < MinConfidence {
		t.Errorf("Route com anexo decisivo: esperava confiança >= %v, obteve %.4f", MinConfidence, route.Confidence)
	}
	if !hasSignal(route.Signals, "anexo .docx") {
		t.Errorf("Route com anexo: esperava o sinal %q explicando a decisão, obteve %v", "anexo .docx", route.Signals)
	}
	if route.Surface != string(specialist.SurfaceDocument) {
		t.Errorf("Route com anexo: esperava a superfície %q, obteve %q", specialist.SurfaceDocument, route.Surface)
	}
}

func TestRouteSQLAttachmentRoutesData(t *testing.T) {
	requireLexiconPrefers(t, bugText, "code")

	router := NewRouter(forbiddenIntent{t: t}, forbiddenClassifier{t: t})
	route := router.Route(context.Background(), RouteInput{
		Text:        bugText,
		Attachments: []string{"dump.sql"},
	})

	if route.Specialist != "data" {
		t.Fatalf("Route(%q + .sql): esperava %q, obteve %q (motivo %q)",
			bugText, "data", route.Specialist, route.Reason)
	}
	if route.Reason != protocol.RouteHeuristic {
		t.Errorf("Route com .sql: esperava o motivo %q, obteve %q", protocol.RouteHeuristic, route.Reason)
	}
}

// A tabela inteira do produto, formato a formato. O texto é neutro para o teste
// medir SÓ o anexo — o caso com radical concorrente tem teste próprio acima.
func TestRouteAttachmentExtensionTable(t *testing.T) {
	cases := []struct {
		extension string
		want      string
	}{
		{"docx", "office"}, {"pptx", "office"}, {"xlsx", "office"}, {"pdf", "office"}, {"odt", "office"},
		{"sql", "data"}, {"db", "data"}, {"csv", "data"},
		{"png", "design"}, {"jpg", "design"}, {"svg", "design"}, {"fig", "design"},
		// Vídeo mora no design — decisão de produto, não dedução de MIME.
		{"mp4", "design"}, {"mov", "design"}, {"webm", "design"}, {"srt", "design"},
		{"go", "code"}, {"rs", "code"}, {"ts", "code"}, {"tsx", "code"}, {"py", "code"}, {"js", "code"},
		{"jsonl", "tune"}, {"gguf", "tune"}, {"safetensors", "tune"},
	}

	requireNoLexicalSignal(t, noSignalText)
	for _, each := range cases {
		t.Run("."+each.extension, func(t *testing.T) {
			router := NewRouter(forbiddenIntent{t: t}, forbiddenClassifier{t: t})
			route := router.Route(context.Background(), RouteInput{
				Text:        noSignalText,
				Attachments: []string{"arquivo." + each.extension},
			})
			if route.Specialist != each.want {
				t.Errorf("anexo .%s: esperava %q, obteve %q", each.extension, each.want, route.Specialist)
			}
		})
	}
}

// Sem anexo reconhecido, NADA muda: extensão desconhecida e nome sem extensão
// não opinam, e o prompt roteia exatamente como se o campo não existisse.
func TestRouteUnknownAttachmentChangesNothing(t *testing.T) {
	requireNoLexicalSignal(t, noSignalText)

	for _, names := range [][]string{
		{"leia-me.xyz"},
		{"SEM_EXTENSAO"},
		{"terminado-no-ponto."},
		nil,
	} {
		t.Run(fmt.Sprintf("%v", names), func(t *testing.T) {
			route := NewRouter(nil, nil).Route(context.Background(), RouteInput{
				Text:        noSignalText,
				Attachments: names,
			})
			if route.Reason != protocol.RouteFallback {
				t.Fatalf("esperava o fallback de sempre, obteve o motivo %q (%q)", route.Reason, route.Specialist)
			}
			if route.Specialist != specialist.DefaultID {
				t.Errorf("esperava o padrão %q, obteve %q", specialist.DefaultID, route.Specialist)
			}
		})
	}

	// E com anexo reconhecido a decisão continua a MESMA do texto quando o
	// texto já decidia sozinho para o mesmo lado — a soma não estraga o óbvio.
	route := NewRouter(forbiddenIntent{t: t}, forbiddenClassifier{t: t}).Route(context.Background(), RouteInput{
		Text:        xssText,
		Attachments: []string{"nota.xyz"},
	})
	if route.Specialist != "security" || route.Reason != protocol.RouteHeuristic {
		t.Errorf("anexo desconhecido mudou a decisão do texto: obteve %q (motivo %q)", route.Specialist, route.Reason)
	}
}

// Conversa em andamento NÃO reclassifica: o modo é da conversa, e anexo é sinal
// de PRIMEIRO input. Um .docx mandado no meio de uma sessão de código é um
// arquivo para o especialista de código ler — não uma troca de tela.
func TestRouteStickyIgnoresAttachments(t *testing.T) {
	router := NewRouter(forbiddenIntent{t: t}, forbiddenClassifier{t: t})

	route := router.Route(context.Background(), RouteInput{
		Text:        bugText,
		Current:     "code",
		Attachments: []string{"contrato.docx"},
	})

	if route.Reason != protocol.RouteSticky {
		t.Fatalf("Route com Current e anexo: esperava %q, obteve %q", protocol.RouteSticky, route.Reason)
	}
	if route.Specialist != "code" {
		t.Errorf("o anexo trocou o dono da conversa para %q — anexo não reclassifica conversa em andamento",
			route.Specialist)
	}
}

// A escolha explícita continua vencendo tudo — inclusive o anexo.
func TestRouteExplicitBeatsAttachment(t *testing.T) {
	router := NewRouter(forbiddenIntent{t: t}, forbiddenClassifier{t: t})

	route := router.Route(context.Background(), RouteInput{
		Text:        noSignalText,
		Explicit:    "chat",
		Attachments: []string{"contrato.docx"},
	})

	if route.Reason != protocol.RouteExplicit || route.Specialist != "chat" {
		t.Errorf("Route com Explicit e anexo: esperava chat/explicit, obteve %q/%q",
			route.Specialist, route.Reason)
	}
}

// Anexo cujo dono está fora da política NÃO pontua: rotear para quem o admin
// barrou seria usar o anexo como porta de trás da lista.
func TestRouteAttachmentOutsideAllowedIsIgnored(t *testing.T) {
	// Texto SEM sinal léxico, para o anexo ser a única coisa capaz de decidir —
	// é ele que está sob teste. Com um texto que decide sozinho, o cenário
	// passaria pelo motivo errado.
	route := NewRouter(nil, nil).Route(context.Background(), RouteInput{
		Text:        noSignalText,
		Allowed:     []string{"chat", "code"},
		Attachments: []string{"contrato.docx"},
	})

	if route.Specialist == "office" {
		t.Fatalf("Route escolheu %q, que está fora de Allowed, por causa do anexo", route.Specialist)
	}
	if route.Specialist != specialist.DefaultID {
		t.Errorf("esperava o fallback %q (o texto sozinho não decide), obteve %q (motivo %q)",
			specialist.DefaultID, route.Specialist, route.Reason)
	}
}

// Vários anexos disputam por quantidade: dois .sql pesam mais que um .docx.
func TestRouteAttachmentMajorityWins(t *testing.T) {
	requireNoLexicalSignal(t, noSignalText)
	router := NewRouter(forbiddenIntent{t: t}, forbiddenClassifier{t: t})

	route := router.Route(context.Background(), RouteInput{
		Text:        noSignalText,
		Attachments: []string{"clientes.sql", "faturas.sql", "resumo.docx"},
	})

	if route.Specialist != "data" {
		t.Errorf("dois .sql contra um .docx: esperava %q, obteve %q", "data", route.Specialist)
	}
}

// O empate exato entre formatos NÃO decide no cara ou coroa: sem texto que
// desempate, a decisão segue a cascata (aqui, sem classificadores, o fallback —
// que é onde o supervisor pergunta em vez de adivinhar). Com texto que
// desempata, decide — e decide para o lado do texto.
func TestRouteAttachmentTie(t *testing.T) {
	requireNoLexicalSignal(t, noSignalText)

	t.Run("empate sem texto segue a cascata", func(t *testing.T) {
		route := NewRouter(nil, nil).Route(context.Background(), RouteInput{
			Text:        noSignalText,
			Attachments: []string{"contrato.docx", "dump.sql"},
		})
		if route.Reason != protocol.RouteFallback {
			t.Fatalf("empate .docx/.sql: esperava seguir para o fallback, obteve %q (%q)",
				route.Reason, route.Specialist)
		}
	})

	t.Run("o texto desempata", func(t *testing.T) {
		router := NewRouter(forbiddenIntent{t: t}, forbiddenClassifier{t: t})
		route := router.Route(context.Background(), RouteInput{
			Text:        "consulta na tabela de clientes",
			Attachments: []string{"contrato.docx", "dump.sql"},
		})
		if route.Specialist != "data" {
			t.Errorf("empate desempatado por texto de dados: esperava %q, obteve %q", "data", route.Specialist)
		}
	})
}

/* --------------------------- combineAttachments --------------------------- */

// A garantia aritmética do "extensão vence radical": a parcela de texto entra
// CAPADA em saturation, então um único anexo (2×saturation) fica estritamente à
// frente de qualquer pontuação de radical — inclusive de um texto que sozinho
// pontuaria confiança 1.0. Sem o cap não haveria peso que garantisse.
func TestCombineAttachmentsBeatsSaturatedText(t *testing.T) {
	// Texto entupido de radicais de código, muito acima da saturação.
	stuffed := "refatora a funcao do endpoint typescript com bug no build do commit da branch"
	scores := Score(stuffed, specialist.All())
	if len(scores) == 0 || scores[0].ID != "code" || scores[0].Confidence < 1 {
		t.Fatalf("o cenário exige texto saturado em code (confiança 1.0), obteve: %s", describeScores(scores))
	}

	combined, decisive := combineAttachments(scores, []string{"contrato.docx"}, specialist.All())

	if !decisive {
		t.Fatalf("um anexo contra texto saturado tinha de ser decisivo; ranking: %s", describeScores(combined))
	}
	if combined[0].ID != "office" {
		t.Errorf("esperava %q no topo do ranking combinado, obteve %q", "office", combined[0].ID)
	}
}

func TestCombineAttachmentsWithoutRecognizedNamesIsIdentity(t *testing.T) {
	scores := Score(xssText, specialist.All())

	combined, decisive := combineAttachments(scores, []string{"leia-me.xyz", "SEM_EXTENSAO"}, specialist.All())

	if decisive {
		t.Fatal("anexo sem extensão reconhecida não pode decidir nada")
	}
	if describeScores(combined) != describeScores(scores) {
		t.Errorf("sem anexo reconhecido o ranking tinha de sair intacto:\n  antes:  %s\n  depois: %s",
			describeScores(scores), describeScores(combined))
	}
}
