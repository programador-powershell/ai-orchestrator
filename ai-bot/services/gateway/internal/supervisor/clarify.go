// A pergunta bloqueante do supervisor: clarificação de rota e aprovação de
// plano.
//
// As duas coisas são o MESMO mecanismo, de propósito — pergunta → resposta →
// continuação:
//
//   - CLARIFICAÇÃO: o primeiro input caiu no fallback (ou a confiança veio
//     rasteira) e nenhum anexo decidiu. Adivinhar aqui grava o modo ERRADO na
//     conversa inteira — o modo não se reavalia —, então o supervisor pergunta,
//     com opções objetivas montadas do shortlist do fast router, e encerra o
//     turno sem gastar modelo nenhum. A resposta roda o turno original com a
//     escolha explícita.
//
//   - PLANO: o especialista com ferramenta de escrita propôs um bloco
//     `aibot:plan` antes de mexer em vários arquivos. O supervisor pergunta
//     "Aprovar?" e NADA executa antes do aval — nem as ferramentas que vieram
//     no mesmo texto. Aprovar continua o turno; ajustar devolve a palavra ao
//     modelo como instrução de revisão.
//
// A pendência é UMA por sessão e morre com a próxima mensagem normal: quem
// ignorou o cartão e seguiu escrevendo já respondeu — a mensagem nova É a
// resposta. Não há timer: um prazo inventaria uma resposta que ninguém deu
// (a mesma razão de o AskCard não ter prazo do lado de lá).
package supervisor

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"aibot/gateway/internal/modelrouter"
	"aibot/gateway/internal/permissions"
	"aibot/gateway/internal/protocol"
	"aibot/gateway/internal/specialist"
)

// ClarifyMaxConfidence é a confiança abaixo da qual o primeiro input vira
// pergunta em vez de chute.
//
// 0.4 fica DE PROPÓSITO abaixo de MinConfidence (0.55): o degrau léxico que
// decide sozinho nunca cai aqui, e um veredito de modelo entre 0.4 e 0.55 ainda
// é aceito — perguntar a cada dúvida leve transformaria o roteador num
// questionário. Só a incerteza de verdade (fallback a 0.25, modelo abaixo de
// 0.4) interrompe a pessoa.
const ClarifyMaxConfidence = 0.4

// clarifyMinOptions/clarifyMaxOptions delimitam a pergunta: menos de duas
// opções não é pergunta (é o fallback com outro nome), e mais de quatro é o
// catálogo inteiro de volta — justamente a decisão que a pessoa não quis fazer.
const (
	clarifyMinOptions = 2
	clarifyMaxOptions = 4
)

// clarifyQuestion é a pergunta da clarificação. Curta porque as OPÇÕES são a
// informação; a frase só explica por que o cartão apareceu.
const clarifyQuestion = "Dá para atender isso de mais de um jeito. Qual destes é o que você quer?"

// planApproveOption/planAdjustOption são os rótulos dos botões do plano. O
// texto do botão É o protocolo: o reply devolve o rótulo escolhido.
const (
	planApproveOption = "Aprovar plano"
	planAdjustOption  = "Ajustar"
)

// planApprovedPrompt é a continuação de quem aprovou. Vira a mensagem da pessoa
// no log — é lendo ELA que o modelo sabe que pode executar.
const planApprovedPrompt = "Plano aprovado — execute."

// planAdjustPrompt é a continuação do clique em Ajustar. Em primeira pessoa
// porque entra no log como fala da pessoa; o clique não diz O QUE mudar, então
// a instrução manda o modelo perguntar em vez de reexecutar às cegas.
const planAdjustPrompt = "Quero ajustar o plano antes de aprovar. Pergunte em uma linha o que deve " +
	"mudar e proponha a versão revisada — não execute nada ainda."

// pendingAskKind diz POR QUE o turno parou para perguntar.
type pendingAskKind int

const (
	pendingClarify pendingAskKind = iota
	pendingPlan
)

// pendingAsk é a pergunta bloqueante aberta numa sessão.
type pendingAsk struct {
	askID string
	kind  pendingAskKind
	// prompt é o pedido ORIGINAL (clarificação): a continuação o executa com o
	// especialista escolhido — texto, anexos e modelo preservados.
	prompt protocol.Prompt
	// options mapeia o rótulo mostrado → id do especialista (clarificação).
	options map[string]string
	// specialist é o dono da conversa (plano): a continuação volta para ele.
	specialist string
}

// dropAsk descarta a pergunta pendente da sessão, se houver.
func (s *Supervisor) dropAsk(sessionID string) {
	s.mu.Lock()
	delete(s.asks, sessionID)
	s.mu.Unlock()
}

/* ----------------------------- clarificação ------------------------------ */

// attachmentNames reduz os anexos ao que o roteador consome: os nomes. O
// conteúdo não importa para rotear — a extensão é o sinal.
func attachmentNames(attachments []protocol.Attachment) []string {
	if len(attachments) == 0 {
		return nil
	}
	names := make([]string, 0, len(attachments))
	for _, attachment := range attachments {
		names = append(names, attachment.Name)
	}
	return names
}

