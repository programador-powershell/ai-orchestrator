// Package memory é a memória persistente do AI-BOT — o que o produto sabe sobre
// a pessoa e sobre o projeto DEPOIS que a conversa fecha.
//
// Ela é independente de fornecedor de propósito. Memória guardada dentro do
// provedor (o "projects" de um, o "memory" de outro) morre junto com a troca de
// modelo, e trocar de modelo é justamente o que o AI-BOT faz o tempo todo. Aqui
// o fato mora no disco do usuário e é injetado no prompt de QUALQUER provedor.
//
// A busca é LÉXICA — casamento de palavra, sem embedding, sem rede. Esse é o
// ponto, não uma limitação temporária: a memória precisa responder quando o
// notebook está no avião, e precisa responder em microssegundos, porque ela roda
// ANTES de cada turno. Busca semântica cobra uma ida à rede (ou um modelo local
// carregado) por mensagem para melhorar um caso que o casamento de palavra já
// resolve na maioria das vezes. Quando houver provedor de embedding, o vetor
// entra no campo Vector e SearchVector passa a existir como complemento — nunca
// como pré-requisito.
//
// SOMENTE biblioteca padrão (política de dependências do gateway). Duas coisas
// que normalmente viriam de fora estão escritas à mão aqui:
//
//   - dobra de acentos: golang.org/x/text por causa de dezoito letras não paga;
//   - índice vetorial: a varredura é linear. Memória de uma pessoa vive na casa
//     dos milhares de itens, onde comparar todos custa menos que manter um HNSW.
//     Se um dia passar disso, o lugar de resolver é aqui, não numa dependência.
//
// O arquivo é um JSON único carregado inteiro na memória. É o formato certo para
// algo que cabe em RAM, que o usuário pode abrir no editor e que precisa ser
// gravado de forma atômica — não um log append-only como internal/store, porque
// memória se EDITA e se APAGA, e log append-only é péssimo nisso.
package memory

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

// Kind classifica o item. O supervisor usa isso para montar o bloco de contexto
// em seções ("o que você prefere", "o que já foi decidido") em vez de despejar
// uma lista solta no prompt.
type Kind string

const (
	// KindFact é o que é verdade sobre o mundo do usuário: nome do time, stack,
	// caminho do repositório.
	KindFact Kind = "fact"
	// KindPreference é gosto e regra de trabalho: "commit em português",
	// "não usar emoji".
	KindPreference Kind = "preference"
	// KindProject amarra o item a um projeto específico.
	KindProject Kind = "project"
	// KindDecision é escolha já tomada, com o motivo. É o que evita a discussão
	// recomeçar do zero daqui a três meses.
	KindDecision Kind = "decision"
	// KindReference é ponteiro: link, caminho, número de chamado.
	KindReference Kind = "reference"
)

// Origens conhecidas do item. Ficam como constante porque a interface filtra por
// elas — e porque "de onde veio isso" é a primeira pergunta de quem encontra uma
// memória errada.
const (
	SourceConversation = "conversa"
	SourceManual       = "manual"
	SourceImportClaude = "import:claude"
	SourceImportOpenAI = "import:openai"
)

// ErrNotFound diz que o id não existe na memória.
var ErrNotFound = errors.New("memória não encontrada")

// fileVersion versiona o formato em disco. Gravado desde o primeiro dia porque
// migrar arquivo sem número de versão exige adivinhar o formato pelo conteúdo.
const fileVersion = 1

// Pesos da busca léxica. Título vale três vezes o conteúdo porque quem escreve a
// memória resume o assunto no título; tag vale dois porque é rótulo escolhido a
// dedo, mas casa menos que o título por ser uma palavra só.
const (
	weightTitle   = 3.0
	weightContent = 1.0
	weightTag     = 2.0
)

// minTokenRunes descarta token curto. "de", "do", "os" aparecem em tudo: sem o
// corte, qualquer frase casaria com qualquer item e o ranking viraria ruído.
const minTokenRunes = 3

