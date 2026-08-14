// Testes do Corporate Capability Pack.
//
// A ordem é a do risco: primeiro a recusa (um pacote meio-aplicado é o estado
// que ninguém explica), depois a soma de políticas (a regra de segurança — o
// pacote nunca pode AFROUXAR nada) e então a mecânica de disco (templates,
// persistência, tar).
package pack

import (
	"archive/tar"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"aibot/gateway/internal/permissions"
)

/* ------------------------------- auxiliares ------------------------------- */

// overlayDoc é um overlay ESTRUTURALMENTE válido para o Load do pacote. A
// validação semântica completa é do specialist.LoadOverlay, que os testes
// substituem por um fake — aqui interessa o contrato do pacote, não o catálogo.
const overlayDoc = `{"schemaVersion":1,"version":"9.9.9","specialists":[{"id":"financeiro"}]}`

// writeFiles materializa um pacote em disco a partir de um mapa caminho→texto.
func writeFiles(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	for name, content := range files {
		path := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatalf("criar pasta de %s: %v", name, err)
		}
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatalf("gravar %s: %v", name, err)
		}
	}
}

// validManifest é o manifesto completo do qual os testes de recusa partem,
// quebrando UMA coisa por vez.
func validManifest() Manifest {
	return Manifest{
		SchemaVersion: 1,
		Name:          "financeiro-empresa",
		Version:       "1.0.0",
		Specialists:   "specialists.json",
		MCP:           []MCPServer{{Name: "erp", URL: "https://erp.interno.example/mcp", SecretRef: "mcp:erp"}},
		Prompts:       map[string]string{"financeiro": "prompts/financeiro.md"},
		Policies:      Policies{DeniedTools: []string{"proc.run"}, BlockedDomains: []string{"pastebin.com"}},
		Templates:     []string{"templates/financeiro.pptx"},
		Hooks: []HookSpec{
			{On: "after_tool", Tool: "fs.write", Action: "audit"},
			{On: "on_error", Action: "webhook", SecretRef: "webhook.si"},
		},
	}
}

// writePack grava manifesto + arquivos referenciados e devolve o diretório.
func writePack(t *testing.T, manifest Manifest) string {
	t.Helper()
	dir := t.TempDir()
	raw, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		t.Fatalf("serializar o manifesto: %v", err)
	}
	writeFiles(t, dir, map[string]string{
		"manifest.json":             string(raw),
		"specialists.json":          overlayDoc,
		"prompts/financeiro.md":     "Use o plano de contas oficial da empresa.",
		"templates/financeiro.pptx": "conteudo-do-template",
	})
	return dir
}

func mustLoad(t *testing.T, dir string) Pack {
	t.Helper()
	loaded, err := Load(dir)
	if err != nil {
		t.Fatalf("Load(%s): esperava sucesso, obteve erro: %v", dir, err)
	}
	return loaded
}

/* ------------------------------ recusa inteira ----------------------------- */

// Um manifesto com QUALQUER problema recusa o pacote INTEIRO — e a recusa lista
// todos os problemas de uma vez, para quem publica não descobri-los um por um.
func TestLoadRecusaManifestoInvalidoInteiro(t *testing.T) {
	t.Cleanup(reset)
	manifest := validManifest()
	manifest.Name = "Nome Com Espaço"                                                             // vira diretório: alfabeto fechado
	manifest.Prompts = map[string]string{"financeiro": "prompts/nao-existe.md"}                   // arquivo ausente
	manifest.MCP = append(manifest.MCP, MCPServer{Name: "solto", URL: "http://fora.example/mcp"}) // http fora de loopback
	manifest.Hooks = append(manifest.Hooks, HookSpec{On: "after_tool", Action: "deny"})           // deny depois do fato

	dir := writePack(t, manifest)
	_, err := Load(dir)
	if err == nil {
		t.Fatal("Load: esperava recusa do pacote inteiro, obteve sucesso")
	}
	if !errors.Is(err, ErrPack) {
		t.Fatalf("Load: esperava ErrPack, obteve %v", err)
	}
	for _, want := range []string{"name", "nao-existe.md", "loopback", "deny"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("a recusa precisa listar todos os problemas; faltou %q em:\n%v", want, err)
		}
	}
}

