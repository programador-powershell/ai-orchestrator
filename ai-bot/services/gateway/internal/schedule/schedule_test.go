// Testes da agenda local.
//
// Três invariantes justificam quase todos eles, e as três nasceram de defeito de
// agendador que qualquer um já viu na prática:
//
//  1. o gatilho vencido é adiado ANTES de sair de Due, com a trava segurada —
//     senão o mesmo prompt roda duas vezes;
//  2. janela perdida com a máquina desligada NÃO vira rajada ao ligar;
//  3. o que foi agendado sobrevive a fechar e abrir o gateway.
package schedule

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

/* ------------------------------ auxiliares ------------------------------ */

func openStore(t *testing.T) *Store {
	t.Helper()
	store, err := Open(filepath.Join(t.TempDir(), "schedule.json"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return store
}

func addTrigger(t *testing.T, store *Store, trigger Trigger) Trigger {
	t.Helper()
	created, err := store.Add(trigger)
	if err != nil {
		t.Fatalf("Add(%+v): %v", trigger, err)
	}
	return created
}

func everyTrigger(every string) Trigger {
	return Trigger{Session: "s1", Prompt: "resuma o dia", Every: every, Note: "relatório diário"}
}

// setNextRun mexe na agenda como o relógio mexeria, sem esperar o relógio. Vai
// pela trava porque o resto do pacote também vai.
func setNextRun(t *testing.T, store *Store, id string, when time.Time) {
	t.Helper()
	store.mu.Lock()
	defer store.mu.Unlock()
	index := store.indexOf(id)
	if index < 0 {
		t.Fatalf("gatilho %s não está na agenda", id)
	}
	store.triggers[index].NextRun = when
}

func quietLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, &slog.HandlerOptions{Level: slog.LevelError}))
}

// writeForTest planta um arquivo de agenda como o editor da pessoa plantaria.
func writeForTest(path, content string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(content), 0o600)
}

/* ---------------------------------- Add --------------------------------- */

func TestAddValidates(t *testing.T) {
	cases := []struct {
		name    string
		trigger Trigger
		want    string
	}{
		{"sem sessão", Trigger{Prompt: "oi", Every: "15m"}, "sessão"},
		{"sem prompt", Trigger{Session: "s1", Every: "15m"}, "prompt"},
		{"sem every e sem at", Trigger{Session: "s1", Prompt: "oi"}, `informe "every"`},
		{"every e at juntos", Trigger{Session: "s1", Prompt: "oi", Every: "15m", At: "08:30"}, "não os dois"},
		{"every ilegível", Trigger{Session: "s1", Prompt: "oi", Every: "amanhã"}, "intervalo inválido"},
		{"every abaixo do mínimo", Trigger{Session: "s1", Prompt: "oi", Every: "5s"}, "intervalo mínimo"},
		{"at fora do formato", Trigger{Session: "s1", Prompt: "oi", At: "8h30"}, "horário inválido"},
		{"at fora do relógio", Trigger{Session: "s1", Prompt: "oi", At: "25:00"}, "horário inválido"},
	}

	for _, each := range cases {
		t.Run(each.name, func(t *testing.T) {
			store := openStore(t)
			_, err := store.Add(each.trigger)
			if err == nil {
				t.Fatalf("esperava recusa de %+v", each.trigger)
			}
			if !strings.Contains(err.Error(), each.want) {
				t.Fatalf("esperava erro contendo %q, obtive %q", each.want, err)
			}
			if len(store.List()) != 0 {
				t.Fatal("o gatilho recusado entrou na agenda")
			}
		})
	}
}

// O chamador diz o QUANDO e o QUÊ; agenda e histórico são consequência, não
// pedido. E gatilho que nasce desligado é gatilho que não existe.
func TestAddIgnoresHistoryAndTurnsTriggerOn(t *testing.T) {
	store := openStore(t)
	before := time.Now()

	created := addTrigger(t, store, Trigger{
		Session: "s1", Prompt: "resuma o dia", Every: "15m",
		Enabled: false,
		Runs:    99,
		LastRun: before.Add(-72 * time.Hour),
		NextRun: before.Add(-72 * time.Hour),
	})

	if !created.Enabled {
		t.Fatal("o gatilho nasceu desligado")
	}
	if created.Runs != 0 || !created.LastRun.IsZero() {
		t.Fatalf("histórico veio do chamador: runs=%d lastRun=%v", created.Runs, created.LastRun)
	}
	if !created.NextRun.After(before) {
		t.Fatalf("o próximo disparo precisa ser futuro, veio %v", created.NextRun)
	}
	if created.ID == "" || !strings.HasPrefix(created.ID, "trg-") {
		t.Fatalf("id gerado inesperado: %q", created.ID)
	}
}

