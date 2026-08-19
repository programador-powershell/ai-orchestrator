// Ferramentas que o gateway resolve sozinho.
//
// Cada uma destas nasceu candidata a "roda no Rust" e foi trazida para cá
// depois de uma pergunta só: ela precisa de algo que a máquina tem e o servidor
// não? Varredura de segredo é ler arquivo; SQL é texto; consulta de
// vulnerabilidade e webhook são rede. Nenhuma precisa de ConPTY, Job Object nem
// do Credential Manager — então ficam em Go, onde funcionam também quando o
// gateway roda num servidor sem interface nenhuma.
package supervisor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"aibot/gateway/internal/pack"
)

// SecretUser é o cofre visto por este arquivo: dá para USAR o segredo, não para
// obtê-lo. É a mesma indireção do app anterior — a URL de um webhook É o
// segredo, e devolvê-la para quem chama a coloca em log e em mensagem de erro.
type SecretUser interface {
	Use(ref string, fn func(secret string) error) error
	Has(ref string) bool
}

// InstallExtraTools registra as ferramentas resolvidas no gateway.
func (t *Toolbox) InstallExtraTools(registry *Registry) {
	// secrets.scan e osv.query soletram o bloco ```json do fim: é dele que a
	// tela de Achados monta os cartões — o relatório em texto continua na
	// frente para o modelo e para a pessoa.
	registry.Register("secrets.scan",
		"procura segredo exposto nos arquivos do projeto e devolve o relatório + bloco ```json "+
			"{scanned, findings: [{severity, rule, file, line, evidence}]} (evidence sempre mascarada). "+
			"args: {path?}", t.secretsScan)
	// As duas ferramentas de dados devolvem JSON, não texto: a tela de Dados
	// (SchemaSurface) desenha o diagrama a partir do tool.result, e texto plano
	// deixava o painel vazio para sempre. A descrição soletra o formato porque
	// ela é o ÚNICO contrato que o modelo vê — implementação em tools_data.go.
	registry.Register("sql.render",
		"monta o DDL completo do schema por dialeto (tipos mapeados, DEFAULT traduzido, FK com ON UPDATE/ON DELETE, "+
			"tabela de junção para n-n, CREATE [UNIQUE] INDEX) e devolve JSON {sql, dialect}. "+
			"args: {dialect: postgres|mysql|ansi|sqlite|mssql, schema: {name, "+
			"tables: [{name, fields: [{name, type, primaryKey?, unique?, nullable?, defaultValue?, references?: {table, field}}]}], "+
			"relations?: [{fromTable, fromField, toTable, toField, cardinality?: \"1-1\"|\"1-n\"|\"n-n\", onUpdate?, onDelete?}], "+
			"indexes?: [{table, fields, unique?}]}}", t.sqlRender)
	registry.Register("schema.export",
		"exporta o schema como JSON estruturado {tables, relations, indexes, dialect, sql} — é este JSON que a tela de "+
			"Dados transforma em diagrama ERD. args: os mesmos de sql.render, mais {format?: \"erd\"} para incluir também "+
			"o diagrama textual no campo \"erd\"", t.schemaExport)
	registry.Register("osv.query",
		"consulta vulnerabilidade conhecida de uma dependência e devolve o relatório + bloco ```json "+
			"{package, version, vulns: [{id, aliases, severity?, summary, url}]}. "+
			"args: {ecosystem, name, version}", t.osvQuery)
	registry.Register("webhook.post",
		"dispara um webhook pela REFERÊNCIA no cofre. args: {secretRef, body}", t.webhookPost)

	// web.search — ver tools_web.go.
	registry.Register("web.search",
		"pesquisa na web pelo motor configurado. args: {query, limit?}", t.webSearch)

	// design.replicate — ver tools_design.go: devolve o JSON estruturado que a
	// tela de Design consome (os extratores continuam em tools_web.go).
	t.designToolsInstall(registry)

	// O inventário dos pacotes corporativos (internal/pack). Registrado AQUI, e
	// não no main, porque toda ferramenta que um especialista promete tem de
	// nascer da Toolbox — é a invariante que tools_host_test.go verifica.
	registry.Register("pack.list",
		"lista os pacotes corporativos instalados neste gateway. args: {}", packList)

	// image.generate, finetune.submit e finetune.status — ver tools_provider.go.
	t.providerToolsInstall(registry)
}

/* ---------------------------- varredura de segredo ---------------------------- */

