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
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
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
	// Nonce identifica a materialização dona do staging (ver
	// Execution.StagingNonce). Zero para execuções inplace.
	Nonce uint64
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
	// Origin diz quem está por trás do pedido — é ELA que decide o staging
	// (só OriginModel ganha cópia; ver as constantes em plan.go). Vazio cai em
	// inplace de propósito: um chamador novo que esqueça de declarar a origem
	// ganha o comportamento antigo e seguro, nunca uma cópia por acidente.
	Origin Origin
}

// Manager congela, materializa e promove.
type Manager struct {
	// roots resolve a pasta de projeto de uma sessão — o backend v1 do Source.
	roots  func(sessionID string) string
	leases Leases

	// O SANDBOX de staging da v1 (desligado até EnableStaging): o turno de
	// modelo sobre um workspace PROVISIONADO (<dataDir>/projects/…) trabalha
	// numa cópia em <dataDir>/staging/<plano>/ e só a promoção espelha o
	// resultado de volta. Os tetos existem porque copiar é O(bytes): um projeto
	// que os estoura degrada para inplace com aviso, em vez de travar o turno.
	stagingBase     string // <dataDir>/staging — vazio = staging desligado
	projectsBase    string // <dataDir>/projects — a única raiz que ganha cópia
	stagingMaxBytes int64
	stagingMaxFiles int

	// stagingMu guarda o mapa de nonces; stagingLocks serializa materializar/
	// promover/descartar POR PLANO — uma trava global seguraria toda sessão
	// enquanto uma cópia de 128 MiB anda.
	stagingMu     sync.Mutex
	stagingNonces map[string]uint64
	nonceSeq      uint64
	stagingLocks  sync.Map
}

// NewManager monta o gerente v1 local. `roots` é a MESMA função que antes
// alimentava o Toolbox.Root: a pasta de projeto gravada no meta da sessão.
func NewManager(roots func(sessionID string) string) *Manager {
	return &Manager{roots: roots, leases: localLeases{}}
}

// NewManagerWithLeases monta o gerente com um dono de leases DE VERDADE (a
// frota, com época persistida) no lugar do local/1 fixo da v1. É a troca de
// backend que o desenho prometia: a cerca não muda uma linha.
func NewManagerWithLeases(roots func(sessionID string) string, leases Leases) *Manager {
	if leases == nil {
		return NewManager(roots)
	}
	return &Manager{roots: roots, leases: leases}
}

// Tetos da cópia de segurança. Os workspaces provisionados são pequenos por
// construção; o teto existe para o dia em que alguém apontar (ou encher) um
// gigante — copiar 40 GB por turno não é sandbox, é pane de disco.
const (
	maxStagingBytes = 128 << 20 // 128 MiB
	maxStagingFiles = 4096
)

// EnableStaging liga o sandbox de staging: o turno de MODELO sobre uma raiz
// dentro de <dataDir>/projects/ passa a trabalhar numa cópia. Sem esta chamada
// (ou com dataDir vazio) TUDO segue inplace, como sempre foi.
func (m *Manager) EnableStaging(dataDir string) {
	m.EnableStagingWithLimits(dataDir, maxStagingBytes, maxStagingFiles)
}

