// O supervisor executa UM turno: prompt → rota → especialista → modelo →
// ferramentas → done.
//
// Ele é o único lugar do sistema que junta as peças, e é de propósito: quando a
// montagem do prompt vivia espalhada pelas abas, cada aba injetava contexto do
// seu jeito e ninguém sabia dizer o que o modelo tinha visto. Aqui a ordem é
// uma só e está escrita em `buildMessages`.
//
// A ordem do prompt não é estética. O prompt master do admin vem PRIMEIRO e
// nenhum modo o remove: se trocar de especialista removesse a política, trocar
// de especialista seria a saída barata da política.
package supervisor

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"aibot/gateway/internal/contextrt"
	"aibot/gateway/internal/eventbus"
	"aibot/gateway/internal/fleet"
	"aibot/gateway/internal/fusion"
	"aibot/gateway/internal/memory"
	"aibot/gateway/internal/modelrouter"
	"aibot/gateway/internal/permissions"
	"aibot/gateway/internal/protocol"
	"aibot/gateway/internal/specialist"
	"aibot/gateway/internal/store"
	"aibot/gateway/internal/workspace"
	"aibot/gateway/internal/worktree"
)

// maxToolRounds limita o vaivém modelo↔ferramenta num turno.
//
// Sem teto, um modelo que erra o argumento e relê o mesmo arquivo entra em laço
// e queima o orçamento inteiro numa mensagem. Oito é o suficiente para uma
// tarefa de código real (listar, ler dois arquivos, editar, rodar teste, ler o
// erro, corrigir) e curto o bastante para o laço morrer barato.
const maxToolRounds = 8

// maxHistoryMessages é quanto do histórico entra no prompt.
const maxHistoryMessages = 40

// approvalTimeout é quanto o turno espera por uma decisão humana. Passado isso
// a ferramenta é RECUSADA, não liberada: o silêncio de quem saiu para o almoço
// não pode ser lido como consentimento.
const approvalTimeout = 10 * time.Minute

// FusionPresets é quem sabe se um especialista responde com várias cabeças.
//
// Interface, e não o struct do catálogo, porque o supervisor não deve saber de
// onde a configuração vem — arquivo hoje, política assinada amanhã.
type FusionPresets interface {
	PresetFor(specialist string) (fusion.Preset, bool)
}

// Deps são as peças que o supervisor orquestra.
type Deps struct {
	Store  *store.Store
	Bus    *eventbus.Bus
	Models *modelrouter.Router
	Gate   *permissions.Gate
	Memory *memory.Store
	Tools  *Registry
	Router *Router
	// Worktrees dá a cada tarefa isolada uma cópia de verdade do git. É o MESMO
	// gerente do Toolbox: dois gerentes sobre o mesmo repositório teriam dois
	// semáforos e voltariam a brigar pelo index.lock, que é justo o que ele
	// serializa. Pode ser nil (fora de um repositório, ou sem git na estação) — e
	// aí a tarefa que pediu isolamento falha em vez de rodar no compartilhado.
	Worktrees *worktree.Manager
	// Fusion devolve o preset configurado para um especialista. Nil = ninguém
	// configurou fusion, e todo turno usa um modelo só — que é o padrão.
	Fusion FusionPresets
	// PromptMaster devolve o prompt do admin. Pode ser nil.
	PromptMaster func() string
	// Hooks são os ganchos declarativos dos pacotes corporativos (ver hooks.go).
	// Nil = nenhum pacote com gancho, que é o caso de quem não instalou nada.
	Hooks *HookRunner
	// PackPrompt devolve o texto que os pacotes corporativos anexam ao prompt de
	// sistema de um especialista (internal/pack.PromptFor). Pode ser nil.
	PackPrompt func(specialistID string) string
	// Runs registra cada execução de tarefa em disco (fleet.RunLog). Nil = sem
	// registro, e a equipe roda como sempre rodou.
	Runs *fleet.RunLog
	// Workspaces congela ONDE cada execução trabalha (internal/workspace): o
	// plano v1 aponta para a pasta local da sessão, e é pendurado no contexto
	// no começo do turno/tarefa — a ferramenta nunca calcula um diretório, ela
	// recebe uma execução cujo workspace já foi decidido. Nil = nenhum
	// workspace é pendurado e as ferramentas de arquivo recusam com motivo.
	Workspaces *workspace.Manager
}

// turnHandle é o cancelamento de UM turno, com IDENTIDADE.
//
// A identidade não é enfeite. O turno que é substituído continua correndo até
// perceber o cancelamento, e a limpeza dele roda DEPOIS de o substituto já ter se
// registrado; um `delete` cego apagaria o cancel de quem está vivo, e dali em
// diante `Busy` diria que a sessão está livre e `Cancel` não cancelaria nada.
//
// A identidade é o id do turno porque comparar `context.CancelFunc` é proibido
// em Go — func value só se compara com nil.
type turnHandle struct {
	turn   string
	cancel context.CancelFunc
}

// Supervisor é o executor de turnos.
type Supervisor struct {
	deps Deps

	mu      sync.Mutex
	running map[string]turnHandle
	waiting map[string]chan protocol.ApprovalDecision
	gates   map[string]chan protocol.Gate
	// asks são as perguntas bloqueantes abertas, UMA por sessão. Diferente de
	// `waiting`, aqui não há goroutine esperando: o turno que perguntou JÁ
	// terminou, e a resposta (KindReply) inicia a continuação. É o mesmo
	// mecanismo para a clarificação do master e para a aprovação de plano —
	// pergunta → resposta → continuação.
	asks    map[string]pendingAsk
	counter uint64
	// capsuleLocks serializa a dobra da cápsula por sessão (ver foldCapsule).
	capsuleLocks sync.Map
}

// New monta o supervisor.
func New(deps Deps) *Supervisor {
	return &Supervisor{
		deps:    deps,
		running: make(map[string]turnHandle),
		waiting: make(map[string]chan protocol.ApprovalDecision),
		gates:   make(map[string]chan protocol.Gate),
		asks:    make(map[string]pendingAsk),
	}
}

// nextID gera identificadores curtos e ordenáveis dentro do processo.
func (s *Supervisor) nextID(prefix string) string {
	s.mu.Lock()
	s.counter++
	value := s.counter
	s.mu.Unlock()
	return fmt.Sprintf("%s-%d-%d", prefix, time.Now().UnixNano()/1e6, value)
}

/* --------------------------------- turno -------------------------------- */

// Prompt executa um turno inteiro. Bloqueia até o fim (quem quiser assíncrono
// chama numa goroutine); o progresso sai todo pelo barramento.
func (s *Supervisor) Prompt(parent context.Context, sessionID string, prompt protocol.Prompt) error {
	// Mensagem normal MATA a pergunta pendente da sessão: quem ignorou o cartão
	// e seguiu escrevendo já respondeu — a mensagem nova É a resposta. Guardar a
	// pendência prenderia a conversa a um cartão que a pessoa dispensou.
	s.dropAsk(sessionID)
	return s.runTurn(parent, sessionID, prompt, turnOptions{logQuestion: true, clarify: true})
}

// turnOptions ajusta como runTurn trata a fala da pessoa.
//
// Existe por causa das CONTINUAÇÕES (ver Reply em clarify.go): a resposta de um
// `ask` roda um turno novo, mas a fala original já está no log — regravá-la
// duplicaria a mensagem na conversa — e um primeiro input que já foi clarificado
// uma vez não pode voltar a perguntar, senão a pergunta vira laço.
type turnOptions struct {
	// logQuestion grava prompt.Text (sem o /mode) como mensagem da pessoa.
	logQuestion bool
	// userLine, quando preenchido, é gravado NO LUGAR do texto do prompt: a
	// continuação de texto livre roteia pelo texto composto (resposta + pedido
	// original), mas só a resposta é fala nova — o pedido original já está lá.
	userLine string
	// clarify permite transformar o primeiro input incerto em pergunta.
	clarify bool
	// clarified marca a continuação de uma CLARIFICAÇÃO respondida por opção.
	//
	// A distinção importa porque prompt.Specialist preenchido significa duas
	// coisas diferentes: /mode e hello.specialist são "quero uma conversa DESTE
	// bot" (a conversa vira dele), enquanto a opção do cartão só respondeu QUEM
	// TRABALHA — e aí a raiz DELEGA como se a cascata tivesse decidido com
	// confiança 1, em vez de adotar o modo e virar a IDE (o sequestro que o
	// caminho do master existe para matar).
	clarified bool
}

