// O sandbox de staging visto do TURNO — a regra do produto de ponta a ponta:
// o modelo trabalha numa cópia e a pessoa só recebe resultado entregue.
//
// O que cada teste guarda:
//
//   - DURANTE o turno o projeto real está intocado e o trabalho vive na cópia;
//     o done só sai depois de o espelho entregar (e o staging sumir);
//   - falha no meio do turno descarta a cópia — nada meio-escrito chega;
//   - a raiz apontada pela pessoa TAMBÉM trabalha em cópia (sandbox universal),
//     com os reproduzíveis dela fora da ida e intactos na entrega;
//   - o teto degrada para inplace com um KindThinking avisando;
//   - a UI (CallToolFromUI) lê e escreve o projeto ENTREGUE mesmo com o
//     staging ligado — o Ctrl+S é edição direta da pessoa;
//   - o caminho do master (delegateWithRoute) promove antes do delegate-done.
//
// A mecânica da cópia/espelho/cerca é provada nos testes do pacote workspace;
// aqui se prova que o SUPERVISOR chama cada verbo na hora certa.
package supervisor

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"aibot/gateway/internal/eventbus"
	"aibot/gateway/internal/permissions"
	"aibot/gateway/internal/protocol"
	"aibot/gateway/internal/store"
	"aibot/gateway/internal/workspace"
)

/* -------------------------------- bancada --------------------------------- */

// stagingProvider é o provedor roteado por conteúdo com um ESPIÃO: `hook` roda
// a cada requisição de modelo, DENTRO do turno — é assim que o teste enxerga o
// disco no meio do trabalho, entre a escrita das ferramentas e a resposta
// final. Sem o espião, "o projeto fica intocado durante o turno" seria uma
// afirmação sobre um instante que nenhum teste observa.
func stagingProvider(t *testing.T, routes []route, hook func(body string)) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Messages []struct {
				Content string `json:"content"`
			} `json:"messages"`
		}
		body := ""
		if err := json.NewDecoder(r.Body).Decode(&request); err == nil {
			parts := make([]string, 0, len(request.Messages))
			for _, message := range request.Messages {
				parts = append(parts, message.Content)
			}
			body = strings.Join(parts, "\n")
		}
		if hook != nil {
			hook(body)
		}
		answer := "sem rota"
		for _, candidate := range routes {
			if strings.Contains(body, candidate.trigger) {
				answer = candidate.answer
				break
			}
		}
		// Mesmo gatilho reservado do routedProvider: derruba a chamada para o
		// teste produzir uma falha de modelo sem inventar um modo que não existe.
		if answer == "@@500" {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		chunk, err := json.Marshal(map[string]any{
			"choices": []map[string]any{{"delta": map[string]any{"content": answer}}},
		})
		if err != nil {
			t.Errorf("montar o chunk: %v", err)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprintf(w, "data: %s\n\n", chunk)
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	t.Cleanup(server.Close)
	return server
}

// fenceWrite monta o bloco de ferramenta de um fs.write.
func fenceWrite(path, content string) string {
	return toolFence + "\n" + fmt.Sprintf(`{"tool":"fs.write","args":{"path":%q,"content":%q}}`,
		path, content) + "\n```"
}

// stagingTurnFixture é o supervisor com o staging LIGADO e o Toolbox real.
type stagingTurnFixture struct {
	supervisor *Supervisor
	store      *store.Store
	manager    *workspace.Manager
	registry   *Registry
	session    string
	projeto    string
}

// newStagingTurnFixture monta o cenário do sandbox: uma sessão com pasta de
// projeto (dentro ou fora de <dataDir>/projects/, conforme o teste) e portão
// aprova-tudo — a mecânica sob teste aqui é o staging, não a aprovação.
// `specialistID` vazio deixa a raiz SEM dono, o cenário do master orquestrador.
func newStagingTurnFixture(t *testing.T, server *httptest.Server, dentroDeProjects bool, specialistID string) *stagingTurnFixture {
	t.Helper()
	return newStagingTurnFixtureComPolitica(t, server, dentroDeProjects, specialistID,
		permissions.Policy{Mode: permissions.ModeAll, AgentTools: true})
}

// newStagingTurnFixtureComPolitica é a variante com a POLÍTICA escolhida —
// os testes da jaula usam "edições", que é onde o cartão de entrega e o chip
// "no sandbox" aparecem de verdade.
func newStagingTurnFixtureComPolitica(
	t *testing.T,
	server *httptest.Server,
	dentroDeProjects bool,
	specialistID string,
	policy permissions.Policy,
) *stagingTurnFixture {
	t.Helper()
	dataStore, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("abrir o store: %v", err)
	}
	t.Cleanup(func() { _ = dataStore.Close() })

	projeto := t.TempDir()
	if dentroDeProjects {
		projeto = filepath.Join(dataStore.Root(), "projects", "app-teste")
	}
	if err := os.MkdirAll(projeto, 0o755); err != nil {
		t.Fatalf("criar o projeto: %v", err)
	}

	const sessionID = "s-staging"
	if _, err := dataStore.CreateSession(store.SessionMeta{
		ID: sessionID, CWD: projeto, Specialist: specialistID, Model: "m1",
	}); err != nil {
		t.Fatalf("criar sessão: %v", err)
	}

	registry := NewRegistry()
	(&Toolbox{}).Install(registry)
	manager := workspace.NewManager(func(id string) string {
		meta, err := dataStore.GetSession(id)
		if err != nil {
			return ""
		}
		return meta.CWD
	})
	manager.EnableStaging(dataStore.Root())

	supervisor := New(Deps{
		Store:      dataStore,
		Bus:        eventbus.New(dataStore),
		Models:     scriptedRouter(server.URL),
		Gate:       permissions.NewGate(policy),
		Tools:      registry,
		Router:     NewRouter(nil, nil),
		Workspaces: manager,
	})
	// A equipe também entra: o teste do task.dispatch dentro de um turno com
	// staging precisa dela — e ela é inofensiva para os demais.
	supervisor.InstallCrewTools(registry)
	return &stagingTurnFixture{supervisor: supervisor, store: dataStore, manager: manager,
		registry: registry, session: sessionID, projeto: projeto}
}

