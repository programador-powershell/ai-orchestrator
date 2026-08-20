// O staging v1 no nível do gerente: a decisão de QUEM ganha cópia, a cópia em
// si, o espelho da promoção e o descarte — cada um com o cenário que o
// justifica. O caminho de turno inteiro (modelo → ferramentas → done) vive nos
// testes do supervisor; aqui se prova a mecânica que ele consome.
package workspace

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// stagingHarness monta um gerente com staging ligado sobre um dataDir de
// verdade, com UM projeto provisionado (dentro de projects/) e UMA pasta da
// pessoa (fora).
type stagingHarness struct {
	manager *Manager
	dataDir string
	projeto string // <dataDir>/projects/app — ganha staging
	pessoal string // pasta apontada pela pessoa — inplace para sempre
}

func newStagingHarness(t *testing.T) *stagingHarness {
	t.Helper()
	dataDir := t.TempDir()
	projeto := filepath.Join(dataDir, "projects", "app")
	if err := os.MkdirAll(projeto, 0o755); err != nil {
		t.Fatalf("criar o projeto: %v", err)
	}
	pessoal := t.TempDir()

	manager := NewManager(func(sessionID string) string {
		switch sessionID {
		case "s-projeto":
			return projeto
		case "s-pessoal":
			return pessoal
		default:
			return ""
		}
	})
	manager.EnableStaging(dataDir)
	return &stagingHarness{manager: manager, dataDir: dataDir, projeto: projeto, pessoal: pessoal}
}

// escreve grava um arquivo (criando pastas) e reprova o teste se não der.
func escreve(t *testing.T, root, relative, content string) {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(relative))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("criar pasta de %s: %v", relative, err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("gravar %s: %v", relative, err)
	}
}

// le devolve o conteúdo ou "" quando o arquivo não existe.
func le(t *testing.T, root, relative string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(relative)))
	if err != nil {
		return ""
	}
	return string(data)
}

// existe diz se o caminho existe no disco.
func existe(root, relative string) bool {
	_, err := os.Stat(filepath.Join(root, filepath.FromSlash(relative)))
	return err == nil
}

/* ------------------------------ a decisão --------------------------------- */

// SÓ o turno de modelo sobre raiz provisionada ganha cópia. Cada linha da
// tabela é uma regra de produto: a UI edita o projeto entregue, a equipe tem o
// worktree, a pasta da pessoa pode ser gigante, e origem não declarada cai no
// comportamento antigo e seguro.
func TestPlanDecideStagingSoParaModeloEmProjects(t *testing.T) {
	harness := newStagingHarness(t)

	casos := []struct {
		nome    string
		session string
		origin  Origin
		staged  bool
	}{
		{"modelo em projects/ ganha cópia", "s-projeto", OriginModel, true},
		{"UI fica no projeto entregue", "s-projeto", OriginUI, false},
		{"equipe fica inplace (worktree é o isolamento dela)", "s-projeto", OriginCrew, false},
		{"origem não declarada cai em inplace", "s-projeto", Origin(""), false},
		{"pasta da pessoa fica inplace", "s-pessoal", OriginModel, false},
		{"sessão sem pasta fica inplace", "s-solta", OriginModel, false},
	}
	for _, caso := range casos {
		t.Run(caso.nome, func(t *testing.T) {
			plan, err := harness.manager.Plan(context.Background(),
				PlanRequest{SessionID: caso.session, Origin: caso.origin})
			if err != nil {
				t.Fatalf("congelar: %v", err)
			}
			if plan.Staged() != caso.staged {
				t.Fatalf("staging=%v, esperava %v (uri %q)", plan.Staged(), caso.staged, plan.Staging.URI)
			}
			if caso.staged && !strings.HasPrefix(plan.Staging.URI, StagingURIPrefix) {
				t.Fatalf("URI de staging sem o prefixo real: %q", plan.Staging.URI)
			}
			if !caso.staged && plan.Staging.URI != InplaceStaging {
				t.Fatalf("inplace tinha de continuar %q, veio %q", InplaceStaging, plan.Staging.URI)
			}
		})
	}

	// O prefixo CRU é a armadilha clássica: "projects-2" começa com "projects"
	// como string, mas não mora dentro de projects/. Canonicalizado, não passa.
	vizinho := filepath.Join(harness.dataDir, "projects-2", "app")
	if err := os.MkdirAll(vizinho, 0o755); err != nil {
		t.Fatalf("criar o vizinho: %v", err)
	}
	if harness.manager.stagesRoot(vizinho) {
		t.Error("projects-2/ passou pela comparação de prefixo — a canonicalização não está valendo")
	}
	// E a própria projects/ não é um projeto.
	if harness.manager.stagesRoot(filepath.Join(harness.dataDir, "projects")) {
		t.Error("a própria projects/ não pode ganhar staging — o espelho apagaria os vizinhos")
	}

	// Gerente SEM EnableStaging: tudo inplace, como sempre foi.
	cru := NewManager(func(string) string { return harness.projeto })
	plan, err := cru.Plan(context.Background(), PlanRequest{SessionID: "s-1", Origin: OriginModel})
	if err != nil || plan.Staging.URI != InplaceStaging {
		t.Fatalf("sem EnableStaging tinha de ser inplace: %q (%v)", plan.Staging.URI, err)
	}
}

