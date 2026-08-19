package store

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

// Um processo MORTO cujo handle ainda está aberto pelo pai tem de ser lido como
// morto.
//
// É o caso que travou o aplicativo: o app é o pai do gateway e guarda o Child
// para colher no encerramento. Enquanto esse handle existe, o objeto do
// processo sobrevive no Windows, `os.FindProcess` continua devolvendo sucesso, e
// a versão anterior concluía "vivo". A trava nunca era considerada órfã, e
// nenhum gateway subia mais naquela pasta — a tela dizia "gateway fora do ar"
// para sempre.
//
// Por isso o teste NÃO chama Wait(): é justamente o handle pendurado que
// reproduz o defeito.
func TestProcessAliveComHandleAberto(t *testing.T) {
	nome := "sleep"
	args := []string{"5"}
	if runtime.GOOS == "windows" {
		nome = "cmd.exe"
		args = []string{"/c", "timeout", "/t", "5", "/nobreak"}
	}

	cmd := exec.Command(nome, args...)
	if err := cmd.Start(); err != nil {
		t.Skipf("não foi possível subir o processo de teste: %v", err)
	}
	pid := cmd.Process.Pid

	if !processAlive(pid) {
		t.Fatalf("processo recém-iniciado (pid %d) foi lido como morto", pid)
	}

	if err := cmd.Process.Kill(); err != nil {
		t.Fatalf("não foi possível matar o processo de teste: %v", err)
	}

	// Sem Wait(): o handle continua aberto, que é o cenário do defeito.
	prazo := time.Now().Add(5 * time.Second)
	for time.Now().Before(prazo) {
		if !processAlive(pid) {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("pid %d continuou sendo lido como VIVO depois de morto — a trava ficaria órfã para sempre", pid)
}

// A trava de um pid morto tem de ser recuperável: é o que permite o gateway
// subir depois de uma queda.
func TestOpenRecuperaTravaOrfa(t *testing.T) {
	dir := t.TempDir()

	// Um pid que não roda: 0 é inválido em todo sistema, e `stale` o rejeita
	// pela própria leitura. Aqui interessa o caminho do pid PLAUSÍVEL e morto.
	cmd := exec.Command("cmd.exe", "/c", "exit")
	if runtime.GOOS != "windows" {
		cmd = exec.Command("true")
	}
	if err := cmd.Run(); err != nil {
		t.Skipf("não foi possível criar um pid morto: %v", err)
	}
	morto := cmd.Process.Pid

	lock := filepath.Join(dir, ".lock")
	if err := os.WriteFile(lock, []byte(itoa(morto)), 0o600); err != nil {
		t.Fatal(err)
	}

	store, err := Open(dir)
	if err != nil {
		t.Fatalf("Open recusou uma trava órfã (pid %d morto): %v", morto, err)
	}
	t.Cleanup(func() { _ = store.Close() })
}

func itoa(v int) string {
	if v == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	return string(buf[i:])
}
