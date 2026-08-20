// A EXECUÇÃO ISOLADA POR PADRÃO — o que cada teste deste arquivo guarda:
//
//   - o turno de TRABALHO (especialista que executa) roda o proc.run no
//     sandbox quando ele está são e ninguém fixou ambiente — a máquina da
//     pessoa não ganha nem node_modules;
//   - a escolha explícita da pessoa (o seletor do rodapé) vence o padrão:
//     quem fixou Local fixou Local;
//   - o turno de CONVERSA não muda de padrão — ambiente que troca sozinho
//     onde a conversa roda é o seletor de enfeite de novo;
//   - sandbox indisponível degrada com UM KindThinking por turno e segue no
//     caminho de sempre, com aprovação — nunca em silêncio;
//   - no sandbox, o workdir do container é a CÓPIA CONGELADA do turno (o
//     staging): instalar e buildar agem nela, não no projeto da pessoa.
//
// Esta estação NÃO tem Docker: o último teste dirige o DockerRunner REAL
// contra um sbx DE MENTIRA — o próprio binário de teste copiado para o PATH
// como `sbx`, que grava a pasta corrente e os argumentos recebidos (ver
// TestMain) — porque só assim se mede o caminho inteiro LookPath → sondagem →
// exec sem depender do que está instalado na máquina.
package supervisor

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"aibot/gateway/internal/protocol"
	"aibot/gateway/internal/sandbox"
	"aibot/gateway/internal/workspace"
)

/* ------------------------------ o sbx falso ------------------------------- */