/* --------------------------- o ciclo completo ----------------------------- */

// Materializar → trabalhar na cópia → promover: o projeto só muda na
// promoção, e o espelho cobre os três verbos — novo copiado, alterado
// atualizado, sumido apagado. No fim o staging não existe mais.
func TestMaterializeTrabalhaNaCopiaEPromoteEspelha(t *testing.T) {
	harness := newStagingHarness(t)
	escreve(t, harness.projeto, "velho.txt", "v1")
	escreve(t, harness.projeto, "docs/leia.md", "manual")

	plan, err := harness.manager.Plan(context.Background(),
		PlanRequest{SessionID: "s-projeto", Origin: OriginModel})
	if err != nil {
		t.Fatalf("congelar: %v", err)
	}
	execution, err := harness.manager.Materialize(context.Background(), plan)
	if err != nil {
		t.Fatalf("materializar: %v", err)
	}
	if execution.LocalStaging == "" || execution.LocalRoot != execution.LocalStaging {
		t.Fatalf("a execução tinha de apontar para a cópia: root=%q staging=%q",
			execution.LocalRoot, execution.LocalStaging)
	}
	if filepath.Clean(execution.LocalRoot) == filepath.Clean(harness.projeto) {
		t.Fatal("a cópia não pode ser o próprio projeto")
	}
	// A cópia nasce com o conteúdo do projeto.
	if le(t, execution.LocalRoot, "velho.txt") != "v1" || le(t, execution.LocalRoot, "docs/leia.md") != "manual" {
		t.Fatal("a cópia não trouxe o conteúdo do projeto")
	}

	// O "turno" trabalha NA CÓPIA: cria, altera e apaga.
	escreve(t, execution.LocalRoot, "novo.txt", "conteudo novo")
	escreve(t, execution.LocalRoot, "velho.txt", "v2")
	if err := os.RemoveAll(filepath.Join(execution.LocalRoot, "docs")); err != nil {
		t.Fatalf("apagar na cópia: %v", err)
	}

	// DURANTE o trabalho o projeto real está intocado.
	if le(t, harness.projeto, "velho.txt") != "v1" || existe(harness.projeto, "novo.txt") {
		t.Fatal("o projeto mudou antes da promoção — o sandbox vazou")
	}

	if err := harness.manager.Promote(context.Background(), plan, execution.Publication()); err != nil {
		t.Fatalf("promover: %v", err)
	}
	// Novo copiado, alterado atualizado, sumido apagado — inclusive a pasta.
	if le(t, harness.projeto, "novo.txt") != "conteudo novo" {
		t.Error("o arquivo novo não chegou ao projeto")
	}
	if le(t, harness.projeto, "velho.txt") != "v2" {
		t.Error("a alteração não chegou ao projeto")
	}
	if existe(harness.projeto, "docs/leia.md") || existe(harness.projeto, "docs") {
		t.Error("o apagamento no staging não virou apagamento no projeto")
	}
	// E o staging foi embora.
	if existe(execution.LocalRoot, ".") {
		t.Error("o staging tinha de sumir depois da promoção")
	}

	// Idempotência: promover de novo (e descartar depois) é não-op, nunca um
	// segundo espelho.
	if err := harness.manager.Promote(context.Background(), plan, execution.Publication()); err != nil {
		t.Fatalf("a segunda promoção tinha de ser não-op: %v", err)
	}
	if err := harness.manager.Discard(context.Background(), plan, execution.Publication()); err != nil {
		t.Fatalf("descartar depois de promover tinha de ser não-op: %v", err)
	}
	if le(t, harness.projeto, "novo.txt") != "conteudo novo" {
		t.Error("a idempotência tocou o projeto")
	}
}