// Caminho com `..` no manifesto leria (e o persist copiaria) qualquer arquivo
// do disco de quem instala — é recusado antes de tocar o sistema de arquivos.
func TestLoadRecusaCaminhoQueEscapaDoPacote(t *testing.T) {
	t.Cleanup(reset)
	manifest := validManifest()
	manifest.Prompts = map[string]string{"financeiro": "../fora-do-pacote.md"}

	dir := writePack(t, manifest)
	// O arquivo EXISTE fora do pacote, de propósito: a recusa tem de vir do
	// caminho, não da ausência.
	writeFiles(t, filepath.Dir(dir), map[string]string{"fora-do-pacote.md": "conteudo"})

	if _, err := Load(dir); err == nil || !errors.Is(err, ErrPack) {
		t.Fatalf("Load: esperava recusa por caminho fora do pacote, obteve %v", err)
	}
}

func TestLoadRecusaEsquemaDesconhecido(t *testing.T) {
	t.Cleanup(reset)
	manifest := validManifest()
	manifest.SchemaVersion = 2
	if _, err := Load(writePack(t, manifest)); err == nil || !errors.Is(err, ErrPack) {
		t.Fatalf("Load: esperava recusa por esquema 2, obteve %v", err)
	}
}

func TestLoadCarregaConteudoDoPacoteValido(t *testing.T) {
	t.Cleanup(reset)
	loaded := mustLoad(t, writePack(t, validManifest()))

	if string(loaded.SpecialistsRaw) != overlayDoc {
		t.Errorf("o overlay precisa vir em memória; obteve %q", loaded.SpecialistsRaw)
	}
	if got := loaded.PromptTexts["financeiro"]; !strings.Contains(got, "plano de contas") {
		t.Errorf("o prompt precisa vir lido do arquivo; obteve %q", got)
	}
}

/* ------------------------------ soma de política ---------------------------- */

// A regra de segurança do pacote: as políticas SOMAM e NUNCA removem. O que o
// admin já tinha recusado continua recusado; o que o pacote recusa entra na
// união; e nenhum campo permissivo muda.
func TestInstallSomaPoliticasNuncaRemove(t *testing.T) {
	t.Cleanup(reset)
	base := permissions.DefaultPolicy()
	base.DeniedTools = []string{"proc.run"}
	base.BlockedDomains = []string{"interno.example"}
	gate := permissions.NewGate(base)

	manifest := validManifest()
	// PROC.RUN em caixa diferente é a MESMA regra — não pode duplicar; e a
	// lista do pacote não traz o domínio do admin, que não pode sumir.
	manifest.Policies = Policies{
		DeniedTools:    []string{"webhook.post", "PROC.RUN"},
		BlockedDomains: []string{"pastebin.com"},
	}

	loaded := mustLoad(t, writePack(t, manifest))
	if err := Install(loaded, Deps{DataDir: t.TempDir(), Gate: gate}); err != nil {
		t.Fatalf("Install: esperava sucesso, obteve erro: %v", err)
	}

	got := gate.Policy()
	wantDenied := []string{"proc.run", "webhook.post"}
	for _, tool := range wantDenied {
		found := false
		for _, denied := range got.DeniedTools {
			if strings.EqualFold(denied, tool) {
				found = true
			}
		}
		if !found {
			t.Errorf("DeniedTools precisa conter %q depois da soma; obteve %v", tool, got.DeniedTools)
		}
	}
	if len(got.DeniedTools) != 2 {
		t.Errorf("a união não pode duplicar a mesma regra em caixa diferente; obteve %v", got.DeniedTools)
	}
	for _, domain := range []string{"interno.example", "pastebin.com"} {
		found := false
		for _, blocked := range got.BlockedDomains {
			if strings.EqualFold(blocked, domain) {
				found = true
			}
		}
		if !found {
			t.Errorf("BlockedDomains precisa conter %q depois da soma; obteve %v", domain, got.BlockedDomains)
		}
	}
	// Os campos permissivos não são do pacote: modo e interruptor ficam como o
	// admin deixou — pacote que os tocasse seria o caminho barato de abrir a
	// estação.
	if got.Mode != base.Mode || got.AgentTools != base.AgentTools {
		t.Errorf("o pacote alterou campo permissivo: modo %q→%q, agentTools %t→%t",
			base.Mode, got.Mode, base.AgentTools, got.AgentTools)
	}
}

