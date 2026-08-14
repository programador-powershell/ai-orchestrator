// Package worktree dá a cada agente que escreve uma cópia de verdade do git.
//
// O modo de falha que este pacote existe para impedir: dois agentes editando o
// mesmo diretório em paralelo se sobrescrevem SEM AVISO, e o resultado parece
// plausível — compila, passa no teste, e metade do trabalho de um dos dois
// sumiu. Diferente do erro que estoura, esse só aparece dias depois, quando
// alguém procura a função que "tinha sido feita". Por isso toda tarefa marcada
// com Worktree=true (protocol.Task) ganha um `git worktree` próprio, com branch
// próprio: o encontro dos trabalhos vira decisão explícita, com diff na mão.
//
// A ideia foi levantada do Orca (MIT), em clean-room — nada de código copiado,
// só o formato da solução. Ver docs/creditos-inspiracao.md.
//
// Por que chamar o binário `git` com os/exec em vez de uma biblioteca: não
// existe git na biblioteca padrão do Go, e trazer go-git seria dependência de
// terceiro dentro do processo que mexe no repositório da pessoa (item 4 da
// política de TI/SI). Além disso o git do sistema é o git DA ESTAÇÃO: já herda
// o gitconfig, o credential helper corporativo, os hooks e o que a TI
// configurou. Uma biblioteca reimplementaria tudo isso — e erraria calada nas
// bordas que custam caro (safe.directory, longpaths, autocrlf, submódulo).
//
// Regra que vale para todo comando daqui: argumento é ELEMENTO de slice, nunca
// pedaço de string concatenada. Uma mensagem de commit escrita pelo modelo, com
// aspas dentro, viraria injeção de argumento no primeiro `sh -c` — aqui não há
// shell nenhum no caminho.
package worktree

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// BranchPrefix marca as branches criadas por este pacote. Prefixo existe para
// que `git branch` continue legível depois de vinte tarefas e para que apagar o
// que é nosso nunca esbarre no que é da pessoa.
const BranchPrefix = "aibot/"

// MaxIDLen é o teto do id. O id vira nome de diretório e nome de ref; caminho
// de worktree longo no Windows estoura o limite de 260 caracteres antes de o
// git conseguir explicar o que houve.
const MaxIDLen = 64

// DefaultTimeout é o teto sugerido para cada comando, aplicado por QUEM CHAMA:
//
//	ctx, cancel := context.WithTimeout(parent, worktree.DefaultTimeout)
//
// Não é imposto aqui dentro de propósito. Quem chama é quem sabe se o comando é
// um `diff` de um arquivo ou um `worktree add` de repositório de 2 GB, e é quem
// segura o cancelamento do turno; um prazo escondido no Manager faria o mesmo
// comando falhar em máquina lenta sem ninguém entender por quê.
const DefaultTimeout = 120 * time.Second

// waitDelay é a folga para o git soltar os canos depois de morto por
// cancelamento. Sem isso, um neto de processo que herdou a saída padrão pode
// segurar o Wait para sempre, e o timeout do contexto não teria servido de nada.
const waitDelay = 10 * time.Second

// ErrNotFound diz que não existe worktree com esse id sob a raiz configurada.
var ErrNotFound = errors.New("worktree não encontrada")

// Manager é o dono das cópias: um repositório de origem e a pasta onde as
// cópias moram.
type Manager struct {
	repoRoot     string
	worktreeRoot string

	// sem serializa as operações que mexem no repositório PRINCIPAL (criar,
	// remover, podar). Dois agentes criando worktree no mesmo instante brigam
	// pelo index.lock do repositório e um dos dois recebe um erro de trava que
	// não tem nada a ver com o trabalho dele.
	//
	// É canal e não sync.Mutex porque a espera precisa respeitar o contexto:
	// mutex não tem como ser cancelado, e um agente cancelado ficaria preso
	// atrás de um clone lento até o fim dele.
	sem chan struct{}
}