// A ENTREGA É O PRODUTO: o espelho da promoção exclui os reproduzíveis nos
// DOIS sentidos — o node_modules que o container instalou no staging não chega
// ao projeto, e o node_modules que a própria pessoa tinha no projeto não é
// apagado por estar "sumido" da cópia. Build de verdade (dist/) ENTRA: é o que
// foi pedido.
func TestPromoteExcluiReproduziveisNosDoisSentidos(t *testing.T) {
	harness := newStagingHarness(t)
	escreve(t, harness.projeto, "app.js", "fonte")
	// O que JÁ É da pessoa e o espelho não pode destruir: as dependências que
	// ela instalou e o histórico git dela.
	escreve(t, harness.projeto, "node_modules/preexistente/lib.js", "instalado pela pessoa")
	escreve(t, harness.projeto, ".git/config", "historico da pessoa")

	plan, err := harness.manager.Plan(context.Background(),
		PlanRequest{SessionID: "s-projeto", Origin: OriginModel})
	if err != nil {
		t.Fatalf("congelar: %v", err)
	}
	execution, err := harness.manager.Materialize(context.Background(), plan)
	if err != nil {
		t.Fatalf("materializar: %v", err)
	}

	// O "turno no sandbox": instala, builda e mexe no git — tudo NA CÓPIA.
	escreve(t, execution.LocalRoot, "node_modules/instalado/pacote.js", "veio do pnpm install")
	escreve(t, execution.LocalRoot, "pacote/node_modules/aninhado.js", "reproduzível aninhado")
	escreve(t, execution.LocalRoot, ".pnpm-store/v3/blob", "cache do pnpm")
	escreve(t, execution.LocalRoot, "__pycache__/m.pyc", "bytecode")
	escreve(t, execution.LocalRoot, ".venv/pyvenv.cfg", "venv do container")
	escreve(t, execution.LocalRoot, ".git/config", "git do staging")
	escreve(t, execution.LocalRoot, "dist/bundle.js", "produto buildado")
	escreve(t, execution.LocalRoot, "app.js", "fonte v2")

	if err := harness.manager.Promote(context.Background(), plan, execution.Publication()); err != nil {
		t.Fatalf("promover: %v", err)
	}

	// O PRODUTO chegou: fonte alterada e o build.
	if le(t, harness.projeto, "app.js") != "fonte v2" || le(t, harness.projeto, "dist/bundle.js") != "produto buildado" {
		t.Error("o produto (fonte alterada e dist/) tinha de chegar ao projeto")
	}
	// Os REPRODUZÍVEIS do staging não chegaram — a máquina da pessoa não ganha
	// nem node_modules.
	for _, proibido := range []string{
		"node_modules/instalado", "pacote/node_modules", ".pnpm-store", "__pycache__", ".venv",
	} {
		if existe(harness.projeto, proibido) {
			t.Errorf("%s do staging não podia chegar ao projeto", proibido)
		}
	}
	// E o que era da pessoa SOBREVIVEU: o espelho não copiou os reproduzíveis,
	// e o apagamento também não pode tocá-los.
	if le(t, harness.projeto, "node_modules/preexistente/lib.js") != "instalado pela pessoa" {
		t.Error("o node_modules pré-existente da pessoa foi apagado pelo espelho")
	}
	if le(t, harness.projeto, ".git/config") != "historico da pessoa" {
		t.Error("o .git da pessoa foi sobrescrito pelo git do staging")
	}
}

// Discard joga a cópia fora SEM tocar o projeto — é o desfecho de falha,
// interrupção e recusa. Idempotente.
func TestDiscardRemoveACopiaSemTocarOProjeto(t *testing.T) {
	harness := newStagingHarness(t)
	escreve(t, harness.projeto, "unico.txt", "intacto")

	plan, err := harness.manager.Plan(context.Background(),
		PlanRequest{SessionID: "s-projeto", Origin: OriginModel})
	if err != nil {
		t.Fatalf("congelar: %v", err)
	}
	execution, err := harness.manager.Materialize(context.Background(), plan)
	if err != nil {
		t.Fatalf("materializar: %v", err)
	}
	escreve(t, execution.LocalRoot, "meio-escrito.txt", "não pode chegar à pessoa")

	if err := harness.manager.Discard(context.Background(), plan, execution.Publication()); err != nil {
		t.Fatalf("descartar: %v", err)
	}
	if existe(execution.LocalRoot, ".") {
		t.Error("o staging tinha de sumir no descarte")
	}
	if existe(harness.projeto, "meio-escrito.txt") || le(t, harness.projeto, "unico.txt") != "intacto" {
		t.Error("o descarte tocou o projeto")
	}
	if err := harness.manager.Discard(context.Background(), plan, execution.Publication()); err != nil {
		t.Fatalf("o segundo descarte tinha de ser não-op: %v", err)
	}
	// E promover o que foi descartado também é não-op: o staging já não existe
	// e o projeto não pode ser espelhado a partir do nada.
	if err := harness.manager.Promote(context.Background(), plan, execution.Publication()); err != nil {
		t.Fatalf("promover pós-descarte tinha de ser não-op: %v", err)
	}
	if le(t, harness.projeto, "unico.txt") != "intacto" {
		t.Error("a promoção pós-descarte tocou o projeto")
	}
}

