// Package netguard é a saída de rede do AI-BOT.
//
// Todo acesso a URL vinda de fora (o modelo, um plugin, um fluxo) passa por
// aqui. O ataque que este pacote existe para fechar é o SSRF: convencer o
// gateway — que roda na estação da pessoa, dentro da rede da empresa — a buscar
// um endereço interno e devolver o conteúdo. `http://169.254.169.254/` num
// prompt vira credencial de nuvem no chat.
//
// O detalhe que a maioria das implementações erra: NÃO basta validar a URL e
// depois chamar o cliente HTTP. Entre a validação e a conexão o DNS pode
// responder outra coisa (DNS rebinding) — o nome resolve para um IP público na
// checagem e para 127.0.0.1 na conexão. Por isso aqui o host é resolvido UMA
// vez, cada endereço é conferido, e o dial é FIXADO nos endereços aprovados: o
// cliente não resolve nome nenhum.
package netguard

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"aibot/gateway/internal/permissions"
)

// MaxBody é o teto de download. Sem teto, uma URL que serve um fluxo infinito
// consome a memória do processo.
const MaxBody = 8 << 20

// ErrBlocked marca recusa por política ou por destino interno.
var ErrBlocked = errors.New("destino bloqueado")

// Guard aplica as regras e disca.
type Guard struct {
	// Blocked são as regras de domínio da política assinada.
	blocked func() []string
	dialer  *net.Dialer
}

// New monta o guarda. `blocked` pode ser nil (sem lista de bloqueio).
func New(blocked func() []string) *Guard {
	return &Guard{
		blocked: blocked,
		dialer:  &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second},
	}
}

// Check valida a URL sem conectar. Devolve os endereços aprovados.
func (g *Guard) Check(ctx context.Context, raw string) (*url.URL, []string, error) {
	target, err := url.Parse(raw)
	if err != nil {
		return nil, nil, fmt.Errorf("url inválida: %w", err)
	}
	if target.Scheme != "http" && target.Scheme != "https" {
		return nil, nil, fmt.Errorf("%w: esquema %q não é permitido", ErrBlocked, target.Scheme)
	}
	host := target.Hostname()
	if host == "" {
		return nil, nil, fmt.Errorf("%w: url sem host", ErrBlocked)
	}

	// Nomes recusados ANTES de resolver: resolver "localhost" só para descobrir
	// que é loopback dá ao atacante uma consulta DNS de graça, e alguns
	// resolvedores internos respondem coisas surpreendentes para `.internal`.
	lower := strings.ToLower(strings.TrimSuffix(host, "."))
	if lower == "localhost" ||
		strings.HasSuffix(lower, ".localhost") ||
		strings.HasSuffix(lower, ".local") ||
		strings.HasSuffix(lower, ".internal") {
		return nil, nil, fmt.Errorf("%w: nome interno %q", ErrBlocked, host)
	}

	if g.blocked != nil {
		if rule, hit := permissions.HostBlocked(g.blocked(), lower); hit {
			return nil, nil, fmt.Errorf("%w: a política bloqueia %q (regra %q)", ErrBlocked, host, rule)
		}
	}

	addresses, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, nil, fmt.Errorf("resolver %s: %w", host, err)
	}
	if len(addresses) == 0 {
		return nil, nil, fmt.Errorf("%w: %s não resolve", ErrBlocked, host)
	}

	port := target.Port()
	if port == "" {
		if target.Scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}

	approved := make([]string, 0, len(addresses))
	for _, address := range addresses {
		if IsInternal(address.IP) {
			// UM endereço interno reprova a URL inteira. Aceitar os outros
			// deixaria o atacante publicar um nome com dois registros e ganhar
			// no retry — a falha tem de ser do nome, não da tentativa.
			return nil, nil, fmt.Errorf("%w: %s resolve para o endereço interno %s", ErrBlocked, host, address.IP)
		}
		approved = append(approved, net.JoinHostPort(address.IP.String(), port))
	}
	return target, approved, nil
}