// Worktree é uma cópia isolada e o que se sabe sobre ela.
type Worktree struct {
	ID   string `json:"id"`
	Path string `json:"path"`
	// Branch é o nome completo, já com o prefixo (ex.: "aibot/task-3").
	Branch string `json:"branch"`
	// Base é de onde a cópia saiu. Em Create é a ref pedida ("HEAD" quando
	// vazia); em List é o commit em que a cópia está AGORA, porque o git não
	// guarda em lugar nenhum de onde a worktree nasceu.
	Base string `json:"base"`
	// CreatedAt vem do relógio em Create. Em List é aproximado pela data do
	// arquivo .git de dentro da cópia — ele é escrito uma vez, no add — e fica
	// zerado quando não dá para ler, o que é mais honesto que inventar agora.
	CreatedAt time.Time `json:"createdAt"`
}

// NewManager valida o par de raízes e prepara o gerente.
//
// Vale manter worktreeRoot FORA de repoRoot: cópia dentro do repositório
// aparece como um monte de arquivo não rastreado no diretório principal, e o
// primeiro `git add -A` do usuário levaria as cópias junto para o commit.
func NewManager(repoRoot, worktreeRoot string) (*Manager, error) {
	if strings.TrimSpace(repoRoot) == "" {
		return nil, errors.New("raiz do repositório vazia")
	}
	if strings.TrimSpace(worktreeRoot) == "" {
		return nil, errors.New("raiz das worktrees vazia")
	}
	absRepo, err := filepath.Abs(repoRoot)
	if err != nil {
		return nil, fmt.Errorf("resolver raiz do repositório: %w", err)
	}
	absWorktrees, err := filepath.Abs(worktreeRoot)
	if err != nil {
		return nil, fmt.Errorf("resolver raiz das worktrees: %w", err)
	}

	// Sem esta checagem, "não é um repositório git" e "git não está instalado"
	// chegariam na tela com a mesma cara, e o usuário iria procurar o problema
	// no lugar errado.
	if _, err := exec.LookPath("git"); err != nil {
		return nil, fmt.Errorf("git não encontrado no PATH: %w", err)
	}

	// NewManager não recebe contexto (é construtor), então usa o prazo padrão.
	ctx, cancel := context.WithTimeout(context.Background(), DefaultTimeout)
	defer cancel()
	if _, err := runGit(ctx, absRepo, "rev-parse", "--git-dir"); err != nil {
		return nil, fmt.Errorf("raiz %s não é um repositório git: %w", absRepo, err)
	}

	if err := os.MkdirAll(absWorktrees, 0o755); err != nil {
		return nil, fmt.Errorf("criar raiz das worktrees: %w", err)
	}

	return &Manager{
		repoRoot:     absRepo,
		worktreeRoot: absWorktrees,
		sem:          make(chan struct{}, 1),
	}, nil
}

// Create abre uma cópia nova em <worktreeRoot>/<id>, na branch aibot/<id>.
// baseRef vazio significa HEAD.
func (m *Manager) Create(ctx context.Context, id, baseRef string) (Worktree, error) {
	path, branch, err := m.resolve(id)
	if err != nil {
		return Worktree{}, err
	}
	base := strings.TrimSpace(baseRef)
	if base == "" {
		base = "HEAD"
	}
	// Ref começando com hífen seria lida pelo git como opção, mesmo vindo em
	// elemento separado do slice — "--detach" no lugar de um nome de branch
	// mudaria o significado do comando inteiro.
	if strings.HasPrefix(base, "-") {
		return Worktree{}, fmt.Errorf("ref base inválida %q: não pode começar com '-'", base)
	}

	release, err := m.acquire(ctx)
	if err != nil {
		return Worktree{}, err
	}
	defer release()

	if _, err := runGit(ctx, m.repoRoot, "worktree", "add", "-b", branch, path, base); err != nil {
		return Worktree{}, fmt.Errorf("criar worktree %s: %w", id, err)
	}

	return Worktree{
		ID:        filepath.Base(path),
		Path:      path,
		Branch:    branch,
		Base:      base,
		CreatedAt: time.Now(),
	}, nil
}

