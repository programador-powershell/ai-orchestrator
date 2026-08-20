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

// Relation é COMO o companheiro trabalha em relação ao dono.
//
// A distinção não é enfeite de tela: ela é o formato do plano. O Design pode
// desenhar a identidade visual enquanto o Código monta o esqueleto — são
// paralelos, e serializá-los dobraria o tempo por nada. Já a revisão de
// Segurança precisa de código para revisar: pô-la em paralelo produziria um
// parecer sobre um repositório vazio.
type Relation string

const (
	// RelationParallel trabalha AO MESMO TEMPO que o dono.
	RelationParallel Relation = "parallel"
	// RelationAfter trabalha SOBRE o que o dono produziu.
	RelationAfter Relation = "after"
)

// Companion é um especialista que entra em espera junto com o dono.
type Companion struct {
	// Specialist é quem entra.
	Specialist string `json:"specialist"`
	// When diz se ele trabalha junto ou depois.
	When Relation `json:"when"`
	// Requires são radicais que precisam aparecer no pedido para ele entrar.
	// Vazio = entra sempre que este especialista for o dono.
	//
	// Existe porque companheiro incondicional vira ruído: nem todo pedido de
	// código tem front-end, e um Design em espera numa correção de bug de
	// backend só ensina a pessoa a ignorar o aviso.
	Requires []string `json:"requires,omitempty"`
	// Why é a frase que a tela mostra. Escrita para a PESSOA ler, não para o
	// log: ela precisa entender por que aquele bot apareceu.
	Why string `json:"why"`
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

	// Deliverables são os substantivos que ESTE especialista entrega.
	//
	// Existem porque contar radicais não distingue o pedido do ingrediente.
	// "Crie uma API de cobrança com banco postgres" pontua muito mais alto em
	// Dados (dois radicais longos: banco, postgres) do que em Código (um curto:
	// api) — e mesmo assim quem é dono é o Código: a API é o que foi PEDIDO, o
	// banco é o que ela usa. Quem desfaz o empate é a ordem das palavras em
	// português: o entregável vem logo depois do verbo de construção.
	Deliverables []string `json:"deliverables,omitempty"`

	// Companions são os especialistas que ENTRAM EM ESPERA quando este aqui é
	// escolhido dono da conversa.
	//
	// Escolher o dono nunca foi o trabalho todo: "crie uma aplicação completa"
	// é do Código, mas se ela tem front-end o Design tem o que fazer, e depois
	// de existir código alguém precisa revisar a segurança. Sem isto a pessoa
	// teria de lembrar de pedir cada um — que é justamente o trabalho que o
	// master existe para não devolver a ela.
	Companions []Companion `json:"companions,omitempty"`

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
			"português do Brasil, direto ao ponto, sem preâmbulo. Use um tom confiante e " +
			"conversacional, com humor leve quando combinar — nunca à custa da precisão. " +
			"Você continua sendo o AI-BOT: não finja ser outro produto. Separe o que você " +
			"sabe do que é hipótese. Quando pesquisar, cite a fonte. Quando o pedido " +
			"for de outra especialidade (código, documento, dados, segurança), diga " +
			"isso em uma linha em vez de improvisar.",
		Placeholder: "Pergunte, pesquise ou pense junto…",
		NewLabel:    "Nova conversa",
		Actions: []Action{
			{ID: "pesquisar", Label: "Pesquisar", Insert: "/pesquisar ", Glyph: "search"},
			{ID: "resumir", Label: "Resumir", Insert: "/resumir ", Glyph: "file"},
		},
		// `pack.list` fica no especialista PADRÃO porque "o que a TI instalou
		// aqui?" é pergunta de conversa, não de especialidade — e é para o chat
		// que todo id desconhecido cai.
		Tools:           []string{"web.search", "memory.read", "memory.write", "fs.read", "pack.list"},
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
		// O "grave, não cole" nasceu de um flagrante: pedido um site, o Código
		// respondeu com o HTML inteiro num bloco de markdown NO CHAT e a janela
		// do editor ficou em "nenhum arquivo aberto". A superfície dele é a IDE:
		// o trabalho só EXISTE para a pessoa quando o arquivo é gravado no
		// projeto — e fs.write passa pelo funil de aprovação, que é o desejado.
		//
		// O "rode você mesmo" nasceu de OUTRO flagrante: pedida uma aplicação, o
		// Código mandou a PESSOA operar a máquina ("crie a pasta, rode git
		// init…"). Scaffold, dependência e build são trabalho DELE, via proc.run
		// no ambiente da sessão (sandbox por padrão no turno de trabalho — ver
		// supervisor/tools_process.go), pelo funil: a pessoa aprova, não digita.
		//
		// O GATILHO DO DESIGN é do ofício, não do roteador (docs/
		// execucao-na-janela.md, item 3): a cascata decide UM vencedor no primeiro
		// input, então "site completo" vencia no code e o design nunca entrava —
		// apesar de a delegação bot-a-bot, o projeto compartilhado e a persona do
		// design já existirem. Quem enxerga o pedido inteiro é o Código atendendo;
		// o gesto de compor já tem nome na casa: delegar. A ORDEM importa (o
		// design LÊ o que existe — chamado antes do fs.write, desenha de cabeça,
		// que é o que a persona dele proíbe) e o que trafega é o goal com os
		// CAMINHOS gravados: HTML inline estoura goal/contexto/teto de resultado,
		// e URL de localhost morre na guarda anti-SSRF do design.replicate.
		System: "Você é o especialista de código do AI-BOT e trabalha NA SUA JANELA: " +
			"o resultado é ARQUIVO NO PROJETO da sessão, não texto no chat. Crie e " +
			"edite com as ferramentas fs.write e fs.patch — é isso que abre o código " +
			"no editor da pessoa. NUNCA cole o arquivo inteiro na resposta: no chat " +
			"só cabe trecho ilustrativo pequeno. Comando é trabalho SEU, não da " +
			"pessoa: scaffold, instalação de dependência, build e verificação você " +
			"executa com proc.run no ambiente da sessão (isolado quando há sandbox), " +
			"passando pela aprovação. NUNCA mande a pessoa abrir terminal nem rodar " +
			"comando — 'crie a pasta', 'rode git init', 'instale e teste aí' são " +
			"defeitos, não instruções. Depois de gravar, responda CURTO anunciando " +
			"o que gravou, onde, e o que VOCÊ rodou para verificar. Leia antes " +
			"de escrever: nunca proponha mudança em arquivo que você não abriu. Siga " +
			"o estilo do código à volta (nomes, comentários, idioma). Se a mudança " +
			"quebrar contrato público, avise antes de fazer. Pedido com camada " +
			"VISUAL (tema, paleta, tokens, tipografia, responsivo)? DEPOIS de gravar " +
			"a estrutura no projeto, delegue ao especialista design em vez de " +
			"improvisar CSS: no goal, cite os CAMINHOS gravados (o index.html, a " +
			"folha de estilo) para ele ler no projeto compartilhado — nunca cole o " +
			"HTML inline no goal e nunca aponte URL de localhost.",
		Placeholder: "Descreva a mudança de código…",
		NewLabel:    "Nova sessão",
		Actions: []Action{
			{ID: "review", Label: "Revisar", Insert: "/review ", Glyph: "review"},
			{ID: "explain", Label: "Explicar", Insert: "/explain ", Glyph: "explain"},
			{ID: "testgen", Label: "Testes", Insert: "/testgen ", Glyph: "testgen"},
		},
		// `term.open` saiu desta lista junto com o registro dela no gateway (ver
		// supervisor/tools.go): sem painel de terminal na interface, ela abria
		// um shell que ninguém via e respondia sucesso ao modelo. Quem precisa
		// rodar comando usa `proc.run`, que passa pela aprovação.
		Tools: []string{
			"fs.read", "fs.write", "fs.list", "fs.search", "fs.patch",
			"proc.run", "git.status", "git.diff", "git.commit", "diagnostics.run",
			// A dupla de publicação (internal/ship): descobrir a stack e gerar
			// o Dockerfile são leitura e função pura — cabem no especialista
			// que edita o repositório, sem portão de execução.
			"ship.detect", "ship.dockerfile",
		},
		// Os radicais de PEDIDO DE CONSTRUÇÃO entraram depois de uma sonda mostrar
		// que "crie uma aplicação em next.js completa" — o jeito mais comum de
		// pedir software — não pontuava em NENHUM especialista e caía na
		// clarificação. A lista antiga só conhecia o vocabulário de quem já está
		// DENTRO do código (bug, refator, stack trace), e não o de quem está
		// pedindo um.
		//
		// A régua para entrar aqui: o radical tem de tornar ESTE especialista mais
		// provável que os outros. "repositorio", "sistema", "programa", "docker" e
		// "login" foram tentados e REMOVIDOS — aparecem tanto num pedido de
		// segurança quanto num de código, e o efeito medido foi o oposto do
		// pretendido: "faça uma auditoria de segurança no repositório" passou a
		// empatar com `security`, a margem mínima matou a decisão dos dois, e o
		// pedido caiu na clarificação.
		Triggers: []string{"codig", "funcao", "bug", "refator", "compil", "test", "build", "lint", "commit", "branch", "merge", "stack trace", "erro de", "implement", "classe", "metodo", "endpoint", "typescript", "python", "rust", "golang", "javascript",
			"aplicac", "aplicativo", "next.js", "nextjs", "react", "vue.js", "angular", "django", "flask", "vercel",
			"api", "backend", "front-end", "frontend", "biblioteca", "framework", "microservic", "crud"},
		Deliverables: []string{"aplicac", "aplicativo", "app", "api", "site", "portal", "sistema",
			"backend", "frontend", "front-end", "servico", "microservic", "crud", "landing", "pagina", "programa"},
		Companions: []Companion{
			{
				Specialist: "design", When: RelationParallel,
				// Só com sinal de interface. Design em espera numa correção de bug
				// de backend é ruído, e ruído ensina a ignorar o aviso.
				Requires: []string{"aplicac", "aplicativo", "site", "tela", "interface", "front-end",
					"frontend", "next.js", "nextjs", "react", "vue.js", "angular", "landing", "pagina", "portal"},
				Why: "o pedido tem interface — o Design pode definir o visual enquanto o código é montado",
			},
			{
				Specialist: "security", When: RelationAfter,
				// DEPOIS: revisão de segurança sem código para revisar produz
				// parecer sobre repositório vazio.
				Requires: []string{"aplicac", "aplicativo", "site", "api", "backend", "endpoint",
					"login", "autenticac", "deploy", "portal", "crud"},
				Why: "aplicação nova pede revisão de segurança depois de existir código",
			},
			{
				Specialist: "data", When: RelationParallel,
				Requires: []string{"banco", "sql", "tabela", "schema", "crud", "cadastro", "postgres", "mysql"},
				Why:      "há dados no pedido — o modelo do banco pode ser desenhado em paralelo",
			},
		},
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
		// O "NA SUA JANELA" é o padrão do Código levado ao ofício de documentos
		// (auditoria da paridade): a superfície dele mostra o ARQUIVO, e uma
		// resposta que descreve a edição sem chamar office.edit deixa o
		// documento intocado com cara de trabalho feito.
		System: "Você é o especialista de documentos do AI-BOT e trabalha NA SUA JANELA: " +
			"abra e altere o arquivo BINÁRIO (DOCX/PPTX) pelas ferramentas office.open, " +
			"office.edit e office.export, e leia PDF com pdf.extract — é o documento " +
			"alterado que a pessoa vê na sua superfície. Não devolva markdown fingindo " +
			"ser documento nem cole o documento inteiro no chat. Antes de alterar, " +
			"descreva a alteração em uma linha e mostre onde ela cai. Preserve estilo, " +
			"numeração e sumário existentes: reescrever o documento inteiro para mudar " +
			"um parágrafo destrói formatação que a pessoa levou horas montando.",
		Placeholder: "Diga o que quer alterar no arquivo…",
		NewLabel:    "Nova sessão",
		Actions: []Action{
			{ID: "abrir", Label: "Abrir", Insert: "/abrir ", Glyph: "file"},
			{ID: "substituir", Label: "Substituir", Insert: "/substituir ", Glyph: "diff"},
		},
		Tools:           []string{"fs.read", "fs.list", "office.open", "office.edit", "office.export", "pdf.extract"},
		Triggers:        []string{"docx", "pptx", "pdf", "document", "planilha", "slide", "apresenta", "word", "powerpoint", "sumario", "paragrafo", "cabecalho", "rodape", "contrato", "relatorio", "ata", "oficio"},
		Deliverables:    []string{"document", "apresenta", "slide", "planilha", "relatorio", "contrato", "ata", "oficio", "manual"},
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
		// A primeira frase existe porque o Design compartilha o MESMO projeto da
		// conversa (o cwd desce da raiz à filha): o index.html que o Código
		// acabou de gravar está ao alcance de um fs.read — desenhar "de cabeça"
		// em vez de ler o que já existe produz um front que não é o do projeto.
		System: "Você é o especialista de design do AI-BOT e trabalha NA SUA JANELA: " +
			"desenhe pelas ferramentas (design.replicate e as de vídeo) — é o que a " +
			"pessoa vê no seu canvas — em vez de colar o artefato inteiro no chat. " +
			"LEIA o projeto da sessão com fs.read/fs.list antes de desenhar: o " +
			"index.html que o Código gravou está no mesmo projeto, e é dele que você " +
			"extrai o sistema para desenhar o front ao vivo. Trabalhe em TOKENS " +
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
		// As cinco `video.*` moram aqui porque vídeo é entrega VISUAL — quem
		// pede "corta a abertura e põe o título" está falando com o design,
		// não com um décimo primeiro especialista que ninguém acharia.
		//
		// `fs.list` entrou junto com a ordem de LER o projeto no system: sem
		// listar a pasta, o Design não acha o index.html que o Código gravou e a
		// persona mandaria fazer o que a permissão recusa.
		Tools: []string{"fs.read", "fs.list", "fs.write", "web.fetch", "design.replicate", "image.generate",
			"video.probe", "video.trim", "video.concat", "video.text", "video.export"},
		Triggers: []string{"design", "interface", "layout", "tela", "componente", "css", "cor", "paleta", "tipografia", "figma", "mockup", "tema", "espacamento", "icone", "logo", "responsiv",
			"video", "corte de video", "legenda no video", "gif", "mp4"},
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
		// A tela de Dados desenha o ERD a partir do RESULTADO das ferramentas
		// (schema.export/sql.render devolvem JSON estruturado — ver
		// supervisor/tools_data.go): schema colado no chat deixa o painel vazio.
		System: "Você é o especialista de dados do AI-BOT e trabalha NA SUA JANELA: " +
			"produza o schema e o SQL pelas ferramentas schema.export e sql.render — " +
			"é o resultado delas que vira o diagrama na tela da pessoa — em vez de " +
			"colar o artefato inteiro no chat. Antes de responder, deixe " +
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
		Deliverables:    []string{"banco", "schema", "tabela", "modelagem", "erd", "consulta", "query", "migracao"},
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
		// O reforço de ferramenta é o mesmo do Código (auditoria da paridade):
		// automação "criada" só no texto do chat não dispara nunca — quem agenda
		// é schedule.create, e é isso que a persona tem de mandar usar.
		System: "Você é o especialista de trabalho do AI-BOT e trabalha NA SUA JANELA: " +
			"registre o quadro e as tarefas com fs.write e crie a automação DE VERDADE " +
			"com schedule.create (confira com schedule.list, desfaça com schedule.remove; " +
			"notificação sai por webhook.post) — descrever a automação no chat não agenda " +
			"nada. Transforme pedido vago em tarefa executável: título no imperativo, " +
			"critério de pronto e responsável. Automação só é automação quando você diz " +
			"o gatilho, a ação e o que acontece quando ela falha. Não crie tarefa sem " +
			"dizer como ela termina.",
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
		// A tela de Achados monta os cartões do ```json de secrets.scan/osv.query
		// — achado narrado sem ferramenta deixa o painel vazio e é exatamente a
		// encenação que o portão de narração pune (auditoria da paridade).
		System: "Você é o especialista de segurança do AI-BOT e trabalha NA SUA JANELA: " +
			"todo achado nasce de ferramenta que RODOU — fs.search e git.diff para o " +
			"caminho até o dano, secrets.scan para segredo exposto, osv.query para " +
			"dependência vulnerável; é o resultado delas que vira os cartões da sua " +
			"tela de achados. Não descreva varredura que você não executou. Classifique " +
			"cada achado por severidade e mostre o CAMINHO até o dano (entrada → sink), " +
			"não só o nome da categoria. Proponha o patch. Não reporte o que você não " +
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
		// O quadro da equipe nasce do task.dispatch — um plano descrito no chat
		// não despacha trabalhador nenhum (auditoria da paridade).
		System: "Você é o orquestrador do AI-BOT e trabalha NA SUA JANELA: monte a equipe " +
			"DE VERDADE com task.dispatch — é o despacho que desenha o quadro na sua " +
			"tela — e decida onda parada com task.gate; um plano só descrito no chat " +
			"não executa nada. Leia o objetivo e decida o TAMANHO da " +
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
		// flow.validate é a régua do ofício: um grafo colado no chat, sem passar
		// pela validação, é desenho — não pipeline (auditoria da paridade).
		System: "Você é o especialista de fluxo do AI-BOT e trabalha NA SUA JANELA: " +
			"materialize o grafo pelas ferramentas (fs.write para os nós e " +
			"flow.validate para provar que ele fecha) em vez de colar o fluxo no chat " +
			"— é o resultado validado que a sua tela desenha. Transforme o pedido em um " +
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
		// O treino que a tela de Runs acompanha é o que finetune.submit disparou
		// — config colada no chat não treina nada (auditoria da paridade).
		System: "Você é o especialista de fine-tuning do AI-BOT e trabalha NA SUA JANELA: " +
			"materialize dataset e config com fs.write, dispare o treino com " +
			"finetune.submit e acompanhe com finetune.status — é o run de verdade que a " +
			"sua tela mostra; config colada no chat não treina nada. Comece pelo dataset: " +
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

// Daqui para baixo o acesso é SEMPRE pelo catálogo ativo (overlay.go), nunca
// pela fatia `catalog` diretamente: desde a trilha A de docs/atualizacao.md o
// catálogo compilado é só o ponto de partida, e um leitor que ignore a troca
// responderia com o registro velho depois de uma publicação.

// All devolve o catálogo na ordem de exibição. O master fica FORA: ele não é
// uma opção que a pessoa escolhe, é o que roda antes da escolha existir.
func All() []Definition {
	list := active.Load().list
	out := make([]Definition, len(list))
	copy(out, list)
	return out
}

// IDs devolve só os identificadores, na ordem de exibição.
func IDs() []string {
	list := active.Load().list
	out := make([]string, 0, len(list))
	for _, definition := range list {
		out = append(out, definition.ID)
	}
	return out
}

// Get busca por id. O segundo retorno distingue "não existe" de "veio zerado" —
// um especialista zerado tem Surface vazia e a tela não saberia o que montar.
func Get(id string) (Definition, bool) {
	definition, ok := active.Load().byID[id]
	return definition, ok
}

// GetOrDefault nunca falha: id desconhecido cai no especialista padrão. Usado no
// caminho de renderização, onde derrubar a tela por causa de um id velho gravado
// numa conversa antiga seria desproporcional.
//
// Uma leitura só do ponteiro, e não duas: entre um `active.Load()` para o id e
// outro para o padrão poderia caber uma troca de catálogo, e a resposta sairia
// de dois catálogos diferentes.
func GetOrDefault(id string) Definition {
	index := active.Load().byID
	if definition, ok := index[id]; ok {
		return definition
	}
	return index[DefaultID]
}

// Exists diz se o id é de um especialista real (master incluso).
func Exists(id string) bool {
	_, ok := active.Load().byID[id]
	return ok
}

// AllowsTool diz se o especialista pode pedir aquela ferramenta.
// universalTools valem para TODO especialista, sem constar no catálogo de
// cada um: são leitura do que a PRÓPRIA conversa já produziu — recuperar a
// fatia de um artefato não é capacidade nova, é acesso ao que já aconteceu.
var universalTools = map[string]bool{
	"context.fetch": true,
}

func (d Definition) AllowsTool(tool string) bool {
	if universalTools[tool] {
		return true
	}
	for _, allowed := range d.Tools {
		if allowed == tool {
			return true
		}
	}
	return false
}
