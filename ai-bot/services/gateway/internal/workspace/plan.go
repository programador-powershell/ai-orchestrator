// O plano de workspace: ONDE uma execução trabalha, congelado ANTES de ela
// começar.
//
// É a peça central do desenho de cluster (docs/arquitetura-cluster.md): a
// ferramenta nunca recebe nem calcula um diretório — ela recebe uma execução
// cujo workspace já foi decidido. O plano congela junto quem executa (worker) e
// em que época de lease, e é essa tríade que a cerca (fence) confere na hora de
// promover: um worker que perdeu o lease pode até terminar o trabalho, mas não
// consegue transformá-lo em verdade.
//
// A v1 é LOCAL de propósito (Source.Provider "local", WorkerID "local", época
// 1): a arquitetura muda agora — Task → Plan → fs/git/proc no MESMO root — e o
// backend troca depois, quando o Puter e o worker-daemon entrarem. Construir o
// cluster em cima do Root(sessionID) de antes obrigaria a reescrever tudo de
// novo.
package workspace

import (
	"errors"
	"fmt"
	"strings"
)

// Constantes da v1 local. São identificadores DEFINIDOS, não placeholders
// vazios: o Validate exige cada campo preenchido para o plano remoto nascer
// completo, e a v1 os preenche com valores que dizem exatamente o que são.
const (
	// LocalProvider é o backend v1: o workspace é uma pasta desta máquina.
	LocalProvider = "local"
	// LocalWorker é o único worker da v1: este processo.
	LocalWorker = "local"
	// LiveRevision marca um workspace VIVO, sem endereçamento por conteúdo —
	// o resolver por manifesto/fingerprint o substituirá.
	LiveRevision = "live"
	// HostSnapshot marca o runtime "a máquina como está", sem snapshot
	// resolvido por digest.
	HostSnapshot = "host"
	// InplaceStaging marca que a execução escreve DIRETO no workspace, sem área
	// de staging — a promoção com cerca é constatação. É o caso da UI (a pessoa
	// edita o projeto ENTREGUE), da equipe (o isolamento dela é o worktree) e da
	// raiz apontada pela pessoa (pasta própria, potencialmente gigante — a
	// resposta para repositório grande é worktree/Puter, não cópia cega).
	InplaceStaging = "local://inplace"
	// StagingURIPrefix marca o staging REAL da v1: o turno de modelo trabalha
	// numa CÓPIA do projeto em <dataDir>/staging/<planID>/ e só o desfecho
	// bem-sucedido promove — falha, interrupção e recusa descartam a cópia sem
	// que nada meio-escrito chegue à pessoa.
	StagingURIPrefix = "staging://"
)

// Origin diz QUEM está por trás do pedido de execução. O staging só existe
// para o MODELO: a pessoa que salva pela interface está editando o projeto
// entregue, e o trabalhador de equipe tem o worktree como isolamento.
type Origin string

const (
	// OriginModel é o turno (ou sub-turno delegado) de MODELO de um
	// especialista: o único que ganha a cópia de segurança.
	OriginModel Origin = "model"
	// OriginUI é a pessoa agindo pela interface (Ctrl+S, árvore de arquivos):
	// edição direta do projeto entregue, com aprovação — nunca staging.
	OriginUI Origin = "ui"
	// OriginCrew é o trabalhador de equipe. Deliberadamente SEM staging:
	// trabalhadores rodam em PARALELO sobre o mesmo projeto, e duas cópias
	// espelhadas de volta se apagariam mutuamente (o espelho remove o que não
	// está na própria cópia). O isolamento da equipe é o worktree — misturar os
	// dois mecanismos seria copiar uma cópia.
	OriginCrew Origin = "crew"
)

// Source identifica o workspace de origem — de onde a execução materializa.
// O worker nunca promove diretamente para Source.URI: ele publica no staging e
// a promoção passa pela cerca.
type Source struct {
	Provider string `json:"provider"`
	URI      string `json:"uri"`
	Revision string `json:"revision"`
}

