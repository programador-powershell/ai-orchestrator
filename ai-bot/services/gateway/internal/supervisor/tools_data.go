// Ferramentas de DADOS: schema → DDL multi-dialeto e export estruturado.
//
// Este arquivo existe porque a tela de Dados (SchemaSurface) desenha o ERD a
// partir do tool.result — no AI-BOT não há documento compartilhado nem canal de
// operações como no orquestrador, então o CONTRATO é o JSON do resultado:
// `schema.export` devolve {tables, relations, indexes, dialect, sql} no formato
// exato que o parse() da tela aceita, e `sql.render` devolve {sql, dialect}.
// Texto plano aqui era uma tela para sempre vazia — foi assim até agora.
//
// O motor de DDL é um porte do exportSql do orquestrador
// (apps/desktop/src/lib/schema.ts): mapa de tipos por dialeto, DEFAULT now()
// traduzido, tabela de junção para n-n, FK com ON UPDATE/ON DELETE e
// CREATE [UNIQUE] INDEX. Portado, não reinventado — cada regra ali nasceu de um
// DDL que quebrou em algum banco de verdade.
package supervisor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

/* ------------------------------ documento ------------------------------- */

// schemaRef é o alvo de uma chave estrangeira declarada no próprio campo.
type schemaRef struct {
	Table string `json:"table"`
	Field string `json:"field"`
}

type schemaField struct {
	Name       string     `json:"name"`
	Type       string     `json:"type"`
	PrimaryKey bool       `json:"primaryKey"`
	Unique     bool       `json:"unique"`
	Nullable   bool       `json:"nullable"`
	Default    string     `json:"defaultValue"`
	References *schemaRef `json:"references"`
}

type schemaTable struct {
	Name   string        `json:"name"`
	Fields []schemaField `json:"fields"`
}

// schemaRelation é a relação vista do lado que GUARDA a chave (fromTable é a
// filha). É o mesmo shape do SchemaRelation do orquestrador; as ações
// referenciais e a cardinalidade moram aqui — e não no campo — porque n-n não
// tem coluna de FK: a relação existe antes da coluna.
type schemaRelation struct {
	FromTable   string `json:"fromTable"`
	FromField   string `json:"fromField"`
	ToTable     string `json:"toTable"`
	ToField     string `json:"toField"`
	Cardinality string `json:"cardinality"`
	OnUpdate    string `json:"onUpdate"`
	OnDelete    string `json:"onDelete"`
}

type schemaIndex struct {
	Table  string   `json:"table"`
	Fields []string `json:"fields"`
	Unique bool     `json:"unique"`
}

// schemaDoc é a ENTRADA das duas ferramentas. `relations` e `indexes` são
// ampliações opcionais: todo schema que o modelo já mandava (só name+tables)
// continua válido — quebrar a chamada de quem só conhece o formato antigo
// custaria toda conversa em andamento.
type schemaDoc struct {
	Name      string           `json:"name"`
	Tables    []schemaTable    `json:"tables"`
	Relations []schemaRelation `json:"relations"`
	Indexes   []schemaIndex    `json:"indexes"`
	Dialect   string           `json:"dialect"`
}

/* ------------------------------- dialeto -------------------------------- */

// normalizeDialect resolve apelidos e escolhe entre o dialeto pedido e o
// declarado no documento. Desconhecido vira "ansi" — e o resultado DIZ que
// virou: ecoar "oracle" por cima de tipos de outro banco seria mentir duas
// vezes, no chip da tela e no comentário do DDL.
func normalizeDialect(requested, declared string) string {
	for _, candidate := range []string{requested, declared} {
		trimmed := strings.ToLower(strings.TrimSpace(candidate))
		if trimmed == "" {
			continue
		}
		switch trimmed {
		case "postgres", "postgresql", "pg":
			return "postgres"
		case "mysql", "mariadb":
			return "mysql"
		case "sqlite", "sqlite3":
			return "sqlite"
		case "mssql", "sqlserver", "sql server", "sql-server":
			return "mssql"
		case "ansi", "sql":
			return "ansi"
		}
		return "ansi"
	}
	return "postgres"
}

