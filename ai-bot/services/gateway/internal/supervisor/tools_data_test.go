// Testes das ferramentas de dados (sql.render e schema.export).
//
// O que está em jogo aqui é um CONTRATO com uma tela: o parse() da
// SchemaSurface só desenha o diagrama se o JSON vier com as chaves exatas
// (tables/fields/pk/fk/nullable, relations/from/to/kind, indexes, dialect, sql).
// Por isso os testes conferem o texto serializado, não só a struct — a struct
// pode estar certa e a tag JSON errada, e a tela ficaria vazia sem nenhum
// teste vermelho. O motor de DDL é um porte do exportSql do orquestrador, e
// cada regra portada (tipo por dialeto, now(), junção n-n, ação de FK, índice)
// tem um teste porque cada uma nasceu de um DDL que quebrou em algum banco.
package supervisor

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

/* ------------------------------ auxiliares ------------------------------ */

// lojaArgs é o schema-fixture dos testes: cobre serial/uuid/jsonb/timestamptz,
// PK, UNIQUE, NOT NULL, DEFAULT now(), FK com ações referenciais, relação n-n
// e índices (um deles órfão de propósito). Os testes trocam SÓ o dialeto.
func lojaArgs(dialect string) string {
	return `{
	  "dialect": "` + dialect + `",
	  "schema": {
	    "name": "loja",
	    "tables": [
	      {"name": "users", "fields": [
	        {"name": "id", "type": "serial", "primaryKey": true},
	        {"name": "email", "type": "varchar", "unique": true},
	        {"name": "profile", "type": "jsonb", "nullable": true},
	        {"name": "created_at", "type": "timestamptz", "defaultValue": "now()"}
	      ]},
	      {"name": "orders", "fields": [
	        {"name": "id", "type": "uuid", "primaryKey": true},
	        {"name": "user_id", "type": "int", "references": {"table": "users", "field": "id"}}
	      ]},
	      {"name": "tags", "fields": [
	        {"name": "id", "type": "serial", "primaryKey": true},
	        {"name": "name", "type": "text"}
	      ]}
	    ],
	    "relations": [
	      {"fromTable": "orders", "fromField": "user_id", "toTable": "users", "toField": "id",
	       "onUpdate": "CASCADE", "onDelete": "SET NULL"},
	      {"fromTable": "users", "fromField": "id", "toTable": "tags", "toField": "id", "cardinality": "n-n"}
	    ],
	    "indexes": [
	      {"table": "users", "fields": ["email"], "unique": true},
	      {"table": "orders", "fields": ["user_id"]},
	      {"table": "users", "fields": ["fantasma"]}
	    ]
	  }
	}`
}

func callDataTool(t *testing.T, fn func(context.Context, string, json.RawMessage) (string, error), args string) string {
	t.Helper()
	out, err := fn(context.Background(), "sessao-teste", json.RawMessage(args))
	if err != nil {
		t.Fatalf("a ferramenta recusou: %v", err)
	}
	return out
}

// renderedSQL devolve o campo "sql" do JSON — todos os testes de DDL passam por
// aqui para garantir de tabela que a resposta é JSON, nunca texto solto.
func renderedSQL(t *testing.T, out string) string {
	t.Helper()
	var payload struct {
		SQL     string `json:"sql"`
		Dialect string `json:"dialect"`
	}
	if err := json.Unmarshal([]byte(out), &payload); err != nil {
		t.Fatalf("resposta não é JSON: %v\n%s", err, out)
	}
	if payload.SQL == "" {
		t.Fatalf("resposta sem campo \"sql\":\n%s", out)
	}
	return payload.SQL
}

func requireContains(t *testing.T, text string, wanted ...string) {
	t.Helper()
	for _, piece := range wanted {
		if !strings.Contains(text, piece) {
			t.Fatalf("esperava encontrar %q em:\n%s", piece, text)
		}
	}
}

