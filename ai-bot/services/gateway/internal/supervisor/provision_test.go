// O contrato do WORKSPACE AUTOMÁTICO: um especialista de trabalho nunca
// executa numa sessão sem pasta de projeto — o gateway provisiona uma pasta
// durável em <dataDir>/projects e o turno segue.
//
// O defeito que este arquivo guarda: nenhuma sessão nascia com cwd, a árvore
// da IDE morria em "esta sessão não tem pasta de projeto definida" e o
// especialista recusava gravar arquivos. As fronteiras, cada uma com teste:
//
//   - /mode code numa sessão sem pasta → pasta provisionada E modo adotado
//     (a adoção continua intacta — provisionar não muda quem é o dono);
//   - segunda delegação na mesma raiz → a MESMA filha e a MESMA pasta
//     (provisão nunca troca o projeto debaixo do trabalho);
//   - título malicioso (/, \, .., :) → slug saneado DENTRO de projects/;
//   - fs.list numa filha recém-provisionada → listagem vazia legítima, não a
//     recusa de quem não tem pasta.
package supervisor

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"aibot/gateway/internal/eventbus"
	"aibot/gateway/internal/permissions"
	"aibot/gateway/internal/protocol"
	"aibot/gateway/internal/specialist"
	"aibot/gateway/internal/store"
	"aibot/gateway/internal/workspace"
)

// provisionFixture é o supervisor de um teste de workspace automático: uma
// raiz SEM pasta de projeto (o cenário real do defeito) e o gerente de
// workspaces lendo o meta — a mesma ligação do main.go, para o teste provar o
// caminho inteiro (meta → plano → ferramenta) e não só a gravação do campo.
type provisionFixture struct {
	supervisor *Supervisor
	store      *store.Store
	registry   *Registry
	session    string
}

func newProvisionFixture(t *testing.T, routes []route) *provisionFixture {
	t.Helper()
	dataStore, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("abrir o store: %v", err)
	}
	t.Cleanup(func() { dataStore.Close() })

	const sessionID = "s-sem-pasta"
	if _, err := dataStore.CreateSession(store.SessionMeta{ID: sessionID, Model: "m1"}); err != nil {
		t.Fatalf("criar sessão: %v", err)
	}

	provider := newRoutedProvider(t, routes, "sem rota")
	registry := NewRegistry()
	(&Toolbox{}).Install(registry)
	supervisor := New(Deps{
		Store:  dataStore,
		Bus:    eventbus.New(dataStore),
		Models: scriptedRouter(provider.server.URL),
		Gate:   permissions.NewGate(permissions.DefaultPolicy()),
		Tools:  registry,
		Router: NewRouter(nil, nil),
		Workspaces: workspace.NewManager(func(id string) string {
			meta, err := dataStore.GetSession(id)
			if err != nil {
				return ""
			}
			return meta.CWD
		}),
	})
	return &provisionFixture{supervisor: supervisor, store: dataStore, registry: registry, session: sessionID}
}

// projectsDirOf é o prefixo em que TODA pasta provisionada tem de morar.
func projectsDirOf(dataStore *store.Store) string {
	return filepath.Join(dataStore.Root(), "projects") + string(filepath.Separator)
}

// requireProvisionedDir reprova a pasta que não existe ou que escapou de
// <dataDir>/projects — o confinamento é metade do contrato.
func requireProvisionedDir(t *testing.T, dataStore *store.Store, cwd string) {
	t.Helper()
	if strings.TrimSpace(cwd) == "" {
		t.Fatal("a sessão ficou sem pasta de projeto — a árvore da IDE abre morta")
	}
	if !strings.HasPrefix(cwd, projectsDirOf(dataStore)) {
		t.Fatalf("a pasta provisionada tinha de morar em %q, obtive %q", projectsDirOf(dataStore), cwd)
	}
	info, err := os.Stat(cwd)
	if err != nil || !info.IsDir() {
		t.Fatalf("a pasta provisionada não existe no disco: %v", err)
	}
}

