package store

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"testing"
	"time"
)

// A decisão é o coração: derrubar processo errado corrompe seq; deixar de
// derrubar o órfão devolve o defeito vivido (app novo conversando com o
// gateway de ontem). Cada linha é um lado da faca.
func TestStaleHolderDecideEstreito(t *testing.T) {
	exe := `C:\app\dist\aibotd.exe`
	mtime := time.Date(2026, 8, 20, 6, 19, 0, 0, time.UTC)

	cases := []struct {
		nome        string
		holderExe   string
		holderStart time.Time
		derruba     bool
	}{
		{"órfão clássico: mesmo exe, começou antes do build", exe, mtime.Add(-21 * time.Hour), true},
		{"mesmo exe com caixa diferente (NTFS não diferencia)", `c:\APP\dist\AIBOTD.EXE`, mtime.Add(-time.Hour), true},
		{"outro executável NUNCA é derrubado", `C:\outra\coisa.exe`, mtime.Add(-time.Hour), false},
		{"começou depois do build: pode ser este mesmo binário", exe, mtime.Add(time.Minute), false},
		{"começou exatamente no mtime: dúvida preserva a trava", exe, mtime, false},
		{"hora de início desconhecida: dúvida preserva a trava", exe, time.Time{}, false},
	}
	for _, tc := range cases {
		motivo := staleHolder(exe, mtime, tc.holderExe, tc.holderStart)
		if (motivo == "") != tc.derruba {
			t.Errorf("%s: derruba=%v, esperado %v (motivo %q)", tc.nome, motivo == "", tc.derruba, motivo)
		}
	}
}

// A sonda contra o PRÓPRIO processo prova que ela fala com o núcleo de
// verdade: o caminho tem de ser o do binário de teste e o início não pode ser
// nem zero nem futuro.
func TestHolderImageDoProprioProcesso(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("sonda implementada só no Windows por enquanto")
	}
	image, started, err := holderImage(os.Getpid())
	if err != nil {
		t.Fatalf("sondar o próprio pid: %v", err)
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Clean(image) != filepath.Clean(self) {
		t.Fatalf("imagem %q não é o próprio executável %q", image, self)
	}
	if started.IsZero() || started.After(time.Now().Add(time.Minute)) {
		t.Fatalf("hora de início sem sentido: %v", started)
	}
}

// O lado da segurança de ponta a ponta: a trava apontando para um processo
// VIVO de OUTRO executável nunca é roubada — e o processo continua vivo.
func TestTakeoverRecusaProcessoQueNaoEhNosso(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("takeover implementado só no Windows por enquanto")
	}
	// Um processo qualquer, comprovadamente vivo e comprovadamente não-aibotd.
	cobaia := exec.Command("ping", "-n", "30", "127.0.0.1")
	if err := cobaia.Start(); err != nil {
		t.Fatalf("subir a cobaia: %v", err)
	}
	defer func() {
		_ = cobaia.Process.Kill()
		_, _ = cobaia.Process.Wait()
	}()

	root := t.TempDir()
	lock := filepath.Join(root, ".lock")
	if err := os.WriteFile(lock, []byte(strconv.Itoa(cobaia.Process.Pid)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	took, cause := TakeoverStale(root)
	if took {
		t.Fatal("derrubou um processo que não é o nosso executável — é exatamente a corrupção que a trava evita")
	}
	if cause == nil {
		t.Fatal("a recusa precisa dizer o motivo")
	}
	if !processAlive(cobaia.Process.Pid) {
		t.Fatal("a cobaia morreu — o takeover encostou em quem não devia")
	}
}

// Trava ilegível, pid inválido e pid próprio: todos preservam a trava.
func TestTakeoverRecusaTravasEstranhas(t *testing.T) {
	root := t.TempDir()
	lock := filepath.Join(root, ".lock")

	if _, err := TakeoverStale(root); err == nil {
		t.Fatal("sem arquivo de trava devia falhar")
	}
	if err := os.WriteFile(lock, []byte("isto não é um pid\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if took, _ := TakeoverStale(root); took {
		t.Fatal("pid ilegível não pode derrubar ninguém")
	}
	if err := os.WriteFile(lock, []byte(strconv.Itoa(os.Getpid())+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if took, _ := TakeoverStale(root); took {
		t.Fatal("a própria trava do processo não é alvo de takeover")
	}
}
