// Testes do master.
//
// Um erro aqui não quebra nada visivelmente: só manda a conversa para o
// especialista errado de vez em quando. Por isso cada degrau da decisão
// (`/mode`, explícito, sticky, léxico, modelo, fallback) tem teste próprio, e os
// textos usados são fixados em constantes com o motivo de cada um.
//
// A ordem dessa lista É a ordem da cascata, e o lugar do sticky nela é a regra
// de produto: MODO É DA CONVERSA. Com `Current` preenchido a rota sai antes de
// qualquer pontuação léxica e antes de qualquer classificador — por isso os
// testes de sticky usam classificadores PROIBIDOS em vez de nil: com nil, um
// degrau que voltasse a ser consultado passaria despercebido.
package supervisor

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"aibot/gateway/internal/protocol"
	"aibot/gateway/internal/specialist"
)

// noSignalText não casa com radical nenhum do catálogo. É o texto que exercita
// os degraus que só existem quando o léxico não tem o que dizer.
const noSignalText = "hmm"

// bugText pontua "code" acima de todos. Já DECIDE sozinho desde que o peso de
// palavra inteira entrou no Score — o que é o certo: "bug" e "compilação" não
// são pedido de outra especialidade.
const bugText = "corrige o bug de compilação"

// ambiguousText tem opinião do léxico e mesmo assim NÃO pode decidir: "seguranc"
// e "codig" competem, a margem fica abaixo de MinMargin, e é exatamente aí que
// os degraus seguintes da cascata existem para entrar. É o caso que o próprio
// comentário de MinMargin descreve.
const ambiguousText = "revisa a segurança desse código"

// xssText decide sozinho: "vulnerab" e "xss" só aparecem em pedido de segurança.
const xssText = "revisa a vulnerabilidade de XSS"

/* ------------------------------ auxiliares ------------------------------ */

// stubClassifier é o degrau 3 sem rede.
type stubClassifier struct {
	verdict    ClassifierVerdict
	err        error
	calls      int
	lastPrompt string
	lastIDs    []string
}

func (s *stubClassifier) Classify(_ context.Context, prompt string, candidates []specialist.Definition) (ClassifierVerdict, error) {
	s.calls++
	s.lastPrompt = prompt
	s.lastIDs = s.lastIDs[:0]
	for _, candidate := range candidates {
		s.lastIDs = append(s.lastIDs, candidate.ID)
	}
	return s.verdict, s.err
}

// stubIntent é o degrau 2 (Needle) sem a biblioteca nativa.
//
// `ready` é campo e não constante porque os DOIS estados são cenário de teste:
// pronto exercita o degrau, e não pronto é o build sem a tag `needle` — em que a
// cascata tem de encurtar em vez de falhar.
type stubIntent struct {
	verdict    ClassifierVerdict
	err        error
	ready      bool
	calls      int
	lastPrompt string
	lastIDs    []string
}

func (s *stubIntent) Ready() bool { return s.ready }

func (s *stubIntent) Intent(_ context.Context, prompt string, candidates []specialist.Definition) (ClassifierVerdict, error) {
	s.calls++
	s.lastPrompt = prompt
	s.lastIDs = s.lastIDs[:0]
	for _, candidate := range candidates {
		s.lastIDs = append(s.lastIDs, candidate.ID)
	}
	return s.verdict, s.err
}

// forbiddenClassifier reprova o teste se for consultado. Chamar o modelo quando
// a decisão já estava tomada custa uma ida à rede em toda mensagem.
type forbiddenClassifier struct{ t *testing.T }

func (f forbiddenClassifier) Classify(context.Context, string, []specialist.Definition) (ClassifierVerdict, error) {
	f.t.Helper()
	f.t.Errorf("o classificador do modelo grande foi consultado, mas a decisão já estava tomada sem ele")
	return ClassifierVerdict{}, nil
}

// forbiddenIntent é o degrau local proibido. `Ready` também reprova: só de
// perguntar se o Needle está pronto o roteador já mostrou que passou do ponto em
// que a decisão devia ter saído — e é o único sinal que sobra quando o degrau
// não chega a ser chamado.
type forbiddenIntent struct{ t *testing.T }

func (f forbiddenIntent) Ready() bool {
	f.t.Helper()
	f.t.Errorf("o roteador local foi consultado, mas a decisão já estava tomada sem ele")
	return false
}

func (f forbiddenIntent) Intent(context.Context, string, []specialist.Definition) (ClassifierVerdict, error) {
	f.t.Helper()
	f.t.Errorf("o roteador local classificou, mas a decisão já estava tomada sem ele")
	return ClassifierVerdict{}, nil
}

// requireNoLexicalSignal garante que o texto realmente não aciona radical
// nenhum. Sem esta guarda, acrescentar um trigger novo faria os testes de
// sticky e de fallback continuarem passando exercitando o degrau errado.
func requireNoLexicalSignal(t *testing.T, text string) {
	t.Helper()
	if scores := Score(text, specialist.All()); len(scores) != 0 {
		t.Fatalf("o texto %q deveria estar sem sinal léxico, mas pontuou: %s", text, describeScores(scores))
	}
}

