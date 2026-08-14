// Testes do backup. Cada um fixa uma das promessas do cabeçalho do pacote:
// o tar abre e tem o que dizemos que tem, a retenção corta o excedente, o
// espelho recebe a cópia (e a falha dele não derruba nada), e a restauração
// NUNCA escreve por cima do que já existe.
package backup

import (
	"archive/tar"
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// dataDir monta um diretório de dados de mentira com os cinco alvos.
func dataDir(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "sessions", "s1"), 0o700); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		filepath.Join("sessions", "s1", "log.jsonl"): `{"seq":1}` + "\n",
		filepath.Join("sessions", "s1", "meta.json"): `{"id":"s1"}`,
		"memory.json":   `{"facts":[]}`,
		"schedule.json": `{"tasks":[]}`,
		"catalog.json":  `{"providers":[]}`,
		"vault.json":    `{"sealed":"AAAA"}`,
	}
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(root, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

// readTar devolve nome -> conteúdo de um tar.
func readTar(t *testing.T, path string) map[string]string {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatalf("abrir o tar: %v", err)
	}
	defer file.Close()

	out := map[string]string{}
	reader := tar.NewReader(file)
	for {
		header, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("o tar não abre: %v", err)
		}
		content, err := io.ReadAll(reader)
		if err != nil {
			t.Fatalf("ler %s: %v", header.Name, err)
		}
		out[header.Name] = string(content)
	}
	return out
}

func listNames(t *testing.T, directory string) []string {
	t.Helper()
	names, err := listBackups(directory)
	if err != nil {
		t.Fatalf("listar backups: %v", err)
	}
	return names
}

/* -------------------------------- snapshot ------------------------------- */

func TestSnapshotIncluiOsAlvosEOTarAbre(t *testing.T) {
	root := dataDir(t)
	service := New(root, Options{})

	path, err := service.Snapshot()
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	if !strings.HasPrefix(path, filepath.Join(root, "backups")) {
		t.Fatalf("o snapshot deveria morar em <dataDir>/backups, veio %q", path)
	}

	entries := readTar(t, path)
	expected := map[string]string{
		"sessions/s1/log.jsonl": `{"seq":1}` + "\n",
		"sessions/s1/meta.json": `{"id":"s1"}`,
		"memory.json":           `{"facts":[]}`,
		"schedule.json":         `{"tasks":[]}`,
		"catalog.json":          `{"providers":[]}`,
		"vault.json":            `{"sealed":"AAAA"}`,
	}
	for name, want := range expected {
		got, ok := entries[name]
		if !ok {
			t.Errorf("o tar deveria ter %q; tem %v", name, keys(entries))
			continue
		}
		if got != want {
			t.Errorf("%s: conteúdo %q, esperava %q", name, got, want)
		}
	}
}