// secretPattern é um par de detector. `Redact` no fim garante que o valor
// encontrado NUNCA é ecoado inteiro — mostrar o segredo dentro do relatório de
// "achamos um segredo exposto" é expor o segredo de novo, agora no histórico da
// conversa e no log do gateway.
//
// A severidade é do PADRÃO, não do arquivo: chave de provedor e chave privada
// são "critical" porque valem sozinhas e não expiram por conta própria; JWT,
// senha em atribuição e credencial em URL são "high" porque dependem de
// contexto (o alvo, a validade) para virar acesso. É esta severidade que a
// tela de Achados usa para ordenar e contar.
type secretPattern struct {
	name     string
	severity string
	pattern  *regexp.Regexp
}

var secretPatterns = []secretPattern{
	{"chave da AWS", "critical", regexp.MustCompile(`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`)},
	{"token do GitHub", "critical", regexp.MustCompile(`\bgh[pousr]_[A-Za-z0-9]{36,}\b`)},
	{"chave da OpenAI", "critical", regexp.MustCompile(`\bsk-[A-Za-z0-9_-]{20,}\b`)},
	{"chave da Anthropic", "critical", regexp.MustCompile(`\bsk-ant-[A-Za-z0-9_-]{20,}\b`)},
	{"chave do Google", "critical", regexp.MustCompile(`\bAIza[0-9A-Za-z_-]{35}\b`)},
	{"token do Slack", "critical", regexp.MustCompile(`\bxox[baprs]-[0-9A-Za-z-]{10,}\b`)},
	{"chave privada", "critical", regexp.MustCompile(`-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----`)},
	{"JWT", "high", regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b`)},
	{"senha em atribuição", "high", regexp.MustCompile(`(?i)\b(?:password|senha|passwd|secret|api[_-]?key)\s*[:=]\s*["'][^"'\s]{8,}["']`)},
	{"credencial em URL", "high", regexp.MustCompile(`\b[a-z][a-z0-9+.-]*://[^/\s:@]+:[^/\s:@]+@`)},
}

// scanSkip evita o falso positivo mais comum: a pasta de dependências, cheia de
// chave de exemplo em teste de biblioteca. Um relatório com 400 achados de
// node_modules é um relatório que ninguém lê — e é assim que o achado real passa.
func scanSkip(name string) bool {
	if skipDir(name) {
		return true
	}
	switch name {
	case ".idea", ".vscode", "coverage", ".pytest_cache", "Pods":
		return true
	}
	return false
}

func (t *Toolbox) secretsScan(ctx context.Context, sessionID string, raw json.RawMessage) (string, error) {
	var args struct {
		Path string `json:"path"`
	}
	if err := decodeArgs(raw, &args); err != nil {
		return "", err
	}
	base, err := resolveInside(t.root(ctx), args.Path)
	if err != nil {
		return "", err
	}

	var findings []secretFinding
	scanned := 0

	walkErr := filepath.WalkDir(base, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if entry.IsDir() {
			if scanSkip(entry.Name()) {
				return filepath.SkipDir
			}
			return nil
		}
		if scanned >= searchMaxFiles || len(findings) >= searchMaxResults {
			return filepath.SkipAll
		}
		info, err := entry.Info()
		if err != nil || info.Size() > searchMaxSize {
			return nil
		}
		content, err := os.ReadFile(path)
		if err != nil || !isProbablyText(content) {
			return nil
		}
		scanned++
		relative, _ := filepath.Rel(base, path)
		for number, line := range strings.Split(string(content), "\n") {
			for _, candidate := range secretPatterns {
				match := candidate.pattern.FindString(line)
				if match == "" {
					continue
				}
				findings = append(findings, secretFinding{
					Severity: candidate.severity,
					Rule:     candidate.name,
					File:     filepath.ToSlash(relative),
					Line:     number + 1,
					Evidence: mask(match),
				})
				break // um achado por linha basta para a pessoa ir olhar
			}
		}
		return nil
	})
	if walkErr != nil && !errors.Is(walkErr, filepath.SkipAll) {
		return "", fmt.Errorf("varrer: %w", walkErr)
	}

	// O bloco JSON sai SEMPRE, inclusive com zero achados: é ele que deixa a
	// tela de Achados distinguir "a varredura veio limpa" de "ninguém varreu" —
	// as duas frases parecem iguais e só uma delas é verdade.
	structured := secretScanDoc{Scanned: scanned, Findings: findings}
	if structured.Findings == nil {
		structured.Findings = make([]secretFinding, 0)
	}
	if len(findings) == 0 {
		return appendStructuredJSON(
			fmt.Sprintf("nenhum segredo aparente em %d arquivos", scanned), structured), nil
	}
	var report strings.Builder
	fmt.Fprintf(&report, "%d achado(s) em %d arquivos:\n", len(findings), scanned)
	for _, item := range findings {
		fmt.Fprintf(&report, "%s:%d — %s (%s)\n", item.File, item.Line, item.Rule, item.Evidence)
	}
	report.WriteString("\nO valor foi MASCARADO de propósito. Abra o arquivo para conferir; " +
		"e trate como vazado qualquer segredo que já esteve no histórico do git.")
	return appendStructuredJSON(report.String(), structured), nil
}