// List devolve SÓ as cópias que estão sob worktreeRoot. O diretório principal e
// worktrees que a pessoa criou na mão aparecem na saída do git e são
// descartadas aqui: não são nossas para remover.
func (m *Manager) List(ctx context.Context) ([]Worktree, error) {
	out, err := runGit(ctx, m.repoRoot, "worktree", "list", "--porcelain")
	if err != nil {
		return nil, fmt.Errorf("listar worktrees: %w", err)
	}

	// O formato --porcelain é um bloco por worktree, blocos separados por linha
	// em branco, cada linha "chave valor" (a chave sozinha quando é sinalizador,
	// como "detached" e "bare").
	var (
		found   []Worktree
		current Worktree
	)
	flush := func() {
		if current.Path != "" {
			if id, ok := relUnder(m.worktreeRoot, current.Path); ok {
				current.ID = id
				current.CreatedAt = birth(current.Path)
				found = append(found, current)
			}
		}
		current = Worktree{}
	}

	for _, raw := range strings.Split(out, "\n") {
		line := strings.TrimRight(raw, "\r")
		if line == "" {
			flush()
			continue
		}
		key, value := line, ""
		if i := strings.IndexByte(line, ' '); i >= 0 {
			key, value = line[:i], line[i+1:]
		}
		switch key {
		case "worktree":
			flush()
			current.Path = filepath.Clean(value)
		case "HEAD":
			current.Base = value
		case "branch":
			current.Branch = strings.TrimPrefix(value, "refs/heads/")
		case "detached":
			current.Branch = ""
		}
	}
	flush()

	return found, nil
}

// Diff mostra o que o agente mudou na cópia, em relação ao último commit dela.
//
// Atenção de quem revisa: `diff HEAD` NÃO mostra arquivo novo ainda não
// rastreado. Um agente que só criou arquivos aparece aqui como diff vazio — e o
// Commit, que faz `add -A`, levaria tudo. Quando o portão de revisão precisar
// enxergar arquivo novo, o caminho é commitar antes e revisar o commit.
func (m *Manager) Diff(ctx context.Context, id string) (string, error) {
	path, _, err := m.resolve(id)
	if err != nil {
		return "", err
	}
	if err := ensureExists(path, id); err != nil {
		return "", err
	}
	out, err := runGit(ctx, path, "diff", "HEAD")
	if err != nil {
		return "", fmt.Errorf("diff da worktree %s: %w", id, err)
	}
	return out, nil
}

// Commit grava tudo o que está na cópia e devolve o hash curto.
//
// Nada para commitar devolve ("", nil) de propósito: um agente que só leu
// arquivos terminou bem, e transformar isso em erro faria o orquestrador
// marcar a tarefa como falha e reexecutar trabalho que já estava certo.
func (m *Manager) Commit(ctx context.Context, id, message string) (string, error) {
	path, _, err := m.resolve(id)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(message) == "" {
		return "", errors.New("mensagem de commit vazia")
	}
	if err := ensureExists(path, id); err != nil {
		return "", err
	}

	if _, err := runGit(ctx, path, "add", "-A"); err != nil {
		return "", fmt.Errorf("preparar commit da worktree %s: %w", id, err)
	}

	// Depois do `add -A`, saída vazia do status significa que a cópia está igual
	// ao HEAD. Perguntar antes é melhor que chamar `git commit` e ter de
	// adivinhar, pelo texto do erro, se o código de saída 1 foi "nada a fazer"
	// ou falha de verdade (hook recusando, identidade não configurada).
	status, err := runGit(ctx, path, "status", "--porcelain")
	if err != nil {
		return "", fmt.Errorf("checar estado da worktree %s: %w", id, err)
	}
	if strings.TrimSpace(status) == "" {
		return "", nil
	}

	// A mensagem vai como valor de -m, em elemento próprio do slice: aspas,
	// quebra de linha e ponto-e-vírgula dentro dela são texto, não comando.
	if _, err := runGit(ctx, path, "commit", "-m", message); err != nil {
		return "", fmt.Errorf("commitar worktree %s: %w", id, err)
	}

	hash, err := runGit(ctx, path, "rev-parse", "--short", "HEAD")
	if err != nil {
		return "", fmt.Errorf("ler hash do commit da worktree %s: %w", id, err)
	}
	return strings.TrimSpace(hash), nil
}