// A chave mestra e o token NÃO entram: um tar que carrega a chave ao lado do
// vault selado se deslacra sozinho no primeiro disco perdido.
func TestSnapshotNaoLevaAChaveMestraNemOToken(t *testing.T) {
	root := dataDir(t)
	for _, secret := range []string{"master.key", "token"} {
		if err := os.WriteFile(filepath.Join(root, secret), []byte("segredo"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	service := New(root, Options{})
	path, err := service.Snapshot()
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	entries := readTar(t, path)
	for name := range entries {
		if strings.Contains(name, "master.key") || strings.Contains(name, "token") {
			t.Errorf("o tar não pode carregar %q", name)
		}
	}
}

// Alvo ausente é estado normal (schedule.json só nasce no primeiro uso), mas
// um DataDir sem NENHUM alvo é erro — sucesso vazio esconderia um caminho
// errado até o dia da restauração.
func TestSnapshotDeDiretorioVazioFalhaComMotivo(t *testing.T) {
	service := New(t.TempDir(), Options{})
	if _, err := service.Snapshot(); err == nil {
		t.Fatal("um DataDir sem nenhum alvo deveria falhar, não gerar tar vazio")
	}
}

func TestSnapshotIgnoraAlvoAusenteSemFalhar(t *testing.T) {
	root := dataDir(t)
	if err := os.Remove(filepath.Join(root, "schedule.json")); err != nil {
		t.Fatal(err)
	}
	service := New(root, Options{})
	path, err := service.Snapshot()
	if err != nil {
		t.Fatalf("Snapshot com um alvo ausente: %v", err)
	}
	if _, ok := readTar(t, path)["memory.json"]; !ok {
		t.Fatal("os alvos presentes deveriam continuar entrando")
	}
}

/* -------------------------------- retenção ------------------------------- */

func TestRetencaoApagaOExcedenteMantendoOsMaisNovos(t *testing.T) {
	root := dataDir(t)
	service := New(root, Options{Keep: 2})

	var paths []string
	for i := 0; i < 4; i++ {
		path, err := service.Snapshot()
		if err != nil {
			t.Fatalf("Snapshot %d: %v", i, err)
		}
		paths = append(paths, path)
	}

	names := listNames(t, filepath.Join(root, "backups"))
	if len(names) != 2 {
		t.Fatalf("a retenção deveria manter 2, sobraram %d: %v", len(names), names)
	}
	// Os que ficam são os DOIS ÚLTIMOS snapshots tirados.
	kept := map[string]bool{names[0]: true, names[1]: true}
	for _, recent := range paths[len(paths)-2:] {
		if !kept[filepath.Base(recent)] {
			t.Errorf("o snapshot recente %q deveria ter sido mantido; ficaram %v", filepath.Base(recent), names)
		}
	}
}

/* -------------------------------- espelho -------------------------------- */

func TestEspelhoRecebeACopiaDoTarFechado(t *testing.T) {
	root := dataDir(t)
	mirror := t.TempDir()
	service := New(root, Options{Mirror: mirror})

	path, err := service.Snapshot()
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}

	copied := filepath.Join(mirror, filepath.Base(path))
	original, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	mirrored, err := os.ReadFile(copied)
	if err != nil {
		t.Fatalf("o espelho deveria ter %s: %v", filepath.Base(path), err)
	}
	if string(original) != string(mirrored) {
		t.Fatal("a cópia do espelho difere do snapshot local")
	}
}

// A segunda perna não pode derrubar a primeira: espelho quebrado (aqui, um
// ARQUIVO no lugar da pasta) registra e segue — o snapshot local fica de pé.
func TestFalhaNoEspelhoNaoFalhaOSnapshotLocal(t *testing.T) {
	root := dataDir(t)
	broken := filepath.Join(t.TempDir(), "nao-e-pasta")
	if err := os.WriteFile(broken, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	service := New(root, Options{Mirror: broken})

	path, err := service.Snapshot()
	if err != nil {
		t.Fatalf("a falha do espelho não pode falhar o snapshot: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("o snapshot local deveria existir: %v", err)
	}
}

/* ------------------------------- restauração ------------------------------ */

func TestRestoreCriaPastaNovaENuncaSobrescreve(t *testing.T) {
	root := dataDir(t)
	service := New(root, Options{})
	path, err := service.Snapshot()
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}

	first, err := Restore(path)
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}
	restored, err := os.ReadFile(filepath.Join(first, "sessions", "s1", "log.jsonl"))
	if err != nil {
		t.Fatalf("o restaurado deveria ter o log: %v", err)
	}
	if string(restored) != `{"seq":1}`+"\n" {
		t.Fatalf("conteúdo restaurado errado: %q", restored)
	}

	// Marca a primeira restauração; a segunda tem de ir para OUTRA pasta e
	// deixar a marca intacta.
	marker := filepath.Join(first, "marcador.txt")
	if err := os.WriteFile(marker, []byte("meu"), 0o600); err != nil {
		t.Fatal(err)
	}
	second, err := Restore(path)
	if err != nil {
		t.Fatalf("segunda Restore: %v", err)
	}
	if second == first {
		t.Fatal("a segunda restauração reusou a mesma pasta")
	}
	if content, err := os.ReadFile(marker); err != nil || string(content) != "meu" {
		t.Fatalf("a restauração tocou numa pasta que não era dela: %v %q", err, content)
	}
	// E nenhuma das duas encosta no diretório vivo.
	if _, err := os.Stat(filepath.Join(root, "sessions", "s1", "log.jsonl")); err != nil {
		t.Fatalf("o diretório vivo deveria continuar intacto: %v", err)
	}
}

// Restore aceita qualquer tar que a pessoa apontar — inclusive um malicioso
// com `../`, que escreveria FORA da pasta nova. Recusa, não extração.
func TestRestoreRecusaEntradaQueSobeDiretorio(t *testing.T) {
	directory := t.TempDir()
	evil := filepath.Join(directory, "aibot-evil.tar")
	file, err := os.Create(evil)
	if err != nil {
		t.Fatal(err)
	}
	writer := tar.NewWriter(file)
	content := []byte("fora")
	if err := writer.WriteHeader(&tar.Header{Name: "../escapou.txt", Mode: 0o600, Size: int64(len(content))}); err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Write(content); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	if _, err := Restore(evil); err == nil {
		t.Fatal("um tar com ../ deveria ser recusado")
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(directory), "escapou.txt")); err == nil {
		t.Fatal("a entrada maliciosa escreveu fora da pasta de restauração")
	}
}

func TestRestoreDeTarVazioFalhaComMotivo(t *testing.T) {
	directory := t.TempDir()
	empty := filepath.Join(directory, "aibot-vazio.tar")
	file, err := os.Create(empty)
	if err != nil {
		t.Fatal(err)
	}
	writer := tar.NewWriter(file)
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := Restore(empty); err == nil {
		t.Fatal("tar sem nenhum arquivo deveria falhar, não devolver pasta vazia")
	}
}

/* -------------------------------- relógio -------------------------------- */

func TestStartTiraSnapshotsPeriodicos(t *testing.T) {
	root := dataDir(t)
	service := New(root, Options{Every: 20 * time.Millisecond})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	service.Start(ctx)

	directory := filepath.Join(root, "backups")
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if names, err := listBackups(directory); err == nil && len(names) > 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("o relógio deveria ter gravado ao menos um snapshot")
}

/* -------------------------------- ambiente -------------------------------- */

func TestOptionsFromEnvLeEValidaAsVariaveis(t *testing.T) {
	t.Setenv(EnvEvery, "90m")
	t.Setenv(EnvKeep, "5")
	t.Setenv(EnvMirror, `D:\espelho`)
	options := OptionsFromEnv(nil)
	if options.Every != 90*time.Minute {
		t.Errorf("Every: veio %v", options.Every)
	}
	if options.Keep != 5 {
		t.Errorf("Keep: veio %d", options.Keep)
	}
	if options.Mirror != `D:\espelho` {
		t.Errorf("Mirror: veio %q", options.Mirror)
	}
}

// Valor inválido não pode derrubar o boot: o padrão assume e o log explica.
func TestOptionsFromEnvInvalidoCaiNoPadrao(t *testing.T) {
	t.Setenv(EnvEvery, "6 horas")
	t.Setenv(EnvKeep, "-3")
	options := OptionsFromEnv(nil)
	service := New(t.TempDir(), options)
	if service.every != DefaultEvery {
		t.Errorf("Every inválido deveria cair no padrão, veio %v", service.every)
	}
	if service.keep != DefaultKeep {
		t.Errorf("Keep inválido deveria cair no padrão, veio %d", service.keep)
	}
}

func keys(entries map[string]string) []string {
	out := make([]string, 0, len(entries))
	for name := range entries {
		out = append(out, name)
	}
	return out
}
