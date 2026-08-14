// Testes da memória.
//
// O foco aqui é o índice léxico. Ele é uma OTIMIZAÇÃO — guarda os tokens de
// título, conteúdo e tags para não refazer a tokenização a cada consulta — e
// otimização de busca falha do jeito mais silencioso que existe: o item
// continua na lista, continua no arquivo, e simplesmente deixa de aparecer no
// que foi procurado. Ninguém abre chamado para memória que "não lembrou".
//
// Por isso dois tipos de teste:
//
//   - contra ORÁCULO: uma reimplementação ingênua, que tokeniza tudo na hora,
//     confere resultado a resultado com a versão indexada;
//   - de COERÊNCIA: depois de cada caminho que mexe no estado (Add, Update,
//     Delete, Touch e as reversões de falha de gravação), o índice tem de ser
//     idêntico ao que seria reconstruído do zero.
package memory

import (
	"fmt"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

/* ------------------------------- oráculo -------------------------------- */

// searchReference é a busca ANTES do índice: tokeniza título, conteúdo e tags
// de cada item a cada chamada, monta o Hit de todos os que casaram, ordena e só
// então corta. É lenta de propósito — ela existe para dizer qual é a resposta
// certa, não para ser rápida.
func searchReference(store *Store, query string, limit int, now time.Time) []Hit {
	terms := tokenize(query)
	if len(terms) == 0 {
		return nil
	}

	hits := make([]Hit, 0, len(store.items))
	for _, item := range store.items {
		score, why := scoreItemReference(item, terms, now)
		if score <= 0 {
			continue
		}
		hits = append(hits, Hit{Item: cloneItem(item), Score: score, Why: why})
	}
	sortHits(hits)
	return limitHits(hits, limit)
}

func scoreItemReference(item Item, terms []string, now time.Time) (float64, string) {
	titleTokens := tokenSet(item.Title)
	contentTokens := tokenSet(item.Content)

	titleHits, contentHits := 0, 0
	terminology := make(map[string]bool, len(terms))
	for _, term := range terms {
		terminology[term] = true
		if titleTokens[term] {
			titleHits++
		}
		if contentTokens[term] {
			contentHits++
		}
	}

	tagHits := 0
	counted := make(map[string]bool, len(item.Tags))
	for _, tag := range item.Tags {
		tokens := tokenize(tag)
		if len(tokens) == 0 {
			continue
		}
		key := strings.Join(tokens, " ")
		if counted[key] {
			continue
		}
		counted[key] = true
		complete := true
		for _, token := range tokens {
			if !terminology[token] {
				complete = false
				break
			}
		}
		if complete {
			tagHits++
		}
	}

	raw := weightTitle*float64(titleHits) + weightContent*float64(contentHits) + weightTag*float64(tagHits)
	if raw == 0 {
		return 0, ""
	}
	score := raw * (0.6 + 0.1*float64(clampImportance(item.Importance))) * recencyWeight(item, now)
	return score, explain(titleHits, contentHits, tagHits)
}

func describeHits(hits []Hit) string {
	parts := make([]string, 0, len(hits))
	for _, hit := range hits {
		parts = append(parts, fmt.Sprintf("%s=%.6f(%s)", hit.Item.ID, hit.Score, hit.Why))
	}
	if len(parts) == 0 {
		return "(nenhum)"
	}
	return strings.Join(parts, " ")
}

// TestSearchMatchesReference é o teste que autoriza o índice a existir: mesma
// memória, mesmas consultas, resposta idêntica — id, ordem, score e a frase do
// Why. Um índice que acerta o conjunto e erra a ORDEM entregaria ao prompt
// cinco memórias diferentes das que o usuário viu na tela.
func TestSearchMatchesReference(t *testing.T) {
	store := benchStore(t, 300)

	queries := []string{
		benchQuery,
		"máscara do frame",
		"postgres",
		"code review",
		"CODE REVIEW",          // caixa não pode mudar o resultado
		"segurança do gateway", // acento dobrado dos dois lados
		"o de os as",           // só termos abaixo do corte de 3 runas
		"palavraquenaoexisteemlugarnenhum",
		"decisao tecnica memoria",
	}
	limits := []int{0, 1, 5, 50, 1000, -1}

	for _, query := range queries {
		for _, limit := range limits {
			// O MESMO instante nos dois lados: recencyWeight classifica por
			// idade, e dois relógios diferentes poderiam cair em faixas
			// diferentes num item que estivesse na fronteira.
			now := time.Now().UTC()

			want := searchReference(store, query, limit, now)
			got := store.searchAt(query, limit, now)

			if len(got) != len(want) {
				t.Fatalf("Search(%q, %d): esperava %d resultados, obteve %d\n  esperava: %s\n  obteve:   %s",
					query, limit, len(want), len(got), describeHits(want), describeHits(got))
			}
			for i := range want {
				if got[i].Item.ID != want[i].Item.ID {
					t.Errorf("Search(%q, %d): na posição %d esperava o item %q, obteve %q\n  esperava: %s\n  obteve:   %s",
						query, limit, i, want[i].Item.ID, got[i].Item.ID, describeHits(want), describeHits(got))
					break
				}
				if got[i].Score != want[i].Score {
					t.Errorf("Search(%q, %d): o item %q pontuou %.10f, esperava %.10f",
						query, limit, want[i].Item.ID, got[i].Score, want[i].Score)
				}
				if got[i].Why != want[i].Why {
					t.Errorf("Search(%q, %d): o item %q explicou %q, esperava %q",
						query, limit, want[i].Item.ID, got[i].Why, want[i].Why)
				}
			}
		}
	}
}

/* ------------------------------ coerência ------------------------------- */

// requireCoherentIndex confere a invariante do índice: uma entrada por item,
// nenhuma sobrando, e cada uma igual ao que seria reconstruído agora a partir
// do item guardado.
func requireCoherentIndex(t *testing.T, store *Store, moment string) {
	t.Helper()

	if len(store.index) != len(store.items) {
		t.Fatalf("%s: o índice tem %d entradas para %d itens", moment, len(store.index), len(store.items))
	}
	for id, item := range store.items {
		indexed, ok := store.index[id]
		if !ok {
			t.Fatalf("%s: o item %q está guardado e não tem entrada no índice — ele sumiria da busca", moment, id)
		}
		expected := buildSearchIndex(item)
		if !reflect.DeepEqual(indexed.title, expected.title) {
			t.Errorf("%s: o índice de título do item %q está velho: %v, esperado %v",
				moment, id, indexed.title, expected.title)
		}
		if !reflect.DeepEqual(indexed.content, expected.content) {
			t.Errorf("%s: o índice de conteúdo do item %q está velho", moment, id)
		}
		if !reflect.DeepEqual(indexed.tags, expected.tags) {
			t.Errorf("%s: o índice de tags do item %q está velho: %v, esperado %v",
				moment, id, indexed.tags, expected.tags)
		}
	}
}

func newStore(t *testing.T) *Store {
	t.Helper()
	store, err := Open(filepath.Join(t.TempDir(), "memoria.json"))
	if err != nil {
		t.Fatalf("abrir a memória: %v", err)
	}
	return store
}

func TestIndexFollowsEveryMutation(t *testing.T) {
	store := newStore(t)

	added, err := store.Add(Item{
		Title:   "o gateway valida a máscara do frame",
		Content: "o transporte recusa frame de cliente sem máscara, porque a máscara existe contra proxy envenenado.",
		Tags:    []string{"websocket", "seguranca"},
	})
	if err != nil {
		t.Fatalf("Add: %v", err)
	}
	requireCoherentIndex(t, store, "depois do Add")

	if hits := store.Search("máscara", 0); len(hits) != 1 {
		t.Fatalf("depois do Add: esperava 1 resultado para \"máscara\", obteve %d", len(hits))
	}

	// Update troca o texto: o índice velho faria a busca continuar achando o
	// item pelo termo APAGADO e nunca pelo termo novo.
	updated := added
	updated.Title = "o roteador pontua a decisão"
	updated.Content = "o léxico decide sozinho quando o radical é específico."
	updated.Tags = []string{"roteamento"}
	if err := store.Update(updated); err != nil {
		t.Fatalf("Update: %v", err)
	}
	requireCoherentIndex(t, store, "depois do Update")

	if hits := store.Search("máscara", 0); len(hits) != 0 {
		t.Errorf("depois do Update: o termo apagado \"máscara\" ainda encontra o item (%d resultados) — o índice ficou para trás",
			len(hits))
	}
	if hits := store.Search("roteador", 0); len(hits) != 1 {
		t.Errorf("depois do Update: o termo novo \"roteador\" não encontra o item (%d resultados)", len(hits))
	}

	// Touch mexe em Uses e LastUsedAt e NÃO deve invalidar o índice — é o
	// caminho de todo turno, e reconstruir ali seria refazer o trabalho que o
	// índice existe para evitar.
	if err := store.Touch([]string{added.ID}); err != nil {
		t.Fatalf("Touch: %v", err)
	}
	requireCoherentIndex(t, store, "depois do Touch")
	if hits := store.Search("roteador", 0); len(hits) != 1 {
		t.Errorf("depois do Touch: esperava o item ainda encontrável, obteve %d resultados", len(hits))
	}

	if err := store.Delete(added.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	requireCoherentIndex(t, store, "depois do Delete")
	if hits := store.Search("roteador", 0); len(hits) != 0 {
		t.Errorf("depois do Delete: o item apagado ainda aparece na busca (%d resultados)", len(hits))
	}
}

// Reabrir o arquivo tem de reconstruir o índice: sem isso a memória inteira
// existiria na lista e não responderia a busca nenhuma até a primeira edição.
func TestIndexIsBuiltOnOpen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "memoria.json")

	first, err := Open(path)
	if err != nil {
		t.Fatalf("abrir a memória: %v", err)
	}
	if _, err := first.Add(Item{
		Title:   "o cofre guarda a chave do provedor",
		Content: "a chave nunca é ecoada inteira na resposta.",
		Tags:    []string{"seguranca"},
	}); err != nil {
		t.Fatalf("Add: %v", err)
	}

	reopened, err := Open(path)
	if err != nil {
		t.Fatalf("reabrir a memória: %v", err)
	}
	requireCoherentIndex(t, reopened, "depois de reabrir")
	if hits := reopened.Search("provedor", 0); len(hits) != 1 {
		t.Fatalf("depois de reabrir: esperava 1 resultado para \"provedor\", obteve %d", len(hits))
	}
}

