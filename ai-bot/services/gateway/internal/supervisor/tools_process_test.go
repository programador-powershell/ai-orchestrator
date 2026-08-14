// O teste que fecha o buraco do produto anterior: `proc.run` tem de mudar de
// DESTINO quando o ambiente muda. Lá o seletor roteava só o terminal, o agente
// compilava no servidor e lia os arquivos na estação, e ninguém percebia.
package supervisor

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"aibot/gateway/internal/protocol"
	"aibot/gateway/internal/sandbox"
)

/* --------------------------------- duplos -------------------------------- */

// procHostSpy é o aplicativo nativo. Guarda o que foi despachado para lá.
type procHostSpy struct {
	tool    string
	args    string
	chamado bool
}

func (p *procHostSpy) Call(_ context.Context, _, tool string, args json.RawMessage) (string, error) {
	p.chamado = true
	p.tool = tool
	p.args = string(args)
	return "saída da estação", nil
}

// procFakeRunner é um ambiente que registra o que recebeu, sem executar nada.
type procFakeRunner struct {
	id      protocol.Environment
	workdir string
	command string
	chamado bool
}

func (f *procFakeRunner) ID() protocol.Environment { return f.id }

func (f *procFakeRunner) Available(context.Context) (bool, string) { return true, "" }

func (f *procFakeRunner) Run(_ context.Context, workdir, command string) (sandbox.Result, error) {
	f.chamado = true
	f.workdir = workdir
	f.command = command
	return sandbox.Result{ExitCode: 0, Stdout: "compilado"}, nil
}

func procToolbox(t *testing.T, environments *sandbox.Registry) (*Registry, *procHostSpy, string) {
	t.Helper()
	root := t.TempDir()
	registry := NewRegistry()
	host := &procHostSpy{}
	registry.SetBridge(host)
	toolbox := &Toolbox{
		Root:         func(string) string { return root },
		Environments: environments,
	}
	toolbox.Install(registry)
	return registry, host, root
}

/* --------------------------------- testes -------------------------------- */

func TestProcRunNoAmbienteLocalVaiParaOAplicativoNativo(t *testing.T) {
	// O Go não executa comando na estação de propósito: quem tem Job Object e
	// ConPTY é o Rust. No ambiente local nada muda em relação a antes.
	fake := &procFakeRunner{id: protocol.EnvDocker}
	environments := sandbox.NewRegistry(sandbox.NewLocalRunner(), fake)
	registry, host, _ := procToolbox(t, environments)

	args := json.RawMessage(`{"command":"go build ./...","cwd":"."}`)
	output, err := registry.Call(context.Background(), "proc.run", "s1", args)
	if err != nil {
		t.Fatalf("proc.run: %v", err)
	}
	if !host.chamado || host.tool != "proc.run" {
		t.Fatal("o comando tinha de ser despachado ao aplicativo nativo")
	}
	// Os argumentos vão INTOCADOS: remontá-los aqui apagaria em silêncio um
	// campo que só o host entende.
	if host.args != string(args) {
		t.Fatalf("os argumentos foram reescritos: %s", host.args)
	}
	if fake.chamado {
		t.Fatal("nenhum sandbox podia ter sido acionado no ambiente local")
	}
	if output != "saída da estação" {
		t.Fatalf("saída inesperada: %q", output)
	}
}

func TestProcRunForaDoLocalNaoPassaPeloAplicativoNativo(t *testing.T) {
	fake := &procFakeRunner{id: protocol.EnvDocker}
	environments := sandbox.NewRegistry(sandbox.NewLocalRunner(), fake)
	registry, host, root := procToolbox(t, environments)

	if err := environments.Set("s1", protocol.EnvDocker); err != nil {
		t.Fatalf("Set: %v", err)
	}

	output, err := registry.Call(context.Background(), "proc.run", "s1",
		json.RawMessage(`{"command":"go test ./..."}`))
	if err != nil {
		t.Fatalf("proc.run: %v", err)
	}
	if host.chamado {
		t.Fatal("com ambiente Docker o comando NÃO pode ir para a estação")
	}
	if !fake.chamado {
		t.Fatal("o comando tinha de passar pelo runner do ambiente")
	}
	if fake.command != "go test ./..." {
		t.Fatalf("o comando chegou alterado: %q", fake.command)
	}
	// Sem `cwd` o comando roda na raiz do projeto da sessão — nunca na pasta do
	// processo, que é onde mora o binário do gateway.
	if fake.workdir != root {
		t.Fatalf("esperava rodar em %q, veio %q", root, fake.workdir)
	}
	// O carimbo do ambiente é o que faltava no produto anterior: sem ele,
	// "código de saída 1" é indistinguível entre estação e container.
	if !strings.Contains(output, "[ambiente: docker]") {
		t.Fatalf("a saída tinha de dizer onde rodou: %q", output)
	}
	if !strings.Contains(output, "compilado") {
		t.Fatalf("a saída do comando sumiu: %q", output)
	}
}

func TestProcRunConfinaOCwdNaPastaDoProjeto(t *testing.T) {
	fake := &procFakeRunner{id: protocol.EnvDocker}
	environments := sandbox.NewRegistry(sandbox.NewLocalRunner(), fake)
	registry, _, _ := procToolbox(t, environments)
	if err := environments.Set("s1", protocol.EnvDocker); err != nil {
		t.Fatalf("Set: %v", err)
	}

	if _, err := registry.Call(context.Background(), "proc.run", "s1",
		json.RawMessage(`{"command":"ls","cwd":"../.."}`)); err == nil {
		t.Fatal("cwd fora da pasta do projeto tinha de ser recusado")
	}
	if fake.chamado {
		t.Fatal("nada podia ter sido executado depois da recusa")
	}
}

func TestProcRunRecusaAmbienteIndisponivel(t *testing.T) {
	// A VPS está declarada e SEM configuração no catálogo. A recusa vem com o
	// motivo acionável, e não com um erro genérico de ferramenta.
	environments := sandbox.NewRegistry(sandbox.NewLocalRunner(), sandbox.NewVPSRunner(sandbox.VPSConfig{}))
	registry, host, _ := procToolbox(t, environments)
	if err := environments.Set("s1", protocol.EnvVPS); err != nil {
		t.Fatalf("Set: %v", err)
	}

	_, err := registry.Call(context.Background(), "proc.run", "s1",
		json.RawMessage(`{"command":"make"}`))
	if err == nil {
		t.Fatal("ambiente indisponível tinha de recusar")
	}
	if !strings.Contains(err.Error(), "catalog.json") {
		t.Fatalf("o motivo tem de chegar ao modelo com o que configurar: %v", err)
	}
	if host.chamado {
		t.Fatal("recusar não é cair de volta na estação — seria rodar no lugar errado calado")
	}
}

func TestProcRunSemComandoRecusaAntesDeDecidirODestino(t *testing.T) {
	registry, host, _ := procToolbox(t, sandbox.NewRegistry(sandbox.NewLocalRunner()))
	if _, err := registry.Call(context.Background(), "proc.run", "s1",
		json.RawMessage(`{"command":"   "}`)); err == nil {
		t.Fatal("comando em branco tinha de ser recusado")
	}
	if host.chamado {
		t.Fatal("nada podia ter sido despachado")
	}
}