// runTurn é o turno de verdade; Prompt e as continuações de Reply chegam aqui.
func (s *Supervisor) runTurn(parent context.Context, sessionID string, prompt protocol.Prompt, opts turnOptions) error {
	// Anexo sem texto É um pedido — e o composer o deixa passar de propósito
	// ("Anexo sem texto vale como envio"). Antes ele morria aqui, na PRIMEIRA
	// linha do turno, antes de existir um id de turno para carimbar qualquer
	// envelope: nada chegava à tela, o `busy` do cliente nunca fechava, o orbe
	// girava e o chip do anexo já tinha sido apagado. A pessoa perdia o arquivo e
	// o pedido sem uma palavra.
	//
	// O texto é sintetizado a partir dos nomes porque é exatamente o que o resto
	// do motor espera receber: o roteamento por extensão resolve `.docx` para o
	// especialista de escritório com confiança 1 (ver combineAttachments), e o
	// modelo precisa de uma frase para responder.
	if strings.TrimSpace(prompt.Text) == "" {
		names := attachmentNames(prompt.Attachments)
		if len(names) == 0 {
			return errors.New("prompt vazio")
		}
		prompt.Text = "Analise o(s) anexo(s): " + strings.Join(names, ", ")
	}

	// O id sai ANTES do registro porque ele é a identidade do turno no mapa de
	// execução (ver turnHandle). Fora do lock: `nextID` também tranca `mu`, e
	// sync.Mutex não é reentrante.
	turn := s.nextID("t")

	// Um turno por sessão. O anterior é CANCELADO, não enfileirado: quem manda
	// outra mensagem enquanto a resposta corre está corrigindo o rumo, e
	// esperar a resposta abandonada terminar só atrasa a que interessa.
	ctx, cancel := context.WithCancel(parent)
	// O orçamento de equipe nasce AQUI, uma vez por turno, e desce por contexto
	// até as sub-equipes. Criá-lo dentro de `task.dispatch` daria cota nova a cada
	// nível da árvore, que é exatamente o que o teto existe para impedir.
	ctx = withCrewBudget(ctx)
	// A CÁPSULA dobra no fim do turno, aconteça o que acontecer com ele —
	// falha também é estado que o próximo turno precisa saber.
	defer s.foldCapsule(sessionID)
	// O WORKSPACE do turno também nasce aqui, congelado UMA vez: fs.read,
	// git.diff e proc.run deste turno enxergam o mesmo root porque leem a mesma
	// execução do contexto — nenhuma ferramenta resolve diretório sozinha.
	// OriginModel: este é o turno do modelo, e num projeto provisionado ele
	// trabalha numa CÓPIA (o staging v1) até a entrega.
	ctx = s.comWorkspace(ctx, sessionID, turn, "", "", workspace.OriginModel)
	// O DESCARTE do staging é garantido: qualquer caminho que sair do turno sem
	// promover — falha de modelo, interrupção, recusa, portão de narração,
	// retorno antecipado — joga a cópia fora, e nada meio-escrito chega à
	// pessoa. No caminho feliz a promoção já limpou o staging e isto é não-op.
	// Closure sobre a variável `ctx` de propósito: o recongelamento pós-
	// provisionamento (abaixo) troca a execução, e é a ÚLTIMA que se descarta.
	defer func() { s.descartaWorkspace(ctx) }()
	s.mu.Lock()
	if previous, ok := s.running[sessionID]; ok {
		previous.cancel()
	}
	s.running[sessionID] = turnHandle{turn: turn, cancel: cancel}
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		// Só quem AINDA é o dono da sessão se desregistra. Este turno pode já ter
		// sido substituído — e apagar o registro do substituto deixaria a sessão
		// marcada como livre com um turno correndo dentro dela.
		if current, ok := s.running[sessionID]; ok && current.turn == turn {
			delete(s.running, sessionID)
		}
		s.mu.Unlock()
		cancel()
	}()

	session, err := s.deps.Store.GetSession(sessionID)
	if err != nil {
		return err
	}

	// O `/mode` sai do texto antes de ele virar mensagem: quem lê a conversa
	// depois quer o pedido, não o comando de roteamento. A troca de modo não se
	// perde — ela fica registrada no envelope de rota, que é onde a interface
	// desenha a faixa "agora é X".
	//
	// Sem comando não há o que repor: `ParseModeCommand` devolve o texto intacto.
	_, question, hadCommand := ParseModeCommand(prompt.Text)

	// 1. A fala da pessoa entra no log ANTES de qualquer decisão. Se o
	// roteamento ou o modelo falharem, a pessoa ainda vê o que perguntou —
	// perder o próprio texto por causa de um erro do servidor é a pior forma de
	// falhar aqui. Nas continuações de Reply a fala já está no log (ou é a linha
	// nova em userLine), por isso o que se grava é escolhido pelas opções.
	userLine := opts.userLine
	if opts.logQuestion {
		userLine = question
	}
	if strings.TrimSpace(userLine) != "" {
		if err := s.emit(sessionID, turn, protocol.KindMessage,
			protocol.Actor{Kind: protocol.ActorUser}, protocol.Message{
				Role: "user",
				Text: userLine,
			}); err != nil {
			return err
		}
	}

	// 2. Quem atende. Só o PRIMEIRO input da conversa desce a cascata
	// (fast router → Needle → modelo grande); depois disso a conversa tem modo
	// e vai direto ao mesmo executor. Ver o cabeçalho de router.go.
	route := s.deps.Router.Route(ctx, RouteInput{
		Text:        prompt.Text,
		Explicit:    prompt.Specialist,
		Current:     session.Specialist,
		Allowed:     s.deps.Gate.Policy().AllowedSpecialists,
		Attachments: attachmentNames(prompt.Attachments),
	})
	definition := specialist.GetOrDefault(route.Specialist)

	// `/mode` sozinho, sem pedido junto, só troca o modo e encerra o turno: não
	// há o que perguntar ao modelo, e mandar um prompt vazio faria o
	// especialista novo responder ao nada.
	if hadCommand && strings.TrimSpace(question) == "" {
		if _, err := s.deps.Store.UpdateSession(sessionID, func(meta *store.SessionMeta) {
			meta.Specialist = definition.ID
		}); err != nil {
			return err
		}
		// A superfície de trabalho flipa AGORA (a rota abaixo troca a tela), e
		// uma sessão sem pasta abriria a IDE com a árvore morta — o próximo turno
		// congela o workspace já com a pasta provisionada aqui. A semente é a
		// `question` (vazia neste braço) de propósito: o "/mode code" cru viraria
		// o nome da pasta, e o fallback do título/"projeto" nomeia melhor.
		s.provisionaProjeto(sessionID, turn, definition, question)
		if err := s.emit(sessionID, turn, protocol.KindRoute,
			protocol.Actor{Kind: protocol.ActorSupervisor, ID: specialist.MasterID}, route); err != nil {
			return err
		}
		s.done(sessionID, turn, definition.ID, modelrouter.Usage{}, false)
		return nil
	}

	// 2b. PRIMEIRO input incerto não vira chute: vira pergunta. Quando a cascata
	// caiu no fallback (ou devolveu confiança rasteira) e nenhum anexo decidiu —
	// anexo decisivo sai com confiança 1 e nunca chega aqui —, o supervisor
	// pergunta O QUE a pessoa quer, com opções objetivas montadas do shortlist
	// do fast router, e ENCERRA o turno sem chamar modelo nenhum. A resposta
	// chega como `reply` e roda o turno original com a escolha explícita (ver
	// Reply em clarify.go). Conversa em andamento nunca passa por aqui: com modo
	// gravado a rota é sticky, confiança 1.
	if opts.clarify && session.Specialist == "" &&
		(route.Reason == protocol.RouteFallback || route.Confidence < ClarifyMaxConfidence) {
		if s.askClarification(sessionID, turn, question, prompt) {
			return nil
		}
	}

	// 2c. A RAIZ NÃO VIRA O BOT DE TRABALHO: o master delega.
	//
	// "Construa um html" roteava para o Código e a conversa INTEIRA virava a
	// IDE — a pessoa ficava presa na superfície do bot. Agora a conversa raiz
	// fica com o master (superfície de conversa) e o especialista de trabalho
	// nasce como conversa FILHA, pelo MESMO caminho da delegação bot-a-bot; o
	// modo, a rota e a superfície acontecem NA FILHA. Só a rota vinda da
	// CASCATA desce por aqui: /mode e prompt.Specialist são escolhas da pessoa,
	// e quem escolhe o modo vira o bot, como sempre (hello.specialist idem —
	// a conversa nasce com dono e o sticky nem chega neste ponto).
	//
	// EXCEÇÃO deliberada: a resposta da CLARIFICAÇÃO. Ela chega com
	// prompt.Specialist preenchido (a opção escolhida), mas escolher "Código" no
	// cartão é responder QUEM TRABALHA — a mesma pergunta que a cascata teria
	// respondido sozinha se tivesse confiança —, não pedir uma conversa DESTE
	// bot. Por isso ela desce pela delegação, com a razão trocada para
	// "clarified": a rota na FILHA conta de onde a decisão veio (transparência)
	// sem a raiz virar a IDE (sequestro).
	if !hadCommand && (strings.TrimSpace(prompt.Specialist) == "" || opts.clarified) &&
		masterDelegates(session, definition) {
		if opts.clarified {
			route.Reason = protocol.RouteClarified
			route.Confidence = 1
		}
		return s.masterDelegate(ctx, sessionID, turn, route, definition, question, prompt)
	}

	// 3. O modelo. A escolha do usuário vence a preferência do especialista.
	choice := prompt.Model
	if choice == "" {
		choice = session.Model
	}
	entry, _, err := s.deps.Models.Resolve(definition.ID, choice)
	if err != nil {
		s.fail(sessionID, turn, definition.ID, "sem_modelo", err.Error(), false)
		return err
	}
	route.Model = entry.Model.ID

	if err := s.emit(sessionID, turn, protocol.KindRoute,
		protocol.Actor{Kind: protocol.ActorSupervisor, ID: specialist.MasterID}, route); err != nil {
		return err
	}

	// A sessão passa a lembrar do especialista e do modelo: reabrir a conversa
	// restaura a tela sem esperar o primeiro turno novo.
	if _, err := s.deps.Store.UpdateSession(sessionID, func(meta *store.SessionMeta) {
		meta.Specialist = definition.ID
		meta.Model = entry.Model.ID
		if meta.Title == "" {
			meta.Title = titleFrom(prompt.Text)
		}
	}); err != nil {
		return err
	}

	// 3b. O WORKSPACE AUTOMÁTICO da adoção: um especialista de TRABALHO vai
	// executar (/mode code com pedido, conversa nascida no bot, sticky) e a
	// sessão não tem pasta — sem ela a árvore da IDE morre em "esta sessão não
	// tem pasta de projeto definida" e o bot recusa gravar qualquer arquivo. O
	// contexto é congelado DE NOVO porque o congelamento do começo do turno leu
	// o meta antes da pasta existir — as ferramentas DESTE turno já precisam
	// enxergar o root recém-criado.
	if s.provisionaProjeto(sessionID, turn, definition, question) {
		ctx = s.comWorkspace(ctx, sessionID, turn, "", "", workspace.OriginModel)
	}

	actor := protocol.Actor{
		Kind:       protocol.ActorSpecialist,
		ID:         definition.ID,
		Specialist: definition.ID,
	}

	messages, err := s.buildMessages(sessionID, definition, question, entry.Model.Context)
	if err != nil {
		s.fail(sessionID, turn, definition.ID, "contexto", err.Error(), false)
		return err
	}

	// O orçamento de delegação é do TURNO e é compartilhado com os sub-turnos:
	// três delegações são três, aconteçam elas todas aqui ou espalhadas pela
	// árvore que elas abrem.
	budget := &delegationBudget{}

	// O plano só é reconhecido de quem foi CONVIDADO a planejar (ver
	// planContract): um bloco aibot:plan ecoado por um especialista sem
	// ferramenta de escrita — a pessoa colou um exemplo, o modelo repetiu — não
	// pode congelar o turno esperando aprovação de nada.
	planExpected := s.planContract(definition) != ""

	// O estado do PORTÃO DE NARRAÇÃO deste turno (ver narration.go):
	// `executouEfeito` lembra se ALGUMA ferramenta de efeito rodou com sucesso —
	// é o que separa o "gravei o arquivo" verdadeiro do narrado — e
	// `corrigiuNarracao` capa o laço corretivo em UMA tentativa: reincidência
	// vira falha honesta, nunca uma segunda chance infinita.
	executouEfeito := false
	corrigiuNarracao := false

	var totalUsage modelrouter.Usage
	for round := 0; round < maxToolRounds; round++ {
		s.thinking(sessionID, turn, actor, thinkingLabel(definition, round), false)

		answer, usage, err := s.runModel(ctx, sessionID, turn, actor, entry.Model.ID, messages)
		totalUsage.PromptTokens += usage.PromptTokens
		totalUsage.OutputTokens += usage.OutputTokens
		s.thinking(sessionID, turn, actor, "", true)

		if err != nil {
			if errors.Is(ctx.Err(), context.Canceled) {
				s.done(sessionID, turn, definition.ID, totalUsage, true)
				return nil
			}
			s.fail(sessionID, turn, definition.ID, "modelo", err.Error(), errors.Is(err, modelrouter.ErrTruncated))
			return err
		}

		calls := parseToolCalls(answer)
		delegations := parseDelegations(answer)

		// Plano aprovável: o modelo propôs um plano e o turno PARA aqui, antes
		// de qualquer execução — inclusive das ferramentas que vieram no mesmo
		// texto: um modelo que propõe o plano e já sai executando não propôs
		// nada. A aprovação chega como `reply` e a continuação roda com "plano
		// aprovado" (ver Reply em clarify.go). Mesma pendência da clarificação:
		// pergunta → resposta → continuação.
		if planExpected {
			if plan, proposed := parsePlan(answer); proposed {
				// O texto vai para a conversa COM o bloco do plano: é ele que a
				// pessoa lê para decidir. stripBlocks só tira ferramenta e
				// delegação, que são protocolo de máquina.
				if err := s.emit(sessionID, turn, protocol.KindMessage, actor, protocol.Message{
					Role:       "assistant",
					Text:       stripBlocks(answer),
					Specialist: definition.ID,
					Model:      entry.Model.ID,
				}); err != nil {
					return err
				}
				s.askPlan(sessionID, turn, definition, plan)
				s.done(sessionID, turn, definition.ID, totalUsage, false)
				return nil
			}
		}

		if len(calls) == 0 && len(delegations) == 0 {
			// O PORTÃO DE NARRAÇÃO (ver narration.go): especialista de trabalho
			// que DESCREVE resultado de ferramenta sem nenhum efeito consumado no
			// turno não publica essa resposta como boa. Primeiro flagrante: UMA
			// correção de sistema e mais um giro; reincidência: falha honesta —
			// "não executado" não pode sair com cara de ✓.
			if narrouSemExecutar(definition, answer, executouEfeito) {
				if !corrigiuNarracao {
					corrigiuNarracao = true
					// Telemetria honesta: a pessoa vê o portão agindo em vez de a
					// resposta só demorar um giro a mais sem explicação.
					s.thinking(sessionID, turn, actor, avisoDeNarracao, false)
					messages = append(messages,
						modelrouter.ChatMessage{Role: "assistant", Content: answer},
						modelrouter.ChatMessage{Role: "system", Content: correcaoDeNarracao})
					continue
				}
				s.fail(sessionID, turn, definition.ID, narracaoFailCode,
					narracaoFailMessage(answer), true)
				return nil
			}
			// A ENTREGA vem antes do anúncio: o staging do turno é promovido ao
			// projeto AGORA — cerca de worker+época, espelho, limpeza — para a
			// mensagem final e o done só saírem depois de o resultado existir
			// onde a pessoa olha. Promoção recusada é falha honesta do turno
			// (o defer descarta a cópia), nunca um ✓ sobre trabalho não entregue.
			if err := s.entregaWorkspace(ctx, sessionID, turn); err != nil {
				s.fail(sessionID, turn, definition.ID, "entrega_do_workspace",
					"o resultado não pôde ser entregue ao projeto: "+err.Error(), true)
				return nil
			}
			// A resposta final entra no log inteira. Os deltas já foram
			// entregues, mas eles são EFÊMEROS: quem abrir a conversa amanhã lê
			// esta mensagem, não a soma de mil pedacinhos.
			if err := s.emit(sessionID, turn, protocol.KindMessage, actor, protocol.Message{
				Role:       "assistant",
				Text:       stripBlocks(answer),
				Specialist: definition.ID,
				Model:      entry.Model.ID,
			}); err != nil {
				return err
			}
			s.done(sessionID, turn, definition.ID, totalUsage, false)
			return nil
		}

		// Houve ferramenta ou delegação: a fala do modelo até aqui vale como
		// mensagem, e o que voltar delas entra como contexto do próximo giro.
		visible := strings.TrimSpace(stripBlocks(answer))
		if visible != "" {
			if err := s.emit(sessionID, turn, protocol.KindMessage, actor, protocol.Message{
				Role:       "assistant",
				Text:       visible,
				Specialist: definition.ID,
				Model:      entry.Model.ID,
			}); err != nil {
				return err
			}
		}
		messages = append(messages, modelrouter.ChatMessage{Role: "assistant", Content: answer})

		if len(calls) > 0 {
			results := make([]string, 0, len(calls))
			for _, call := range calls {
				result, executou := s.executeTool(ctx, sessionID, turn, actor, definition, call)
				// Só o efeito CONSUMADO cala o portão de narração: recusa e erro
				// não produziram nada que a resposta final possa anunciar.
				if executou && ferramentaDeEfeito(call.Tool) {
					executouEfeito = true
				}
				results = append(results, result)
			}
			messages = append(messages, modelrouter.ChatMessage{
				Role:    "user",
				Content: "Resultado das ferramentas:\n\n" + strings.Join(results, "\n\n"),
			})
		}

		// A delegação volta como contexto, do mesmo jeito que a ferramenta —
		// numa mensagem separada porque é outra coisa: quem responde continua
		// sendo este especialista, e o texto que voltou é a fala de um colega,
		// não a saída de um comando.
		//
		// O especialista e o modelo do turno NÃO mudam aqui, e o modo gravado na
		// conversa também não: delegar é emprestar especialidade, não trocar de
		// dono. Quem troca o modo é `/mode`.
		if len(delegations) > 0 {
			results := make([]string, 0, len(delegations))
			for _, request := range delegations {
				results = append(results,
					s.delegate(ctx, sessionID, turn, definition, request, budget, firstDelegationDepth))
			}
			messages = append(messages, modelrouter.ChatMessage{
				Role:    "user",
				Content: "Resultado da delegação:\n\n" + strings.Join(results, "\n\n"),
			})
		}
	}

	s.fail(sessionID, turn, definition.ID, "laco_de_ferramenta",
		fmt.Sprintf("o especialista chamou ferramenta %d vezes seguidas sem concluir — o turno foi encerrado", maxToolRounds),
		true)
	return nil
}

