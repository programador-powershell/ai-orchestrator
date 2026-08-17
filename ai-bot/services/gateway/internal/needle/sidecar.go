// O degrau local por PROCESSO SEPARADO, em vez de cgo.
//
// A rota nativa (needle_shim.c) esbarrou em duas paredes que não são técnicas:
// o motor C fica num projeto à parte, com licença própria, e ligar a tag de
// build exige toolchain C em toda máquina que compila o gateway. O caminho por
// Python contorna as duas — `pip install cactus-needle` e `needle fetch` trazem
// um binário único com modelo, tokenizer e engine selados dentro — ao custo de
// um processo a mais.
//
// Três propriedades seguram este arquivo de pé, e as três existem porque o
// degrau local é OPCIONAL: ele acelera o primeiro input, e nunca pode ser o
// motivo de a conversa não andar.
//
//  1. NADA aqui derruba o roteamento. Sidecar que não sobe, que morre no meio,
//     que responde lixo ou que demora demais faz `Ready()` virar falso e a
//     cascata seguir para o modelo grande — o mesmo caminho de quem nunca
//     configurou o sidecar.
//
//  2. A resposta é CONFERIDA contra os candidatos. O processo é de terceiro e
//     fala por texto; aceitar o id que ele mandar sem conferir deixaria um
//     especialista fora da política atender a conversa.
//
//  3. Uma pergunta por vez. O modelo é uma sessão só do outro lado, e duas
//     perguntas concorrentes na mesma stdin embaralhariam as respostas — o pior
//     tipo de defeito, porque devolve a resposta da pergunta do vizinho.
package needle

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"aibot/gateway/internal/specialist"
)

// EnvSidecarCommand é o comando do sidecar, com argumentos separados por
// espaço. Vazio = degrau local desligado.
const EnvSidecarCommand = "AIBOT_NEEDLE_CMD"

const (
	// handshakeTimeout é quanto se espera pelo "pronto" do sidecar. Carregar o
	// modelo é a parte lenta e acontece UMA vez; depois disso as respostas são
	// de milissegundos.
	handshakeTimeout = 30 * time.Second

	// requestTimeout é o teto de UMA classificação. Curto de propósito: o degrau
	// existe para ser mais barato que a rede, e um sidecar que demora mais que
	// isso perdeu a razão de existir — melhor cair para o modelo grande.
	requestTimeout = 3 * time.Second
)

// sidecarRequest é o que vai para o processo, uma linha por pergunta.
type sidecarRequest struct {
	Prompt string `json:"prompt"`
	// Candidates são os ids que o sidecar PODE devolver. Vão junto porque o
	// shortlist muda por política e por conversa — mandar o catálogo inteiro
	// deixaria o modelo escolher quem a sessão não liberou.
	Candidates []string `json:"candidates"`
}

// sidecarResponse é a linha de volta.
type sidecarResponse struct {
	Specialist string  `json:"specialist"`
	Confidence float64 `json:"confidence"`
	Why        string  `json:"why"`
	// Error preenchido é o sidecar dizendo que não conseguiu — vale como "pule
	// o degrau", não como falha do turno.
	Error string `json:"error,omitempty"`
}

// Sidecar conversa com o processo do modelo local.
type Sidecar struct {
	command []string
	// env sobrepõe o ambiente do processo filho. Nil = herda o do gateway, que
	// é o caso de produção; o teste usa este campo para reexecutar o próprio
	// binário como sidecar de mentira.
	env []string

	mu      sync.Mutex
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	stdout  *bufio.Reader
	ready   bool
	lastErr error
}

// NewSidecar monta o cliente a partir da linha de comando. Comando vazio
// devolve um sidecar DESLIGADO — `Ready()` falso e nada é executado.
func NewSidecar(command string) *Sidecar {
	fields := strings.Fields(strings.TrimSpace(command))
	return &Sidecar{command: fields}
}

// Configured diz se alguém pediu o degrau local. Distinto de `Ready`: sem
// configuração não há o que reportar; configurado e não pronto é problema, e o
// log de subida precisa separar os dois.
func (s *Sidecar) Configured() bool { return s != nil && len(s.command) > 0 }

