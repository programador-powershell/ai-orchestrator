// Testes do ambiente de execução.
//
// Duas regras guiam o que é testado aqui:
//
//  1. NADA é executado de verdade. A máquina que roda estes testes não tem
//     `sbx` nem distribuição de WSL, e um teste que dependesse disso passaria
//     ou falharia pelo que está instalado — que não é o que se quer medir. Os
//     disparos de processo entram por `run`/`lookPath`, e o teste os substitui.
//  2. A montagem dos argumentos é conferida ELEMENTO A ELEMENTO. O comando vem
//     do modelo: se um dia alguém "simplificar" `sbxArgs` para concatenar tudo
//     numa string, o comando volta a ser reinterpretado por um shell e um
//     argumento com aspas vira injeção. É a regressão mais cara deste pacote e
//     por isso é a mais coberta.
package sandbox

import (
	"context"
	"errors"
	"os/exec"
	"strings"
	"testing"
	"time"

	"aibot/gateway/internal/protocol"
)

/* --------------------------------- duplos -------------------------------- */

// recorder guarda o que teria sido executado.
type recorder struct {
	names   []string
	args    [][]string
	dirs    []string
	answer  func(name string, args []string) (Result, error)
	callCnt int
}

func (r *recorder) exec(_ context.Context, dir, name string, args []string) (Result, error) {
	r.callCnt++
	r.names = append(r.names, name)
	r.args = append(r.args, args)
	r.dirs = append(r.dirs, dir)
	if r.answer != nil {
		return r.answer(name, args)
	}
	return Result{}, nil
}

func found(string) (string, error)   { return "C:\\fake\\binario.exe", nil }
func missing(string) (string, error) { return "", errors.New("executable file not found in %PATH%") }

/* ----------------------------- disponibilidade ---------------------------- */

func TestDockerAvailableSemBinarioDizOQueInstalar(t *testing.T) {
	runner := NewDockerRunner(DockerOptions{})
	runner.lookPath = missing

	available, detail := runner.Available(context.Background())
	if available {
		t.Fatal("sem o sbx no PATH o ambiente não pode ser oferecido")
	}
	if detail != dockerMissing {
		t.Fatalf("motivo inesperado: %q", detail)
	}
	// A frase tem de dizer O QUE instalar — "indisponível" sozinho não resolve
	// nada para quem está olhando a opção cinza.
	for _, expected := range []string{"Docker Sandboxes", "Docker Desktop", "sbx"} {
		if !strings.Contains(detail, expected) {
			t.Errorf("a frase não menciona %q: %q", expected, detail)
		}
	}
}

// TestDockerAvailableNestaMaquina confere o caminho REAL, sem duplo. Esta
// máquina não tem `sbx`; numa que tenha, o teste sai de cena em vez de falhar —
// medir o que está instalado na estação não é o objetivo dele.
func TestDockerAvailableNestaMaquina(t *testing.T) {
	if _, err := exec.LookPath("sbx"); err == nil {
		t.Skip("esta máquina tem o sbx instalado — o caminho de ausência não se aplica")
	}
	available, detail := NewDockerRunner(DockerOptions{}).Available(context.Background())
	if available || detail != dockerMissing {
		t.Fatalf("esperava indisponível com a frase de instalação, veio (%v, %q)", available, detail)
	}
}

func TestDockerAvailableComDaemonParado(t *testing.T) {
	// O binário existe e mesmo assim não dá para usar (Docker Desktop fechado é
	// o caso comum). A frase certa aqui NÃO é "instale" — é o que o sbx disse.
	calls := &recorder{answer: func(string, []string) (Result, error) {
		return Result{ExitCode: 1, Stderr: "cannot connect to the Docker daemon\nis it running?"}, nil
	}}
	runner := NewDockerRunner(DockerOptions{})
	runner.lookPath = found
	runner.run = calls.exec

	available, detail := runner.Available(context.Background())
	if available {
		t.Fatal("daemon parado não é ambiente disponível")
	}
	if strings.Contains(detail, "instale") {
		t.Fatalf("com o binário presente a frase não pode mandar instalar: %q", detail)
	}
	if !strings.Contains(detail, "cannot connect") {
		t.Fatalf("o motivo do sbx tem de aparecer: %q", detail)
	}
	if strings.Contains(detail, "\n") {
		t.Fatalf("o motivo vai em uma linha para caber no rótulo: %q", detail)
	}
}