// Cancel interrompe o turno em andamento.
func (s *Supervisor) Cancel(sessionID string) {
	s.mu.Lock()
	handle, ok := s.running[sessionID]
	delete(s.running, sessionID)
	s.mu.Unlock()
	if ok {
		handle.cancel()
	}
}

// Busy diz se a sessão tem turno rodando.
func (s *Supervisor) Busy(sessionID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.running[sessionID]
	return ok
}

/* -------------------------------- modelo -------------------------------- */

// streamSink publica cada pedaço no barramento enquanto acumula o texto.
type streamSink struct {
	supervisor *Supervisor
	session    string
	turn       string
	actor      protocol.Actor
	builder    strings.Builder
}

func (s *streamSink) Delta(text string) error {
	s.builder.WriteString(text)
	// Delta é EFÊMERO: não vai para o log. Gravar token a token faria o replay
	// reencenar a digitação inteira e multiplicaria o tamanho do arquivo pelo
	// número de pedaços — a mensagem completa é gravada uma vez no fim.
	s.supervisor.deps.Bus.PublishEphemeral(s.session, protocol.Envelope{
		V:       protocol.Version,
		TS:      time.Now().UTC(),
		Session: s.session,
		Turn:    s.turn,
		Kind:    protocol.KindDelta,
		From:    s.actor,
		Payload: mustPayload(protocol.Delta{Text: text}),
	})
	return nil
}