// Gravação que falha desfaz o que estava em RAM — e o índice tem de voltar
// junto. Se ele ficasse, a busca passaria a devolver um item que não existe
// mais, e o clone que monta o Hit leria um item vazio.
func TestIndexIsRolledBackWhenPersistFails(t *testing.T) {
	store := newStore(t)

	survivor, err := store.Add(Item{
		Title:   "o índice acompanha o item",
		Content: "toda escrita passa por put, porque escrita solta deixa o índice para trás.",
		Tags:    []string{"memoria"},
	})
	if err != nil {
		t.Fatalf("Add: %v", err)
	}

	// Aponta o arquivo para dentro de um diretório inexistente: a partir daqui
	// toda gravação falha, que é o cenário em disco cheio ou permissão perdida.
	store.path = filepath.Join(store.path, "impossivel", "memoria.json")

	if _, err := store.Add(Item{Title: "não deve sobreviver", Content: "conteúdo perdido"}); err == nil {
		t.Fatal("Add: esperava falha de gravação, obteve sucesso")
	}
	requireCoherentIndex(t, store, "depois do Add que falhou")

	doomed := survivor
	doomed.Title = "título que não deve pegar"
	doomed.Content = "conteúdo que não deve pegar"
	if err := store.Update(doomed); err == nil {
		t.Fatal("Update: esperava falha de gravação, obteve sucesso")
	}
	requireCoherentIndex(t, store, "depois do Update que falhou")

	if err := store.Delete(survivor.ID); err == nil {
		t.Fatal("Delete: esperava falha de gravação, obteve sucesso")
	}
	requireCoherentIndex(t, store, "depois do Delete que falhou")

	// E o item continua encontrável pelo texto ORIGINAL, não pelo que a edição
	// fracassada tentou escrever.
	if hits := store.Search("índice", 0); len(hits) != 1 {
		t.Errorf("depois das falhas: esperava o item original encontrável, obteve %d resultados", len(hits))
	}
	if hits := store.Search("pegar", 0); len(hits) != 0 {
		t.Errorf("depois das falhas: o texto da edição fracassada entrou no índice (%d resultados)", len(hits))
	}
}