// secretFinding é um achado como a tela de Achados o lê: severidade, regra,
// onde. `Evidence` carrega só a versão MASCARADA (mask) — a regra de ouro da
// tela vale aqui também: o valor inteiro nunca viaja no resultado.
type secretFinding struct {
	Severity string `json:"severity"`
	Rule     string `json:"rule"`
	File     string `json:"file"`
	Line     int    `json:"line"`
	Evidence string `json:"evidence"`
}

// secretScanDoc é o bloco JSON de secrets.scan.
type secretScanDoc struct {
	Scanned  int             `json:"scanned"`
	Findings []secretFinding `json:"findings"`
}

// mask mostra o suficiente para a pessoa reconhecer o segredo sem republicá-lo.
func mask(value string) string {
	runes := []rune(value)
	if len(runes) <= 8 {
		return "•••"
	}
	return string(runes[:4]) + "…•••…" + string(runes[len(runes)-2:])
}

/* --------------------------------- schema --------------------------------- */

// sql.render e schema.export moram em tools_data.go: cresceram de "SQL é texto"
// para o motor de DDL multi-dialeto + export estruturado que a tela de Dados
// consome, e este arquivo é o catálogo, não o lugar de um motor.

func orDefault(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

/* ------------------------------ vulnerabilidade ---------------------------- */

func (t *Toolbox) osvQuery(ctx context.Context, _ string, raw json.RawMessage) (string, error) {
	if t.Net == nil {
		return "", errors.New("a saída de rede não está disponível")
	}
	var args struct {
		Ecosystem string `json:"ecosystem"`
		Name      string `json:"name"`
		Version   string `json:"version"`
	}
	if err := decodeArgs(raw, &args); err != nil {
		return "", err
	}
	if args.Name == "" {
		return "", errors.New("informe o nome do pacote")
	}

	body, err := json.Marshal(map[string]any{
		"version": args.Version,
		"package": map[string]string{"name": args.Name, "ecosystem": args.Ecosystem},
	})
	if err != nil {
		return "", err
	}
	response, payload, err := t.Net.Post(ctx, "https://api.osv.dev/v1/query", body)
	if err != nil {
		return "", err
	}
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("a consulta respondeu %d", response.StatusCode)
	}
	return osvReport(args.Name, args.Version, args.Ecosystem, payload)
}

// osvVuln é a resposta da OSV no que interessa. `database_specific.severity` é
// de onde sai a faixa legível (CRITICAL/HIGH/MODERATE/LOW): o campo `severity`
// de cima traz o VETOR CVSS, e calcular a nota a partir do vetor é uma
// aritmética inteira que não vale reimplementar aqui — quando a faixa não vem,
// o achado sai sem severidade em vez de sair com uma inventada.
type osvVuln struct {
	ID       string   `json:"id"`
	Summary  string   `json:"summary"`
	Aliases  []string `json:"aliases"`
	Severity []struct {
		Type  string `json:"type"`
		Score string `json:"score"`
	} `json:"severity"`
	DatabaseSpecific struct {
		Severity string `json:"severity"`
	} `json:"database_specific"`
}

// osvFinding é uma vulnerabilidade como a tela de Achados a lê. A URL do
// advisory vai PRONTA porque é o gateway quem conhece a convenção do osv.dev —
// a tela só abre o que recebeu.
type osvFinding struct {
	ID       string   `json:"id"`
	Aliases  []string `json:"aliases,omitempty"`
	Severity string   `json:"severity,omitempty"`
	Summary  string   `json:"summary,omitempty"`
	URL      string   `json:"url"`
}

// osvDoc é o bloco JSON de osv.query. O pacote consultado fica na raiz — cada
// vulnerabilidade da lista só traz o id e a nota, e sem o alvo a tela mostraria
// "GHSA-…" sem dizer de quê.
type osvDoc struct {
	Package struct {
		Name      string `json:"name"`
		Ecosystem string `json:"ecosystem,omitempty"`
	} `json:"package"`
	Version string       `json:"version,omitempty"`
	Vulns   []osvFinding `json:"vulns"`
}