/* --------------------- /mode code provisiona e adota ---------------------- */

// /mode é ESCOLHA: a conversa vira o bot como sempre virou (modo gravado, rota
// explícita na própria sessão, nenhuma filha) — e agora, sem pasta, ela ganha
// uma antes de o especialista executar.
func TestModeCodeSemPastaProvisionaEAdota(t *testing.T) {
	fixture := newProvisionFixture(t, []route{
		{trigger: "ajuste o rodape", answer: "rodapé ajustado"},
	})

	if err := fixture.supervisor.Prompt(motorContext(t), fixture.session,
		protocol.Prompt{Text: "/mode code ajuste o rodape do site"}); err != nil {
		t.Fatalf("prompt: %v", err)
	}

	meta, err := fixture.store.GetSession(fixture.session)
	if err != nil {
		t.Fatalf("ler a sessão: %v", err)
	}
	if meta.Specialist != "code" {
		t.Errorf("/mode code tinha de gravar o modo (adoção intacta), obtive %q", meta.Specialist)
	}
	requireProvisionedDir(t, fixture.store, meta.CWD)

	if _, err := fixture.store.GetSession(store.ChildSessionID(fixture.session, "code")); err == nil {
		t.Error("a escolha explícita abriu conversa filha — /mode adota, não delega")
	}
	rotas := envelopesByKind(t, fixture.store, fixture.session, protocol.KindRoute)
	if len(rotas) != 1 {
		t.Fatalf("esperava a rota explícita na própria sessão, obtive %d", len(rotas))
	}
	var rota protocol.Route
	if err := rotas[0].Decode(&rota); err != nil {
		t.Fatalf("decodificar a rota: %v", err)
	}
	if rota.Reason != protocol.RouteExplicit || rota.Specialist != "code" {
		t.Errorf("esperava code/explicit, obtive %q/%q", rota.Specialist, rota.Reason)
	}
}

// O `/mode code` SOZINHO (sem pedido junto) troca o modo, encerra o turno — e
// também provisiona: a rota flipa a tela para a IDE agora, e uma IDE sem pasta
// abriria com a árvore morta até o próximo turno.
func TestModeCodeSozinhoTambemProvisiona(t *testing.T) {
	fixture := newProvisionFixture(t, nil)

	if err := fixture.supervisor.Prompt(motorContext(t), fixture.session,
		protocol.Prompt{Text: "/mode code"}); err != nil {
		t.Fatalf("prompt: %v", err)
	}

	meta, err := fixture.store.GetSession(fixture.session)
	if err != nil {
		t.Fatalf("ler a sessão: %v", err)
	}
	if meta.Specialist != "code" {
		t.Errorf("/mode code tinha de gravar o modo, obtive %q", meta.Specialist)
	}
	requireProvisionedDir(t, fixture.store, meta.CWD)
}

/* ------------------ segunda delegação reusa a mesma pasta ------------------ */