// typeMap é o TYPE_MAP do orquestrador: o tipo "lógico" do documento vira o
// tipo nativo de cada banco. É o coração do export — sem ele um schema com
// `serial` sai igual em cinco bancos e só roda em um.
var typeMap = map[string]map[string]string{
	"postgres": {
		"uuid": "uuid", "text": "text", "varchar": "varchar(255)",
		"int": "integer", "integer": "integer", "bigint": "bigint",
		"serial": "serial", "boolean": "boolean",
		"timestamptz": "timestamptz", "timestamp": "timestamp", "date": "date",
		"jsonb": "jsonb", "json": "jsonb",
		"numeric": "numeric(18,6)", "float": "double precision",
	},
	"mysql": {
		"uuid": "CHAR(36)", "text": "TEXT", "varchar": "VARCHAR(255)",
		"int": "INT", "integer": "INT", "bigint": "BIGINT",
		"serial": "INT AUTO_INCREMENT", "boolean": "TINYINT(1)",
		"timestamptz": "DATETIME", "timestamp": "DATETIME", "date": "DATE",
		"jsonb": "JSON", "json": "JSON",
		"numeric": "DECIMAL(18,6)", "float": "DOUBLE",
	},
	"ansi": {
		"uuid": "CHAR(36)", "text": "VARCHAR(4000)", "varchar": "VARCHAR(255)",
		"int": "INTEGER", "integer": "INTEGER", "bigint": "BIGINT",
		"serial": "INTEGER", "boolean": "SMALLINT",
		"timestamptz": "TIMESTAMP", "timestamp": "TIMESTAMP", "date": "DATE",
		"jsonb": "VARCHAR(4000)", "json": "VARCHAR(4000)",
		"numeric": "NUMERIC(18,6)", "float": "DOUBLE PRECISION",
	},
	"sqlite": {
		// SQLite tem afinidade de tipos: sem UUID/BOOLEAN nativos, tudo cai em
		// TEXT/INTEGER — declarar "uuid" funcionaria por afinidade, mas mentiria
		// sobre o que o banco realmente guarda.
		"uuid": "TEXT", "text": "TEXT", "varchar": "VARCHAR(255)",
		"int": "INTEGER", "integer": "INTEGER", "bigint": "INTEGER",
		"serial": "INTEGER", "boolean": "INTEGER",
		"timestamptz": "DATETIME", "timestamp": "DATETIME", "date": "DATE",
		"jsonb": "TEXT", "json": "TEXT",
		"numeric": "NUMERIC", "float": "REAL",
	},
	"mssql": {
		"uuid": "UNIQUEIDENTIFIER", "text": "NVARCHAR(MAX)", "varchar": "NVARCHAR(255)",
		"int": "INT", "integer": "INT", "bigint": "BIGINT",
		"serial": "INT IDENTITY(1,1)", "boolean": "BIT",
		"timestamptz": "DATETIME2", "timestamp": "DATETIME2", "date": "DATE",
		"jsonb": "NVARCHAR(MAX)", "json": "NVARCHAR(MAX)",
		"numeric": "DECIMAL(18,6)", "float": "FLOAT",
	},
}

func mapType(fieldType, dialect string) string {
	key := strings.ToLower(strings.TrimSpace(fieldType))
	if mapped, ok := typeMap[dialect][key]; ok {
		return mapped
	}
	// Tipo que não conhecemos passa cru: quem escreveu "geography(Point)" sabia
	// o que pediu, e traduzir para um chute seria pior que não traduzir.
	return fieldType
}

// referenceableInt é a base inteira "referenciável" por dialeto — para coluna
// de FK que aponta uma PK serial.
var referenceableInt = map[string]struct{ serial, bigserial string }{
	"postgres": {"integer", "bigint"},
	"mysql":    {"INT", "BIGINT"},
	"ansi":     {"INTEGER", "BIGINT"},
	"sqlite":   {"INTEGER", "INTEGER"},
	"mssql":    {"INT", "BIGINT"},
}