// O overlay recusado aborta o Install INTEIRO: nada persiste e a política não
// muda — meio pacote aplicado é pior que nenhum.
func TestInstallAbortaInteiroQuandoOverlayRecusa(t *testing.T) {
	t.Cleanup(reset)
	gate := permissions.NewGate(permissions.DefaultPolicy())
	dataDir := t.TempDir()
	loaded := mustLoad(t, writePack(t, validManifest()))

	err := Install(loaded, Deps{
		DataDir:      dataDir,
		Gate:         gate,
		ApplyOverlay: func([]byte) error { return errors.New("catálogo sem o especialista padrão") },
	})
	if err == nil {
		t.Fatal("Install: esperava a recusa do overlay abortar tudo, obteve sucesso")
	}
	if len(gate.Policy().DeniedTools) != 0 {
		t.Errorf("a política não pode mudar num install abortado; obteve %v", gate.Policy().DeniedTools)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "packs", loaded.Name)); !os.IsNotExist(err) {
		t.Errorf("o pacote não pode persistir num install abortado (stat: %v)", err)
	}
	if len(Installed()) != 0 {
		t.Errorf("o registro não pode listar um pacote que não instalou: %v", Installed())
	}
}

/* -------------------------------- templates -------------------------------- */

func TestInstallCopiaTemplatesParaAPastaDeDados(t *testing.T) {
	t.Cleanup(reset)
	dataDir := t.TempDir()
	loaded := mustLoad(t, writePack(t, validManifest()))

	if err := Install(loaded, Deps{DataDir: dataDir}); err != nil {
		t.Fatalf("Install: esperava sucesso, obteve erro: %v", err)
	}

	copied := filepath.Join(dataDir, "templates", loaded.Name, "financeiro.pptx")
	raw, err := os.ReadFile(copied)
	if err != nil {
		t.Fatalf("o template precisa existir em %s: %v", copied, err)
	}
	if string(raw) != "conteudo-do-template" {
		t.Errorf("o conteúdo do template mudou na cópia: %q", raw)
	}
}

/* --------------------------- persistência e boot --------------------------- */

// O install de hoje é o boot de amanhã: o pacote persiste em <dataDir>/packs e
// o Discover o relê inteiro (revalidando), pronto para o Install do boot.
func TestInstallPersisteEDiscoverRele(t *testing.T) {
	t.Cleanup(reset)
	dataDir := t.TempDir()
	loaded := mustLoad(t, writePack(t, validManifest()))
	if err := Install(loaded, Deps{DataDir: dataDir}); err != nil {
		t.Fatalf("Install: %v", err)
	}

	reset() // simula outro processo (o boot do gateway)
	found, err := Discover(dataDir)
	if err != nil {
		t.Fatalf("Discover: esperava sucesso, obteve erro: %v", err)
	}
	if len(found) != 1 || found[0].Name != "financeiro-empresa" {
		t.Fatalf("Discover: esperava o pacote persistido, obteve %+v", found)
	}
	if got := found[0].PromptTexts["financeiro"]; !strings.Contains(got, "plano de contas") {
		t.Errorf("o prompt precisa sobreviver à persistência; obteve %q", got)
	}
	// E o Install a partir da cópia persistida não pode falhar (é o boot).
	if err := Install(found[0], Deps{DataDir: dataDir}); err != nil {
		t.Fatalf("Install no boot: %v", err)
	}
}

func TestRemoveApagaDiscoERegistro(t *testing.T) {
	t.Cleanup(reset)
	dataDir := t.TempDir()
	loaded := mustLoad(t, writePack(t, validManifest()))
	if err := Install(loaded, Deps{DataDir: dataDir}); err != nil {
		t.Fatalf("Install: %v", err)
	}

	if err := Remove(loaded.Name); err != nil {
		t.Fatalf("Remove: esperava sucesso, obteve erro: %v", err)
	}
	if len(Installed()) != 0 {
		t.Errorf("o registro precisa esquecer o pacote removido: %v", Installed())
	}
	for _, gone := range []string{
		filepath.Join(dataDir, "packs", loaded.Name),
		filepath.Join(dataDir, "templates", loaded.Name),
	} {
		if _, err := os.Stat(gone); !os.IsNotExist(err) {
			t.Errorf("%s precisa sumir do disco (stat: %v)", gone, err)
		}
	}
	if err := Remove(loaded.Name); err == nil {
		t.Error("Remove de pacote inexistente precisa recusar com motivo, obteve sucesso")
	}
}

