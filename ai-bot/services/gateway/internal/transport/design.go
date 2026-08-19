// A rota do "Clonar layout" da tela de Design.
//
// POST /v1/design/fetch {url} → {html, finalUrl}.
//
// Ela existe porque o webview NÃO PODE buscar a página sozinho: a resposta de
// outra origem morre no CORS antes de o JS lê-la, e dar `fetch` livre ao app
// seria abrir mão do anti-SSRF. No orquestrador de referência esse papel era do
// `page_fetch` do Rust (research.rs); aqui o host Tauri do AI-BOT não expõe
// fetch de página, então o gateway — que já tem o guarda de rede — assume. A
// tela renderiza o HTML devolvido num iframe SEM script e lê a geometria real
// com getBoundingClientRect; o transporte só entrega os bytes.
//
// Três decisões que não são detalhe:
//
//   - TODA busca passa pelo internal/netguard (IP resolvido UMA vez e fixado
//     no dial — fecha o DNS rebinding), nunca por http.Get. A URL vem da
//     pessoa, mas a resposta volta para dentro da rede da empresa.
//   - a URL FINAL vai junto do HTML: se houve redirect, os caminhos relativos
//     do documento são relativos a ela, não à digitada — absolutizar contra a
//     URL errada montaria o layout com CSS e imagem de outro host.
//   - o teto é 2 MB (o mesmo MAX_DESIGN_SOURCE_BYTES da referência): página
//     maior que isso é carga de aplicação, não layout, e o HTML inteiro viaja
//     de volta na resposta HTTP.
package transport

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"aibot/gateway/internal/netguard"
)

// designFetchMaxBody é o teto do HTML devolvido — 2 MiB.
const designFetchMaxBody = 2 << 20

// designNet é o netguard visto por esta rota: só o GET guardado. Interface, e
// não o tipo concreto, pelo mesmo motivo do guardedNet de internal/update: o
// guarda de verdade recusa loopback, e o teste precisa responder de um fake —
// sem tocar rede nenhuma.
type designNet interface {
	Fetch(ctx context.Context, raw string, header http.Header) (*http.Response, []byte, error)
}

// postDesignFetch é o handler registrado em http.go.
//
// O guarda é montado POR REQUISIÇÃO a partir do gate: o Server não guarda um
// netguard próprio (o campo pertence à Toolbox do supervisor), e construir o
// Guard é barato — um struct com dialer, sem estado. O que importa é que a
// blocklist lida seja a da POLÍTICA ATUAL: ler `s.gate.Policy()` na hora da
// chamada acompanha a rotação da política sem cache para envelhecer.
func (s *Server) postDesignFetch(w http.ResponseWriter, r *http.Request) {
	var body struct {
		URL string `json:"url"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		s.fail(w, http.StatusBadRequest, "bad_request", "corpo inválido: "+err.Error())
		return
	}
	guard := netguard.New(func() []string {
		// gate nil acontece num gateway mínimo (testes, boot sem política):
		// sem lista de bloqueio por domínio, mas as regras de rede interna do
		// netguard continuam todas de pé.
		if s.gate == nil {
			return nil
		}
		return s.gate.Policy().BlockedDomains
	})
	s.serveDesignFetch(w, r, guard, body.URL)
}

// serveDesignFetch é o miolo da rota, com o guarda por parâmetro — é o que o
// teste chama com um fake para exercitar sucesso, teto e content-type sem rede.
func (s *Server) serveDesignFetch(w http.ResponseWriter, r *http.Request, fetcher designNet, raw string) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		s.fail(w, http.StatusBadRequest, "bad_request", "informe o endereço da página em \"url\"")
		return
	}

	response, body, err := fetcher.Fetch(r.Context(), raw, http.Header{"Accept": {"text/html"}})
	if err != nil {
		// A recusa do guarda sai com o MOTIVO dele (esquema, nome interno,
		// endereço privado, regra da política): é a frase que a tela mostra, e
		// "não deu" mandaria a pessoa tentar a mesma URL de novo. 403 e não
		// 400 porque o pedido está bem formado — o destino é que é proibido.
		if errors.Is(err, netguard.ErrBlocked) {
			s.fail(w, http.StatusForbidden, "destino_bloqueado", err.Error())
			return
		}
		// 502: a falha é da origem (DNS, conexão, timeout), não do pedido.
		s.fail(w, http.StatusBadGateway, "origem_inacessivel", err.Error())
		return
	}
	if response.StatusCode != http.StatusOK {
		s.fail(w, http.StatusBadGateway, "origem_inacessivel",
			fmt.Sprintf("a página respondeu %d", response.StatusCode))
		return
	}

	// Só HTML — a tela vai RENDERIZAR isto num iframe; um PDF ou um JSON
	// sairiam como sopa de bytes num layout que parece bug. Tipo ausente
	// passa (a referência fazia igual): servidor preguiçoso não declara.
	contentType := strings.ToLower(strings.TrimSpace(response.Header.Get("Content-Type")))
	if contentType != "" && !strings.Contains(contentType, "text/html") {
		s.fail(w, http.StatusUnsupportedMediaType, "nao_html",
			"o clone de layout precisa de HTML e a resposta veio como "+contentType)
		return
	}

	// O teto é conferido no TAMANHO LIDO, não no Content-Length: o header é
	// promessa do servidor, e um chunked sem header passaria reto. O netguard
	// já corta em 8 MiB; aqui o corte é o da rota.
	if len(body) > designFetchMaxBody {
		s.fail(w, http.StatusBadRequest, "pagina_grande_demais",
			fmt.Sprintf("a página tem mais de %d MB — o teto do clone de layout é 2 MB", len(body)>>20))
		return
	}

	finalURL := raw
	if response.Request != nil && response.Request.URL != nil {
		finalURL = response.Request.URL.String()
	}
	s.ok(w, map[string]string{"html": string(body), "finalUrl": finalURL})
}
