// O PLANEJAMENTO DO MASTER: antes de delegar, a raiz orquestradora LISTA o que
// o pedido precisa — e só então chama os ofícios, um a um, em ordem.
//
// O defeito que este arquivo fecha (teste do dono): "crie um site completo em
// next" descia INTEIRO ao Código por delegação direta e o Design ficava de
// fora. A corrente dependia de a PERSONA do Código lembrar de delegar o visual
// — e persona é instrução, não mecânica: no dia em que o modelo não lembra, o
// site sai sem design e ninguém erra em nenhum passo visível. A ordem do dono
// foi literal: "precisaria primeiro listar o que precisa e não chamar direto".
//
// O desenho, em três fronteiras:
//
//  1. UMA chamada de planejamento com contrato FECHADO: o master recebe o
//     catálogo real (id + ofício, do registry) e devolve SÓ a lista
//     [{specialist, goal, dependsOn}]. Saída inválida ganha UM retry com o
//     erro; inválida de novo, o caminho ATUAL continua — item único com o
//     dono decidido pela cascata. O planejamento nunca pode ser o motivo de
//     um pedido não ser atendido.
//
//  2. A LISTA É VISÍVEL E DURÁVEL na raiz ANTES de qualquer delegação — uma
//     mensagem do master em markdown de lista ("Para este pedido preciso
//     de…"), que é o formato que o cliente já renderiza; nunca cerca crua.
//
//  3. A execução REUSA tudo o que já existe: a validação é a da Equipe
//     (PlanTasks — especialista existe, não é o master, sem ciclo, sem
//     dependência fantasma) com concorrência 1, sem arrastar o crew; cada
//     item roda pelo MESMO masterDelegate de hoje (mesma-filha-por-par,
//     staging PRÓPRIO, cartão de entrega espelhado POR ITEM — decisão
//     deliberada: a pessoa aprova a entrega de CADA ofício ao vê-la, em vez
//     de um cartão único no fim que ninguém consegue avaliar). Item que
//     depende de outro só roda depois da ENTREGA do anterior — o Design lê
//     no projeto os arquivos que o Código JÁ promoveu; falha ou recusa corta
//     os dependentes com aviso honesto na raiz (a regra da Equipe) e os
//     independentes seguem.
package supervisor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"aibot/gateway/internal/modelrouter"
	"aibot/gateway/internal/protocol"
	"aibot/gateway/internal/specialist"
	"aibot/gateway/internal/workspace"
)

const (
	// masterPlanMaxItems é o teto de itens de um plano do master. Quatro porque
	// cada item é um sub-turno INTEIRO do master (teto de maxToolRounds, com o
	// orçamento de delegação próprio), então o plano multiplica custo — e um
	// pedido real raramente precisa de mais de três ofícios. Plano maior que
	// isso quase sempre é modelo alucinando lista, o mesmo julgamento do
	// maxTasks da Equipe, só que numa escala de ofícios e não de tarefas.
	masterPlanMaxItems = 4

	// masterPlanMaxTokens é curto de propósito: a resposta é um array de até
	// quatro objetos de três campos. Teto baixo também desencoraja o modelo de
	// "explicar" o plano em vez de devolvê-lo.
	masterPlanMaxTokens = 700
)

// contratoDePlanejamento é o prompt da chamada única. O marcador
// "PLANEJAMENTO DO MASTER" na primeira linha é deliberado: identifica a
// chamada nos logs (e nos provedores de teste) sem depender do resto do texto.
const contratoDePlanejamento = "PLANEJAMENTO DO MASTER. Leia o pedido de trabalho da pessoa e " +
	"liste O QUE ele precisa, por ofício, ANTES de qualquer execução. Responda SOMENTE com um " +
	"array JSON, sem cerca de código e sem texto em volta, neste formato exato:\n" +
	`[{"specialist":"<id do catálogo>","goal":"<o que este ofício entrega, em uma frase>","dependsOn":[<posições>]}]` + "\n" +
	"Regras: de 1 a 4 itens; use somente ids do catálogo abaixo; dependsOn cita itens pela " +
	"POSIÇÃO na lista (1 é o primeiro) e só quando este item precisa LER o que o outro entregou; " +
	"sem ciclos; não invente ofício que o pedido não pede — um item basta para um pedido de uma " +
	"coisa só. Não converse, não explique e não resolva o pedido."