func (s *streamSink) Reasoning(text string) error {
	// `Reasoning: true` é o que separa este texto do rótulo de etapa que sai
	// por `thinking()`: sem a marca, o cliente só podia piscar cada pedaço no
	// orbe e jogar o texto fora — agora ele acumula num bloco recolhível.
	s.supervisor.deps.Bus.PublishEphemeral(s.session, protocol.Envelope{
		V:       protocol.Version,
		TS:      time.Now().UTC(),
		Session: s.session,
		Turn:    s.turn,
		Kind:    protocol.KindThinking,
		From:    s.actor,
		Payload: mustPayload(protocol.Thinking{Label: text, Reasoning: true}),
	})
	return nil
}

func (s *Supervisor) runModel(
	ctx context.Context,
	sessionID, turn string,
	actor protocol.Actor,
	model string,
	messages []modelrouter.ChatMessage,
) (string, modelrouter.Usage, error) {
	sink := &streamSink{supervisor: s, session: sessionID, turn: turn, actor: actor}

	// FUSION: várias cabeças num turno só.
	//
	// Entra aqui, e não no roteador de modelos, porque é aqui que existem as
	// duas coisas de que ele precisa — o especialista que está atendendo (para
	// a política de papéis) e o sink que leva os deltas à tela. O turno inteiro
	// continua igual do lado de fora: entra `messages`, sai texto.
	if preset, temFusion := s.presetDeFusion(actor.Specialist); temFusion && len(messages) > 0 {
		texto, err := s.rodarFusion(ctx, sessionID, preset, actor.Specialist, messages, sink)
		// O uso não é somado por etapa: cada sub-chamada tem o seu, e o
		// roteador só devolve o da chamada que ele fez. Contabilizar fusion por
		// dentro é trabalho da próxima rodada — e é melhor devolver zero do que
		// um número inventado.
		return texto, modelrouter.Usage{}, err
	}

	usage, err := s.deps.Models.Stream(ctx, modelrouter.Request{
		Model:          model,
		Messages:       messages,
		ConversationID: sessionID,
	}, sink)
	return sink.builder.String(), usage, err
}

// presetDeFusion devolve o preset configurado para o especialista, se houver.
func (s *Supervisor) presetDeFusion(specialist string) (fusion.Preset, bool) {
	if s.deps.Fusion == nil || specialist == "" {
		return fusion.Preset{}, false
	}
	return s.deps.Fusion.PresetFor(specialist)
}

// rodarFusion traduz o turno para o motor de fusion e de volta.
//
// A última mensagem é a PERGUNTA e o resto é histórico — a mesma divisão do
// motor original, e ela importa: os construtores de prompt do fusion já incluem
// a pergunta, então mandá-la duas vezes faria cada etapa recebê-la em dobro.
func (s *Supervisor) rodarFusion(
	ctx context.Context,
	sessionID string,
	preset fusion.Preset,
	specialist string,
	messages []modelrouter.ChatMessage,
	sink *streamSink,
) (string, error) {
	pergunta := messages[len(messages)-1].Content
	historico := messages[:len(messages)-1]

	deps := fusion.Deps{
		// Quiet é bastidor: o texto inteiro, sem passar pela tela.
		Quiet: func(ctx context.Context, model string, m []modelrouter.ChatMessage) (string, error) {
			texto, _, err := s.deps.Models.Complete(ctx, modelrouter.Request{
				Model:          model,
				Messages:       m,
				ConversationID: sessionID,
			})
			return texto, err
		},
		// Stream é o que a pessoa vê chegando — e só uma etapa por turno usa
		// isto, senão dois textos disputariam a mesma bolha.
		Stream: func(ctx context.Context, model string, m []modelrouter.ChatMessage) (string, error) {
			_, err := s.deps.Models.Stream(ctx, modelrouter.Request{
				Model:          model,
				Messages:       m,
				ConversationID: sessionID,
			}, sink)
			return sink.builder.String(), err
		},
		Stage: func(texto string) {
			s.thinking(sessionID, sink.turn, sink.actor, texto, false)
		},
	}

	return fusion.Run(ctx, preset, specialist, pergunta, historico, deps)
}

/* ------------------------------- contexto ------------------------------- */

// buildMessages monta o prompt do turno. A ORDEM é a regra:
//
//  1. prompt master do admin  (nenhum especialista o remove)
//  2. prompt do especialista
//  3. prompt dos pacotes corporativos (complementa o especialista; nunca o master)
//  4. contrato de ferramentas (só se ele tiver ferramentas liberadas)
//  5. contrato de plano (só para quem tem ferramenta de escrita)
//  6. contrato de delegação (só se sobrar alguém para chamar)
//  7. memórias relevantes
//  8. histórico da conversa
//  9. arquivos citados com @
//
// policyHeader é o cabeçalho de system que TODO modelo desta casa recebe, seja
// ele o dono da conversa, um delegado ou um trabalhador de equipe: a política do
// admin primeiro, depois o system do especialista, depois o que os pacotes
// corporativos acrescentam.
//
// Existe como um lugar só porque já foram três montagens à mão e uma delas
// esquecia o master: o trabalhador de equipe recebia apenas `definition.System`.
// Bastava o modo agente despachar uma tarefa — para qualquer especialista — e a
// política corporativa deixava de valer, sem erro e sem aviso. A ordem importa e
// é sempre esta: pacote complementa o especialista, e nem pacote nem
// especialista passam por cima do admin.
func (s *Supervisor) policyHeader(definition specialist.Definition) []modelrouter.ChatMessage {
	header := make([]modelrouter.ChatMessage, 0, 3)
	if s.deps.PromptMaster != nil {
		if master := strings.TrimSpace(s.deps.PromptMaster()); master != "" {
			header = append(header, modelrouter.ChatMessage{Role: "system", Content: master})
		}
	}
	header = append(header, modelrouter.ChatMessage{Role: "system", Content: definition.System})
	if s.deps.PackPrompt != nil {
		if extra := strings.TrimSpace(s.deps.PackPrompt(definition.ID)); extra != "" {
			header = append(header, modelrouter.ChatMessage{Role: "system", Content: extra})
		}
	}
	return header
}

