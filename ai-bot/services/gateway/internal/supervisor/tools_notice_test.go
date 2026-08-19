// O aviso animado do Docker — e a ORDEM dele.
//
// O que se mede aqui não é o texto do popup: é que o KindNotice sai ANTES de o
// DockerRunner rodar (num barramento de mentira que registra a sequência), e
// que o downgrade para o ai-jail da VPS nunca acontece em silêncio. Um teste
// que só olhasse o payload deixaria passar a implementação que roda primeiro e
// anuncia depois — que anuncia o passado.
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

// noticeLog é a linha do tempo compartilhada entre o barramento e os runners:
// é a ordem DELE que o teste afirma.
type noticeLog struct {
	events []string
}

// noticeSpyBus registra os avisos publicados, na posição em que aconteceram.
type noticeSpyBus struct {
	timeline  *noticeLog
	envelopes []protocol.Envelope
}

func (b *noticeSpyBus) PublishEphemeral(_ string, envelope protocol.Envelope) {
	b.timeline.events = append(b.timeline.events, "notice")
	b.envelopes = append(b.envelopes, envelope)
}

// noticeSpyRunner é um ambiente que registra QUANDO rodou na mesma linha do
// tempo do barramento.
type noticeSpyRunner struct {
	id        protocol.Environment
	timeline  *noticeLog
	available bool
	detail    string
	command   string
}

func (r *noticeSpyRunner) ID() protocol.Environment { return r.id }

func (r *noticeSpyRunner) Available(context.Context) (bool, string) {
	return r.available, r.detail
}

func (r *noticeSpyRunner) Run(_ context.Context, _, command string) (sandbox.Result, error) {
	r.timeline.events = append(r.timeline.events, "run:"+string(r.id))
	r.command = command
	return sandbox.Result{ExitCode: 0, Stdout: "rodou"}, nil
}

// noticeToolbox monta o registro de ferramentas com o barramento e os
// ambientes de mentira já ligados.
func noticeToolbox(t *testing.T, timeline *noticeLog, runners ...sandbox.Runner) (*Registry, *noticeSpyBus) {
	t.Helper()
	registry := NewRegistry()
	registry.SetBridge(&procHostSpy{})
	bus := &noticeSpyBus{timeline: timeline}
	toolbox := &Toolbox{
		Environments: sandbox.NewRegistry(append([]sandbox.Runner{sandbox.NewLocalRunner()}, runners...)...),
		Notices:      bus,
		Specialist:   func(string) string { return "code" },
	}
	toolbox.Install(registry)
	return registry, bus
}

// decodeNotice tira o payload do envelope registrado.
func decodeNotice(t *testing.T, envelope protocol.Envelope) protocol.Notice {
	t.Helper()
	if envelope.Kind != protocol.KindNotice {
		t.Fatalf("esperava KindNotice, veio %q", envelope.Kind)
	}
	var notice protocol.Notice
	if err := json.Unmarshal(envelope.Payload, &notice); err != nil {
		t.Fatalf("payload do notice ilegível: %v", err)
	}
	return notice
}

/* --------------------------------- testes -------------------------------- */

func TestProcRunAnunciaAntesDeRodarNoDocker(t *testing.T) {
	timeline := &noticeLog{}
	docker := &noticeSpyRunner{id: protocol.EnvDocker, timeline: timeline, available: true}
	registry, bus := noticeToolbox(t, timeline, docker)

	output, err := registry.Call(ctxComRoot(t.TempDir()), "proc.run", "s1",
		json.RawMessage(`{"command":"docker compose up -d"}`))
	if err != nil {
		t.Fatalf("proc.run: %v", err)
	}

	// A ordem é o teste: aviso PRIMEIRO, container depois. Invertida, o popup
	// anuncia algo que já aconteceu.
	if len(timeline.events) != 2 || timeline.events[0] != "notice" || timeline.events[1] != "run:docker" {
		t.Fatalf("esperava [notice, run:docker], veio %q", timeline.events)
	}

	notice := decodeNotice(t, bus.envelopes[0])
	if notice.Icon != "docker" {
		t.Fatalf("ícone inesperado: %q", notice.Icon)
	}
	if !strings.Contains(notice.Title, "container") {
		t.Fatalf("o título tem de dizer que vai para um container: %q", notice.Title)
	}
	if notice.Specialist != "code" {
		t.Fatalf("o aviso tem de carregar o especialista ativo, veio %q", notice.Specialist)
	}
	if !strings.Contains(notice.Detail, "docker") {
		t.Fatalf("o detalhe tem de dizer o porquê: %q", notice.Detail)
	}
	if !strings.Contains(output, "[ambiente: docker]") {
		t.Fatalf("a saída tinha de vir carimbada do docker: %q", output)
	}
}