func TestAddRefusesRepeatedID(t *testing.T) {
	store := openStore(t)
	first := addTrigger(t, store, everyTrigger("15m"))

	repeated := everyTrigger("30m")
	repeated.ID = first.ID
	if _, err := store.Add(repeated); err == nil {
		t.Fatal("esperava recusa de id repetido")
	}
	if len(store.List()) != 1 {
		t.Fatalf("esperava 1 gatilho, obtive %d", len(store.List()))
	}
}

/* ---------------------------------- Due --------------------------------- */

// Due adia ANTES de devolver: quem recebeu o gatilho já o recebeu remarcado, e
// a segunda chamada no mesmo instante não devolve nada.
func TestDueReschedulesBeforeReturning(t *testing.T) {
	store := openStore(t)
	created := addTrigger(t, store, everyTrigger("15m"))
	now := time.Now()
	setNextRun(t, store, created.ID, now.Add(-time.Second))

	due := store.Due(now)
	if len(due) != 1 {
		t.Fatalf("esperava 1 gatilho vencido, obtive %d", len(due))
	}
	if !due[0].NextRun.After(now) {
		t.Fatalf("o gatilho voltou de Due sem ser adiado: %v", due[0].NextRun)
	}
	if due[0].Runs != 1 || !due[0].LastRun.Equal(now) {
		t.Fatalf("o disparo não foi registrado: runs=%d lastRun=%v", due[0].Runs, due[0].LastRun)
	}
	if again := store.Due(now); len(again) != 0 {
		t.Fatalf("o mesmo gatilho venceu duas vezes no mesmo instante: %d", len(again))
	}
}

// A trava é o que impede o disparo duplo quando dois tiques se atropelam. Com
// -race este teste também cobre a corrida de escrita.
func TestDueHandsTriggerToASingleCaller(t *testing.T) {
	store := openStore(t)
	created := addTrigger(t, store, everyTrigger("15m"))
	now := time.Now()
	setNextRun(t, store, created.ID, now.Add(-time.Second))

	const callers = 8
	var wait sync.WaitGroup
	counts := make([]int, callers)
	for index := 0; index < callers; index++ {
		wait.Add(1)
		go func(slot int) {
			defer wait.Done()
			counts[slot] = len(store.Due(now))
		}(index)
	}
	wait.Wait()

	total := 0
	for _, count := range counts {
		total += count
	}
	if total != 1 {
		t.Fatalf("o gatilho saiu %d vezes para %d chamadores concorrentes", total, callers)
	}
}

func TestDueSkipsDisabledTrigger(t *testing.T) {
	store := openStore(t)
	created := addTrigger(t, store, everyTrigger("15m"))
	now := time.Now()
	setNextRun(t, store, created.ID, now.Add(-time.Second))

	store.mu.Lock()
	store.triggers[0].Enabled = false
	store.mu.Unlock()

	if due := store.Due(now); len(due) != 0 {
		t.Fatalf("gatilho desligado disparou: %d", len(due))
	}
}

