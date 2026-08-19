package workspace

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// O plano incompleto não passa, e o erro DIZ o que falta. Um plano é o
// contrato da execução; validar campo a campo é o que impede o cluster de
// nascer com esperanças no lugar de decisões.
func TestPlanValidateExigeCadaCampo(t *testing.T) {
	completo := func() Plan {
		return Plan{
			ID: "wp-1", UserID: "paim", GoalID: "goal-crm", TaskID: "t7", BotID: "code",
			Attempt: 1, WorkerID: "pc-02", LeaseEpoch: 17,
			Source:   Source{Provider: "puter", URI: "puter:///Goals/goal-crm/workspace", Revision: "sha256:c15a"},
			Runtime:  Runtime{SnapshotDigest: "sha256:9921"},
			Staging:  Staging{URI: "puter:///Goals/goal-crm/staging/t7/epoch-17"},
			Baseline: Baseline{Revision: "sha256:c15a", ManifestDigest: "sha256:54f"},
		}
	}
	if err := completo().Validate(); err != nil {
		t.Fatalf("o plano completo tinha de passar: %v", err)
	}

	quebras := map[string]func(*Plan){
		"id":         func(p *Plan) { p.ID = " " },
		"userId":     func(p *Plan) { p.UserID = "" },
		"goalId":     func(p *Plan) { p.GoalID = "" },
		"taskId":     func(p *Plan) { p.TaskID = "" },
		"botId":      func(p *Plan) { p.BotID = "" },
		"attempt":    func(p *Plan) { p.Attempt = 0 },
		"workerId":   func(p *Plan) { p.WorkerID = "" },
		"leaseEpoch": func(p *Plan) { p.LeaseEpoch = 0 },
		"provider":   func(p *Plan) { p.Source.Provider = "" },
		"uri":        func(p *Plan) { p.Source.URI = "" },
		"revision":   func(p *Plan) { p.Source.Revision = "" },
		"snapshot":   func(p *Plan) { p.Runtime.SnapshotDigest = "" },
		"staging":    func(p *Plan) { p.Staging.URI = "" },
		"baseline":   func(p *Plan) { p.Baseline.ManifestDigest = "" },
	}
	for nome, quebra := range quebras {
		plano := completo()
		quebra(&plano)
		if err := plano.Validate(); err == nil {
			t.Errorf("plano sem %s passou na validação", nome)
		}
	}
}

// O contexto carrega a execução — e SÓ ele. Require sem execução recusa com
// motivo; execução sem root materializado também.
func TestRequireExigeExecucaoMaterializada(t *testing.T) {
	if _, err := Require(context.Background()); !errors.Is(err, ErrNoExecution) {
		t.Fatalf("contexto cru tinha de recusar com ErrNoExecution, veio %v", err)
	}

	semRoot := WithExecution(context.Background(), &Execution{})
	if _, err := Require(semRoot); err == nil {
		t.Fatal("execução sem root materializado tinha de recusar")
	}

	ctx := WithExecution(context.Background(), &Execution{LocalRoot: "C:/projeto"})
	execution, err := Require(ctx)
	if err != nil {
		t.Fatalf("execução materializada tinha de passar: %v", err)
	}
	if execution.LocalRoot != "C:/projeto" {
		t.Fatalf("root errado: %q", execution.LocalRoot)
	}

	// Nil não pendura nada: quem consultar recebe o mesmo erro do contexto cru.
	if _, err := Require(WithExecution(context.Background(), nil)); !errors.Is(err, ErrNoExecution) {
		t.Fatalf("WithExecution(nil) não pode fingir que há workspace: %v", err)
	}
}

// O caminho v1 inteiro: congelar → materializar → mesmo root para todo mundo.
func TestManagerV1CongelaEMaterializaLocal(t *testing.T) {
	manager := NewManager(func(sessionID string) string {
		if sessionID == "s-1" {
			return `C:\projeto`
		}
		return ""
	})

	plan, err := manager.Plan(context.Background(), PlanRequest{SessionID: "s-1", BotID: "code"})
	if err != nil {
		t.Fatalf("congelar: %v", err)
	}
	if plan.WorkerID != LocalWorker || plan.LeaseEpoch != 1 {
		t.Fatalf("a v1 é o worker local na época 1, veio %s/%d", plan.WorkerID, plan.LeaseEpoch)
	}
	if strings.Contains(plan.Source.URI, `\`) {
		t.Fatalf("a URI persistente não pode carregar separador de uma máquina: %q", plan.Source.URI)
	}

	execution, err := manager.Materialize(context.Background(), plan)
	if err != nil {
		t.Fatalf("materializar: %v", err)
	}
	if execution.LocalRoot != "C:/projeto" {
		t.Fatalf("root materializado errado: %q", execution.LocalRoot)
	}

	// O mesmo pedido congela o MESMO plano: sem relógio nem aleatório, replay e
	// reexecução convergem.
	segundo, err := manager.Plan(context.Background(), PlanRequest{SessionID: "s-1", BotID: "code"})
	if err != nil || segundo.ID != plan.ID {
		t.Fatalf("o plano tinha de ser determinístico: %q vs %q (%v)", plan.ID, segundo.ID, err)
	}
}

// Sessão sem pasta de projeto: o plano nasce válido, a materialização produz
// root VAZIO, e quem recusa é a ferramenta — com o motivo de sempre. Cair na
// pasta do processo seria trabalhar dentro do binário do gateway.
func TestManagerSemPastaMaterializaVazio(t *testing.T) {
	manager := NewManager(func(string) string { return "" })

	plan, err := manager.Plan(context.Background(), PlanRequest{SessionID: "s-solta"})
	if err != nil {
		t.Fatalf("congelar sem pasta: %v", err)
	}
	execution, err := manager.Materialize(context.Background(), plan)
	if err != nil {
		t.Fatalf("materializar sem pasta: %v", err)
	}
	if execution.LocalRoot != "" {
		t.Fatalf("sem pasta o root tinha de ser vazio, veio %q", execution.LocalRoot)
	}
}

// leasesDeMentira permite encenar a perda do lease.
type leasesDeMentira struct{ lease Lease }

func (l leasesDeMentira) CurrentLease(context.Context, string) (Lease, error) {
	return l.lease, nil
}

// A CERCA: o worker que perdeu o lease pode terminar, mas não vira verdade.
// É o cenário PC-02 época 5 → rede cai → PC-03 época 6 → PC-02 volta e tenta
// publicar: staging aceito, promoção recusada.
func TestPromoteRecusaEpocaVelha(t *testing.T) {
	manager := NewManager(func(string) string { return "C:/projeto" })

	plan, err := manager.Plan(context.Background(), PlanRequest{SessionID: "s-1", TaskID: "t1"})
	if err != nil {
		t.Fatalf("congelar: %v", err)
	}

	// Com o lease em dia, a promoção v1 passa.
	if err := manager.Promote(context.Background(), plan, Publication{StagingURI: InplaceStaging}); err != nil {
		t.Fatalf("promoção com lease em dia: %v", err)
	}

	// O lease andou (outro worker, outra época): o plano congelado ficou velho.
	manager.leases = leasesDeMentira{lease: Lease{WorkerID: "pc-03", Epoch: 6}}
	err = manager.Promote(context.Background(), plan, Publication{StagingURI: InplaceStaging})
	if !errors.Is(err, ErrStaleWorkspace) {
		t.Fatalf("a época velha tinha de bater na cerca, veio %v", err)
	}
}
