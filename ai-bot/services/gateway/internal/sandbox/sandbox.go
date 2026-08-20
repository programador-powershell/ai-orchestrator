// Package sandbox decide ONDE um comando roda.
//
// O produto anterior tinha este seletor no rodapé (Local, WSL, VPS, Nuvem) e
// aprendeu apanhando que ambiente não é enfeite: ele roteava SÓ o terminal, e
// então o agente compilava no servidor e lia os arquivos na estação — duas
// máquinas, uma conversa, e ninguém percebia. Aqui o ambiente é consultado no
// ponto de despacho da ferramenta de processo, não na aparência do rodapé.
//
// # Docker Sandboxes: dirigimos, não redistribuímos
//
// O quinto ambiente é o Docker Sandboxes (o comando `sbx`, de
// docker/sbx-releases). A licença dele é "Copyright © 2026 Docker Inc. All
// rights reserved" — software proprietário, sem permissão de redistribuição.
// Por isso NADA do Docker entra neste repositório: nem binário, nem instalador,
// nem arquivo do kit. Vendorizar seria redistribuir software proprietário sem
// licença, e um `.exe` de terceiro no nosso repo também fura a política de
// homologação de TI/SI da casa.
//
// O que fazemos é DIRIGIR o `sbx` que já está instalado na máquina de quem usa,
// como se faz com o `git` ou o `ffmpeg`: procuramos no PATH, e quando não está
// lá recusamos com uma frase que diz o que instalar. O que entra no repositório
// é NOSSO: o `.sbxenv.yaml` (a declaração do nosso sandbox) e este adaptador.
//
// # Por que Available devolve motivo
//
// Um ambiente indisponível não some da lista: aparece cinza com o porquê.
// Esconder a opção faz a pessoa procurar por ela e concluir que o app perdeu
// uma função; mostrar sem motivo faz ela clicar e receber erro sem saber o que
// fazer. "O Docker Sandboxes não está instalado — instale o Docker Desktop e o
// sbx" é acionável; a opção sumir, não.
package sandbox

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"sync"
	"time"

	"aibot/gateway/internal/protocol"
)

// Result é o que sobra de um comando: o que ele imprimiu e como terminou.
type Result struct {
	ExitCode int
	Stdout   string
	Stderr   string
	Elapsed  time.Duration
}

// Combined junta as duas saídas na ordem em que quem lê espera vê-las. O modelo
// recebe UM texto; separar stdout de stderr só interessa a quem programa contra
// o resultado.
func (r Result) Combined() string {
	switch {
	case r.Stderr == "":
		return r.Stdout
	case r.Stdout == "":
		return r.Stderr
	default:
		return r.Stdout + "\n" + r.Stderr
	}
}

// Runner é um ambiente de execução.
type Runner interface {
	// Run executa um comando único e devolve saída combinada (em Result, já
	// separada em Stdout/Stderr; ver Result.Combined).
	//
	// Sair com código diferente de zero NÃO é erro deste método: é resultado, e
	// volta em Result.ExitCode com a saída junto. Erro aqui é o ambiente ter
	// falhado — binário ausente, container que não subiu, contexto cancelado.
	// Confundir os dois faria "o teste reprovou" chegar ao modelo como "não
	// consegui rodar o teste", e ele tentaria de novo em vez de ler a falha.
	Run(ctx context.Context, workdir, command string) (Result, error)
	// Available diz se este ambiente está utilizável agora, e por que não.
	Available(ctx context.Context) (bool, string)
	ID() protocol.Environment
}

// ErrHostOnly diz que a execução pertence ao aplicativo nativo, não ao gateway.
var ErrHostOnly = errors.New("este ambiente executa no aplicativo nativo")

// ErrNoRunner diz que o ambiente pedido não existe neste gateway.
var ErrNoRunner = errors.New("ambiente de execução desconhecido")

// probeTimeout é quanto se espera pela sondagem de disponibilidade.
//
// Curto de propósito: ela roda no handshake do WebSocket, antes do primeiro
// quadro da janela. Um `sbx version` que trava porque o daemon do Docker está
// subindo não pode segurar a tela — melhor a opção aparecer indisponível por
// alguns segundos e acender depois.
const probeTimeout = 5 * time.Second

/* ------------------------- montagem de argumentos ------------------------ */