// requireUndecidedLexicon garante que o léxico TEM opinião sobre o texto e mesmo
// assim não pode decidir sozinho. É o único cenário em que os degraus de IA são
// consultados — e sem esta guarda, recalibrar um radical faria os testes da
// cascata continuarem passando exercitando a heurística.
func requireUndecidedLexicon(t *testing.T, text string) {
	t.Helper()
	scores := Score(text, specialist.All())
	if len(scores) == 0 {
		t.Fatalf("o cenário exige o léxico com opinião sobre %q, mas ele não pontuou ninguém", text)
	}
	if scores[0].Confidence >= MinConfidence {
		t.Fatalf("o cenário exige léxico indeciso para %q, mas o ranking foi: %s", text, describeScores(scores))
	}
}

func describeScores(scores []Scored) string {
	parts := make([]string, 0, len(scores))
	for _, score := range scores {
		parts = append(parts, fmt.Sprintf("%s=%.4f[%s]", score.ID, score.Confidence, strings.Join(score.Signals, "+")))
	}
	if len(parts) == 0 {
		return "(nenhum)"
	}
	return strings.Join(parts, " ")
}

func confidenceOf(scores []Scored, id string) float64 {
	for _, score := range scores {
		if score.ID == id {
			return score.Confidence
		}
	}
	return 0
}

func hasSignal(signals []string, want string) bool {
	for _, signal := range signals {
		if signal == want {
			return true
		}
	}
	return false
}

func describeDefinitions(definitions []specialist.Definition) string {
	parts := make([]string, 0, len(definitions))
	for _, definition := range definitions {
		parts = append(parts, definition.ID)
	}
	if len(parts) == 0 {
		return "(nenhum)"
	}
	return strings.Join(parts, " ")
}

// firstDuplicate existe porque a lista entregue ao Needle vira gramática: o
// mesmo especialista declarado duas vezes gastaria uma das cinco vagas sem
// acrescentar opção nenhuma.
func firstDuplicate(definitions []specialist.Definition) string {
	seen := make(map[string]bool, len(definitions))
	for _, definition := range definitions {
		if seen[definition.ID] {
			return definition.ID
		}
		seen[definition.ID] = true
	}
	return ""
}

/* ------------------------------ Normalize ------------------------------- */

func TestNormalizeFoldsAccentsAndCollapsesSpace(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"acento do português", "Compilação", "compilacao"},
		{"cedilha e til", "Segurança à Ação", "seguranca a acao"},
		{"espaços colapsados", "  corrige   o   BUG  ", "corrige o bug"},
		{"tabulação e quebra de linha", "linha\tum\nlinha dois", "linha um linha dois"},
		{"todas as vogais dobradas", "ÁÀÂÃÄÅ ÉÈÊË ÍÌÎÏ ÓÒÔÕÖ ÚÙÛÜ Çç Ññ Ýý", "aaaaaa eeee iiii ooooo uuuu cc nn yy"},
		{"pontuação preservada", "E daí?", "e dai?"},
		{"texto vazio", "", ""},
		{"só espaço", "   \t\n  ", ""},
	}

	for _, each := range cases {
		t.Run(each.name, func(t *testing.T) {
			if got := Normalize(each.in); got != each.want {
				t.Errorf("Normalize(%q): esperava %q, obteve %q", each.in, each.want, got)
			}
		})
	}
}

// Os radicais do catálogo já nascem normalizados. Um trigger com acento ou com
// maiúscula nunca casaria — o texto é dobrado e ele não.
func TestCatalogTriggersAreAlreadyNormalized(t *testing.T) {
	for _, definition := range specialist.All() {
		for _, trigger := range definition.Triggers {
			if got := Normalize(trigger); got != trigger {
				t.Errorf("o radical %q do especialista %q não está normalizado: Normalize devolve %q e ele nunca casaria",
					trigger, definition.ID, got)
			}
		}
	}
}

/* -------------------------------- Score --------------------------------- */

func TestScoreRanksCodeFirstForCompilationBug(t *testing.T) {
	scores := Score(bugText, specialist.All())
	if len(scores) == 0 {
		t.Fatalf("Score(%q): esperava pelo menos um especialista pontuado, obteve nenhum", bugText)
	}
	if scores[0].ID != "code" {
		t.Fatalf("Score(%q): esperava \"code\" em primeiro, obteve %q. Ranking: %s",
			bugText, scores[0].ID, describeScores(scores))
	}
	for _, score := range scores[1:] {
		if score.Confidence >= scores[0].Confidence {
			t.Errorf("Score(%q): esperava \"code\" acima de todos, mas %q empatou ou passou (%.4f >= %.4f)",
				bugText, score.ID, score.Confidence, scores[0].Confidence)
		}
	}
	for _, want := range []string{"bug", "compil"} {
		if !hasSignal(scores[0].Signals, want) {
			t.Errorf("Score(%q): esperava o sinal %q entre os de \"code\", obteve %v", bugText, want, scores[0].Signals)
		}
	}
}

func TestScoreRanksSecurityAboveCodeForXSSReview(t *testing.T) {
	scores := Score(xssText, specialist.All())
	if len(scores) == 0 {
		t.Fatalf("Score(%q): esperava pelo menos um especialista pontuado, obteve nenhum", xssText)
	}
	if scores[0].ID != "security" {
		t.Fatalf("Score(%q): esperava \"security\" em primeiro, obteve %q. Ranking: %s",
			xssText, scores[0].ID, describeScores(scores))
	}
	security, code := confidenceOf(scores, "security"), confidenceOf(scores, "code")
	if security <= code {
		t.Errorf("Score(%q): esperava \"security\" acima de \"code\", obteve security=%.4f e code=%.4f. Ranking: %s",
			xssText, security, code, describeScores(scores))
	}
}