// referenceableType dá o tipo de uma coluna que REFERENCIA a PK dada. Coluna de
// FK nunca pode herdar o auto-incremento (serial → IDENTITY/AUTO_INCREMENT):
// isso gera DDL inválido — dois auto-incremento na mesma tabela em mysql/mssql.
func referenceableType(fieldType, dialect string) string {
	key := strings.ToLower(strings.TrimSpace(fieldType))
	if base, ok := referenceableInt[dialect]; ok {
		if key == "serial" {
			return base.serial
		}
		if key == "bigserial" {
			return base.bigserial
		}
	}
	return mapType(orDefault(fieldType, "text"), dialect)
}

// mapDefault traduz o DEFAULT now() — o jeito mais comum de carimbar linha —
// para o relógio de cada banco. Qualquer outro default passa intocado: default
// é expressão do dono, não nossa.
func mapDefault(value, dialect string) string {
	if dialect == "postgres" || strings.ToLower(value) != "now()" {
		return value
	}
	if dialect == "mssql" {
		return "SYSUTCDATETIME()"
	}
	return "CURRENT_TIMESTAMP"
}

// quote aplica a citação do dialeto. Não é detalhe: uma coluna chamada `order`
// sem citação quebra no Postgres e passa no MySQL, e o schema "funciona" até o
// dia em que alguém troca de banco.
func quote(dialect, identifier string) string {
	switch dialect {
	case "mysql":
		return "`" + strings.ReplaceAll(identifier, "`", "``") + "`"
	case "mssql":
		return "[" + strings.ReplaceAll(identifier, "]", "]]") + "]"
	}
	return `"` + strings.ReplaceAll(identifier, `"`, `""`) + `"`
}

/* --------------------------------- DDL ---------------------------------- */

// columnDDL monta a linha de uma coluna: nome, tipo mapeado, NULL e DEFAULT.
// Sem `nullable: true` explícito a coluna é NOT NULL — a mesma convenção do
// orquestrador, para o mesmo schema não mudar de significado entre os apps.
func columnDDL(field schemaField, dialect string) string {
	line := quote(dialect, field.Name) + " " + mapType(orDefault(field.Type, "text"), dialect)
	if !field.Nullable {
		line += " NOT NULL"
	}
	if field.Default != "" {
		line += " DEFAULT " + mapDefault(field.Default, dialect)
	}
	return line
}

func tableTail(dialect string) string {
	if dialect == "mysql" {
		// ENGINE explícito porque MyISAM aceita a sintaxe de FK e a ignora em
		// silêncio — o schema parece íntegro até a primeira órfã.
		return ") ENGINE=InnoDB;"
	}
	return ");"
}

func renderCreateTable(table schemaTable, dialect string) string {
	lines := make([]string, 0, len(table.Fields)+2)
	var primary []string
	for _, field := range table.Fields {
		lines = append(lines, "  "+columnDDL(field, dialect))
		if field.PrimaryKey {
			primary = append(primary, quote(dialect, field.Name))
		}
	}
	if len(primary) > 0 {
		lines = append(lines, "  PRIMARY KEY ("+strings.Join(primary, ", ")+")")
	}
	for _, field := range table.Fields {
		if field.Unique && !field.PrimaryKey {
			lines = append(lines, "  UNIQUE ("+quote(dialect, field.Name)+")")
		}
	}
	return "CREATE TABLE " + quote(dialect, table.Name) + " (\n" + strings.Join(lines, ",\n") + "\n" + tableTail(dialect)
}

// normalizeFkAction valida a ação referencial. Ação desconhecida some em vez de
// virar DDL inválido: "ON DELETE cascata" quebraria o script inteiro por causa
// de uma palavra.
func normalizeFkAction(value string) string {
	action := strings.ToUpper(strings.Join(strings.Fields(value), " "))
	switch action {
	case "CASCADE", "RESTRICT", "SET NULL", "NO ACTION":
		return action
	}
	return ""
}