// Runtime é o que a tarefa EXIGE da máquina que a executa. O scheduler escolhe
// um worker que satisfaça; a v1 só conhece o host local.
type Runtime struct {
	Profile        string   `json:"profile,omitempty"`
	SnapshotDigest string   `json:"snapshotDigest"`
	Arch           string   `json:"arch,omitempty"`
	MinRamBytes    uint64   `json:"minRamBytes,omitempty"`
	Capabilities   []string `json:"capabilities,omitempty"`
}

// Staging é onde o worker publica ANTES da promoção.
type Staging struct {
	URI string `json:"uri"`
}

// Baseline identifica o estado inicial da tentativa — é contra ele que o diff
// e o checkpoint (shadow-git) serão calculados.
type Baseline struct {
	Revision string `json:"revision"`
	// Digest do manifest materializado.
	ManifestDigest string `json:"manifestDigest"`
}

// Plan é o contrato completo de uma execução. PERSISTENTE e serializável: nada
// aqui dentro é caminho físico de uma máquina — o caminho local vive na
// Execution, que existe somente dentro do worker que materializou.
type Plan struct {
	ID        string `json:"id"`
	UserID    string `json:"userId"`
	GoalID    string `json:"goalId"`
	SessionID string `json:"sessionId,omitempty"`
	TaskID    string `json:"taskId"`
	BotID     string `json:"botId"`
	// Attempt conta as tentativas da MESMA tarefa: a segunda tentativa não pode
	// reaproveitar o staging da primeira.
	Attempt int `json:"attempt"`
	// WorkerID é o PC registrado no cluster que vai executar — não o processo
	// lógico de uma onda (esse é o TaskRunID do despacho).
	WorkerID string `json:"workerId"`
	// LeaseEpoch é a época do lease no momento do congelamento. A cerca compara
	// worker+época na promoção: worker velho com época velha não publica.
	LeaseEpoch uint64   `json:"leaseEpoch"`
	Source     Source   `json:"source"`
	Runtime    Runtime  `json:"runtime"`
	Staging    Staging  `json:"staging"`
	Baseline   Baseline `json:"baseline"`
}

// Validate confere o plano campo a campo. Um plano incompleto não descreve uma
// execução — descreve uma esperança — e o erro diz exatamente o que falta.
func (p Plan) Validate() error {
	switch {
	case strings.TrimSpace(p.ID) == "":
		return errors.New("workspace plan sem id")
	case strings.TrimSpace(p.UserID) == "":
		return errors.New("workspace plan sem userId")
	case strings.TrimSpace(p.GoalID) == "":
		return errors.New("workspace plan sem goalId")
	case strings.TrimSpace(p.TaskID) == "":
		return errors.New("workspace plan sem taskId")
	case strings.TrimSpace(p.BotID) == "":
		return errors.New("workspace plan sem botId")
	case p.Attempt == 0:
		return errors.New("workspace plan com attempt zero")
	case strings.TrimSpace(p.WorkerID) == "":
		return errors.New("workspace plan sem workerId")
	case p.LeaseEpoch == 0:
		return errors.New("workspace plan sem leaseEpoch")
	case strings.TrimSpace(p.Source.Provider) == "":
		return errors.New("workspace plan sem source provider")
	case strings.TrimSpace(p.Source.URI) == "":
		return errors.New("workspace plan sem source uri")
	case strings.TrimSpace(p.Source.Revision) == "":
		return errors.New("workspace plan sem source revision")
	case strings.TrimSpace(p.Runtime.SnapshotDigest) == "":
		return errors.New("workspace plan sem runtime snapshot")
	case strings.TrimSpace(p.Staging.URI) == "":
		return errors.New("workspace plan sem staging uri")
	case strings.TrimSpace(p.Baseline.ManifestDigest) == "":
		return errors.New("workspace plan sem baseline")
	}
	return nil
}

// Staged diz se o plano trabalha numa CÓPIA (staging real) em vez de direto
// no projeto. É o que o supervisor consulta para a telemetria e para saber se
// há algo a promover/descartar no fim do turno.
func (p Plan) Staged() bool {
	return strings.HasPrefix(p.Staging.URI, StagingURIPrefix)
}

func (p Plan) String() string {
	return fmt.Sprintf(
		"%s task=%s bot=%s worker=%s attempt=%d epoch=%d",
		p.ID,
		p.TaskID,
		p.BotID,
		p.WorkerID,
		p.Attempt,
		p.LeaseEpoch,
	)
}