/* -------------------------- texto e tokenização -------------------------- */

func TestNormalizeFoldsAccentsAndCollapsesSpace(t *testing.T) {
	cases := []struct{ in, want string }{
		{"Memória", "memoria"},
		{"Segurança à Ação", "seguranca a acao"},
		{"  duas   palavras  ", "duas palavras"},
		{"linha\tum\nlinha dois", "linha um linha dois"},
		{"ÁÀÂÃÄÅ ÉÈÊË ÍÌÎÏ ÓÒÔÕÖ ÚÙÛÜ Çç Ññ Ýý", "aaaaaa eeee iiii ooooo uuuu cc nn yy"},
		{"E daí?", "e dai?"},
		{"", ""},
		{"   \t\n  ", ""},
	}
	for _, each := range cases {
		if got := Normalize(each.in); got != each.want {
			t.Errorf("Normalize(%q): esperava %q, obteve %q", each.in, each.want, got)
		}
	}
}

// A tokenização é o que alimenta o índice: token curto descartado, repetido
// contado uma vez, ordem de aparição preservada.
func TestTokenize(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"o gateway valida o frame do gateway", []string{"gateway", "valida", "frame"}},
		{"de do os as", nil},
		{"Máscara, frame; WebSocket!", []string{"mascara", "frame", "websocket"}},
		// Dígito conta como letra para o corte de 3 runas: "go1" entra, "e" não.
		{"php7 e go1", []string{"php7", "go1"}},
		{"", nil},
	}
	for _, each := range cases {
		got := tokenize(each.in)
		if len(got) != len(each.want) {
			t.Errorf("tokenize(%q): esperava %v, obteve %v", each.in, each.want, got)
			continue
		}
		for i := range each.want {
			if got[i] != each.want[i] {
				t.Errorf("tokenize(%q): esperava %v, obteve %v", each.in, each.want, got)
				break
			}
		}
	}
}