// sbxArgs monta a linha do `sbx`. É PURA e devolve ELEMENTOS SEPARADOS.
//
// Separados não é estilo: o comando vem do MODELO. Montar
// "exec --env-file "+path+" -- sh -c "+command numa string só devolveria o
// texto para um shell interpretar de novo, e um comando com aspas viraria
// injeção de argumento. Cada elemento do slice chega ao processo filho como um
// argv[i] intocado.
func sbxArgs(envFile, shell, command string) []string {
	args := make([]string, 0, 6)
	args = append(args, "exec")
	if envFile != "" {
		// O caminho vai em elemento próprio, depois da flag. `--env-file=<path>`
		// também funcionaria, mas um caminho com espaço (o normal no Windows:
		// "C:\Users\...\Meus Projetos") vira dois argumentos em qualquer camada
		// que decida reprocessar a string.
		args = append(args, "--env-file", envFile)
	}
	// O `--` fecha as flags do sbx: sem ele, um comando começando com `-` seria
	// lido como opção do próprio sbx.
	args = append(args, "--", shell, "-c", command)
	return args
}

// wslArgs monta a linha do `wsl.exe`. Mesma regra: elementos separados.
//
// `-lc` (login + command) e não só `-c` porque sem o perfil carregado o PATH do
// usuário não existe dentro da distribuição, e ferramenta instalada por gerenciador
// de versão (nvm, pyenv, rustup) some — o comando falha com "not found" numa
// máquina onde ele funciona quando a pessoa digita.
func wslArgs(command string) []string {
	return []string{"-e", "bash", "-lc", command}
}

/* -------------------------------- execução ------------------------------- */

// execFunc é o disparo de um processo. Fica atrás de um campo para o teste
// medir a MONTAGEM dos argumentos sem executar nada — não há docker nem wsl na
// máquina de quem roda os testes, e um teste que depende disso não é teste.
type execFunc func(ctx context.Context, dir, name string, args []string) (Result, error)

// lookupFunc procura o binário no PATH. Mesmo motivo do execFunc.
type lookupFunc func(name string) (string, error)

// runProcess executa e classifica o desfecho.
func runProcess(ctx context.Context, dir, name string, args []string) (Result, error) {
	started := time.Now()
	command := exec.CommandContext(ctx, name, args...)
	if dir != "" {
		command.Dir = dir
	}
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr

	err := command.Run()
	result := Result{
		Stdout:  strings.TrimRight(stdout.String(), "\r\n"),
		Stderr:  strings.TrimRight(stderr.String(), "\r\n"),
		Elapsed: time.Since(started),
	}

	var exitErr *exec.ExitError
	switch {
	case err == nil:
		return result, nil
	case errors.As(err, &exitErr):
		// O comando rodou e reprovou. Isso é resultado, não falha do ambiente.
		result.ExitCode = exitErr.ExitCode()
		return result, nil
	default:
		// Aqui o ambiente é que falhou (binário sumiu, contexto cancelado).
		result.ExitCode = -1
		return result, fmt.Errorf("executar %s: %w", name, err)
	}
}

// probe roda uma sondagem curta e devolve a saída.
func probe(ctx context.Context, run execFunc, name string, args []string) (Result, error) {
	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	return run(ctx, "", name, args)
}

/* ------------------------------ LocalRunner ------------------------------ */

// LocalRunner é a estação da pessoa — e NÃO executa nada aqui.
//
// É de propósito, e a razão é o isolamento: quem roda comando na estação é o
// aplicativo nativo em Rust, que coloca o processo num Job Object do Windows
// (matar o pai mata a árvore inteira, inclusive o que o comando abriu) e tem
// ConPTY para o terminal de verdade. Nada disso existe na biblioteca padrão do
// Go, e trazer `golang.org/x/sys` para cá poria uma dependência de terceiro
// justamente no processo que guarda as chaves e a conversa. Ver go.mod.
//
// Então `Run` devolve ErrHostOnly e o supervisor despacha `proc.run` ao host
// pelo mesmo `tool.call` de sempre.
type LocalRunner struct{}

// NewLocalRunner monta o ambiente local.
func NewLocalRunner() *LocalRunner { return &LocalRunner{} }

// ID identifica o ambiente.
func (l *LocalRunner) ID() protocol.Environment { return protocol.EnvLocal }