// existeEm/leEm/escreveEm: leitura e escrita relativas a uma raiz, no disco.
func existeEm(root, relative string) bool {
	_, err := os.Stat(filepath.Join(root, filepath.FromSlash(relative)))
	return err == nil
}

func leEm(t *testing.T, root, relative string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(relative)))
	if err != nil {
		return ""
	}
	return string(data)
}

func escreveEm(t *testing.T, root, relative, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(root, relative), []byte(content), 0o644); err != nil {
		t.Fatalf("gravar %s: %v", relative, err)
	}
}

// stagingEntries lista o que existe em <dataDir>/staging — vazio (ou
// inexistente) é o estado limpo que todo desfecho tem de deixar.
func stagingEntries(t *testing.T, dataStore *store.Store) []os.DirEntry {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(dataStore.Root(), "staging"))
	if err != nil {
		return nil
	}
	return entries
}

/* ------------------------- o turno feliz entrega -------------------------- */

// O turno de trabalho grava dois arquivos: DURANTE o turno o projeto real está
// intocado e os dois vivem na cópia; no done os dois estão no projeto e o
// staging não existe mais. É a frase inteira da regra do dono num teste.
func TestTurnoDeTrabalhoSoEntregaAoProjetoNoDone(t *testing.T) {
	escrita := "gravando os dois arquivos\n\n" +
		fenceWrite("a.txt", "AAA") + "\n\n" + fenceWrite("b.txt", "BBB")

	var fixture *stagingTurnFixture
	var espiou atomic.Bool
	hook := func(body string) {
		// Só a SEGUNDA chamada interessa: o resultado das ferramentas voltando
		// ao modelo — as escritas já aconteceram e o turno ainda não terminou.
		if fixture == nil || !strings.Contains(body, "Resultado das ferramentas") {
			return
		}
		espiou.Store(true)
		if existeEm(fixture.projeto, "a.txt") || existeEm(fixture.projeto, "b.txt") {
			t.Error("o projeto real mudou DURANTE o turno — o sandbox vazou")
		}
		entries := stagingEntries(t, fixture.store)
		if len(entries) != 1 {
			t.Errorf("esperava exatamente 1 cópia de staging durante o turno, obtive %d", len(entries))
			return
		}
		copia := filepath.Join(fixture.store.Root(), "staging", entries[0].Name())
		if !existeEm(copia, "a.txt") || !existeEm(copia, "b.txt") {
			t.Error("as escritas do turno tinham de estar na cópia de staging")
		}
	}
	server := stagingProvider(t, []route{
		// A ordem importa: a segunda rodada ainda contém o pedido no histórico,
		// então o gatilho do resultado vem primeiro.
		{trigger: "Resultado das ferramentas", answer: "a.txt e b.txt gravados."},
		{trigger: "grava os dois arquivos", answer: escrita},
	}, hook)
	fixture = newStagingTurnFixture(t, server, true, "code")

	if err := fixture.supervisor.Prompt(motorContext(t), fixture.session,
		protocol.Prompt{Text: "grava os dois arquivos do projeto"}); err != nil {
		t.Fatalf("prompt: %v", err)
	}

	if !espiou.Load() {
		t.Fatal("o espião do meio do turno nunca rodou — o teste não observou o que promete")
	}
	// O done entregou: os dois no projeto, staging limpo, turno fechado sem erro.
	if leEm(t, fixture.projeto, "a.txt") != "AAA" || leEm(t, fixture.projeto, "b.txt") != "BBB" {
		t.Error("a promoção não entregou os arquivos ao projeto")
	}
	if entries := stagingEntries(t, fixture.store); len(entries) != 0 {
		t.Errorf("o staging tinha de sumir depois da entrega, sobraram %d entrada(s)", len(entries))
	}
	if got := len(envelopesByKind(t, fixture.store, fixture.session, protocol.KindDone)); got != 1 {
		t.Errorf("esperava 1 done fechando o turno, obtive %d", got)
	}
	if got := len(envelopesByKind(t, fixture.store, fixture.session, protocol.KindError)); got != 0 {
		t.Errorf("turno feliz não pode deixar KindError, obtive %d", got)
	}
}

