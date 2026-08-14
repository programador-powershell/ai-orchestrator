// Package specialist descreve QUEM o AI-BOT pode ser.
//
// No app anterior cada capacidade era uma ABA: dez telas, dez barras laterais,
// dez campos de texto. Trocar de capacidade era trocar de tela na mão, e a
// pessoa precisava saber de antemão em qual aba morava o que ela queria. Aqui
// as dez viram ESPECIALISTAS de um bot só: a tela é uma, o campo é um, e quem
// escolhe é o master a partir do que foi pedido.
//
// A definição abaixo é dado, não código: o mesmo registro alimenta o roteador
// (Triggers), o prompt do turno (System), a tela (Surface, Rail), o campo de
// texto (Placeholder, Actions), a permissão (Tools) e o desenho do bot
// (Avatar). Quando isso vivia espalhado — placeholder num mapa, ícone noutro,
// cor num CSS, ferramenta num terceiro — acrescentar capacidade significava
// lembrar de seis lugares, e o Fluxo passou versões com o placeholder de um
// campo que nem aparecia.
package specialist

// Surface é a forma que a tela única assume. A UI tem um componente por
// superfície; o especialista escolhe qual.
type Surface string

const (
	SurfaceConversation Surface = "conversation"
	SurfaceEditor       Surface = "editor"
	SurfaceDocument     Surface = "document"
	SurfaceCanvas       Surface = "canvas"
	SurfaceSchema       Surface = "schema"
	SurfaceBoard        Surface = "board"
	SurfaceFindings     Surface = "findings"
	SurfaceCrew         Surface = "crew"
	SurfaceFlow         Surface = "flow"
	SurfaceTrain        Surface = "train"
)

// RailKind é o que a barra lateral esquerda serve enquanto o especialista está
// ativo. A barra não some entre especialistas — ela troca de conteúdo.
type RailKind string

const (
	RailConversations RailKind = "conversations"
	RailFiles         RailKind = "files"
	RailDocument      RailKind = "document"
	RailLayers        RailKind = "layers"
	RailTables        RailKind = "tables"
	RailTasks         RailKind = "tasks"
	RailFindings      RailKind = "findings"
	RailCrew          RailKind = "crew"
	RailNodes         RailKind = "nodes"
	RailRuns          RailKind = "runs"
)

// Action é um atalho que aparece no composer quando o especialista está ativo.
// É a única pista visível de que o campo mudou de assunto.
type Action struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	// Insert é o texto colocado no campo. Termina em espaço quando a pessoa
	// ainda precisa completar a frase.
	Insert string `json:"insert"`
	Glyph  string `json:"glyph"`
}

// Avatar são os parâmetros PROCEDURAIS do bot — não um arquivo de imagem.
//
// Procedural porque cada especialista precisa de um retrato próprio e ninguém
// vai desenhar (nem versionar) onze PNGs por tema. Levantamento funcional do
// Bible Strong Avatar Lab (partes 2D compostas por parâmetro, expressão e
// animação, exportáveis como SVG) em docs/creditos-inspiracao.md — implementação
// própria, nenhum código ou asset de lá.
type Avatar struct {
	Seed      int    `json:"seed"`
	Shape     string `json:"shape"`     // orb | squircle | hex | shield | bloom | chip
	Eyes      string `json:"eyes"`      // dot | arc | visor | spark | scan | ring
	Mouth     string `json:"mouth"`     // none | line | smile | wave | grid
	Accessory string `json:"accessory"` // none | antenna | halo | bolt | glasses | crown | shield
	Motion    string `json:"motion"`    // idle | breathe | pulse | scan | orbit
	// Hue vem do especialista por padrão; o laboratório de avatares pode soltar
	// esta amarra sem mexer na cor do resto do app.
	Hue        int  `json:"hue"`
	Saturation int  `json:"saturation"`
	Custom     bool `json:"custom,omitempty"`
}