func requireAbsent(t *testing.T, text string, unwanted ...string) {
	t.Helper()
	for _, piece := range unwanted {
		if strings.Contains(text, piece) {
			t.Fatalf("NÃO esperava encontrar %q em:\n%s", piece, text)
		}
	}
}

/* ------------------------------- sql.render ------------------------------ */

func TestSqlRenderDevolveJsonComSqlEDialeto(t *testing.T) {
	box := &Toolbox{}
	out := callDataTool(t, box.sqlRender, lojaArgs("postgres"))

	var payload struct {
		SQL     string `json:"sql"`
		Dialect string `json:"dialect"`
	}
	if err := json.Unmarshal([]byte(out), &payload); err != nil {
		t.Fatalf("sql.render deixou de ser JSON: %v\n%s", err, out)
	}
	if payload.Dialect != "postgres" {
		t.Fatalf("dialeto ecoado errado: %q", payload.Dialect)
	}
	requireContains(t, payload.SQL,
		`CREATE TABLE "users"`,
		`"created_at" timestamptz NOT NULL DEFAULT now()`,
		`"profile" jsonb`,
		`PRIMARY KEY ("id")`,
		`UNIQUE ("email")`)
	// NOT NULL é o padrão sem `nullable: true` — a coluna opcional não pode sair marcada.
	requireAbsent(t, payload.SQL, `"profile" jsonb NOT NULL`)
}

func TestSqlRenderMapeiaTiposPorDialeto(t *testing.T) {
	// Um caso por dialeto, com os três tipos que mais divergem entre bancos.
	// serial/uuid/jsonb iguais em todo lugar é o sintoma do bug antigo: o tipo
	// saía cru e o schema só rodava no banco em que foi pensado.
	cases := []struct {
		dialect string
		wanted  []string
	}{
		{"postgres", []string{`"id" serial`, `"id" uuid`, `"profile" jsonb`}},
		{"mysql", []string{"`id` INT AUTO_INCREMENT", "`id` CHAR(36)", "`profile` JSON"}},
		{"sqlite", []string{`"id" INTEGER`, `"id" TEXT`, `"profile" TEXT`}},
		{"mssql", []string{`[id] INT IDENTITY(1,1)`, `[id] UNIQUEIDENTIFIER`, `[profile] NVARCHAR(MAX)`}},
		{"ansi", []string{`"id" INTEGER`, `"id" CHAR(36)`, `"profile" VARCHAR(4000)`}},
	}
	box := &Toolbox{}
	for _, item := range cases {
		sql := renderedSQL(t, callDataTool(t, box.sqlRender, lojaArgs(item.dialect)))
		requireContains(t, sql, item.wanted...)
	}
}

func TestSqlRenderTraduzDefaultNow(t *testing.T) {
	cases := map[string]string{
		"postgres": "DEFAULT now()",
		"mysql":    "DEFAULT CURRENT_TIMESTAMP",
		"sqlite":   "DEFAULT CURRENT_TIMESTAMP",
		"ansi":     "DEFAULT CURRENT_TIMESTAMP",
		"mssql":    "DEFAULT SYSUTCDATETIME()",
	}
	box := &Toolbox{}
	for dialect, wanted := range cases {
		sql := renderedSQL(t, callDataTool(t, box.sqlRender, lojaArgs(dialect)))
		requireContains(t, sql, wanted)
	}
}

func TestSqlRenderFkComAcoesReferenciais(t *testing.T) {
	box := &Toolbox{}
	sql := renderedSQL(t, callDataTool(t, box.sqlRender, lojaArgs("postgres")))
	requireContains(t, sql,
		`ALTER TABLE "orders" ADD CONSTRAINT "fk_orders_user_id" FOREIGN KEY ("user_id") `+
			`REFERENCES "users" ("id") ON UPDATE CASCADE ON DELETE SET NULL;`)
}