func TestWSLAvailableSemBinario(t *testing.T) {
	runner := NewWSLRunner()
	runner.lookPath = missing

	available, detail := runner.Available(context.Background())
	if available || detail != wslMissing {
		t.Fatalf("esperava (false, %q), veio (%v, %q)", wslMissing, available, detail)
	}
}

func TestWSLAvailableSemDistribuicao(t *testing.T) {
	// No Windows 11 o `wsl.exe` vem no System32 de fábrica: achar o binário não
	// quer dizer que dá para rodar Linux. Sem esta separação o ambiente
	// apareceria disponível e todo comando morreria com um erro do wsl.
	calls := &recorder{answer: func(string, []string) (Result, error) {
		// Saída vazia em UTF-16LE — só os bytes zero.
		return Result{Stdout: "\x00\x00"}, nil
	}}
	runner := NewWSLRunner()
	runner.lookPath = found
	runner.run = calls.exec

	available, detail := runner.Available(context.Background())
	if available {
		t.Fatal("sem distribuição instalada o WSL não executa nada")
	}
	if detail != wslNoDistro {
		t.Fatalf("motivo inesperado: %q", detail)
	}
}

func TestWSLAvailableComDistribuicao(t *testing.T) {
	calls := &recorder{answer: func(string, []string) (Result, error) {
		// `wsl -l -q` responde em UTF-16LE: cada caractere seguido de um zero.
		return Result{Stdout: "U\x00b\x00u\x00n\x00t\x00u\x00"}, nil
	}}
	runner := NewWSLRunner()
	runner.lookPath = found
	runner.run = calls.exec

	available, detail := runner.Available(context.Background())
	if !available || detail != "" {
		t.Fatalf("com distribuição o ambiente é utilizável, veio (%v, %q)", available, detail)
	}
	if got := calls.args[0]; len(got) != 2 || got[0] != "-l" || got[1] != "-q" {
		t.Fatalf("sondagem inesperada: %q", got)
	}
}

func TestNuvemApareceComMotivo(t *testing.T) {
	// Honestidade: a opção continua na lista, cinza, com o porquê. O produto
	// anterior prometia os quatro ambientes no rodapé — sumir com a opção faria
	// a pessoa procurar por uma função que ela leu que existe. (O VPS saiu
	// desta lista: ele tem executor de verdade, testado em vps_test.go.)
	runner := NewCloudRunner()
	available, detail := runner.Available(context.Background())
	if available {
		t.Fatalf("%s ainda não tem executor", runner.ID())
	}
	if detail != notImplemented {
		t.Fatalf("%s: motivo inesperado %q", runner.ID(), detail)
	}
	if _, err := runner.Run(context.Background(), "", "echo oi"); err == nil {
		t.Fatalf("%s: Run tinha de recusar", runner.ID())
	}
}

func TestLocalNaoExecutaNoGateway(t *testing.T) {
	// O Go não roda comando na estação de propósito: quem tem Job Object e
	// ConPTY é o aplicativo nativo em Rust. Aqui a resposta é ErrHostOnly, que é
	// o sinal para o supervisor despachar ao host.
	local := NewLocalRunner()
	if available, detail := local.Available(context.Background()); !available || detail != "" {
		t.Fatalf("a estação está sempre disponível, veio (%v, %q)", available, detail)
	}
	if _, err := local.Run(context.Background(), "", "echo oi"); !errors.Is(err, ErrHostOnly) {
		t.Fatalf("esperava ErrHostOnly, veio %v", err)
	}
}

