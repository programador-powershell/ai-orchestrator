// O PORTÃO DE NARRAÇÃO: o detector mecânico do especialista que DESCREVE o
// trabalho em vez de fazê-lo.
//
// O flagrante que motivou este arquivo: na conversa do Código, o modelo
// respondeu "Resultado do fs.list em .:" seguido de uma listagem INVENTADA
// (api/index.js, vercel.json…) — nenhuma ferramenta tinha sido chamada e a
// pasta do projeto estava VAZIA. A persona já proíbe ("NUNCA cole o arquivo
// inteiro na resposta"), mas persona é instrução, e instrução o modelo ignora
// no dia em que quer. O que faltava era o portão MECÂNICO: o supervisor
// confere se a resposta final ALEGA trabalho que o turno não registrou,
// corrige UMA vez e, na reincidência, encerra o turno como FALHA honesta —
// "não executado" nunca pode sair com cara de ✓. É a regra da
// recusa-como-falha da Equipe (ver refusal em crew.go), aplicada ao turno.
//
// O portão só vale para ESPECIALISTA DE TRABALHO (Surface != conversation): a
// Conversa responde NO chat por ofício, e um bloco de código grande ali é
// exatamente o que a pessoa pediu ("me mostra um exemplo de quicksort").
//
// A detecção é deliberadamente CONSERVADORA porque o custo de errar é
// assimétrico: o falso negativo deixa passar uma encenação — ruim, mas era o
// estado anterior do produto —; o falso positivo descarta trabalho legítimo e
// pune quem respondeu certo. Por isso cada marcador é uma ALEGAÇÃO DE EFEITO
// específica ("criei o arquivo", "gravado em"), nunca palavra de assunto, e o
// bloco cercado só reprova quando é grande demais para ser trecho ilustrativo.
package supervisor

import (
	"strings"

	"aibot/gateway/internal/permissions"
	"aibot/gateway/internal/protocol"
	"aibot/gateway/internal/specialist"
)

// linhasMinimasDeCerca é a partir de quantas linhas NÃO VAZIAS um bloco
// cercado deixa de ser "trecho ilustrativo" (que a persona do Código permite
// de propósito) e vira artefato narrado no chat. Dez porque um trecho que
// ilustra uma função ou um comando cabe em meia dúzia de linhas; uma página
// inteira, uma listagem de pasta ou um arquivo colado passam disso fácil.
const linhasMinimasDeCerca = 10

// marcadoresDeNarracao são as ALEGAÇÕES DE EFEITO que uma resposta só pode
// fazer se alguma ferramenta de efeito rodou de verdade no turno. Comparados
// em minúsculas; sem acento onde o português permite escolher, porque os
// modelos alternam grafias.
//
// A régua para entrar aqui: a frase precisa afirmar que um EFEITO aconteceu
// (saída de ferramenta, arquivo criado, conteúdo gravado). Palavra de assunto
// não entra — "vou criar o arquivo" é plano, não alegação, e não casa com
// nenhum item porque todos estão no passado ou citam a ferramenta pelo nome.
var marcadoresDeNarracao = []string{
	// A alegação de SAÍDA de ferramenta — o texto do flagrante era literalmente
	// "Resultado do fs.list em .:". Cobre fs.list/fs.read/fs.write pela família.
	"resultado do fs.",
	"resultado do proc.",
	"resultado da ferramenta",
	// A alegação de efeito consumado sem efeito no log.
	"criei o arquivo",
	"criei os arquivos",
	"arquivo criado",
	"arquivos criados",
	"gravei o arquivo",
	"gravei em ",
	"gravado em ",
	"salvei o arquivo",
	"salvei em ",
}

// respostaNarrada diz se a resposta final tem cara de trabalho narrado:
// artefato substancial colado em cerca de código OU alegação explícita de
// resultado de ferramenta. Pura de propósito — a tabela de casos de mesa em
// narration_test.go é quem fixa a régua, dos dois lados.
//
// Ela NÃO decide sozinha: quem decide é narrouSemExecutar, que só reprova
// quando o turno também não teve nenhum efeito real — "gravei o arquivo" é a
// resposta CERTA depois de um fs.write ok.
func respostaNarrada(answer string) bool {
	if cercaSubstancial(answer) {
		return true
	}
	lower := strings.ToLower(answer)
	for _, marcador := range marcadoresDeNarracao {
		if strings.Contains(lower, marcador) {
			return true
		}
	}
	return false
}

