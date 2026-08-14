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

	"aibot/gateway/internal/eventbus"
	"aibot/gateway/internal/memory"
	"aibot/gateway/internal/modelrouter"
	"aibot/gateway/internal/permissions"
	"aibot/gateway/internal/protocol"
	"aibot/gateway/internal/specialist"
	"aibot/gateway/internal/store"
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

// Deps são as peças que o supervisor orquestra.
type Deps struct {
	Store  *store.Store
	Bus    *eventbus.Bus
	Models *modelrouter.Router
	Gate   *permissions.Gate
	Memory *memory.Store
	Tools  *Registry
	Router *Router
	// PromptMaster devolve o prompt do admin. Pode ser nil.
	PromptMaster func() string
}

// Supervisor é o executor de turnos.
type Supervisor struct {
	deps Deps

	mu      sync.Mutex
	running map[string]context.CancelFunc
	waiting map[string]chan protocol.ApprovalDecision
	gates   map[string]chan protocol.Gate
	counter uint64
}

// New monta o supervisor.
func New(deps Deps) *Supervisor {
	return &Supervisor{
		deps:    deps,
		running: make(map[string]context.CancelFunc),
		waiting: make(map[string]chan protocol.ApprovalDecision),
		gates:   make(map[string]chan protocol.Gate),
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
	if strings.TrimSpace(prompt.Text) == "" {
		return errors.New("prompt vazio")
	}

	// Um turno por sessão. O anterior é CANCELADO, não enfileirado: quem manda
	// outra mensagem enquanto a resposta corre está corrigindo o rumo, e
	// esperar a resposta abandonada terminar só atrasa a que interessa.
	ctx, cancel := context.WithCancel(parent)
	s.mu.Lock()
	if previous, ok := s.running[sessionID]; ok {
		previous()
	}
	s.running[sessionID] = cancel
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		if s.running[sessionID] != nil {
			delete(s.running, sessionID)
		}
		s.mu.Unlock()
		cancel()
	}()

	turn := s.nextID("t")
	session, err := s.deps.Store.GetSession(sessionID)
	if err != nil {
		return err
	}

	// O `/mode` sai do texto antes de ele virar mensagem: quem lê a conversa
	// depois quer o pedido, não o comando de roteamento. A troca de modo não se
	// perde — ela fica registrada no envelope de rota, que é onde a interface
	// desenha a faixa "agora é X".
	_, question, hadCommand := ParseModeCommand(prompt.Text)
	if !hadCommand {
		question = prompt.Text
	}

	// 1. A pergunta entra no log ANTES de qualquer decisão. Se o roteamento ou
	// o modelo falharem, a pessoa ainda vê o que perguntou — perder o próprio
	// texto por causa de um erro do servidor é a pior forma de falhar aqui.
	if strings.TrimSpace(question) != "" {
		if err := s.emit(sessionID, turn, protocol.KindMessage,
			protocol.Actor{Kind: protocol.ActorUser}, protocol.Message{
				Role: "user",
				Text: question,
			}); err != nil {
			return err
		}
	}

	// 2. Quem atende. Só o PRIMEIRO input da conversa desce a cascata
	// (fast router → Needle → modelo grande); depois disso a conversa tem modo
	// e vai direto ao mesmo executor. Ver o cabeçalho de router.go.
	route := s.deps.Router.Route(ctx, RouteInput{
		Text:     prompt.Text,
		Explicit: prompt.Specialist,
		Current:  session.Specialist,
		Allowed:  s.deps.Gate.Policy().AllowedSpecialists,
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
		if err := s.emit(sessionID, turn, protocol.KindRoute,
			protocol.Actor{Kind: protocol.ActorSupervisor, ID: specialist.MasterID}, route); err != nil {
			return err
		}
		s.done(sessionID, turn, definition.ID, modelrouter.Usage{}, false)
		return nil
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

	actor := protocol.Actor{
		Kind:       protocol.ActorSpecialist,
		ID:         definition.ID,
		Specialist: definition.ID,
	}

	messages, err := s.buildMessages(sessionID, definition, question)
	if err != nil {
		s.fail(sessionID, turn, definition.ID, "contexto", err.Error(), false)
		return err
	}

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
		if len(calls) == 0 {
			// A resposta final entra no log inteira. Os deltas já foram
			// entregues, mas eles são EFÊMEROS: quem abrir a conversa amanhã lê
			// esta mensagem, não a soma de mil pedacinhos.
			if err := s.emit(sessionID, turn, protocol.KindMessage, actor, protocol.Message{
				Role:       "assistant",
				Text:       stripToolBlocks(answer),
				Specialist: definition.ID,
				Model:      entry.Model.ID,
			}); err != nil {
				return err
			}
			s.done(sessionID, turn, definition.ID, totalUsage, false)
			return nil
		}

		// Houve ferramenta: a fala do modelo até aqui vale como mensagem, e o
		// resultado das ferramentas volta como contexto do próximo giro.
		visible := strings.TrimSpace(stripToolBlocks(answer))
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

		results := make([]string, 0, len(calls))
		for _, call := range calls {
			results = append(results, s.executeTool(ctx, sessionID, turn, actor, definition, call))
		}
		messages = append(messages, modelrouter.ChatMessage{
			Role:    "user",
			Content: "Resultado das ferramentas:\n\n" + strings.Join(results, "\n\n"),
		})
	}

	s.fail(sessionID, turn, definition.ID, "laco_de_ferramenta",
		fmt.Sprintf("o especialista chamou ferramenta %d vezes seguidas sem concluir — o turno foi encerrado", maxToolRounds),
		true)
	return nil
}

// Cancel interrompe o turno em andamento.
func (s *Supervisor) Cancel(sessionID string) {
	s.mu.Lock()
	cancel := s.running[sessionID]
	delete(s.running, sessionID)
	s.mu.Unlock()
	if cancel != nil {
		cancel()
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
	s.supervisor.deps.Bus.PublishEphemeral(s.session, protocol.Envelope{
		V:       protocol.Version,
		TS:      time.Now().UTC(),
		Session: s.session,
		Turn:    s.turn,
		Kind:    protocol.KindThinking,
		From:    s.actor,
		Payload: mustPayload(protocol.Thinking{Label: text}),
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
	usage, err := s.deps.Models.Stream(ctx, modelrouter.Request{
		Model:    model,
		Messages: messages,
	}, sink)
	return sink.builder.String(), usage, err
}

/* ------------------------------- contexto ------------------------------- */

// buildMessages monta o prompt do turno. A ORDEM é a regra:
//
//	1. prompt master do admin  (nenhum especialista o remove)
//	2. prompt do especialista
//	3. contrato de ferramentas (só se ele tiver ferramentas liberadas)
//	4. memórias relevantes
//	5. histórico da conversa
//	6. arquivos citados com @
func (s *Supervisor) buildMessages(
	sessionID string,
	definition specialist.Definition,
	question string,
) ([]modelrouter.ChatMessage, error) {
	messages := make([]modelrouter.ChatMessage, 0, maxHistoryMessages+6)

	if s.deps.PromptMaster != nil {
		if master := strings.TrimSpace(s.deps.PromptMaster()); master != "" {
			messages = append(messages, modelrouter.ChatMessage{Role: "system", Content: master})
		}
	}
	messages = append(messages, modelrouter.ChatMessage{Role: "system", Content: definition.System})

	if contract := s.toolContract(definition); contract != "" {
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

	history, err := s.history(sessionID)
	if err != nil {
		return nil, err
	}
	messages = append(messages, history...)

	// O prompt já foi gravado como mensagem e volta pelo histórico; acrescentá-lo
	// de novo faria o modelo ver a pergunta duas vezes.
	return messages, nil
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
		if envelope.Kind != protocol.KindMessage {
			continue
		}
		var message protocol.Message
		if err := envelope.Decode(&message); err != nil {
			continue
		}
		if strings.TrimSpace(message.Text) == "" {
			continue
		}
		out = append(out, modelrouter.ChatMessage{Role: message.Role, Content: message.Text})
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
	return "Você pode usar ferramentas. Para chamar uma, emita um bloco cercado exatamente assim:\n\n" +
		"```aibot:tool\n{\"tool\":\"<nome>\",\"args\":{...}}\n```\n\n" +
		"Regras: um bloco por chamada; JSON válido; nada de texto dentro do bloco além do JSON. " +
		"Depois de chamar, PARE e espere o resultado — ele chega como a próxima mensagem. " +
		"Não invente resultado de ferramenta. Se o resultado vier com erro, leia o erro e corrija a chamada.\n\n" +
		"Ferramentas disponíveis:\n" + strings.Join(available, "\n")
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
// saber que foi recusado para tentar outro caminho em vez de repetir.
func (s *Supervisor) executeTool(
	ctx context.Context,
	sessionID, turn string,
	actor protocol.Actor,
	definition specialist.Definition,
	call toolInvocation,
) string {
	if call.Tool == "" {
		return fmt.Sprintf("ERRO: bloco de ferramenta com JSON inválido. Recebido:\n%s", truncate(call.raw, 500))
	}

	callID := s.nextID("c")
	digest := digestOf(call.Tool, call.Args)
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
		return fmt.Sprintf("RECUSADO (%s): %s", call.Tool, reason)
	case permissions.DecisionAsk:
		allowed, why := s.askApproval(ctx, sessionID, turn, actor, callID, call, risk, digest)
		if !allowed {
			s.toolResult(sessionID, turn, actor, callID, call.Tool, false, "", why, 0)
			return fmt.Sprintf("RECUSADO PELO USUÁRIO (%s): %s", call.Tool, why)
		}
	}

	started := time.Now()
	output, err := s.deps.Tools.Call(ctx, call.Tool, sessionID, call.Args)
	elapsed := time.Since(started).Milliseconds()
	if err != nil {
		s.toolResult(sessionID, turn, actor, callID, call.Tool, false, "", err.Error(), elapsed)
		return fmt.Sprintf("ERRO em %s: %s", call.Tool, err.Error())
	}
	s.toolResult(sessionID, turn, actor, callID, call.Tool, true, output, "", elapsed)
	return fmt.Sprintf("%s =>\n%s", call.Tool, truncate(output, 20000))
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
		if decision.Allow {
			s.deps.Gate.Grant(decision.Scope, call.Tool, digest)
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
}

func (s *Supervisor) fail(sessionID, turn, specialistID, code, message string, retryable bool) {
	_ = s.emit(sessionID, turn, protocol.KindError,
		protocol.Actor{Kind: protocol.ActorSupervisor, Specialist: specialistID}, protocol.Error{
			Code:      code,
			Message:   message,
			Retryable: retryable,
		})
}

/* -------------------------------- apoio --------------------------------- */

// mustPayload serializa para envelope efêmero. Só recebe tipos deste pacote,
// que sempre serializam; o erro vira payload vazio em vez de derrubar o turno.
func mustPayload(value any) json.RawMessage {
	raw, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	return raw
}

func digestOf(tool string, args json.RawMessage) string {
	sum := sha256.Sum256(append([]byte(tool+"\x00"), args...))
	return hex.EncodeToString(sum[:8])
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
