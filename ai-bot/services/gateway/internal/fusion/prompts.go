// Fusion de produção — papéis cooperativos SEM sobreposição.
//
// Porte do motor do orquestrador (`apps/desktop/src/lib/fusionPrompts.ts`) para
// o gateway. Os TEXTOS dos papéis vieram de lá quase palavra por palavra, e é
// deliberado: eles são o produto do ajuste de quem usou a coisa, não prosa que
// se reescreve por gosto. O que mudou foi o idioma da máquina (TypeScript → Go)
// e o lugar onde roda — aqui, e não no cliente, porque é o gateway que tem o
// cofre, o roteador de modelos e o orçamento do turno.
//
// Regra de ouro: quem orquestra NUNCA produz o entregável final; quem executa
// NUNCA planeja nem muda o escopo. Cada especialidade define a política de
// divisão:
//
//   - security → política de SALVAGUARDA: o modelo menos restrito ORQUESTRA
//     (explora hipóteses de ataque, decide escopo); o modelo mais restrito
//     apenas EXECUTA (implementa correções e entrega).
//   - code     → política de CUSTO/INTELIGÊNCIA: o modelo mais inteligente
//     ORQUESTRA (especifica, divide, revisa); o mais barato apenas EXECUTA.
//   - demais   → política de CAPACIDADE: orquestrador planeja e integra;
//     executores produzem.
//
// O merge NÃO repete a mesma pergunta para N modelos — isso seria sobreposição
// paga três vezes. O orquestrador DECOMPÕE a tarefa em focos complementares,
// um por executor. Este arquivo é 100% puro: testa sem rede.
package fusion

import "aibot/gateway/internal/modelrouter"

// Policy é a divisão de papéis de uma especialidade.
type Policy struct {
	// Name identifica a política na tela e no log.
	Name             string
	OrchestratorRole string
	ExecutorRole     string
}

// RolePolicy devolve a política do especialista.
//
// O id que chega é o do ESPECIALISTA do AI-BOT (chat, code, security…), que faz
// aqui o papel que a "aba" fazia no orquestrador.
func RolePolicy(specialist string) Policy {
	switch specialist {
	case "security":
		return Policy{
			Name: "salvaguarda",
			OrchestratorRole: "Você é o ORQUESTRADOR de segurança (modelo com menos salvaguardas, escolhido para explorar sem autocensura). " +
				"Seu papel: levantar hipóteses de ataque, vetores, abusos e casos de borda que um modelo restrito evitaria mencionar; " +
				"definir o escopo exato do trabalho e os critérios de aceitação. " +
				"PROIBIDO: escrever o entregável final, código de correção ou texto para o usuário — isso é papel do executor.",
			ExecutorRole: "Você é o EXECUTOR de segurança (modelo restrito). Seu papel: seguir ESTRITAMENTE o escopo definido pelo orquestrador, " +
				"implementar as verificações/correções e produzir o entregável final, claro e responsável. " +
				"PROIBIDO: ampliar o escopo, adicionar hipóteses novas ou reescrever o plano — se o escopo parecer incompleto, execute o definido e liste a lacuna ao final.",
		}
	case "code":
		return Policy{
			Name: "custo",
			OrchestratorRole: "Você é o ARQUITETO (modelo mais inteligente do par). Seu papel: transformar o pedido numa especificação técnica curta e inequívoca — " +
				"interfaces, casos de borda, critérios de aceite e o que NÃO fazer — e depois revisar o diff do executor apontando correções pontuais. " +
				"PROIBIDO: escrever o código de produção você mesmo; especificação e revisão apenas.",
			ExecutorRole: "Você é o IMPLEMENTADOR (modelo mais barato do par). Seu papel: escrever o código EXATAMENTE conforme a especificação recebida, sem inventar requisitos, " +
				"sem refatorar fora do escopo e sem decisões de arquitetura próprias. " +
				"PROIBIDO: mudar a spec; dúvidas viram comentário `// DÚVIDA:` no ponto exato.",
		}
	default:
		return Policy{
			Name: "capacidade",
			OrchestratorRole: "Você é o ORQUESTRADOR. Seu papel: planejar a resposta (estrutura, critérios de qualidade, armadilhas) e depois integrar/revisar o material produzido. " +
				"PROIBIDO: produzir o conteúdo final você mesmo na fase de planejamento.",
			ExecutorRole: "Você é o EXECUTOR. Seu papel: produzir o conteúdo seguindo o briefing recebido, sem alterar estrutura nem escopo. " +
				"PROIBIDO: replanejar; lacunas do briefing são apontadas ao final, não resolvidas por conta própria.",
		}
	}
}