func renderAddFK(table, field, refTable, refField, dialect string, relation *schemaRelation) string {
	sql := fmt.Sprintf("ALTER TABLE %s ADD CONSTRAINT %s FOREIGN KEY (%s) REFERENCES %s (%s)",
		quote(dialect, table),
		quote(dialect, "fk_"+table+"_"+field),
		quote(dialect, field),
		quote(dialect, refTable),
		quote(dialect, orDefault(refField, "id")))
	if relation != nil {
		// Ordem canônica ON UPDATE → ON DELETE, a mesma do orquestrador: DDL
		// estável se compara no git; DDL que troca a ordem sozinho vira diff falso.
		if action := normalizeFkAction(relation.OnUpdate); action != "" {
			sql += " ON UPDATE " + action
		}
		if action := normalizeFkAction(relation.OnDelete); action != "" {
			sql += " ON DELETE " + action
		}
	}
	return sql + ";"
}

// relKey identifica uma relação pelos quatro cantos. O separador é \x00 porque
// nome de tabela pode conter "_" e "." — qualquer separador imprimível colide.
func relKey(fromTable, fromField, toTable, toField string) string {
	return fromTable + "\x00" + fromField + "\x00" + toTable + "\x00" + toField
}

func relationIndex(doc schemaDoc) map[string]*schemaRelation {
	index := make(map[string]*schemaRelation, len(doc.Relations))
	for i := range doc.Relations {
		relation := &doc.Relations[i]
		index[relKey(relation.FromTable, relation.FromField, relation.ToTable, relation.ToField)] = relation
	}
	return index
}

// normalizeCardinality reduz ao vocabulário do documento. O padrão é "1-n" —
// a FK comum — porque é o que uma relação sem rótulo quase sempre é.
func normalizeCardinality(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1-1":
		return "1-1"
	case "n-n", "m-n", "n-m":
		return "n-n"
	}
	return "1-n"
}

// primaryKeyField acha a PK para a junção referenciar; sem PK declarada cai no
// primeiro campo — melhor uma FK para a coluna errada, visível e corrigível,
// do que uma junção sem integridade nenhuma.
func primaryKeyField(table schemaTable) schemaField {
	for _, field := range table.Fields {
		if field.PrimaryKey {
			return field
		}
	}
	if len(table.Fields) > 0 {
		return table.Fields[0]
	}
	return schemaField{Name: "id", Type: "uuid"}
}

// renderJunctionTables materializa as relações n-n: `<a>_<b>` com uma FK para a
// PK de cada lado e PK composta. A relação n-n NÃO vira FK direta — não existe
// coluna capaz de guardá-la; quem tenta acaba com um array de ids em texto.
func renderJunctionTables(doc schemaDoc, dialect string) (creates, fks []string) {
	byName := make(map[string]schemaTable, len(doc.Tables))
	for _, table := range doc.Tables {
		byName[table.Name] = table
	}
	seen := make(map[string]bool)
	for _, relation := range doc.Relations {
		if normalizeCardinality(relation.Cardinality) != "n-n" {
			continue
		}
		a, okA := byName[relation.FromTable]
		b, okB := byName[relation.ToTable]
		if !okA || !okB {
			continue
		}
		name := a.Name + "_" + b.Name
		if seen[name] {
			continue
		}
		seen[name] = true
		pkA := primaryKeyField(a)
		pkB := primaryKeyField(b)
		colA := a.Name + "_" + pkA.Name
		colB := b.Name + "_" + pkB.Name
		if colA == colB {
			// Auto-relação n-n (pessoa segue pessoa): duas colunas não podem ter
			// o mesmo nome, então o segundo lado ganha sufixo.
			colB += "_2"
		}
		lines := []string{
			"  " + quote(dialect, colA) + " " + referenceableType(pkA.Type, dialect) + " NOT NULL",
			"  " + quote(dialect, colB) + " " + referenceableType(pkB.Type, dialect) + " NOT NULL",
			"  PRIMARY KEY (" + quote(dialect, colA) + ", " + quote(dialect, colB) + ")",
		}
		creates = append(creates, "CREATE TABLE "+quote(dialect, name)+" (\n"+strings.Join(lines, ",\n")+"\n"+tableTail(dialect))
		fks = append(fks,
			renderAddFK(name, colA, a.Name, pkA.Name, dialect, nil),
			renderAddFK(name, colB, b.Name, pkB.Name, dialect, nil))
	}
	return creates, fks
}

