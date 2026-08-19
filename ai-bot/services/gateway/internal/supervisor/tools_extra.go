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
	"os"
	"path/filepath"
	"regexp"
	"sort"
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
	registry.Register("secrets.scan",
		"procura segredo exposto nos arquivos do projeto. args: {path?}", t.secretsScan)
	registry.Register("sql.render",
		"monta o SQL de um schema. args: {dialect, schema}", t.sqlRender)
	registry.Register("schema.export",
		"exporta o schema como SQL ou ERD textual. args: {dialect, schema, format?}", t.schemaExport)
	registry.Register("osv.query",
		"consulta vulnerabilidade conhecida de uma dependência. args: {ecosystem, name, version}", t.osvQuery)
	registry.Register("webhook.post",
		"dispara um webhook pela REFERÊNCIA no cofre. args: {secretRef, body}", t.webhookPost)

	// web.search e design.replicate — ver tools_web.go.
	registry.Register("web.search",
		"pesquisa na web pelo motor configurado. args: {query, limit?}", t.webSearch)
	registry.Register("design.replicate",
		"extrai a linguagem visual (cores, variáveis, fontes, animações, layout) de uma URL. args: {url, maxPages?}",
		t.designReplicate)

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
type secretPattern struct {
	name    string
	pattern *regexp.Regexp
}

var secretPatterns = []secretPattern{
	{"chave da AWS", regexp.MustCompile(`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`)},
	{"token do GitHub", regexp.MustCompile(`\bgh[pousr]_[A-Za-z0-9]{36,}\b`)},
	{"chave da OpenAI", regexp.MustCompile(`\bsk-[A-Za-z0-9_-]{20,}\b`)},
	{"chave da Anthropic", regexp.MustCompile(`\bsk-ant-[A-Za-z0-9_-]{20,}\b`)},
	{"chave do Google", regexp.MustCompile(`\bAIza[0-9A-Za-z_-]{35}\b`)},
	{"token do Slack", regexp.MustCompile(`\bxox[baprs]-[0-9A-Za-z-]{10,}\b`)},
	{"chave privada", regexp.MustCompile(`-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----`)},
	{"JWT", regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b`)},
	{"senha em atribuição", regexp.MustCompile(`(?i)\b(?:password|senha|passwd|secret|api[_-]?key)\s*[:=]\s*["'][^"'\s]{8,}["']`)},
	{"credencial em URL", regexp.MustCompile(`\b[a-z][a-z0-9+.-]*://[^/\s:@]+:[^/\s:@]+@`)},
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

	type finding struct {
		file string
		line int
		kind string
		hint string
	}
	var findings []finding
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
				findings = append(findings, finding{
					file: filepath.ToSlash(relative),
					line: number + 1,
					kind: candidate.name,
					hint: mask(match),
				})
				break // um achado por linha basta para a pessoa ir olhar
			}
		}
		return nil
	})
	if walkErr != nil && !errors.Is(walkErr, filepath.SkipAll) {
		return "", fmt.Errorf("varrer: %w", walkErr)
	}

	if len(findings) == 0 {
		return fmt.Sprintf("nenhum segredo aparente em %d arquivos", scanned), nil
	}
	var report strings.Builder
	fmt.Fprintf(&report, "%d achado(s) em %d arquivos:\n", len(findings), scanned)
	for _, item := range findings {
		fmt.Fprintf(&report, "%s:%d — %s (%s)\n", item.file, item.line, item.kind, item.hint)
	}
	report.WriteString("\nO valor foi MASCARADO de propósito. Abra o arquivo para conferir; " +
		"e trate como vazado qualquer segredo que já esteve no histórico do git.")
	return report.String(), nil
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

type schemaField struct {
	Name       string `json:"name"`
	Type       string `json:"type"`
	PrimaryKey bool   `json:"primaryKey"`
	Unique     bool   `json:"unique"`
	Nullable   bool   `json:"nullable"`
	Default    string `json:"defaultValue"`
	References *struct {
		Table string `json:"table"`
		Field string `json:"field"`
	} `json:"references"`
}

type schemaTable struct {
	Name   string        `json:"name"`
	Fields []schemaField `json:"fields"`
}

type schemaDoc struct {
	Name    string        `json:"name"`
	Tables  []schemaTable `json:"tables"`
	Dialect string        `json:"dialect"`
}

func (t *Toolbox) sqlRender(_ context.Context, _ string, raw json.RawMessage) (string, error) {
	var args struct {
		Dialect string    `json:"dialect"`
		Schema  schemaDoc `json:"schema"`
	}
	if err := decodeArgs(raw, &args); err != nil {
		return "", err
	}
	if len(args.Schema.Tables) == 0 {
		return "", errors.New("informe o schema em \"schema\" com pelo menos uma tabela")
	}
	return renderSQL(args.Schema, args.Dialect), nil
}

func (t *Toolbox) schemaExport(_ context.Context, _ string, raw json.RawMessage) (string, error) {
	var args struct {
		Dialect string    `json:"dialect"`
		Format  string    `json:"format"`
		Schema  schemaDoc `json:"schema"`
	}
	if err := decodeArgs(raw, &args); err != nil {
		return "", err
	}
	if len(args.Schema.Tables) == 0 {
		return "", errors.New("informe o schema em \"schema\" com pelo menos uma tabela")
	}
	if strings.EqualFold(args.Format, "erd") {
		return renderERD(args.Schema), nil
	}
	return renderSQL(args.Schema, args.Dialect), nil
}

