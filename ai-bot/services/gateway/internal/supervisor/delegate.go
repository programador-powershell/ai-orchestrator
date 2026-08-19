// A delegação entre especialistas: quem está atendendo chama outro sozinho.
//
// O problema que ela resolve é de produto. O AI-BOT tem UMA tela e o modo é
// decidido no primeiro input; a partir daí a conversa inteira vai para o mesmo
// especialista. Quando o pedido encosta em outra especialidade — o de código
// precisa das tabelas, o de dados precisa de um patch — a saída antiga era o
// especialista escrever "isso é com o especialista de dados" e a pessoa ter de
// pedir de novo, noutras palavras, para outro bot. Pedir à pessoa que faça o
// roteamento é devolver a ela o trabalho que o master existe para fazer.
//
// Aqui o próprio especialista chama o outro, sem pedir permissão, e a tela só
// anuncia quem entrou. Duas fronteiras seguram isso de pé:
//
//  1. DELEGAR não pede permissão; o que o delegado FAZ pede. Cada ferramenta do
//     delegado passa pelo `permissions.Gate` normalmente, com o catálogo DELE.
//     Sem isso, "delegar" viraria a forma barata de escapar da aprovação — o
//     especialista sem `proc.run` delegaria para um que tem e mandaria rodar,
//     que é exatamente o buraco que um plugin capaz de executar código abriria.
//
//  2. O MODO GRAVADO na conversa não muda. Quem delegou continua dono da
//     conversa e é ele quem responde à pessoa; a delegação é um empréstimo de
//     especialidade dentro de um turno, não uma troca de modo. Trocar de modo é
//     `/mode`, e só — senão uma pergunta de passagem sobre schema mudaria a
//     conversa de código para dados e a tela trocaria de superfície sozinha.
package supervisor

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"aibot/gateway/internal/modelrouter"
	"aibot/gateway/internal/protocol"
	"aibot/gateway/internal/specialist"
	"aibot/gateway/internal/store"
)

const (
	// maxDelegationDepth é quantos níveis de delegação um turno aceita. 1 é a
	// delegação feita pelo especialista da conversa; 2 é o delegado delegando uma
	// vez. O terceiro nível é RECUSADO, com motivo.
	//
	// O teto não é opcional. Dois especialistas que se acham incompetentes um
	// para o assunto do outro delegam em pingue-pongue — código manda para dados,
	// dados devolve para código — até o orçamento do turno acabar. O laço não
	// erra em nenhum passo: cada delegação, sozinha, é uma decisão plausível, e é
	// justamente por isso que ele não se interrompe sozinho.
	maxDelegationDepth = 2

	// maxDelegationsPerTurn conta o turno INTEIRO, sub-turnos inclusive. A
	// profundidade sozinha não segura a conta: um especialista pode chamar cinco
	// colegas em sequência, todos no nível 1, e cada um custa um modelo inteiro.
	maxDelegationsPerTurn = 3

	// firstDelegationDepth é a profundidade da delegação feita por quem atende a
	// conversa. Nomeado porque `1` solto no meio do turno não diz nada.
	firstDelegationDepth = 1

	// maxDelegationRounds limita o vaivém modelo↔ferramenta DENTRO do sub-turno.
	// Menor que o `maxToolRounds` do turno principal de propósito: o delegado
	// recebeu UMA coisa pontual, e um delegado que precisa de oito rodadas está
	// resolvendo outro problema — o de quem delegou.
	maxDelegationRounds = 4
)

// delegateFence é o bloco cercado que o modelo emite para delegar. Mesmo
// formato da chamada de ferramenta (ver toolContract) e pelo mesmo motivo: o
// usuário escolhe o modelo, e nem todo modelo do catálogo tem function-calling.
const delegateFence = "```aibot:delegate"

// delegateRequest é o pedido extraído da resposta do modelo.
type delegateRequest struct {
	Specialist string `json:"specialist"`
	Goal       string `json:"goal"`
	Reason     string `json:"reason,omitempty"`
	// raw guarda o texto original, para a mensagem de erro citar o que veio.
	raw string
}