// A raiz sem pasta delega: a pasta nasce NA raiz e a filha a herda — o mesmo
// projeto dos dois lados. A segunda delegação na MESMA raiz continua na MESMA
// filha e na MESMA pasta: provisão acontece uma vez, nunca troca o projeto
// debaixo do trabalho em andamento.
func TestSegundaDelegacaoReusaAMesmaFilhaEAMesmaPasta(t *testing.T) {
	const segundoPedido = "construa um app com um botao de contato"
	fixture := newProvisionFixture(t, []route{
		// O gatilho do segundo pedido vem PRIMEIRO: o corpo da segunda chamada
		// também contém o primeiro pedido (é a memória descendo).
		{trigger: segundoPedido, answer: "adicionei o botão"},
		{trigger: pedidoDeTrabalho, answer: "<html>hello</html>"},
	})

	ctx := motorContext(t)
	if err := fixture.supervisor.Prompt(ctx, fixture.session,
		protocol.Prompt{Text: pedidoDeTrabalho}); err != nil {
		t.Fatalf("primeiro prompt: %v", err)
	}

	raiz, err := fixture.store.GetSession(fixture.session)
	if err != nil {
		t.Fatalf("ler a raiz: %v", err)
	}
	requireProvisionedDir(t, fixture.store, raiz.CWD)

	filhoID := store.ChildSessionID(fixture.session, "code")
	filho, err := fixture.store.GetSession(filhoID)
	if err != nil {
		t.Fatalf("a filha não nasceu: %v", err)
	}
	if filho.CWD != raiz.CWD {
		t.Fatalf("raiz e filha tinham de compartilhar o MESMO projeto: raiz %q, filha %q", raiz.CWD, filho.CWD)
	}

	if err := fixture.supervisor.Prompt(ctx, fixture.session,
		protocol.Prompt{Text: segundoPedido}); err != nil {
		t.Fatalf("segundo prompt: %v", err)
	}

	depois, err := fixture.store.GetSession(fixture.session)
	if err != nil {
		t.Fatalf("reler a raiz: %v", err)
	}
	if depois.CWD != raiz.CWD {
		t.Errorf("a segunda delegação trocou a pasta da raiz: %q → %q", raiz.CWD, depois.CWD)
	}
	filhoDepois, err := fixture.store.GetSession(filhoID)
	if err != nil {
		t.Fatalf("reler a filha: %v", err)
	}
	if filhoDepois.CWD != filho.CWD {
		t.Errorf("a segunda delegação trocou a pasta da filha: %q → %q", filho.CWD, filhoDepois.CWD)
	}
	// E todos os envelopes apontam para a MESMA filha — dois pares abre/fecha.
	delegations := delegateEnvelopes(t, fixture.store, fixture.session)
	if len(delegations) != 4 {
		t.Fatalf("esperava 2 pares abre/fecha, obtive %d", len(delegations))
	}
	for i, payload := range delegations {
		if payload.Session != filhoID {
			t.Errorf("envelope %d aponta para %q, esperava a mesma filha %q", i, payload.Session, filhoID)
		}
	}
}

/* ------------------------------ slug saneado ------------------------------- */

// O slug vem de texto da PESSOA (título, pedido) e vira nome de pasta: tudo o
// que significaria outra coisa num caminho (/ \ .. :) tem de sumir — o nome é
// UM componente, sem como subir de diretório.
func TestProjectSlugSaneiaSeparadoresETraversal(t *testing.T) {
	cases := []struct {
		name string
		seed string
	}{
		{"traversal com barras", `../../etc/passwd`},
		{"barras do windows e unidade", `..\..\C:\Windows\System32`},
		{"mistura com espaços", `construa / um \ site .. : agora`},
		{"só lixo", `../..\\::`},
		{"vazio", ``},
	}
	for _, each := range cases {
		t.Run(each.name, func(t *testing.T) {
			slug := projectSlug(each.seed, "s-1755-42")
			if slug == "" {
				t.Fatal("slug vazio não nomeia pasta nenhuma")
			}
			for _, symbol := range slug {
				safe := (symbol >= 'a' && symbol <= 'z') || (symbol >= '0' && symbol <= '9') || symbol == '-'
				if !safe {
					t.Fatalf("o slug %q carrega o caractere proibido %q", slug, symbol)
				}
			}
			if strings.Contains(slug, "..") {
				t.Fatalf("o slug %q ainda carrega traversal", slug)
			}
			// A prova de confinamento: juntar o slug a projects/ tem de continuar
			// DENTRO de projects/ — é o que o MkdirAll vai receber.
			base := filepath.Join("dados", "projects")
			if dir := filepath.Clean(filepath.Join(base, slug)); !strings.HasPrefix(dir, base+string(filepath.Separator)) {
				t.Fatalf("o slug %q escapou de projects/: %q", slug, dir)
			}
		})
	}
}