// quote aplica a citação do dialeto. Não é detalhe: uma coluna chamada `order`
// sem citação quebra no Postgres e passa no MySQL, e o schema "funciona" até o
// dia em que alguém troca de banco.
func quote(dialect, identifier string) string {
	if strings.EqualFold(dialect, "mysql") {
		return "`" + strings.ReplaceAll(identifier, "`", "``") + "`"
	}
	return `"` + strings.ReplaceAll(identifier, `"`, `""`) + `"`
}

func renderSQL(doc schemaDoc, dialect string) string {
	if dialect == "" {
		dialect = doc.Dialect
	}
	if dialect == "" {
		dialect = "postgres"
	}

	var out strings.Builder
	fmt.Fprintf(&out, "-- %s (%s)\n\n", orDefault(doc.Name, "schema"), dialect)

	// Chave estrangeira sai em ALTER depois de todas as tabelas: emitir a
	// referência dentro do CREATE obriga a ordenar as tabelas topologicamente, e
	// um ciclo de referência (que é legítimo) não teria ordem nenhuma.
	var constraints []string

	for _, table := range doc.Tables {
		fmt.Fprintf(&out, "CREATE TABLE %s (\n", quote(dialect, table.Name))
		lines := make([]string, 0, len(table.Fields)+1)
		var primary []string

		for _, field := range table.Fields {
			line := "  " + quote(dialect, field.Name) + " " + orDefault(field.Type, "text")
			if !field.Nullable {
				line += " NOT NULL"
			}
			if field.Default != "" {
				line += " DEFAULT " + field.Default
			}
			if field.Unique && !field.PrimaryKey {
				line += " UNIQUE"
			}
			lines = append(lines, line)
			if field.PrimaryKey {
				primary = append(primary, quote(dialect, field.Name))
			}
			if field.References != nil && field.References.Table != "" {
				constraints = append(constraints, fmt.Sprintf(
					"ALTER TABLE %s ADD CONSTRAINT %s FOREIGN KEY (%s) REFERENCES %s (%s);",
					quote(dialect, table.Name),
					quote(dialect, fmt.Sprintf("fk_%s_%s", table.Name, field.Name)),
					quote(dialect, field.Name),
					quote(dialect, field.References.Table),
					quote(dialect, orDefault(field.References.Field, "id")),
				))
			}
		}
		if len(primary) > 0 {
			lines = append(lines, "  PRIMARY KEY ("+strings.Join(primary, ", ")+")")
		}
		out.WriteString(strings.Join(lines, ",\n"))
		out.WriteString("\n);\n\n")
	}

	if len(constraints) > 0 {
		sort.Strings(constraints)
		out.WriteString(strings.Join(constraints, "\n"))
		out.WriteString("\n")
	}
	return out.String()
}

// renderERD desenha o diagrama em texto. Existe porque um schema revisado no
// chat é lido, não executado — e ler CREATE TABLE para entender relação é o
// trabalho que o diagrama poupa.
func renderERD(doc schemaDoc) string {
	var out strings.Builder
	fmt.Fprintf(&out, "%s\n\n", orDefault(doc.Name, "schema"))
	for _, table := range doc.Tables {
		fmt.Fprintf(&out, "┌─ %s\n", table.Name)
		for _, field := range table.Fields {
			marker := " "
			switch {
			case field.PrimaryKey:
				marker = "◆"
			case field.References != nil:
				marker = "→"
			case field.Unique:
				marker = "○"
			}
			fmt.Fprintf(&out, "│ %s %s: %s", marker, field.Name, orDefault(field.Type, "text"))
			if field.References != nil {
				fmt.Fprintf(&out, "  ⇒ %s.%s", field.References.Table, orDefault(field.References.Field, "id"))
			}
			out.WriteString("\n")
		}
		out.WriteString("└─\n\n")
	}
	return out.String()
}

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

	var parsed struct {
		Vulns []struct {
			ID       string   `json:"id"`
			Summary  string   `json:"summary"`
			Aliases  []string `json:"aliases"`
			Severity []struct {
				Type  string `json:"type"`
				Score string `json:"score"`
			} `json:"severity"`
		} `json:"vulns"`
	}
	if err := json.Unmarshal(payload, &parsed); err != nil {
		return "", fmt.Errorf("resposta inesperada: %w", err)
	}
	if len(parsed.Vulns) == 0 {
		return fmt.Sprintf("%s %s (%s): nenhuma vulnerabilidade conhecida",
			args.Name, args.Version, args.Ecosystem), nil
	}

	var report strings.Builder
	fmt.Fprintf(&report, "%s %s (%s): %d vulnerabilidade(s)\n",
		args.Name, args.Version, args.Ecosystem, len(parsed.Vulns))
	for _, vulnerability := range parsed.Vulns {
		fmt.Fprintf(&report, "- %s", vulnerability.ID)
		if len(vulnerability.Aliases) > 0 {
			fmt.Fprintf(&report, " (%s)", strings.Join(vulnerability.Aliases, ", "))
		}
		for _, severity := range vulnerability.Severity {
			fmt.Fprintf(&report, " [%s %s]", severity.Type, severity.Score)
		}
		fmt.Fprintf(&report, ": %s\n", strings.TrimSpace(vulnerability.Summary))
	}
	return report.String(), nil
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
