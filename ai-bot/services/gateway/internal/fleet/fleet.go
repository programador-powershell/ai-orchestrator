// Package fleet é o registro de WORKERS e o dono dos LEASES de tarefa.
//
// É a fase 2 do cluster (docs/arquitetura-cluster.md): antes de existirem
// vários PCs, as ENTIDADES já existem — o worker é registrado com identidade
// real (pc-<hostname>, arquitetura, CPUs), o lease de cada tarefa tem dono e
// ÉPOCA persistidos em disco, e o heartbeat mantém os dois vivos. Quando o
// worker-daemon remoto entrar, ele se registra aqui e disputa os mesmos
// leases; a cerca do workspace (Promote) não aprende regra nova.
//
// A época é o coração: ela SOBREVIVE ao reinício do processo. Sem isso, um
// gateway que cai e volta recomeçaria toda tarefa na época 1 — e o resultado
// de um worker antigo, congelado numa época "1" anterior, passaria pela cerca
// como se fosse atual.
package fleet

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"aibot/gateway/internal/workspace"
)

// leaseTTL é a validade de um lease sem renovação. Curto o bastante para uma
// tarefa órfã (worker morto) ser reatribuível em minutos, longo o bastante
// para uma rodada lenta de modelo não perder o próprio lease.
const leaseTTL = 3 * time.Minute

// ErrLeaseHeld diz que OUTRO worker detém a tarefa e o lease ainda vale.
var ErrLeaseHeld = errors.New("a tarefa está com outro worker e o lease ainda vale")

// Worker é um PC registrado.
type Worker struct {
	ID       string    `json:"id"`
	Hostname string    `json:"hostname"`
	Arch     string    `json:"arch"`
	CPUs     int       `json:"cpus"`
	LastSeen time.Time `json:"lastSeen"`
}

type leaseRecord struct {
	WorkerID  string    `json:"workerId"`
	Epoch     uint64    `json:"epoch"`
	ExpiresAt time.Time `json:"expiresAt"`
}

// Fleet guarda workers e leases num diretório próprio do DataDir.
type Fleet struct {
	mu      sync.Mutex
	dir     string
	self    Worker
	workers map[string]Worker
	leases  map[string]leaseRecord
	// ttl é campo (e não a constante direto) para o teste poder encenar o
	// vencimento sem esperar três minutos de relógio.
	ttl time.Duration
}

// Open carrega (ou cria) o registro e INSCREVE este processo como worker
// local, com identidade de máquina de verdade — é o "pc-02" da v1.
func Open(dataDir string) (*Fleet, error) {
	if strings.TrimSpace(dataDir) == "" {
		return nil, errors.New("fleet sem diretório de dados")
	}
	dir := filepath.Join(dataDir, "fleet")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("criar diretório da frota: %w", err)
	}

	f := &Fleet{
		dir:     dir,
		workers: map[string]Worker{},
		leases:  map[string]leaseRecord{},
		ttl:     leaseTTL,
	}
	_ = readJSONFile(filepath.Join(dir, "workers.json"), &f.workers)
	_ = readJSONFile(filepath.Join(dir, "leases.json"), &f.leases)

	hostname, err := os.Hostname()
	if err != nil || strings.TrimSpace(hostname) == "" {
		hostname = "local"
	}
	f.self = Worker{
		ID:       "pc-" + safeName(hostname),
		Hostname: hostname,
		Arch:     runtime.GOARCH,
		CPUs:     runtime.NumCPU(),
		LastSeen: time.Now().UTC(),
	}
	f.workers[f.self.ID] = f.self
	if err := f.persistWorkersLocked(); err != nil {
		return nil, err
	}
	return f, nil
}

// Self devolve a identidade deste worker.
func (f *Fleet) Self() Worker {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.self
}

// Heartbeat renova o "estou vivo" do worker local. Quem chama é o laço de
// batimento do main; o daemon remoto fará o mesmo pela rede.
func (f *Fleet) Heartbeat() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.self.LastSeen = time.Now().UTC()
	f.workers[f.self.ID] = f.self
	_ = f.persistWorkersLocked()
}