// O desempate por id é o que impede a margem do segundo colocado de virar
// sorteio quando duas pontuações batem.
func TestScoreBreaksTiesByID(t *testing.T) {
	tied := []specialist.Definition{
		{ID: "zeta", Surface: specialist.SurfaceConversation, Triggers: []string{"alvo"}},
		{ID: "alpha", Surface: specialist.SurfaceConversation, Triggers: []string{"alvo"}},
	}
	scores := Score("o alvo do teste", tied)
	if len(scores) != 2 {
		t.Fatalf("Score: esperava 2 pontuações, obteve %d (%s)", len(scores), describeScores(scores))
	}
	if scores[0].Confidence != scores[1].Confidence {
		t.Fatalf("o cenário do teste exige empate: obteve %.4f e %.4f", scores[0].Confidence, scores[1].Confidence)
	}
	if scores[0].ID != "alpha" || scores[1].ID != "zeta" {
		t.Errorf("Score com empate: esperava a ordem [alpha zeta] (desempate por id), obteve [%s %s]",
			scores[0].ID, scores[1].ID)
	}
}

func TestScoreIsDeterministic(t *testing.T) {
	const text = "revisa a segurança do código e o schema do banco"
	candidates := specialist.All()

	first := describeScores(Score(text, candidates))
	for round := 0; round < 50; round++ {
		got := describeScores(Score(text, candidates))
		if got != first {
			t.Fatalf("Score na execução %d: esperava o mesmo ranking de sempre\n  esperava: %s\n  obteve:   %s",
				round, first, got)
		}
	}
}

func TestScoreIgnoresTextWithoutSignal(t *testing.T) {
	if scores := Score("", specialist.All()); scores != nil {
		t.Errorf("Score(\"\"): esperava nil, obteve %s", describeScores(scores))
	}
	requireNoLexicalSignal(t, noSignalText)
}

/* --------------------------- ParseModeCommand --------------------------- */

// O comando vale sozinho ou com o pedido na mesma linha: obrigar duas mensagens
// para trocar de modo e pedir a coisa seria uma cerimônia que ninguém cumpre.
//
// E modo inexistente NÃO vira comando — vira texto. Engolir "/mode xpto" em
// silêncio faria a pessoa achar que trocou de modo quando não trocou.
func TestParseModeCommand(t *testing.T) {
	cases := []struct {
		name     string
		in       string
		wantMode string
		wantRest string
		wantOK   bool
	}{
		{"comando sozinho", "/mode code", "code", "", true},
		{"comando com o pedido na mesma linha", "/mode code corrige o login", "code", "corrige o login", true},
		{"modo inexistente não é comando", "/mode xpto", "", "/mode xpto", false},
		{"o master não é destino de /mode", "/mode master", "", "/mode master", false},
		{"texto sem /mode passa intacto", "corrige o login", "", "corrige o login", false},
		// "/mode" sem argumento não tem para onde ir: fica texto, e o master
		// responde em vez de trocar a tela por nada.
		{"/mode sem argumento", "/mode", "", "/mode", false},
	}

	for _, each := range cases {
		t.Run(each.name, func(t *testing.T) {
			mode, rest, ok := ParseModeCommand(each.in)
			if ok != each.wantOK {
				t.Fatalf("ParseModeCommand(%q): esperava ok=%v, obteve %v (modo %q, resto %q)",
					each.in, each.wantOK, ok, mode, rest)
			}
			if mode != each.wantMode {
				t.Errorf("ParseModeCommand(%q): esperava o modo %q, obteve %q", each.in, each.wantMode, mode)
			}
			if rest != each.wantRest {
				t.Errorf("ParseModeCommand(%q): esperava o resto %q, obteve %q", each.in, each.wantRest, rest)
			}
		})
	}
}

/* -------------------------------- Route --------------------------------- */

// O seletor da interface vence o modo já gravado na conversa: é a escolha mais
// recente e a mais deliberada. Por isso `Current` vem preenchido aqui — sem ele
// o teste não distinguiria "explícito venceu" de "não havia com quem competir".
func TestRouteExplicitChoiceWins(t *testing.T) {
	router := NewRouter(nil, &stubClassifier{verdict: ClassifierVerdict{Specialist: "code", Confidence: 1}})

	route := router.Route(context.Background(), RouteInput{Text: xssText, Explicit: "design", Current: "code"})

	if route.Reason != protocol.RouteExplicit {
		t.Errorf("Route com Explicit: esperava o motivo %q, obteve %q", protocol.RouteExplicit, route.Reason)
	}
	if route.Specialist != "design" {
		t.Errorf("Route com Explicit: esperava o especialista %q, obteve %q", "design", route.Specialist)
	}
	if route.Confidence != 1 {
		t.Errorf("Route com Explicit: esperava confiança 1, obteve %v", route.Confidence)
	}
	if route.Previous != "code" {
		t.Errorf("Route com Explicit: esperava Previous %q preservado, obteve %q", "code", route.Previous)
	}
	if route.Surface != string(specialist.SurfaceCanvas) {
		t.Errorf("Route com Explicit: esperava a superfície %q, obteve %q", specialist.SurfaceCanvas, route.Surface)
	}
}