/* --------------------------- a falha descarta ------------------------------ */

// O modelo erra no SEGUNDO passo (depois de já ter gravado um arquivo na
// cópia): o projeto fica intocado e o staging é removido — falha honesta, sem
// nada meio-escrito.
func TestFalhaDoModeloNoMeioDescartaOStaging(t *testing.T) {
	server := stagingProvider(t, []route{
		{trigger: "Resultado das ferramentas", answer: "@@500"},
		{trigger: "grava um arquivo", answer: "gravando\n\n" + fenceWrite("meio.txt", "meio-escrito")},
	}, nil)
	fixture := newStagingTurnFixture(t, server, true, "code")

	if err := fixture.supervisor.Prompt(motorContext(t), fixture.session,
		protocol.Prompt{Text: "grava um arquivo e continua o trabalho"}); err == nil {
		t.Fatal("o modelo caiu no meio — o turno tinha de falhar")
	}

	if existeEm(fixture.projeto, "meio.txt") {
		t.Error("trabalho meio-escrito chegou ao projeto — o descarte não rodou")
	}
	if entries := stagingEntries(t, fixture.store); len(entries) != 0 {
		t.Errorf("a falha tinha de descartar o staging, sobraram %d entrada(s)", len(entries))
	}
	if got := len(envelopesByKind(t, fixture.store, fixture.session, protocol.KindError)); got == 0 {
		t.Error("a falha tinha de ficar visível como KindError")
	}
}

/* ------------------- a pasta da pessoa também é sandbox -------------------- */

