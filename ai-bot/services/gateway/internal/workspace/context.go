// A execução materializada e o transporte dela pelo contexto.
//
// A Execution existe SOMENTE dentro do worker que materializou o plano: o
// caminho físico (C:\..., /var/lib/...) nunca entra no Plan persistente, porque
// o orquestrador não precisa — e não deve — saber onde cada PC monta as coisas.
//
// O contexto é o veículo de propósito: o plano é CONGELADO antes da execução, e
// pendurá-lo no ctx garante que fs.read, git.diff e proc.run do mesmo turno
// enxergam o MESMO root. A alternativa — cada ferramenta resolver o workspace
// de novo — abre a janela clássica: fs.read na época 17, a tarefa é
// reatribuída, fs.write na época 18, em outro worker.
package workspace

import (
	"context"
	"errors"
)

type executionKey struct{}

var ErrNoExecution = errors.New("nenhum workspace de execução associado ao contexto")

// Execution é o plano MATERIALIZADO nesta máquina.
type Execution struct {
	Plan Plan
	// LocalRoot existe SOMENTE dentro do worker. Vazio = a sessão não tem pasta
	// de projeto (as ferramentas de arquivo recusam, como sempre recusaram).
	// Num plano com staging real, ELE é a cópia: as ferramentas do turno agem
	// na cópia sem saber que é uma — o projeto entregue só muda na promoção.
	LocalRoot string
	// ShadowGitDir é o git sombra usado para baseline/checkpoints. Vazio na v1
	// — o checkpoint shadow-git ainda não foi implementado.
	ShadowGitDir string
	// LocalStaging é a pasta da cópia de segurança quando o plano tem staging
	// real (igual a LocalRoot). Vazio = execução inplace: escreve direto no
	// workspace e a promoção é constatação.
	LocalStaging string
	// StagingNonce identifica ESTA materialização da cópia. Promote e Discard
	// só agem se o staging ainda pertence a esta execução — um turno substituído
	// que sobreviveu à troca não pode apagar (nem entregar) a cópia que o
	// substituto acabou de materializar no mesmo lugar.
	StagingNonce uint64
	// StagingDegraded explica por que um plano que PEDIA staging acabou
	// inplace (teto de tamanho, entrada que a cópia não espelha). Vazio = nada
	// a avisar. O supervisor transforma isto num KindThinking honesto.
	StagingDegraded string
}

// Publication descreve para a promoção O QUE esta execução publicou — o URI
// congelado no plano e o nonce da materialização. Execução inplace (ou
// degradada para inplace) publica a constatação de sempre.
func (e *Execution) Publication() Publication {
	if e == nil || e.LocalStaging == "" {
		return Publication{StagingURI: InplaceStaging}
	}
	return Publication{StagingURI: e.Plan.Staging.URI, Nonce: e.StagingNonce}
}

// WithExecution pendura a execução no contexto. Nil não pendura nada — quem
// consultar recebe o mesmo "não há workspace" de um contexto cru.
func WithExecution(ctx context.Context, execution *Execution) context.Context {
	if execution == nil {
		return ctx
	}
	return context.WithValue(ctx, executionKey{}, execution)
}

// FromContext devolve a execução do contexto, se houver.
func FromContext(ctx context.Context) (*Execution, bool) {
	execution, ok := ctx.Value(executionKey{}).(*Execution)
	return execution, ok && execution != nil
}

// Require devolve a execução ou o motivo de não haver uma. Para a ferramenta
// que não funciona sem workspace: o erro diz o que falta em vez de cair na
// pasta do processo — que seria o binário do gateway.
func Require(ctx context.Context) (*Execution, error) {
	execution, ok := FromContext(ctx)
	if !ok {
		return nil, ErrNoExecution
	}
	if execution.LocalRoot == "" {
		return nil, errors.New("workspace ainda não foi materializado")
	}
	return execution, nil
}