// masterPlanItem é um item da lista devolvida pelo modelo — o contrato fechado.
type masterPlanItem struct {
	Specialist string `json:"specialist"`
	Goal       string `json:"goal"`
	// DependsOn cita itens pela POSIÇÃO (1-based). Posição, e não id inventado,
	// porque é o que um modelo acerta ao citar a própria lista que acabou de
	// escrever — e é o mesmo número que a mensagem visível mostra à pessoa.
	DependsOn []int `json:"dependsOn"`
}

// planoDoMaster é a lista VALIDADA, pronta para executar em ordem.
type planoDoMaster struct {
	items []masterPlanItem
	// ordem são os índices de items em ordem de execução — a saída do
	// PlanTasks com concorrência 1, que é sequencial e respeita dependências.
	ordem []int
	// planejado separa o plano vindo do MODELO do item único de fallback: só o
	// primeiro vira lista visível na raiz, e o segundo preserva o comportamento
	// de antes byte a byte.
	planejado bool
}

// planoDeItemUnico é o fallback: o comportamento atual do masterDelegate — um
// item, o dono decidido pela cascata, sem lista visível.
func planoDeItemUnico(specialistID, goal string) planoDoMaster {
	return planoDoMaster{
		items: []masterPlanItem{{Specialist: specialistID, Goal: goal}},
		ordem: []int{0},
	}
}

/* -------------------------------- parsing --------------------------------- */

// parseMasterPlan extrai o array JSON da resposta, mesmo quando o modelo o
// embrulha em cerca ou escreve uma frase antes — a mesma tolerância do
// parseVerdict do classificador, pelo mesmo motivo: "responda só JSON" reduz o
// desvio, não o elimina, e um plano que falha porque o modelo disse "Claro!"
// derrubaria o planejamento por um problema de etiqueta.
func parseMasterPlan(answer string) ([]masterPlanItem, error) {
	text := strings.TrimSpace(answer)
	if text == "" {
		return nil, errors.New("o master respondeu vazio")
	}
	start := strings.Index(text, "[")
	end := strings.LastIndex(text, "]")
	if start < 0 || end <= start {
		return nil, fmt.Errorf("o master não devolveu a lista JSON: %q", truncate(text, 200))
	}
	var items []masterPlanItem
	if err := json.Unmarshal([]byte(text[start:end+1]), &items); err != nil {
		return nil, fmt.Errorf("lista JSON inválida: %v", err)
	}
	return items, nil
}