// Item é uma unidade de memória.
type Item struct {
	ID      string   `json:"id"`
	Kind    Kind     `json:"kind"`
	Title   string   `json:"title"`
	Content string   `json:"content"`
	Tags    []string `json:"tags,omitempty"`
	// Importance vai de 1 a 5 e PONDERA o ranking, não manda nele. Se importância
	// decidisse sozinha, tudo que a pessoa marcou com 5 uma vez entraria em todo
	// prompt para sempre, inclusive quando não tem nada a ver com a pergunta.
	Importance int `json:"importance"`
	// Uses conta quantas vezes o item foi injetado num prompt.
	Uses       int        `json:"uses"`
	CreatedAt  time.Time  `json:"createdAt"`
	UpdatedAt  time.Time  `json:"updatedAt"`
	LastUsedAt *time.Time `json:"lastUsedAt,omitempty"`
	Source     string     `json:"source,omitempty"`
	// Specialist restringe o item a um especialista. Vazio vale para todos — é o
	// padrão, porque memória que só um especialista enxerga some justo quando a
	// conversa troca de especialista no meio.
	Specialist string `json:"specialist,omitempty"`
	// Vector é opcional e fica nil quando não houve provedor de embedding. Nunca
	// é pré-requisito para nada: a busca léxica funciona sem ele.
	Vector []float32 `json:"vector,omitempty"`
}

// Hit é um item encontrado, com o quanto casou e o porquê.
type Hit struct {
	Item  Item
	Score float64
	// Why é a frase curta que a interface mostra ao lado do item ("título e 2
	// tags"). Ranking sem explicação é caixa-preta, e caixa-preta que injeta
	// texto no prompt é o tipo de coisa que ninguém consegue depurar depois.
	Why string
}

// fileContent é o envelope gravado no disco.
type fileContent struct {
	Version int    `json:"version"`
	Items   []Item `json:"items"`
}

// Store é o dono do arquivo de memória.
type Store struct {
	mu    sync.RWMutex
	path  string
	items map[string]Item
	// counter desempata ids gerados no mesmo segundo.
	counter uint64
}

// Open carrega o arquivo de memória, criando um vazio se ainda não existir.
//
// Item corrompido é PULADO em vez de derrubar a abertura: um byte torto numa
// linha não pode custar o acesso a toda a memória acumulada.
func Open(path string) (*Store, error) {
	if strings.TrimSpace(path) == "" {
		return nil, errors.New("caminho da memória vazio")
	}

	store := &Store{path: path, items: make(map[string]Item)}

	raw, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			return nil, fmt.Errorf("ler memória: %w", err)
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return nil, fmt.Errorf("criar diretório da memória: %w", err)
		}
		// Grava o arquivo vazio já na abertura para que erro de permissão apareça
		// aqui, e não no meio de uma conversa quando a pessoa salvar o primeiro
		// fato. Sem concorrência ainda: ninguém mais tem o ponteiro.
		if err := store.persist(); err != nil {
			return nil, err
		}
		return store, nil
	}

	if strings.TrimSpace(string(raw)) == "" {
		// Arquivo vazio é o que sobra de uma queda entre criar e gravar. Vale como
		// memória vazia; tratar como erro travaria o app por causa de zero byte.
		return store, nil
	}

	var content fileContent
	if err := json.Unmarshal(raw, &content); err != nil {
		return nil, fmt.Errorf("ler memória %s: %w", filepath.Base(path), err)
	}

	now := time.Now().UTC()
	for _, item := range content.Items {
		item = sanitize(item, now)
		if item.ID == "" || item.Title == "" || item.Content == "" {
			continue
		}
		store.items[item.ID] = item
	}
	return store, nil
}

// Path devolve o arquivo em uso.
func (s *Store) Path() string { return s.path }

