// O TaskRun persistente: cada execução de tarefa vira REGISTRO durável.
//
// Até aqui o DAG da equipe vivia só na memória do turno — o processo caía e
// não sobrava nem a prova de que a tarefa rodou, quanto mais onde parou. O
// registro é o primeiro degrau da retomada distribuída: primeiro a execução
// existe em disco (auditável), depois ela vira retomável.
package fleet

import (
	"encoding/json"
	"strings"
	"time"
)

// runsBlobName é o blob da sessão onde as execuções vivem.
const runsBlobName = "taskruns"

// maxRunsPerSession é o teto de registros por sessão — os mais antigos caem.
// O registro é auditoria recente, não arquivo morto; o log de envelopes já
// guarda a história completa.
const maxRunsPerSession = 200

// Run é uma execução de tarefa, do despacho ao desfecho.
type Run struct {
	// ID é o identificador lógico da execução (o TaskRunID do despacho) —
	// tentativa incluída. O worker físico fica em WorkerID.
	ID       string    `json:"id"`
	TaskID   string    `json:"taskId"`
	Turn     string    `json:"turn"`
	Wave     int       `json:"wave"`
	WorkerID string    `json:"workerId"`
	PlanID   string    `json:"planId,omitempty"`
	Epoch    uint64    `json:"epoch,omitempty"`
	State    string    `json:"state"` // running | done | failed
	Error    string    `json:"error,omitempty"`
	Started  time.Time `json:"started"`
	Ended    time.Time `json:"ended,omitempty"`
}

// SessionBlobs é o que o registro precisa do store — a mesma dupla que a
// cápsula de estado usa.
type SessionBlobs interface {
	SaveSessionBlob(sessionID, name string, data []byte) error
	LoadSessionBlob(sessionID, name string) ([]byte, error)
}

// RunLog grava as execuções de cada sessão.
type RunLog struct {
	blobs SessionBlobs
}

// NewRunLog monta o registro sobre o store. Nil-safe nos métodos: gateway sem
// store grava nada e não derruba a equipe.
func NewRunLog(blobs SessionBlobs) *RunLog {
	return &RunLog{blobs: blobs}
}

// Start registra a execução despachada.
func (r *RunLog) Start(sessionID string, run Run) {
	if r == nil || r.blobs == nil || strings.TrimSpace(run.ID) == "" {
		return
	}
	run.State = "running"
	run.Started = time.Now().UTC()
	r.update(sessionID, run.ID, func(runs []Run) []Run {
		return append(runs, run)
	})
}

// Finish registra o desfecho. Erro vazio = concluída.
func (r *RunLog) Finish(sessionID, runID, failure string) {
	if r == nil || r.blobs == nil {
		return
	}
	r.update(sessionID, runID, func(runs []Run) []Run {
		for index := range runs {
			if runs[index].ID != runID {
				continue
			}
			runs[index].Ended = time.Now().UTC()
			if failure == "" {
				runs[index].State = "done"
			} else {
				runs[index].State = "failed"
				runs[index].Error = failure
			}
		}
		return runs
	})
}

// List devolve as execuções registradas da sessão, mais antiga primeiro.
func (r *RunLog) List(sessionID string) []Run {
	if r == nil || r.blobs == nil {
		return nil
	}
	data, err := r.blobs.LoadSessionBlob(sessionID, runsBlobName)
	if err != nil || len(data) == 0 {
		return nil
	}
	var runs []Run
	if json.Unmarshal(data, &runs) != nil {
		return nil
	}
	return runs
}

// update lê-modifica-grava a lista. Erros são engolidos de propósito: o
// registro é auditoria, e falha de disco aqui não pode derrubar a onda que
// está rodando — o log de envelopes continua contando a história.
func (r *RunLog) update(sessionID, _ string, mutate func([]Run) []Run) {
	data, _ := r.blobs.LoadSessionBlob(sessionID, runsBlobName)
	var runs []Run
	if len(data) > 0 {
		_ = json.Unmarshal(data, &runs)
	}
	runs = mutate(runs)
	if len(runs) > maxRunsPerSession {
		runs = append([]Run(nil), runs[len(runs)-maxRunsPerSession:]...)
	}
	if serialized, err := json.Marshal(runs); err == nil {
		_ = r.blobs.SaveSessionBlob(sessionID, runsBlobName, serialized)
	}
}