// Definition é o especialista completo.
type Definition struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Tagline string   `json:"tagline"`
	Glyph   string   `json:"glyph"`
	Hue     int      `json:"hue"`
	Surface Surface  `json:"surface"`
	Rail    RailKind `json:"rail"`

	// System é o prompt que define o comportamento. Entra SEMPRE depois do
	// prompt master do admin — trocar de especialista não pode ser a forma
	// barata de sair da política.
	System string `json:"system"`

	Placeholder string   `json:"placeholder"`
	NewLabel    string   `json:"newLabel"`
	Actions     []Action `json:"actions,omitempty"`

	// Tools são as ferramentas que ESTE especialista pode pedir. O supervisor
	// recusa qualquer outra: um especialista de documento que consegue rodar
	// processo é um especialista de execução com outro nome.
	Tools []string `json:"tools,omitempty"`

	// Triggers alimentam o classificador léxico do roteador. São radicais em
	// minúscula e sem acento — a normalização acontece no roteador.
	Triggers []string `json:"triggers,omitempty"`

	// PreferredSkills descrevem o que o modelo desta linha precisa saber fazer.
	// O Model Router casa isso com o catálogo; o usuário pode sobrepor.
	PreferredSkills []string `json:"preferredSkills,omitempty"`

	Avatar Avatar `json:"avatar"`
}

// MasterID é o roteador. Ele não tem superfície: existe entre o prompt e o
// especialista, e some assim que decide.
const MasterID = "master"

// DefaultID é para onde a conversa cai quando nada mais decide.
const DefaultID = "chat"

// Master é o primeiro a ler todo prompt de conversa nova.
var Master = Definition{
	ID:      MasterID,
	Name:    "AI-BOT",
	Tagline: "Lê o pedido e chama quem resolve",
	Glyph:   "bot",
	Hue:     158,
	Surface: SurfaceConversation,
	Rail:    RailConversations,
	System: "Você é o master do AI-BOT. Sua única tarefa é ler o pedido e dizer qual " +
		"especialista deve atendê-lo. Responda SOMENTE com um objeto JSON " +
		"{\"specialist\":\"<id>\",\"confidence\":<0..1>,\"why\":\"<motivo curto>\"}. " +
		"Não converse, não cumprimente, não resolva o pedido. Se o pedido couber em " +
		"mais de um especialista, escolha o que entrega o artefato final. Se não " +
		"houver sinal suficiente, use \"chat\" com confiança baixa.",
	Placeholder: "O que você quer fazer?",
	NewLabel:    "Nova conversa",
	Avatar: Avatar{
		Seed: 1, Shape: "orb", Eyes: "spark", Mouth: "none",
		Accessory: "halo", Motion: "breathe", Hue: 158, Saturation: 62,
	},
}

