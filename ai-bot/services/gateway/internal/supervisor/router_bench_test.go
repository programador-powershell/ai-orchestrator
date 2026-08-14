// Medição do roteamento — o primeiro degrau da cascata, antes do primeiro token.
//
// O que estas medições precisam mostrar, e por quê:
//
//   - BenchmarkRouteSticky é o caminho de quase toda mensagem. A regra de
//     produto diz que a conversa tem um modo decidido no PRIMEIRO input; da
//     segunda mensagem em diante nada é pontuado. Se este número não for
//     praticamente zero, a regra foi quebrada em algum lugar e o léxico voltou
//     a rodar a cada linha.
//   - BenchmarkRouteFirstInput é a cascata SÓ com o léxico (sem Needle e sem
//     modelo grande). É o custo real do primeiro input numa estação offline.
//   - BenchmarkScore isola o classificador léxico: dez especialistas contra
//     ~150 radicais.
//   - BenchmarkNormalize isola a dobra de acentos, que roda sobre o texto e
//     sobre cada radical.
package supervisor

import (
	"context"
	"testing"

	"aibot/gateway/internal/protocol"
	"aibot/gateway/internal/specialist"
)

// benchRequestText é um primeiro input de verdade: várias frases, acento,
// maiúscula, pontuação e sinais de mais de um especialista ao mesmo tempo —
// que é o caso em que o léxico tem de pontuar todo mundo antes de decidir.
// Um texto de três palavras mediria o caso que não dói.
const benchRequestText = "Preciso revisar a segurança do endpoint de autenticação do gateway: " +
	"tem um SQL injection no formulário de login e o token exposto no log de erro. " +
	"Depois disso, corrige o bug de compilação em TypeScript, roda os testes e " +
	"abre um commit explicando a mudança na função de sessão."

// benchDecisiveText é um primeiro input FOCADO — o caso em que o léxico decide
// sozinho e a cascata para no primeiro degrau.
//
// Existe separado de benchRequestText porque os dois medem coisas diferentes: o
// texto misto acima empata "code" e "security" em 1.0, não alcança a margem
// mínima e a rota cai para o modelo (fallback, sem classificador). Medir a
// cascata com ele mediria o caminho do INDECISO; medir Score com ele mede o
// pior caso do léxico, que é justamente pontuar todo mundo. Cada benchmark usa
// o texto que corresponde ao caminho que ele diz medir.
const benchDecisiveText = "Revisa a vulnerabilidade de XSS e a credencial exposta " +
	"no formulário de login do portal."

// benchAccentedPhrase é a frase da medição de Normalize. Acento em toda vogal,
// cedilha, maiúscula e espaço repetido: se a dobra fosse barata só em ASCII, é
// aqui que apareceria.
const benchAccentedPhrase = "Revisão de SEGURANÇA: a configuração da automação não é órfã, " +
	"é só ambígua — corrija a validação, o índice e a três vírgulas."

func BenchmarkNormalize(b *testing.B) {
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		Normalize(benchAccentedPhrase)
	}
}

func BenchmarkScore(b *testing.B) {
	candidates := specialist.All()

	// Guarda do cenário: um texto que não pontua ninguém mediria o laço vazio.
	if scores := Score(benchRequestText, candidates); len(scores) < 3 {
		b.Fatalf("o cenário exige o léxico pontuando vários especialistas, mas ele pontuou %d", len(scores))
	}

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		Score(benchRequestText, candidates)
	}
}

// BenchmarkRouteFirstInput mede a cascata inteira do primeiro input com os dois
// classificadores AUSENTES. É de propósito: com eles, a medição seria a do stub
// (ou a da rede), não a do roteamento. Este é o custo que o gateway paga numa
// estação sem a biblioteca nativa e sem conexão.
func BenchmarkRouteFirstInput(b *testing.B) {
	router := NewRouter(nil, nil)
	input := RouteInput{Text: benchDecisiveText}

	if route := router.Route(context.Background(), input); route.Reason != protocol.RouteHeuristic {
		b.Fatalf("o cenário exige o léxico decidindo sozinho, mas o motivo foi %q (confiança %.4f)",
			route.Reason, route.Confidence)
	}

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		router.Route(context.Background(), input)
	}
}

// TestRouteStickyDoesNotAllocate transforma a promessa de arquitetura em teste.
//
// "Custa zero" era comentário; agora é asserção. O caminho sticky chegou a
// alocar 4 KB por mensagem porque candidatesFor copiava o catálogo inteiro só
// para perguntar se um id estava na lista — um custo invisível em qualquer
// teste de comportamento, já que a rota devolvida estava certíssima.
func TestRouteStickyDoesNotAllocate(t *testing.T) {
	router := NewRouter(nil, nil)
	input := RouteInput{Text: benchRequestText, Current: "data"}

	allocations := testing.AllocsPerRun(200, func() {
		router.Route(context.Background(), input)
	})
	if allocations != 0 {
		t.Errorf("Route no caminho sticky alocou %.0f vez(es) por chamada; o caminho de quase toda mensagem tem de custar zero",
			allocations)
	}
}

// O cache de radicais é uma otimização com um jeito silencioso de falhar: se
// ele discordasse de Normalize, o roteamento passaria a casar radicais
// diferentes dos do catálogo e a decisão mudaria sem nenhum teste reclamar.
func TestNormalizedTriggerCacheAgreesWithNormalize(t *testing.T) {
	cache := activeCatalog()
	for _, definition := range specialist.All() {
		for _, trigger := range definition.Triggers {
			if got, want := cache.trigger(trigger), Normalize(trigger); got != want {
				t.Errorf("o radical %q de %q: o cache devolveu %q e Normalize devolve %q",
					trigger, definition.ID, got, want)
			}
		}
	}

	// E o caminho de fora do catálogo tem de continuar valendo: Score é
	// exportada e recebe especialistas montados à mão.
	if got, want := cache.trigger("Radical NÃO catalogado"), Normalize("Radical NÃO catalogado"); got != want {
		t.Errorf("radical fora do catálogo: o cache devolveu %q, esperava %q", got, want)
	}
}

// BenchmarkRouteSticky é o caminho de 90% das mensagens: a conversa já tem modo,
// e a rota tem de sair sem pontuar nada e sem consultar classificador nenhum.
// O número aqui é um teste de arquitetura disfarçado de benchmark.
func BenchmarkRouteSticky(b *testing.B) {
	router := NewRouter(nil, nil)
	// O texto carrega sinal léxico forte de OUTRO especialista. Se alguém
	// reintroduzir a pontuação neste caminho, o custo aparece aqui na hora.
	input := RouteInput{Text: benchRequestText, Current: "data"}

	if route := router.Route(context.Background(), input); route.Reason != protocol.RouteSticky {
		b.Fatalf("o cenário exige a rota sticky, mas o motivo foi %q", route.Reason)
	}

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		router.Route(context.Background(), input)
	}
}