/* ------------------------------- os tetos --------------------------------- */

// O projeto que estoura o teto degrada para INPLACE com o motivo preenchido —
// o turno segue trabalhando direto no projeto, avisado, e nenhuma meia-cópia
// sobra no disco.
func TestTetoDegradaParaInplaceComMotivo(t *testing.T) {
	harness := newStagingHarness(t)
	// Teto apertado de propósito: 2 arquivos. Criar 4096 de verdade só
	// deixaria o teste lento sem provar nada além do comparador.
	harness.manager.EnableStagingWithLimits(harness.dataDir, maxStagingBytes, 2)
	escreve(t, harness.projeto, "a.txt", "1")
	escreve(t, harness.projeto, "b.txt", "2")
	escreve(t, harness.projeto, "c.txt", "3")

	plan, err := harness.manager.Plan(context.Background(),
		PlanRequest{SessionID: "s-projeto", Origin: OriginModel})
	if err != nil {
		t.Fatalf("congelar: %v", err)
	}
	if !plan.Staged() {
		t.Fatal("o plano ainda pede staging — quem degrada é a materialização, que é quem conta os bytes")
	}
	execution, err := harness.manager.Materialize(context.Background(), plan)
	if err != nil {
		t.Fatalf("materializar: %v", err)
	}
	if execution.LocalStaging != "" {
		t.Fatal("degradado não pode apontar para cópia nenhuma")
	}
	if filepath.Clean(filepath.FromSlash(execution.LocalRoot)) != filepath.Clean(harness.projeto) {
		t.Fatalf("degradado tinha de trabalhar direto no projeto, veio %q", execution.LocalRoot)
	}
	if !strings.Contains(execution.StagingDegraded, "teto") {
		t.Fatalf("o motivo da degradação tinha de citar o teto: %q", execution.StagingDegraded)
	}
	// Nenhuma meia-cópia sobra.
	if entries, err := os.ReadDir(filepath.Join(harness.dataDir, "staging")); err == nil && len(entries) > 0 {
		t.Errorf("sobrou meia-cópia no staging: %d entrada(s)", len(entries))
	}
	// E a promoção da execução degradada é a constatação de sempre.
	if err := harness.manager.Promote(context.Background(), plan, execution.Publication()); err != nil {
		t.Fatalf("promover a execução degradada (inplace): %v", err)
	}

	// O teto de BYTES degrada do mesmo jeito.
	harness.manager.EnableStagingWithLimits(harness.dataDir, 2, maxStagingFiles)
	execution, err = harness.manager.Materialize(context.Background(), plan)
	if err != nil {
		t.Fatalf("materializar com teto de bytes: %v", err)
	}
	if execution.StagingDegraded == "" || execution.LocalStaging != "" {
		t.Fatal("o teto de bytes tinha de degradar para inplace com motivo")
	}
}

/* -------------------------------- as cercas -------------------------------- */

// A cerca de worker+época continua na frente do espelho: o plano de uma época
// que passou NÃO promove, o projeto não muda e a cópia fica para o descarte.
func TestPromoteComStagingRespeitaACercaDeEpoca(t *testing.T) {
	harness := newStagingHarness(t)
	escreve(t, harness.projeto, "verdade.txt", "do projeto")

	plan, err := harness.manager.Plan(context.Background(),
		PlanRequest{SessionID: "s-projeto", TaskID: "t1", Origin: OriginModel})
	if err != nil {
		t.Fatalf("congelar: %v", err)
	}
	execution, err := harness.manager.Materialize(context.Background(), plan)
	if err != nil {
		t.Fatalf("materializar: %v", err)
	}
	escreve(t, execution.LocalRoot, "verdade.txt", "do worker velho")

	// O lease andou: outro worker, outra época.
	harness.manager.leases = leasesDeMentira{lease: Lease{WorkerID: "pc-03", Epoch: 6}}
	err = harness.manager.Promote(context.Background(), plan, execution.Publication())
	if !errors.Is(err, ErrStaleWorkspace) {
		t.Fatalf("a época velha tinha de bater na cerca, veio %v", err)
	}
	if le(t, harness.projeto, "verdade.txt") != "do projeto" {
		t.Error("a cerca recusou mas o espelho rodou — o projeto mudou")
	}
	// O descarte não precisa de lease: jogar fora a própria cópia não publica
	// verdade nenhuma.
	if err := harness.manager.Discard(context.Background(), plan, execution.Publication()); err != nil {
		t.Fatalf("descartar depois da cerca: %v", err)
	}
	if existe(execution.LocalRoot, ".") {
		t.Error("a cópia recusada tinha de poder ser descartada")
	}
}