func TestRouteUsesHeuristicWhenLexiconIsDecisive(t *testing.T) {
	// Os dois degraus de IA ficam proibidos: quando o léxico decide com folga,
	// nem o modelo local nem o grande têm o que acrescentar.
	router := NewRouter(forbiddenIntent{t: t}, forbiddenClassifier{t: t})

	route := router.Route(context.Background(), RouteInput{Text: xssText})

	if route.Reason != protocol.RouteHeuristic {
		t.Fatalf("Route(%q): esperava o motivo %q, obteve %q (confiança %.4f)",
			xssText, protocol.RouteHeuristic, route.Reason, route.Confidence)
	}
	if route.Specialist != "security" {
		t.Errorf("Route(%q): esperava o especialista %q, obteve %q", xssText, "security", route.Specialist)
	}
	if route.Confidence < MinConfidence {
		t.Errorf("Route(%q): esperava confiança >= %v no degrau léxico, obteve %.4f", xssText, MinConfidence, route.Confidence)
	}
	if len(route.Signals) == 0 {
		t.Errorf("Route(%q): esperava os sinais que pesaram na decisão, obteve nenhum", xssText)
	}
}

/* ---------------------------- degrau 2: Needle --------------------------- */

// O degrau local existe para NÃO ir à rede: o que o léxico não resolve, um modelo
// de 14 MB resolve na máquina, em milissegundos e sem custo por token. Por isso o
// modelo grande fica PROIBIDO aqui — se ele for consultado depois de um veredito
// bom do Needle, a economia que justifica o degrau desapareceu.
func TestRouteUsesNeedleWhenLexiconIsUndecided(t *testing.T) {
	requireUndecidedLexicon(t, ambiguousText)

	// O limiar entra na lista: `>=` é a regra, e um veredito exatamente em
	// NeedleMinConfidence tem de ser aceito. Trocar o `>=` por `>` passaria em
	// qualquer teste que só usasse 0.9.
	for _, reported := range []float64{NeedleMinConfidence, 0.9, 1} {
		t.Run(fmt.Sprintf("confiança %v", reported), func(t *testing.T) {
			local := &stubIntent{
				ready:   true,
				verdict: ClassifierVerdict{Specialist: "work", Confidence: reported, Why: "é uma rotina"},
			}
			router := NewRouter(local, forbiddenClassifier{t: t})

			route := router.Route(context.Background(), RouteInput{Text: ambiguousText})

			if local.calls != 1 {
				t.Fatalf("esperava 1 consulta ao roteador local, obteve %d", local.calls)
			}
			if local.lastPrompt != ambiguousText {
				t.Errorf("o roteador local recebeu o prompt %q, esperava %q", local.lastPrompt, ambiguousText)
			}
			if route.Reason != protocol.RouteNeedle {
				t.Fatalf("Route(%q): esperava o motivo %q, obteve %q", ambiguousText, protocol.RouteNeedle, route.Reason)
			}
			if route.Specialist != "work" {
				t.Errorf("Route(%q): esperava o especialista %q, obteve %q", ambiguousText, "work", route.Specialist)
			}
			if route.Confidence != reported {
				t.Errorf("Route(%q): esperava a confiança %v do veredito local, obteve %v",
					ambiguousText, reported, route.Confidence)
			}
			if want := string(specialist.GetOrDefault("work").Surface); route.Surface != want {
				t.Errorf("Route pelo Needle: esperava a superfície %q, obteve %q", want, route.Surface)
			}
		})
	}
}

// O que chega ao Needle é o que ele PODE escolher, e a lista é curta de propósito:
// acima de cinco ferramentas ele liga a recuperação por embedding e escolhe as
// cinco sozinho — uma heurística em cima da nossa, feita com menos informação.
//
// `shortlistFor` tem teste próprio; este cobre a LIGAÇÃO. Um Route que esquecesse
// de encurtar passaria lá e falharia aqui.
func TestRouteGivesNeedleAtMostTheToolBudget(t *testing.T) {
	requireUndecidedLexicon(t, ambiguousText)
	if len(specialist.All()) <= NeedleToolBudget {
		t.Fatalf("o cenário exige um catálogo maior que o orçamento %d, mas ele tem %d especialistas",
			NeedleToolBudget, len(specialist.All()))
	}

	local := &stubIntent{ready: true, verdict: ClassifierVerdict{Specialist: "work", Confidence: 0.9}}
	NewRouter(local, forbiddenClassifier{t: t}).Route(context.Background(), RouteInput{Text: ambiguousText})

	if len(local.lastIDs) != NeedleToolBudget {
		t.Fatalf("o roteador local recebeu %d candidatos (%s), esperava %d",
			len(local.lastIDs), strings.Join(local.lastIDs, " "), NeedleToolBudget)
	}
	// E o mais pontuado pelo léxico precisa estar na frente: entregar cinco
	// quaisquer tiraria do Needle justamente o candidato que o léxico já apontou.
	scores := Score(ambiguousText, specialist.All())
	if local.lastIDs[0] != scores[0].ID {
		t.Errorf("o roteador local recebeu %q em primeiro, esperava o mais pontuado %q. Lista: %s",
			local.lastIDs[0], scores[0].ID, strings.Join(local.lastIDs, " "))
	}
}