// E o caminho inteiro: um título malicioso atravessa a provisão e a pasta
// criada continua dentro de <dataDir>/projects.
func TestProvisionaProjetoConfinaTituloMalicioso(t *testing.T) {
	dataStore, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("abrir o store: %v", err)
	}
	t.Cleanup(func() { dataStore.Close() })
	const sessionID = "s-malicioso"
	if _, err := dataStore.CreateSession(store.SessionMeta{ID: sessionID}); err != nil {
		t.Fatalf("criar sessão: %v", err)
	}

	supervisor := New(Deps{Store: dataStore})
	if !supervisor.provisionaProjeto(sessionID, "t-1", specialist.GetOrDefault("code"),
		`../../..\..\C:\Windows:evil`) {
		t.Fatal("a provisão tinha de acontecer — a sessão não tem pasta")
	}
	meta, err := dataStore.GetSession(sessionID)
	if err != nil {
		t.Fatalf("ler a sessão: %v", err)
	}
	requireProvisionedDir(t, dataStore, meta.CWD)

	// A segunda chamada é um não-fazer: a pasta já é decisão tomada.
	if supervisor.provisionaProjeto(sessionID, "t-2", specialist.GetOrDefault("code"), "outro título") {
		t.Error("a segunda provisão tinha de ser recusada — o CWD gravado é a barreira")
	}
	depois, _ := dataStore.GetSession(sessionID)
	if depois.CWD != meta.CWD {
		t.Errorf("a segunda chamada trocou a pasta: %q → %q", meta.CWD, depois.CWD)
	}

	// E o especialista de CONVERSA nunca provisiona: pergunta não precisa de
	// disco, e uma pasta por bate-papo encheria o projects/ de cascas vazias.
	if _, err := dataStore.CreateSession(store.SessionMeta{ID: "s-conversa"}); err != nil {
		t.Fatalf("criar sessão de conversa: %v", err)
	}
	if supervisor.provisionaProjeto("s-conversa", "t-3", specialist.GetOrDefault("chat"), "uma dúvida") {
		t.Error("o chat ganhou pasta de projeto — só especialista de trabalho provisiona")
	}
}

/* ------------------- fs.list na filha recém-provisionada ------------------- */

// A filha recém-provisionada tem pasta VAZIA — e vazio é resposta legítima do
// fs.list, não a recusa "esta sessão não tem pasta de projeto definida". É a
// diferença entre a IDE abrir pronta para trabalhar e abrir morta.
func TestFsListNaFilhaRecemProvisionadaListaVazioLegitimo(t *testing.T) {
	fixture := newProvisionFixture(t, []route{
		{trigger: pedidoDeTrabalho, answer: "<html>hello</html>"},
	})

	if err := fixture.supervisor.Prompt(motorContext(t), fixture.session,
		protocol.Prompt{Text: pedidoDeTrabalho}); err != nil {
		t.Fatalf("prompt: %v", err)
	}

	filhoID := store.ChildSessionID(fixture.session, "code")
	filho, err := fixture.store.GetSession(filhoID)
	if err != nil {
		t.Fatalf("a filha não nasceu: %v", err)
	}
	requireProvisionedDir(t, fixture.store, filho.CWD)

	// O que um turno NA FILHA faz no começo — e o que a ferramenta enxerga.
	ctx := fixture.supervisor.comWorkspace(context.Background(), filhoID, "t-filha", "", "", workspace.OriginModel)
	args, _ := json.Marshal(map[string]string{"path": "."})
	output, err := fixture.registry.Call(ctx, "fs.list", filhoID, args)
	if err != nil {
		t.Fatalf("fs.list na filha recém-provisionada recusou: %v", err)
	}
	if !strings.Contains(output, "pasta vazia") {
		t.Errorf("esperava a listagem vazia legítima, obtive %q", output)
	}
}
