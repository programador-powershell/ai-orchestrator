// Adaptador do roteador local para a cascata.
//
// Fica no supervisor, e não no pacote needle, para a dependência apontar para
// baixo: `supervisor` sabe que existe um degrau local; `needle` não sabe que
// existe um supervisor. Assim o pacote de baixo compila e é testável sozinho —
// com ou sem cgo — e trocar o Needle por outro modelo pequeno amanhã é
// reescrever um arquivo, não desatar um nó.
package supervisor

import (
	"context"

	"aibot/gateway/internal/needle"
	"aibot/gateway/internal/specialist"
)

// NeedleClassifier é o degrau 2 da cascata.
type NeedleClassifier struct {
	session *needle.Session
}

// NewNeedleClassifier abre a sessão do modelo local.
//
// O erro é devolvido para o log de subida dizer POR QUE o degrau não existe
// (build sem a tag, arquivo de pesos ausente, biblioteca que não carregou), mas
// o classificador devolvido é utilizável mesmo assim: `Ready()` responde false e
// a cascata pula. Falhar a subida do gateway inteiro porque um degrau opcional
// não carregou seria trocar uma degradação por uma indisponibilidade.
func NewNeedleClassifier(options needle.Options) (*NeedleClassifier, error) {
	session, err := needle.Open(options)
	if err != nil {
		return &NeedleClassifier{}, err
	}
	return &NeedleClassifier{session: session}, nil
}

// Ready diz se o degrau local existe neste build e nesta máquina.
func (n *NeedleClassifier) Ready() bool {
	return n != nil && n.session != nil && n.session.Ready()
}

// Intent classifica o primeiro input entre os candidatos pré-selecionados.
func (n *NeedleClassifier) Intent(
	ctx context.Context,
	prompt string,
	candidates []specialist.Definition,
) (ClassifierVerdict, error) {
	if !n.Ready() {
		return ClassifierVerdict{}, needle.ErrUnavailable
	}
	verdict, err := n.session.Classify(ctx, prompt, candidates)
	if err != nil {
		return ClassifierVerdict{}, err
	}
	return ClassifierVerdict{
		Specialist: verdict.Specialist,
		Confidence: verdict.Confidence,
		Why:        "roteador local",
	}, nil
}

// Close libera a sessão nativa.
func (n *NeedleClassifier) Close() error {
	if n == nil || n.session == nil {
		return nil
	}
	return n.session.Close()
}

// A asserção falha na compilação se a interface da cascata mudar — melhor do
// que descobrir em execução que o degrau local parou de ser consultado.
var _ IntentClassifier = (*NeedleClassifier)(nil)

/* ------------------------- o mesmo degrau, por processo ------------------- */

// SidecarClassifier é o degrau 2 servido por um PROCESSO separado (Python), e
// não pela biblioteca nativa.
//
// Existe ao lado do NeedleClassifier, e não no lugar dele, porque as duas rotas
// têm trocas diferentes: cgo é mais rápido e exige toolchain C em quem compila;
// o processo custa um IPC por decisão e roda em qualquer máquina que tenha o
// pacote Python instalado. Para a cascata os dois são a mesma coisa — é o que a
// asserção de interface no fim deste arquivo garante.
type SidecarClassifier struct {
	sidecar *needle.Sidecar
}

// NewSidecarClassifier monta o degrau a partir da linha de comando e JÁ SOBE o
// processo, porque carregar o modelo é a parte lenta e ela não pode acontecer
// no meio do primeiro turno de alguém.
//
// O erro volta para o log de subida dizer o motivo; o classificador devolvido é
// utilizável de qualquer forma, com `Ready()` falso.
func NewSidecarClassifier(ctx context.Context, command string) (*SidecarClassifier, error) {
	sidecar := needle.NewSidecar(command)
	if !sidecar.Configured() {
		return &SidecarClassifier{sidecar: sidecar}, nil
	}
	err := sidecar.Start(ctx)
	return &SidecarClassifier{sidecar: sidecar}, err
}

// Configured diz se alguém pediu este degrau.
func (s *SidecarClassifier) Configured() bool {
	return s != nil && s.sidecar.Configured()
}

func (s *SidecarClassifier) Ready() bool {
	return s != nil && s.sidecar.Ready()
}

func (s *SidecarClassifier) Intent(
	ctx context.Context,
	prompt string,
	candidates []specialist.Definition,
) (ClassifierVerdict, error) {
	if !s.Ready() {
		return ClassifierVerdict{}, needle.ErrUnavailable
	}
	verdict, err := s.sidecar.Classify(ctx, prompt, candidates)
	if err != nil {
		return ClassifierVerdict{}, err
	}
	return ClassifierVerdict{
		Specialist: verdict.Specialist,
		Confidence: verdict.Confidence,
		Why:        "roteador local (processo)",
	}, nil
}

func (s *SidecarClassifier) Close() error {
	if s != nil {
		s.sidecar.Close()
	}
	return nil
}

var _ IntentClassifier = (*SidecarClassifier)(nil)