// Available: a estação está sempre lá. Se o aplicativo nativo não estiver
// conectado, quem diz isso é a ponte, na hora do despacho — e com o nome da
// ferramenta junto, que é o que ajuda a entender.
func (l *LocalRunner) Available(context.Context) (bool, string) { return true, "" }

// Run recusa: ver o comentário do tipo.
func (l *LocalRunner) Run(context.Context, string, string) (Result, error) {
	return Result{ExitCode: -1}, ErrHostOnly
}

/* ------------------------------ DockerRunner ----------------------------- */

// dockerMissing é a frase que a pessoa lê quando o `sbx` não está no PATH.
// Diz O QUE instalar, porque "indisponível" sozinho não resolve nada.
const dockerMissing = "o Docker Sandboxes não está instalado — instale o Docker Desktop e o sbx (docker/sbx-releases) para usar este ambiente"

// DockerRunner dirige o `sbx` instalado na máquina. Ver o cabeçalho do pacote
// para o porquê de nada do Docker entrar neste repositório.
type DockerRunner struct {
	// Binary é o comando a procurar no PATH. Vazio = "sbx".
	Binary string
	// EnvFile é o caminho do nosso `.sbxenv.yaml`. Vazio = o sbx usa o que
	// achar na pasta corrente, que é o comportamento dele.
	EnvFile string
	// Shell é o interpretador DENTRO do container. Vazio = "bash", que é o que
	// a imagem declarada no nosso .sbxenv.yaml garante.
	Shell string

	lookPath lookupFunc
	run      execFunc
}

// DockerOptions são os ajustes do ambiente Docker.
type DockerOptions struct {
	Binary  string
	EnvFile string
	Shell   string
}

// NewDockerRunner monta o ambiente Docker.
func NewDockerRunner(options DockerOptions) *DockerRunner {
	return &DockerRunner{
		Binary:   defaulted(options.Binary, "sbx"),
		EnvFile:  options.EnvFile,
		Shell:    defaulted(options.Shell, "bash"),
		lookPath: exec.LookPath,
		run:      runProcess,
	}
}

// ID identifica o ambiente.
func (d *DockerRunner) ID() protocol.Environment { return protocol.EnvDocker }

// Available procura o `sbx` e confere se ele responde.
//
// São duas checagens porque elas falham por motivos diferentes: o binário pode
// estar no PATH e mesmo assim não funcionar (Docker Desktop parado é o caso
// comum), e aí a frase certa não é "instale" — é o que o próprio sbx disse.
func (d *DockerRunner) Available(ctx context.Context) (bool, string) {
	if _, err := d.lookPath(d.Binary); err != nil {
		return false, dockerMissing
	}
	result, err := probe(ctx, d.run, d.Binary, []string{"version"})
	if err != nil {
		return false, fmt.Sprintf("o %s está instalado mas não respondeu: %v", d.Binary, err)
	}
	if result.ExitCode != 0 {
		detail := strings.TrimSpace(result.Combined())
		if detail == "" {
			detail = fmt.Sprintf("saiu com código %d", result.ExitCode)
		}
		return false, fmt.Sprintf("o Docker Sandboxes não está pronto — %s", firstLine(detail))
	}
	return true, ""
}

// Run executa dentro do sandbox.
func (d *DockerRunner) Run(ctx context.Context, workdir, command string) (Result, error) {
	if strings.TrimSpace(command) == "" {
		// Sem isto, `sbx exec -- bash -c ""` sobe um container para nada.
		return Result{ExitCode: -1}, errors.New("comando vazio")
	}
	// A conferência se repete aqui de propósito, mesmo quem chama tendo medido
	// antes (o registro mede, com cache): sem ela, um `sbx` que sumiu entre a
	// medição e o comando devolveria "executable file not found in %PATH%" ao
	// modelo, em vez da frase que diz o que instalar.
	if ok, detail := d.Available(ctx); !ok {
		return Result{ExitCode: -1}, errors.New(detail)
	}
	// O processo `sbx` roda A PARTIR da pasta do projeto: é ela que o
	// .sbxenv.yaml monta como workspace, e é dela que o sbx deduz o contexto
	// quando o caminho do arquivo é relativo.
	return d.run(ctx, workdir, d.Binary, sbxArgs(d.EnvFile, d.Shell, command))
}

/* -------------------------------- WSLRunner ------------------------------ */