func (s *Supervisor) buildMessages(
	sessionID string,
	definition specialist.Definition,
	question string,
	contextTokens int,
) ([]modelrouter.ChatMessage, error) {
	messages := make([]modelrouter.ChatMessage, 0, maxHistoryMessages+6)
	messages = append(messages, s.policyHeader(definition)...)

	if contract := s.toolContract(definition); contract != "" {
		messages = append(messages, modelrouter.ChatMessage{Role: "system", Content: contract})
	}
	if contract := s.planContract(definition); contract != "" {
		messages = append(messages, modelrouter.ChatMessage{Role: "system", Content: contract})
	}
	if contract := s.delegateContract(definition, firstDelegationDepth); contract != "" {
		messages = append(messages, modelrouter.ChatMessage{Role: "system", Content: contract})
	}

	if s.deps.Memory != nil {
		if hits := s.deps.Memory.Search(question, 5); len(hits) > 0 {
			var recalled strings.Builder
			recalled.WriteString("Memórias que podem ser relevantes (use se ajudar; ignore se não):\n")
			ids := make([]string, 0, len(hits))
			for _, hit := range hits {
				fmt.Fprintf(&recalled, "- [%s] %s: %s\n", hit.Item.Kind, hit.Item.Title, hit.Item.Content)
				ids = append(ids, hit.Item.ID)
			}
			messages = append(messages, modelrouter.ChatMessage{Role: "system", Content: recalled.String()})
			_ = s.deps.Memory.Touch(ids)
		}
	}

	// A CÁPSULA DE ESTADO (Context Runtime): o destilado de tudo o que a janela
	// recente já não alcança. Antes dela, uma conversa de 200 turnos chegava ao
	// modelo como as últimas 40 mensagens e NADA mais — objetivo, decisões e
	// erros antigos simplesmente sumiam. A cápsula entra ANTES da cauda: é
	// estado, e a cauda verbatim é a recência.
	if rendered := s.capsuleMessage(sessionID); rendered != "" {
		messages = append(messages, modelrouter.ChatMessage{Role: "system", Content: rendered})
	}

	history, err := s.history(sessionID)
	if err != nil {
		return nil, err
	}
	messages = append(messages, history...)

	// O prompt já foi gravado como mensagem e volta pelo histórico; acrescentá-lo
	// de novo faria o modelo ver a pergunta duas vezes.
	//
	// O corte por TAMANHO é o último passo, e é o que impede a conversa de morrer
	// depois de uma colagem grande: o corte por contagem (40 mensagens) não olha
	// o que cada uma pesa. Ver context_budget.go.
	return fitToContext(messages, contextTokens), nil
}

// history reconstrói a conversa a partir do log.
func (s *Supervisor) history(sessionID string) ([]modelrouter.ChatMessage, error) {
	// A janela é lida a partir do FIM do log, não do começo. `Since` devolve os
	// PRIMEIROS `limit` envelopes depois do cursor, então ler a partir do zero
	// numa sessão com mais de MaxEventBatch eventos entregaria para sempre o
	// começo da conversa — inclusive a pergunta atual, que acabou de ser
	// gravada, ficaria de fora e o modelo responderia à mensagem de meses atrás.
	last, err := s.deps.Store.LastSeq(sessionID)
	if err != nil {
		return nil, err
	}
	var from uint64
	if last > store.MaxEventBatch {
		from = last - store.MaxEventBatch
	}

	envelopes, err := s.deps.Store.Since(sessionID, from, store.MaxEventBatch)
	if err != nil {
		return nil, err
	}
	out := make([]modelrouter.ChatMessage, 0, len(envelopes))
	for _, envelope := range envelopes {
		switch envelope.Kind {
		case protocol.KindMessage:
			var message protocol.Message
			if err := envelope.Decode(&message); err != nil {
				continue
			}
			if strings.TrimSpace(message.Text) == "" {
				continue
			}
			out = append(out, modelrouter.ChatMessage{Role: message.Role, Content: message.Text})

		// A EVIDÊNCIA volta ao histórico.
		//
		// Antes só `KindMessage` era dobrado, e o par chamada+resultado sumia entre
		// um turno e o seguinte: o modelo entrava no turno 2 vendo "o arquivo diz
		// 42" — a própria afirmação dele — e nenhum traço do que o arquivo continha
		// nem de que houve leitura. Ou relia (custo, e aprovação de novo), ou seguia
		// em cima da própria alegação, que é como resposta plausível vira invenção.
		// Pior justamente no especialista de código, onde a evidência é o arquivo.
		//
		// UMA mensagem por par, e não duas: o "Chamei a ferramenta X." separado
		// podia ser cortado do resultado pelo orçamento (ou o contrário), e uma
		// unidade lógica nunca deve ser partida ao caber a janela. A evidência é
		// autodescritiva — o nome da ferramenta está nela.
		case protocol.KindToolResult:
			var result protocol.ToolResult
			if err := envelope.Decode(&result); err != nil || result.Tool == "" {
				continue
			}
			body := result.Output
			if !result.OK {
				body = "falhou: " + result.Error
			}
			if strings.TrimSpace(body) == "" {
				continue
			}
			// Truncado bem mais curto que os 20 000 do log: aqui o texto disputa a
			// janela do modelo com a conversa inteira, e a saída de um `fs.read`
			// grande sozinha empurraria tudo para fora.
			out = append(out, modelrouter.ChatMessage{
				Role:    "user",
				Content: toolEvidence(result.Tool, truncate(body, 2000)),
			})

		// A DELEGAÇÃO também volta — pelo mesmo motivo da evidência de
		// ferramenta. Sem esta dobra, o turno seguinte via só a síntese final do
		// dono: nem o fato estruturado "deleguei X ao bot Y", nem o resultado
		// bruto do delegado. O dono então redelegava a mesma coisa ou afirmava
		// de memória o que era do outro — a caixa-preta clássica de sub-agente.
		// A delegação é gravada DUAS vezes (abre e fecha), e a chave é o Done:
		// o envelope inicial vira o pedido, o final vira o resultado.
		case protocol.KindDelegate:
			var delegation protocol.Delegate
			if err := envelope.Decode(&delegation); err != nil || delegation.To == "" {
				continue
			}
			if !delegation.Done {
				out = append(out, modelrouter.ChatMessage{
					Role:    "assistant",
					Content: fmt.Sprintf("Deleguei ao especialista %s: %s", delegation.To, truncate(delegation.Goal, 400)),
				})
				continue
			}
			if strings.TrimSpace(delegation.Result) == "" {
				continue
			}
			out = append(out, modelrouter.ChatMessage{
				Role:    "user",
				Content: fmt.Sprintf("Resultado do especialista %s:\n%s", delegation.To, truncate(delegation.Result, 2000)),
			})
		}
	}
	// Corta pelo FIM: o começo da conversa é o que menos importa para o próximo
	// turno, e cortar pelo começo descartaria justamente a pergunta atual.
	if len(out) > maxHistoryMessages {
		out = out[len(out)-maxHistoryMessages:]
	}
	return out, nil
}

