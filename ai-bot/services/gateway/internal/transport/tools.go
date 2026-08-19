// As rotas da interface FORA do turno do modelo (Onda 4).
//
// POST /v1/tools/call     {session, tool, args}            → {ok, output|error}
// POST /v1/model/complete {session, prompt, maxTokens?}    → {text}
//
// Este arquivo é transporte no sentido estrito do pacote: serialização e
// prazo. Quem decide o que é legítimo é o supervisor — a whitelist da UI, o
// especialista da sessão, o portão de aprovação e os envelopes de auditoria
// moram todos em supervisor/ui_tools.go, e a rota não tem NENHUMA regra
// própria. É a lição do app anterior repetida de propósito: um transporte que
// decidisse sozinho seria um caminho por onde a política não passa.
package transport

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"aibot/gateway/internal/modelrouter"
	"aibot/gateway/internal/store"
)

// uiCallDeadline é o prazo de UMA chamada da interface — 2 minutos.
//
// Bem menor que o approvalTimeout do turno (10 min) de propósito: quem clicou
// num botão da tela está na frente dela AGORA, e uma árvore de arquivos que
// fica pendurada dez minutos esperando é uma tela travada. O prazo derruba o
// contexto, o supervisor lê o cancelamento como recusa ("silêncio não é
// consentimento") e a recusa volta com motivo. O autocomplete usa o mesmo
// prazo como pára-quedas — o cliente cancela muito antes, pelo AbortController.
const uiCallDeadline = 2 * time.Minute

// mountUITools registra as rotas desta onda. Existe para o Handler() do
// http.go crescer UMA linha por onda, em vez de uma por rota — e para as duas
// rotas nascerem juntas e autenticadas do mesmo jeito, sempre.
func (s *Server) mountUITools(mux *http.ServeMux) {
	mux.Handle("POST /v1/tools/call", s.auth(s.postToolCall))
	mux.Handle("POST /v1/model/complete", s.auth(s.postModelComplete))
}

// postToolCall é a interface pedindo uma ferramenta fora do turno.
//
// A resposta é 200 com {ok:false, error} para TODA recusa de mérito (fora da
// whitelist, portão, pessoa disse não, ferramenta falhou): para a tela, todas
// são o mesmo evento — "não rodou, mostre o motivo". Os códigos HTTP ficam
// para o que é do transporte: corpo ilegível, token errado, sessão que não
// existe. Misturar os dois obrigaria o cliente a tratar recusa de política em
// dois formatos diferentes.
func (s *Server) postToolCall(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Session string          `json:"session"`
		Tool    string          `json:"tool"`
		Args    json.RawMessage `json:"args"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		s.fail(w, http.StatusBadRequest, "bad_request", "corpo inválido: "+err.Error())
		return
	}
	if strings.TrimSpace(body.Session) == "" || strings.TrimSpace(body.Tool) == "" {
		s.fail(w, http.StatusBadRequest, "bad_request", "informe \"session\" e \"tool\"")
		return
	}

	// O prazo embrulha a requisição INTEIRA, aprovação inclusa: se ninguém
	// decidir o cartão em 2 minutos, o supervisor recusa e a recusa volta por
	// aqui — a rota nunca fica pendurada além do prazo.
	ctx, cancel := context.WithTimeout(r.Context(), uiCallDeadline)
	defer cancel()

	result, err := s.sup.CallToolFromUI(ctx, body.Session, body.Tool, body.Args)
	if err != nil {
		// Só infraestrutura chega aqui (sessão inexistente, log que não grava);
		// o storeError já separa 404 de 500.
		s.storeError(w, err)
		return
	}
	s.ok(w, result)
}

// postModelComplete é o one-shot de autocomplete.
func (s *Server) postModelComplete(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Session   string `json:"session"`
		Prompt    string `json:"prompt"`
		MaxTokens int    `json:"maxTokens"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		s.fail(w, http.StatusBadRequest, "bad_request", "corpo inválido: "+err.Error())
		return
	}
	if strings.TrimSpace(body.Session) == "" {
		s.fail(w, http.StatusBadRequest, "bad_request", "informe \"session\"")
		return
	}
	if strings.TrimSpace(body.Prompt) == "" {
		s.fail(w, http.StatusBadRequest, "bad_request", "informe \"prompt\"")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), uiCallDeadline)
	defer cancel()

	text, err := s.sup.CompleteFromUI(ctx, body.Session, body.Prompt, body.MaxTokens)
	if err != nil {
		switch {
		case errors.Is(err, store.ErrNotFound):
			s.fail(w, http.StatusNotFound, "not_found", err.Error())
		case errors.Is(err, modelrouter.ErrNoModel):
			// 503 e não 400: o pedido está certo, é o catálogo da estação que
			// não tem modelo utilizável agora — a frase diz o que configurar.
			s.fail(w, http.StatusServiceUnavailable, "sem_modelo", err.Error())
		default:
			// 502: a falha é do provedor (rede, chave, corte no stream), não do
			// pedido — o autocomplete do cliente trata como "sem sugestão".
			s.fail(w, http.StatusBadGateway, "modelo_falhou", err.Error())
		}
		return
	}
	s.ok(w, map[string]string{"text": text})
}