// TestMain intercepta o MODO SBX DE MENTIRA: quando o binário de teste é
// copiado para o PATH como `sbx` (ver installFakeSbx), a variável de ambiente
// aponta o arquivo de registro — o processo grava a pasta corrente e os
// argumentos recebidos, sai 0 e nunca chega ao m.Run. É o "script no PATH" da
// estação sem Docker, sem trazer shell nenhum para o teste.
func TestMain(m *testing.M) {
	if logPath := os.Getenv("AIBOT_SBX_FALSO"); logPath != "" {
		cwd, _ := os.Getwd()
		file, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
		if err == nil {
			fmt.Fprintf(file, "cwd=%s\nargs=%s\n", cwd, strings.Join(os.Args[1:], " "))
			_ = file.Close()
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// installFakeSbx põe o sbx de mentira no PATH do teste e devolve o arquivo em
// que ele grava o que recebeu. A cópia é do PRÓPRIO binário de teste: um .exe
// de verdade que o exec.LookPath acha e o CreateProcess roda sem intermediário
// — um .cmd/.sh exigiria um shell e a regra de escape dele.
func installFakeSbx(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	logPath := filepath.Join(dir, "sbx.log")

	self, err := os.Executable()
	if err != nil {
		t.Fatalf("descobrir o binário de teste: %v", err)
	}
	name := "sbx"
	if runtime.GOOS == "windows" {
		name = "sbx.exe"
	}
	source, err := os.Open(self)
	if err != nil {
		t.Fatalf("abrir o binário de teste: %v", err)
	}
	defer source.Close()
	target, err := os.OpenFile(filepath.Join(dir, name), os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o755)
	if err != nil {
		t.Fatalf("criar o sbx de mentira: %v", err)
	}
	if _, err := io.Copy(target, source); err != nil {
		target.Close()
		t.Fatalf("copiar o binário: %v", err)
	}
	if err := target.Close(); err != nil {
		t.Fatalf("fechar o sbx de mentira: %v", err)
	}

	t.Setenv("AIBOT_SBX_FALSO", logPath)
	// PREPOSTO no PATH: o LookPath tem de achar o falso antes de qualquer sbx
	// real que um dia exista nesta máquina.
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return logPath
}

// lastEntry devolve o último valor de uma chave ("cwd", "args") no registro do
// sbx falso — a sondagem de versão também grava, e o que interessa é a
// EXECUÇÃO, que vem por último.
func lastEntry(t *testing.T, logPath, key string) string {
	t.Helper()
	raw, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("ler o registro do sbx falso: %v", err)
	}
	value := ""
	for _, line := range strings.Split(strings.ReplaceAll(string(raw), "\r\n", "\n"), "\n") {
		if rest, ok := strings.CutPrefix(line, key+"="); ok {
			value = rest
		}
	}
	if value == "" {
		t.Fatalf("o registro do sbx falso não tem %q:\n%s", key, raw)
	}
	return value
}

/* --------------------------------- duplos --------------------------------- */

// prefRunner é um ambiente de mentira com disponibilidade programável.
type prefRunner struct {
	id        protocol.Environment
	available bool
	detail    string
	calls     int
	workdir   string
	command   string
}

func (r *prefRunner) ID() protocol.Environment { return r.id }

func (r *prefRunner) Available(context.Context) (bool, string) { return r.available, r.detail }

func (r *prefRunner) Run(_ context.Context, workdir, command string) (sandbox.Result, error) {
	r.calls++
	r.workdir = workdir
	r.command = command
	return sandbox.Result{ExitCode: 0, Stdout: "isolado"}, nil
}

// prefHost é o aplicativo nativo, contando quantas vezes foi acionado.
type prefHost struct{ calls int }

func (h *prefHost) Call(context.Context, string, string, json.RawMessage) (string, error) {
	h.calls++
	return "estação", nil
}

// prefBus registra os envelopes efêmeros — é nele que o aviso de degradação
// (KindThinking) tem de aparecer, uma vez só.
type prefBus struct{ envelopes []protocol.Envelope }

func (b *prefBus) PublishEphemeral(_ string, envelope protocol.Envelope) {
	b.envelopes = append(b.envelopes, envelope)
}

// thinkingLabels filtra os rótulos de etapa publicados.
func (b *prefBus) thinkingLabels(t *testing.T) []string {
	t.Helper()
	labels := make([]string, 0, len(b.envelopes))
	for _, envelope := range b.envelopes {
		if envelope.Kind != protocol.KindThinking {
			continue
		}
		var thinking protocol.Thinking
		if err := json.Unmarshal(envelope.Payload, &thinking); err != nil {
			t.Fatalf("payload de thinking ilegível: %v", err)
		}
		labels = append(labels, thinking.Label)
	}
	return labels
}

// prefToolbox monta o proc.run com o especialista da sessão programável — é o
// que separa o turno de trabalho do turno de conversa nestes testes.
func prefToolbox(t *testing.T, specialistID string, runners ...sandbox.Runner) (*Registry, *prefHost, *prefBus, *sandbox.Registry) {
	t.Helper()
	registry := NewRegistry()
	host := &prefHost{}
	registry.SetBridge(host)
	bus := &prefBus{}
	environments := sandbox.NewRegistry(append([]sandbox.Runner{sandbox.NewLocalRunner()}, runners...)...)
	toolbox := &Toolbox{
		Environments: environments,
		Notices:      bus,
		Specialist:   func(string) string { return specialistID },
	}
	toolbox.Install(registry)
	return registry, host, bus, environments
}

/* --------------------------------- testes --------------------------------- */

func TestProcRunTurnoDeTrabalhoPrefereOSandboxSao(t *testing.T) {
	// Ninguém fixou ambiente e o sandbox responde: o turno de trabalho roda
	// ISOLADO por omissão — instalar dependência não toca a estação.
	docker := &prefRunner{id: protocol.EnvDocker, available: true}
	registry, host, bus, _ := prefToolbox(t, "code", docker)
	root := t.TempDir()

	output, err := registry.Call(ctxComRoot(root), "proc.run", "s1",
		json.RawMessage(`{"command":"corepack pnpm install"}`))
	if err != nil {
		t.Fatalf("proc.run: %v", err)
	}
	if host.calls != 0 {
		t.Fatal("o comando do turno de trabalho não podia ter caído na estação")
	}
	if docker.calls != 1 {
		t.Fatalf("o sandbox tinha de ter executado, houve %d chamada(s)", docker.calls)
	}
	// O workdir é a raiz congelada do turno: é nela que o install age.
	if docker.workdir != root {
		t.Fatalf("esperava rodar em %q, veio %q", root, docker.workdir)
	}
	if !strings.Contains(output, "[ambiente: docker]") {
		t.Fatalf("a saída tinha de vir carimbada do sandbox: %q", output)
	}
	// Padrão saudável não é degradação: nenhum aviso.
	if labels := bus.thinkingLabels(t); len(labels) != 0 {
		t.Fatalf("sandbox são não avisa nada, veio %q", labels)
	}
}

func TestProcRunEscolhaExplicitaDaPessoaVenceOSandbox(t *testing.T) {
	// A pessoa fixou o Local no rodapé: o padrão novo NÃO passa por cima —
	// Local virou escolha explícita, não deixou de ser escolha.
	docker := &prefRunner{id: protocol.EnvDocker, available: true}
	wsl := &prefRunner{id: protocol.EnvWSL, available: true}
	registry, host, _, environments := prefToolbox(t, "code", docker, wsl)
	root := t.TempDir()

	if err := environments.Set("s1", protocol.EnvLocal); err != nil {
		t.Fatalf("Set: %v", err)
	}
	if _, err := registry.Call(ctxComRoot(root), "proc.run", "s1",
		json.RawMessage(`{"command":"corepack pnpm install"}`)); err != nil {
		t.Fatalf("proc.run: %v", err)
	}
	if host.calls != 1 || docker.calls != 0 {
		t.Fatalf("com Local fixado o comando vai à estação: host=%d docker=%d", host.calls, docker.calls)
	}

	// E qualquer outra escolha explícita também manda — o seletor continua
	// sendo o dono da decisão.
	if err := environments.Set("s1", protocol.EnvWSL); err != nil {
		t.Fatalf("Set: %v", err)
	}
	if _, err := registry.Call(ctxComRoot(root), "proc.run", "s1",
		json.RawMessage(`{"command":"go vet ./..."}`)); err != nil {
		t.Fatalf("proc.run: %v", err)
	}
	if wsl.calls != 1 || docker.calls != 0 {
		t.Fatalf("a escolha explícita da pessoa não valeu: wsl=%d docker=%d", wsl.calls, docker.calls)
	}
}

func TestProcRunTurnoDeConversaNaoMudaDePadrao(t *testing.T) {
	// A sessão é do chat: mesmo com o sandbox são, o padrão do turno de
	// conversa continua o de sempre — o modo é da conversa, não do Docker.
	docker := &prefRunner{id: protocol.EnvDocker, available: true}
	registry, host, bus, _ := prefToolbox(t, "chat", docker)

	if _, err := registry.Call(ctxComRoot(t.TempDir()), "proc.run", "s1",
		json.RawMessage(`{"command":"go build ./..."}`)); err != nil {
		t.Fatalf("proc.run: %v", err)
	}
	if host.calls != 1 || docker.calls != 0 {
		t.Fatalf("o turno de conversa tinha de seguir na estação: host=%d docker=%d", host.calls, docker.calls)
	}
	if labels := bus.thinkingLabels(t); len(labels) != 0 {
		t.Fatalf("conversa fora do sandbox não é degradação — nenhum aviso: %q", labels)
	}
}

func TestProcRunDegradaHonestoComUmAvisoPorTurno(t *testing.T) {
	// Sandbox indisponível no turno de trabalho: o comando segue Local (com o
	// funil de aprovação de sempre) e a pessoa lê UM aviso por turno — dez
	// proc.run não viram dez avisos, e o turno seguinte avisa de novo.
	docker := &prefRunner{id: protocol.EnvDocker, available: false,
		detail: "o Docker Sandboxes não está instalado"}
	registry, host, bus, _ := prefToolbox(t, "code", docker)
	root := t.TempDir()

	turno := withSandboxWarning(ctxComRoot(root))
	for range 2 {
		if _, err := registry.Call(turno, "proc.run", "s1",
			json.RawMessage(`{"command":"corepack pnpm install"}`)); err != nil {
			t.Fatalf("proc.run degradado: %v", err)
		}
	}
	if host.calls != 2 || docker.calls != 0 {
		t.Fatalf("degradado tinha de seguir na estação: host=%d docker=%d", host.calls, docker.calls)
	}

	labels := bus.thinkingLabels(t)
	if len(labels) != 1 {
		t.Fatalf("esperava UM aviso no turno, veio %d: %q", len(labels), labels)
	}
	// O aviso é acionável: diz o que instalar e onde o comando vai rodar.
	for _, want := range []string{"execução isolada indisponível", "Docker Desktop", "sbx", "Local", "aprovação"} {
		if !strings.Contains(labels[0], want) {
			t.Errorf("o aviso não diz %q: %q", want, labels[0])
		}
	}

	// O TURNO SEGUINTE avisa de novo: quem abriu a conversa amanhã não leu o
	// aviso de ontem.
	if _, err := registry.Call(withSandboxWarning(ctxComRoot(root)), "proc.run", "s1",
		json.RawMessage(`{"command":"go test ./..."}`)); err != nil {
		t.Fatalf("proc.run do turno seguinte: %v", err)
	}
	if labels := bus.thinkingLabels(t); len(labels) != 2 {
		t.Fatalf("o turno novo tinha de avisar de novo, total %d: %q", len(labels), labels)
	}
}

func TestProcRunNoSandboxMontaACopiaCongeladaDoTurno(t *testing.T) {
	// O caminho REAL de ponta a ponta — DockerRunner de verdade, sbx de
	// mentira no PATH: o processo `sbx` roda A PARTIR do staging do turno, que
	// é a pasta que o .sbxenv.yaml monta como workspace do container. Instalar
	// e buildar agem na cópia; o projeto da pessoa não vê nada até a promoção.
	logPath := installFakeSbx(t)

	registry := NewRegistry()
	host := &prefHost{}
	registry.SetBridge(host)
	environments := sandbox.NewRegistry(
		sandbox.NewLocalRunner(),
		sandbox.NewDockerRunner(sandbox.DockerOptions{}),
	)
	toolbox := &Toolbox{
		Environments: environments,
		Specialist:   func(string) string { return "code" },
	}
	toolbox.Install(registry)

	// A execução congelada do turno aponta para a CÓPIA (staging real).
	staging := t.TempDir()
	ctx := workspace.WithExecution(context.Background(), &workspace.Execution{
		LocalRoot:    staging,
		LocalStaging: staging,
	})

	output, err := registry.Call(ctx, "proc.run", "s1",
		json.RawMessage(`{"command":"corepack pnpm install"}`))
	if err != nil {
		t.Fatalf("proc.run: %v", err)
	}
	if host.calls != 0 {
		t.Fatal("nada podia ter ido à estação — o sandbox estava são")
	}
	if !strings.Contains(output, "[ambiente: docker]") {
		t.Fatalf("a saída tinha de vir carimbada do sandbox: %q", output)
	}

	// O sbx rodou DE DENTRO do staging — não do projeto, não da pasta do
	// processo. EqualFold porque o Windows devolve o mesmo caminho com caixa
	// própria em chamadas diferentes.
	cwd := lastEntry(t, logPath, "cwd")
	if !strings.EqualFold(filepath.Clean(cwd), filepath.Clean(staging)) {
		t.Fatalf("o container tinha de montar o staging %q, montou %q", staging, cwd)
	}
	// E a linha do exec chegou montada como sempre: exec -- shell -c comando.
	args := lastEntry(t, logPath, "args")
	for _, want := range []string{"exec", "--", "corepack pnpm install"} {
		if !strings.Contains(args, want) {
			t.Fatalf("a linha do sbx não tem %q: %q", want, args)
		}
	}
}
