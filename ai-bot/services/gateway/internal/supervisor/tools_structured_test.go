// Testes do bloco JSON estruturado das ferramentas anti-casca.
//
// O contrato aqui é com a TELA: cada teste extrai o bloco demarcado exatamente
// como a superfície extrai (última cerca ```json) e afirma sobre o que a tela
// vai desenhar. O texto legível é conferido junto porque ele é a metade do
// contrato que o modelo lê — sumir com ele quebraria a conversa, não a tela.
package supervisor

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// blocoJSON extrai o bloco demarcado do fim do resultado — o espelho em Go do
// structuredJson da tela.
func blocoJSON(t *testing.T, output string) string {
	t.Helper()
	fence := strings.LastIndex(output, "```json\n")
	if fence < 0 {
		t.Fatalf("o resultado não tem bloco ```json:\n%s", output)
	}
	rest := output[fence+len("```json\n"):]
	end := strings.Index(rest, "\n```")
	if end < 0 {
		t.Fatalf("o bloco ```json não fecha:\n%s", output)
	}
	return rest[:end]
}

/* ------------------------------ flow.validate ----------------------------- */

func TestFlowValidateAppendsStructuredGraph(t *testing.T) {
	toolbox := &Toolbox{}
	doc := FlowDoc{
		Name: "atendimento",
		Nodes: []FlowNode{
			flowNode("start", flowInput, "work"),
			// "work" sem onError: vira aviso ATRIBUÍDO ao nó no bloco JSON.
			flowNode("work", flowAction, "done"),
			flowNode("done", flowOutput),
		},
	}
	raw, err := json.Marshal(map[string]any{"flow": doc})
	if err != nil {
		t.Fatalf("montar argumentos: %v", err)
	}
	out, err := toolbox.flowValidate(nil, "s1", raw)
	if err != nil {
		t.Fatalf("flow.validate: %v", err)
	}
	// O relatório legível continua na frente — é ele que o modelo lê.
	if !strings.Contains(out, "VÁLIDO") {
		t.Fatalf("o relatório em texto sumiu:\n%s", out)
	}

	var graph flowExport
	if err := json.Unmarshal([]byte(blocoJSON(t, out)), &graph); err != nil {
		t.Fatalf("o bloco JSON não parseia: %v", err)
	}
	if !graph.OK || graph.Name != "atendimento" {
		t.Fatalf("veredito/nome errados no bloco: %+v", graph)
	}
	if len(graph.Nodes) != 3 || graph.Nodes[1].ID != "work" || graph.Nodes[1].Kind != "action" {
		t.Fatalf("nós errados no bloco: %+v", graph.Nodes)
	}
	if len(graph.Edges) != 2 || graph.Edges[0].From != "start" || graph.Edges[0].To != "work" {
		t.Fatalf("arestas erradas no bloco: %+v", graph.Edges)
	}
	if len(graph.Problems) != 1 || graph.Problems[0].Level != "warn" || graph.Problems[0].NodeID != "work" {
		t.Fatalf("o aviso de falta de onError não foi atribuído ao nó: %+v", graph.Problems)
	}
}

// O caminho de erro vira aresta ROTULADA — é o que deixa a tela desenhá-lo
// diferente do caminho feliz.
func TestFlowStructuredLabelsErrorPath(t *testing.T) {
	report := ValidateFlow(okFlow())
	graph := flowStructured(okFlow(), report)

	var labeled *flowExportEdge
	for index := range graph.Edges {
		if graph.Edges[index].Label == "erro" {
			labeled = &graph.Edges[index]
		}
	}
	if labeled == nil || labeled.From != "work" || labeled.To != "fail" {
		t.Fatalf("a aresta de onError não saiu rotulada: %+v", graph.Edges)
	}
}

