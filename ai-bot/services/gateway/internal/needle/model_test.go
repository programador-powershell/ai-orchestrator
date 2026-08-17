package needle

import (
	"os"
	"path/filepath"
	"testing"
)

func writeModel(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatalf("criar pasta do modelo: %v", err)
	}
	if err := os.WriteFile(path, []byte("pesos de mentira"), 0o600); err != nil {
		t.Fatalf("gravar modelo de teste: %v", err)
	}
}

func TestResolveModelPathPrefersTheExplicitPath(t *testing.T) {
	dataDir := t.TempDir()
	explicit := filepath.Join(t.TempDir(), "meu.cact")
	writeModel(t, explicit)
	// O do diretório de dados também existe — e mesmo assim o explícito vence:
	// quem apontou um caminho na mão quer AQUELE arquivo, não o padrão.
	writeModel(t, filepath.Join(dataDir, "models", ModelFileName))

	path, found := ResolveModelPath(explicit, dataDir)
	if !found {
		t.Fatal("esperava achar o modelo explícito")
	}
	if path != explicit {
		t.Errorf("esperava o caminho explícito %q, veio %q", explicit, path)
	}
}

func TestResolveModelPathFindsTheDataDirModel(t *testing.T) {
	dataDir := t.TempDir()
	installed := filepath.Join(dataDir, "models", ModelFileName)
	writeModel(t, installed)

	path, found := ResolveModelPath("", dataDir)
	if !found {
		t.Fatal("esperava achar o modelo no diretório de dados")
	}
	if path != installed {
		t.Errorf("esperava %q, veio %q", installed, path)
	}
}

func TestResolveModelPathFallsBackToTheLegacyName(t *testing.T) {
	dataDir := t.TempDir()
	legacy := filepath.Join(dataDir, "models", BaseModelFileName)
	writeModel(t, legacy)

	path, found := ResolveModelPath("", dataDir)
	if !found {
		t.Fatal("esperava achar o modelo pelo nome legado")
	}
	if path != legacy {
		t.Errorf("esperava %q, veio %q", legacy, path)
	}
}

func TestResolveModelPathSaysWhereToInstallWhenMissing(t *testing.T) {
	dataDir := t.TempDir()

	path, found := ResolveModelPath("", dataDir)
	if found {
		t.Fatal("não deveria achar modelo em diretório vazio")
	}
	// A mensagem de log usa este caminho para dizer ONDE instalar — ele tem de
	// ser o preferido (dados + nome novo), não uma string vazia.
	want := filepath.Join(dataDir, "models", ModelFileName)
	if path != want {
		t.Errorf("esperava a indicação de instalação %q, veio %q", want, path)
	}
}

func TestModelCandidatesKeepsPriorityOrder(t *testing.T) {
	dataDir := filepath.Join("c:", "dados")
	candidates := ModelCandidates("apontado.cact", dataDir)
	if len(candidates) < 3 {
		t.Fatalf("esperava ao menos 3 candidatos, vieram %d", len(candidates))
	}
	if candidates[0] != "apontado.cact" {
		t.Errorf("o caminho explícito tem de vir primeiro, veio %q", candidates[0])
	}
	if candidates[1] != filepath.Join(dataDir, "models", ModelFileName) {
		t.Errorf("o segundo candidato tem de ser o .cact do diretório de dados, veio %q", candidates[1])
	}
	// Um diretório no lugar do arquivo NÃO conta como modelo.
	trap := t.TempDir()
	if err := os.MkdirAll(filepath.Join(trap, "models", ModelFileName), 0o700); err != nil {
		t.Fatalf("montar armadilha: %v", err)
	}
	if _, found := ResolveModelPath("", trap); found {
		t.Error("um diretório com o nome do modelo não pode passar por arquivo de pesos")
	}
}