func TestSqlRenderIgnoraAcaoReferencialInvalida(t *testing.T) {
	// Ação desconhecida não pode virar "ON DELETE cascata" no meio do script:
	// ela some e a FK sai válida.
	args := `{"dialect": "postgres", "schema": {"name": "app", "tables": [
	  {"name": "a", "fields": [{"name": "id", "type": "uuid", "primaryKey": true}]},
	  {"name": "b", "fields": [
	    {"name": "id", "type": "uuid", "primaryKey": true},
	    {"name": "a_id", "type": "uuid", "references": {"table": "a", "field": "id"}}
	  ]}],
	  "relations": [{"fromTable": "b", "fromField": "a_id", "toTable": "a", "toField": "id", "onDelete": "cascata"}]
	}}`
	box := &Toolbox{}
	sql := renderedSQL(t, callDataTool(t, box.sqlRender, args))
	requireContains(t, sql, `REFERENCES "a" ("id");`)
	requireAbsent(t, sql, "cascata", "ON DELETE")
}

func TestSqlRenderGeraJuncaoParaNaN(t *testing.T) {
	box := &Toolbox{}
	sql := renderedSQL(t, callDataTool(t, box.sqlRender, lojaArgs("postgres")))
	// A junção nasce com a PK dos dois lados, e serial NÃO herda o
	// auto-incremento na coluna de FK — vira o inteiro simples.
	requireContains(t, sql,
		`CREATE TABLE "users_tags"`,
		`"users_id" integer NOT NULL`,
		`"tags_id" integer NOT NULL`,
		`PRIMARY KEY ("users_id", "tags_id")`,
		`ALTER TABLE "users_tags" ADD CONSTRAINT "fk_users_tags_users_id"`,
		`ALTER TABLE "users_tags" ADD CONSTRAINT "fk_users_tags_tags_id"`)
}

func TestSqlRenderCreateIndex(t *testing.T) {
	box := &Toolbox{}
	sql := renderedSQL(t, callDataTool(t, box.sqlRender, lojaArgs("postgres")))
	requireContains(t, sql,
		`CREATE UNIQUE INDEX "ux_users_email" ON "users" ("email");`,
		`CREATE INDEX "idx_orders_user_id" ON "orders" ("user_id");`)
	// O índice sobre campo inexistente não pode virar CREATE INDEX quebrado.
	requireAbsent(t, sql, "fantasma")
}

func TestSqlRenderCitacaoPorDialeto(t *testing.T) {
	box := &Toolbox{}
	mysql := renderedSQL(t, callDataTool(t, box.sqlRender, lojaArgs("mysql")))
	requireContains(t, mysql, "CREATE TABLE `users`", ") ENGINE=InnoDB;")

	mssql := renderedSQL(t, callDataTool(t, box.sqlRender, lojaArgs("mssql")))
	requireContains(t, mssql, "CREATE TABLE [users]", "ALTER TABLE [orders] ADD CONSTRAINT [fk_orders_user_id]")
}

func TestSqlRenderNormalizaDialeto(t *testing.T) {
	box := &Toolbox{}
	// "sqlserver" é como muita gente chama o mssql — apelido resolve.
	out := callDataTool(t, box.sqlRender, lojaArgs("sqlserver"))
	requireContains(t, out, `"dialect": "mssql"`)
	requireContains(t, renderedSQL(t, out), "[users]")

	// Dialeto desconhecido cai em ANSI e o resultado DIZ isso — ecoar "oracle"
	// por cima de tipos genéricos seria mentir para a tela e para o modelo.
	out = callDataTool(t, box.sqlRender, lojaArgs("oracle"))
	requireContains(t, out, `"dialect": "ansi"`)
}