// toolContract descreve as ferramentas e o formato de chamada.
//
// A chamada de ferramenta é por BLOCO CERCADO, e não pelo function-calling
// nativo de cada provedor, por uma razão de produto: o usuário escolhe o
// modelo, e nem todo modelo do catálogo tem function-calling — nem os que têm
// concordam no formato. Um contrato em texto funciona no catálogo inteiro,
// inclusive no modelo local. O custo é o modelo poder errar o JSON, e é por
// isso que o erro de parse volta para ele como resultado, em vez de virar
// exceção.
func (s *Supervisor) toolContract(definition specialist.Definition) string {
	if len(definition.Tools) == 0 || !s.deps.Gate.Policy().AgentTools {
		return ""
	}
	available := make([]string, 0, len(definition.Tools))
	for _, tool := range definition.Tools {
		if describe := s.deps.Tools.Describe(tool); describe != "" {
			available = append(available, "- "+tool+": "+describe)
		}
	}
	if len(available) == 0 {
		return ""
	}
	contract := "Você pode usar ferramentas. Para chamar uma, emita um bloco cercado exatamente assim:\n\n" +
		"```aibot:tool\n{\"tool\":\"<nome>\",\"args\":{...}}\n```\n\n" +
		"Regras: um bloco por chamada; JSON válido; nada de texto dentro do bloco além do JSON. " +
		"Depois de chamar, PARE e espere o resultado — ele chega como a próxima mensagem. " +
		"Não invente resultado de ferramenta. Se o resultado vier com erro, leia o erro e corrija a chamada."
	// O EXEMPLO CONCRETO entra para o especialista de TRABALHO que grava
	// arquivo: modelos menores erram o formato quando só veem o exemplo
	// abstrato ({...}), e errar o formato aqui é narrar em vez de executar — o
	// flagrante do portão de narração (ver narration.go). O chat fica com o
	// contrato genérico (a superfície dele é o próprio texto) e quem não tem
	// fs.write também: exemplificar uma ferramenta que o portão recusa
	// ensinaria o modelo a bater na porta errada.
	if especialistaDeTrabalho(definition) && definition.AllowsTool("fs.write") {
		contract += "\n\nExemplo real — gravar um arquivo do projeto:\n\n" + exemploDeCercaDeFerramenta
	}
	return contract + "\n\nFerramentas disponíveis:\n" + strings.Join(available, "\n")
}

/* ------------------------------ ferramentas ----------------------------- */

// toolInvocation é uma chamada extraída da resposta.
type toolInvocation struct {
	Tool string          `json:"tool"`
	Args json.RawMessage `json:"args"`
	// raw guarda o texto original, para a mensagem de erro citar o que veio.
	raw string
}

const toolFence = "```aibot:tool"

// parseToolCalls extrai as chamadas do texto do modelo.
func parseToolCalls(answer string) []toolInvocation {
	var out []toolInvocation
	rest := answer
	for {
		start := strings.Index(rest, toolFence)
		if start < 0 {
			return out
		}
		rest = rest[start+len(toolFence):]
		end := strings.Index(rest, "```")
		if end < 0 {
			// Bloco aberto e não fechado: o modelo cortou no meio. Ignorar é o
			// certo — executar um JSON truncado seria executar outra coisa.
			return out
		}
		body := strings.TrimSpace(rest[:end])
		rest = rest[end+3:]

		var call toolInvocation
		call.raw = body
		if err := json.Unmarshal([]byte(body), &call); err != nil || call.Tool == "" {
			// Guarda a chamada mesmo assim: o erro precisa VOLTAR para o modelo,
			// senão ele repete o mesmo JSON quebrado para sempre.
			out = append(out, toolInvocation{raw: body})
			continue
		}
		out = append(out, call)
	}
}

// stripToolBlocks tira os blocos de ferramenta do texto mostrado à pessoa.
func stripToolBlocks(answer string) string {
	var builder strings.Builder
	rest := answer
	for {
		start := strings.Index(rest, toolFence)
		if start < 0 {
			builder.WriteString(rest)
			return strings.TrimSpace(builder.String())
		}
		builder.WriteString(rest[:start])
		rest = rest[start+len(toolFence):]
		end := strings.Index(rest, "```")
		if end < 0 {
			return strings.TrimSpace(builder.String())
		}
		rest = rest[end+3:]
	}
}

// executeTool roda uma chamada passando pelo portão. Devolve SEMPRE um texto
// para voltar ao modelo — inclusive quando recusa, porque o modelo precisa
// saber que foi recusado para tentar outro caminho em vez de repetir — e um
// booleano dizendo se a ferramenta EXECUTOU de verdade.
//
// O booleano existe para o portão de narração (ver narration.go): "houve
// efeito neste turno?" não pode ser deduzido do texto de retorno, que é frase
// montada para modelo ler — parseá-la acoplaria o portão a uma redação.
func (s *Supervisor) executeTool(
	ctx context.Context,
	sessionID, turn string,
	actor protocol.Actor,
	definition specialist.Definition,
	call toolInvocation,
) (string, bool) {
	if call.Tool == "" {
		return fmt.Sprintf("ERRO: bloco de ferramenta com JSON inválido. Recebido:\n%s", truncate(call.raw, 500)), false
	}

	callID := s.nextID("c")
	// O digest carrega o ESCOPO, e não só a ferramenta e os argumentos.
	//
	// "Aprovar sempre" com digest de `tool+args` puro dava um cheque que valia em
	// qualquer lugar: aprovar `fs.write` em `deploy/ci.yml` olhando o `code` no
	// repositório A liberava o MESMO caminho relativo no repositório B, e liberava
	// também o `design`, que tem `fs.write` no catálogo. O "sim" foi dado olhando
	// um projeto e um especialista; é a esses dois que ele tem de ficar preso.
	digest := digestOf(s.approvalScope(sessionID, definition.ID), call.Tool, call.Args)
	risk := permissions.RiskOf(call.Tool)

	_ = s.emit(sessionID, turn, protocol.KindToolCall, actor, protocol.ToolCall{
		CallID: callID,
		Tool:   call.Tool,
		Args:   call.Args,
		Digest: digest,
	})

	decision, reason := s.deps.Gate.Evaluate(definition.ID, call.Tool, risk, digest)
	switch decision {
	case permissions.DecisionDeny:
		s.toolResult(sessionID, turn, actor, callID, call.Tool, false, "", reason, 0)
		return fmt.Sprintf("RECUSADO (%s): %s", call.Tool, reason), false
	case permissions.DecisionAsk:
		allowed, why := s.askApproval(ctx, sessionID, turn, actor, callID, call, risk, digest)
		if !allowed {
			s.toolResult(sessionID, turn, actor, callID, call.Tool, false, "", why, 0)
			return fmt.Sprintf("RECUSADO PELO USUÁRIO (%s): %s", call.Tool, why), false
		}
	}

	// Ganchos de ANTES (before_tool / before_edit), depois de todas as
	// aprovações: o deny de pacote é o último portão antes do efeito colateral,
	// e as ações observadoras registram exatamente o que está prestes a rodar.
	// Recusa de gancho volta ao modelo como qualquer recusa — com o motivo.
	if s.deps.Hooks != nil {
		if denied, why := s.deps.Hooks.Before(ctx, HookInfo{
			Event: HookBeforeTool, TS: time.Now().UTC(),
			Session: sessionID, Turn: turn, Specialist: definition.ID,
			Tool: call.Tool, Digest: digest,
		}); denied {
			s.toolResult(sessionID, turn, actor, callID, call.Tool, false, "", why, 0)
			return fmt.Sprintf("RECUSADO PELA POLÍTICA DE PACOTE (%s): %s", call.Tool, why), false
		}
	}

	started := time.Now()
	output, err := s.deps.Tools.Call(ctx, call.Tool, sessionID, call.Args)
	elapsed := time.Since(started).Milliseconds()

	// Ganchos de DEPOIS (after_tool / after_edit): observam o desfecho — ok ou
	// erro — e nunca mudam o rumo do turno. Rodam antes do retorno ao modelo
	// para a auditoria ficar na ordem em que as coisas aconteceram.
	if s.deps.Hooks != nil {
		failure := ""
		if err != nil {
			failure = err.Error()
		}
		s.deps.Hooks.Notify(ctx, HookInfo{
			Event: HookAfterTool, TS: time.Now().UTC(),
			Session: sessionID, Turn: turn, Specialist: definition.ID,
			Tool: call.Tool, Digest: digest, OK: err == nil, Error: failure,
		})
	}

	if err != nil {
		s.toolResult(sessionID, turn, actor, callID, call.Tool, false, "", err.Error(), elapsed)
		return fmt.Sprintf("ERRO em %s: %s", call.Tool, err.Error()), false
	}

	// O TOOL OUTPUT GATEWAY (ver tool_gateway.go): a saída grande vira artefato
	// integral + projeção início/fim. É a projeção que entra no LOG e volta ao
	// modelo — a janela nunca carrega o dump, e o integral fica recuperável em
	// fatias por context.fetch.
	projected, artifactRef, rawBytes, wasTruncated := s.projectToolOutput(sessionID, call.Tool, output)
	_ = s.emit(sessionID, turn, protocol.KindToolResult, actor, protocol.ToolResult{
		CallID:      callID,
		Tool:        call.Tool,
		OK:          true,
		Output:      truncate(projected, 20000),
		Elapsed:     elapsed,
		Truncated:   wasTruncated,
		ArtifactRef: artifactRef,
		RawBytes:    rawBytes,
	})
	return fmt.Sprintf("%s =>\n%s", call.Tool, truncate(projected, 20000)), true
}