// cercaSubstancial procura um bloco ``` com conteúdo demais para ser trecho
// ilustrativo. Os blocos de PROTOCOLO (aibot:tool, aibot:delegate, aibot:plan)
// não contam: são máquina, não narração — e quando chegam aqui fechados o
// parser já os transformou em chamada; o que sobra é no máximo um bloco
// truncado, que também não é artefato colado.
func cercaSubstancial(answer string) bool {
	// Fatiado por "```": os índices ímpares são o DENTRO das cercas. Cerca
	// desbalanceada deixa o último pedaço aberto até o fim do texto — e ele
	// conta, porque um artefato cortado no meio do streaming continua sendo um
	// artefato narrado.
	parts := strings.Split(answer, "```")
	for i := 1; i < len(parts); i += 2 {
		label, body, _ := strings.Cut(parts[i], "\n")
		if strings.HasPrefix(strings.TrimSpace(label), "aibot:") {
			continue
		}
		lines := 0
		for _, line := range strings.Split(body, "\n") {
			if strings.TrimSpace(line) != "" {
				lines++
			}
		}
		if lines >= linhasMinimasDeCerca {
			return true
		}
	}
	return false
}

// ferramentaDeEfeito diz se a ferramenta DEIXA RASTRO — escreve arquivo, roda
// processo, produz o artefato que a superfície mostra (fs.write/fs.patch,
// proc.run, design.*, schema.* …).
//
// Derivada do julgamento de risco (permissions.RiskOf), e não de uma lista
// solta aqui: a tabela de risco é o registro que o produto já mantém, e uma
// segunda lista divergiria em silêncio no dia em que uma ferramenta nova
// nascesse. Ferramenta desconhecida vem como RiskExecute — e portanto conta
// como efeito, que é o lado conservador certo DESTE portão: um efeito real não
// reconhecido calaria o portão sobre uma resposta legítima; nunca acusaria uma
// legítima de encenação.
func ferramentaDeEfeito(tool string) bool {
	switch permissions.RiskOf(tool) {
	case protocol.RiskWrite, protocol.RiskExecute:
		return true
	default:
		return false
	}
}

// narrouSemExecutar é a decisão do portão: especialista de TRABALHO, resposta
// com cara de narração e NENHUM efeito consumado no turno. As três condições
// juntas, sempre — cada uma sozinha descreve um turno normal.
func narrouSemExecutar(definition specialist.Definition, answer string, executouEfeito bool) bool {
	return especialistaDeTrabalho(definition) && !executouEfeito && respostaNarrada(answer)
}

/* --------------------------- correção e desfecho --------------------------- */

// exemploDeCercaDeFerramenta é o exemplo CONCRETO da cerca de ferramenta, no
// formato EXATO que parseToolCalls espera (a cerca aibot:tool, o JSON sozinho
// dentro, o fecho). Modelos menores erram o formato quando só veem o exemplo
// abstrato ({...}) — e errar o formato aqui é narrar em vez de executar. O
// teste em narration_test.go faz este texto passar pelo parser de verdade: se
// o formato da cerca mudar, o exemplo quebra junto e o teste acusa.
const exemploDeCercaDeFerramenta = toolFence + "\n" +
	`{"tool":"fs.write","args":{"path":"index.html","content":"<!doctype html><html>…</html>"}}` +
	"\n```"

// correcaoDeNarracao é a correção de sistema reinjetada UMA vez quando o
// portão flagra a narração: diz o que aconteceu, mostra o exemplo concreto e
// manda executar. Uma só, capada — reinjetar para sempre viraria o laço que o
// maxToolRounds existe para matar.
const correcaoDeNarracao = "CORREÇÃO DO SUPERVISOR: você NARROU um resultado em vez de executar — " +
	"nenhuma ferramenta de efeito rodou neste turno, então nada do que você descreveu existe. " +
	"Use as ferramentas de verdade. Exemplo, para gravar um arquivo:\n\n" +
	exemploDeCercaDeFerramenta + "\n\n" +
	"Emita o bloco com uma ferramenta do SEU catálogo, PARE, espere o resultado chegar e só então " +
	"responda curto anunciando o que foi feito. Não descreva saída de ferramenta que não rodou."

// avisoDeNarracao é o rótulo de etapa (KindThinking) que a pessoa vê quando o
// portão age. Telemetria honesta: sem ele, a correção seria só um giro a mais
// de modelo que ninguém explica.
const avisoDeNarracao = "o especialista narrou sem executar — mandei executar de verdade"

// narracaoFailCode é o código da falha honesta — o mesmo caminho visual de
// erro que o turno já tem (KindError), nunca um done com cara de sucesso.
const narracaoFailCode = "narrou_sem_executar"

// narracaoFailMessage monta a mensagem da falha citando um pedaço do que foi
// descartado: a pessoa precisa ver O QUE o modelo alegou para entender por que
// o turno reprovou — "falhou" seco ensinaria a desconfiar do portão, não do
// modelo.
func narracaoFailMessage(answer string) string {
	return "o especialista descreveu o resultado em vez de executar as ferramentas — " +
		"a resposta foi descartada: " + truncate(strings.TrimSpace(stripBlocks(answer)), 200)
}
