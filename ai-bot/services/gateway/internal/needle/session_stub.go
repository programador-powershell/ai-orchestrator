//go:build !needle

// Build PADRÃO: sem cgo, sem biblioteca nativa, sem modelo de 14 MB.
//
// Este é o arquivo que compila quando ninguém pediu o Needle — que é o caso do
// build de desenvolvimento, do CI e de qualquer máquina onde a biblioteca ainda
// não passou por TI/SI. `Ready()` devolve false, a cascata pula o degrau local
// e o roteamento vira fast router → modelo grande.
//
// O ponto de existir um esboço em vez de simplesmente não existir o pacote: com
// ele, `go build ./...` e `go test ./...` funcionam em qualquer lugar, e
// `CGO_ENABLED=0` continua produzindo um binário estático. Sem ele, todo mundo
// que clonasse o repositório precisaria da DLL para compilar.
package needle

import "context"

// Session é a sessão do modelo local. Neste build ela é oca.
type Session struct{}

// Open sempre falha aqui — e o erro diz como habilitar, porque "não disponível"
// sem instrução manda a pessoa procurar no código.
func Open(Options) (*Session, error) {
	return nil, ErrUnavailable
}

// Ready é false: não há biblioteca nativa neste binário.
func (s *Session) Ready() bool { return false }

// Call nunca chega a ser chamado (Ready barra antes), mas responde direito caso
// alguém pule a checagem.
func (s *Session) Call(context.Context, string, []Tool) (string, error) {
	return "", ErrUnavailable
}

// Close não tem o que liberar.
func (s *Session) Close() error { return nil }

// Version diz que não há biblioteca. O log de subida imprime isto, e ver
// "ausente" no log é o que faz alguém perceber que o degrau local não está
// ligado — em vez de estranhar meses depois por que o roteamento é lento.
func Version() string { return "ausente (build sem a tag " + BuildTag + ")" }

// BuildTag é o que precisa ser passado ao compilador para trocar este esboço
// pelo binding de verdade. Exportado para a mensagem de erro do gateway poder
// citá-lo sem repetir a string.
const BuildTag = "needle"
