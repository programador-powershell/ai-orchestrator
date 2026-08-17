// O ELENCO do primeiro input: quem atende e quem fica em espera.
//
// Escolher o dono nunca foi o trabalho todo. "Crie uma aplicação completa" é do
// Código — e se ela tem interface, o Design tem o que fazer; depois de existir
// código, alguém revisa a segurança. Sem elenco, a pessoa precisaria lembrar de
// pedir cada um, que é justamente o roteamento que o master existe para não
// devolver a ela.
//
// Duas fontes montam o elenco, e elas se complementam:
//
//  1. As COMPANHIAS declaradas no catálogo (specialist.Companion): regra de
//     ofício, escrita como dado. "Código com interface chama Design em
//     paralelo"; "aplicação nova chama Segurança depois".
//
//  2. O que o LÉXICO viu no pedido: um especialista que pontuou forte e não
//     ganhou provavelmente tem trabalho ali. "Crie o app e o banco de cobrança"
//     dá Código dono e Dados com pontuação alta — e Dados entra mesmo que
//     nenhuma companhia o citasse.
//
// O que este arquivo NÃO faz: executar. Ele monta a intenção; quem despacha é a
// equipe (crew.go), e quem confirma é a pessoa. Um elenco que já saísse rodando
// transformaria "crie uma aplicação" em cinco modelos gastando dinheiro sem
// ninguém ter pedido.
package supervisor

import (
	"sort"
	"strings"

	"aibot/gateway/internal/protocol"
	"aibot/gateway/internal/specialist"
)

// castLexicalMin é a pontuação a partir da qual um especialista que NÃO ganhou
// entra em espera por mérito próprio.
//
// Mais baixo que `MinConfidence` (0,55) de propósito: para DECIDIR sozinho o
// léxico precisa de convicção, mas para dizer "este aqui provavelmente tem
// trabalho neste pedido" um sinal claro basta. Alto demais e o elenco fica
// sempre vazio; baixo demais e todo pedido convoca meio catálogo — e um aviso
// que aparece sempre é um aviso que ninguém lê.
const castLexicalMin = 0.30

// maxStandby limita o elenco. Mais que três bots em espera na barra lateral
// deixa de ser informação e vira enfeite.
const maxStandby = 3

// Cast monta o elenco de apoio para um pedido já roteado.
//
// `owner` é quem atende; `scores` é o ranking do léxico (pode ser nil quando a
// rota veio do modelo ou do sticky); `allowed` são os ids que a política desta
// sessão libera — um bot em espera que a sessão não pode usar seria uma promessa
// que o portão vai quebrar depois.
func Cast(
	prompt string,
	owner string,
	scores []Scored,
	allowed []specialist.Definition,
) []protocol.Standby {
	normalized := Normalize(prompt)
	permitted := make(map[string]bool, len(allowed))
	for _, candidate := range allowed {
		permitted[candidate.ID] = true
	}

	// Ordem de inserção preservada: as companhias declaradas vêm primeiro
	// porque são regra de ofício, e o léxico completa o que sobrou.
	chosen := make([]protocol.Standby, 0, maxStandby)
	seen := map[string]bool{owner: true}

	add := func(id, when, why string) {
		if seen[id] || !permitted[id] || len(chosen) >= maxStandby {
			return
		}
		seen[id] = true
		chosen = append(chosen, protocol.Standby{Specialist: id, When: when, Why: why})
	}

	for _, companion := range specialist.GetOrDefault(owner).Companions {
		if !requirementsMet(normalized, companion.Requires) {
			continue
		}
		add(companion.Specialist, string(companion.When), companion.Why)
	}

	// O léxico completa. Ordenado por pontuação para o mais provável entrar
	// primeiro quando o teto apertar.
	byScore := append([]Scored(nil), scores...)
	sort.SliceStable(byScore, func(i, j int) bool { return byScore[i].Confidence > byScore[j].Confidence })
	for _, score := range byScore {
		if score.ID == owner || score.Confidence < castLexicalMin {
			continue
		}
		add(score.ID, defaultRelation(owner, score.ID),
			"o pedido tem sinal de "+specialist.GetOrDefault(score.ID).Name+
				" ("+strings.Join(score.Signals, ", ")+")")
	}

	if len(chosen) == 0 {
		return nil
	}
	return chosen
}

// requirementsMet diz se o pedido tem algum dos radicais exigidos. Lista vazia
// significa "sem condição" — o companheiro entra sempre.
func requirementsMet(normalized string, requires []string) bool {
	if len(requires) == 0 {
		return true
	}
	for _, radical := range requires {
		if strings.Contains(normalized, Normalize(radical)) {
			return true
		}
	}
	return false
}

// defaultRelation decide série ou paralelo para quem entrou pelo LÉXICO, sem
// companhia declarada dizendo quando.
//
// A regra é a dependência de ARTEFATO: quem revisa, documenta ou empacota
// precisa que o trabalho exista; quem projeta ou modela pode trabalhar junto.
// Errar para o lado de "depois" é o erro barato — serializar demais custa
// tempo, paralelizar quem depende produz um parecer sobre o vazio.
func defaultRelation(owner, companion string) string {
	switch companion {
	case "security", "office":
		return string(specialist.RelationAfter)
	}
	return string(specialist.RelationParallel)
}
