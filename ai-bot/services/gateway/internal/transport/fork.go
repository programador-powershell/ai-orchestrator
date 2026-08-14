// POST /v1/sessions/{id}/fork — ramifica uma conversa.
//
// A rota é fina de propósito (o padrão deste pacote): quem sabe copiar log é o
// store (ForkSession), e o transporte só serializa. O fork copia o prefixo até
// `fromSeq` (ausente = tudo) para uma sessão NOVA com ProjectID/CWD/Specialist
// herdados — dois futuros sobre o mesmo passado, sem recontar a história. O
// caso que paga o recurso: testar PostgreSQL num ramo e SQL Server no outro,
// em paralelo, partindo do mesmo contexto.
package transport

import (
	"encoding/json"
	"net/http"
)

// forkRequest é o corpo do POST. Os dois campos são opcionais: corpo vazio
// significa "o log inteiro, com o título padrão".
type forkRequest struct {
	// FromSeq é o corte (inclusivo). Zero ou ausente = tudo.
	FromSeq uint64 `json:"fromSeq"`
	// Title sobrepõe o "fork: <original>" que o store monta.
	Title string `json:"title"`
}

// postFork cria a ramificação e devolve o cabeçalho da sessão nova — é ele que
// o cliente usa para abrir a conversa ramificada na hora.
func (s *Server) postFork(w http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("id")

	// O decode tolerante segue o padrão do createSession: corpo vazio é o caso
	// normal (o botão da barra lateral ramifica o log inteiro), e um corpo
	// malformado cai nos padrões em vez de derrubar a ação com um 400 que a
	// pessoa não tem como corrigir pela tela.
	var body forkRequest
	_ = json.NewDecoder(r.Body).Decode(&body)

	meta, err := s.store.ForkSession(sessionID, body.FromSeq, body.Title)
	if err != nil {
		// ErrNotFound vira 404; o resto é falha de disco (500) — storeError já
		// separa os dois.
		s.storeError(w, err)
		return
	}

	// 201: nasceu uma sessão. O cabeçalho vem antes do WriteHeader pelo mesmo
	// motivo documentado no createSession — depois dele, Header().Set é ignorado.
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusCreated)
	s.ok(w, meta)
}
