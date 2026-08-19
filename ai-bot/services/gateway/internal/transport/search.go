// GET /v1/sessions/search?q= — busca por conteúdo nas conversas (Ctrl+K).
//
// Fina como as vizinhas: quem sabe varrer o log é o store (SearchSessions);
// aqui só o contrato da borda. Autenticada como tudo — o conteúdo das
// conversas é exatamente o que o token protege. O "dono" deste gateway é quem
// tem o token: o processo é por estação, sem multiusuário, então não há outro
// dono de quem separar as sessões.
package transport

import (
	"net/http"
	"strconv"
	"strings"

	"aibot/gateway/internal/store"
)

func (s *Server) searchSessions(w http.ResponseWriter, r *http.Request) {
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if query == "" {
		// Busca vazia não é erro: é a tela abrindo antes de a pessoa digitar.
		s.ok(w, map[string]any{"results": []store.SearchHit{}})
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))

	hits, err := s.store.SearchSessions(query, limit)
	if err != nil {
		s.fail(w, http.StatusInternalServerError, "store", err.Error())
		return
	}
	if hits == nil {
		hits = []store.SearchHit{}
	}
	s.ok(w, map[string]any{"results": hits})
}