// validIndexes filtra os índices cujo alvo inteiro (tabela e todos os campos)
// existe no documento. Índice órfão não vira CREATE INDEX quebrado nem entra no
// JSON da tela — ele simplesmente não é um índice deste schema.
func validIndexes(doc schemaDoc) []schemaIndex {
	byName := make(map[string]schemaTable, len(doc.Tables))
	for _, table := range doc.Tables {
		byName[table.Name] = table
	}
	var valid []schemaIndex
	for _, index := range doc.Indexes {
		table, ok := byName[index.Table]
		if !ok || len(index.Fields) == 0 {
			continue
		}
		complete := true
		for _, name := range index.Fields {
			found := false
			for _, field := range table.Fields {
				if field.Name == name {
					found = true
					break
				}
			}
			if !found {
				complete = false
				break
			}
		}
		if complete {
			valid = append(valid, index)
		}
	}
	return valid
}

// indexName é determinístico (ux_/idx_ + tabela + campos) — o mesmo do
// orquestrador, para a migração de lá conseguir dar DROP no índice de cá.
func indexName(index schemaIndex) string {
	prefix := "idx"
	if index.Unique {
		prefix = "ux"
	}
	return prefix + "_" + index.Table + "_" + strings.Join(index.Fields, "_")
}

func renderCreateIndex(index schemaIndex, dialect string) string {
	unique := ""
	if index.Unique {
		unique = "UNIQUE "
	}
	quoted := make([]string, len(index.Fields))
	for i, field := range index.Fields {
		quoted[i] = quote(dialect, field)
	}
	return fmt.Sprintf("CREATE %sINDEX %s ON %s (%s);",
		unique, quote(dialect, indexName(index)), quote(dialect, index.Table), strings.Join(quoted, ", "))
}

// renderSQL monta o script completo: CREATE TABLE na ordem do documento,
// junções das n-n, FKs em ALTER e por fim os índices.
func renderSQL(doc schemaDoc, dialect string) string {
	dialect = normalizeDialect(dialect, doc.Dialect)
	statements := []string{
		"-- Esquema: " + orDefault(doc.Name, "schema"),
		"-- Dialeto: " + dialect,
		"",
	}
	relations := relationIndex(doc)

	for _, table := range doc.Tables {
		statements = append(statements, renderCreateTable(table, dialect), "")
	}

	junctionCreates, junctionFKs := renderJunctionTables(doc, dialect)
	for _, create := range junctionCreates {
		statements = append(statements, create, "")
	}

	// Chave estrangeira sai em ALTER depois de todas as tabelas: emitir a
	// referência dentro do CREATE obriga a ordenar as tabelas topologicamente, e
	// um ciclo de referência (que é legítimo) não teria ordem nenhuma. A ordem é
	// a do documento (tabela → campo), estável entre execuções — um schema.sql
	// comparado no git não pode dançar sozinho.
	var fks []string
	for _, table := range doc.Tables {
		for _, field := range table.Fields {
			if field.References == nil || field.References.Table == "" {
				continue
			}
			relation := relations[relKey(table.Name, field.Name, field.References.Table, field.References.Field)]
			if relation != nil && normalizeCardinality(relation.Cardinality) == "n-n" {
				continue // n-n é resolvida pela tabela de junção, não por FK direta
			}
			fks = append(fks, renderAddFK(table.Name, field.Name, field.References.Table, field.References.Field, dialect, relation))
		}
	}
	fks = append(fks, junctionFKs...)
	if len(fks) > 0 {
		statements = append(statements, fks...)
		statements = append(statements, "")
	}

	var indexes []string
	for _, index := range validIndexes(doc) {
		indexes = append(indexes, renderCreateIndex(index, dialect))
	}
	if len(indexes) > 0 {
		statements = append(statements, indexes...)
		statements = append(statements, "")
	}
	return strings.TrimRight(strings.Join(statements, "\n"), "\n") + "\n"
}

/* --------------------------- export estruturado -------------------------- */