// Máquina desligada a tarde inteira: o gatilho perdeu dez janelas e sai UMA vez,
// já remarcado para a próxima janela futura. Rajada de dez execuções ao ligar o
// computador é pior que a execução perdida.
func TestDueDoesNotBurstAfterMissedWindows(t *testing.T) {
	store := openStore(t)
	created := addTrigger(t, store, everyTrigger("1m"))
	now := time.Now()
	missedSince := now.Add(-10 * time.Minute)
	setNextRun(t, store, created.ID, missedSince)

	due := store.Due(now)
	if len(due) != 1 {
		t.Fatalf("esperava 1 disparo para 10 janelas perdidas, obtive %d", len(due))
	}
	next := due[0].NextRun
	if !next.After(now) || next.After(now.Add(time.Minute)) {
		t.Fatalf("o próximo disparo devia cair na próxima janela futura, veio %v (agora %v)", next, now)
	}
	// A fase é preservada: o gatilho continua caindo no mesmo minuto do relógio
	// em que foi marcado, e não escorrega a cada reinício.
	if drift := next.Sub(missedSince) % time.Minute; drift != 0 {
		t.Fatalf("a fase do gatilho escorregou %v", drift)
	}
	if again := store.Due(now); len(again) != 0 {
		t.Fatalf("sobrou janela perdida para disparar: %d", len(again))
	}
}

/* ------------------------------- diário (At) ----------------------------- */

func TestAtSchedulesDailyInLocalTime(t *testing.T) {
	store := openStore(t)
	created := addTrigger(t, store, Trigger{Session: "s1", Prompt: "bom dia", At: "08:30"})
	now := time.Now()

	if created.NextRun.Hour() != 8 || created.NextRun.Minute() != 30 {
		t.Fatalf("esperava 08:30 na hora local, veio %v", created.NextRun)
	}
	if !created.NextRun.After(now) || created.NextRun.Sub(now) > 24*time.Hour {
		t.Fatalf("o primeiro disparo devia ser o próximo 08:30, veio %v", created.NextRun)
	}

	// Vencido: o próximo é o 08:30 seguinte, um por dia — nunca dois.
	setNextRun(t, store, created.ID, now.Add(-time.Minute))
	due := store.Due(now)
	if len(due) != 1 {
		t.Fatalf("esperava 1 disparo diário, obtive %d", len(due))
	}
	next := due[0].NextRun
	if next.Hour() != 8 || next.Minute() != 30 {
		t.Fatalf("o próximo disparo saiu do horário: %v", next)
	}
	if !next.After(now) || next.Sub(now) > 24*time.Hour {
		t.Fatalf("o próximo disparo devia cair nas próximas 24 horas, veio %v", next)
	}
}

/* ----------------------------- persistência ------------------------------ */

func TestAgendaSurvivesReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "dados", "schedule.json")
	store, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	first := addTrigger(t, store, everyTrigger("2h"))
	second := addTrigger(t, store, Trigger{Session: "s2", Prompt: "bom dia", At: "08:30"})

	reopened, err := Open(path)
	if err != nil {
		t.Fatalf("reabrir: %v", err)
	}
	list := reopened.List()
	if len(list) != 2 {
		t.Fatalf("esperava 2 gatilhos depois de reabrir, obtive %d", len(list))
	}
	// A ordem é a de inclusão, não a de um mapa: a lista não pode se embaralhar
	// entre duas aberturas do produto.
	if list[0].ID != first.ID || list[1].ID != second.ID {
		t.Fatalf("a ordem mudou ao reabrir: %s, %s", list[0].ID, list[1].ID)
	}
	if list[0].Prompt != first.Prompt || list[0].Every != "2h" || list[0].Note != first.Note {
		t.Fatalf("o gatilho voltou diferente: %+v", list[0])
	}
	if !list[0].NextRun.Equal(first.NextRun) {
		t.Fatalf("o horário mudou ao reabrir: %v ≠ %v", list[0].NextRun, first.NextRun)
	}
	if !list[0].Enabled {
		t.Fatal("o gatilho voltou desligado")
	}
}

func TestRemoveApagaEPersiste(t *testing.T) {
	path := filepath.Join(t.TempDir(), "schedule.json")
	store, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	first := addTrigger(t, store, everyTrigger("2h"))
	second := addTrigger(t, store, everyTrigger("3h"))

	if err := store.Remove(first.ID); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if list := store.List(); len(list) != 1 || list[0].ID != second.ID {
		t.Fatalf("removeu o gatilho errado: %+v", list)
	}
	if err := store.Remove("trg-que-nao-existe"); err == nil {
		t.Fatal("esperava recusa ao remover id inexistente")
	}

	reopened, err := Open(path)
	if err != nil {
		t.Fatalf("reabrir: %v", err)
	}
	if list := reopened.List(); len(list) != 1 || list[0].ID != second.ID {
		t.Fatalf("a remoção não sobreviveu a reabrir: %+v", list)
	}
}

