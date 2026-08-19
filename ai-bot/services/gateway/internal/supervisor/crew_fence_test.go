// A cerca do cluster no ponto em que ela importa: o trabalhador executa
// EXATAMENTE o plano que foi despachado, e o resultado só vira verdade se o
// lease ainda for dele na época congelada.
package supervisor

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"aibot/gateway/internal/eventbus"
	"aibot/gateway/internal/permissions"
	"aibot/gateway/internal/protocol"
	"aibot/gateway/internal/store"
	"aibot/gateway/internal/workspace"
)

// leaseComandavel encena a perda do lease NO MEIO da execução.
type leaseComandavel struct {
	mu    sync.Mutex
	lease workspace.Lease
}

func (l *leaseComandavel) CurrentLease(context.Context, string) (workspace.Lease, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.lease, nil
}

func (l *leaseComandavel) trocaPara(worker string, epoch uint64) {
	l.mu.Lock()
	l.lease = workspace.Lease{WorkerID: worker, Epoch: epoch}
	l.mu.Unlock()
}

func fenceHarness(t *testing.T, leases *leaseComandavel, answer string) (*Supervisor, *workspace.Manager) {
	t.Helper()
	dataStore, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("abrir o store: %v", err)
	}
	t.Cleanup(func() { _ = dataStore.Close() })
	if _, err := dataStore.CreateSession(store.SessionMeta{ID: "s1", Title: "t", CWD: t.TempDir()}); err != nil {
		t.Fatalf("criar sessão: %v", err)
	}

	server := scriptedProvider(t, []string{answer}, nil)
	t.Cleanup(server.Close)

	manager := workspace.NewManagerWithLeases(func(string) string { return "C:/projeto" }, leases)
	supervisor := New(Deps{
		Store:      dataStore,
		Bus:        eventbus.New(dataStore),
		Models:     scriptedRouter(server.URL),
		Gate:       permissions.NewGate(permissions.DefaultPolicy()),
		Tools:      NewRegistry(),
		Workspaces: manager,
	})
	return supervisor, manager
}

// O caminho feliz: plano congelado → materializado → executado → PROMOVIDO.
func TestRunWorkerExecutaOPlanoDespachadoEPromove(t *testing.T) {
	leases := &leaseComandavel{lease: workspace.Lease{WorkerID: "pc-02", Epoch: 5}}
	supervisor, manager := fenceHarness(t, leases, "tarefa cumprida")

	plan, err := manager.Plan(context.Background(), workspace.PlanRequest{
		SessionID: "s1", TaskID: "t1", BotID: "code",
	})
	if err != nil {
		t.Fatalf("congelar: %v", err)
	}
	if plan.WorkerID != "pc-02" || plan.LeaseEpoch != 5 {
		t.Fatalf("o plano não congelou o lease da frota: %+v", plan)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	done := supervisor.runWorker(ctx, "s1", "turno-1",
		protocol.Task{ID: "t1", Title: "tarefa", Specialist: "code", Goal: "faça"},
		"w-1-t1", 1, &plan, nil)

	if !done.OK || done.Error != "" {
		t.Fatalf("o caminho feliz tinha de promover: %+v", done)
	}
}

// O cenário PC-02/PC-03: o worker TERMINA, mas o lease andou no meio — o
// resultado não vira verdade, e o desfecho DIZ por quê.
func TestRunWorkerRecusaResultadoDeEpocaVelha(t *testing.T) {
	leases := &leaseComandavel{lease: workspace.Lease{WorkerID: "pc-02", Epoch: 5}}
	supervisor, manager := fenceHarness(t, leases, "trabalho da época velha")

	plan, err := manager.Plan(context.Background(), workspace.PlanRequest{
		SessionID: "s1", TaskID: "t1", BotID: "code",
	})
	if err != nil {
		t.Fatalf("congelar: %v", err)
	}

	// PC-02 perdeu a rede; PC-03 assumiu na época 6 — ANTES de o resultado
	// voltar.
	leases.trocaPara("pc-03", 6)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	done := supervisor.runWorker(ctx, "s1", "turno-1",
		protocol.Task{ID: "t1", Title: "tarefa", Specialist: "code", Goal: "faça"},
		"w-1-t1", 1, &plan, nil)

	if done.OK {
		t.Fatal("o resultado de uma época que já passou virou verdade")
	}
	if !strings.Contains(done.Error, "promovido") {
		t.Fatalf("o desfecho tinha de dizer que a promoção falhou: %q", done.Error)
	}
}
