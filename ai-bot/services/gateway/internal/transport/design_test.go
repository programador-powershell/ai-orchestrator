// Testes da rota POST /v1/design/fetch — o "Clonar layout" da tela de Design.
//
// Duas frentes, de propósito:
//
//   - as RECUSAS do guarda rodam pela rota inteira (Handler + auth + netguard
//     de verdade), porque são determinísticas SEM rede: "localhost" morre pelo
//     nome antes do DNS, 127.0.0.1 é literal e o esquema é conferido antes de
//     tudo. É o caminho real que um atacante tentaria.
//   - o SUCESSO e os tetos rodam contra um guarda falso via serveDesignFetch:
//     o netguard de verdade recusa loopback, então o único jeito de exercitar
//     o miolo sem depender da internet é responder de um fake — o mesmo motivo
//     do loopbackNet de internal/update.
package transport

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"aibot/gateway/internal/config"
	"aibot/gateway/internal/fusion"
)

const designTestToken = "token-de-teste-do-design"

// newDesignHarness monta o servidor mínimo da rota: só config e log — a rota
// de design não toca store, barramento, supervisor nem catálogo, e montá-los
// aqui esconderia quais dependências ela realmente tem.
func newDesignHarness(t *testing.T) *Server {
	t.Helper()
	return NewServer(
		config.Config{Token: designTestToken},
		nil, nil, nil,
		nil,
		fusion.NewRegistry(),
		nil, nil,
		nil, "",
		slog.New(slog.NewTextHandler(io.Discard, nil)),
	)
}

// designDo dispara a requisição pela rota inteira, com ou sem token.
func designDo(t *testing.T, handler http.Handler, token string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var reader io.Reader
	if texto, cru := body.(string); cru {
		reader = strings.NewReader(texto)
	} else if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("serializar corpo: %v", err)
		}
		reader = bytes.NewReader(raw)
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/design/fetch", reader)
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

// designError lê o {code, message} do corpo de erro padrão do servidor.
func designError(t *testing.T, recorder *httptest.ResponseRecorder) (string, string) {
	t.Helper()
	var parsed struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &parsed); err != nil {
		t.Fatalf("corpo de erro não é o padrão do servidor: %v\n%s", err, recorder.Body.String())
	}
	return parsed.Error.Code, parsed.Error.Message
}

// designNetFake é o guarda falso do caminho de sucesso.
type designNetFake struct {
	status   int
	header   http.Header
	body     []byte
	finalURL string
	err      error
}

func (f designNetFake) Fetch(context.Context, string, http.Header) (*http.Response, []byte, error) {
	if f.err != nil {
		return nil, nil, f.err
	}
	header := f.header
	if header == nil {
		header = http.Header{}
	}
	response := &http.Response{StatusCode: f.status, Header: header}
	if f.finalURL != "" {
		parsed, err := url.Parse(f.finalURL)
		if err != nil {
			panic(err) // URL de teste inválida é bug do teste
		}
		response.Request = &http.Request{URL: parsed}
	}
	return response, f.body, nil
}

/* ------------------------------- pela rota -------------------------------- */

// A rota é autenticada como tudo no gateway: sem o token, qualquer página
// aberta no navegador da estação usaria o AI-BOT como proxy de saída.
func TestDesignFetchExigeToken(t *testing.T) {
	handler := newDesignHarness(t).Handler()

	if code := designDo(t, handler, "", map[string]string{"url": "https://exemplo.com"}).Code; code != http.StatusUnauthorized {
		t.Fatalf("sem token: esperava 401, veio %d", code)
	}
	if code := designDo(t, handler, "token-errado", map[string]string{"url": "https://exemplo.com"}).Code; code != http.StatusUnauthorized {
		t.Fatalf("token errado: esperava 401, veio %d", code)
	}
}

func TestDesignFetchRecusaCorpoInvalidoESemURL(t *testing.T) {
	handler := newDesignHarness(t).Handler()

	if code := designDo(t, handler, designTestToken, "não é json").Code; code != http.StatusBadRequest {
		t.Fatalf("corpo inválido: esperava 400, veio %d", code)
	}

	recorder := designDo(t, handler, designTestToken, map[string]string{"url": "   "})
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("sem url: esperava 400, veio %d", recorder.Code)
	}
	if _, message := designError(t, recorder); !strings.Contains(message, "url") {
		t.Fatalf("a recusa tinha de apontar o campo url, veio %q", message)
	}
}