// Fluxo RECUSADO também sai desenhável: é o torto que a pessoa precisa ver.
func TestFlowStructuredKeepsBrokenGraphDrawable(t *testing.T) {
	doc := FlowDoc{Nodes: []FlowNode{
		flowNode("start", flowInput, "fantasma"),
		flowNode("solto", flowAction),
	}}
	report := ValidateFlow(doc)
	if report.Valid {
		t.Fatal("o fluxo do teste precisa ser inválido")
	}
	graph := flowStructured(doc, report)
	if graph.OK {
		t.Fatal("o bloco não pode dizer ok para fluxo recusado")
	}
	if len(graph.Nodes) != 2 {
		t.Fatalf("os nós têm de sair mesmo com o fluxo recusado: %+v", graph.Nodes)
	}
	// A aresta para o nó inexistente sai como declarada; quem a descarta é a
	// tela, por não ter onde ancorá-la.
	if len(graph.Edges) != 1 || graph.Edges[0].To != "fantasma" {
		t.Fatalf("a aresta declarada sumiu: %+v", graph.Edges)
	}
	achouFantasma := false
	for _, problem := range graph.Problems {
		if problem.Level == "error" && problem.NodeID == "start" && strings.Contains(problem.Message, "fantasma") {
			achouFantasma = true
		}
	}
	if !achouFantasma {
		t.Fatalf("o erro da aresta quebrada não foi atribuído a quem a declarou: %+v", graph.Problems)
	}
}

/* ------------------------------ secrets.scan ------------------------------ */

func TestSecretsScanAppendsStructuredFindings(t *testing.T) {
	root := t.TempDir()
	// Chave sintética no formato da AWS — o padrão exige AKIA + 16 maiúsculas.
	planted := "AKIA" + strings.Repeat("A", 16)
	if err := os.WriteFile(filepath.Join(root, "config.ts"), []byte("const x = 1\nconst key = \""+planted+"\"\n"), 0o644); err != nil {
		t.Fatalf("plantar arquivo: %v", err)
	}

	toolbox := &Toolbox{}
	out, err := toolbox.secretsScan(ctxComRoot(root), "s1", json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("secrets.scan: %v", err)
	}

	var doc secretScanDoc
	if err := json.Unmarshal([]byte(blocoJSON(t, out)), &doc); err != nil {
		t.Fatalf("o bloco JSON não parseia: %v", err)
	}
	if len(doc.Findings) != 1 {
		t.Fatalf("esperava 1 achado, veio %d: %+v", len(doc.Findings), doc.Findings)
	}
	found := doc.Findings[0]
	if found.Severity != "critical" || found.Rule != "chave da AWS" || found.File != "config.ts" || found.Line != 2 {
		t.Fatalf("achado com campos errados: %+v", found)
	}
	// A regra de ouro vale no JSON também: o valor NUNCA sai inteiro.
	if strings.Contains(out, planted) {
		t.Fatal("o segredo saiu inteiro no resultado — inclusive no bloco JSON isso é vazamento")
	}
	if found.Evidence == "" || !strings.Contains(found.Evidence, "…") {
		t.Fatalf("a evidência tem de ser a versão mascarada: %q", found.Evidence)
	}
}

// Varredura limpa também emite o bloco: é ele que separa "veio limpo" de
// "ninguém varreu" na tela.
func TestSecretsScanEmitsBlockWhenClean(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "main.go"), []byte("package main\n"), 0o644); err != nil {
		t.Fatalf("plantar arquivo: %v", err)
	}
	toolbox := &Toolbox{}
	out, err := toolbox.secretsScan(ctxComRoot(root), "s1", json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("secrets.scan: %v", err)
	}
	var doc secretScanDoc
	if err := json.Unmarshal([]byte(blocoJSON(t, out)), &doc); err != nil {
		t.Fatalf("o bloco JSON não parseia: %v", err)
	}
	if doc.Findings == nil || len(doc.Findings) != 0 || doc.Scanned != 1 {
		t.Fatalf("esperava findings [] e scanned 1: %+v", doc)
	}
}

/* -------------------------------- osv.query ------------------------------- */

func TestOsvReportAppendsStructuredVulns(t *testing.T) {
	payload := []byte(`{"vulns":[
		{"id":"GHSA-p6mc-m468-83gw","summary":"Prototype Pollution in lodash",
		 "aliases":["CVE-2020-8203"],
		 "severity":[{"type":"CVSS_V3","score":"CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:N/I:H/A:H"}],
		 "database_specific":{"severity":"HIGH"}}
	]}`)
	out, err := osvReport("lodash", "4.17.15", "npm", payload)
	if err != nil {
		t.Fatalf("osvReport: %v", err)
	}
	if !strings.Contains(out, "1 vulnerabilidade(s)") {
		t.Fatalf("o relatório em texto sumiu:\n%s", out)
	}

	var doc osvDoc
	if err := json.Unmarshal([]byte(blocoJSON(t, out)), &doc); err != nil {
		t.Fatalf("o bloco JSON não parseia: %v", err)
	}
	if doc.Package.Name != "lodash" || doc.Package.Ecosystem != "npm" || doc.Version != "4.17.15" {
		t.Fatalf("o alvo consultado não está na raiz do bloco: %+v", doc)
	}
	if len(doc.Vulns) != 1 {
		t.Fatalf("esperava 1 vulnerabilidade: %+v", doc.Vulns)
	}
	vuln := doc.Vulns[0]
	if vuln.Severity != "high" {
		t.Fatalf("a faixa não foi normalizada para minúsculas: %q", vuln.Severity)
	}
	if vuln.URL != "https://osv.dev/vulnerability/GHSA-p6mc-m468-83gw" {
		t.Fatalf("a URL do advisory saiu errada: %q", vuln.URL)
	}
}