const (
	wslMissing  = "o WSL não está instalado — habilite o Subsistema Linux do Windows para usar este ambiente"
	wslNoDistro = "o WSL está instalado mas não tem distribuição — rode `wsl --install` para usar este ambiente"
)

// WSLRunner dirige o `wsl.exe` da estação.
type WSLRunner struct {
	// Binary é o comando a procurar. Vazio = "wsl.exe".
	Binary string

	lookPath lookupFunc
	run      execFunc
}

// NewWSLRunner monta o ambiente WSL.
func NewWSLRunner() *WSLRunner {
	return &WSLRunner{Binary: "wsl.exe", lookPath: exec.LookPath, run: runProcess}
}

// ID identifica o ambiente.
func (w *WSLRunner) ID() protocol.Environment { return protocol.EnvWSL }

// Available procura o `wsl.exe` e confere se há distribuição instalada.
//
// As duas coisas são separadas no Windows 11: o `wsl.exe` vem no System32 de
// fábrica, então "achei o binário" NÃO quer dizer "dá para rodar Linux". Sem a
// segunda checagem, o ambiente apareceria disponível numa máquina sem nenhuma
// distribuição e todo comando morreria com um erro do wsl que ninguém entende.
func (w *WSLRunner) Available(ctx context.Context) (bool, string) {
	if _, err := w.lookPath(w.Binary); err != nil {
		return false, wslMissing
	}
	result, err := probe(ctx, w.run, w.Binary, []string{"-l", "-q"})
	if err != nil {
		return false, fmt.Sprintf("o WSL não respondeu: %v", err)
	}
	if result.ExitCode != 0 || decodeWSL(result.Combined()) == "" {
		return false, wslNoDistro
	}
	return true, ""
}

// Run executa dentro da distribuição padrão.
func (w *WSLRunner) Run(ctx context.Context, workdir, command string) (Result, error) {
	if strings.TrimSpace(command) == "" {
		return Result{ExitCode: -1}, errors.New("comando vazio")
	}
	if ok, detail := w.Available(ctx); !ok {
		return Result{ExitCode: -1}, errors.New(detail)
	}
	// A pasta do projeto vai como diretório do processo `wsl.exe`: ele traduz o
	// caminho do Windows para /mnt/… sozinho, o que é melhor do que a gente
	// montar a tradução na mão e errar em disco de rede.
	return w.run(ctx, workdir, w.Binary, wslArgs(command))
}

// decodeWSL limpa a saída do `wsl.exe -l -q`.
//
// Ela sai em UTF-16LE, então cada caractere ASCII vem seguido de um byte zero;
// lida como UTF-8, a string parece cheia de NUL e um teste de "está vazia?"
// erra. Tirar os zeros é suficiente para o que se pergunta aqui — existe alguma
// distribuição? — sem trazer um decodificador inteiro para responder sim ou não.
func decodeWSL(raw string) string {
	cleaned := strings.Map(func(symbol rune) rune {
		if symbol == 0 || symbol == '\uFEFF' {
			return -1
		}
		return symbol
	}, raw)
	return strings.TrimSpace(cleaned)
}

/* ------------------------------ nuvem: honesta ---------------------------- */

// notImplemented é a frase dos ambientes que ainda não têm executor.
//
// Eles CONTINUAM na lista, cinza, com este motivo. O produto anterior prometia
// os quatro no rodapé e roteava só o VPS; sumir com a opção teria sido pior,
// porque quem leu a promessa procura por ela. O honesto é aparecer e dizer.
// (O VPS saiu daqui: ele tem executor de verdade em vps.go.)
const notImplemented = "ainda não tem executor próprio nesta versão"

// staticRunner é um ambiente declarado e não implementado.
type staticRunner struct {
	id     protocol.Environment
	detail string
}

func (s staticRunner) ID() protocol.Environment { return s.id }

func (s staticRunner) Available(context.Context) (bool, string) { return false, s.detail }

func (s staticRunner) Run(context.Context, string, string) (Result, error) {
	return Result{ExitCode: -1}, fmt.Errorf("%s: %s", s.id, s.detail)
}

// NewCloudRunner monta o ambiente de nuvem.
func NewCloudRunner() Runner { return staticRunner{id: protocol.EnvCloud, detail: notImplemented} }

/* -------------------------------- registro ------------------------------- */