// Veredito abaixo do limiar SOBE para o modelo grande.
//
// O limiar é 0.70 e não 0.5 porque o modo é gravado na conversa e não se
// reavalia: alguns segundos de rede custam uma vez, errar o modo custa a conversa
// inteira.
func TestRouteFallsToModelWhenNeedleIsNotConfident(t *testing.T) {
	requireUndecidedLexicon(t, ambiguousText)

	for _, reported := range []float64{0, 0.4, NeedleMinConfidence - 0.01} {
		t.Run(fmt.Sprintf("confiança %v", reported), func(t *testing.T) {
			local := &stubIntent{ready: true, verdict: ClassifierVerdict{Specialist: "work", Confidence: reported}}
			classifier := &stubClassifier{verdict: ClassifierVerdict{Specialist: "data", Confidence: 0.8}}

			route := NewRouter(local, classifier).Route(context.Background(), RouteInput{Text: ambiguousText})

			if local.calls != 1 {
				t.Fatalf("esperava 1 consulta ao roteador local, obteve %d", local.calls)
			}
			if classifier.calls != 1 {
				t.Fatalf("o veredito local ficou abaixo de %v e o modelo grande não foi consultado (%d consultas)",
					NeedleMinConfidence, classifier.calls)
			}
			if route.Reason != protocol.RouteModel {
				t.Errorf("Route: esperava o motivo %q, obteve %q", protocol.RouteModel, route.Reason)
			}
			if route.Specialist != "data" {
				t.Errorf("Route: esperava o especialista %q, do modelo grande, obteve %q", "data", route.Specialist)
			}
		})
	}
}

// Veredito de quem está fora da política é DESCARTADO, e a decisão segue para o
// degrau seguinte. Aceitá-lo faria o roteamento ser o caminho barato para sair da
// lista do admin.
func TestRouteIgnoresNeedleVerdictOutsideAllowed(t *testing.T) {
	requireUndecidedLexicon(t, ambiguousText)

	local := &stubIntent{ready: true, verdict: ClassifierVerdict{Specialist: "security", Confidence: 0.99}}
	classifier := &stubClassifier{verdict: ClassifierVerdict{Specialist: "code", Confidence: 0.8}}

	route := NewRouter(local, classifier).Route(context.Background(), RouteInput{
		Text:    ambiguousText,
		Allowed: []string{"chat", "code"},
	})

	if route.Specialist == "security" {
		t.Fatalf("Route aceitou o veredito local %q, que está fora de Allowed", route.Specialist)
	}
	if route.Reason != protocol.RouteModel {
		t.Fatalf("Route: esperava o motivo %q (o veredito local foi descartado), obteve %q",
			protocol.RouteModel, route.Reason)
	}
	if route.Specialist != "code" {
		t.Errorf("Route: esperava o especialista %q, obteve %q", "code", route.Specialist)
	}
}

// Sem a biblioteca nativa — build sem a tag `needle`, ou DLL ausente — o degrau
// NÃO EXISTE e a cascata encurta para léxico → modelo grande. Classificar num
// Needle que não está pronto é o caminho para o gateway não abrir numa estação
// que só tem o binário.
func TestRouteSkipsNeedleWhenNotReady(t *testing.T) {
	requireUndecidedLexicon(t, ambiguousText)

	local := &stubIntent{ready: false, verdict: ClassifierVerdict{Specialist: "work", Confidence: 1}}
	classifier := &stubClassifier{verdict: ClassifierVerdict{Specialist: "data", Confidence: 0.8}}

	route := NewRouter(local, classifier).Route(context.Background(), RouteInput{Text: ambiguousText})

	if local.calls != 0 {
		t.Fatalf("o roteador local classificou %d vez(es) sem estar pronto", local.calls)
	}
	if route.Reason != protocol.RouteModel {
		t.Fatalf("Route: esperava o motivo %q, obteve %q", protocol.RouteModel, route.Reason)
	}
	if route.Specialist != "data" {
		t.Errorf("Route: esperava o especialista %q, obteve %q", "data", route.Specialist)
	}
}

// Erro do degrau local não derruba a decisão: ele sobe para o modelo grande. A
// biblioteca nativa é a peça mais frágil da cascata, e uma falha dela não pode
// virar falha do turno.
func TestRouteFallsToModelWhenNeedleFails(t *testing.T) {
	requireUndecidedLexicon(t, ambiguousText)

	local := &stubIntent{ready: true, err: errors.New("a biblioteca nativa não respondeu")}
	classifier := &stubClassifier{verdict: ClassifierVerdict{Specialist: "data", Confidence: 0.8}}

	route := NewRouter(local, classifier).Route(context.Background(), RouteInput{Text: ambiguousText})

	if local.calls != 1 {
		t.Fatalf("esperava 1 consulta ao roteador local, obteve %d", local.calls)
	}
	if route.Reason != protocol.RouteModel {
		t.Fatalf("Route: esperava o motivo %q, obteve %q", protocol.RouteModel, route.Reason)
	}
	if route.Specialist != "data" {
		t.Errorf("Route: esperava o especialista %q, obteve %q", "data", route.Specialist)
	}
}

// Sem modelo grande, veredito local fraco cai no PADRÃO — não no veredito fraco.
// Aceitar 0.3 "porque não havia melhor" é a mesma coisa que não ter limiar.
func TestRouteFallsBackWhenNeedleIsWeakAndThereIsNoModel(t *testing.T) {
	requireUndecidedLexicon(t, ambiguousText)

	local := &stubIntent{ready: true, verdict: ClassifierVerdict{Specialist: "work", Confidence: 0.3}}

	route := NewRouter(local, nil).Route(context.Background(), RouteInput{Text: ambiguousText})

	if route.Reason != protocol.RouteFallback {
		t.Fatalf("Route: esperava o motivo %q, obteve %q", protocol.RouteFallback, route.Reason)
	}
	if route.Specialist != specialist.DefaultID {
		t.Errorf("Route: esperava o padrão %q, obteve %q", specialist.DefaultID, route.Specialist)
	}
}

