// Medição da memória — ela roda ANTES de cada turno.
//
// O supervisor chama Search(pergunta, 5) na montagem de todo prompt (ver
// internal/supervisor/supervisor.go). Não é um caminho de manutenção: é tempo
// que a pessoa espera olhando para o cursor, antes do primeiro token. Por isso
// a carga aqui é a de uma memória VIVIDA — 500 itens de texto corrido em
// português, com tags e importâncias variadas —, e não três itens de exemplo.
package memory

import (
	"encoding/json"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// benchItemCount é o tamanho da memória medida. Quinhentos itens é o que uma
// pessoa acumula em alguns meses de uso diário com captura automática ligada —
// abaixo disso qualquer implementação parece rápida.
const benchItemCount = 500

// benchQuery é uma pergunta de verdade, com acento, maiúscula e palavras curtas
// que a tokenização descarta. Consulta de uma palavra só mediria o caso fácil.
const benchQuery = "Como o gateway trata a máscara do frame no WebSocket e o teto de mensagem?"

// Vocabulário do domínio, para o conteúdo ter a densidade léxica de texto real:
// muitos termos por item, com repetição entre itens (é isso que faz a busca
// realmente ter de pontuar vários candidatos em vez de casar um só).
var (
	benchSubjects = []string{
		"o gateway", "o supervisor", "o roteador léxico", "a memória persistente",
		"o transporte WebSocket", "o executor de ferramentas", "o modelo local Needle",
		"o cofre de segredos", "a fila de eventos", "o registro append-only",
	}
	benchVerbs = []string{
		"grava", "valida", "recusa", "normaliza", "serializa", "remonta",
		"pontua", "injeta", "descarta", "reaproveita",
	}
	benchObjects = []string{
		"o envelope do protocolo", "a máscara de quatro bytes", "o frame de controle",
		"o teto de oito mebibytes", "a lista de origens permitidas", "o índice de tokens",
		"a chave do provedor", "o prompt do especialista", "a decisão de rota",
		"o arquivo de configuração",
	}
	benchClauses = []string{
		"porque escrever por cima do original deixa o arquivo truncado se o processo morrer no meio",
		"porque o cliente escolhe o tamanho no cabeçalho e sem teto uma alocação derruba o processo",
		"porque reclassificar a cada linha custa latência antes de toda resposta",
		"porque o navegador não aplica CORS a WebSocket e qualquer aba aberta alcançaria o loopback",
		"porque memória guardada dentro do provedor morre junto com a troca de modelo",
		"porque dependência de terceiro no cérebro do produto passaria por análise de segurança",
		"porque a ordem do mapa em Go é aleatória por definição e a lista da tela dançaria sozinha",
		"porque item corrompido não pode custar o acesso a toda a memória acumulada",
	}
	benchTags = []string{
		"gateway", "websocket", "protocolo", "memoria", "roteamento", "seguranca",
		"desempenho", "arquitetura", "code review", "decisao tecnica", "postgres", "tauri",
	}
	benchKinds = []Kind{KindFact, KindPreference, KindProject, KindDecision, KindReference}
)

// benchItems monta a memória de teste. Determinística: mesma semente, mesmos
// 500 itens em toda execução, para que duas medições comparem código e não
// dados diferentes.
func benchItems(count int) []Item {
	source := rand.New(rand.NewSource(20260814))
	// Base no relógio, e não numa data fixa: recencyWeight classifica o item em
	// três faixas contadas a partir de AGORA (7 dias, 30 dias, mais). Com uma
	// data fixa no passado, toda a memória de teste cairia na terceira faixa e a
	// medição nunca passaria pelos outros dois ramos. As idades continuam
	// determinísticas — o que varia com o dia é só o instante de referência.
	base := time.Now().UTC()

	items := make([]Item, 0, count)
	for i := 0; i < count; i++ {
		title := fmt.Sprintf("%s %s %s",
			benchSubjects[source.Intn(len(benchSubjects))],
			benchVerbs[source.Intn(len(benchVerbs))],
			benchObjects[source.Intn(len(benchObjects))])

		// Três a seis frases: um item de memória real tem um parágrafo, não uma
		// linha — e é o conteúdo que a busca re-tokeniza a cada consulta.
		content := ""
		for sentence := 0; sentence < 3+source.Intn(4); sentence++ {
			content += fmt.Sprintf("%s %s %s, %s. ",
				benchSubjects[source.Intn(len(benchSubjects))],
				benchVerbs[source.Intn(len(benchVerbs))],
				benchObjects[source.Intn(len(benchObjects))],
				benchClauses[source.Intn(len(benchClauses))])
		}

		tags := make([]string, 0, 3)
		for tag := 0; tag < 1+source.Intn(3); tag++ {
			tags = append(tags, benchTags[source.Intn(len(benchTags))])
		}

		// Idades espalhadas pelas três faixas de recencyWeight (7 dias, 30 dias,
		// mais), senão o peso de recência seria constante e a medição perderia
		// um ramo inteiro.
		age := time.Duration(source.Intn(120)) * 24 * time.Hour
		stamp := base.Add(-age)

		items = append(items, Item{
			ID:         fmt.Sprintf("mem-bench-%04d", i),
			Kind:       benchKinds[source.Intn(len(benchKinds))],
			Title:      title,
			Content:    content,
			Tags:       tags,
			Importance: 1 + source.Intn(5),
			Uses:       source.Intn(40),
			CreatedAt:  stamp,
			UpdatedAt:  stamp,
			Source:     SourceConversation,
		})
	}
	return items
}

// benchStore grava o arquivo de uma vez e abre — em vez de chamar Add 500
// vezes, que gravaria o arquivo inteiro 500 vezes e faria o preparo demorar
// mais que a medição.
func benchStore(tb testing.TB, count int) *Store {
	tb.Helper()

	path := filepath.Join(tb.TempDir(), "memoria.json")
	raw, err := json.Marshal(fileContent{Version: fileVersion, Items: benchItems(count)})
	if err != nil {
		tb.Fatalf("serializar a memória de teste: %v", err)
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		tb.Fatalf("gravar a memória de teste: %v", err)
	}

	store, err := Open(path)
	if err != nil {
		tb.Fatalf("abrir a memória de teste: %v", err)
	}
	return store
}

func BenchmarkSearch(b *testing.B) {
	store := benchStore(b, benchItemCount)

	// Guarda do cenário: uma consulta que não casa com nada mediria o caminho
	// vazio e diria que tudo está rápido.
	if hits := store.Search(benchQuery, 5); len(hits) == 0 {
		b.Fatalf("o cenário exige que a consulta case com alguma coisa, mas ela não casou com nada")
	}

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		store.Search(benchQuery, 5)
	}
}