// exportColumn usa os NOMES DE CHAVE que o parse() da SchemaSurface lê
// (pk/fk/nullable/default), não os do documento de entrada (primaryKey/…).
// São dois vocabulários de propósito: a entrada espelha o SchemaDoc do
// orquestrador; a saída espelha a tela.
type exportColumn struct {
	Name string `json:"name"`
	// O tipo sai LÓGICO (uuid, serial…), não o mapeado: o diagrama é neutro de
	// dialeto — o tipo nativo mora no SQL, que carrega o dialeto junto.
	Type string `json:"type"`
	Pk   bool   `json:"pk,omitempty"`
	Fk   bool   `json:"fk,omitempty"`
	// Sem omitempty: a tela só marca a coluna obrigatória quando vê
	// `nullable: false` EXPLÍCITO — omitir o campo apagaria o asterisco de toda
	// coluna NOT NULL do diagrama.
	Nullable bool   `json:"nullable"`
	Default  string `json:"default,omitempty"`
}

type exportTable struct {
	Name   string         `json:"name"`
	Fields []exportColumn `json:"fields"`
}

type exportRelation struct {
	From       string `json:"from"`
	FromColumn string `json:"fromColumn,omitempty"`
	To         string `json:"to"`
	ToColumn   string `json:"toColumn,omitempty"`
	Kind       string `json:"kind"`
}

type exportIndex struct {
	Table  string   `json:"table"`
	Fields []string `json:"fields"`
	Unique bool     `json:"unique,omitempty"`
}

// exportDoc é a SAÍDA de schema.export — o contrato com a SchemaSurface.
type exportDoc struct {
	Dialect   string           `json:"dialect"`
	Tables    []exportTable    `json:"tables"`
	Relations []exportRelation `json:"relations"`
	Indexes   []exportIndex    `json:"indexes"`
	SQL       string           `json:"sql"`
	Erd       string           `json:"erd,omitempty"`
}

// displayKind traduz a cardinalidade do documento (vista do lado que guarda a
// FK) para o rótulo que a tela imprime nas pontas da linha. O "1-n" do
// documento é a FK comum — MUITAS linhas de `from` para UMA de `to` —, e na
// ponta isso se escreve "n-1"; passar "1-n" adiante inverteria os rótulos no
// diagrama.
func displayKind(cardinality string) string {
	switch normalizeCardinality(cardinality) {
	case "1-1":
		return "1-1"
	case "n-n":
		return "n-n"
	}
	return "n-1"
}