// validaPlanoDoMaster valida a lista COMO A EQUIPE VALIDA — e é literalmente o
// validador dela: os itens viram protocol.Task e passam pelo PlanTasks, que já
// confere especialista existente, master recusado, dependência fantasma,
// auto-dependência, repetição e ciclo. Reescrever essas regras aqui criaria a
// segunda cópia que diverge em silêncio. O que é LOCAL deste contrato fica
// local: o teto pequeno de itens, o goal obrigatório (a Equipe não o exige) e
// a política da sessão (o portão não chega ao PlanTasks).
func validaPlanoDoMaster(raw []masterPlanItem, allows func(string) bool) (planoDoMaster, error) {
	if len(raw) == 0 {
		return planoDoMaster{}, errors.New("o plano precisa de pelo menos um item")
	}
	if len(raw) > masterPlanMaxItems {
		return planoDoMaster{}, fmt.Errorf("o plano aceita no máximo %d itens — junte ofícios em vez de fatiar", masterPlanMaxItems)
	}

	items := make([]masterPlanItem, 0, len(raw))
	tasks := make([]protocol.Task, 0, len(raw))
	for index, item := range raw {
		numero := index + 1
		id := strings.ToLower(strings.TrimSpace(item.Specialist))
		goal := strings.TrimSpace(item.Goal)
		if goal == "" {
			return planoDoMaster{}, fmt.Errorf("o item %d está sem goal — diga em uma frase o que o ofício entrega", numero)
		}
		if id != "" && allows != nil && !allows(id) {
			return planoDoMaster{}, fmt.Errorf("o item %d pede o especialista %s, que não está liberado para esta sessão", numero, id)
		}
		deps := make([]string, 0, len(item.DependsOn))
		for _, dep := range item.DependsOn {
			deps = append(deps, strconv.Itoa(dep))
		}
		items = append(items, masterPlanItem{Specialist: id, Goal: goal, DependsOn: item.DependsOn})
		tasks = append(tasks, protocol.Task{
			ID:         strconv.Itoa(numero),
			Title:      goal,
			Specialist: id,
			Goal:       goal,
			DependsOn:  deps,
		})
	}

	// Concorrência 1: as ondas saem com UM item cada, em ordem topológica — a
	// execução do master é sequencial de propósito (cada item entrega antes de
	// o dependente ler), então o próprio validador já devolve a fila pronta.
	plan, err := PlanTasks(tasks, 1)
	if err != nil {
		return planoDoMaster{}, err
	}
	ordem := make([]int, 0, len(items))
	for _, wave := range plan.Waves {
		for _, id := range wave {
			posicao, err := strconv.Atoi(id)
			if err != nil || posicao < 1 || posicao > len(items) {
				// Inalcançável — os ids nasceram de strconv.Itoa aqui em cima.
				return planoDoMaster{}, fmt.Errorf("onda com item desconhecido: %q", id)
			}
			ordem = append(ordem, posicao-1)
		}
	}
	return planoDoMaster{items: items, ordem: ordem, planejado: true}, nil
}

/* --------------------------- a chamada única ------------------------------ */

// planejaComOMaster faz a chamada de planejamento: catálogo real no prompt,
// resposta parseada e validada; saída inválida ganha UM retry com o erro (o
// modelo precisa ler "o item 2 depende do 5, que não existe" para corrigir a
// própria lista); inválida de novo, devolve o erro e o chamador cai no
// comportamento atual. Falha de MODELO (rede, provedor) não ganha retry — o
// retry existe para saída inválida, não para infraestrutura.
func (s *Supervisor) planejaComOMaster(ctx context.Context, question string) (planoDoMaster, error) {
	if s.deps.Models == nil {
		return planoDoMaster{}, errors.New("roteador de modelos indisponível")
	}
	entry, _, err := s.deps.Models.Resolve(specialist.MasterID, "")
	if err != nil {
		return planoDoMaster{}, err
	}

	var allows func(string) bool
	if s.deps.Gate != nil {
		allows = s.deps.Gate.AllowsSpecialist
	}
	// O catálogo REAL, do registry — id + ofício. A mesma lista de quem pode
	// RECEBER delegação (sem o master, sem quem a política barrou): oferecer no
	// contrato quem seria recusado na execução gastaria o plano inteiro para
	// descobrir um não.
	peers := delegableSpecialists(specialist.MasterID, allows)
	if len(peers) == 0 {
		return planoDoMaster{}, errors.New("nenhum especialista liberado para planejar")
	}
	var catalog strings.Builder
	for _, definition := range peers {
		fmt.Fprintf(&catalog, "- %s: %s. %s\n", definition.ID, definition.Name, definition.Tagline)
	}

	messages := []modelrouter.ChatMessage{
		{Role: "system", Content: contratoDePlanejamento},
		{Role: "system", Content: "Especialistas disponíveis:\n" + catalog.String()},
		{Role: "user", Content: question},
	}

	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		if err := ctx.Err(); err != nil {
			return planoDoMaster{}, err
		}
		answer, _, err := s.deps.Models.Complete(ctx, modelrouter.Request{
			Model:     entry.Model.ID,
			MaxTokens: masterPlanMaxTokens,
			Messages:  messages,
		})
		if err != nil {
			return planoDoMaster{}, err
		}
		items, parseErr := parseMasterPlan(answer)
		if parseErr == nil {
			plano, validErr := validaPlanoDoMaster(items, allows)
			if validErr == nil {
				return plano, nil
			}
			parseErr = validErr
		}
		lastErr = parseErr
		messages = append(messages,
			modelrouter.ChatMessage{Role: "assistant", Content: answer},
			modelrouter.ChatMessage{Role: "system", Content: "O plano veio inválido: " + parseErr.Error() +
				". Responda de novo SOMENTE com o array JSON do contrato, corrigido."})
	}
	return planoDoMaster{}, lastErr
}