// delegationBudget é o teto de delegações de UM turno.
//
// Ponteiro compartilhado com os sub-turnos porque o teto é do turno, não do
// nível: três delegações são três, aconteçam elas todas no primeiro nível ou
// espalhadas pela árvore. Sem mutex de propósito — a delegação roda em
// sequência dentro do turno, e um lock aqui só esconderia o dia em que alguém
// resolvesse paralelizá-la sem pensar no orçamento.
type delegationBudget struct{ used int }

/* -------------------------------- parsing ------------------------------- */

// parseDelegations extrai os pedidos de delegação do texto do modelo.
//
// Espelha `parseToolCalls`, inclusive nos casos difíceis: bloco aberto e não
// fechado é ignorado, e JSON inválido é GUARDADO para o erro voltar ao modelo.
func parseDelegations(answer string) []delegateRequest {
	var out []delegateRequest
	rest := answer
	for {
		start := strings.Index(rest, delegateFence)
		if start < 0 {
			return out
		}
		rest = rest[start+len(delegateFence):]
		end := strings.Index(rest, "```")
		if end < 0 {
			// Bloco aberto e não fechado: o modelo cortou no meio. Ignorar é o
			// certo — chamar um especialista a partir de um JSON truncado é chamar
			// outro especialista, ou pedir outra coisa a ele.
			return out
		}
		body := strings.TrimSpace(rest[:end])
		rest = rest[end+3:]

		var request delegateRequest
		request.raw = body
		if err := json.Unmarshal([]byte(body), &request); err != nil || request.Specialist == "" {
			// Guarda o pedido mesmo assim: o erro precisa VOLTAR para o modelo,
			// senão ele repete o mesmo JSON quebrado até o turno acabar.
			out = append(out, delegateRequest{raw: body})
			continue
		}
		out = append(out, request)
	}
}

// stripDelegateBlocks tira os blocos de delegação do texto mostrado à pessoa.
// O que ela vê é o bot que entrou, não o JSON que o chamou.
func stripDelegateBlocks(answer string) string {
	var builder strings.Builder
	rest := answer
	for {
		start := strings.Index(rest, delegateFence)
		if start < 0 {
			builder.WriteString(rest)
			return strings.TrimSpace(builder.String())
		}
		builder.WriteString(rest[:start])
		rest = rest[start+len(delegateFence):]
		end := strings.Index(rest, "```")
		if end < 0 {
			return strings.TrimSpace(builder.String())
		}
		rest = rest[end+3:]
	}
}

// stripBlocks tira do texto tudo o que é protocolo — ferramenta e delegação.
// Existe para que ninguém precise lembrar de chamar as duas.
func stripBlocks(answer string) string {
	return stripDelegateBlocks(stripToolBlocks(answer))
}

/* -------------------------------- limites ------------------------------- */

// delegationLimits são os tetos EFETIVOS de uma delegação.
//
// Existem como parâmetro, em vez de as constantes serem lidas direto lá dentro,
// porque o administrador pode apertá-los pela política — e assim a checagem
// continua pura, que é o que permite testá-la sem supervisor.
type delegationLimits struct {
	depth   int
	perTurn int
}

func defaultDelegationLimits() delegationLimits {
	return delegationLimits{depth: maxDelegationDepth, perTurn: maxDelegationsPerTurn}
}

// effectiveDelegationLimits aperta os tetos com a política do administrador.
//
// Só APERTA: as constantes deste arquivo são o teto do produto, e uma política
// frouxa (ou ausente) não as afrouxa. Com os padrões — MaxDepth 3 contra
// profundidade 2, MaxTotal 24 contra 3 por turno — nada muda; quem baixar os
// números na política passa a valer para a delegação e para a equipe do mesmo
// jeito, que é o mínimo que se espera de um limite configurável.
func (s *Supervisor) effectiveDelegationLimits() delegationLimits {
	limits := defaultDelegationLimits()
	policy := s.crewPolicy()
	if policy.MaxDepth > 0 && policy.MaxDepth < limits.depth {
		limits.depth = policy.MaxDepth
	}
	if policy.MaxTotal > 0 && policy.MaxTotal < limits.perTurn {
		limits.perTurn = policy.MaxTotal
	}
	return limits
}