func TestSqlRenderEntradaAntigaContinuaValendo(t *testing.T) {
	// O shape que o modelo mandava ANTES da ampliação (sem relations/indexes)
	// tem de continuar rendendo DDL — quebrar a entrada custaria toda conversa
	// em andamento que já aprendeu a chamar a ferramenta.
	args := `{"dialect": "postgres", "schema": {"name": "app", "tables": [
	  {"name": "notas", "fields": [
	    {"name": "id", "type": "uuid", "primaryKey": true},
	    {"name": "texto", "type": "text", "nullable": true}
	  ]}]}}`
	box := &Toolbox{}
	sql := renderedSQL(t, callDataTool(t, box.sqlRender, args))
	requireContains(t, sql, `CREATE TABLE "notas"`, `"id" uuid NOT NULL`, `PRIMARY KEY ("id")`)
}

func TestSqlRenderRecusaSchemaVazio(t *testing.T) {
	box := &Toolbox{}
	if _, err := box.sqlRender(context.Background(), "s", json.RawMessage(`{"dialect": "postgres"}`)); err == nil {
		t.Fatal("esperava recusa de schema sem tabela")
	}
}

/* ------------------------------ schema.export ---------------------------- */

// exportPayload espelha o contrato de saída de schema.export nos testes.
type exportPayload struct {
	Dialect string `json:"dialect"`
	Tables  []struct {
		Name   string `json:"name"`
		Fields []struct {
			Name     string `json:"name"`
			Type     string `json:"type"`
			Pk       bool   `json:"pk"`
			Fk       bool   `json:"fk"`
			Nullable bool   `json:"nullable"`
			Default  string `json:"default"`
		} `json:"fields"`
	} `json:"tables"`
	Relations []struct {
		From       string `json:"from"`
		FromColumn string `json:"fromColumn"`
		To         string `json:"to"`
		ToColumn   string `json:"toColumn"`
		Kind       string `json:"kind"`
	} `json:"relations"`
	Indexes []struct {
		Table  string   `json:"table"`
		Fields []string `json:"fields"`
		Unique bool     `json:"unique"`
	} `json:"indexes"`
	SQL string `json:"sql"`
	Erd string `json:"erd"`
}

func exportLoja(t *testing.T, args string) (exportPayload, string) {
	t.Helper()
	box := &Toolbox{}
	out := callDataTool(t, box.schemaExport, args)
	var payload exportPayload
	if err := json.Unmarshal([]byte(out), &payload); err != nil {
		t.Fatalf("schema.export deixou de ser JSON: %v\n%s", err, out)
	}
	return payload, out
}

func TestSchemaExportEmiteJsonQueATelaAceita(t *testing.T) {
	payload, out := exportLoja(t, lojaArgs("postgres"))

	if payload.Dialect != "postgres" {
		t.Fatalf("dialeto errado: %q", payload.Dialect)
	}
	if len(payload.Tables) != 3 {
		t.Fatalf("esperava 3 tabelas (a junção NÃO entra no diagrama), obtive %d", len(payload.Tables))
	}
	for _, table := range payload.Tables {
		if table.Name == "users_tags" {
			t.Fatal("a tabela de junção é derivada do SQL, não faz parte do documento")
		}
	}

	users := payload.Tables[0]
	if users.Fields[0].Name != "id" || !users.Fields[0].Pk {
		t.Fatalf("users.id deveria sair com pk=true: %+v", users.Fields[0])
	}
	if users.Fields[2].Name != "profile" || !users.Fields[2].Nullable {
		t.Fatalf("users.profile deveria sair nullable=true: %+v", users.Fields[2])
	}
	if users.Fields[3].Default != "now()" {
		t.Fatalf("o default sai LÓGICO (now()), a tradução mora no SQL: %+v", users.Fields[3])
	}
	orders := payload.Tables[1]
	if orders.Fields[1].Name != "user_id" || !orders.Fields[1].Fk {
		t.Fatalf("orders.user_id deveria sair com fk=true: %+v", orders.Fields[1])
	}

	if len(payload.Relations) != 2 {
		t.Fatalf("esperava 2 relações, obtive %d: %+v", len(payload.Relations), payload.Relations)
	}
	fk := payload.Relations[0]
	if fk.From != "orders" || fk.To != "users" || fk.FromColumn != "user_id" || fk.ToColumn != "id" {
		t.Fatalf("relação da FK com pontas erradas: %+v", fk)
	}
	// A FK comum se lê "n-1" nas pontas: muitos pedidos para um usuário.
	if fk.Kind != "n-1" {
		t.Fatalf("kind da FK deveria ser n-1, veio %q", fk.Kind)
	}
	if payload.Relations[1].Kind != "n-n" {
		t.Fatalf("a relação declarada n-n tem de chegar n-n na tela: %+v", payload.Relations[1])
	}

	if len(payload.Indexes) != 2 {
		t.Fatalf("esperava 2 índices válidos (o órfão cai), obtive %d", len(payload.Indexes))
	}
	if !payload.Indexes[0].Unique || payload.Indexes[0].Table != "users" {
		t.Fatalf("índice único de users.email perdido: %+v", payload.Indexes[0])
	}
	if payload.SQL == "" {
		t.Fatal("schema.export deve levar o SQL junto — uma chamada enche os dois painéis")
	}

	// As CHAVES do JSON são o contrato com o parse() da tela: a struct pode
	// estar certa com a tag errada, e só o texto serializado denuncia.
	requireContains(t, out,
		`"pk": true`, `"fk": true`, `"nullable": false`, `"nullable": true`,
		`"kind": "n-1"`, `"fromColumn": "user_id"`, `"toColumn": "id"`,
		`"default": "now()"`)
}