// descriptor é o rótulo e a explicação de um ambiente na tela. Vivem aqui, e
// não no cliente, porque a lista de ambientes é do gateway: um cliente com a
// tabela própria mostraria um ambiente que este gateway não tem.
type descriptor struct {
	label string
	hint  string
}

var descriptors = map[protocol.Environment]descriptor{
	protocol.EnvLocal:  {label: "Local", hint: "No seu computador"},
	protocol.EnvDocker: {label: "Docker", hint: "Sandbox do Docker (sbx), isolado do seu disco"},
	protocol.EnvWSL:    {label: "WSL", hint: "Subsistema Linux no Windows"},
	protocol.EnvVPS:    {label: "VPS", hint: "Servidor configurado pela TI"},
	protocol.EnvCloud:  {label: "Nuvem", hint: "GitHub, GitLab, Gitea…"},
}

// availabilityTTL é por quanto tempo a sondagem vale.
//
// Existe porque `Describe` roda no handshake de CADA conexão, e sem cache toda
// janela aberta dispara dois processos filhos antes de pintar o primeiro
// quadro. Curto porque instalar o Docker Desktop e ver a opção continuar cinza
// por dez minutos parece defeito — meio minuto é o bastante para a rajada de
// reconexões e curto o bastante para ninguém notar a espera.
const availabilityTTL = 30 * time.Second

type availability struct {
	ok       bool
	detail   string
	measured time.Time
}

// Registry guarda os ambientes e qual deles está ativo em cada sessão.
//
// O ativo mora em MEMÓRIA, por sessão. Reiniciar o gateway devolve todas as
// sessões para o padrão (DefaultEnvironment — a VPS medida agora, ou local), e
// isso é escolha: o ambiente é a resposta a "onde este comando vai rodar?", e
// ressuscitá-la de um arquivo depois de uma queda faria o primeiro comando
// depois do reinício rodar num lugar que ninguém reafirmou. O padrão é
// remedido a cada consulta justamente para refletir a máquina de AGORA.
type Registry struct {
	mu      sync.RWMutex
	order   []protocol.Environment
	runners map[protocol.Environment]Runner
	active  map[string]protocol.Environment
	cache   map[protocol.Environment]availability
	// now é o relógio, injetável para o teste do cache não depender de sleep.
	now func() time.Time
}

// NewRegistry monta o registro na ORDEM em que os ambientes serão mostrados.
func NewRegistry(runners ...Runner) *Registry {
	registry := &Registry{
		runners: make(map[protocol.Environment]Runner, len(runners)),
		active:  make(map[string]protocol.Environment),
		cache:   make(map[protocol.Environment]availability),
		now:     time.Now,
	}
	for _, runner := range runners {
		if runner == nil {
			continue
		}
		id := runner.ID()
		if _, seen := registry.runners[id]; seen {
			continue
		}
		registry.runners[id] = runner
		registry.order = append(registry.order, id)
	}
	return registry
}

// Default é o piso: o ambiente de quem nunca escolheu quando NADA melhor está
// configurado. O padrão de verdade do gateway é DefaultEnvironment, que
// promove a VPS quando a TI a configurou e ela responde.
func Default() protocol.Environment { return protocol.EnvLocal }

// DefaultEnvironment é onde nasce a sessão que nunca escolheu ambiente.
//
// O padrão do produto é a VPS da TI QUANDO ela existe: é a máquina
// preparada para o trabalho (com o ai-jail confinando cada comando), e o
// local volta a ser o que sempre foi — a exceção explícita, não o lugar onde
// tudo cai por omissão.
//
// As duas condições são inegociáveis e a sondagem cobre ambas: uma VPS não
// configurada mede indisponível na hora (sem processo filho), e uma
// configurada só passa se o servidor responder E a fingerprint bater (ver
// VPSRunner.Available). Promover uma VPS fora do ar faria todo comando de
// sessão nova falhar; promover uma sem conferência mandaria o primeiro
// comando para quem quer que responda pelo DNS. O custo da medição é contido
// pelo cache curto de Availability.
func (r *Registry) DefaultEnvironment(ctx context.Context) protocol.Environment {
	if ok, _ := r.Availability(ctx, protocol.EnvVPS); ok {
		return protocol.EnvVPS
	}
	return Default()
}