// delegationRefusal devolve o motivo pelo qual a delegação NÃO pode acontecer,
// ou "" quando ela é legítima.
//
// Pura de propósito: os limites são a parte que precisa estar certa mesmo
// quando não há modelo, rede nem sessão para montar um teste. `allows` é o
// `Gate.AllowsSpecialist` — passado como função para que o teste exercite a
// política de verdade sem arrastar o supervisor inteiro.
func delegationRefusal(from string, request delegateRequest, depth, used int, allows func(string) bool, limits delegationLimits) string {
	target := strings.TrimSpace(request.Specialist)

	if target == "" {
		return fmt.Sprintf("o bloco de delegação não tem JSON válido — use "+
			"{\"specialist\":\"<id>\",\"goal\":\"<o que você precisa>\"}. recebido:\n%s",
			truncate(request.raw, 500))
	}
	if strings.TrimSpace(request.Goal) == "" {
		return fmt.Sprintf("delegação para %s sem objetivo — diga em uma frase o que ele deve entregar", target)
	}
	if strings.EqualFold(target, from) {
		return fmt.Sprintf("você não pode delegar para si mesmo (%s) — resolva você ou chame outra especialidade", target)
	}
	if !specialist.Exists(target) {
		return fmt.Sprintf("não existe especialista %q — escolha um da lista do contrato", target)
	}
	if target == specialist.MasterID {
		return "o master só decide quem atende, ele não executa — delegue para uma especialidade"
	}
	if allows != nil && !allows(target) {
		return fmt.Sprintf("o especialista %s não está liberado para esta sessão", target)
	}
	if depth > limits.depth {
		return fmt.Sprintf("limite de profundidade da delegação atingido (%d níveis) — "+
			"resolva com o que você tem ou devolva a quem te chamou o que ficou faltando", limits.depth)
	}
	if used >= limits.perTurn {
		return fmt.Sprintf("limite de %d delegações por turno atingido — termine com o que já veio",
			limits.perTurn)
	}
	return ""
}

// delegableSpecialists lista quem pode RECEBER delegação: o catálogo, menos o
// master (ele só roteia), menos quem a política barrou, menos quem está
// delegando. Oferecer na lista quem seria recusado depois gasta uma rodada
// inteira de modelo para dizer não.
func delegableSpecialists(from string, allows func(string) bool) []specialist.Definition {
	all := specialist.All()
	out := make([]specialist.Definition, 0, len(all))
	for _, definition := range all {
		if definition.ID == from || definition.ID == specialist.MasterID {
			continue
		}
		if allows != nil && !allows(definition.ID) {
			continue
		}
		out = append(out, definition)
	}
	return out
}

/* -------------------------------- contrato ------------------------------- */

// delegateContract é o parágrafo de sistema que ensina a delegar.
//
// Fica FORA de `toolContract` porque não é ferramenta e porque os dois têm
// públicos diferentes: o contrato de ferramenta também vai para o trabalhador
// da equipe (ver crew.go), que não tem laço de delegação — prometer a ele um
// bloco que ninguém lê faria o trabalhador parar esperando uma resposta que não
// vem.
//
// `depth` é a profundidade que a PRÓXIMA delegação teria. Passado o teto, o
// contrato some: um delegado no último nível não deve ser convidado a fazer o
// que vai ser recusado.
func (s *Supervisor) delegateContract(definition specialist.Definition, depth int) string {
	if depth > s.effectiveDelegationLimits().depth {
		return ""
	}
	var allows func(string) bool
	if s.deps.Gate != nil {
		allows = s.deps.Gate.AllowsSpecialist
	}
	peers := delegableSpecialists(definition.ID, allows)
	if len(peers) == 0 {
		return ""
	}
	lines := make([]string, 0, len(peers))
	for _, peer := range peers {
		lines = append(lines, fmt.Sprintf("- %s (%s): %s", peer.ID, peer.Name, peer.Tagline))
	}

	// O "não peça permissão" está escrito porque o comportamento padrão do modelo
	// é o contrário: perguntado se pode chamar alguém, ele pergunta. E uma
	// pergunta aqui devolve à pessoa exatamente o roteamento que ela não quer
	// fazer.
	return "Se o pedido precisar de outra especialidade, CHAME o especialista dela " +
		"com este bloco em vez de improvisar:\n\n" +
		delegateFence + "\n{\"specialist\":\"data\",\"goal\":\"modele as tabelas de cobrança\"," +
		"\"reason\":\"a modelagem é da especialidade dela\"}\n```\n\n" +
		"Você NÃO precisa pedir permissão para delegar, e não pergunte se pode — delegue. " +
		"Um bloco por especialista; JSON válido; nada dentro do bloco além do JSON. " +
		"Depois de delegar, PARE e espere: a resposta dele chega como a próxima mensagem. " +
		"Quem termina a conversa é você — junte o que ele devolveu à sua resposta em vez de repassá-la crua. " +
		"Delegue o que é da especialidade do outro, não o que você mesmo resolve.\n\n" +
		"Especialistas que você pode chamar:\n" + strings.Join(lines, "\n")
}

