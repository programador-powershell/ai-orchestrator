// POST /v1/sessions/{id}/truncate — corta o fim do log de uma conversa.
//
// É a metade servidor do "regenerar a última resposta" e do "editar a última
// pergunta": sem um corte DURÁVEL, o cliente só teria como reenviar por cima —
// e a pergunta duplicaria para sempre no histórico, porque o histórico que o
// modelo lê É o log. A rota é fina como as vizinhas: quem sabe cortar é o
// store (TruncateBefore); aqui mora só o contrato da borda — token, corpo,
// códigos e a recusa de cortar um turno EM EXECUÇÃO.
package transport

import (
	"encoding/json"
	"net/http"
)

// truncateRequest é o corpo do POST. Um dos dois campos precisa vir:
// `beforeSeq` corta a partir daquele envelope (inclusive); `turn` resolve o
// primeiro envelope do turno e corta dali — é o que o "regenerar" usa sem
// precisar saber seq nenhum.
type truncateRequest struct {
	BeforeSeq uint64 `json:"beforeSeq"`
	Turn      string `json:"turn"`
}

func (s *Server) postTruncate(w http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("id")

	// Decode ESTRITO, ao contrário do fork: corpo vazio lá era "tudo, com o
	// título padrão"; aqui seria "cortar não sei o quê" — e cortar é destrutivo.
	var body truncateRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		s.fail(w, http.StatusBadRequest, "bad_request", "corpo inválido: "+err.Error())
		return
	}
	if body.BeforeSeq == 0 && body.Turn == "" {
		s.fail(w, http.StatusBadRequest, "sem_corte", "informe beforeSeq ou turn")
		return
	}
	if _, err := s.store.GetSession(sessionID); err != nil {
		s.storeError(w, err)
		return
	}
	// Turno rodando escreve no log NESTE momento: cortar por baixo dele deixaria
	// a resposta em curso órfã da pergunta — metade do turno sobreviveria ao
	// corte e o log contaria uma conversa que não aconteceu. Quem quer
	// regenerar uma resposta em andamento primeiro a interrompe.
	if s.sup.Busy(sessionID) {
		s.fail(w, http.StatusConflict, "turno_em_execucao",
			"há um turno em execução nesta conversa — interrompa antes de cortar o histórico")
		return
	}

	cut := body.BeforeSeq
	if cut == 0 {
		seq, err := s.store.FirstSeqOfTurn(sessionID, body.Turn)
		if err != nil {
			s.storeError(w, err)
			return
		}
		if seq == 0 {
			s.fail(w, http.StatusNotFound, "turno_desconhecido", "nenhum envelope deste turno no log")
			return
		}
		cut = seq
	}

	meta, err := s.store.TruncateBefore(sessionID, cut)
	if err != nil {
		s.storeError(w, err)
		return
	}
	// O novo fim volta para o cliente reancorar o replay: é com ele que a tela
	// sabe que o corte pegou e reabre a conversa do ponto certo.
	s.ok(w, map[string]any{"lastSeq": meta.LastSeq, "turns": meta.Turns})
}