// askApproval publica o pedido e espera a decisão humana.
func (s *Supervisor) askApproval(
	ctx context.Context,
	sessionID, turn string,
	actor protocol.Actor,
	callID string,
	call toolInvocation,
	risk protocol.Risk,
	digest string,
) (bool, string) {
	channel := make(chan protocol.ApprovalDecision, 1)
	s.mu.Lock()
	s.waiting[callID] = channel
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.waiting, callID)
		s.mu.Unlock()
	}()

	_ = s.emit(sessionID, turn, protocol.KindApprovalRequest, actor, protocol.ApprovalRequest{
		CallID:  callID,
		Tool:    call.Tool,
		Risk:    risk,
		Summary: summarize(call.Tool, call.Args),
		Detail:  truncate(string(call.Args), 2000),
		Digest:  digest,
	})

	timer := time.NewTimer(approvalTimeout)
	defer timer.Stop()

	select {
	case decision := <-channel:
		// A decisão vira ENVELOPE DURÁVEL antes de qualquer efeito.
		//
		// Sem ela o log ficava `tool.call → approval.request → tool.result(ok)`, e
		// lendo depois não dava para distinguir "a pessoa autorizou" de "a política
		// era aprovar tudo" ou "havia concessão anterior" — sumia justamente o
		// registro do último degrau antes do efeito colateral. O verbo já existia no
		// protocolo e no reducer da tela, e não tinha emissor nenhum no gateway; é
		// também por ele que uma segunda janela fecha o cartão.
		_ = s.emit(sessionID, turn, protocol.KindApprovalDecision,
			protocol.Actor{Kind: protocol.ActorUser}, protocol.ApprovalDecision{
				CallID:  callID,
				Allow:   decision.Allow,
				Scope:   decision.Scope,
				Comment: decision.Comment,
			})
		if decision.Allow {
			s.deps.Gate.Grant(decision.Scope, actor.Specialist, call.Tool, digest)
			return true, ""
		}
		if decision.Comment != "" {
			return false, decision.Comment
		}
		return false, "a pessoa recusou a execução"
	case <-timer.C:
		// Silêncio NÃO é consentimento.
		return false, "ninguém decidiu dentro do prazo — a execução foi recusada por segurança"
	case <-ctx.Done():
		return false, "o turno foi cancelado antes da decisão"
	}
}

// Decide entrega a decisão humana ao turno que está esperando.
func (s *Supervisor) Decide(decision protocol.ApprovalDecision) error {
	s.mu.Lock()
	channel, ok := s.waiting[decision.CallID]
	s.mu.Unlock()
	if !ok {
		return fmt.Errorf("nenhuma aprovação pendente para %s", decision.CallID)
	}
	select {
	case channel <- decision:
		return nil
	default:
		// Já decidida: a segunda decisão é ruído (dois cliques, dois clientes).
		return nil
	}
}

/* -------------------------------- emissão ------------------------------- */

func (s *Supervisor) emit(sessionID, turn string, kind protocol.Kind, from protocol.Actor, payload any) error {
	envelope := &protocol.Envelope{
		V:       protocol.Version,
		ID:      s.nextID("e"),
		TS:      time.Now().UTC(),
		Session: sessionID,
		Turn:    turn,
		Kind:    kind,
		From:    from,
	}
	if err := envelope.SetPayload(payload); err != nil {
		return err
	}
	_, err := s.deps.Bus.Publish(sessionID, envelope)
	return err
}

func (s *Supervisor) toolResult(
	sessionID, turn string, actor protocol.Actor,
	callID, tool string, ok bool, output, failure string, elapsed int64,
) {
	_ = s.emit(sessionID, turn, protocol.KindToolResult, actor, protocol.ToolResult{
		CallID:  callID,
		Tool:    tool,
		OK:      ok,
		Output:  truncate(output, 20000),
		Error:   failure,
		Elapsed: elapsed,
	})
}

func (s *Supervisor) thinking(sessionID, turn string, actor protocol.Actor, label string, done bool) {
	s.deps.Bus.PublishEphemeral(sessionID, protocol.Envelope{
		V:       protocol.Version,
		TS:      time.Now().UTC(),
		Session: sessionID,
		Turn:    turn,
		Kind:    protocol.KindThinking,
		From:    actor,
		Payload: mustPayload(protocol.Thinking{Label: label, Done: done}),
	})
}

func (s *Supervisor) done(sessionID, turn, specialistID string, usage modelrouter.Usage, interrupted bool) {
	_ = s.emit(sessionID, turn, protocol.KindDone,
		protocol.Actor{Kind: protocol.ActorSupervisor, Specialist: specialistID}, protocol.Done{
			Turn:         turn,
			Specialist:   specialistID,
			OutputTokens: usage.OutputTokens,
			Interrupted:  interrupted,
		})
	// on_complete dos pacotes. Contexto de fundo porque o turno pode ter sido
	// CANCELADO — e o fim do turno é exatamente o que a auditoria quer ver.
	if s.deps.Hooks != nil {
		s.deps.Hooks.Notify(context.Background(), HookInfo{
			Event: HookOnComplete, TS: time.Now().UTC(),
			Session: sessionID, Turn: turn, Specialist: specialistID, OK: !interrupted,
		})
	}
}

func (s *Supervisor) fail(sessionID, turn, specialistID, code, message string, retryable bool) {
	_ = s.emit(sessionID, turn, protocol.KindError,
		protocol.Actor{Kind: protocol.ActorSupervisor, Specialist: specialistID}, protocol.Error{
			Code:      code,
			Message:   message,
			Retryable: retryable,
		})
	// on_error dos pacotes — o evento que a SI mais pede para receber por
	// webhook. Falha do gancho não muda nada aqui: o turno já falhou.
	if s.deps.Hooks != nil {
		s.deps.Hooks.Notify(context.Background(), HookInfo{
			Event: HookOnError, TS: time.Now().UTC(),
			Session: sessionID, Turn: turn, Specialist: specialistID,
			Error: code + ": " + message,
		})
	}
}

// ReportTurnFailure publica na sessão um erro que aconteceu ANTES de o turno
// existir.
//
// `runTurn` tem saídas antecipadas — prompt inválido, sessão que não abre, log
// que recusa a escrita — que devolvem `error` sem nunca ter carimbado um id de
// turno, e portanto sem emitir envelope nenhum. Quem chama só registrava no log
// do SERVIDOR. Do lado de cá do fio isso é indistinguível de um turno que
// simplesmente nunca responde: a tela mantém `busy`, o orbe gira e o único botão
// vivo é o de parar.
//
// Existe como método exportado porque quem descobre a falha é o transporte, e
// ele não tem (nem deve ter) acesso ao barramento por fora do supervisor.
func (s *Supervisor) ReportTurnFailure(sessionID string, err error) {
	if s == nil || err == nil || strings.TrimSpace(sessionID) == "" {
		return
	}
	// Turno vazio de propósito: não houve turno. O cliente fecha o `busy` pelo
	// verbo, não pelo id.
	s.fail(sessionID, "", "", "turno_nao_iniciou", err.Error(), true)
}

/* -------------------------------- apoio --------------------------------- */

/* --------------------------- cápsula de estado ---------------------------- */

// capsuleBlobName é o blob da sessão onde a cápsula vive.
const capsuleBlobName = "capsule"

// capsuleMessage devolve a cápsula renderizada para o prompt — vazia quando a
// sessão ainda não dobrou nada (conversa nova não paga por estado que não tem).
func (s *Supervisor) capsuleMessage(sessionID string) string {
	if s.deps.Store == nil {
		return ""
	}
	data, err := s.deps.Store.LoadSessionBlob(sessionID, capsuleBlobName)
	if err != nil || len(data) == 0 {
		return ""
	}
	return contextrt.Load(data).Render()
}

// foldCapsule dobra os envelopes novos da sessão para dentro da cápsula.
//
// Roda no FIM de cada turno (o `done` é o fim de fase natural da conversa —
// a compactação por fase da especificação), fora do caminho da resposta: a
// pessoa nunca espera a dobra. Incremental por cursor: só os envelopes que a
// cápsula ainda não viu são lidos.
//
// A trava é POR SESSÃO: um turno substituído pode terminar a dobra dele
// enquanto o substituto termina a própria, e duas dobras lendo o mesmo cursor
// dobrariam os mesmos eventos duas vezes.
func (s *Supervisor) foldCapsule(sessionID string) {
	if s.deps.Store == nil {
		return
	}
	lock, _ := s.capsuleLocks.LoadOrStore(sessionID, &sync.Mutex{})
	mutex := lock.(*sync.Mutex)
	mutex.Lock()
	defer mutex.Unlock()

	data, err := s.deps.Store.LoadSessionBlob(sessionID, capsuleBlobName)
	if err != nil {
		return
	}
	capsule := contextrt.Load(data)

	// Se a sessão não tem cabeçalho de objetivo ainda, o título serve de
	// semente — validação da compactação: cápsula sem objetivo não presta.
	if capsule.Goal == "" {
		if meta, err := s.deps.Store.GetSession(sessionID); err == nil {
			capsule.Goal = meta.Title
		}
	}

	for {
		batch, err := s.deps.Store.Since(sessionID, capsule.Cursor, store.MaxEventBatch)
		if err != nil || len(batch) == 0 {
			break
		}
		capsule.Fold(batch)
		if len(batch) < store.MaxEventBatch {
			break
		}
	}

	if serialized, err := capsule.Marshal(); err == nil {
		_ = s.deps.Store.SaveSessionBlob(sessionID, capsuleBlobName, serialized)
	}
}