// Remove apaga a cópia e, em seguida, a branch dela.
//
// Sem force, o git recusa remover cópia com alteração não commitada — e essa
// recusa é a proteção principal contra perder trabalho de agente por engano.
func (m *Manager) Remove(ctx context.Context, id string, force bool) error {
	path, branch, err := m.resolve(id)
	if err != nil {
		return err
	}

	release, err := m.acquire(ctx)
	if err != nil {
		return err
	}
	defer release()

	args := []string{"worktree", "remove"}
	if force {
		args = append(args, "--force")
	}
	args = append(args, path)
	if _, err := runGit(ctx, m.repoRoot, args...); err != nil {
		return fmt.Errorf("remover worktree %s: %w", id, err)
	}

	// Erro aqui é ignorado de propósito: branch já apagada (ou já mesclada e
	// removida por quem integrou) deixa a limpeza no estado desejado. Falhar
	// depois de a cópia já ter sido removida só faria o chamador tentar de novo
	// um comando que não tem mais o que remover.
	_, _ = runGit(ctx, m.repoRoot, "branch", "-D", branch)
	return nil
}

// Prune limpa o registro de worktrees cujo diretório sumiu do disco — o que
// acontece toda vez que alguém apaga a pasta na mão. Enquanto o registro fica,
// o git recusa criar outra cópia no mesmo caminho.
func (m *Manager) Prune(ctx context.Context) error {
	release, err := m.acquire(ctx)
	if err != nil {
		return err
	}
	defer release()

	if _, err := runGit(ctx, m.repoRoot, "worktree", "prune"); err != nil {
		return fmt.Errorf("podar worktrees: %w", err)
	}
	return nil
}

// acquire pega a vez de mexer no repositório principal, ou desiste se o
// contexto acabar. Devolve a função que solta a vez.
func (m *Manager) acquire(ctx context.Context) (func(), error) {
	// Manager montado sem NewManager (um Manager{} num teste, por exemplo) tem
	// o canal nil, e mandar para canal nil trava PARA SEMPRE. Perder a
	// serialização é ruim; travar o gateway sem erro e sem log é pior.
	if m.sem == nil {
		return func() {}, nil
	}
	select {
	case m.sem <- struct{}{}:
		return func() { <-m.sem }, nil
	case <-ctx.Done():
		return nil, fmt.Errorf("esperar a vez no repositório: %w", ctx.Err())
	}
}

// resolve traduz o id em caminho e nome de branch, passando pela sanitização.
func (m *Manager) resolve(id string) (string, string, error) {
	clean, err := sanitizeID(id)
	if err != nil {
		return "", "", err
	}
	return filepath.Join(m.worktreeRoot, clean), BranchPrefix + clean, nil
}

// sanitizeID recusa o que não for [a-zA-Z0-9-_] até 64 caracteres.
//
// O id chega do modelo e vira DUAS coisas perigosas: um caminho de diretório e
// um nome de ref. Um id "../.." escreveria fora da raiz das worktrees — em
// cima do repositório, no melhor caso. Por isso recusa em vez de filtrar: se
// "../a" virasse "a" calado, dois ids diferentes passariam a apontar para a
// mesma cópia, e o segundo agente escreveria por cima do primeiro, que é
// exatamente o acidente que este pacote existe para impedir.
func sanitizeID(id string) (string, error) {
	if id == "" {
		return "", errors.New("id da worktree vazio")
	}
	if len(id) > MaxIDLen {
		return "", fmt.Errorf("id da worktree tem %d caracteres, máximo %d", len(id), MaxIDLen)
	}
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
		default:
			return "", fmt.Errorf("id da worktree %q tem caractere inválido %q: use só letras sem acento, números, '-' e '_'", id, r)
		}
	}
	// Hífen na frente seria lido como opção pelo git no nome da branch e
	// atrapalha qualquer comando que receba o id de volta.
	if id[0] == '-' {
		return "", fmt.Errorf("id da worktree %q não pode começar com '-'", id)
	}
	return id, nil
}