/* ------------------------- degrau 3: modelo grande ----------------------- */

func TestRouteUsesClassifierWhenLexiconIsUndecided(t *testing.T) {
	// Guarda do cenário: o léxico precisa ter opinião e mesmo assim ficar
	// abaixo do limiar, senão este teste passaria exercitando a heurística.
	requireUndecidedLexicon(t, ambiguousText)

	classifier := &stubClassifier{verdict: ClassifierVerdict{Specialist: "work", Confidence: 0.8, Why: "é uma rotina"}}
	// Sem Needle: a cascata encurta sozinha para léxico → modelo grande, que é
	// como o gateway roda numa estação sem a biblioteca nativa.
	router := NewRouter(nil, classifier)

	route := router.Route(context.Background(), RouteInput{Text: ambiguousText})

	if classifier.calls != 1 {
		t.Fatalf("esperava 1 consulta ao classificador, obteve %d", classifier.calls)
	}
	if classifier.lastPrompt != ambiguousText {
		t.Errorf("o classificador recebeu o prompt %q, esperava %q", classifier.lastPrompt, ambiguousText)
	}
	if len(classifier.lastIDs) != len(specialist.All()) {
		t.Errorf("o classificador recebeu %d candidatos, esperava %d", len(classifier.lastIDs), len(specialist.All()))
	}
	if route.Reason != protocol.RouteModel {
		t.Errorf("Route(%q): esperava o motivo %q, obteve %q", ambiguousText, protocol.RouteModel, route.Reason)
	}
	if route.Specialist != "work" {
		t.Errorf("Route(%q): esperava o especialista %q, obteve %q", ambiguousText, "work", route.Specialist)
	}
	if route.Confidence != 0.8 {
		t.Errorf("Route(%q): esperava a confiança 0.8 do modelo, obteve %v", ambiguousText, route.Confidence)
	}
}

// Confiança fora de [0,1] não derruba o turno; vira desconfiança no número.
func TestRouteClampsClassifierConfidenceOutOfRange(t *testing.T) {
	requireNoLexicalSignal(t, noSignalText)

	for _, reported := range []float64{0, -1, 1.5} {
		classifier := &stubClassifier{verdict: ClassifierVerdict{Specialist: "data", Confidence: reported}}
		route := NewRouter(nil, classifier).Route(context.Background(), RouteInput{Text: noSignalText})

		if route.Reason != protocol.RouteModel {
			t.Fatalf("confiança %v: esperava o motivo %q, obteve %q", reported, protocol.RouteModel, route.Reason)
		}
		if route.Confidence != MinConfidence {
			t.Errorf("confiança %v devolvida pelo modelo: esperava o corte em %v, obteve %v",
				reported, MinConfidence, route.Confidence)
		}
	}
}

// Modo é da CONVERSA: com `Current` preenchido a rota sai sticky imediatamente,
// antes de pontuar léxico e antes de qualquer classificador.
//
// Reclassificar a cada linha custa latência antes de toda resposta, faz "agora
// corrige o login" — que só faz sentido dentro do assunto anterior — ser lido
// como pedido isolado, e troca a tela debaixo de quem estava no meio de um
// trabalho.
func TestRouteIsStickyBeforeAnyClassifier(t *testing.T) {
	cases := []struct {
		name string
		text string
	}{
		{"texto sem sinal léxico", noSignalText},
		// Este é o caso que prova a regra: se o léxico ainda tivesse voz, uma
		// frase sobre vulnerabilidade arrancaria do modo de dados uma conversa
		// que estava no meio de um trabalho de dados.
		{"texto com sinal léxico forte de outro especialista", xssText},
	}

	for _, each := range cases {
		t.Run(each.name, func(t *testing.T) {
			router := NewRouter(forbiddenIntent{t: t}, forbiddenClassifier{t: t})

			route := router.Route(context.Background(), RouteInput{Text: each.text, Current: "data"})

			if route.Reason != protocol.RouteSticky {
				t.Fatalf("Route com Current preenchido: esperava o motivo %q, obteve %q",
					protocol.RouteSticky, route.Reason)
			}
			if route.Specialist != "data" {
				t.Errorf("Route sticky: esperava o especialista %q, obteve %q", "data", route.Specialist)
			}
			if route.Previous != "data" {
				t.Errorf("Route sticky: esperava Previous %q, obteve %q", "data", route.Previous)
			}
			if route.Confidence != 1 {
				t.Errorf("Route sticky: esperava confiança 1 — não houve classificação de que duvidar —, obteve %v",
					route.Confidence)
			}
			if len(route.Signals) != 0 {
				t.Errorf("Route sticky: esperava nenhum sinal (nada foi pontuado), obteve %v", route.Signals)
			}
			if route.Surface != string(specialist.SurfaceSchema) {
				t.Errorf("Route sticky: esperava a superfície %q, obteve %q", specialist.SurfaceSchema, route.Surface)
			}
		})
	}
}