// comWorkspace congela o plano de workspace e pendura a execução no contexto.
//
// UMA vez por turno/tarefa, nunca por ferramenta: resolver o workspace a cada
// fs.read abriria a janela clássica — fs.read na época 17, a tarefa é
// reatribuída, fs.write na época 18, em outro worker. O plano congelado é o
// que garante que todas as ferramentas do mesmo turno enxergam o mesmo root.
//
// A ORIGEM decide o sandbox: o turno de MODELO (OriginModel) sobre um projeto
// provisionado é materializado numa CÓPIA — as ferramentas dele agem nela e só
// a promoção (entregaWorkspace) espelha o resultado no projeto. A UI
// (OriginUI) continua no projeto entregue, porque o Ctrl+S da pessoa é edição
// direta dela.
//
// Falha aqui NÃO derruba o turno: o contexto segue sem execução e as
// ferramentas de arquivo recusam com motivo — um turno de pura conversa nunca
// precisou de workspace.
func (s *Supervisor) comWorkspace(
	ctx context.Context, sessionID, turn, taskID, botID string, origem workspace.Origin,
) context.Context {
	return s.workspaceDaTarefa(ctx, sessionID, turn, taskID, botID, 1, origem)
}

// workspaceDaTarefa é o comWorkspace com a TENTATIVA explícita: a refação de
// uma onda congela um plano novo (attempt 2), o mesmo que foi anunciado no
// despacho — plano do envelope e plano da execução não podem divergir.
func (s *Supervisor) workspaceDaTarefa(
	ctx context.Context, sessionID, turn, taskID, botID string, attempt int, origem workspace.Origin,
) context.Context {
	if s.deps.Workspaces == nil {
		return ctx
	}
	plan, err := s.deps.Workspaces.Plan(ctx, workspace.PlanRequest{
		SessionID: sessionID,
		TaskID:    taskID,
		BotID:     botID,
		Attempt:   attempt,
		Origin:    origem,
	})
	if err != nil {
		return ctx
	}
	// A cópia fica VISÍVEL enquanto é feita: a pessoa vê o gesto em vez de o
	// primeiro passo do turno simplesmente demorar mais.
	master := protocol.Actor{Kind: protocol.ActorSupervisor, ID: specialist.MasterID}
	if plan.Staged() && s.deps.Bus != nil {
		s.thinking(sessionID, turn, master, "trabalhando numa cópia de segurança do projeto…", false)
	}
	execution, err := s.deps.Workspaces.Materialize(ctx, plan)
	if plan.Staged() && s.deps.Bus != nil {
		s.thinking(sessionID, turn, master, "", true)
	}
	if err != nil {
		return ctx
	}
	if execution.StagingDegraded != "" && s.deps.Bus != nil {
		// O teto degradou para inplace: o turno segue direto no projeto, e a
		// pessoa fica sabendo o porquê em vez de perder o sandbox em silêncio.
		s.thinking(sessionID, turn, master, execution.StagingDegraded+" — trabalhando direto no projeto", false)
	}
	return workspace.WithExecution(ctx, execution)
}

// entregaWorkspace PROMOVE o staging do turno para o projeto — a cerca de
// worker+época primeiro, o espelho depois. Chamada no SUCESSO, antes de a
// pessoa ser avisada (mensagem final/done/delegate-done): ela só lê resultado
// que já está entregue. Execução inplace (ou nenhuma) é não-op.
func (s *Supervisor) entregaWorkspace(ctx context.Context, sessionID, turn string) error {
	execution, ok := workspace.FromContext(ctx)
	if !ok || execution.LocalStaging == "" || s.deps.Workspaces == nil {
		return nil
	}
	master := protocol.Actor{Kind: protocol.ActorSupervisor, ID: specialist.MasterID}
	if s.deps.Bus != nil {
		s.thinking(sessionID, turn, master, "entregando o resultado ao projeto…", false)
	}
	err := s.deps.Workspaces.Promote(ctx, execution.Plan, execution.Publication())
	if s.deps.Bus != nil {
		s.thinking(sessionID, turn, master, "", true)
	}
	return err
}

// descartaWorkspace joga fora o staging do turno SEM tocar o projeto. É o
// desfecho de TODO caminho que não promoveu — falha de modelo, interrupção,
// recusa, portão de narração, retorno antecipado — e por isso roda em defer:
// nada meio-escrito chega à pessoa. Depois de uma promoção é não-op (o staging
// já foi embora), o que a torna segura de chamar sempre.
func (s *Supervisor) descartaWorkspace(ctx context.Context) {
	execution, ok := workspace.FromContext(ctx)
	if !ok || execution.LocalStaging == "" || s.deps.Workspaces == nil {
		return
	}
	_ = s.deps.Workspaces.Discard(context.Background(), execution.Plan, execution.Publication())
}

// mustPayload serializa para envelope efêmero. Só recebe tipos deste pacote,
// que sempre serializam; o erro vira payload vazio em vez de derrubar o turno.
func mustPayload(value any) json.RawMessage {
	raw, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	return raw
}

func digestOf(scope, tool string, args json.RawMessage) string {
	sum := sha256.Sum256(append([]byte(scope+"\x00"+tool+"\x00"), args...))
	return hex.EncodeToString(sum[:8])
}

// approvalScope é o par (projeto, especialista) a que uma concessão fica presa.
//
// A raiz vem da SESSÃO porque é ela que define onde as ferramentas de arquivo
// escrevem; o portão, esse, é um só no processo. Sessão sem raiz cai numa marca
// fixa em vez de string vazia: assim duas sessões sem projeto compartilham o
// escopo entre si, mas nenhuma delas empresta a concessão para uma sessão que
// TEM projeto.
func (s *Supervisor) approvalScope(sessionID, specialistID string) string {
	root := "sem-projeto"
	if s.deps.Store != nil {
		if meta, err := s.deps.Store.GetSession(sessionID); err == nil {
			if cwd := strings.TrimSpace(meta.CWD); cwd != "" {
				root = cwd
			}
		}
	}
	return root + "\x00" + specialistID
}

func truncate(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	// Corta em fronteira de rune: cortar no meio de um caractere multibyte
	// produz U+FFFD no meio da saída e confunde quem lê o log.
	cut := limit
	for cut > 0 && !isRuneStart(text[cut]) {
		cut--
	}
	return text[:cut] + fmt.Sprintf("\n… (cortado em %d de %d bytes)", cut, len(text))
}

func isRuneStart(b byte) bool { return b&0xC0 != 0x80 }

func titleFrom(text string) string {
	clean := strings.Join(strings.Fields(text), " ")
	if len(clean) <= 60 {
		return clean
	}
	cut := 60
	for cut > 0 && !isRuneStart(clean[cut]) {
		cut--
	}
	return strings.TrimSpace(clean[:cut]) + "…"
}

func summarize(tool string, args json.RawMessage) string {
	var fields map[string]any
	if err := json.Unmarshal(args, &fields); err != nil || len(fields) == 0 {
		return tool
	}
	// Mostra os campos que dizem O QUE vai acontecer, na ordem em que uma
	// pessoa lê. Um resumo com o JSON inteiro não é resumo.
	for _, key := range []string{"path", "command", "url", "file", "query", "message"} {
		if value, ok := fields[key]; ok {
			return fmt.Sprintf("%s — %v", tool, value)
		}
	}
	return tool
}

func thinkingLabel(definition specialist.Definition, round int) string {
	if round > 0 {
		return "trabalhando"
	}
	switch definition.Surface {
	case specialist.SurfaceEditor:
		return "lendo o código"
	case specialist.SurfaceSchema:
		return "modelando"
	case specialist.SurfaceFindings:
		return "procurando"
	case specialist.SurfaceCrew:
		return "montando a equipe"
	case specialist.SurfaceCanvas:
		return "compondo"
	default:
		return "pensando"
	}
}