// Quem edita o arquivo à mão erra; uma linha torta não pode custar a agenda
// inteira nem impedir o gateway de subir.
func TestOpenSkipsBrokenTriggers(t *testing.T) {
	path := filepath.Join(t.TempDir(), "schedule.json")
	content := `{"version":1,"triggers":[
		{"id":"trg-1","session":"s1","prompt":"ok","every":"1h","enabled":true},
		{"id":"","session":"s1","prompt":"sem id","every":"1h","enabled":true},
		{"id":"trg-3","session":"s1","prompt":"intervalo impossível","every":"1s","enabled":true},
		{"id":"trg-4","session":"s1","prompt":"sem horário","enabled":true}
	]}`
	if err := writeForTest(path, content); err != nil {
		t.Fatalf("preparar arquivo: %v", err)
	}

	store, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	list := store.List()
	if len(list) != 1 || list[0].ID != "trg-1" {
		t.Fatalf("esperava só o gatilho íntegro, obtive %+v", list)
	}
	// Sem nextRun no arquivo, a abertura calcula um — senão o gatilho ficaria na
	// lista para sempre sem nunca disparar.
	if !list[0].NextRun.After(time.Now()) {
		t.Fatalf("a abertura não remarcou o gatilho: %v", list[0].NextRun)
	}
}

/* --------------------------------- Runner -------------------------------- */

func TestRunnerFiresDueTriggerAndStopsWithContext(t *testing.T) {
	store := openStore(t)
	created := addTrigger(t, store, everyTrigger("1m"))
	setNextRun(t, store, created.ID, time.Now().Add(-time.Second))

	fired := make(chan string, 8)
	runner := NewRunner(store, func(_ context.Context, sessionID, prompt string) error {
		fired <- sessionID + "|" + prompt
		return nil
	}, quietLogger())
	// O tique de produção é de trinta segundos; o teste não espera por isso.
	runner.tick = 5 * time.Millisecond

	ctx, cancel := context.WithCancel(context.Background())
	runner.Start(ctx)

	select {
	case got := <-fired:
		if got != "s1|resuma o dia" {
			t.Fatalf("disparou com a carga errada: %q", got)
		}
	case <-time.After(2 * time.Second):
		cancel()
		t.Fatal("o gatilho vencido não disparou")
	}

	cancel()
	// Depois do ctx.Done() a goroutine morre: nem um gatilho vencido de novo a
	// acorda. Sem isso, fechar o gateway deixaria automação rodando.
	time.Sleep(50 * time.Millisecond)
	for len(fired) > 0 {
		<-fired
	}
	setNextRun(t, store, created.ID, time.Now().Add(-time.Second))
	time.Sleep(100 * time.Millisecond)
	if len(fired) != 0 {
		t.Fatalf("o runner continuou disparando depois do cancelamento: %d", len(fired))
	}
}

// Falha no disparo não vira tentativa em série: o gatilho já foi adiado, e
// repetir na hora é a rajada que o adiamento evita.
func TestRunnerDoesNotRetryFailedFireImmediately(t *testing.T) {
	store := openStore(t)
	created := addTrigger(t, store, everyTrigger("1m"))
	setNextRun(t, store, created.ID, time.Now().Add(-time.Second))

	var mu sync.Mutex
	calls := 0
	runner := NewRunner(store, func(_ context.Context, _, _ string) error {
		mu.Lock()
		calls++
		mu.Unlock()
		return io.ErrUnexpectedEOF
	}, quietLogger())
	runner.tick = 5 * time.Millisecond

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runner.Start(ctx)

	time.Sleep(150 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if calls != 1 {
		t.Fatalf("esperava 1 tentativa em ~30 tiques, obtive %d", calls)
	}
}

// Sem agenda ou sem quem disparar, o Runner não sobe: goroutine que acorda a
// cada trinta segundos para não fazer nada é consumo de bateria.
func TestRunnerDoesNotStartWithoutDependencies(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	NewRunner(nil, func(context.Context, string, string) error { return nil }, quietLogger()).Start(ctx)
	NewRunner(openStore(t), nil, quietLogger()).Start(ctx)
}