// A cerca do PRÓPRIO staging: o turno substituído que sobreviveu à troca não
// entrega (nem apaga) a cópia que o substituto materializou no mesmo lugar.
func TestPromoteRecusaMaterializacaoSubstituida(t *testing.T) {
	harness := newStagingHarness(t)
	escreve(t, harness.projeto, "base.txt", "original")

	plan, err := harness.manager.Plan(context.Background(),
		PlanRequest{SessionID: "s-projeto", Origin: OriginModel})
	if err != nil {
		t.Fatalf("congelar: %v", err)
	}
	velho, err := harness.manager.Materialize(context.Background(), plan)
	if err != nil {
		t.Fatalf("materializar o turno velho: %v", err)
	}
	escreve(t, velho.LocalRoot, "do-velho.txt", "trabalho abandonado")

	// O substituto materializa o MESMO plano (mesma sessão, mesmo id): cópia
	// fresca, nonce novo, mesmo diretório.
	novo, err := harness.manager.Materialize(context.Background(), plan)
	if err != nil {
		t.Fatalf("materializar o substituto: %v", err)
	}
	if existe(novo.LocalRoot, "do-velho.txt") {
		t.Fatal("a cópia do substituto tinha de nascer fresca do projeto")
	}
	escreve(t, novo.LocalRoot, "do-novo.txt", "trabalho vivo")

	// O turno velho tenta promover: recusa honesta, projeto intocado.
	if err := harness.manager.Promote(context.Background(), plan, velho.Publication()); !errors.Is(err, ErrStaleStaging) {
		t.Fatalf("o turno substituído tinha de bater na cerca do staging, veio %v", err)
	}
	// E o descarte do velho também não apaga o trabalho do substituto.
	if err := harness.manager.Discard(context.Background(), plan, velho.Publication()); err != nil {
		t.Fatalf("descartar o turno velho: %v", err)
	}
	if !existe(novo.LocalRoot, "do-novo.txt") {
		t.Fatal("o descarte do turno velho apagou a cópia do substituto")
	}

	// O substituto promove normalmente.
	if err := harness.manager.Promote(context.Background(), plan, novo.Publication()); err != nil {
		t.Fatalf("o substituto tinha de promover: %v", err)
	}
	if le(t, harness.projeto, "do-novo.txt") != "trabalho vivo" || existe(harness.projeto, "do-velho.txt") {
		t.Error("o projeto tinha de receber SÓ o trabalho do substituto")
	}
}

/* --------------------------- a varredura do boot --------------------------- */

// Staging órfão de um processo MORTO não fica para sempre: o mapa de nonces
// morreu com o processo, então nenhuma cópia órfã volta a ser promovível — é
// lixo por definição, e o EnableStaging do boot seguinte varre a pasta
// inteira. Sem a varredura, a sobra de uma sessão que nunca mais roda viveria
// no disco eternamente (a materialização só limpa a pasta do PRÓPRIO plano).
func TestEnableStagingVarreOrfaosDoBootAnterior(t *testing.T) {
	dataDir := t.TempDir()
	projeto := filepath.Join(dataDir, "projects", "app")
	if err := os.MkdirAll(projeto, 0o755); err != nil {
		t.Fatalf("criar o projeto: %v", err)
	}
	// A sobra do processo morto: uma cópia meio-escrita de um plano qualquer.
	orfao := filepath.Join(dataDir, "staging", "wp-morto-chat-morto-1-deadbeef")
	escreve(t, orfao, "meio-escrito.txt", "sobra da queda")

	// O boot seguinte é um gerente NOVO (os nonces morreram junto).
	manager := NewManager(func(string) string { return projeto })
	manager.EnableStaging(dataDir)

	if existe(dataDir, "staging/wp-morto-chat-morto-1-deadbeef") {
		t.Fatal("a varredura do boot tinha de remover o staging órfão")
	}
	// E o projeto não foi tocado pela varredura.
	if _, err := os.Stat(projeto); err != nil {
		t.Fatalf("a varredura não pode tocar o projeto: %v", err)
	}
}