// Workers lista os registrados, com o mais recente batimento primeiro.
func (f *Fleet) Workers() []Worker {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]Worker, 0, len(f.workers))
	for _, worker := range f.workers {
		out = append(out, worker)
	}
	return out
}

/* --------------------------------- leases --------------------------------- */

// Acquire toma (ou renova) o lease de uma tarefa para um worker.
//
// As três saídas são exatamente as do desenho do cluster:
//   - o próprio dono renova: MESMA época, validade estendida;
//   - lease vago ou vencido: época ANDA (nunca volta), novo dono;
//   - outro dono com lease válido: recusa — lease não se rouba, se espera vencer.
func (f *Fleet) Acquire(taskID, workerID string) (workspace.Lease, error) {
	taskID = strings.TrimSpace(taskID)
	if taskID == "" {
		return workspace.Lease{}, errors.New("lease sem tarefa")
	}
	f.mu.Lock()
	defer f.mu.Unlock()

	now := time.Now().UTC()
	current, exists := f.leases[taskID]
	switch {
	case exists && current.WorkerID == workerID:
		current.ExpiresAt = now.Add(f.ttl)
	case exists && now.Before(current.ExpiresAt):
		return workspace.Lease{}, fmt.Errorf("%w (dono: %s, época %d)", ErrLeaseHeld, current.WorkerID, current.Epoch)
	default:
		// Vago ou vencido: a época anda. É o PC-03 assumindo a tarefa que o
		// PC-02 largou — e é o que faz o resultado atrasado do PC-02 bater na
		// cerca em vez de sobrescrever o trabalho novo.
		current = leaseRecord{WorkerID: workerID, Epoch: current.Epoch + 1, ExpiresAt: now.Add(f.ttl)}
	}
	f.leases[taskID] = current
	if err := f.persistLeasesLocked(); err != nil {
		return workspace.Lease{}, err
	}
	return workspace.Lease{WorkerID: current.WorkerID, Epoch: current.Epoch}, nil
}

// CurrentLease responde quem detém a tarefa AGORA — é a interface que a cerca
// do workspace consulta (workspace.Leases).
//
// Tarefa sem lease (ou com lease vencido) é adquirida IMPLICITAMENTE pelo
// worker local: o turno de conversa nunca pede lease antes de congelar o
// plano, e recusar o congelamento por falta de um registro que só este
// processo criaria seria burocracia consigo mesmo. Lease VÁLIDO de outro
// worker é devolvido como está — e aí o Promote de quem perguntou falha, que
// é a cerca funcionando.
func (f *Fleet) CurrentLease(_ context.Context, taskID string) (workspace.Lease, error) {
	f.mu.Lock()
	current, exists := f.leases[taskID]
	valido := exists && time.Now().UTC().Before(current.ExpiresAt)
	self := f.self.ID
	f.mu.Unlock()

	if valido && current.WorkerID != self {
		return workspace.Lease{WorkerID: current.WorkerID, Epoch: current.Epoch}, nil
	}
	return f.Acquire(taskID, self)
}

/* ------------------------------- persistência ----------------------------- */

func (f *Fleet) persistWorkersLocked() error {
	return writeJSONFile(filepath.Join(f.dir, "workers.json"), f.workers)
}

func (f *Fleet) persistLeasesLocked() error {
	return writeJSONFile(filepath.Join(f.dir, "leases.json"), f.leases)
}

// writeJSONFile grava com temp+rename E fsync: o lease é o guardião da cerca,
// e uma época perdida numa queda deixaria um resultado velho passar por atual.
// A frequência é por tarefa/turno, não por token — o fsync aqui não dói.
func writeJSONFile(path string, value any) error {
	data, err := json.MarshalIndent(value, "", " ")
	if err != nil {
		return err
	}
	temp := path + ".tmp"
	file, err := os.OpenFile(temp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := file.Write(data); err != nil {
		file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := os.Rename(temp, path); err != nil {
		_ = os.Remove(temp)
		return err
	}
	return nil
}

func readJSONFile(path string, value any) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, value)
}

func safeName(name string) string {
	var out strings.Builder
	for _, r := range strings.ToLower(name) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-':
			out.WriteRune(r)
		default:
			out.WriteRune('_')
		}
	}
	return out.String()
}