// O anti-SSRF é a razão de a rota existir no gateway em vez de um fetch no
// webview — e a recusa tem de voltar com o MOTIVO do guarda, porque é a frase
// que a tela mostra para a pessoa corrigir a URL.
func TestDesignFetchRecusaDestinoBloqueadoComMotivo(t *testing.T) {
	handler := newDesignHarness(t).Handler()

	for _, alvo := range []string{
		"http://localhost/admin",    // nome interno, recusado antes do DNS
		"http://127.0.0.1:8080/",    // loopback literal, sem consulta de rede
		"ftp://exemplo.com/arquivo", // esquema fora de http(s)
	} {
		recorder := designDo(t, handler, designTestToken, map[string]string{"url": alvo})
		if recorder.Code != http.StatusForbidden {
			t.Errorf("%s: esperava 403, veio %d: %s", alvo, recorder.Code, recorder.Body.String())
			continue
		}
		code, message := designError(t, recorder)
		if code != "destino_bloqueado" || !strings.Contains(message, "bloqueado") {
			t.Errorf("%s: esperava o motivo do guarda, veio %q / %q", alvo, code, message)
		}
	}
}

/* ------------------------------ pelo miolo -------------------------------- */

func TestDesignFetchDevolveHTMLEURLFinal(t *testing.T) {
	server := newDesignHarness(t)
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/v1/design/fetch", nil)

	server.serveDesignFetch(recorder, request, designNetFake{
		status: http.StatusOK,
		header: http.Header{"Content-Type": {"text/html; charset=utf-8"}},
		body:   []byte("<html><body>oi</body></html>"),
		// A URL final difere da pedida de propósito: é o caso do redirect, e o
		// cliente absolutiza os caminhos relativos contra ELA.
		finalURL: "https://exemplo.com/inicio",
	}, "http://exemplo.com")

	if recorder.Code != http.StatusOK {
		t.Fatalf("esperava 200, veio %d: %s", recorder.Code, recorder.Body.String())
	}
	var parsed struct {
		HTML     string `json:"html"`
		FinalURL string `json:"finalUrl"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &parsed); err != nil {
		t.Fatalf("resposta fora do contrato {html, finalUrl}: %v\n%s", err, recorder.Body.String())
	}
	if parsed.HTML != "<html><body>oi</body></html>" {
		t.Errorf("html: veio %q", parsed.HTML)
	}
	if parsed.FinalURL != "https://exemplo.com/inicio" {
		t.Errorf("finalUrl: esperava a URL depois do redirect, veio %q", parsed.FinalURL)
	}
}

func TestDesignFetchRespeitaTetoDe2MB(t *testing.T) {
	server := newDesignHarness(t)
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/v1/design/fetch", nil)

	server.serveDesignFetch(recorder, request, designNetFake{
		status: http.StatusOK,
		header: http.Header{"Content-Type": {"text/html"}},
		body:   bytes.Repeat([]byte("a"), designFetchMaxBody+1),
	}, "https://exemplo.com")

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("esperava 400, veio %d", recorder.Code)
	}
	if code, message := designError(t, recorder); code != "pagina_grande_demais" || !strings.Contains(message, "2 MB") {
		t.Fatalf("a recusa tinha de citar o teto de 2 MB, veio %q / %q", code, message)
	}
}

func TestDesignFetchRecusaOQueNaoEhHTML(t *testing.T) {
	server := newDesignHarness(t)
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/v1/design/fetch", nil)

	server.serveDesignFetch(recorder, request, designNetFake{
		status: http.StatusOK,
		header: http.Header{"Content-Type": {"application/pdf"}},
		body:   []byte("%PDF-1.7"),
	}, "https://exemplo.com/arquivo.pdf")

	if recorder.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("esperava 415, veio %d", recorder.Code)
	}
	if _, message := designError(t, recorder); !strings.Contains(message, "application/pdf") {
		t.Fatalf("a recusa tinha de citar o tipo recebido, veio %q", message)
	}
}

func TestDesignFetchPropagaFalhaDaOrigem(t *testing.T) {
	server := newDesignHarness(t)

	// Origem que respondeu, mas não 200.
	recorder := httptest.NewRecorder()
	server.serveDesignFetch(recorder, httptest.NewRequest(http.MethodPost, "/v1/design/fetch", nil),
		designNetFake{status: http.StatusNotFound}, "https://exemplo.com/sumida")
	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("status da origem: esperava 502, veio %d", recorder.Code)
	}
	if _, message := designError(t, recorder); !strings.Contains(message, "404") {
		t.Fatalf("a recusa tinha de citar o status da origem, veio %q", message)
	}

	// Origem que nem respondeu (DNS, conexão, timeout).
	recorder = httptest.NewRecorder()
	server.serveDesignFetch(recorder, httptest.NewRequest(http.MethodPost, "/v1/design/fetch", nil),
		designNetFake{err: io.ErrUnexpectedEOF}, "https://exemplo.com")
	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("erro de rede: esperava 502, veio %d", recorder.Code)
	}
}