/* ---------------------------- a lista visível ------------------------------ */

// renderizaPlanoDoMaster monta a mensagem que a pessoa lê ANTES de qualquer
// delegação: markdown de lista numerada — o formato que o cliente já renderiza
// bem — com a dependência dita em palavras ("depois de 1"). Os números são as
// POSIÇÕES originais, as mesmas que o dependsOn cita: a lista visível e o
// contrato interno contam a mesma história.
func renderizaPlanoDoMaster(plano planoDoMaster) string {
	var builder strings.Builder
	builder.WriteString("Para este pedido preciso de:\n")
	for index, item := range plano.items {
		nome := specialist.GetOrDefault(item.Specialist).Name
		fmt.Fprintf(&builder, "\n%d. **%s** — %s", index+1, nome, item.Goal)
		if len(item.DependsOn) > 0 {
			fmt.Fprintf(&builder, " (depois de %s)", listaDeNumeros(item.DependsOn))
		}
	}
	return builder.String()
}

// listaDeNumeros escreve "1", "1 e 2" ou "1, 2 e 3" — texto para gente ler.
func listaDeNumeros(numeros []int) string {
	partes := make([]string, 0, len(numeros))
	for _, numero := range numeros {
		partes = append(partes, strconv.Itoa(numero))
	}
	switch len(partes) {
	case 0:
		return ""
	case 1:
		return partes[0]
	default:
		return strings.Join(partes[:len(partes)-1], ", ") + " e " + partes[len(partes)-1]
	}
}

/* -------------------------- entregas coletadas ----------------------------- */

// coletorDeEntregaKey pendura no contexto do ITEM a fatia onde a promoção
// registra os caminhos entregues. Por contexto, como o espelho de aprovação:
// quem conhece os caminhos é o entregaWorkspace, no fundo do sub-turno, e
// mudar a assinatura de toda a cadeia para devolver uma lista que só o plano
// do master consome seria espalhar o planejamento por onde ele não mora.
type coletorDeEntregaKey struct{}

func comColetorDeEntrega(ctx context.Context, coletor *[]string) context.Context {
	return context.WithValue(ctx, coletorDeEntregaKey{}, coletor)
}

func coletorDeEntrega(ctx context.Context) (*[]string, bool) {
	coletor, ok := ctx.Value(coletorDeEntregaKey{}).(*[]string)
	return coletor, ok && coletor != nil
}

// maxCaminhosNoGoal limita quantos caminhos entregues o goal do dependente
// cita — o mesmo julgamento do cartão de entrega (maxEntregaPaths): uma lista
// de 400 arquivos no goal vira ruído que empurra o pedido para fora da janela.
const maxCaminhosNoGoal = 20

func listaDeCaminhos(caminhos []string) string {
	if len(caminhos) <= maxCaminhosNoGoal {
		return strings.Join(caminhos, ", ")
	}
	resto := len(caminhos) - maxCaminhosNoGoal
	return strings.Join(caminhos[:maxCaminhosNoGoal], ", ") +
		fmt.Sprintf(" … e mais %d arquivo(s)", resto)
}

/* ------------------------------- execução ---------------------------------- */