/* ------------------------- orchestrate (par) ------------------------- */

// BriefRequest pede a especificação ao orquestrador.
func BriefRequest(specialist, question string) []modelrouter.ChatMessage {
	policy := RolePolicy(specialist)
	return []modelrouter.ChatMessage{
		{Role: "system", Content: policy.OrchestratorRole + "\n\n" +
			"Produza AGORA apenas o briefing/especificação (máx. 12 linhas): objetivo, estrutura esperada do entregável, " +
			"critérios de aceite e armadilhas. Não responda a pergunta."},
		{Role: "user", Content: question},
	}
}

// ExecuteRequest manda o executor cumprir a especificação, com o histórico.
func ExecuteRequest(specialist, brief string, history []modelrouter.ChatMessage) []modelrouter.ChatMessage {
	policy := RolePolicy(specialist)
	saida := make([]modelrouter.ChatMessage, 0, len(history)+1)
	saida = append(saida, modelrouter.ChatMessage{
		Role:    "system",
		Content: policy.ExecutorRole + "\n\nBriefing do orquestrador (siga à risca):\n" + brief,
	})
	return append(saida, history...)
}

// ReviewRequest é a revisão de conformidade — e é ela que vai para a tela.
func ReviewRequest(specialist, question, draft string) []modelrouter.ChatMessage {
	policy := RolePolicy(specialist)
	return []modelrouter.ChatMessage{
		{Role: "system", Content: policy.OrchestratorRole + "\n\n" +
			"Fase de revisão: você recebeu o rascunho do executor. NÃO reescreva do zero (isso sobreporia o trabalho dele). " +
			"Se estiver conforme a especificação, devolva-o intacto com no máximo ajustes pontuais; " +
			"se houver não-conformidades, corrija SOMENTE os trechos afetados. Devolva apenas o entregável final."},
		{Role: "user", Content: "Pedido original:\n" + question + "\n\nRascunho do executor:\n" + draft},
	}
}

/* --------------------- merge (decompor e integrar) ------------------- */

// SubtaskRequest dá a UM executor o foco que é só dele.
func SubtaskRequest(specialist, question, subtask string, index, total int) []modelrouter.ChatMessage {
	policy := RolePolicy(specialist)
	return []modelrouter.ChatMessage{
		{Role: "system", Content: policy.ExecutorRole + "\n\n" +
			itoa(index+1) + "º executor de " + itoa(total) + ". Trabalhe SOMENTE no seu foco — os demais focos pertencem a outros executores; " +
			"não os cubra nem os repita."},
		{Role: "user", Content: "Tarefa geral (contexto):\n" + question + "\n\nSEU FOCO:\n" + subtask},
	}
}

// IntegrateRequest costura as partes — sem reescrever o trabalho de ninguém.
func IntegrateRequest(specialist, question string, parts []Part) []modelrouter.ChatMessage {
	policy := RolePolicy(specialist)
	material := ""
	for index, part := range parts {
		if index > 0 {
			material += "\n\n"
		}
		material += "### Parte " + itoa(index+1) + " — foco: " + part.Focus + "\n" + part.Content
	}
	return []modelrouter.ChatMessage{
		{Role: "system", Content: policy.OrchestratorRole + "\n\n" +
			"Fase de integração: costure as partes num entregável único e coerente. NÃO reescreva o conteúdo das partes " +
			"(cada uma é trabalho exclusivo de um executor) — ordene, ligue, remova apenas redundância acidental de bordas " +
			"e resolva contradições explicitando a resolução. Não mencione o processo."},
		{Role: "user", Content: "Pedido original:\n" + question + "\n\nPartes produzidas:\n" + material},
	}
}

// Part é o que UM executor produziu, com o foco que lhe coube.
type Part struct {
	Focus   string
	Content string
}

// itoa evita puxar strconv só para um número de uma casa em prompt.
func itoa(v int) string {
	if v == 0 {
		return "0"
	}
	negativo := v < 0
	if negativo {
		v = -v
	}
	var buf [20]byte
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	if negativo {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
