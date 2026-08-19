// Busca por conteúdo nas conversas — o motor do Ctrl+K.
//
// O cabeçalho do pacote avisa que este formato não dá consulta por conteúdo, e
// a ressalva de lá continua valendo: varrer JSONL é aceitável em conversa de
// usuário (dezenas de sessões, MBs) e seria inaceitável em telemetria. É
// exatamente esse o caso de uso aqui, então a busca varre — sem índice novo,
// sem dependência, e com dois freios: só mensagens (KindMessage) entram, e a
// varredura PARA no teto de resultados em vez de medir o acervo inteiro.
//
// As sessões são visitadas da mais recente para a mais antiga (a ordem do
// ListSessions) de propósito: com o teto atingido, o que fica de fora é o que a
// pessoa menos procura.
package store

import (
	"strings"
	"time"
	"unicode/utf8"

	"aibot/gateway/internal/protocol"
)

// searchHitsPerSession limita quantos trechos UMA conversa pode ocupar na
// resposta: sem o teto, uma conversa longa sobre o termo buscado engoliria a
// lista inteira e esconderia as outras.
const searchHitsPerSession = 3

// searchSnippetRadius é quanto contexto (em bytes, ajustado a fronteira de
// rune) vai de cada lado do trecho encontrado.
const searchSnippetRadius = 60

// MaxSearchResults é o teto absoluto de resultados de uma busca.
const MaxSearchResults = 20

// SearchHit é um trecho encontrado, com o suficiente para a lista desenhar a
// linha e para o clique abrir a conversa certa.
type SearchHit struct {
	Session   string    `json:"session"`
	Title     string    `json:"title"`
	Seq       uint64    `json:"seq"`
	Turn      string    `json:"turn,omitempty"`
	Role      string    `json:"role"`
	Snippet   string    `json:"snippet"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// SearchSessions varre as mensagens de todas as sessões procurando `query`
// (sem diferenciar maiúsculas). Query vazia devolve lista vazia — buscar tudo
// não é uma pergunta.
func (s *Store) SearchSessions(query string, limit int) ([]SearchHit, error) {
	needle := strings.ToLower(strings.TrimSpace(query))
	if needle == "" {
		return []SearchHit{}, nil
	}
	if limit <= 0 || limit > MaxSearchResults {
		limit = MaxSearchResults
	}

	sessions, err := s.ListSessions()
	if err != nil {
		return nil, err
	}

	out := make([]SearchHit, 0, limit)
	for _, meta := range sessions {
		if len(out) >= limit {
			break
		}
		hits := s.searchSession(meta, needle, min(searchHitsPerSession, limit-len(out)))
		out = append(out, hits...)
	}
	return out, nil
}

// searchSession pagina o log de UMA sessão colhendo até `budget` trechos.
// Erro de leitura devolve o que já achou: uma sessão ilegível não pode derrubar
// a busca nas outras — a mesma regra do ListSessions.
func (s *Store) searchSession(meta SessionMeta, needle string, budget int) []SearchHit {
	if budget <= 0 {
		return nil
	}
	var hits []SearchHit
	var cursor uint64
	for {
		batch, err := s.Since(meta.ID, cursor, MaxEventBatch)
		if err != nil || len(batch) == 0 {
			return hits
		}
		for _, envelope := range batch {
			cursor = envelope.Seq
			if envelope.Kind != protocol.KindMessage {
				continue
			}
			var message protocol.Message
			if err := envelope.Decode(&message); err != nil || message.Text == "" {
				continue
			}
			at := strings.Index(strings.ToLower(message.Text), needle)
			if at < 0 {
				continue
			}
			hits = append(hits, SearchHit{
				Session:   meta.ID,
				Title:     meta.Title,
				Seq:       envelope.Seq,
				Turn:      envelope.Turn,
				Role:      message.Role,
				Snippet:   snippetAround(message.Text, at, len(needle)),
				UpdatedAt: meta.UpdatedAt,
			})
			if len(hits) >= budget {
				return hits
			}
		}
		if len(batch) < MaxEventBatch {
			return hits
		}
	}
}

// snippetAround recorta uma janela ao redor do trecho encontrado, com corte em
// fronteira de rune — cortar no meio de um caractere multibyte produziria
// U+FFFD bem no pedaço que a pessoa vai ler.
//
// `at` vem de uma busca sobre o texto MINÚSCULO, e o ToLower do Go pode mudar o
// tamanho em bytes de raros caracteres — por isso o deslocamento é tratado como
// aproximado: ancorado nos limites e ajustado à fronteira, nunca confiado como
// exato. O trecho continua certo para todo texto comum, e no caso raro sai
// deslocado por um caractere, não quebrado.
func snippetAround(text string, at, matchLen int) string {
	if at < 0 || at > len(text) {
		at = 0
	}
	start := at - searchSnippetRadius
	if start < 0 {
		start = 0
	}
	end := at + matchLen + searchSnippetRadius
	if end > len(text) {
		end = len(text)
	}
	for start > 0 && !utf8.RuneStart(text[start]) {
		start--
	}
	for end < len(text) && !utf8.RuneStart(text[end]) {
		end++
	}
	snippet := strings.Join(strings.Fields(text[start:end]), " ")
	if start > 0 {
		snippet = "…" + snippet
	}
	if end < len(text) {
		snippet += "…"
	}
	return snippet
}