// SANDBOX UNIVERSAL: a raiz apontada pela PESSOA (fora de <dataDir>/projects/)
// também trabalha em cópia — a decisão do dono. O espião prova que durante o
// turno a pasta dela está intocada e o trabalho vive na cópia; o done entrega.
// E o node_modules dela nem viaja: a cópia de ida exclui os reproduzíveis (é o
// que tornou a pasta da pessoa viável sem estourar o teto à toa).
func TestRaizDaPessoaTambemTrabalhaEmSandbox(t *testing.T) {
	var fixture *stagingTurnFixture
	var espiou atomic.Bool
	hook := func(body string) {
		if fixture == nil || !strings.Contains(body, "Resultado das ferramentas") {
			return
		}
		espiou.Store(true)
		if existeEm(fixture.projeto, "direto.txt") {
			t.Error("a pasta da pessoa mudou DURANTE o turno — o sandbox universal não valeu para ela")
		}
		entries := stagingEntries(t, fixture.store)
		if len(entries) != 1 {
			t.Errorf("esperava a cópia única do turno, obtive %d entrada(s)", len(entries))
			return
		}
		copia := filepath.Join(fixture.store.Root(), "staging", entries[0].Name())
		if !existeEm(copia, "direto.txt") {
			t.Error("a escrita do turno tinha de estar na cópia")
		}
		if existeEm(copia, "node_modules") {
			t.Error("o node_modules da pessoa não podia viajar na cópia de ida")
		}
	}
	server := stagingProvider(t, []route{
		{trigger: "Resultado das ferramentas", answer: "direto.txt gravado."},
		{trigger: "grava direto", answer: "gravando\n\n" + fenceWrite("direto.txt", "no sandbox")},
	}, hook)
	fixture = newStagingTurnFixture(t, server, false, "code")
	escreveEm(t, fixture.projeto, "app.js", "fonte da pessoa")
	if err := os.MkdirAll(filepath.Join(fixture.projeto, "node_modules", "dep"), 0o755); err != nil {
		t.Fatalf("montar node_modules: %v", err)
	}
	escreveEm(t, fixture.projeto, filepath.Join("node_modules", "dep", "index.js"), "instalado pela pessoa")

	if err := fixture.supervisor.Prompt(motorContext(t), fixture.session,
		protocol.Prompt{Text: "grava direto na minha pasta"}); err != nil {
		t.Fatalf("prompt: %v", err)
	}
	if !espiou.Load() {
		t.Fatal("o espião do meio do turno nunca rodou — o teste não observou o que promete")
	}
	if leEm(t, fixture.projeto, "direto.txt") != "no sandbox" {
		t.Error("a entrega não chegou à pasta da pessoa no done")
	}
	// O que era dela sobreviveu à entrega — o espelho não toca reproduzível.
	if leEm(t, fixture.projeto, "node_modules/dep/index.js") != "instalado pela pessoa" {
		t.Error("o node_modules da pessoa foi tocado pela entrega")
	}
	if entries := stagingEntries(t, fixture.store); len(entries) != 0 {
		t.Errorf("o staging tinha de sumir depois da entrega, sobraram %d entrada(s)", len(entries))
	}
}

/* ------------------------- o teto degrada e avisa -------------------------- */

// O projeto que estoura o teto da cópia degrada para inplace COM AVISO: um
// KindThinking conta o porquê, o turno segue direto no projeto e nenhuma
// meia-cópia sobra.
func TestTetoDegradaOTurnoParaInplaceComAviso(t *testing.T) {
	server := stagingProvider(t, []route{
		{trigger: "Resultado das ferramentas", answer: "x.txt gravado."},
		{trigger: "grava mais um", answer: "gravando\n\n" + fenceWrite("x.txt", "X")},
	}, nil)
	fixture := newStagingTurnFixture(t, server, true, "code")
	// Dois arquivos já existem e o teto aceita UM: a materialização degrada.
	escreveEm(t, fixture.projeto, "um.txt", "1")
	escreveEm(t, fixture.projeto, "dois.txt", "2")
	fixture.manager.EnableStagingWithLimits(fixture.store.Root(), 128<<20, 1)

	// O aviso é EFÊMERO (KindThinking não vai ao log): assina o barramento
	// antes do turno e drena depois — o buffer do assinante segura a rajada.
	subscription := fixture.supervisor.deps.Bus.Subscribe(fixture.session)
	defer subscription.Close()

	if err := fixture.supervisor.Prompt(motorContext(t), fixture.session,
		protocol.Prompt{Text: "grava mais um arquivo"}); err != nil {
		t.Fatalf("prompt: %v", err)
	}

	avisou := false
drenagem:
	for {
		select {
		case envelope, ok := <-subscription.Events:
			if !ok {
				break drenagem
			}
			if envelope.Kind != protocol.KindThinking {
				continue
			}
			var thinking protocol.Thinking
			if json.Unmarshal(envelope.Payload, &thinking) == nil &&
				strings.Contains(thinking.Label, "teto") {
				avisou = true
			}
		default:
			break drenagem
		}
	}
	if !avisou {
		t.Error("a degradação tinha de avisar por KindThinking — perder o sandbox em silêncio é defeito")
	}
	if leEm(t, fixture.projeto, "x.txt") != "X" {
		t.Error("degradado para inplace, a escrita tinha de ir direto ao projeto")
	}
	if entries := stagingEntries(t, fixture.store); len(entries) != 0 {
		t.Errorf("não pode sobrar meia-cópia, obtive %d entrada(s)", len(entries))
	}
}

