// Testes dos ganchos de ciclo de vida (hooks.go).
//
// Os três contratos que não podem quebrar, na ordem do risco:
//
//  1. deny RECUSA a ferramenta antes de ela rodar — é a política de pacote;
//  2. falha de gancho observador (webhook fora do ar, disco cheio) NUNCA
//     derruba o turno — auditoria que mata a resposta vira auditoria desligada;
//  3. o audit.log escreve linha legível e rotaciona no teto — trilha que cresce
//     sem limite é trilha que ninguém consegue anexar num chamado.
package supervisor

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"aibot/gateway/internal/eventbus"
	"aibot/gateway/internal/permissions"
	"aibot/gateway/internal/protocol"
	"aibot/gateway/internal/specialist"
	"aibot/gateway/internal/store"
)

/* ------------------------------- auxiliares ------------------------------- */

// hookActor é o ator dos executeTool destes testes.
func hookActor() protocol.Actor {
	return protocol.Actor{Kind: protocol.ActorSpecialist, ID: "chat", Specialist: "chat"}
}

func testInfo(event HookEvent, tool string) HookInfo {
	return HookInfo{
		Event: event, TS: time.Now().UTC(),
		Session: "s-hooks", Turn: "t1", Specialist: "chat",
		Tool: tool, Digest: "abcd1234", OK: true,
	}
}

// auditLines lê as linhas JSON do audit.log dado.
func auditLines(t *testing.T, path string) []HookInfo {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ler %s: %v", path, err)
	}
	var out []HookInfo
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		if line == "" {
			continue
		}
		var info HookInfo
		if err := json.Unmarshal([]byte(line), &info); err != nil {
			t.Fatalf("linha de auditoria ilegível %q: %v", line, err)
		}
		out = append(out, info)
	}
	return out
}

/* --------------------------------- audit ---------------------------------- */

func TestAuditEscreveLinhaLegivelERotacionaNoTeto(t *testing.T) {
	dataDir := t.TempDir()
	runner := NewHookRunner(dataDir, nil, nil)
	runner.Register("financeiro-empresa", []Hook{{On: HookAfterTool, Action: "audit"}})

	runner.Notify(context.Background(), testInfo(HookAfterTool, "fs.write"))

	logPath := filepath.Join(dataDir, "audit.log")
	lines := auditLines(t, logPath)
	if len(lines) != 1 {
		t.Fatalf("esperava 1 linha de auditoria, obtive %d", len(lines))
	}
	got := lines[0]
	if got.Session != "s-hooks" || got.Tool != "fs.write" || got.Digest != "abcd1234" || !got.OK {
		t.Errorf("a linha precisa dizer quem, o quê e o desfecho; obtive %+v", got)
	}

	// Rotação: com o teto encolhido, a próxima escrita encontra o arquivo já
	// acima do limite e o gira para .1 antes de gravar.
	runner.auditMax = 1
	runner.Notify(context.Background(), testInfo(HookAfterTool, "fs.patch"))

	rotated := auditLines(t, logPath+".1")
	if len(rotated) != 1 || rotated[0].Tool != "fs.write" {
		t.Errorf("audit.log.1 precisa guardar a geração anterior; obtive %+v", rotated)
	}
	current := auditLines(t, logPath)
	if len(current) != 1 || current[0].Tool != "fs.patch" {
		t.Errorf("audit.log precisa recomeçar com a linha nova; obtive %+v", current)
	}
}

// fs.write CONTA como edição: um gancho registrado em after_edit dispara para
// ela sem precisar repetir a lista de ferramentas no manifesto.
func TestGanchoDeEdicaoCasaComFerramentaDeEdicao(t *testing.T) {
	dataDir := t.TempDir()
	runner := NewHookRunner(dataDir, nil, nil)
	runner.Register("si", []Hook{{On: HookAfterEdit, Action: "audit"}})

	runner.Notify(context.Background(), testInfo(HookAfterTool, "fs.write"))
	runner.Notify(context.Background(), testInfo(HookAfterTool, "web.fetch"))

	lines := auditLines(t, filepath.Join(dataDir, "audit.log"))
	if len(lines) != 1 || lines[0].Tool != "fs.write" {
		t.Fatalf("after_edit deve casar só com edição (fs.write), obtive %+v", lines)
	}
}

/* ---------------------------------- deny ----------------------------------- */

func TestDenyRecusaBeforeToolEAuditoriaRegistraATentativa(t *testing.T) {
	dataDir := t.TempDir()
	runner := NewHookRunner(dataDir, nil, nil)
	runner.Register("si", []Hook{
		{On: HookBeforeTool, Tool: "fs.read", Action: "audit"},
		{On: HookBeforeTool, Tool: "fs.read", Action: "deny"},
	})

	denied, reason := runner.Before(context.Background(), testInfo(HookBeforeTool, "fs.read"))
	if !denied {
		t.Fatal("esperava o deny recusar a ferramenta, foi liberada")
	}
	if !strings.Contains(reason, "si") || !strings.Contains(reason, "fs.read") {
		t.Errorf("a recusa precisa dizer o pacote e a ferramenta; obtive %q", reason)
	}
	// A tentativa recusada TAMBÉM entra na trilha — auditoria que só vê o que
	// passou não é auditoria.
	if lines := auditLines(t, filepath.Join(dataDir, "audit.log")); len(lines) != 1 {
		t.Errorf("a tentativa recusada precisa estar na auditoria; obtive %+v", lines)
	}

	// Outra ferramenta não é atingida pela regra.
	if denied, _ := runner.Before(context.Background(), testInfo(HookBeforeTool, "web.fetch")); denied {
		t.Error("o deny de fs.read não pode recusar web.fetch")
	}
}