func TestProcRunPedidoExplicitoDoModeloTambemAnuncia(t *testing.T) {
	timeline := &noticeLog{}
	docker := &noticeSpyRunner{id: protocol.EnvDocker, timeline: timeline, available: true}
	registry, bus := noticeToolbox(t, timeline, docker)

	// O comando em si não fala de docker — quem pediu o container foi o
	// modelo, pelo argumento `env`.
	if _, err := registry.Call(ctxComRoot(t.TempDir()), "proc.run", "s1",
		json.RawMessage(`{"command":"go test ./...","env":"docker"}`)); err != nil {
		t.Fatalf("proc.run: %v", err)
	}
	if len(timeline.events) != 2 || timeline.events[0] != "notice" {
		t.Fatalf("o pedido explícito tinha de ser anunciado antes de rodar: %q", timeline.events)
	}
	if notice := decodeNotice(t, bus.envelopes[0]); !strings.Contains(notice.Detail, "explicitamente") {
		t.Fatalf("o detalhe tem de dizer que foi pedido do modelo: %q", notice.Detail)
	}
}

func TestProcRunSemSbxCaiNoAiJailDaVPSComAviso(t *testing.T) {
	timeline := &noticeLog{}
	docker := &noticeSpyRunner{
		id: protocol.EnvDocker, timeline: timeline,
		available: false, detail: "o Docker Sandboxes não está instalado — instale o Docker Desktop e o sbx",
	}
	vps := &noticeSpyRunner{id: protocol.EnvVPS, timeline: timeline, available: true}
	registry, bus := noticeToolbox(t, timeline, docker, vps)

	output, err := registry.Call(ctxComRoot(t.TempDir()), "proc.run", "s1",
		json.RawMessage(`{"command":"docker build ."}`))
	if err != nil {
		t.Fatalf("proc.run: %v", err)
	}

	// O downgrade NUNCA é silencioso: aviso primeiro, ai-jail depois.
	if len(timeline.events) != 2 || timeline.events[0] != "notice" || timeline.events[1] != "run:vps" {
		t.Fatalf("esperava [notice, run:vps], veio %q", timeline.events)
	}
	notice := decodeNotice(t, bus.envelopes[0])
	if !strings.Contains(notice.Title, "ai-jail") {
		t.Fatalf("o título tem de dizer para onde o passo caiu: %q", notice.Title)
	}
	// O aviso explica o downgrade: o motivo do sbx E o que o ai-jail não é.
	if !strings.Contains(notice.Detail, "não está instalado") ||
		!strings.Contains(notice.Detail, "não é isolamento de kernel") {
		t.Fatalf("o detalhe tem de explicar o downgrade inteiro: %q", notice.Detail)
	}
	if !strings.Contains(output, "[ambiente: vps]") {
		t.Fatalf("a saída tinha de vir carimbada da vps: %q", output)
	}
}

func TestProcRunComandoComumNaoDisparaAviso(t *testing.T) {
	timeline := &noticeLog{}
	docker := &noticeSpyRunner{id: protocol.EnvDocker, timeline: timeline, available: true}
	registry, bus := noticeToolbox(t, timeline, docker)

	// Comando sem nada de container, sessão no ambiente local: vai ao host,
	// sem popup nenhum — aviso de rotina é aviso que ninguém lê.
	if _, err := registry.Call(ctxComRoot(t.TempDir()), "proc.run", "s1",
		json.RawMessage(`{"command":"go build ./..."}`)); err != nil {
		t.Fatalf("proc.run: %v", err)
	}
	if len(bus.envelopes) != 0 || len(timeline.events) != 0 {
		t.Fatalf("nada podia ter sido anunciado nem rodado no sandbox: %q", timeline.events)
	}
}

func TestContainerIntentLeOComandoEONPedidoExplicito(t *testing.T) {
	cases := []struct {
		command string
		env     string
		wants   bool
	}{
		{"docker ps", "", true},
		{"docker-compose up -d", "", true},
		{"(docker build .)", "", true},
		{"podman container ls", "", true},
		{"go test ./...", "docker", true},
		{"go test ./...", "", false},
		{"echo dockerfile-parser", "", false},
		{"", "", false},
	}
	for _, each := range cases {
		if _, got := containerIntent(each.command, each.env); got != each.wants {
			t.Errorf("containerIntent(%q, %q): esperava %v, veio %v", each.command, each.env, each.wants, got)
		}
	}
}