/* ------------------------ a UI edita o projeto entregue -------------------- */

// A UI (CallToolFromUI) lê e escreve o projeto ENTREGUE mesmo com o staging
// ligado: o Ctrl+S da pessoa é edição direta dela — o sandbox é do MODELO. Se
// um turno estiver correndo em paralelo, o último a promover vence (a cerca de
// worker+época segura épocas velhas); não há merge, de propósito.
func TestUIEscreveNoProjetoEntregueMesmoComStagingLigado(t *testing.T) {
	server := stagingProvider(t, nil, nil) // a UI não passa pelo modelo
	fixture := newStagingTurnFixture(t, server, true, "code")

	args, _ := json.Marshal(map[string]string{"path": "da-ui.txt", "content": "ctrl+s da pessoa"})
	result, err := fixture.supervisor.CallToolFromUI(context.Background(), fixture.session, "fs.write", args)
	if err != nil {
		t.Fatalf("CallToolFromUI: %v", err)
	}
	if !result.OK {
		t.Fatalf("a escrita da UI tinha de rodar: %+v", result)
	}
	if leEm(t, fixture.projeto, "da-ui.txt") != "ctrl+s da pessoa" {
		t.Error("o Ctrl+S da pessoa tinha de ir DIRETO ao projeto entregue")
	}
	if entries := stagingEntries(t, fixture.store); len(entries) != 0 {
		t.Errorf("a UI não pode materializar cópia nenhuma, obtive %d entrada(s)", len(entries))
	}

	// E a leitura da UI lê o projeto real — o mesmo que ela acabou de gravar.
	args, _ = json.Marshal(map[string]string{"path": "da-ui.txt"})
	result, err = fixture.supervisor.CallToolFromUI(context.Background(), fixture.session, "fs.read", args)
	if err != nil || !result.OK || !strings.Contains(result.Output, "ctrl+s da pessoa") {
		t.Fatalf("a leitura da UI tinha de vir do projeto real: %+v (%v)", result, err)
	}
}

/* ------------------- a equipe trabalha na cópia do turno ------------------- */