/* --------------------------------- prompts --------------------------------- */

// Dois pacotes com prompt para o MESMO especialista agregam em ordem de nome —
// o prompt final é o mesmo em toda estação, independente da ordem de install.
func TestPromptForAgregaPorOrdemDeNome(t *testing.T) {
	t.Cleanup(reset)
	dataDir := t.TempDir()

	second := validManifest()
	second.Name = "zz-riscos"
	second.MCP, second.Templates, second.Hooks = nil, nil, nil
	second.Specialists = ""
	secondDir := t.TempDir()
	raw, _ := json.Marshal(second)
	writeFiles(t, secondDir, map[string]string{
		"manifest.json":         string(raw),
		"prompts/financeiro.md": "Nunca aprove lançamento sem centro de custo.",
	})

	if err := Install(mustLoad(t, writePack(t, validManifest())), Deps{DataDir: dataDir}); err != nil {
		t.Fatalf("Install do primeiro: %v", err)
	}
	if err := Install(mustLoad(t, secondDir), Deps{DataDir: dataDir}); err != nil {
		t.Fatalf("Install do segundo: %v", err)
	}

	got := PromptFor("financeiro")
	first := strings.Index(got, "plano de contas")
	last := strings.Index(got, "centro de custo")
	if first < 0 || last < 0 || first > last {
		t.Errorf("PromptFor precisa agregar os dois prompts em ordem de nome de pacote; obteve %q", got)
	}
	if PromptFor("code") != "" {
		t.Errorf("especialista sem prompt de pacote precisa receber vazio; obteve %q", PromptFor("code"))
	}
}

/* ----------------------------------- .tar ---------------------------------- */

func TestLoadLePacoteEmTar(t *testing.T) {
	t.Cleanup(reset)
	source := writePack(t, validManifest())

	tarPath := filepath.Join(t.TempDir(), "financeiro.tar")
	out, err := os.Create(tarPath)
	if err != nil {
		t.Fatalf("criar o tar: %v", err)
	}
	writer := tar.NewWriter(out)
	walkErr := filepath.WalkDir(source, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		if err := writer.WriteHeader(&tar.Header{
			Name: filepath.ToSlash(relative),
			Mode: 0o600,
			Size: int64(len(raw)),
		}); err != nil {
			return err
		}
		_, err = writer.Write(raw)
		return err
	})
	if walkErr != nil {
		t.Fatalf("montar o tar: %v", walkErr)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("fechar o tar: %v", err)
	}
	if err := out.Close(); err != nil {
		t.Fatalf("fechar o arquivo: %v", err)
	}

	loaded, err := Load(tarPath)
	if err != nil {
		t.Fatalf("Load(.tar): esperava sucesso, obteve erro: %v", err)
	}
	defer loaded.Cleanup()
	if loaded.Name != "financeiro-empresa" || len(loaded.PromptTexts) != 1 {
		t.Errorf("o pacote extraído do tar veio incompleto: %+v", loaded.Manifest)
	}
}

// Um tar com `..` no nome extrairia FORA do diretório temporário — em qualquer
// lugar do disco de quem instalou. A recusa tem de vir na extração.
func TestLoadRecusaTarComEscapeDeCaminho(t *testing.T) {
	t.Cleanup(reset)
	tarPath := filepath.Join(t.TempDir(), "hostil.tar")
	out, err := os.Create(tarPath)
	if err != nil {
		t.Fatalf("criar o tar: %v", err)
	}
	writer := tar.NewWriter(out)
	payload := []byte("estou fora")
	if err := writer.WriteHeader(&tar.Header{Name: "../fora.txt", Mode: 0o600, Size: int64(len(payload))}); err != nil {
		t.Fatalf("escrever o header: %v", err)
	}
	if _, err := writer.Write(payload); err != nil {
		t.Fatalf("escrever o corpo: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("fechar o tar: %v", err)
	}
	if err := out.Close(); err != nil {
		t.Fatalf("fechar o arquivo: %v", err)
	}

	if _, err := Load(tarPath); err == nil || !errors.Is(err, ErrPack) {
		t.Fatalf("Load: esperava recusa do tar hostil, obteve %v", err)
	}
}