/* ------------------------------- execução -------------------------------- */

// delegate executa UMA delegação e devolve o texto que volta para quem delegou
// — do mesmo jeito que o resultado de ferramenta volta, e sempre com texto,
// inclusive na recusa: o modelo precisa saber que foi recusado para tentar
// outro caminho em vez de reemitir o mesmo bloco.
func (s *Supervisor) delegate(
	ctx context.Context,
	sessionID, turn string,
	origin specialist.Definition,
	request delegateRequest,
	budget *delegationBudget,
	depth int,
) string {
	var allows func(string) bool
	if s.deps.Gate != nil {
		allows = s.deps.Gate.AllowsSpecialist
	}
	if reason := delegationRefusal(origin.ID, request, depth, budget.used, allows, s.effectiveDelegationLimits()); reason != "" {
		// Recusa NÃO publica envelope nenhum. O popup existe para anunciar o bot
		// que ENTROU, e aqui não entrou ninguém; um popup que abre e fecha sozinho
		// é ruído que a pessoa aprende a ignorar — inclusive no dia em que for de
		// verdade. O motivo volta para quem tem o que fazer com ele: o modelo.
		return fmt.Sprintf("DELEGAÇÃO RECUSADA: %s", reason)
	}
	budget.used++

	target, ok := specialist.Get(request.Specialist)
	if !ok {
		// Inalcançável — `delegationRefusal` já checou. Fica como recusa em vez de
		// GetOrDefault: cair no especialista padrão aqui chamaria um bot que
		// ninguém pediu.
		return fmt.Sprintf("DELEGAÇÃO RECUSADA: não existe especialista %q", request.Specialist)
	}

	// O modelo é resolvido para o DELEGADO, não herdado de quem delegou: a
	// preferência de modelo é do especialista (o de código pede um modelo bom de
	// código), e herdar mandaria o trabalho de dados para o modelo escolhido a
	// pensar em outra coisa. A escolha manual da pessoa também não desce — ela
	// vale para o especialista da conversa, que é quem ela escolheu.
	//
	// Resolvido ANTES do primeiro envelope de propósito: falhar aqui não deve
	// abrir um popup para um bot que nunca chegou a rodar.
	entry, _, err := s.deps.Models.Resolve(target.ID, "")
	if err != nil {
		return fmt.Sprintf("DELEGAÇÃO PARA %s NÃO DEU CERTO: %v", target.ID, err)
	}

	originActor := protocol.Actor{
		Kind:       protocol.ActorSpecialist,
		ID:         origin.ID,
		Specialist: origin.ID,
	}
	payload := protocol.Delegate{
		From:   origin.ID,
		To:     target.ID,
		Goal:   strings.TrimSpace(request.Goal),
		Reason: strings.TrimSpace(request.Reason),
		Depth:  depth,
	}
	// A CONVERSA DO BOT.
	//
	// O trabalho do delegado ganha conversa própria, pendurada nesta: na barra
	// lateral ela aparece aninhada sob a conversa que a criou, e clicar nela
	// leva a pessoa a falar direto com aquele bot. Antes o Código respondia
	// dentro da conversa do Conversa e sumia — não sobrava com quem falar
	// depois, e pedir "agora faça o site inteiro" obrigava a passar tudo pelo
	// dono de novo.
	//
	// Espelho, e não mudança de lugar: a conversa do dono continua mostrando a
	// delegação inteira (é ela que a pessoa está lendo). O que a filha recebe é
	// o par pergunta/resposta, que é o que a torna continuável.
	//
	// A memória é lida ANTES do espelho: o espelho grava o pedido novo na
	// conversa do bot, e lê-la depois faria o objetivo atual chegar duas vezes
	// ao modelo — no histórico e no briefing.
	memoriaDoBot := s.childHistory(sessionID, target.ID)
	filho := s.mirrorDelegation(sessionID, target, payload.Goal)
	// O id da filha viaja no PRÓPRIO envelope de delegação, e não é recalculado
	// no cliente: a regra que forma o id (o par pai+bot) mora no store, e
	// reescrevê-la em TypeScript criaria uma segunda regra que discorda em
	// silêncio no dia em que a primeira mudar.
	payload.Session = filho

	// Antes de executar, e não depois: é este envelope que faz o popup do bot
	// aparecer na hora certa — e agora também a linha dele na barra lateral.
	// Anunciar quem entrou junto com o resultado anuncia alguém que já foi
	// embora.
	_ = s.emit(sessionID, turn, protocol.KindDelegate, originActor, payload)

	// finish fecha o popup. TODA saída daqui para baixo passa por ele — um
	// caminho de erro que esquecesse o segundo envelope deixaria o bot do
	// delegado girando na tela para sempre.
	finish := func(succeeded bool, outcome string) string {
		outcome = truncate(outcome, 20000)
		payload.Done = true
		payload.Result = outcome
		_ = s.emit(sessionID, turn, protocol.KindDelegate, originActor, payload)
		if filho != "" && succeeded {
			// O resultado bom entra na VOZ do bot: é a resposta dele.
			_ = s.emit(filho, turn, protocol.KindMessage, protocol.Actor{
				Kind:       protocol.ActorSpecialist,
				ID:         target.ID,
				Specialist: target.ID,
			}, protocol.Message{Role: "assistant", Text: outcome})
			_ = s.emit(filho, turn, protocol.KindDone, protocol.Actor{
				Kind:       protocol.ActorSpecialist,
				ID:         target.ID,
				Specialist: target.ID,
			}, protocol.Done{Specialist: target.ID})
		}
		if filho != "" && !succeeded {
			// A falha TAMBÉM vira registro — mas como aviso do SISTEMA, não como
			// fala do bot: escrevê-la na voz dele o apresentaria pelo pior. Sem
			// este registro a conversa do bot ficava com a pergunta sem resposta,
			// como se ele tivesse ignorado a pessoa — e falha é um estado de
			// primeira classe, não um silêncio.
			_ = s.emit(filho, turn, protocol.KindMessage,
				protocol.Actor{Kind: protocol.ActorSupervisor},
				protocol.Message{Role: "system",
					Text: "A tarefa não terminou: " + truncate(outcome, 2000)})
			_ = s.emit(filho, turn, protocol.KindDone, protocol.Actor{
				Kind:       protocol.ActorSupervisor,
				Specialist: target.ID,
			}, protocol.Done{Specialist: target.ID})
		}
		if !succeeded {
			return fmt.Sprintf("DELEGAÇÃO PARA %s NÃO DEU CERTO: %s", target.ID, outcome)
		}
		return fmt.Sprintf("RESULTADO DA DELEGAÇÃO PARA %s (%s):\n%s", target.Name, target.ID, outcome)
	}

	actor := protocol.Actor{
		Kind:       protocol.ActorSpecialist,
		ID:         target.ID,
		Specialist: target.ID,
	}
	messages := s.delegateMessages(origin, target, request, depth, memoriaDoBot)

	for round := 0; round < maxDelegationRounds; round++ {
		if ctx.Err() != nil {
			return finish(false, "o turno foi cancelado antes de o especialista terminar")
		}
		s.thinking(sessionID, turn, actor, thinkingLabel(target, round), false)
		answer, _, err := s.runModel(ctx, sessionID, turn, actor, entry.Model.ID, messages)
		s.thinking(sessionID, turn, actor, "", true)
		if err != nil {
			return finish(false, err.Error())
		}

		calls := parseToolCalls(answer)
		nested := parseDelegations(answer)
		if len(calls) == 0 && len(nested) == 0 {
			// A resposta do delegado NÃO entra no log como mensagem da conversa.
			// Ela volta para quem delegou como contexto, igual ao resultado de uma
			// ferramenta, e quem escreve para a pessoa continua sendo o dono da
			// conversa. Gravá-la como mensagem faria o histórico do próximo turno
			// ter duas vozes respondendo à mesma pergunta — e o texto do delegado é
			// escrito para outro bot ler, não para a pessoa.
			return finish(true, stripBlocks(answer))
		}

		messages = append(messages, modelrouter.ChatMessage{Role: "assistant", Content: answer})

		if len(calls) > 0 {
			// AS FERRAMENTAS DO DELEGADO PASSAM PELO PORTÃO NORMAL. `executeTool`
			// recebe a definição DELE, então o `permissions.Gate` confere o catálogo
			// dele, a política da sessão e pergunta à pessoa o que tiver de
			// perguntar. É a fronteira toda: delegar não pede permissão, mas o que o
			// delegado FAZ pede — sem isso, delegar seria a forma barata de escapar
			// da aprovação (o especialista sem `proc.run` chamaria um que tem).
			results := make([]string, 0, len(calls))
			for _, call := range calls {
				results = append(results, s.executeTool(ctx, sessionID, turn, actor, target, call))
			}
			messages = append(messages, modelrouter.ChatMessage{
				Role:    "user",
				Content: "Resultado das ferramentas:\n\n" + strings.Join(results, "\n\n"),
			})
		}

		if len(nested) > 0 {
			results := make([]string, 0, len(nested))
			for _, sub := range nested {
				results = append(results, s.delegate(ctx, sessionID, turn, target, sub, budget, depth+1))
			}
			messages = append(messages, modelrouter.ChatMessage{
				Role:    "user",
				Content: "Resultado da delegação:\n\n" + strings.Join(results, "\n\n"),
			})
		}
	}

	return finish(false, fmt.Sprintf("não concluiu em %d rodadas", maxDelegationRounds))
}