// askClarification publica a pergunta de rota e encerra o turno. Devolve false
// quando não há pergunta que valha — aí o chamador segue com o fallback, que é
// o comportamento antigo.
func (s *Supervisor) askClarification(sessionID, turn, question string, original protocol.Prompt) bool {
	candidates := candidatesFor(s.deps.Gate.Policy().AllowedSpecialists)

	// As opções saem do MESMO shortlist que alimentaria o Needle: os mais
	// pontuados pelo léxico (com o peso dos anexos não decisivos somado — um
	// .docx e um .sql empatados são exatamente as duas opções a oferecer),
	// completado pela ordem do catálogo quando o texto não pontuou ninguém.
	scores := Score(question, candidates)
	if names := attachmentNames(original.Attachments); len(names) > 0 {
		scores, _ = combineAttachments(scores, names, candidates)
	}
	shortlist := shortlistFor(scores, candidates, clarifyMaxOptions)
	if len(shortlist) < clarifyMinOptions {
		// Uma opção só não é escolha. Segue o fallback: responder algo errado é
		// recuperável com /mode; um cartão com um botão único é cerimônia.
		return false
	}

	options := make([]string, 0, len(shortlist))
	byLabel := make(map[string]string, len(shortlist))
	for _, definition := range shortlist {
		// "Código — Edita, roda e revisa o repositório": o nome diz QUEM e a
		// vocação diz O QUE — é a opção objetiva que dispensa conhecer o app.
		label := definition.Name + " — " + definition.Tagline
		options = append(options, label)
		byLabel[label] = definition.ID
	}

	askID := s.nextID("a")
	if err := s.emit(sessionID, turn, protocol.KindAsk,
		protocol.Actor{Kind: protocol.ActorSupervisor, ID: specialist.MasterID}, protocol.Ask{
			AskID:    askID,
			Question: clarifyQuestion,
			Options:  options,
			Blocking: true,
		}); err != nil {
		return false
	}

	s.mu.Lock()
	s.asks[sessionID] = pendingAsk{
		askID:   askID,
		kind:    pendingClarify,
		prompt:  original,
		options: byLabel,
	}
	s.mu.Unlock()

	// O turno acaba AQUI, sem rota e sem modelo: a sessão continua sem dono —
	// gravar um modo agora seria decidir justamente o que se acabou de
	// perguntar — e o done libera a tela para a pessoa responder. O done sai SEM
	// especialista de propósito: o store carimba meta.Specialist de qualquer
	// envelope com From.Specialist preenchido, e um done "do master" coroaria o
	// master como dono da conversa que está justamente sem dono.
	s.done(sessionID, turn, "", modelrouter.Usage{}, false)
	return true
}

/* --------------------------------- plano --------------------------------- */

// planFence é o bloco cercado em que o especialista propõe o plano. Mesma
// família dos blocos de ferramenta e delegação, e pelo mesmo motivo: contrato
// em texto funciona em qualquer modelo do catálogo.
const planFence = "```aibot:plan"

// parsePlan extrai o primeiro plano proposto na resposta.
//
// Bloco aberto e não fechado é ignorado como nos outros parsers: aprovar um
// plano truncado seria aprovar outra coisa. E plano vazio não é plano.
func parsePlan(answer string) (string, bool) {
	start := strings.Index(answer, planFence)
	if start < 0 {
		return "", false
	}
	rest := answer[start+len(planFence):]
	end := strings.Index(rest, "```")
	if end < 0 {
		return "", false
	}
	plan := strings.TrimSpace(rest[:end])
	if plan == "" {
		return "", false
	}
	return plan, true
}

// planContract é o parágrafo de sistema que pede plano antes de mudança larga.
//
// Só para quem tem ferramenta de ESCRITA liberada: pedir plano a um
// especialista que não altera nada é cerimônia, e é este mesmo critério que
// runTurn usa para reconhecer o bloco — contrato e reconhecimento andam juntos
// para um `aibot:plan` ecoado por um especialista só-leitura não congelar o
// turno.
func (s *Supervisor) planContract(definition specialist.Definition) string {
	if len(definition.Tools) == 0 || !s.deps.Gate.Policy().AgentTools {
		return ""
	}
	writes := false
	for _, tool := range definition.Tools {
		// memory.write fica de fora: a memória é o caderno do bot, não um
		// arquivo da pessoa — plano para anotar lembrete seria só atrito.
		if tool != "memory.write" && permissions.RiskOf(tool) == protocol.RiskWrite {
			writes = true
			break
		}
	}
	if !writes {
		return ""
	}
	return "Para tarefa que altera VÁRIOS arquivos, proponha antes um plano num bloco cercado exatamente assim:\n\n" +
		planFence + "\n1. primeiro passo\n2. segundo passo\n```\n\n" +
		"Lista numerada curta, um passo por linha, e AGUARDE: a aprovação chega como a próxima mensagem — " +
		"não chame ferramenta no mesmo turno do plano. " +
		"Mudança pontual (um arquivo, um ajuste) não precisa de plano: execute direto."
}