// Runner devolve o executor de um ambiente.
func (r *Registry) Runner(id protocol.Environment) (Runner, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	runner, ok := r.runners[id]
	return runner, ok
}

// Active devolve o ambiente da sessão. Sessão sem escolha nasce no padrão do
// gateway (DefaultEnvironment): VPS quando a TI a configurou e ela responde,
// local no resto. O ctx existe por causa dessa sondagem — que sai FORA da
// trava e com cache, então o caminho comum é uma leitura de mapa.
func (r *Registry) Active(ctx context.Context, sessionID string) protocol.Environment {
	r.mu.RLock()
	chosen, ok := r.active[sessionID]
	r.mu.RUnlock()
	if ok {
		return chosen
	}
	return r.DefaultEnvironment(ctx)
}

// Chosen devolve a escolha EXPLÍCITA da sessão, se houver.
//
// Existe separado de Active porque a preferência do proc.run precisa
// distinguir "a pessoa fixou Local no rodapé" (que manda sempre) de "ninguém
// escolheu nada" (que abre espaço para o sandbox virar o padrão do turno de
// trabalho) — e Active esconde essa diferença de propósito, devolvendo sempre
// um ambiente utilizável.
func (r *Registry) Chosen(sessionID string) (protocol.Environment, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	chosen, ok := r.active[sessionID]
	return chosen, ok
}

// Set troca o ambiente ativo da sessão.
//
// NÃO confere disponibilidade de propósito: medir custa processo filho e exige
// contexto, e quem chama (a rota HTTP) já precisa do motivo em texto para
// devolver à pessoa. Aqui só se recusa o que não existe — o que não existe é
// erro de programa, não circunstância da máquina.
func (r *Registry) Set(sessionID string, id protocol.Environment) error {
	if sessionID == "" {
		return errors.New("sessão vazia")
	}
	if !id.Valid() {
		return fmt.Errorf("%w: %q", ErrNoRunner, id)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.runners[id]; !ok {
		return fmt.Errorf("%w: %q", ErrNoRunner, id)
	}
	r.active[sessionID] = id
	return nil
}

// Forget descarta o ambiente de uma sessão apagada, para o mapa não crescer
// para sempre com id de conversa que já não existe.
func (r *Registry) Forget(sessionID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.active, sessionID)
}

// Availability mede (com cache curto) se um ambiente pode ser usado agora.
func (r *Registry) Availability(ctx context.Context, id protocol.Environment) (bool, string) {
	runner, ok := r.Runner(id)
	if !ok {
		return false, "este gateway não conhece esse ambiente"
	}

	r.mu.RLock()
	cached, hit := r.cache[id]
	clock := r.now
	r.mu.RUnlock()
	if hit && clock().Sub(cached.measured) < availabilityTTL {
		return cached.ok, cached.detail
	}

	// A sondagem roda FORA da trava: ela dispara processo filho e pode levar
	// segundos. Segurar o mutex aqui prenderia toda leitura de ambiente do
	// gateway atrás de um `sbx version` que travou.
	ok, detail := runner.Available(ctx)

	r.mu.Lock()
	r.cache[id] = availability{ok: ok, detail: detail, measured: clock()}
	r.mu.Unlock()
	return ok, detail
}

// Describe monta o catálogo com a disponibilidade já medida — é o que vai no
// `ready` para a tela não oferecer opção que não funciona.
func (r *Registry) Describe(ctx context.Context) []protocol.EnvironmentInfo {
	r.mu.RLock()
	order := append([]protocol.Environment(nil), r.order...)
	r.mu.RUnlock()

	out := make([]protocol.EnvironmentInfo, 0, len(order))
	for _, id := range order {
		ok, detail := r.Availability(ctx, id)
		described := descriptors[id]
		out = append(out, protocol.EnvironmentInfo{
			ID:        id,
			Label:     defaulted(described.label, string(id)),
			Hint:      described.hint,
			Available: ok,
			Detail:    detail,
		})
	}
	return out
}

/* --------------------------------- apoio --------------------------------- */

func defaulted(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

// firstLine encurta a explicação de uma ferramenta para caber num rótulo. O
// resto continua no log de quem for investigar.
func firstLine(text string) string {
	if index := strings.IndexAny(text, "\r\n"); index >= 0 {
		return strings.TrimSpace(text[:index])
	}
	return text
}
