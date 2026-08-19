package transport

import "testing"

// O vetor de teste da RFC 6455, §1.3.
//
// Este é o único teste do handshake que não pode ser escrito "conferindo com a
// própria implementação": ele usa a chave e a resposta que a norma publica. A
// constante mágica estava com dois caracteres trocados de lugar
// (…-95CA-5AB0DC85B11C em vez de …-95CA-C5AB0DC85B11), e o efeito foi o pior
// possível — NENHUM navegador conectava, porque o navegador confere este campo
// e recusa em silêncio, com close 1006 e nenhuma mensagem. Cliente escrito à
// mão que não confere (o de teste, o de linha de comando) conectava normalmente,
// então o defeito ficou escondido atrás de um "funciona aqui".
func TestAcceptKeyBateComARFC(t *testing.T) {
	// RFC 6455: "dGhlIHNhbXBsZSBub25jZQ==" -> "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
	const chave = "dGhlIHNhbXBsZSBub25jZQ=="
	const esperado = "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="

	if got := acceptKey(chave); got != esperado {
		t.Fatalf("acceptKey(%q) = %q, a RFC exige %q — nenhum navegador conecta com isto",
			chave, got, esperado)
	}
}

// A constante em si, escrita por extenso: se alguém a reordenar de novo, o teste
// aponta o caractere, e não só o efeito.
func TestGUIDDoHandshake(t *testing.T) {
	const daRFC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
	if websocketGUID != daRFC {
		t.Fatalf("websocketGUID = %q, a RFC 6455 fixa %q", websocketGUID, daRFC)
	}
}