// catalog é a ordem em que os especialistas aparecem na UI.
var catalog = []Definition{
	{
		ID:      "chat",
		Name:    "Conversa",
		Tagline: "Pergunta, pesquisa e raciocínio",
		Glyph:   "chat",
		Hue:     158,
		Surface: SurfaceConversation,
		Rail:    RailConversations,
		System: "Você é o especialista de conversa e pesquisa do AI-BOT. Responda em " +
			"português do Brasil, direto ao ponto, sem preâmbulo. Separe o que você " +
			"sabe do que é hipótese. Quando pesquisar, cite a fonte. Quando o pedido " +
			"for de outra especialidade (código, documento, dados, segurança), diga " +
			"isso em uma linha em vez de improvisar.",
		Placeholder: "Pergunte, pesquise ou pense junto…",
		NewLabel:    "Nova conversa",
		Actions: []Action{
			{ID: "pesquisar", Label: "Pesquisar", Insert: "/pesquisar ", Glyph: "search"},
			{ID: "resumir", Label: "Resumir", Insert: "/resumir ", Glyph: "file"},
		},
		Tools:           []string{"web.search", "memory.read", "memory.write", "fs.read"},
		Triggers:        []string{"pergunt", "explic", "resum", "pesquis", "duvid", "o que e", "por que", "compar", "traduz", "escrev"},
		PreferredSkills: []string{"chat", "reasoning"},
		Avatar: Avatar{
			Seed: 11, Shape: "orb", Eyes: "dot", Mouth: "smile",
			Accessory: "none", Motion: "breathe", Hue: 158, Saturation: 62,
		},
	},
	{
		ID:      "code",
		Name:    "Código",
		Tagline: "Edita, roda e revisa o repositório",
		Glyph:   "code",
		Hue:     210,
		Surface: SurfaceEditor,
		Rail:    RailFiles,
		System: "Você é o especialista de código do AI-BOT. Leia antes de escrever: " +
			"nunca proponha mudança em arquivo que você não abriu. Siga o estilo do " +
			"código à volta (nomes, comentários, idioma). Entregue diff aplicável, não " +
			"trecho solto. Depois de editar, diga o que rodar para verificar. Se a " +
			"mudança quebrar contrato público, avise antes de fazer.",
		Placeholder: "Descreva a mudança de código…",
		NewLabel:    "Nova sessão",
		Actions: []Action{
			{ID: "review", Label: "Revisar", Insert: "/review ", Glyph: "review"},
			{ID: "explain", Label: "Explicar", Insert: "/explain ", Glyph: "explain"},
			{ID: "testgen", Label: "Testes", Insert: "/testgen ", Glyph: "testgen"},
		},
		Tools: []string{
			"fs.read", "fs.write", "fs.list", "fs.search", "fs.patch",
			"proc.run", "git.status", "git.diff", "git.commit", "term.open", "diagnostics.run",
		},
		Triggers:        []string{"codig", "funcao", "bug", "refator", "compil", "test", "build", "lint", "commit", "branch", "merge", "stack trace", "erro de", "implement", "classe", "metodo", "endpoint", "typescript", "python", "rust", "golang", "javascript"},
		PreferredSkills: []string{"code", "tools", "long-context"},
		Avatar: Avatar{
			Seed: 22, Shape: "squircle", Eyes: "visor", Mouth: "line",
			Accessory: "none", Motion: "scan", Hue: 210, Saturation: 62,
		},
	},
	{
		ID:      "office",
		Name:    "Documentos",
		Tagline: "DOCX, PPTX e PDF de verdade",
		Glyph:   "office",
		Hue:     26,
		Surface: SurfaceDocument,
		Rail:    RailDocument,
		System: "Você é o especialista de documentos do AI-BOT. Você altera o arquivo " +
			"BINÁRIO (DOCX/PPTX) e lê PDF — não devolve markdown fingindo ser " +
			"documento. Antes de alterar, descreva a alteração em uma linha e mostre " +
			"onde ela cai. Preserve estilo, numeração e sumário existentes: reescrever " +
			"o documento inteiro para mudar um parágrafo destrói formatação que a " +
			"pessoa levou horas montando.",
		Placeholder: "Diga o que quer alterar no arquivo…",
		NewLabel:    "Nova sessão",
		Actions: []Action{
			{ID: "abrir", Label: "Abrir", Insert: "/abrir ", Glyph: "file"},
			{ID: "substituir", Label: "Substituir", Insert: "/substituir ", Glyph: "diff"},
		},
		Tools:           []string{"fs.read", "fs.list", "office.open", "office.edit", "office.export", "pdf.extract"},
		Triggers:        []string{"docx", "pptx", "pdf", "document", "planilha", "slide", "apresenta", "word", "powerpoint", "sumario", "paragrafo", "cabecalho", "rodape", "contrato", "relatorio", "ata", "oficio"},
		PreferredSkills: []string{"chat", "long-context"},
		Avatar: Avatar{
			Seed: 33, Shape: "chip", Eyes: "arc", Mouth: "line",
			Accessory: "glasses", Motion: "idle", Hue: 26, Saturation: 62,
		},
	},
	{
		ID:      "design",
		Name:    "Design",
		Tagline: "Interface, tokens e réplica de layout",
		Glyph:   "design",
		Hue:     282,
		Surface: SurfaceCanvas,
		Rail:    RailLayers,
		System: "Você é o especialista de design do AI-BOT. Trabalhe em TOKENS " +
			"(cor, espaçamento, raio, tipo) antes de trabalhar em telas: valor solto " +
			"em componente vira dívida no segundo componente. Ao replicar um layout de " +
			"referência, extraia o sistema — não copie pixel. Verifique contraste " +
			"contra o fundo real, nos dois temas.",
		Placeholder: "Descreva a interface ou cole uma URL para replicar…",
		NewLabel:    "Nova sessão",
		Actions: []Action{
			{ID: "replicar", Label: "Replicar URL", Insert: "/replicar ", Glyph: "connect"},
			{ID: "tokens", Label: "Tokens", Insert: "/tokens ", Glyph: "design"},
		},
		Tools:           []string{"fs.read", "fs.write", "web.fetch", "design.replicate", "image.generate"},
		Triggers:        []string{"design", "interface", "layout", "tela", "componente", "css", "cor", "paleta", "tipografia", "figma", "mockup", "tema", "espacamento", "icone", "logo", "responsiv"},
		PreferredSkills: []string{"chat", "vision"},
		Avatar: Avatar{
			Seed: 44, Shape: "bloom", Eyes: "ring", Mouth: "wave",
			Accessory: "none", Motion: "orbit", Hue: 282, Saturation: 62,
		},
	},
	{
		ID:      "data",
		Name:    "Dados",
		Tagline: "Schema, ERD, SQL e migração",
		Glyph:   "data",
		Hue:     190,
		Surface: SurfaceSchema,
		Rail:    RailTables,
		System: "Você é o especialista de dados do AI-BOT. Antes de responder, deixe " +
			"explícitas as premissas (período, granularidade, filtros). Em SQL: CTEs " +
			"nomeadas, sem SELECT *, e uma linha dizendo o que cada etapa faz. Em " +
			"schema: chave, índice e integridade referencial antes de conveniência. " +
			"Nunca invente número que não esteja na fonte.",
		Placeholder: "Peça tabelas, relações ou migrações…",
		NewLabel:    "Novo schema",
		Actions: []Action{
			{ID: "erd", Label: "ERD", Insert: "/erd ", Glyph: "erd"},
			{ID: "sql", Label: "SQL", Insert: "/sql ", Glyph: "data"},
			{ID: "migrar", Label: "Migração", Insert: "/migrar ", Glyph: "diff"},
		},
		Tools:           []string{"fs.read", "fs.write", "schema.export", "sql.render", "memory.read"},
		Triggers:        []string{"tabela", "schema", "sql", "banco", "erd", "migracao", "postgres", "mysql", "consulta", "query", "indice", "chave estrangeira", "modelagem", "normaliza", "join", "coluna"},
		PreferredSkills: []string{"code", "chat"},
		Avatar: Avatar{
			Seed: 55, Shape: "hex", Eyes: "scan", Mouth: "grid",
			Accessory: "none", Motion: "pulse", Hue: 190, Saturation: 62,
		},
	},
	{
		ID:      "work",
		Name:    "Trabalho",
		Tagline: "Tarefas, automações e rotina",
		Glyph:   "work",
		Hue:     340,
		Surface: SurfaceBoard,
		Rail:    RailTasks,
		System: "Você é o especialista de trabalho do AI-BOT. Transforme pedido vago em " +
			"tarefa executável: título no imperativo, critério de pronto e responsável. " +
			"Automação só é automação quando você diz o gatilho, a ação e o que " +
			"acontece quando ela falha. Não crie tarefa sem dizer como ela termina.",
		Placeholder: "Descreva o objetivo ou a automação…",
		NewLabel:    "Novo quadro",
		Actions: []Action{
			{ID: "tarefa", Label: "Tarefa", Insert: "/tarefa ", Glyph: "plan"},
			{ID: "automacao", Label: "Automação", Insert: "/automacao ", Glyph: "dag"},
		},
		// schedule.list e schedule.remove andam junto com o create: quem pode
		// agendar e não pode conferir nem desfazer monta automação que a pessoa
		// só descobre quando ela dispara.
		Tools: []string{"fs.read", "fs.write", "memory.read", "memory.write", "webhook.post",
			"schedule.create", "schedule.list", "schedule.remove"},
		Triggers:        []string{"tarefa", "automa", "rotina", "lembr", "agend", "prazo", "quadro", "kanban", "checklist", "processo", "fluxo de trabalho", "workflow", "notific", "webhook"},
		PreferredSkills: []string{"chat"},
		Avatar: Avatar{
			Seed: 66, Shape: "squircle", Eyes: "dot", Mouth: "smile",
			Accessory: "antenna", Motion: "idle", Hue: 340, Saturation: 62,
		},
	},
	{
		ID:      "security",
		Name:    "Segurança",
		Tagline: "Revisão, achado e correção",
		Glyph:   "security",
		Hue:     4,
		Surface: SurfaceFindings,
		Rail:    RailFindings,
		System: "Você é o especialista de segurança do AI-BOT. Classifique cada achado " +
			"por severidade e mostre o CAMINHO até o dano (entrada → sink), não só o " +
			"nome da categoria. Proponha o patch. Não reporte o que você não " +
			"consegue demonstrar: achado sem cenário de falha é ruído que faz o " +
			"próximo achado real ser ignorado. Segredo encontrado nunca é ecoado " +
			"inteiro na resposta.",
		Placeholder: "Peça uma revisão, simulação ou correção…",
		NewLabel:    "Nova revisão",
		Actions: []Action{
			{ID: "revisar", Label: "Revisar", Insert: "/revisar ", Glyph: "security"},
			{ID: "deps", Label: "Dependências", Insert: "/deps ", Glyph: "policy"},
		},
		Tools:           []string{"fs.read", "fs.list", "fs.search", "git.diff", "osv.query", "secrets.scan"},
		Triggers:        []string{"seguranc", "vulnerab", "cve", "xss", "sql injection", "injecao", "credencial", "segredo", "senha", "token exposto", "lgpd", "auditor", "owasp", "csp", "permissao", "exploit", "sanitiz"},
		PreferredSkills: []string{"code", "reasoning"},
		Avatar: Avatar{
			Seed: 77, Shape: "shield", Eyes: "scan", Mouth: "line",
			Accessory: "shield", Motion: "pulse", Hue: 4, Saturation: 62,
		},
	},
	{
		ID:      "agent",
		Name:    "Equipe",
		Tagline: "Monta e supervisiona vários agentes",
		Glyph:   "agent",
		Hue:     258,
		Surface: SurfaceCrew,
		Rail:    RailCrew,
		System: "Você é o orquestrador do AI-BOT. Leia o objetivo e decida o TAMANHO da " +
			"equipe — não monte cinco agentes para o que um resolve. Toda equipe segue " +
			"a espinha: constituição → especificação → plano → tarefas → revisão. " +
			"Cada tarefa tem um dono, uma entrada e um critério de pronto. Tarefa que " +
			"escreve no repositório roda em cópia isolada. Quando um trabalhador não " +
			"souber decidir, ele escala — você não adivinha por ele.",
		Placeholder: "Descreva o objetivo — a equipe se organiza para entregar…",
		NewLabel:    "Nova equipe",
		Actions: []Action{
			{ID: "planejar", Label: "Planejar", Insert: "/planejar ", Glyph: "plan"},
			{ID: "executar", Label: "Executar", Insert: "/executar ", Glyph: "play"},
		},
		Tools:           []string{"task.dispatch", "task.gate", "worktree.create", "worktree.remove", "fs.read", "fs.write", "proc.run", "git.diff", "git.commit"},
		Triggers:        []string{"equipe", "agentes", "orquestr", "paralelo", "delegar", "subagente", "varias tarefas", "plano completo", "do inicio ao fim", "ponta a ponta", "multi-agente", "worktree"},
		PreferredSkills: []string{"reasoning", "tools", "long-context"},
		Avatar: Avatar{
			Seed: 88, Shape: "hex", Eyes: "ring", Mouth: "none",
			Accessory: "crown", Motion: "orbit", Hue: 258, Saturation: 62,
		},
	},
	{
		ID:      "fluxo",
		Name:    "Fluxo",
		Tagline: "Monta o pipeline na tela",
		Glyph:   "dag",
		Hue:     174,
		Surface: SurfaceFlow,
		Rail:    RailNodes,
		System: "Você é o especialista de fluxo do AI-BOT. Transforme o pedido em um " +
			"grafo: nós com entrada, saída e condição de erro. Todo nó precisa dizer o " +
			"que acontece quando falha — fluxo sem caminho de erro só funciona no " +
			"exemplo. Recuse ciclo sem condição de parada e diga onde ele está.",
		Placeholder: "Descreva o que deve acontecer — o fluxo é montado na tela…",
		NewLabel:    "Novo fluxo",
		Actions: []Action{
			{ID: "no", Label: "Nó", Insert: "/no ", Glyph: "dag"},
			{ID: "validar", Label: "Validar", Insert: "/validar", Glyph: "approve"},
		},
		Tools:           []string{"fs.read", "fs.write", "flow.validate", "webhook.post", "mcp.call"},
		Triggers:        []string{"fluxo", "pipeline", "grafo", "etapas", "integra", "conector", "gatilho", "condicional", "orquestracao visual", "n8n", "zapier", "esteira"},
		PreferredSkills: []string{"chat", "reasoning"},
		Avatar: Avatar{
			Seed: 99, Shape: "hex", Eyes: "dot", Mouth: "grid",
			Accessory: "antenna", Motion: "pulse", Hue: 174, Saturation: 62,
		},
	},
	{
		ID:      "tune",
		Name:    "Tuning",
		Tagline: "Dataset, treino e avaliação",
		Glyph:   "tune",
		Hue:     96,
		Surface: SurfaceTrain,
		Rail:    RailRuns,
		System: "Você é o especialista de fine-tuning do AI-BOT. Comece pelo dataset: " +
			"formato, tamanho, contaminação com o conjunto de avaliação. Só depois " +
			"fale de hiperparâmetro. Toda config de treino vem com o custo estimado e " +
			"o critério de parada. Nunca declare ganho sem a avaliação lado a lado com " +
			"o modelo base.",
		Placeholder: "Peça exemplos de dataset, config de treino ou avaliação…",
		NewLabel:    "Novo treino",
		Actions: []Action{
			{ID: "dataset", Label: "Dataset", Insert: "/dataset ", Glyph: "data"},
			{ID: "avaliar", Label: "Avaliar", Insert: "/avaliar ", Glyph: "diagnostics"},
		},
		Tools:           []string{"fs.read", "fs.write", "finetune.submit", "finetune.status", "runtime.status"},
		Triggers:        []string{"fine-tun", "finetun", "treino", "treinar", "dataset", "lora", "epoch", "hiperparam", "avaliacao do modelo", "checkpoint", "quantiz", "adapter"},
		PreferredSkills: []string{"chat", "reasoning"},
		Avatar: Avatar{
			Seed: 111, Shape: "bloom", Eyes: "spark", Mouth: "wave",
			Accessory: "bolt", Motion: "pulse", Hue: 96, Saturation: 62,
		},
	},
}

