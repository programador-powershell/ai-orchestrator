// Testes da saída de rede.
//
// O ataque que este pacote existe para fechar é o SSRF: convencer o gateway,
// que roda dentro da rede da empresa, a buscar um endereço interno e devolver o
// conteúdo. Nenhum teste daqui toca a rede — todos param antes da resolução de
// nome, que é justamente onde as recusas precisam acontecer.
package netguard

import (
	"context"
	"errors"
	"net"
	"testing"
)

func parseIP(t *testing.T, text string) net.IP {
	t.Helper()
	ip := net.ParseIP(text)
	if ip == nil {
		t.Fatalf("endereço de teste inválido: %q", text)
	}
	return ip
}

/* ------------------------------ IsInternal ------------------------------ */

func TestIsInternalCoversPrivateLoopbackAndMetadata(t *testing.T) {
	cases := []struct {
		address string
		why     string
	}{
		{"127.0.0.1", "loopback"},
		{"10.0.0.1", "rede privada"},
		{"172.16.0.1", "rede privada"},
		{"192.168.1.1", "rede privada"},
		{"169.254.169.254", "metadados de nuvem"},
		{"100.64.0.1", "CGNAT"},
		{"0.0.0.0", "esta rede"},
		{"255.255.255.255", "broadcast"},
		{"240.0.0.1", "reservado"},
		{"224.0.0.1", "multicast"},
		{"::1", "loopback v6"},
		{"::", "não especificado v6"},
		{"fc00::1", "único local v6"},
		{"fd00::1", "único local v6"},
		{"fe80::1", "link-local v6"},
		{"ff02::1", "multicast v6"},
		// O caso que sempre escapa: é o MESMO endereço de metadados, escrito
		// como IPv4 embutido em IPv6. Sem a conversão antes das regras v6 ele
		// passa por todas elas.
		{"::ffff:169.254.169.254", "metadados de nuvem em v4 embutido"},
		{"::ffff:127.0.0.1", "loopback em v4 embutido"},
		{"::ffff:10.0.0.1", "rede privada em v4 embutido"},
	}

	for _, each := range cases {
		if !IsInternal(parseIP(t, each.address)) {
			t.Errorf("IsInternal(%q): esperava true (%s), obteve false", each.address, each.why)
		}
	}

	if !IsInternal(nil) {
		t.Errorf("IsInternal(nil): esperava true (na dúvida, fecha), obteve false")
	}
}

func TestIsInternalAllowsPublicAddresses(t *testing.T) {
	for _, address := range []string{"8.8.8.8", "1.1.1.1", "93.184.216.34", "2001:4860:4860::8888", "2606:4700::1111"} {
		if IsInternal(parseIP(t, address)) {
			t.Errorf("IsInternal(%q): esperava false (endereço público), obteve true", address)
		}
	}
}

/* --------------------------------- Check -------------------------------- */

func TestCheckRejectsSchemesAndInternalNames(t *testing.T) {
	guard := New(nil)

	cases := []struct {
		name string
		raw  string
	}{
		{"esquema file", "file:///C:/Windows/System32/drivers/etc/hosts"},
		{"esquema ftp", "ftp://exemplo.com/arquivo"},
		{"esquema vazio", "exemplo.com/sem-esquema"},
		{"sem host", "http:///caminho"},
		{"localhost", "http://localhost:8799/v1/stream"},
		{"subdomínio de localhost", "http://api.localhost/"},
		{"nome .internal", "http://metadados.internal/latest"},
		{"nome .local", "http://impressora.local/"},
		{"nome .local com ponto final", "http://impressora.local./"},
		{"localhost em maiúsculas", "http://LOCALHOST/"},
	}

	for _, each := range cases {
		t.Run(each.name, func(t *testing.T) {
			target, approved, err := guard.Check(context.Background(), each.raw)
			if err == nil {
				t.Fatalf("Check(%q): esperava recusa, obteve %v com os endereços %v", each.raw, target, approved)
			}
			if !errors.Is(err, ErrBlocked) {
				t.Errorf("Check(%q): esperava um erro de %q, obteve %q", each.raw, ErrBlocked, err)
			}
			if target != nil || approved != nil {
				t.Errorf("Check(%q) recusado: esperava url e endereços nil, obteve %v e %v", each.raw, target, approved)
			}
		})
	}
}

// A política é consultada ANTES de resolver o nome: uma consulta DNS de graça
// já é informação para quem está do outro lado.
func TestCheckRejectsBlockedDomainsBeforeResolving(t *testing.T) {
	guard := New(func() []string { return []string{"exemplo.com"} })

	for _, raw := range []string{"https://exemplo.com/x", "https://interno.exemplo.com/x", "https://exemplo.com.:8443/x"} {
		_, _, err := guard.Check(context.Background(), raw)
		if err == nil {
			t.Fatalf("Check(%q) com a política bloqueando exemplo.com: esperava recusa, obteve sucesso", raw)
		}
		if !errors.Is(err, ErrBlocked) {
			t.Errorf("Check(%q): esperava um erro de %q, obteve %q", raw, ErrBlocked, err)
		}
	}
}
