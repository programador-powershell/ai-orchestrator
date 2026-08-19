// O gerente de workspaces: congela o plano, materializa e promove com cerca.
//
// A v1 é o backend LOCAL: uma sessão trabalha na pasta de projeto dela (o CWD
// do meta), o worker é este processo e a época é sempre 1. O que muda AGORA é a
// arquitetura — Task → Plan → fs/git/proc no mesmo root, com a cerca de
// promoção já no caminho — e o que muda DEPOIS é só o backend: Puter no
// Source/Staging, worker-daemon no Materialize, lease distribuído no Leases.
package workspace

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"strings"
)

// ErrStaleWorkspace é a CERCA: o plano foi congelado com um worker/época que
// não detém mais o lease da tarefa. Um worker velho pode até terminar o
// trabalho; ele não consegue transformá-lo em verdade.
var ErrStaleWorkspace = errors.New("workspace de uma época que já passou — o lease é de outro worker")

// Lease é quem detém a tarefa agora, e desde qual época.
type Lease struct {
	WorkerID string
	Epoch    uint64
}

// Leases responde quem detém cada tarefa. A v1 responde sempre o worker local
// na época 1; o lease distribuído (banco compartilhado) troca esta interface
// por uma implementação de verdade, sem tocar na cerca.
type Leases interface {
	CurrentLease(ctx context.Context, taskID string) (Lease, error)
}

// localLeases é o v1: um processo, um worker, época fixa.
type localLeases struct{}

func (localLeases) CurrentLease(context.Context, string) (Lease, error) {
	return Lease{WorkerID: LocalWorker, Epoch: 1}, nil
}

// Publication é o que o worker publicou no staging e quer promover.
type Publication struct {
	StagingURI string
}

// PlanRequest é o que o chamador sabe na hora de congelar. O resto (source,
// runtime, staging, baseline) é decisão do gerente.
type PlanRequest struct {
	SessionID string
	// TaskID vazio = turno de conversa, fora de uma Task de equipe.
	TaskID string
	BotID  string
	// Attempt zero vira 1: a primeira tentativa.
	Attempt int
}

// Manager congela, materializa e promove.
type Manager struct {
	// roots resolve a pasta de projeto de uma sessão — o backend v1 do Source.
	roots  func(sessionID string) string
	leases Leases
}

// NewManager monta o gerente v1 local. `roots` é a MESMA função que antes
// alimentava o Toolbox.Root: a pasta de projeto gravada no meta da sessão.
func NewManager(roots func(sessionID string) string) *Manager {
	return &Manager{roots: roots, leases: localLeases{}}
}

// Plan congela o contrato da execução. É AQUI que worker, época e workspace
// são decididos — a ferramenta lá na ponta só lê o que foi congelado.
func (m *Manager) Plan(ctx context.Context, request PlanRequest) (Plan, error) {
	if m == nil {
		return Plan{}, errors.New("gerente de workspace não configurado")
	}
	sessionID := strings.TrimSpace(request.SessionID)
	if sessionID == "" {
		return Plan{}, errors.New("plano de workspace sem sessão")
	}
	taskID := strings.TrimSpace(request.TaskID)
	if taskID == "" {
		// Turno de conversa: a "tarefa" é a própria sessão. Quando as Tasks de
		// equipe passarem pelo scheduler, elas mandam o id de verdade.
		taskID = "chat-" + sessionID
	}
	botID := strings.TrimSpace(request.BotID)
	if botID == "" {
		botID = "chat"
	}
	attempt := request.Attempt
	if attempt <= 0 {
		attempt = 1
	}

	lease, err := m.leases.CurrentLease(ctx, taskID)
	if err != nil {
		return Plan{}, fmt.Errorf("consultar o lease de %s: %w", taskID, err)
	}

	root := ""
	if m.roots != nil {
		root = strings.TrimSpace(m.roots(sessionID))
	}
	plan := Plan{
		// Determinístico de propósito: mesmo pedido, mesmo id — sem relógio nem
		// aleatório, o plano sobrevive a replay e a comparação em teste.
		ID:         fmt.Sprintf("wp-%s-%s-%d", sessionID, taskID, attempt),
		UserID:     LocalWorker, // v1: máquina de uma pessoa; o multiusuário chega com o Puter
		GoalID:     "goal-" + sessionID,
		SessionID:  sessionID,
		TaskID:     taskID,
		BotID:      botID,
		Attempt:    attempt,
		WorkerID:   lease.WorkerID,
		LeaseEpoch: lease.Epoch,
		Source: Source{
			Provider: LocalProvider,
			URI:      localURI(root),
			Revision: LiveRevision,
		},
		Runtime: Runtime{
			Profile:        HostSnapshot,
			SnapshotDigest: HostSnapshot,
			Arch:           runtime.GOARCH,
		},
		Staging:  Staging{URI: InplaceStaging},
		Baseline: Baseline{Revision: LiveRevision, ManifestDigest: LiveRevision},
	}
	if err := plan.Validate(); err != nil {
		return Plan{}, err
	}
	return plan, nil
}

// Materialize transforma o plano em execução NESTA máquina. No backend local é
// resolver a URI de volta para a pasta; no Puter será baixar snapshot + montar
// o workspace + preparar o git sombra.
func (m *Manager) Materialize(_ context.Context, plan Plan) (*Execution, error) {
	if err := plan.Validate(); err != nil {
		return nil, err
	}
	if plan.Source.Provider != LocalProvider {
		return nil, fmt.Errorf("esta máquina não sabe materializar o provider %q", plan.Source.Provider)
	}
	return &Execution{Plan: plan, LocalRoot: localPath(plan.Source.URI)}, nil
}

// Promote é a CERCA em código: só o worker que detém o lease, na época em que
// o plano foi congelado, transforma staging em verdade. A v1 não tem staging
// separado (escreve direto), mas a checagem já mora aqui — quando o staging do
// Puter entrar, nenhum chamador precisa aprender uma regra nova.
func (m *Manager) Promote(ctx context.Context, plan Plan, result Publication) error {
	if m == nil {
		return errors.New("gerente de workspace não configurado")
	}
	current, err := m.leases.CurrentLease(ctx, plan.TaskID)
	if err != nil {
		return fmt.Errorf("consultar o lease de %s: %w", plan.TaskID, err)
	}
	if current.WorkerID != plan.WorkerID || current.Epoch != plan.LeaseEpoch {
		return ErrStaleWorkspace
	}
	if result.StagingURI == InplaceStaging {
		// v1: o trabalho já está no workspace — promover é constatar.
		return nil
	}
	return fmt.Errorf("esta máquina não sabe promover %q", result.StagingURI)
}

/* -------------------------------- URIs ----------------------------------- */

// localURI codifica a pasta como URI do provider local. Vazio vira
// "local://sem-pasta" — um plano VÁLIDO cuja materialização produz root vazio,
// e aí as ferramentas de arquivo recusam com o motivo de sempre.
func localURI(root string) string {
	if root == "" {
		return "local://sem-pasta"
	}
	return "local://" + strings.ReplaceAll(root, "\\", "/")
}

// localPath desfaz localURI. É a ÚNICA tradução URI→caminho da v1.
func localPath(uri string) string {
	rest, found := strings.CutPrefix(uri, "local://")
	if !found || rest == "sem-pasta" {
		return ""
	}
	return rest
}