// EnableStagingWithLimits existe para os testes apertarem o teto sem criar
// 4096 arquivos de verdade; a produção usa EnableStaging com os padrões.
func (m *Manager) EnableStagingWithLimits(dataDir string, maxBytes int64, maxFiles int) {
	if m == nil || strings.TrimSpace(dataDir) == "" {
		return
	}
	m.stagingBase = filepath.Join(dataDir, "staging")
	m.projectsBase = filepath.Join(dataDir, "projects")
	m.stagingMaxBytes = maxBytes
	m.stagingMaxFiles = maxFiles
	m.stagingNonces = make(map[string]uint64)
	// A VARREDURA DO BOOT: sobra de um processo morto no meio de um turno é
	// lixo por definição — o mapa de nonces morreu com o processo, então
	// nenhuma cópia órfã volta a ser promovível (Promote devolveria
	// ErrStaleStaging). Sem esta linha, o staging de uma sessão que nunca mais
	// roda ficaria no disco para sempre; a materialização só limpa a pasta do
	// PRÓPRIO plano. Falha de remoção não derruba o boot: a próxima
	// materialização do mesmo plano ainda limpa a própria sobra.
	_ = os.RemoveAll(m.stagingBase)
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
	// Determinístico de propósito: mesmo pedido, mesmo id — sem relógio nem
	// aleatório, o plano sobrevive a replay e a comparação em teste.
	planID := fmt.Sprintf("wp-%s-%s-%d", sessionID, taskID, attempt)

	// A DECISÃO do staging mora aqui, no congelamento: turno de MODELO sobre
	// raiz provisionada ganha cópia; todo o resto — a UI (edição direta da
	// pessoa), a equipe (worktree é o isolamento dela) e a raiz apontada pela
	// pessoa (potencialmente gigante; a resposta para repositório grande é
	// worktree/Puter, não cópia cega) — segue inplace, como sempre foi.
	staging := Staging{URI: InplaceStaging}
	if request.Origin == OriginModel && m.stagesRoot(root) {
		staging = Staging{URI: StagingURIPrefix + planID}
	}

	plan := Plan{
		ID:         planID,
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
		Staging:  staging,
		Baseline: Baseline{Revision: LiveRevision, ManifestDigest: LiveRevision},
	}
	if err := plan.Validate(); err != nil {
		return Plan{}, err
	}
	return plan, nil
}

// Materialize transforma o plano em execução NESTA máquina. No backend local é
// resolver a URI de volta para a pasta; num plano com staging real é COPIAR o
// projeto para <dataDir>/staging/<plano>/ e apontar a execução para a cópia —
// as ferramentas do turno agem nela sem saber que é uma. No Puter será baixar
// snapshot + montar o workspace + preparar o git sombra.
func (m *Manager) Materialize(_ context.Context, plan Plan) (*Execution, error) {
	if err := plan.Validate(); err != nil {
		return nil, err
	}
	if plan.Source.Provider != LocalProvider {
		return nil, fmt.Errorf("esta máquina não sabe materializar o provider %q", plan.Source.Provider)
	}
	root := localPath(plan.Source.URI)
	if plan.Staged() && m.stagingBase != "" && root != "" {
		return m.materializeStaging(plan, root)
	}
	return &Execution{Plan: plan, LocalRoot: root}, nil
}

// Promote é a CERCA em código: só o worker que detém o lease, na época em que
// o plano foi congelado, transforma staging em verdade. Depois da cerca vem o
// ESPELHO — novo e alterado copiados ao projeto, sumido apagado dele — e só
// então o staging some. Idempotente: promover o que já foi promovido (ou
// descartado) é um não-op, nunca um segundo espelho.
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
		// Execução inplace (UI, equipe, raiz da pessoa, staging degradado): o
		// trabalho já está no workspace — promover é constatar.
		return nil
	}
	if strings.HasPrefix(result.StagingURI, StagingURIPrefix) && m.stagingBase != "" {
		return m.promoteStaging(plan, result)
	}
	return fmt.Errorf("esta máquina não sabe promover %q", result.StagingURI)
}

// Discard joga fora o staging SEM tocar o projeto: é o desfecho de falha,
// interrupção, recusa e do portão que narrou sem executar — nada meio-escrito
// chega à pessoa. Sem cerca de propósito: jogar fora a própria cópia não
// publica verdade nenhuma, então não precisa de lease. Idempotente.
func (m *Manager) Discard(_ context.Context, plan Plan, result Publication) error {
	if m == nil {
		return nil
	}
	if !strings.HasPrefix(result.StagingURI, StagingURIPrefix) || m.stagingBase == "" {
		// Inplace não tem o que descartar — o trabalho (se houve) já é do
		// projeto, e "desfazê-lo" seria inventar um undo que não existe.
		return nil
	}
	return m.discardStaging(plan, result)
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