// resultadoDeItem é o desfecho de UM item do plano. Um item pulado por
// dependência entra no mapa com o zero do tipo — ok falso corta os dependentes
// dele também, que é o comportamento certo: a corrente inteira atrás de uma
// falha não roda.
type resultadoDeItem struct {
	ok    bool
	texto string
	// entregues são os caminhos que a promoção DESTE item pôs no projeto — é o
	// que o goal do dependente cita, para o próximo ofício ler em vez de recriar.
	entregues []string
}

// dependenciasSemEntrega devolve as posições (1-based) de que o item depende e
// que NÃO entregaram — por falha, recusa ou por terem sido puladas.
func dependenciasSemEntrega(item masterPlanItem, resultados map[int]resultadoDeItem) []int {
	var faltantes []int
	for _, dep := range item.DependsOn {
		if resultado, ok := resultados[dep]; !ok || !resultado.ok {
			faltantes = append(faltantes, dep)
		}
	}
	return faltantes
}

// goalDoItem monta o objetivo que desce à filha: o goal do plano e, para o
// dependente, a ENTREGA de cada upstream — os caminhos JÁ promovidos ao
// projeto e o resultado dele. É a versão do bloco de upstream da Equipe para o
// caminho do master: sem isto o Design "leria o projeto" sem saber o que
// procurar, e com o artefato inline no goal a janela estouraria — caminho é o
// que trafega, nunca o conteúdo.
func goalDoItem(item masterPlanItem, plano planoDoMaster, resultados map[int]resultadoDeItem) string {
	if len(item.DependsOn) == 0 {
		return item.Goal
	}
	var builder strings.Builder
	builder.WriteString(item.Goal)
	for _, dep := range item.DependsOn {
		resultado := resultados[dep]
		nome := specialist.GetOrDefault(plano.items[dep-1].Specialist).Name
		fmt.Fprintf(&builder, "\n\nEntrega do item %d (%s), já promovida ao projeto da sessão", dep, nome)
		if len(resultado.entregues) > 0 {
			fmt.Fprintf(&builder, " — arquivos: %s", listaDeCaminhos(resultado.entregues))
		}
		builder.WriteString(":\n")
		builder.WriteString(truncate(resultado.texto, 1500))
	}
	builder.WriteString("\n\nEsses arquivos JÁ estão no projeto — leia-os com fs.list/fs.read em vez de recriar do zero.")
	return builder.String()
}

// rotaDoItem decide a rota publicada na FILHA do item. O dono decidido pela
// cascata mantém a rota original (transparência: a decisão veio de lá); os
// demais itens saem como RouteModel — foi o modelo do master, na chamada de
// planejamento, quem os escalou — com o item nomeado nos sinais.
func rotaDoItem(base protocol.Route, cascata specialist.Definition, item masterPlanItem, numero int) protocol.Route {
	if item.Specialist == cascata.ID {
		return base
	}
	return decorate(protocol.Route{
		Specialist: item.Specialist,
		Previous:   base.Previous,
		Reason:     protocol.RouteModel,
		Confidence: 1,
		Signals:    []string{fmt.Sprintf("item %d do plano do master", numero)},
	})
}