// Add grava um item novo e devolve como ele ficou.
func (s *Store) Add(item Item) (Item, error) {
	if strings.TrimSpace(item.Title) == "" {
		return Item{}, errors.New("memória sem título")
	}
	if strings.TrimSpace(item.Content) == "" {
		return Item{}, errors.New("memória sem conteúdo")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now().UTC()
	// Cópia dos slices na ENTRADA também: se o chamador reaproveitar a fatia de
	// tags depois do Add, ele estaria editando o que já está guardado.
	stored := cloneItem(item)
	// O id é aparado ANTES da checagem de duplicata: aparar depois faria " abc "
	// passar pela checagem e depois sobrescrever "abc" na hora de guardar.
	stored.ID = strings.TrimSpace(stored.ID)
	if stored.ID == "" {
		stored.ID = s.nextID(now)
	} else if _, exists := s.items[stored.ID]; exists {
		// Sobrescrever calado transformaria um id repetido por engano em perda
		// silenciosa de memória. Quem quer trocar o conteúdo chama Update.
		return Item{}, fmt.Errorf("memória já existe: %s", stored.ID)
	}

	stored = sanitize(stored, now)
	stored.UpdatedAt = now
	s.items[stored.ID] = stored

	if err := s.persist(); err != nil {
		// O que está em RAM não pode ficar à frente do disco: na próxima abertura
		// o item sumiria e o usuário juraria ter salvado.
		delete(s.items, stored.ID)
		return Item{}, err
	}
	return cloneItem(stored), nil
}

// Update troca o conteúdo editável de um item.
//
// Uses e LastUsedAt NÃO são aceitos do chamador: quem corrige um typo no título
// não pode zerar o histórico de uso que alimenta o peso de recência.
func (s *Store) Update(item Item) error {
	id := strings.TrimSpace(item.ID)
	if id == "" {
		return errors.New("memória sem id")
	}
	if strings.TrimSpace(item.Title) == "" {
		return errors.New("memória sem título")
	}
	if strings.TrimSpace(item.Content) == "" {
		return errors.New("memória sem conteúdo")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	previous, ok := s.items[id]
	if !ok {
		return fmt.Errorf("%w: %s", ErrNotFound, id)
	}

	now := time.Now().UTC()
	updated := sanitize(cloneItem(item), now)
	if item.Kind == "" {
		// Kind vazio na entrada quer dizer "não mexi nisso", não "vira fato". A
		// checagem é no item ORIGINAL porque sanitize já preencheu o padrão — olhar
		// para o item saneado aqui seria condição morta, e a decisão do usuário de
		// classificar como decisão ou preferência se perderia a cada edição.
		updated.Kind = previous.Kind
	}
	updated.CreatedAt = previous.CreatedAt
	updated.Uses = previous.Uses
	updated.LastUsedAt = previous.LastUsedAt
	updated.UpdatedAt = now

	s.items[id] = updated
	if err := s.persist(); err != nil {
		s.items[id] = previous
		return err
	}
	return nil
}

// Delete apaga o item.
func (s *Store) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	previous, ok := s.items[id]
	if !ok {
		return fmt.Errorf("%w: %s", ErrNotFound, id)
	}
	delete(s.items, id)
	if err := s.persist(); err != nil {
		s.items[id] = previous
		return err
	}
	return nil
}

// List devolve todos os itens, mais recentes primeiro, em cópia.
func (s *Store) List() []Item {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.sortedItems()
}

// Touch registra que os itens foram usados num prompt.
//
// Id desconhecido é ignorado em silêncio: o supervisor injeta o que a busca
// devolveu e a pessoa pode ter apagado a memória entre a busca e o fim do turno
// — derrubar o turno por causa disso seria trocar um nada por um erro visível.
func (s *Store) Touch(ids []string) error {
	if len(ids) == 0 {
		return nil
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now().UTC()
	// backup serve a dois propósitos: desfazer se a gravação falhar e evitar que
	// o mesmo id repetido na lista conte dois usos.
	backup := make(map[string]Item, len(ids))
	for _, id := range ids {
		if _, seen := backup[id]; seen {
			continue
		}
		item, ok := s.items[id]
		if !ok {
			continue
		}
		backup[id] = item
		item.Uses++
		// Um time.Time por item: apontar todos para a mesma variável faria os
		// itens compartilharem o ponteiro, e um dia alguém escreveria por ele.
		stamp := now
		item.LastUsedAt = &stamp
		s.items[id] = item
	}
	if len(backup) == 0 {
		return nil
	}

	if err := s.persist(); err != nil {
		for id, item := range backup {
			s.items[id] = item
		}
		return err
	}
	return nil
}

/* -------------------------------- busca -------------------------------- */

// Search encontra os itens mais relevantes para a consulta, sem rede.
//
// limit <= 0 devolve tudo o que casou.
func (s *Store) Search(query string, limit int) []Hit {
	terms := tokenize(query)
	if len(terms) == 0 {
		return nil
	}

	s.mu.RLock()
	defer s.mu.RUnlock()

	now := time.Now().UTC()
	hits := make([]Hit, 0, len(s.items))
	for _, item := range s.items {
		score, why := scoreItem(item, terms, now)
		if score <= 0 {
			continue
		}
		hits = append(hits, Hit{Item: cloneItem(item), Score: score, Why: why})
	}
	sortHits(hits)
	return limitHits(hits, limit)
}

// SearchVector compara por cosseno com quem tem vetor.
//
// Vetor de tamanho diferente é PULADO, não pontuado como zero: dimensão
// diferente significa outro modelo de embedding, e comparar os dois números é
// comparar coisas que não são a mesma grandeza. Ficaria no meio do ranking
// fingindo relevância média.
func (s *Store) SearchVector(vector []float32, limit int) []Hit {
	if len(vector) == 0 {
		return nil
	}

	s.mu.RLock()
	defer s.mu.RUnlock()

	hits := make([]Hit, 0, len(s.items))
	for _, item := range s.items {
		if len(item.Vector) != len(vector) {
			continue
		}
		// Cosseno vive em [-1,1] e Score é comparado com o da busca léxica na
		// interface; normalizar para [0,1] evita barra de relevância negativa.
		score := (Cosine(vector, item.Vector) + 1) / 2
		hits = append(hits, Hit{Item: cloneItem(item), Score: score, Why: "proximidade semântica"})
	}
	sortHits(hits)
	return limitHits(hits, limit)
}

// Cosine devolve o cosseno entre dois vetores, ou 0 quando não dá para comparar
// (tamanhos diferentes, vetor vazio ou norma zero). Nunca entra em pânico: isto
// roda sobre dado vindo de arquivo, e arquivo mente.
func Cosine(a, b []float32) float64 {
	if len(a) == 0 || len(b) == 0 || len(a) != len(b) {
		return 0
	}
	var dot, normA, normB float64
	for i := range a {
		x, y := float64(a[i]), float64(b[i])
		dot += x * y
		normA += x * x
		normB += y * y
	}
	if normA == 0 || normB == 0 {
		return 0
	}
	return dot / (math.Sqrt(normA) * math.Sqrt(normB))
}

// scoreItem pontua um item contra os termos já normalizados da consulta.
func scoreItem(item Item, terms []string, now time.Time) (float64, string) {
	titleTokens := tokenSet(item.Title)
	contentTokens := tokenSet(item.Content)

	titleHits, contentHits := 0, 0
	terminology := make(map[string]bool, len(terms))
	for _, term := range terms {
		terminology[term] = true
		// Cada termo conta UMA vez por campo. Contar ocorrência faria o item mais
		// comprido ganhar sempre — relevância viraria contagem de páginas.
		if titleTokens[term] {
			titleHits++
		}
		if contentTokens[term] {
			contentHits++
		}
	}

	// Tag casa por INTEIRO: todos os termos dela têm de estar na consulta. Casar
	// tag por pedaço faria "review" acender a tag "code review" e o rótulo
	// deixaria de ser rótulo; exigir igualdade de string, por outro lado, mataria
	// qualquer tag com mais de uma palavra — nenhum termo tem espaço, porque a
	// tokenização quebra justamente ali.
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

	// Importância de 1 a 5 vira multiplicador de 0.7 a 1.1: mexe no ranking sem
	// nunca superar a diferença entre casar e não casar.
	score := raw * (0.6 + 0.1*float64(clampImportance(item.Importance))) * recencyWeight(item, now)
	return score, explain(titleHits, contentHits, tagHits)
}

// recencyWeight rebaixa devagar o que anda parado.
//
// Item nunca usado cai para UpdatedAt em vez de valer o mínimo: penalizar o que
// acabou de nascer criaria fome — nunca aparece, logo nunca é usado, logo nunca
// deixa de ser antigo.
func recencyWeight(item Item, now time.Time) float64 {
	reference := item.UpdatedAt
	if item.LastUsedAt != nil && item.LastUsedAt.After(reference) {
		reference = *item.LastUsedAt
	}
	age := now.Sub(reference)
	switch {
	case age <= 7*24*time.Hour:
		return 1.0
	case age <= 30*24*time.Hour:
		return 0.85
	default:
		return 0.7
	}
}

// explain monta a frase do Why ("título e 2 tags").
func explain(title, content, tags int) string {
	parts := make([]string, 0, 3)
	switch {
	case title == 1:
		parts = append(parts, "título")
	case title > 1:
		parts = append(parts, fmt.Sprintf("título (%d termos)", title))
	}
	switch {
	case content == 1:
		parts = append(parts, "conteúdo")
	case content > 1:
		parts = append(parts, fmt.Sprintf("conteúdo (%d termos)", content))
	}
	switch {
	case tags == 1:
		parts = append(parts, "1 tag")
	case tags > 1:
		parts = append(parts, fmt.Sprintf("%d tags", tags))
	}

	switch len(parts) {
	case 0:
		return ""
	case 1:
		return parts[0]
	default:
		return strings.Join(parts[:len(parts)-1], ", ") + " e " + parts[len(parts)-1]
	}
}

/* ---------------------------- texto e tokens ---------------------------- */

// fold mapeia as letras acentuadas do português (mais as do espanhol que chegam
// em texto colado) para a forma sem acento.
//
// Este mapa é uma CÓPIA do que existe em internal/supervisor, e é de propósito:
// o supervisor consulta a memória, então memory importando supervisor fecharia
// um ciclo de import — que em Go nem compila. Duplicar dezoito linhas de tabela
// custa menos que inventar um pacote "texto" só para hospedá-las. Se o mapa
// mudar num lado, muda no outro; ele não muda desde que o português tem acento.
var fold = map[rune]rune{
	'á': 'a', 'à': 'a', 'â': 'a', 'ã': 'a', 'ä': 'a', 'å': 'a',
	'é': 'e', 'è': 'e', 'ê': 'e', 'ë': 'e',
	'í': 'i', 'ì': 'i', 'î': 'i', 'ï': 'i',
	'ó': 'o', 'ò': 'o', 'ô': 'o', 'õ': 'o', 'ö': 'o',
	'ú': 'u', 'ù': 'u', 'û': 'u', 'ü': 'u',
	'ç': 'c', 'ñ': 'n', 'ý': 'y',
}

// Normalize deixa o texto comparável: minúsculas, sem acento, espaços
// colapsados. Consulta e conteúdo passam pelo MESMO tratamento — se só um lado
// fosse dobrado, "memória" nunca casaria com "memoria".
func Normalize(text string) string {
	var builder strings.Builder
	builder.Grow(len(text))
	space := false
	for _, symbol := range strings.ToLower(text) {
		if folded, ok := fold[symbol]; ok {
			symbol = folded
		}
		if unicode.IsSpace(symbol) {
			space = true
			continue
		}
		if space && builder.Len() > 0 {
			builder.WriteRune(' ')
		}
		space = false
		builder.WriteRune(symbol)
	}
	return builder.String()
}

// tokenize quebra o texto por não-letra/não-dígito e devolve os termos únicos,
// na ordem em que aparecem. Único porque repetir "erro" três vezes na pergunta
// não deveria triplicar o peso de quem tem "erro" no título.
func tokenize(text string) []string {
	normalized := Normalize(text)
	if normalized == "" {
		return nil
	}

	out := make([]string, 0, 8)
	seen := make(map[string]bool, 8)
	var current strings.Builder

	flush := func() {
		if current.Len() == 0 {
			return
		}
		token := current.String()
		current.Reset()
		if utf8.RuneCountInString(token) < minTokenRunes {
			return
		}
		if seen[token] {
			return
		}
		seen[token] = true
		out = append(out, token)
	}

	for _, symbol := range normalized {
		if unicode.IsLetter(symbol) || unicode.IsDigit(symbol) {
			current.WriteRune(symbol)
			continue
		}
		flush()
	}
	flush()
	return out
}

func tokenSet(text string) map[string]bool {
	tokens := tokenize(text)
	set := make(map[string]bool, len(tokens))
	for _, token := range tokens {
		set[token] = true
	}
	return set
}

/* -------------------------------- interno ------------------------------- */

// nextID gera id legível a olho nu — hora mais contador. Legível importa porque
// esse id aparece em log e em mensagem de erro, e "mem-20260814T113000-0007"
// diz quando o item nasceu; um UUID não diz nada.
//
// O laço protege contra colisão depois de reabrir o arquivo, quando o contador
// volta a zero e o segundo pode ser o mesmo. Termina sempre: o contador só
// cresce e a memória é finita.
func (s *Store) nextID(now time.Time) string {
	for {
		s.counter++
		id := fmt.Sprintf("mem-%s-%04d", now.Format("20060102T150405"), s.counter)
		if _, exists := s.items[id]; !exists {
			return id
		}
	}
}

// sanitize arruma o item antes de guardar. Vale tanto para o que veio do disco
// quanto para o que veio do chamador — os dois mentem do mesmo jeito.
func sanitize(item Item, now time.Time) Item {
	item.ID = strings.TrimSpace(item.ID)
	item.Title = strings.TrimSpace(item.Title)
	item.Content = strings.TrimSpace(item.Content)
	if item.Kind == "" {
		item.Kind = KindFact
	}
	item.Importance = clampImportance(item.Importance)
	if item.Uses < 0 {
		item.Uses = 0
	}
	if item.CreatedAt.IsZero() {
		item.CreatedAt = now
	}
	if item.UpdatedAt.IsZero() {
		item.UpdatedAt = item.CreatedAt
	}
	return item
}

// clampImportance prende a importância em 1..5. Zero (o valor de quem não
// preencheu) vira 1, e não 0, porque 0 zeraria o multiplicador do ranking.
func clampImportance(importance int) int {
	if importance < 1 {
		return 1
	}
	if importance > 5 {
		return 5
	}
	return importance
}

// cloneItem devolve um item que não compartilha memória com o original.
//
// Devolver a fatia interna deixaria quem chamou alterar o que está guardado sem
// passar por Update e sem gravar no disco — o defeito aparece meses depois, como
// uma tag que mudou sozinha.
func cloneItem(item Item) Item {
	out := item
	if item.Tags != nil {
		out.Tags = make([]string, len(item.Tags))
		copy(out.Tags, item.Tags)
	}
	if item.Vector != nil {
		out.Vector = make([]float32, len(item.Vector))
		copy(out.Vector, item.Vector)
	}
	if item.LastUsedAt != nil {
		stamp := *item.LastUsedAt
		out.LastUsedAt = &stamp
	}
	return out
}

// sortedItems devolve cópias ordenadas. Assume o mutex já segurado.
func (s *Store) sortedItems() []Item {
	out := make([]Item, 0, len(s.items))
	for _, item := range s.items {
		out = append(out, cloneItem(item))
	}
	// A ordem do map é aleatória em Go por definição. Sem ordenação total (com
	// desempate por id) o arquivo gravado mudaria de ordem a cada escrita e a
	// lista da tela dançaria sem ninguém ter mexido em nada.
	sort.SliceStable(out, func(i, j int) bool {
		if !out[i].UpdatedAt.Equal(out[j].UpdatedAt) {
			return out[i].UpdatedAt.After(out[j].UpdatedAt)
		}
		return out[i].ID < out[j].ID
	})
	return out
}

// sortHits ordena por score desc, com desempate determinístico.
func sortHits(hits []Hit) {
	sort.SliceStable(hits, func(i, j int) bool {
		if hits[i].Score != hits[j].Score {
			return hits[i].Score > hits[j].Score
		}
		if !hits[i].Item.UpdatedAt.Equal(hits[j].Item.UpdatedAt) {
			return hits[i].Item.UpdatedAt.After(hits[j].Item.UpdatedAt)
		}
		return hits[i].Item.ID < hits[j].Item.ID
	})
}

func limitHits(hits []Hit, limit int) []Hit {
	if limit > 0 && len(hits) > limit {
		return hits[:limit]
	}
	return hits
}

// persist grava o arquivo inteiro por temporário + rename. Assume o mutex de
// escrita já segurado.
//
// Escrever por cima do original deixa a memória truncada se o processo morrer no
// meio — e aqui "truncada" significa a pessoa perder tudo o que o AI-BOT sabia
// sobre ela. O rename é a única operação que o sistema de arquivos promete
// atômica, então é ele quem publica a versão nova.
func (s *Store) persist() error {
	payload := fileContent{Version: fileVersion, Items: s.sortedItems()}
	// Indentado porque este arquivo é feito para a pessoa abrir no editor,
	// conferir o que o AI-BOT guardou e apagar o que não quer.
	raw, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return fmt.Errorf("serializar memória: %w", err)
	}
	raw = append(raw, '\n')

	temporary := s.path + ".tmp"
	// 0600: memória guarda o que a pessoa contou sobre o trabalho dela. Outro
	// usuário da máquina não tem nada que ler isso.
	file, err := os.OpenFile(temporary, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("gravar memória: %w", err)
	}
	if _, err := file.Write(raw); err != nil {
		_ = file.Close()
		_ = os.Remove(temporary)
		return fmt.Errorf("gravar memória: %w", err)
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		_ = os.Remove(temporary)
		return fmt.Errorf("sincronizar memória: %w", err)
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(temporary)
		return fmt.Errorf("fechar memória: %w", err)
	}
	// No Windows os.Rename usa MoveFileEx com REPLACE_EXISTING, então substituir
	// arquivo existente funciona igual ao Unix.
	if err := os.Rename(temporary, s.path); err != nil {
		_ = os.Remove(temporary)
		return fmt.Errorf("publicar memória: %w", err)
	}
	return nil
}