// `/mode` é a única coisa que troca o modo de uma conversa em andamento junto
// com o seletor — e vence os dois: é a escolha mais recente e a mais deliberada.
func TestRouteModeCommandBeatsCurrentAndExplicit(t *testing.T) {
	// O pedido vem na mesma linha do comando para o teste cobrir o caminho real:
	// trocar de modo E pedir a coisa numa mensagem só.
	const command = "/mode security revisa isso aqui"

	cases := []struct {
		name string
		in   RouteInput
	}{
		{"vence o modo já gravado na conversa", RouteInput{Text: command, Current: "data"}},
		{"vence a escolha do seletor", RouteInput{Text: command, Explicit: "design"}},
		{"vence os dois ao mesmo tempo", RouteInput{Text: command, Current: "data", Explicit: "design"}},
	}

	for _, each := range cases {
		t.Run(each.name, func(t *testing.T) {
			// Trocar de modo não pergunta a ninguém: o comando JÁ é a decisão.
			router := NewRouter(forbiddenIntent{t: t}, forbiddenClassifier{t: t})

			route := router.Route(context.Background(), each.in)

			if route.Reason != protocol.RouteExplicit {
				t.Fatalf("Route com /mode: esperava o motivo %q, obteve %q", protocol.RouteExplicit, route.Reason)
			}
			if route.Specialist != "security" {
				t.Errorf("Route com /mode: esperava o especialista %q, obteve %q", "security", route.Specialist)
			}
			if route.Confidence != 1 {
				t.Errorf("Route com /mode: esperava confiança 1, obteve %v", route.Confidence)
			}
			// Previous carrega o modo ANTERIOR, que é o que a interface usa para
			// desenhar a faixa "agora é X" — perdê-lo apagaria a transição.
			if route.Previous != each.in.Current {
				t.Errorf("Route com /mode: esperava Previous %q, obteve %q", each.in.Current, route.Previous)
			}
			if route.Surface != string(specialist.SurfaceFindings) {
				t.Errorf("Route com /mode: esperava a superfície %q, obteve %q",
					specialist.SurfaceFindings, route.Surface)
			}
		})
	}
}

func TestRouteFallsBackToChat(t *testing.T) {
	requireNoLexicalSignal(t, noSignalText)
	router := NewRouter(nil, nil)

	route := router.Route(context.Background(), RouteInput{Text: noSignalText})

	if route.Reason != protocol.RouteFallback {
		t.Fatalf("Route sem sinal, sem Previous e sem classificador: esperava o motivo %q, obteve %q",
			protocol.RouteFallback, route.Reason)
	}
	if route.Specialist != specialist.DefaultID {
		t.Errorf("Route de fallback: esperava o especialista %q, obteve %q", specialist.DefaultID, route.Specialist)
	}
	if route.Confidence != 0.25 {
		t.Errorf("Route de fallback: esperava confiança 0.25, obteve %v", route.Confidence)
	}
	if route.Surface != string(specialist.SurfaceConversation) {
		t.Errorf("Route de fallback: esperava a superfície %q, obteve %q", specialist.SurfaceConversation, route.Surface)
	}
}

// A troca de especialista e a troca de tela são o MESMO evento: rota sem
// superfície deixa a tela um quadro atrás do ícone.
func TestRouteAlwaysFillsSurface(t *testing.T) {
	requireNoLexicalSignal(t, noSignalText)
	plain := NewRouter(nil, nil)
	withModel := NewRouter(nil, &stubClassifier{verdict: ClassifierVerdict{Specialist: "work", Confidence: 0.8}})

	cases := []struct {
		name   string
		router *Router
		in     RouteInput
	}{
		{"escolha explícita", plain, RouteInput{Text: noSignalText, Explicit: "office"}},
		{"comando /mode", plain, RouteInput{Text: "/mode tune"}},
		{"decisão léxica", plain, RouteInput{Text: xssText}},
		{"decisão do modelo", withModel, RouteInput{Text: noSignalText}},
		{"sticky", plain, RouteInput{Text: noSignalText, Current: "fluxo"}},
		{"fallback", plain, RouteInput{Text: noSignalText}},
		{"explícito inexistente", plain, RouteInput{Text: noSignalText, Explicit: "nao-existe"}},
		{"lista permitida sem ninguém real", plain, RouteInput{Text: xssText, Allowed: []string{"nao-existe"}}},
	}

	for _, each := range cases {
		t.Run(each.name, func(t *testing.T) {
			route := each.router.Route(context.Background(), each.in)
			if route.Specialist == "" {
				t.Fatalf("Route devolveu especialista vazio (motivo %q)", route.Reason)
			}
			if route.Surface == "" {
				t.Fatalf("Route devolveu Surface vazia para o especialista %q (motivo %q) — a tela depende dela",
					route.Specialist, route.Reason)
			}
			want := string(specialist.GetOrDefault(route.Specialist).Surface)
			if route.Surface != want {
				t.Errorf("Route: esperava a superfície %q do especialista %q, obteve %q",
					want, route.Specialist, route.Surface)
			}
		})
	}
}