/* -------------------------- montagem de argumentos ------------------------ */

// comandoHostil é o que um modelo pode produzir sem má intenção nenhuma: aspas,
// ponto e vírgula e cifrão. Concatenado numa string, vira três comandos.
const comandoHostil = `echo "olá; rm -rf /" && printf '$HOME'`

func TestSbxArgsNaoConcatena(t *testing.T) {
	args := sbxArgs("C:\\Meus Projetos\\ai-bot\\.sbxenv.yaml", "bash", comandoHostil)

	esperado := []string{
		"exec",
		"--env-file", "C:\\Meus Projetos\\ai-bot\\.sbxenv.yaml",
		"--", "bash", "-c", comandoHostil,
	}
	if len(args) != len(esperado) {
		t.Fatalf("esperava %d elementos, veio %d: %q", len(esperado), len(args), args)
	}
	for index, want := range esperado {
		if args[index] != want {
			t.Fatalf("elemento %d: esperava %q, veio %q", index, want, args[index])
		}
	}

	// A flag e o valor em elementos SEPARADOS: um caminho com espaço não pode
	// virar dois argumentos em nenhuma camada que reprocesse a string.
	for _, arg := range args {
		if strings.HasPrefix(arg, "--env-file") && arg != "--env-file" {
			t.Fatalf("a flag veio grudada no valor: %q", arg)
		}
	}
	// E o comando inteiro em UM elemento só, com os metacaracteres intactos.
	if args[len(args)-1] != comandoHostil {
		t.Fatalf("o comando foi reescrito: %q", args[len(args)-1])
	}
	if strings.Contains(args[0], " ") {
		t.Fatalf("o primeiro elemento tem espaço — sinal de linha montada em string: %q", args[0])
	}
}

func TestSbxArgsSemEnvFileOmiteAFlag(t *testing.T) {
	args := sbxArgs("", "bash", "go test ./...")
	for _, arg := range args {
		if arg == "--env-file" || arg == "" {
			t.Fatalf("sem arquivo declarado a flag não pode aparecer (nem vazia): %q", args)
		}
	}
	if args[0] != "exec" || args[1] != "--" {
		t.Fatalf("o `--` tem de fechar as flags antes do shell: %q", args)
	}
}

func TestWslArgsNaoConcatena(t *testing.T) {
	args := wslArgs(comandoHostil)
	esperado := []string{"-e", "bash", "-lc", comandoHostil}
	if len(args) != len(esperado) {
		t.Fatalf("esperava %d elementos, veio %q", len(esperado), args)
	}
	for index, want := range esperado {
		if args[index] != want {
			t.Fatalf("elemento %d: esperava %q, veio %q", index, want, args[index])
		}
	}
}

func TestDockerRunPassaComandoEmUmElemento(t *testing.T) {
	calls := &recorder{answer: func(_ string, args []string) (Result, error) {
		if len(args) > 0 && args[0] == "version" {
			return Result{Stdout: "sbx 1.0.0"}, nil
		}
		return Result{Stdout: "ok"}, nil
	}}
	runner := NewDockerRunner(DockerOptions{EnvFile: ".sbxenv.yaml"})
	runner.lookPath = found
	runner.run = calls.exec

	if _, err := runner.Run(context.Background(), "C:\\projeto", comandoHostil); err != nil {
		t.Fatalf("Run: %v", err)
	}
	// A última chamada é a execução (a primeira é a sondagem de versão).
	last := calls.args[len(calls.args)-1]
	if last[len(last)-1] != comandoHostil {
		t.Fatalf("o comando não chegou intacto: %q", last)
	}
	if dir := calls.dirs[len(calls.dirs)-1]; dir != "C:\\projeto" {
		t.Fatalf("o processo tinha de rodar a partir da pasta do projeto, veio %q", dir)
	}
}