// executaPlanoDoMaster roda os itens em ordem de dependência, cada um pelo
// MESMO delegateWithRoute de hoje. Devolve se o turno foi interrompido.
//
// Três decisões deliberadas, cada uma com o porquê:
//
//   - SEQUENCIAL, nunca em paralelo: o dependente lê o que o anterior
//     ENTREGOU, e a delegação do turno roda em sequência por desenho (o
//     delegationBudget não tem mutex de propósito — ver delegate.go);
//   - STAGING PRÓPRIO por item: do segundo item em diante o workspace é
//     recongelado, porque a cópia nova nasce do projeto JÁ com a entrega do
//     anterior dentro — é assim que o Design enxerga o index.html que o
//     Código promoveu; reusar a cópia do item 1 mostraria um projeto de antes
//     da entrega (e a promoção já a consumiu);
//   - ORÇAMENTO DE DELEGAÇÃO por item: cada item é "o masterDelegate de
//     hoje" — um turno de trabalho da pessoa — e os tetos do bot-a-bot valem
//     DENTRO dele, como valiam quando o turno inteiro era um item só. O
//     multiplicador é capado pelo teto do plano (masterPlanMaxItems).
func (s *Supervisor) executaPlanoDoMaster(
	ctx context.Context,
	sessionID, turn string,
	baseRoute protocol.Route,
	cascata specialist.Definition,
	plano planoDoMaster,
) bool {
	masterActor := protocol.Actor{Kind: protocol.ActorSupervisor, ID: specialist.MasterID}
	sistema := protocol.Actor{Kind: protocol.ActorSupervisor}
	resultados := make(map[int]resultadoDeItem, len(plano.items))

	for posicao, indice := range plano.ordem {
		if ctx.Err() != nil {
			return true
		}
		item := plano.items[indice]
		numero := indice + 1
		alvo := specialist.GetOrDefault(item.Specialist)

		// FALHA CORTA DEPENDENTES — a regra da Equipe (results só existe para
		// quem entregou): rodar o Design sobre uma estrutura que não existe
		// produziria um visual plausível de um site que ninguém fez. O aviso é
		// honesto e fica na raiz, onde a pessoa está lendo; os itens
		// INDEPENDENTES seguem normalmente.
		if faltantes := dependenciasSemEntrega(item, resultados); len(faltantes) > 0 {
			resultados[numero] = resultadoDeItem{}
			_ = s.emit(sessionID, turn, protocol.KindMessage, sistema, protocol.Message{
				Role: "system",
				Text: fmt.Sprintf("O item %d (%s) não rodou: dependia do item %s, que não entregou.",
					numero, alvo.Name, listaDeNumeros(faltantes)),
			})
			continue
		}

		// O CONTEXTO do item: o primeiro usa a cópia já congelada do turno; os
		// seguintes recongelam (staging próprio) para a cópia nascer do projeto
		// com as entregas anteriores dentro. O descarte do recongelado é
		// garantido aqui mesmo — no caminho feliz a promoção já o limpou e o
		// descarte é não-op; o do primeiro fica com o defer do masterDelegate.
		itemCtx := ctx
		if posicao > 0 {
			itemCtx = s.comWorkspace(ctx, sessionID, turn, "", "", workspace.OriginModel)
		}
		var entregues []string
		itemCtx = comColetorDeEntrega(itemCtx, &entregues)

		rota := rotaDoItem(baseRoute, cascata, item, numero)
		motivo := "o pedido é trabalho da especialidade dele"
		if plano.planejado {
			motivo = fmt.Sprintf("item %d do plano do master", numero)
		}

		s.thinking(sessionID, turn, masterActor, "chamando o especialista "+alvo.Name+"…", false)
		budget := &delegationBudget{}
		outcome, ok := s.delegateWithRoute(itemCtx, sessionID, turn, specialist.Master, delegateRequest{
			Specialist: item.Specialist,
			Goal:       goalDoItem(item, plano, resultados),
			Reason:     motivo,
		}, budget, firstDelegationDepth, &rota)
		s.thinking(sessionID, turn, masterActor, "", true)
		if posicao > 0 {
			s.descartaWorkspace(itemCtx)
		}

		if errors.Is(ctx.Err(), context.Canceled) {
			return true
		}
		resultados[numero] = resultadoDeItem{ok: ok, texto: outcome, entregues: entregues}
		if !ok {
			// Recusa e falha ficam NA RAIZ, como aviso do sistema — a regra que
			// o caminho de item único sempre teve: a filha só recebe trabalho
			// que aconteceu, e aqui o dono é a pessoa.
			_ = s.emit(sessionID, turn, protocol.KindMessage, sistema,
				protocol.Message{Role: "system", Text: outcome})
		}
	}
	return false
}