func exportDocFor(schema schemaDoc, dialect string) exportDoc {
	// O badge FK sai da UNIÃO dos dois jeitos de declarar a relação: pelo
	// `references` do campo E pela lista `relations`. Sem a segunda fonte, uma
	// relação declarada só na lista desenhava a linha no diagrama mas deixava a
	// coluna sem o FK no cartão e no prompt do agente — a mesma informação
	// contada de dois jeitos diferentes na mesma tela.
	fkPorRelacao := make(map[string]bool)
	for _, relation := range schema.Relations {
		if relation.FromTable != "" && relation.FromField != "" {
			fkPorRelacao[relation.FromTable+"\x00"+relation.FromField] = true
		}
	}

	// Slices nascem alocadas para o JSON emitir [] em vez de null: a tela tolera
	// null, mas null em contrato é pergunta que todo consumidor futuro refaz.
	tables := make([]exportTable, 0, len(schema.Tables))
	for _, table := range schema.Tables {
		fields := make([]exportColumn, 0, len(table.Fields))
		for _, field := range table.Fields {
			fields = append(fields, exportColumn{
				Name: field.Name,
				Type: orDefault(field.Type, "text"),
				Pk:   field.PrimaryKey,
				Fk: (field.References != nil && field.References.Table != "") ||
					fkPorRelacao[table.Name+"\x00"+field.Name],
				Nullable: field.Nullable,
				Default:  field.Default,
			})
		}
		tables = append(tables, exportTable{Name: table.Name, Fields: fields})
	}

	// As relações saem da UNIÃO dos dois jeitos de declará-las: `references` no
	// campo (o jeito antigo, que continua valendo) e a lista `relations` (o
	// jeito novo, único capaz de dizer n-n). O relKey deduplica quem declarou
	// dos dois jeitos.
	index := relationIndex(schema)
	seen := make(map[string]bool)
	relations := make([]exportRelation, 0, len(schema.Relations))
	for _, table := range schema.Tables {
		for _, field := range table.Fields {
			if field.References == nil || field.References.Table == "" {
				continue
			}
			key := relKey(table.Name, field.Name, field.References.Table, field.References.Field)
			seen[key] = true
			cardinality := ""
			if relation := index[key]; relation != nil {
				cardinality = relation.Cardinality
			}
			relations = append(relations, exportRelation{
				From:       table.Name,
				FromColumn: field.Name,
				To:         field.References.Table,
				ToColumn:   orDefault(field.References.Field, "id"),
				Kind:       displayKind(cardinality),
			})
		}
	}
	for _, relation := range schema.Relations {
		key := relKey(relation.FromTable, relation.FromField, relation.ToTable, relation.ToField)
		if seen[key] || relation.FromTable == "" || relation.ToTable == "" {
			continue
		}
		seen[key] = true
		relations = append(relations, exportRelation{
			From:       relation.FromTable,
			FromColumn: relation.FromField,
			To:         relation.ToTable,
			ToColumn:   relation.ToField,
			Kind:       displayKind(relation.Cardinality),
		})
	}

	indexes := make([]exportIndex, 0, len(schema.Indexes))
	for _, item := range validIndexes(schema) {
		indexes = append(indexes, exportIndex{Table: item.Table, Fields: item.Fields, Unique: item.Unique})
	}

	return exportDoc{
		Dialect:   dialect,
		Tables:    tables,
		Relations: relations,
		Indexes:   indexes,
		// O SQL vai junto para /erd encher os DOIS painéis com uma chamada só —
		// sem ele o diagrama aparece e o painel de SQL fica pedindo /sql.
		SQL: renderSQL(schema, dialect),
	}
}

// marshalToolJSON serializa indentado: o resultado aparece no transcript da
// conversa e é lido por gente e por modelo antes de ser lido pela tela.
func marshalToolJSON(value any) (string, error) {
	payload, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return "", fmt.Errorf("serializar o resultado: %w", err)
	}
	return string(payload), nil
}

/* ------------------------------ ferramentas ------------------------------ */

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
	dialect := normalizeDialect(args.Dialect, args.Schema.Dialect)
	// O dialeto viaja junto com o SQL porque a tela compara os dois: é ele que
	// acende o chip e o botão "Gerar em X" quando o texto veio de outro banco.
	return marshalToolJSON(struct {
		SQL     string `json:"sql"`
		Dialect string `json:"dialect"`
	}{SQL: renderSQL(args.Schema, dialect), Dialect: dialect})
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
	dialect := normalizeDialect(args.Dialect, args.Schema.Dialect)
	doc := exportDocFor(args.Schema, dialect)
	// `format: "erd"` era o jeito antigo de pedir o diagrama em texto. O JSON
	// agora É o diagrama; o ASCII vira um campo extra, para quem lê o resultado
	// no chat — a tela o ignora.
	if strings.EqualFold(strings.TrimSpace(args.Format), "erd") {
		doc.Erd = renderERD(args.Schema)
	}
	return marshalToolJSON(doc)
}

// renderERD desenha o diagrama em texto. Existe porque um schema revisado no
// chat é lido, não executado — e ler CREATE TABLE para entender relação é o
// trabalho que o diagrama poupa.
func renderERD(doc schemaDoc) string {
	indexesByTable := make(map[string][]schemaIndex)
	for _, index := range validIndexes(doc) {
		indexesByTable[index.Table] = append(indexesByTable[index.Table], index)
	}

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
		for _, index := range indexesByTable[table.Name] {
			kind := "índice"
			if index.Unique {
				kind = "índice único"
			}
			fmt.Fprintf(&out, "│ # %s: %s\n", kind, strings.Join(index.Fields, ", "))
		}
		out.WriteString("└─\n\n")
	}
	return out.String()
}