func TestRunRecusaComandoVazio(t *testing.T) {
	// Sem isto, `sbx exec -- bash -c ""` sobe um container para não fazer nada.
	docker := NewDockerRunner(DockerOptions{})
	docker.lookPath = found
	docker.run = (&recorder{}).exec
	if _, err := docker.Run(context.Background(), "", "   "); err == nil {
		t.Fatal("comando em branco tinha de ser recusado antes de subir container")
	}

	wsl := NewWSLRunner()
	wsl.lookPath = found
	wsl.run = (&recorder{}).exec
	if _, err := wsl.Run(context.Background(), "", ""); err == nil {
		t.Fatal("comando vazio tinha de ser recusado")
	}
}

/* -------------------------------- resultado ------------------------------- */

func TestCombinedJuntaAsDuasSaidas(t *testing.T) {
	cases := []struct {
		name   string
		result Result
		want   string
	}{
		{"só stdout", Result{Stdout: "ok"}, "ok"},
		{"só stderr", Result{Stderr: "falhou"}, "falhou"},
		{"as duas", Result{Stdout: "ok", Stderr: "aviso"}, "ok\naviso"},
		{"nenhuma", Result{}, ""},
	}
	for _, each := range cases {
		if got := each.result.Combined(); got != each.want {
			t.Errorf("%s: esperava %q, veio %q", each.name, each.want, got)
		}
	}
}

/* --------------------------------- registro ------------------------------- */

func novoRegistro() *Registry {
	return NewRegistry(
		NewLocalRunner(),
		NewDockerRunner(DockerOptions{}),
		NewWSLRunner(),
		NewVPSRunner(VPSConfig{}),
		NewCloudRunner(),
	)
}

func TestRegistryTrocaEDevolveOAtivo(t *testing.T) {
	registry := novoRegistro()
	ctx := context.Background()

	// Sessão que nunca escolheu roda no padrão — sem VPS configurada, local.
	if got := registry.Active(ctx, "s1"); got != protocol.EnvLocal {
		t.Fatalf("padrão tinha de ser local, veio %q", got)
	}

	if err := registry.Set("s1", protocol.EnvDocker); err != nil {
		t.Fatalf("Set: %v", err)
	}
	if got := registry.Active(ctx, "s1"); got != protocol.EnvDocker {
		t.Fatalf("esperava docker, veio %q", got)
	}

	// O ambiente é POR SESSÃO: trocar numa conversa não pode mudar a outra —
	// duas janelas trabalhando em projetos diferentes é o caso normal.
	if got := registry.Active(ctx, "s2"); got != protocol.EnvLocal {
		t.Fatalf("a outra sessão foi contaminada: %q", got)
	}

	if err := registry.Set("s1", protocol.EnvWSL); err != nil {
		t.Fatalf("Set: %v", err)
	}
	if got := registry.Active(ctx, "s1"); got != protocol.EnvWSL {
		t.Fatalf("esperava wsl, veio %q", got)
	}

	registry.Forget("s1")
	if got := registry.Active(ctx, "s1"); got != protocol.EnvLocal {
		t.Fatalf("depois de esquecer a sessão volta ao padrão, veio %q", got)
	}
}

func TestRegistryChosenSeparaEscolhaDePadrao(t *testing.T) {
	// `Active` responde sempre um ambiente utilizável — e por isso ESCONDE se
	// foi a pessoa que escolheu. `Chosen` é a pergunta que a preferência do
	// proc.run faz: "alguém fixou?", porque só a omissão abre espaço para o
	// sandbox virar o padrão do turno de trabalho.
	registry := novoRegistro()

	if _, ok := registry.Chosen("s1"); ok {
		t.Fatal("sessão que nunca escolheu não pode aparecer como escolha explícita")
	}
	if err := registry.Set("s1", protocol.EnvLocal); err != nil {
		t.Fatalf("Set: %v", err)
	}
	// Fixar o LOCAL é exatamente o caso que Active não distingue do padrão.
	chosen, ok := registry.Chosen("s1")
	if !ok || chosen != protocol.EnvLocal {
		t.Fatalf("esperava a escolha explícita (local, true), veio (%q, %v)", chosen, ok)
	}
	// Esquecer a sessão volta a ser omissão.
	registry.Forget("s1")
	if _, ok := registry.Chosen("s1"); ok {
		t.Fatal("depois do Forget a sessão não tem mais escolha explícita")
	}
}