// O deny declarado em before_edit alcança fs.write pelo caminho normal do
// turno (que emite before_tool): é a expansão de eventos funcionando de ponta
// a ponta, dentro do executeTool — a ferramenta NÃO pode rodar.
func TestDenyDePacoteRecusaDentroDoExecuteTool(t *testing.T) {
	dataStore, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("abrir o store: %v", err)
	}
	defer dataStore.Close()
	const sessionID = "s-deny"
	if _, err := dataStore.CreateSession(store.SessionMeta{ID: sessionID, Title: "hooks"}); err != nil {
		t.Fatalf("criar sessão: %v", err)
	}

	executed := false
	registry := NewRegistry()
	registry.Register("fs.read", "lê um arquivo", func(context.Context, string, json.RawMessage) (string, error) {
		executed = true
		return "conteudo-secreto", nil
	})

	runner := NewHookRunner(t.TempDir(), nil, nil)
	runner.Register("si", []Hook{{On: HookBeforeTool, Tool: "fs.read", Action: "deny"}})

	supervisor := New(Deps{
		Store: dataStore,
		Bus:   eventbus.New(dataStore),
		Gate:  permissions.NewGate(permissions.DefaultPolicy()),
		Tools: registry,
		Hooks: runner,
	})

	back := supervisor.executeTool(context.Background(), sessionID, "t1",
		hookActor(), specialist.GetOrDefault("chat"),
		toolInvocation{Tool: "fs.read", Args: json.RawMessage(`{"path":"a.txt"}`)})

	if executed {
		t.Fatal("a ferramenta rodou apesar do deny — o gancho precisa vir ANTES da execução")
	}
	if !strings.Contains(back, "RECUSADO PELA POLÍTICA DE PACOTE") || !strings.Contains(back, "si") {
		t.Errorf("o modelo precisa ler a recusa com o pacote; obtive %q", back)
	}
}

/* --------------------------------- webhook --------------------------------- */

// Webhook fora do ar não derruba o turno: a ferramenta executa, o resultado
// volta ao modelo e a falha do gancho fica no log do processo.
func TestFalhaDeWebhookNaoDerrubaOTurno(t *testing.T) {
	dataStore, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("abrir o store: %v", err)
	}
	defer dataStore.Close()
	const sessionID = "s-webhook"
	if _, err := dataStore.CreateSession(store.SessionMeta{ID: sessionID, Title: "hooks"}); err != nil {
		t.Fatalf("criar sessão: %v", err)
	}

	registry := NewRegistry()
	registry.Register("fs.read", "lê um arquivo", func(context.Context, string, json.RawMessage) (string, error) {
		return "conteudo-do-arquivo", nil
	})

	calls := 0
	runner := NewHookRunner(t.TempDir(), func(context.Context, string, json.RawMessage) error {
		calls++
		return errors.New("webhook fora do ar")
	}, nil)
	runner.Register("si", []Hook{{On: HookAfterTool, Action: "webhook", SecretRef: "webhook.si"}})

	supervisor := New(Deps{
		Store: dataStore,
		Bus:   eventbus.New(dataStore),
		Gate:  permissions.NewGate(permissions.DefaultPolicy()),
		Tools: registry,
		Hooks: runner,
	})

	back := supervisor.executeTool(context.Background(), sessionID, "t1",
		hookActor(), specialist.GetOrDefault("chat"),
		toolInvocation{Tool: "fs.read", Args: json.RawMessage(`{"path":"a.txt"}`)})

	if calls != 1 {
		t.Fatalf("o gancho webhook precisa ter sido chamado uma vez, foi %d", calls)
	}
	if !strings.Contains(back, "conteudo-do-arquivo") {
		t.Errorf("a falha do webhook não pode engolir o resultado da ferramenta; obtive %q", back)
	}

	// E o on_error também não pode entrar em pânico com o webhook quebrado.
	runner.Register("si", []Hook{{On: HookOnError, Action: "webhook", SecretRef: "webhook.si"}})
	supervisor.fail(sessionID, "t1", "chat", "modelo", "falhou de mentira", false)
	if calls != 2 {
		t.Errorf("o on_error precisa ter disparado o webhook, chamadas: %d", calls)
	}
}

// O contexto do webhook é DESTACADO do turno: o on_error de um turno cancelado
// dispara com o contexto já morto — e é justamente o evento que a SI quer.
func TestWebhookDisparaMesmoComTurnoCancelado(t *testing.T) {
	fired := false
	var sawDeadline bool
	runner := NewHookRunner(t.TempDir(), func(ctx context.Context, _ string, _ json.RawMessage) error {
		fired = true
		_, sawDeadline = ctx.Deadline()
		return ctx.Err()
	}, nil)
	runner.Register("si", []Hook{{On: HookOnError, Action: "webhook", SecretRef: "webhook.si"}})

	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	runner.Notify(canceled, testInfo(HookOnError, ""))

	if !fired {
		t.Fatal("o webhook precisa disparar mesmo com o contexto do turno cancelado")
	}
	if !sawDeadline {
		t.Error("o contexto destacado precisa de prazo próprio — sem ele, destacar vira espera infinita")
	}
}