// delegateMessages monta o prompt do sub-turno: o sistema DELE, as ferramentas
// DELE e um briefing dizendo que ele foi chamado para uma coisa só.
func (s *Supervisor) delegateMessages(
	origin, target specialist.Definition,
	request delegateRequest,
	depth int,
	memory []modelrouter.ChatMessage,
) []modelrouter.ChatMessage {
	messages := make([]modelrouter.ChatMessage, 0, 6+len(memory))

	// A política do admin entra AQUI TAMBÉM — nenhum especialista a remove —, e
	// ela vale ainda mais aqui, onde quem escolheu o especialista foi um modelo e
	// não a pessoa. Pelo cabeçalho compartilhado, que traz junto o prompt dos
	// pacotes corporativos: esta montagem à mão o perdia.
	messages = append(messages, s.policyHeader(target)...)
	if contract := s.toolContract(target); contract != "" {
		messages = append(messages, modelrouter.ChatMessage{Role: "system", Content: contract})
	}
	if contract := s.delegateContract(target, depth+1); contract != "" {
		messages = append(messages, modelrouter.ChatMessage{Role: "system", Content: contract})
	}

	// O histórico da conversa DA MÃE não desce — o delegado foi chamado para
	// uma coisa pontual, e mandar a conversa inteira o convidaria a responder à
	// pessoa por cima de quem a atende. Mas o que ELE MESMO já fez nesta
	// conversa desce: sem essa memória, o bot chamado pela segunda vez não
	// lembrava nem da própria resposta anterior, e "agora faça o site inteiro"
	// chegava sem o HTML de dez minutos atrás.
	if len(memory) > 0 {
		messages = append(messages, modelrouter.ChatMessage{Role: "system",
			Content: "A seguir, o que você já conversou em chamadas anteriores DESTA mesma conversa. " +
				"É o seu trabalho anterior aqui — continue de onde parou em vez de recomeçar."})
		messages = append(messages, memory...)
	}

	var briefing strings.Builder
	fmt.Fprintf(&briefing, "O especialista %s (%s) está atendendo uma conversa e chamou VOCÊ para uma coisa.\n\n",
		origin.Name, origin.ID)
	fmt.Fprintf(&briefing, "O que ele precisa:\n%s\n", strings.TrimSpace(request.Goal))
	if reason := strings.TrimSpace(request.Reason); reason != "" {
		fmt.Fprintf(&briefing, "\nPor quê: %s\n", reason)
	}
	briefing.WriteString("\nEntregue só isso e pare. Quem responde à pessoa é ele, não você: " +
		"escreva o resultado para ELE ler — sem cumprimento, sem se apresentar, sem perguntar " +
		"se pode continuar. Se faltar informação para fazer o que foi pedido, diga o que falta em " +
		"uma linha em vez de adivinhar.")

	messages = append(messages, modelrouter.ChatMessage{Role: "user", Content: briefing.String()})
	return messages
}