// Client devolve um cliente HTTP que só disca nos endereços aprovados e NÃO
// segue redirect sozinho.
//
// O redirect é seguido à mão por quem chama (ver Fetch) porque cada salto é uma
// URL nova, que precisa passar pelas mesmas checagens. Um cliente que segue
// redirect sozinho valida o primeiro endereço e conecta no que o servidor
// mandar — que é o furo inteiro, com passo extra.
func (g *Guard) Client(approved []string) *http.Client {
	pinned := make([]string, len(approved))
	copy(pinned, approved)

	transport := &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			var lastErr error
			for _, address := range pinned {
				connection, err := g.dialer.DialContext(ctx, network, address)
				if err == nil {
					return connection, nil
				}
				lastErr = err
			}
			if lastErr == nil {
				lastErr = errors.New("nenhum endereço aprovado")
			}
			return nil, lastErr
		},
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 20 * time.Second,
		MaxIdleConns:          4,
		IdleConnTimeout:       30 * time.Second,
	}
	return &http.Client{
		Transport: transport,
		Timeout:   45 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

// MaxRedirects é o teto de saltos seguidos à mão.
const MaxRedirects = 5

// Fetch busca a URL com todas as guardas, seguindo redirect à mão.
func (g *Guard) Fetch(ctx context.Context, raw string, header http.Header) (*http.Response, []byte, error) {
	current := raw
	for hop := 0; hop <= MaxRedirects; hop++ {
		target, approved, err := g.Check(ctx, current)
		if err != nil {
			return nil, nil, err
		}
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
		if err != nil {
			return nil, nil, fmt.Errorf("montar requisição: %w", err)
		}
		for key, values := range header {
			for _, value := range values {
				request.Header.Add(key, value)
			}
		}
		if request.Header.Get("User-Agent") == "" {
			request.Header.Set("User-Agent", "AI-BOT/1.0")
		}

		response, err := g.Client(approved).Do(request)
		if err != nil {
			return nil, nil, fmt.Errorf("buscar %s: %w", target.Host, err)
		}

		if isRedirect(response.StatusCode) {
			location := response.Header.Get("Location")
			_ = response.Body.Close()
			if location == "" {
				return nil, nil, fmt.Errorf("%s respondeu %d sem Location", target.Host, response.StatusCode)
			}
			next, err := target.Parse(location)
			if err != nil {
				return nil, nil, fmt.Errorf("redirect inválido: %w", err)
			}
			current = next.String()
			continue
		}

		body, err := io.ReadAll(io.LimitReader(response.Body, MaxBody))
		_ = response.Body.Close()
		if err != nil {
			return nil, nil, fmt.Errorf("ler corpo: %w", err)
		}
		return response, body, nil
	}
	return nil, nil, fmt.Errorf("%w: mais de %d redirecionamentos", ErrBlocked, MaxRedirects)
}

// Post manda JSON para uma URL, com as mesmas guardas do Fetch.
//
// NÃO segue redirect: um POST redirecionado reenvia o corpo para outro
// endereço, e o corpo aqui pode ser o payload de um webhook. Redirect em POST é
// tratado como resposta, e quem chamou decide o que fazer.
func (g *Guard) Post(ctx context.Context, raw string, body []byte) (*http.Response, []byte, error) {
	target, approved, err := g.Check(ctx, raw)
	if err != nil {
		return nil, nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, target.String(), bytes.NewReader(body))
	if err != nil {
		return nil, nil, fmt.Errorf("montar requisição: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", "AI-BOT/1.0")

	response, err := g.Client(approved).Do(request)
	if err != nil {
		// A URL pode ser o segredo (webhook): a mensagem cita só o host.
		return nil, nil, fmt.Errorf("chamar %s: %w", target.Host, err)
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, MaxBody))
	_ = response.Body.Close()
	if err != nil {
		return nil, nil, fmt.Errorf("ler resposta: %w", err)
	}
	return response, payload, nil
}

func isRedirect(status int) bool {
	switch status {
	case http.StatusMovedPermanently, http.StatusFound, http.StatusSeeOther,
		http.StatusTemporaryRedirect, http.StatusPermanentRedirect:
		return true
	default:
		return false
	}
}

// IsInternal diz se o endereço é da rede interna, de loopback ou de metadados.
//
// A ordem importa: o IPv4 embutido num IPv6 é convertido ANTES de qualquer
// regra v6. Sem isso `::ffff:169.254.169.254` passa por todas as checagens v6 —
// é o mesmo endereço de metadados de nuvem, escrito de outro jeito.
func IsInternal(ip net.IP) bool {
	if ip == nil {
		return true
	}
	if embedded := ip.To4(); embedded != nil {
		return isInternalV4(embedded)
	}
	if ip.IsLoopback() || ip.IsUnspecified() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsInterfaceLocalMulticast() || ip.IsMulticast() {
		return true
	}
	// fc00::/7 — endereço único local.
	if len(ip) == net.IPv6len && ip[0]&0xFE == 0xFC {
		return true
	}
	return false
}

func isInternalV4(ip net.IP) bool {
	if ip.IsLoopback() || ip.IsUnspecified() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() {
		return true
	}
	if ip.Equal(net.IPv4bcast) {
		return true
	}
	if ip.IsPrivate() {
		return true
	}
	// 0.0.0.0/8 — "esta rede".
	if ip[0] == 0 {
		return true
	}
	// 100.64.0.0/10 — CGNAT. Não é privado pela definição do Go, e é rede de
	// operadora: o que responde lá não é da internet pública.
	if ip[0] == 100 && ip[1] >= 64 && ip[1] <= 127 {
		return true
	}
	// 240.0.0.0/4 — reservado.
	if ip[0] >= 240 {
		return true
	}
	return false
}

// A regra de bloqueio por domínio vive em internal/permissions e é usada daqui
// por delegação, não copiada.
//
// Ela é sutil o bastante para não merecer duas implementações: casar por sufixo
// ingênuo bloquearia `malexemplo.com` junto com `exemplo.com`, e a versão de lá
// ainda trata porta, ponto final de FQDN e IPv6 entre colchetes. Duas cópias
// divergem, e a que diverge é sempre a que o atacante encontra.