// byID é o índice de acesso. Montado uma vez.
var byID = func() map[string]Definition {
	index := make(map[string]Definition, len(catalog)+1)
	for _, definition := range catalog {
		index[definition.ID] = definition
	}
	index[MasterID] = Master
	return index
}()

// All devolve o catálogo na ordem de exibição. O master fica FORA: ele não é
// uma opção que a pessoa escolhe, é o que roda antes da escolha existir.
func All() []Definition {
	out := make([]Definition, len(catalog))
	copy(out, catalog)
	return out
}

// IDs devolve só os identificadores, na ordem de exibição.
func IDs() []string {
	out := make([]string, 0, len(catalog))
	for _, definition := range catalog {
		out = append(out, definition.ID)
	}
	return out
}

// Get busca por id. O segundo retorno distingue "não existe" de "veio zerado" —
// um especialista zerado tem Surface vazia e a tela não saberia o que montar.
func Get(id string) (Definition, bool) {
	definition, ok := byID[id]
	return definition, ok
}

// GetOrDefault nunca falha: id desconhecido cai no especialista padrão. Usado no
// caminho de renderização, onde derrubar a tela por causa de um id velho gravado
// numa conversa antiga seria desproporcional.
func GetOrDefault(id string) Definition {
	if definition, ok := byID[id]; ok {
		return definition
	}
	return byID[DefaultID]
}

// Exists diz se o id é de um especialista real (master incluso).
func Exists(id string) bool {
	_, ok := byID[id]
	return ok
}

// AllowsTool diz se o especialista pode pedir aquela ferramenta.
func (d Definition) AllowsTool(tool string) bool {
	for _, allowed := range d.Tools {
		if allowed == tool {
			return true
		}
	}
	return false
}
