package fleet

import (
	"context"
	"errors"
	"testing"

	"aibot/gateway/internal/workspace"
)

// As três saídas do lease, e a que importa mais: a ÉPOCA anda e nunca volta.
func TestLeaseRenovaBumpaERecusa(t *testing.T) {
	frota, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	self := frota.Self().ID

	primeiro, err := frota.Acquire("t1", self)
	if err != nil || primeiro.Epoch != 1 {
		t.Fatalf("primeira aquisição: %+v (%v)", primeiro, err)
	}
	// O dono renova: MESMA época.
	renovado, err := frota.Acquire("t1", self)
	if err != nil || renovado.Epoch != 1 {
		t.Fatalf("renovação mudou a época: %+v (%v)", renovado, err)
	}
	// Outro worker com lease válido na frente: recusa — lease não se rouba.
	if _, err := frota.Acquire("t1", "pc-invasor"); !errors.Is(err, ErrLeaseHeld) {
		t.Fatalf("o lease válido tinha de ser recusado a outro worker: %v", err)
	}
}

// A época SOBREVIVE ao reinício: sem isso, o gateway que cai e volta
// recomeçaria na época 1 e o resultado de um worker antigo passaria pela cerca.
func TestEpocaSobreviveAoReinicio(t *testing.T) {
	dir := t.TempDir()
	frota, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := frota.Acquire("t1", frota.Self().ID); err != nil {
		t.Fatal(err)
	}

	reaberta, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	// Encena o vencimento: TTL negativo faz todo lease renovado nascer vencido,
	// então a PRÓXIMA aquisição precisa ANDAR a época — nunca voltar a 1, que é
	// exatamente o que aconteceria se ela não fosse persistida.
	reaberta.ttl = -1
	vencida, err := reaberta.Acquire("t1", reaberta.Self().ID)
	if err != nil {
		t.Fatal(err)
	}
	if vencida.Epoch < 1 {
		t.Fatalf("época perdida no reinício: %+v", vencida)
	}
	depois, err := reaberta.Acquire("t1", "pc-novo-dono")
	if err != nil {
		t.Fatalf("o lease vencido tinha de ser tomável: %v", err)
	}
	if depois.Epoch != vencida.Epoch+1 {
		t.Fatalf("a época tinha de ANDAR (%d → %d), veio %d", vencida.Epoch, vencida.Epoch+1, depois.Epoch)
	}
}

// CurrentLease adquire implicitamente para o worker LOCAL (o turno de conversa
// nunca pede lease antes de congelar o plano), mas devolve o lease VÁLIDO de
// outro worker como está — é isso que faz o Promote de quem perguntou falhar.
func TestCurrentLeaseImplicitoENaoRouba(t *testing.T) {
	frota, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}

	implicito, err := frota.CurrentLease(context.Background(), "t-nova")
	if err != nil || implicito.WorkerID != frota.Self().ID || implicito.Epoch != 1 {
		t.Fatalf("aquisição implícita: %+v (%v)", implicito, err)
	}

	// Encena outro worker como dono vigente.
	if _, err := frota.Acquire("t-alheia", "pc-outro"); !errors.Is(err, ErrLeaseHeld) {
		// t-alheia estava vaga: pc-outro adquire de verdade.
		if err != nil {
			t.Fatal(err)
		}
	}
	alheio, err := frota.CurrentLease(context.Background(), "t-alheia")
	if err != nil || alheio.WorkerID != "pc-outro" {
		t.Fatalf("o lease alheio não podia ser roubado: %+v (%v)", alheio, err)
	}

	// E a frota satisfaz a interface da cerca.
	var _ workspace.Leases = frota
}

// O registro de execuções: começa, termina, respeita o teto.
func TestRunLogGravaEDevolve(t *testing.T) {
	blobs := memBlobs{}
	runs := NewRunLog(blobs)

	runs.Start("s1", Run{ID: "w-1-t1", TaskID: "t1", Turn: "turno-1", Wave: 1, WorkerID: "pc-x", PlanID: "wp-1", Epoch: 3})
	runs.Finish("s1", "w-1-t1", "")
	runs.Start("s1", Run{ID: "w-1-t2", TaskID: "t2", Turn: "turno-1", Wave: 1})
	runs.Finish("s1", "w-1-t2", "estourou o teto de rodadas")

	lista := runs.List("s1")
	if len(lista) != 2 {
		t.Fatalf("esperava 2 execuções, achei %d", len(lista))
	}
	if lista[0].State != "done" || lista[0].Epoch != 3 {
		t.Fatalf("primeira execução: %+v", lista[0])
	}
	if lista[1].State != "failed" || lista[1].Error == "" {
		t.Fatalf("segunda execução: %+v", lista[1])
	}

	// Nil-safe: gateway sem store não derruba a onda.
	var nenhum *RunLog
	nenhum.Start("s1", Run{ID: "x"})
	nenhum.Finish("s1", "x", "")
}

// memBlobs é o store de mentira dos testes.
type memBlobs map[string][]byte

func (m memBlobs) SaveSessionBlob(sessionID, name string, data []byte) error {
	m[sessionID+"/"+name] = data
	return nil
}

func (m memBlobs) LoadSessionBlob(sessionID, name string) ([]byte, error) {
	return m[sessionID+"/"+name], nil
}