func TestOsvReportEmitsBlockWhenClean(t *testing.T) {
	out, err := osvReport("left-pad", "1.3.0", "npm", []byte(`{}`))
	if err != nil {
		t.Fatalf("osvReport: %v", err)
	}
	var doc osvDoc
	if err := json.Unmarshal([]byte(blocoJSON(t, out)), &doc); err != nil {
		t.Fatalf("o bloco JSON não parseia: %v", err)
	}
	if doc.Vulns == nil || len(doc.Vulns) != 0 {
		t.Fatalf("esperava vulns []: %+v", doc)
	}
}

/* ----------------------------- finetune.status ---------------------------- */

func TestFinetuneStatusReportAppendsStructuredRuns(t *testing.T) {
	jobs := []finetuneJob{
		{ID: "ftjob-1", Model: "base-a", Status: "running", CreatedAt: 1755550000},
		{ID: "ftjob-2", Model: "base-b", Status: "succeeded", FineTunedModel: "ft:base-b:acme"},
	}
	out := finetuneStatusReport("openai", jobs)
	if !strings.Contains(out, "2 treino(s) em openai") {
		t.Fatalf("o relatório em texto sumiu:\n%s", out)
	}

	var doc finetuneStatusDoc
	if err := json.Unmarshal([]byte(blocoJSON(t, out)), &doc); err != nil {
		t.Fatalf("o bloco JSON não parseia: %v", err)
	}
	if doc.Provider != "openai" || len(doc.Runs) != 2 {
		t.Fatalf("bloco errado: %+v", doc)
	}
	if doc.Runs[0].State != "running" || doc.Runs[0].CreatedAt == "" {
		t.Fatalf("a primeira execução saiu sem estado/data: %+v", doc.Runs[0])
	}
	if doc.Runs[1].FineTunedModel != "ft:base-b:acme" {
		t.Fatalf("o modelo resultante — a única parte acionável — sumiu: %+v", doc.Runs[1])
	}
}

// O erro do provedor entra no bloco pelo MESMO filtro do texto: um treino que
// falhou por credencial volta com a chave parcial dentro do JSON do job.
func TestFinetuneStatusReportRedactsProviderEchoInBlock(t *testing.T) {
	leaked := "sk-" + strings.Repeat("a", 24)
	job := finetuneJob{ID: "ftjob-3", Status: "failed"}
	job.Error = &struct {
		Message string `json:"message"`
	}{Message: "Incorrect API key provided: " + leaked}

	out := finetuneStatusReport("openai", []finetuneJob{job})
	if strings.Contains(out, leaked) {
		t.Fatal("a chave ecoada pelo provedor atravessou para o resultado")
	}
	var doc finetuneStatusDoc
	if err := json.Unmarshal([]byte(blocoJSON(t, out)), &doc); err != nil {
		t.Fatalf("o bloco JSON não parseia: %v", err)
	}
	if !strings.Contains(doc.Runs[0].Error, "«oculto»") {
		t.Fatalf("o erro não foi filtrado no bloco: %q", doc.Runs[0].Error)
	}
}

// Sem treino nenhum o bloco sai com runs [] — a tela fica no vazio digno, mas
// sabendo que a consulta aconteceu.
func TestFinetuneStatusReportEmitsBlockWhenEmpty(t *testing.T) {
	out := finetuneStatusReport("openai", nil)
	if !strings.Contains(out, "nenhum treino registrado em openai") {
		t.Fatalf("o texto de vazio sumiu:\n%s", out)
	}
	var doc finetuneStatusDoc
	if err := json.Unmarshal([]byte(blocoJSON(t, out)), &doc); err != nil {
		t.Fatalf("o bloco JSON não parseia: %v", err)
	}
	if doc.Runs == nil || len(doc.Runs) != 0 {
		t.Fatalf("esperava runs []: %+v", doc)
	}
}