// osvReport transforma a resposta crua da OSV no relatório + bloco JSON.
// Função pura de propósito: o cliente HTTP fica em osvQuery e ISTO se testa
// sem rede.
func osvReport(name, version, ecosystem string, payload []byte) (string, error) {
	var parsed struct {
		Vulns []osvVuln `json:"vulns"`
	}
	if err := json.Unmarshal(payload, &parsed); err != nil {
		return "", fmt.Errorf("resposta inesperada: %w", err)
	}

	doc := osvDoc{Version: version, Vulns: make([]osvFinding, 0, len(parsed.Vulns))}
	doc.Package.Name = name
	doc.Package.Ecosystem = ecosystem
	for _, vulnerability := range parsed.Vulns {
		doc.Vulns = append(doc.Vulns, osvFinding{
			ID:       vulnerability.ID,
			Aliases:  vulnerability.Aliases,
			Severity: strings.ToLower(strings.TrimSpace(vulnerability.DatabaseSpecific.Severity)),
			Summary:  strings.TrimSpace(vulnerability.Summary),
			URL:      "https://osv.dev/vulnerability/" + url.PathEscape(vulnerability.ID),
		})
	}

	if len(parsed.Vulns) == 0 {
		return appendStructuredJSON(fmt.Sprintf("%s %s (%s): nenhuma vulnerabilidade conhecida",
			name, version, ecosystem), doc), nil
	}

	var report strings.Builder
	fmt.Fprintf(&report, "%s %s (%s): %d vulnerabilidade(s)\n",
		name, version, ecosystem, len(parsed.Vulns))
	for _, vulnerability := range parsed.Vulns {
		fmt.Fprintf(&report, "- %s", vulnerability.ID)
		if len(vulnerability.Aliases) > 0 {
			fmt.Fprintf(&report, " (%s)", strings.Join(vulnerability.Aliases, ", "))
		}
		if faixa := strings.TrimSpace(vulnerability.DatabaseSpecific.Severity); faixa != "" {
			fmt.Fprintf(&report, " [%s]", faixa)
		}
		for _, severity := range vulnerability.Severity {
			fmt.Fprintf(&report, " [%s %s]", severity.Type, severity.Score)
		}
		fmt.Fprintf(&report, ": %s\n", strings.TrimSpace(vulnerability.Summary))
	}
	return appendStructuredJSON(report.String(), doc), nil
}

/* --------------------------------- webhook -------------------------------- */

func (t *Toolbox) webhookPost(ctx context.Context, _ string, raw json.RawMessage) (string, error) {
	if t.Secrets == nil {
		return "", errors.New("o cofre não está disponível")
	}
	if t.Net == nil {
		return "", errors.New("a saída de rede não está disponível")
	}
	var args struct {
		SecretRef string          `json:"secretRef"`
		Body      json.RawMessage `json:"body"`
	}
	if err := decodeArgs(raw, &args); err != nil {
		return "", err
	}
	if args.SecretRef == "" {
		return "", errors.New("informe a referência do webhook no cofre em \"secretRef\"")
	}
	if !t.Secrets.Has(args.SecretRef) {
		return "", fmt.Errorf("não há webhook cadastrado sob %q", args.SecretRef)
	}
	payload := args.Body
	if len(payload) == 0 {
		payload = json.RawMessage("{}")
	}

	// A URL é o segredo: ela é usada DENTRO do callback e nunca sai dele. É por
	// isso que o resultado é montado aqui e a mensagem de erro é reescrita — o
	// erro cru do cliente HTTP traz a URL inteira.
	var summary string
	err := t.Secrets.Use(args.SecretRef, func(secret string) error {
		response, body, err := t.Net.Post(ctx, secret, payload)
		if err != nil {
			return errors.New("o webhook não respondeu")
		}
		excerpt := strings.TrimSpace(string(body))
		if len(excerpt) > 300 {
			excerpt = excerpt[:300] + "…"
		}
		summary = fmt.Sprintf("webhook respondeu %d: %s", response.StatusCode, excerpt)
		return nil
	})
	if err != nil {
		return "", err
	}
	return summary, nil
}

/* ------------------------------ pacotes ------------------------------- */

// packList é a ferramenta `pack.list`: o inventário do que a TI instalou.
//
// Ela lê o registro do próprio pacote pack (estado de processo, como o
// catálogo de especialistas) em vez de receber injeção pela Toolbox: o
// inventário é um só por gateway, e um campo a mais na Toolbox seria uma
// segunda fonte para o mesmo dado. Só metadado sai por aqui — nome, versão e
// contagens; o CONTEÚDO dos prompts não, porque ele pode carregar contexto
// interno da empresa e esta ferramenta é de leitura livre.
func packList(context.Context, string, json.RawMessage) (string, error) {
	packs := pack.Installed()
	if len(packs) == 0 {
		return "nenhum pacote corporativo instalado neste gateway — a TI instala com `aibotd pack install <caminho>`", nil
	}
	return pack.Describe(packs), nil
}