// mirrorDelegation abre (ou reabre) a conversa do bot delegado e registra ali o
// pedido que ele recebeu.
//
// Devolve o id da conversa filha, ou vazio quando não deu para criar. Vazio NÃO
// interrompe a delegação: o trabalho do delegado importa mais que o espelho
// dele, e uma falha de disco aqui não pode derrubar a resposta que a pessoa
// está esperando — ela só perde a conversa lateral.
func (s *Supervisor) mirrorDelegation(parentID string, target specialist.Definition, goal string) string {
	if s.deps.Store == nil || strings.TrimSpace(parentID) == "" {
		return ""
	}
	meta, err := s.deps.Store.ChildSession(parentID, target.ID, target.Name)
	if err != nil {
		return ""
	}
	if strings.TrimSpace(goal) != "" {
		// O pedido entra como fala do USUÁRIO na conversa do bot, e não como
		// recado do sistema: para quem abre depois, o que aconteceu ali foi
		// alguém pedir uma coisa a ele — e é assim que a continuação faz
		// sentido.
		_ = s.emit(meta.ID, "", protocol.KindMessage, protocol.Actor{Kind: protocol.ActorUser},
			protocol.Message{Role: "user", Text: goal})
		// O pedido também vira o SUBTÍTULO da linha na barra (o título é o nome
		// do bot; este diz o que ele está fazendo). No meta, e não lido do log
		// no handshake — o `ready` não pode pagar cinquenta logs por um
		// subtítulo.
		_, _ = s.deps.Store.UpdateSession(meta.ID, func(m *store.SessionMeta) {
			m.LastGoal = truncate(strings.TrimSpace(goal), 200)
		})
	}
	return meta.ID
}

// childHistory devolve o que o bot delegado já conversou NESTA conversa — os
// pedidos anteriores e o que ele respondeu.
//
// É o que torna a segunda chamada uma CONTINUAÇÃO: sem isto, "agora faça o site
// inteiro" chegava a um bot que não lembrava nem do próprio HTML de dez minutos
// atrás, porque cada delegação nascia só com o briefing. Lida ANTES de o
// espelho gravar o pedido novo — senão o objetivo atual apareceria duas vezes,
// no histórico e no briefing.
//
// Conversa inexistente (primeira chamada) devolve vazio, que é o correto: não
// há passado a lembrar.
func (s *Supervisor) childHistory(parentID, botID string) []modelrouter.ChatMessage {
	if s.deps.Store == nil || strings.TrimSpace(parentID) == "" {
		return nil
	}
	memory, err := s.history(store.ChildSessionID(parentID, botID))
	if err != nil {
		return nil
	}
	return memory
}