// BenchmarkSearchNoLimit mede o caminho em que TODOS os itens que casaram são
// devolvidos — é o que a tela de memória usa ao listar resultados, e é onde o
// custo de clonar item entra na conta junto com o de pontuar.
func BenchmarkSearchNoLimit(b *testing.B) {
	store := benchStore(b, benchItemCount)

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		store.Search(benchQuery, 0)
	}
}

// BenchmarkAdd mede a gravação de um item numa memória já povoada. O número sai
// alto de propósito: Add reserializa e refaz o fsync do arquivo INTEIRO, então
// o custo cresce com o tamanho da memória. Medir isso com três itens esconderia
// justamente o que dói.
func BenchmarkAdd(b *testing.B) {
	store := benchStore(b, benchItemCount)

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := store.Add(Item{
			ID:         fmt.Sprintf("mem-novo-%06d", i),
			Kind:       KindDecision,
			Title:      "o roteador léxico pontua a decisão de rota",
			Content:    "o supervisor injeta a memória no prompt do especialista, porque memória guardada dentro do provedor morre junto com a troca de modelo.",
			Tags:       []string{"roteamento", "memoria"},
			Importance: 3,
		}); err != nil {
			b.Fatalf("Add na iteração %d: %v", i, err)
		}
	}
}

// BenchmarkTokenize isola a tokenização, que é o trabalho que Search repete por
// item a cada consulta. Serve para separar "a busca está lenta" de "o texto
// está caro de quebrar".
func BenchmarkTokenize(b *testing.B) {
	text := benchItems(1)[0].Content

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		tokenize(text)
	}
}