func TestRegistryRecusaAmbienteDesconhecido(t *testing.T) {
	registry := novoRegistro()
	if err := registry.Set("s1", protocol.EnvDocker); err != nil {
		t.Fatalf("Set: %v", err)
	}

	if err := registry.Set("s1", protocol.Environment("kubernetes")); !errors.Is(err, ErrNoRunner) {
		t.Fatalf("esperava ErrNoRunner, veio %v", err)
	}
	// A recusa não pode deixar a sessão num ambiente que ninguém escolheu.
	if got := registry.Active(context.Background(), "s1"); got != protocol.EnvDocker {
		t.Fatalf("o ambiente anterior tinha de continuar, veio %q", got)
	}
	if err := registry.Set("", protocol.EnvDocker); err == nil {
		t.Fatal("sessão vazia tinha de ser recusada")
	}
}

func TestRegistryDescribeTrazMotivoDeQuemNaoPode(t *testing.T) {
	registry := NewRegistry(NewLocalRunner(), NewVPSRunner(VPSConfig{}), NewCloudRunner())
	described := registry.Describe(context.Background())

	if len(described) != 3 {
		t.Fatalf("esperava três ambientes, veio %d", len(described))
	}
	// A ordem é a do registro: é ela que a tela desenha.
	if described[0].ID != protocol.EnvLocal || described[1].ID != protocol.EnvVPS {
		t.Fatalf("ordem inesperada: %+v", described)
	}
	if !described[0].Available || described[0].Label != "Local" {
		t.Fatalf("o local tinha de estar disponível e rotulado: %+v", described[0])
	}
	for _, info := range described[1:] {
		if info.Available {
			t.Fatalf("%s ainda não tem executor", info.ID)
		}
		// Indisponível SEM motivo é uma opção cinza que ninguém entende.
		if info.Detail == "" {
			t.Fatalf("%s: falta o motivo", info.ID)
		}
		if info.Hint == "" || info.Label == "" {
			t.Fatalf("%s: falta rótulo ou explicação: %+v", info.ID, info)
		}
	}
}

// contador é um ambiente que conta quantas vezes foi sondado.
type contador struct {
	id    protocol.Environment
	vezes int
}

func (c *contador) ID() protocol.Environment { return c.id }

func (c *contador) Available(context.Context) (bool, string) {
	c.vezes++
	return true, ""
}

func (c *contador) Run(context.Context, string, string) (Result, error) { return Result{}, nil }

func TestRegistryNaoSondaAMaquinaACadaConexao(t *testing.T) {
	// `Describe` roda no handshake de CADA janela. Sem cache, abrir o app três
	// vezes dispara três `sbx version` e três `wsl -l -q` antes do primeiro
	// quadro — e o preço aparece justamente na abertura, que é onde dói.
	sonda := &contador{id: protocol.EnvDocker}
	registry := NewRegistry(sonda)
	agora := time.Now()
	registry.now = func() time.Time { return agora }

	for range 3 {
		registry.Describe(context.Background())
	}
	if sonda.vezes != 1 {
		t.Fatalf("esperava uma sondagem, houve %d", sonda.vezes)
	}

	// Passado o prazo, mede de novo: quem acabou de instalar o Docker Desktop
	// não pode ficar com a opção cinza até reiniciar o aplicativo.
	agora = agora.Add(availabilityTTL + time.Second)
	registry.Describe(context.Background())
	if sonda.vezes != 2 {
		t.Fatalf("esperava nova sondagem depois do prazo, houve %d", sonda.vezes)
	}
}