// ensureExists distingue "worktree não existe" de "o git falhou", porque as
// duas coisas pedem reação diferente de quem chamou.
func ensureExists(path, id string) error {
	info, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("%w: %s", ErrNotFound, id)
	}
	if err != nil {
		return fmt.Errorf("checar worktree %s: %w", id, err)
	}
	if !info.IsDir() {
		return fmt.Errorf("%w: %s não é diretório", ErrNotFound, id)
	}
	return nil
}

// relUnder devolve o caminho de path relativo a root, e false quando path está
// fora dele.
//
// A comparação ignora caixa porque no Windows o git imprime o caminho como o
// disco o guarda ("C:/Users/...", com barras normais) e a raiz configurada pode
// chegar com outra caixa; sem isso uma cópia nossa apareceria como "de
// terceiro" e nunca seria listada nem limpa.
func relUnder(root, path string) (string, bool) {
	root = filepath.Clean(root)
	path = filepath.Clean(path)
	if len(path) <= len(root) {
		return "", false
	}
	if !strings.EqualFold(path[:len(root)], root) {
		return "", false
	}
	// O caractere logo depois da raiz precisa ser separador, senão
	// "/tmp/wt-old" passaria por dentro de "/tmp/wt".
	if sep := path[len(root)]; sep != '/' && sep != '\\' {
		return "", false
	}
	rest := strings.Trim(path[len(root)+1:], `/\`)
	if rest == "" {
		return "", false
	}
	return filepath.ToSlash(rest), true
}

// birth aproxima a data de criação da cópia pela data do arquivo .git de dentro
// dela, escrito uma única vez pelo `worktree add`. Zero quando não dá para ler.
func birth(path string) time.Time {
	info, err := os.Stat(filepath.Join(path, ".git"))
	if err != nil {
		return time.Time{}
	}
	return info.ModTime()
}

// runGit roda um comando git em dir e devolve a saída padrão.
//
// O `-C dir` vai como argumento em vez de mudar o diretório do processo: o
// gateway é um processo só, com vários agentes dentro, e trocar o cwd global
// para rodar um comando faria o comando do agente vizinho cair em outro lugar.
func runGit(ctx context.Context, dir string, args ...string) (string, error) {
	if len(args) == 0 {
		return "", errors.New("comando git vazio")
	}
	full := make([]string, 0, len(args)+2)
	full = append(full, "-C", dir)
	full = append(full, args...)

	cmd := exec.CommandContext(ctx, "git", full...)
	// Herdar o ambiente é o ponto (PATH, HOME, credential helper). O que muda é
	// o prompt: sem GIT_TERMINAL_PROMPT=0, um git que resolva pedir senha fica
	// esperando resposta num terminal que não existe, e o comando só morre no
	// timeout — parecendo lentidão, não falta de credencial.
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	cmd.WaitDelay = waitDelay

	err := cmd.Run()
	if err == nil {
		return stdout.String(), nil
	}

	// Cancelamento e estouro de prazo chegam ao chamador como o erro do
	// contexto, para ele poder distinguir com errors.Is do erro do git.
	if ctxErr := ctx.Err(); ctxErr != nil {
		return stdout.String(), fmt.Errorf("%s: %w", label(args), ctxErr)
	}
	// O stderr é onde o git explica o que houve ("already exists", "contains
	// modified or untracked files"); sem ele sobra só "exit status 128".
	if detail := strings.TrimSpace(stderr.String()); detail != "" {
		return stdout.String(), fmt.Errorf("%s: %s: %w", label(args), detail, err)
	}
	return stdout.String(), fmt.Errorf("%s: %w", label(args), err)
}

// label resume o comando para a mensagem de erro. Só o começo, para a mensagem
// de commit inteira não vazar dentro do erro.
func label(args []string) string {
	if len(args) == 0 {
		return "git"
	}
	if len(args) > 1 && !strings.HasPrefix(args[1], "-") {
		return "git " + args[0] + " " + args[1]
	}
	return "git " + args[0]
}