// Ready diz se o processo está de pé e respondeu ao aperto de mão.
func (s *Sidecar) Ready() bool {
	if !s.Configured() {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ready
}

// LastError é o motivo de o degrau estar fora, para o log de subida.
func (s *Sidecar) LastError() error {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastErr
}

// Start sobe o processo e espera o aperto de mão.
//
// Devolve erro para o chamador PODER registrar o motivo, mas o erro não é
// fatal: quem chama segue sem o degrau.
func (s *Sidecar) Start(ctx context.Context) error {
	if !s.Configured() {
		return errors.New("degrau local desligado: " + EnvSidecarCommand + " não definido")
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ready {
		return nil
	}

	// Contexto PRÓPRIO, e não o do chamador: o sidecar vive enquanto o gateway
	// viver, e amarrá-lo ao contexto de uma subida (que é cancelado quando o
	// boot termina) mataria o processo assim que ele ficasse pronto.
	cmd := exec.Command(s.command[0], s.command[1:]...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		s.lastErr = fmt.Errorf("stdin do sidecar: %w", err)
		return s.lastErr
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		s.lastErr = fmt.Errorf("stdout do sidecar: %w", err)
		return s.lastErr
	}
	// stderr vai para o do gateway: traceback de Python precisa APARECER. Num
	// pipe que ninguém lê, o sidecar morreria mudo — e o log diria só "o
	// sidecar morreu", que é a metade inútil da informação.
	cmd.Stderr = os.Stderr
	if s.env != nil {
		cmd.Env = s.env
	}

	if err := cmd.Start(); err != nil {
		s.lastErr = fmt.Errorf("subir o sidecar %q: %w", s.command[0], err)
		return s.lastErr
	}

	reader := bufio.NewReader(stdout)
	// Aperto de mão: a primeira linha diz que o modelo carregou.
	line, err := readLineWithin(ctx, reader, handshakeTimeout)
	if err != nil {
		_ = cmd.Process.Kill()
		s.lastErr = fmt.Errorf("aperto de mão do sidecar: %w", err)
		return s.lastErr
	}
	var hello sidecarResponse
	if err := json.Unmarshal([]byte(line), &hello); err != nil {
		_ = cmd.Process.Kill()
		s.lastErr = fmt.Errorf("aperto de mão ilegível (%q): %w", truncateLine(line), err)
		return s.lastErr
	}
	if hello.Error != "" {
		_ = cmd.Process.Kill()
		s.lastErr = errors.New("o sidecar recusou subir: " + hello.Error)
		return s.lastErr
	}

	s.cmd, s.stdin, s.stdout = cmd, stdin, reader
	s.ready = true
	s.lastErr = nil
	return nil
}

// Close encerra o processo.
func (s *Sidecar) Close() {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.shutdownLocked(nil)
}

// shutdownLocked derruba o processo e marca o degrau como fora. `cause`
// preenchido vira o motivo no log.
func (s *Sidecar) shutdownLocked(cause error) {
	if s.stdin != nil {
		_ = s.stdin.Close()
	}
	if s.cmd != nil && s.cmd.Process != nil {
		_ = s.cmd.Process.Kill()
		_ = s.cmd.Wait()
	}
	s.cmd, s.stdin, s.stdout, s.ready = nil, nil, nil, false
	if cause != nil {
		s.lastErr = cause
	}
}

// Classify decide o dono do primeiro input.
//
// Assinatura IDÊNTICA à de Session.Classify de propósito: para a cascata existe
// um degrau local, e trocar cgo por processo separado não pode vazar para ela.
// O contrato é sempre o mesmo — devolver um veredito, ou um erro que faz a
// cascata seguir para o modelo grande. Nunca bloquear além do teto.
func (s *Sidecar) Classify(
	ctx context.Context,
	prompt string,
	candidates []specialist.Definition,
) (Verdict, error) {
	ids := make([]string, 0, len(candidates))
	allowed := make(map[string]bool, len(candidates))
	for _, candidate := range candidates {
		ids = append(ids, candidate.ID)
		allowed[candidate.ID] = true
	}
	if len(ids) == 0 {
		return Verdict{}, errors.New("sem candidatos para o degrau local")
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.ready {
		return Verdict{}, errors.New("o degrau local não está pronto")
	}

	payload, err := json.Marshal(sidecarRequest{Prompt: prompt, Candidates: ids})
	if err != nil {
		return Verdict{}, err
	}
	if _, err := s.stdin.Write(append(payload, '\n')); err != nil {
		// Escrever num processo morto é o sintoma mais comum de crash do outro
		// lado; derruba tudo para a próxima subida ser limpa.
		s.shutdownLocked(fmt.Errorf("o sidecar morreu: %w", err))
		return Verdict{}, s.lastErr
	}

	line, err := readLineWithin(ctx, s.stdout, requestTimeout)
	if err != nil {
		s.shutdownLocked(fmt.Errorf("sem resposta do sidecar: %w", err))
		return Verdict{}, s.lastErr
	}

	var response sidecarResponse
	if err := json.Unmarshal([]byte(line), &response); err != nil {
		// Linha ilegível NÃO derruba o processo: pode ser um `print` perdido do
		// script. O turno segue pelo modelo grande e o sidecar continua de pé.
		return Verdict{}, fmt.Errorf("resposta ilegível do sidecar (%q): %w", truncateLine(line), err)
	}
	if response.Error != "" {
		return Verdict{}, errors.New(response.Error)
	}
	// A CONFERÊNCIA. O sidecar é processo de terceiro: um id fora da lista seria
	// um especialista que a política desta sessão não liberou atendendo a
	// conversa.
	if !allowed[response.Specialist] {
		return Verdict{}, fmt.Errorf("o sidecar devolveu %q, que não está entre os candidatos",
			truncateLine(response.Specialist))
	}
	if response.Confidence < 0 || response.Confidence > 1 {
		return Verdict{}, fmt.Errorf("confiança fora de [0,1]: %v", response.Confidence)
	}

	return Verdict{Specialist: response.Specialist, Confidence: response.Confidence}, nil
}

// readLineWithin lê uma linha com prazo, sem deixar goroutine pendurada quando
// o prazo estoura: a leitura fica presa no pipe até o processo morrer, e é o
// `shutdownLocked` de quem chama que a solta.
func readLineWithin(ctx context.Context, reader *bufio.Reader, limit time.Duration) (string, error) {
	type result struct {
		line string
		err  error
	}
	done := make(chan result, 1)
	go func() {
		line, err := reader.ReadString('\n')
		done <- result{line: strings.TrimSpace(line), err: err}
	}()

	timer := time.NewTimer(limit)
	defer timer.Stop()

	select {
	case out := <-done:
		if out.err != nil && out.line == "" {
			return "", out.err
		}
		return out.line, nil
	case <-timer.C:
		return "", fmt.Errorf("prazo de %s estourado", limit)
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

func truncateLine(line string) string {
	const limit = 120
	if len(line) <= limit {
		return line
	}
	return line[:limit] + "…"
}
