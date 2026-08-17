// PERGUNTA ou PEDIDO: a distinção que o assunto sozinho não faz.
//
// "Qual a sintaxe correta de um for em python?" tem `python` no meio e vai
// direto para o especialista de Código pelo léxico — e está errado. A pessoa não
// pediu para escrever código: ela tirou uma dúvida. Quem responde dúvida é a
// Conversa, e mandá-la para o Código troca a tela, muda o placeholder, carrega
// contratos de ferramenta e grava o modo da conversa inteira, tudo por causa de
// uma pergunta.
//
// O erro é assimétrico, e por isso a regra existe. Mandar uma PERGUNTA para o
// especialista errado estraga a conversa toda (o modo é gravado e não se
// reavalia); mandar um PEDIDO para a Conversa custa uma frase — ela diz de quem
// é o assunto e a pessoa reformula. Na dúvida, portanto, pergunta.
//
// Este arquivo é léxico de propósito: é o degrau de microssegundos. A leitura
// SEMÂNTICA — "isto é uma dúvida ou um pedido disfarçado?" — é trabalho do
// degrau local, que recebe a intenção junto do prompt para não ter de deduzi-la
// sozinho.
package supervisor

import "strings"

// Intent é o que a pessoa quer que aconteça.
type Intent string

const (
	// IntentRequest é "faça algo": há um verbo de ação sobre um artefato.
	IntentRequest Intent = "request"
	// IntentQuestion é "me explique": a pessoa quer saber, não quer que seja
	// feito.
	IntentQuestion Intent = "question"
)

// questionOpeners são as aberturas de pergunta em português.
//
// Casam no COMEÇO da frase (ou logo depois de vocativo/cortesia), porque no meio
// elas mudam de função: "não sei como fazer isso" não é pergunta.
var questionOpeners = []string{
	"qual", "quais", "quando", "onde", "quem", "quanto", "quantos", "quantas",
	"o que", "oque", "por que", "porque", "por quê", "pra que", "para que",
	"tem como", "da pra", "dá pra", "da para", "existe algum", "existe alguma",
	"e possivel", "é possível", "vale a pena", "faz sentido", "devo", "posso",
}

// questionMarkers são marcas de dúvida em QUALQUER posição.
//
// "como" fica de fora desta lista de propósito: "como faço um deploy" é pedido
// disfarçado de pergunta, e ele aparece o tempo todo. Quem separa os dois é o
// verbo de ação, testado abaixo — "como corrijo isto" tem ação e é pedido;
// "como funciona isto" não tem e é dúvida.
var questionMarkers = []string{
	"duvida", "dúvida", "me explica", "me explique", "explica ai", "explique",
	"significa", "quer dizer", "serve para", "serve pra", "diferenca entre",
	"diferença entre", "funciona o", "funciona a", "funciona um", "funciona uma",
	"sintaxe correta", "forma correta", "jeito certo", "melhor pratica",
	"melhor prática", "boa pratica", "boa prática",
}

// actionVerbs são os verbos que pedem TRABALHO sobre um artefato.
//
// Radicais, não palavras: "corrig" cobre corrija/corrigir/corrigindo. A presença
// de um deles vence a marca de pergunta — "como eu corrijo esse bug?" é pedido
// com cara de pergunta, e quem tem de atender é o Código.
// A lista tem duas armadilhas do português, e as duas custaram um teste vermelho
// antes de virar comentário:
//
//   - RADICAL QUE TAMBÉM É SUBSTANTIVO. "compil" casava em "o que significa esse
//     erro de compilação" e transformava a dúvida em pedido. Vale para "test"
//     (teste), "rod" (rodapé!), "list" (lista) e "busc" (busca) — todos saíram, e
//     os que ficaram entram pela forma conjugada, não pelo radical nu.
//   - VERBO IRREGULAR. "corrig" NÃO casa em "corrijo": corrigir muda o g em j na
//     primeira pessoa. Sem "corrij", "como eu corrijo esse bug?" era lido como
//     dúvida e ia para a Conversa.
var actionVerbs = []string{
	"cri", "mont", "constr", "desenvolv", "implement", "gera", "gere", "gerar",
	"corrig", "corrij", "consert", "arrum", "refator", "ajust", "atualiz",
	"remov", "apag", "adicion", "acrescent", "escrev", "redij", "desenh",
	"revis", "audit", "otimiz", "migr", "instal", "configur", "public",
	"export", "convert", "traduz", "execut", "deplo", "renomei", "extrai",
	"resum", "procur", "analis", "quebr", "divid",
	// Formas conjugadas, para não pegar o substantivo homônimo.
	"rode", "rodar", "suba", "subir", "liste", "listar", "busque", "buscar",
	"teste este", "testa isso",
}

// IntentOf lê a intenção do texto JÁ NORMALIZADO (minúsculo, sem acento).
//
// Devolve pedido por padrão: a maioria do que chega aqui é trabalho, e tratar
// tudo como dúvida faria a Conversa engolir o produto.
func IntentOf(normalized string) Intent {
	trimmed := strings.TrimSpace(normalized)
	if trimmed == "" {
		return IntentRequest
	}

	// Verbo de ação vence tudo: quem manda fazer, mandou fazer, com ponto de
	// interrogação ou sem.
	if hasActionVerb(trimmed) {
		return IntentRequest
	}

	if strings.Contains(trimmed, "?") {
		return IntentQuestion
	}
	for _, marker := range questionMarkers {
		if strings.Contains(trimmed, marker) {
			return IntentQuestion
		}
	}
	for _, opener := range questionOpeners {
		if strings.HasPrefix(trimmed, opener) {
			return IntentQuestion
		}
	}
	return IntentRequest
}

// hasActionVerb procura um radical de ação em começo de palavra.
//
// O começo de palavra importa: sem ele "subir" casaria dentro de "assubir" e,
// pior, "test" casaria em "contexto" — e um falso positivo aqui transforma
// dúvida em pedido, que é justamente o erro caro.
func hasActionVerb(normalized string) bool {
	for _, verb := range actionVerbs {
		start := 0
		for {
			index := strings.Index(normalized[start:], verb)
			if index < 0 {
				break
			}
			at := start + index
			start = at + len(verb)
			if isWordStart(normalized, at) {
				return true
			}
		}
	}
	return false
}