func TestSchemaExportKindPorCardinalidade(t *testing.T) {
	args := `{"dialect": "postgres", "schema": {"name": "app", "tables": [
	  {"name": "a", "fields": [{"name": "id", "type": "uuid", "primaryKey": true},
	    {"name": "b_id", "type": "uuid", "references": {"table": "b", "field": "id"}}]},
	  {"name": "b", "fields": [{"name": "id", "type": "uuid", "primaryKey": true}]}],
	  "relations": [{"fromTable": "a", "fromField": "b_id", "toTable": "b", "toField": "id", "cardinality": "1-1"}]
	}}`
	payload, _ := exportLoja(t, args)
	if len(payload.Relations) != 1 || payload.Relations[0].Kind != "1-1" {
		t.Fatalf("cardinalidade 1-1 declarada na relação tem de vencer o padrão: %+v", payload.Relations)
	}
}

func TestSchemaExportListasVaziasSaoListas(t *testing.T) {
	// [] em vez de null: null em contrato é pergunta que todo consumidor refaz.
	args := `{"dialect": "postgres", "schema": {"name": "app", "tables": [
	  {"name": "t", "fields": [{"name": "id", "type": "uuid", "primaryKey": true}]}]}}`
	_, out := exportLoja(t, args)
	requireContains(t, out, `"relations": []`, `"indexes": []`)
	requireAbsent(t, out, `"relations": null`, `"indexes": null`)
}

func TestSchemaExportFormatErdIncluiDiagramaTextual(t *testing.T) {
	args := strings.Replace(lojaArgs("postgres"), `"schema": {`, `"format": "erd", "schema": {`, 1)
	payload, _ := exportLoja(t, args)
	if payload.Erd == "" {
		t.Fatal("format erd deveria incluir o diagrama textual")
	}
	requireContains(t, payload.Erd, "┌─ users", "⇒ users.id", "índice único: email")
	// Mesmo pedindo o ERD textual, o JSON estruturado continua — é ele que a
	// tela desenha; o ASCII é só para quem lê o chat.
	if len(payload.Tables) != 3 {
		t.Fatalf("format erd não pode suprimir as tabelas do JSON: %d", len(payload.Tables))
	}
}

func TestSchemaExportRecusaSchemaVazio(t *testing.T) {
	box := &Toolbox{}
	if _, err := box.schemaExport(context.Background(), "s", json.RawMessage(`{}`)); err == nil {
		t.Fatal("esperava recusa de schema sem tabela")
	}
}