// O task.dispatch DENTRO de um turno com staging: o trabalhador escreve na
// MESMA cópia do turno (não no projeto real), e a entrega é UMA — a promoção
// do turno, no done. É a regressão que apagaria trabalho calado: se o
// trabalhador materializasse o próprio plano (inplace), ele escreveria no
// projeto real e o espelho do fim do turno passaria por cima com a cópia
// congelada ANTES de a equipe rodar.
func TestEquipeDentroDeTurnoComStagingTrabalhaNaCopiaDoTurno(t *testing.T) {
	plano := `{"tasks":[{"id":"t1","title":"gravar arquivo","specialist":"code",` +
		`"goal":"grave o arquivo pedido"}]}`

	var fixture *stagingTurnFixture
	var espiou atomic.Bool
	hook := func(body string) {
		// A rodada 2 DO TRABALHADOR: o fs.write já rodou, o turno-mãe segue vivo.
		if fixture == nil || !strings.Contains(body, "gravado: equipe.txt") {
			return
		}
		espiou.Store(true)
		if existeEm(fixture.projeto, "equipe.txt") {
			t.Error("o trabalhador escreveu no projeto REAL — a equipe vazou do sandbox do turno")
		}
		entries := stagingEntries(t, fixture.store)
		if len(entries) != 1 {
			t.Errorf("esperava a cópia única do turno, obtive %d entrada(s)", len(entries))
			return
		}
		copia := filepath.Join(fixture.store.Root(), "staging", entries[0].Name())
		if !existeEm(copia, "equipe.txt") {
			t.Error("a escrita do trabalhador tinha de estar na cópia do turno")
		}
	}
	server := stagingProvider(t, []route{
		// A ordem importa: cada rodada carrega o histórico das anteriores.
		{trigger: "gravado: equipe.txt", answer: "tarefa concluída"},
		{trigger: "Tarefa t1", answer: "gravando\n\n" + fenceWrite("equipe.txt", "da equipe")},
		// "plano: 1 tarefas" é a primeira linha do RELATÓRIO da equipe — o
		// gatilho precisa dela inteira porque "plano" solto aparece na persona.
		{trigger: "plano: 1 tarefas", answer: "equipe terminou e o arquivo foi produzido"},
		{trigger: "monta a equipe", answer: "vou montar\n\n" + dispatchFence(plano)},
	}, hook)
	fixture = newStagingTurnFixture(t, server, true, "agent")

	if err := fixture.supervisor.Prompt(motorContext(t), fixture.session,
		protocol.Prompt{Text: "monta a equipe para gravar o arquivo"}); err != nil {
		t.Fatalf("prompt: %v", err)
	}

	if !espiou.Load() {
		t.Fatal("o espião do meio do turno nunca rodou — o teste não observou o que promete")
	}
	if leEm(t, fixture.projeto, "equipe.txt") != "da equipe" {
		t.Error("o trabalho da equipe não chegou ao projeto na promoção do turno")
	}
	if entries := stagingEntries(t, fixture.store); len(entries) != 0 {
		t.Errorf("o staging tinha de sumir depois da entrega, sobraram %d entrada(s)", len(entries))
	}
	if got := len(envelopesByKind(t, fixture.store, fixture.session, protocol.KindError)); got != 0 {
		t.Errorf("turno de equipe feliz não pode deixar KindError, obtive %d", got)
	}
}

/* --------------------- o master entrega antes do done ---------------------- */

// O caminho do MASTER (delegateWithRoute): o sub-turno delegado grava na cópia
// e a promoção acontece ANTES do delegate-done — durante o trabalho o projeto
// está intocado; quando a pessoa é avisada, o arquivo já está entregue.
func TestMasterDelegateEntregaAntesDoDelegateDone(t *testing.T) {
	var fixture *stagingTurnFixture
	var espiou atomic.Bool
	hook := func(body string) {
		if fixture == nil || !strings.Contains(body, "Resultado das ferramentas") {
			return
		}
		espiou.Store(true)
		if existeEm(fixture.projeto, "index.html") {
			t.Error("o projeto mudou durante o sub-turno delegado — o sandbox vazou")
		}
	}
	server := stagingProvider(t, []route{
		{trigger: "Resultado das ferramentas", answer: "site criado em index.html"},
		{trigger: pedidoDeTrabalho, answer: "criando o site\n\n" + fenceWrite("index.html", "<html>hello</html>")},
	}, hook)
	// Raiz SEM dono: o fast router decide code e o master delega.
	fixture = newStagingTurnFixture(t, server, true, "")

	if err := fixture.supervisor.Prompt(motorContext(t), fixture.session,
		protocol.Prompt{Text: pedidoDeTrabalho}); err != nil {
		t.Fatalf("prompt: %v", err)
	}

	if !espiou.Load() {
		t.Fatal("o espião do meio do turno nunca rodou — o teste não observou o que promete")
	}
	if leEm(t, fixture.projeto, "index.html") != "<html>hello</html>" {
		t.Error("a promoção do caminho do master não entregou o arquivo ao projeto")
	}
	if entries := stagingEntries(t, fixture.store); len(entries) != 0 {
		t.Errorf("o staging tinha de sumir depois da entrega, sobraram %d entrada(s)", len(entries))
	}
	delegations := delegateEnvelopes(t, fixture.store, fixture.session)
	if len(delegations) != 2 || !delegations[1].Done ||
		!strings.Contains(delegations[1].Result, "site criado") {
		t.Fatalf("esperava o par abre/fecha da delegação com o resultado, obtive %+v", delegations)
	}
}