func TestRouteRespectsAllowedList(t *testing.T) {
	requireNoLexicalSignal(t, noSignalText)

	t.Run("o léxico não escolhe quem está fora da lista", func(t *testing.T) {
		route := NewRouter(nil, nil).Route(context.Background(), RouteInput{
			Text:    xssText,
			Allowed: []string{"chat", "office"},
		})
		if route.Specialist == "security" {
			t.Fatalf("Route escolheu %q, que está fora de Allowed", route.Specialist)
		}
		if route.Specialist != "chat" {
			t.Errorf("Route: esperava o fallback %q, obteve %q", "chat", route.Specialist)
		}
	})

	t.Run("escolha explícita fora da lista é ignorada", func(t *testing.T) {
		route := NewRouter(nil, nil).Route(context.Background(), RouteInput{
			Text:     noSignalText,
			Explicit: "security",
			Allowed:  []string{"chat", "code"},
		})
		if route.Specialist == "security" {
			t.Fatalf("Route aceitou o explícito %q, que está fora de Allowed", route.Specialist)
		}
		if route.Reason != protocol.RouteFallback {
			t.Errorf("Route: esperava o motivo %q, obteve %q", protocol.RouteFallback, route.Reason)
		}
	})

	t.Run("sticky não ressuscita quem saiu da lista", func(t *testing.T) {
		route := NewRouter(nil, nil).Route(context.Background(), RouteInput{
			Text:    noSignalText,
			Current: "security",
			Allowed: []string{"chat", "code"},
		})
		if route.Specialist == "security" {
			t.Fatalf("Route grudou em %q, que está fora de Allowed", route.Specialist)
		}
		if route.Reason != protocol.RouteFallback {
			t.Errorf("Route: esperava o motivo %q, obteve %q", protocol.RouteFallback, route.Reason)
		}
	})

	t.Run("veredito do modelo fora da lista é ignorado", func(t *testing.T) {
		classifier := &stubClassifier{verdict: ClassifierVerdict{Specialist: "security", Confidence: 0.99}}
		route := NewRouter(nil, classifier).Route(context.Background(), RouteInput{
			Text:    noSignalText,
			Allowed: []string{"chat", "code"},
		})
		if route.Specialist == "security" {
			t.Fatalf("Route aceitou o veredito %q, que está fora de Allowed", route.Specialist)
		}
		if route.Reason != protocol.RouteFallback {
			t.Errorf("Route: esperava o motivo %q, obteve %q", protocol.RouteFallback, route.Reason)
		}
	})

	t.Run("sem o padrão na lista cai no primeiro permitido", func(t *testing.T) {
		route := NewRouter(nil, nil).Route(context.Background(), RouteInput{
			Text:    noSignalText,
			Allowed: []string{"office", "data"},
		})
		if route.Specialist != "office" {
			t.Errorf("Route: esperava o primeiro permitido %q (ordem do catálogo), obteve %q", "office", route.Specialist)
		}
		if route.Surface != string(specialist.SurfaceDocument) {
			t.Errorf("Route: esperava a superfície %q, obteve %q", specialist.SurfaceDocument, route.Surface)
		}
	})
}

/* ----------------------------- shortlistFor ------------------------------ */

// O que o Needle recebe é o que ele pode escolher: acima de cinco ferramentas
// ele liga a recuperação por embedding e seleciona sozinho — uma heurística em
// cima da nossa, feita com menos informação. E lista vazia é pior: o modelo não
// decidiria nada, sempre.
func TestShortlistForRespectsBudgetAndFillsTheRest(t *testing.T) {
	candidates := specialist.All()
	if len(candidates) <= NeedleToolBudget {
		t.Fatalf("o cenário exige um catálogo maior que o orçamento %d, mas ele tem %d especialistas",
			NeedleToolBudget, len(candidates))
	}

	t.Run("os mais pontuados vêm primeiro", func(t *testing.T) {
		scores := Score(xssText, candidates)
		if len(scores) == 0 {
			t.Fatalf("o cenário exige o léxico com opinião sobre %q, mas ele não pontuou ninguém", xssText)
		}

		shortlist := shortlistFor(scores, candidates, NeedleToolBudget)

		if len(shortlist) != NeedleToolBudget {
			t.Fatalf("shortlistFor: esperava %d candidatos, obteve %d (%s)",
				NeedleToolBudget, len(shortlist), describeDefinitions(shortlist))
		}
		for index, score := range scores {
			if index >= len(shortlist) {
				break
			}
			if shortlist[index].ID != score.ID {
				t.Errorf("shortlistFor: na posição %d esperava %q (o %dº mais pontuado), obteve %q. Lista: %s",
					index, score.ID, index+1, shortlist[index].ID, describeDefinitions(shortlist))
			}
		}
		if repeated := firstDuplicate(shortlist); repeated != "" {
			t.Errorf("shortlistFor devolveu %q duas vezes: %s", repeated, describeDefinitions(shortlist))
		}
	})

	t.Run("completa com o resto quando o léxico não pontuou ninguém", func(t *testing.T) {
		requireNoLexicalSignal(t, noSignalText)
		scores := Score(noSignalText, candidates)

		shortlist := shortlistFor(scores, candidates, NeedleToolBudget)

		if len(shortlist) != NeedleToolBudget {
			t.Fatalf("shortlistFor com scores vazio: esperava %d candidatos (senão o Needle decide entre nada), obteve %d (%s)",
				NeedleToolBudget, len(shortlist), describeDefinitions(shortlist))
		}
		// Sem pontuação sobra a ordem do catálogo, que é fixa — o mesmo pedido
		// não pode declarar ferramentas diferentes a cada execução.
		for index, definition := range shortlist {
			if definition.ID != candidates[index].ID {
				t.Errorf("shortlistFor sem pontuação: na posição %d esperava %q (ordem do catálogo), obteve %q. Lista: %s",
					index, candidates[index].ID, definition.ID, describeDefinitions(shortlist))
			}
		}
	})

	t.Run("orçamento a partir do tamanho do catálogo devolve todo mundo", func(t *testing.T) {
		for _, limit := range []int{len(candidates), len(candidates) + 1, 0, -1} {
			shortlist := shortlistFor(nil, candidates, limit)
			if len(shortlist) != len(candidates) {
				t.Errorf("shortlistFor com limite %d: esperava os %d candidatos, obteve %d (%s)",
					limit, len(candidates), len(shortlist), describeDefinitions(shortlist))
			}
		}
	})
}