// askPlan publica o pedido de aprovação do plano e registra a pendência. Quem
// encerra o turno é o chamador (runTurn), que ainda tem o uso a reportar.
func (s *Supervisor) askPlan(sessionID, turn string, definition specialist.Definition, plan string) {
	askID := s.nextID("a")
	_ = s.emit(sessionID, turn, protocol.KindAsk,
		protocol.Actor{Kind: protocol.ActorSupervisor, ID: specialist.MasterID}, protocol.Ask{
			AskID:    askID,
			Question: fmt.Sprintf("%s propôs um plano antes de executar. Aprovar?", definition.Name),
			Options:  []string{planApproveOption, planAdjustOption},
			// O plano vai no Detail, separado da pergunta: a frase é o que se lê
			// antes de decidir, e o corpo é o que se confere quando se quer.
			Detail:   truncate(plan, 4000),
			Blocking: true,
		})

	s.mu.Lock()
	s.asks[sessionID] = pendingAsk{
		askID:      askID,
		kind:       pendingPlan,
		specialist: definition.ID,
	}
	s.mu.Unlock()
}

/* --------------------------------- reply --------------------------------- */

// Reply entrega a resposta humana de um `ask` bloqueante e RODA a continuação.
// Bloqueia até o fim do turno de continuação, como Prompt — quem quiser
// assíncrono chama numa goroutine.
func (s *Supervisor) Reply(parent context.Context, sessionID string, reply protocol.Reply) error {
	answer := strings.TrimSpace(reply.Answer)
	if answer == "" {
		return errors.New("resposta vazia — escolha uma opção ou escreva o que você quer")
	}

	s.mu.Lock()
	pending, exists := s.asks[sessionID]
	// AskID vazio casa com a pendente da sessão (só existe uma); preenchido tem
	// de bater — um reply atrasado de uma pergunta que já morreu não pode
	// destravar a pergunta nova com uma resposta dada a outra coisa.
	matches := exists && (reply.AskID == "" || reply.AskID == pending.askID)
	if matches {
		delete(s.asks, sessionID)
	}
	s.mu.Unlock()

	if !exists {
		return fmt.Errorf("nenhuma pergunta pendente para a sessão %s — mande a mensagem normalmente", sessionID)
	}
	if !matches {
		return fmt.Errorf("a pergunta %s não está mais pendente — responda a atual ou mande a mensagem normalmente", reply.AskID)
	}

	// O eco da resposta entra no LOG (não é efêmero): é ele que fecha o cartão
	// nas outras janelas da sessão e deixa o replay contar a história inteira —
	// pergunta, resposta, continuação.
	_ = s.emit(sessionID, "", protocol.KindReply,
		protocol.Actor{Kind: protocol.ActorUser}, protocol.Reply{AskID: pending.askID, Answer: answer})

	switch pending.kind {
	case pendingClarify:
		if chosen, found := pending.options[answer]; found {
			// A pessoa escolheu uma prateleira: o turno ORIGINAL roda com a
			// escolha explícita. Nada é regravado — a pergunta já está no log —
			// e a clarificação fica desligada: pergunta respondida não repergunta.
			//
			// O flag `clarified` diz ao turno DE ONDE a escolha veio: a opção do
			// cartão responde "quem trabalha", não "quero uma conversa deste bot"
			// — então especialista de TRABALHO numa raiz sem modo desce pela
			// delegação do master (a filha nasce, a raiz não vira a IDE), enquanto
			// a escolha de conversa responde na própria raiz, como sempre.
			continuation := pending.prompt
			continuation.Specialist = chosen
			return s.runTurn(parent, sessionID, continuation, turnOptions{clarified: true})
		}
		// Texto livre: a pessoa não escolheu, acrescentou. A resposta vira o
		// prompt de continuação com o pedido original anexado — juntos eles dão
		// ao roteador o contexto que o original sozinho não deu. Só a resposta é
		// fala nova (userLine); o original já está no log.
		continuation := pending.prompt
		continuation.Text = answer + "\n\n" + pending.prompt.Text
		continuation.Specialist = ""
		return s.runTurn(parent, sessionID, continuation, turnOptions{userLine: answer})

	case pendingPlan:
		// O dono da conversa não muda — a continuação volta explicitamente para
		// quem propôs o plano, e a instrução entra no log como fala da pessoa:
		// é lendo ELA que o modelo sabe o que foi decidido (o histórico não
		// carrega ask/reply, só mensagens).
		continuation := protocol.Prompt{Specialist: pending.specialist}
		switch answer {
		case planApproveOption:
			continuation.Text = planApprovedPrompt
		case planAdjustOption:
			continuation.Text = planAdjustPrompt
		default:
			// Texto livre É a instrução de revisão, nas palavras da pessoa.
			continuation.Text = answer
		}
		return s.runTurn(parent, sessionID, continuation, turnOptions{logQuestion: true})
	}
	return nil
}
