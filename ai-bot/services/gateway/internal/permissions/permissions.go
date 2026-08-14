// Package permissions é o portão de aprovação humana do gateway.
//
// No app anterior a aprovação era o que separava "o modelo sugere" de "o
// modelo faz". Sendo o último degrau antes do efeito colateral, tudo aqui é
// escrito para falhar FECHADO: risco de ferramenta desconhecida vira execute,
// modo desconhecido vira "perguntar", e o zero de Decision não é "liberar".
//
// Duas armadilhas que o levantamento registrou e que este pacote existe para
// manter fechadas:
//
//  1. Um programa que COMBINA ferramentas (o code mode do app anterior) não é
//     porta lateral. Cada chamada de dentro do programa passa por Evaluate
//     como se fosse avulsa — se escrever um programa driblasse o portão, seria
//     mais fácil pedir ao modelo um programa do que pedir a ferramenta direto.
//     Por isso Evaluate não tem parâmetro de "origem": não existe chamada
//     privilegiada por vir de dentro de outra.
//
//  2. "Aprovar sempre" fica preso ao DIGEST dos argumentos, nunca ao nome da
//     ferramenta. Um "sim" para fs.write naquele arquivo não pode virar cheque
//     em branco para fs.write em qualquer outro (ver Grant).
//
// O bloqueio de domínio (HostBlocked) é portado do app anterior com o mesmo
// casamento por fronteira de rótulo — o porquê está no comentário da função.
package permissions

import (
	"fmt"
	"sort"
	"strings"
	"sync"

	"aibot/gateway/internal/protocol"
	"aibot/gateway/internal/specialist"
)

// Mode é a política de aprovação escolhida para a sessão.
type Mode string

const (
	// ModeAsk pergunta em TODA chamada, inclusive leitura: ler arquivo do
	// projeto é o caminho mais barato de exfiltração que existe, e quem
	// escolhe "perguntar sempre" está pedindo exatamente isso.
	ModeAsk Mode = "ask"
	// ModeEdits pergunta só no que altera, executa ou toca segredo.
	ModeEdits Mode = "edits"
	// ModeAll não pergunta nada. Existe para automação sem humano na frente
	// (tarefa agendada, worker de orquestração); numa sessão com pessoa é
	// justamente a opção que anula este pacote.
	ModeAll Mode = "all"
)

// Policy é o que o admin (ou a automação) decidiu que esta sessão pode.
type Policy struct {
	Mode Mode
	// AllowedSpecialists vazio significa todos — política não configurada não
	// pode bloquear todo mundo no dia seguinte à migração.
	AllowedSpecialists []string
	// DeniedTools é recusa dura: nem chega a perguntar.
	DeniedTools    []string
	BlockedDomains []string
	// AgentTools falso derruba a ferramenta inteira e sobra só texto. É o
	// interruptor geral de quem ainda não homologou execução na estação.
	AgentTools bool
	// Tetos da delegação. Um agente que aciona agentes é recursão dirigida por
	// modelo: sem teto, o custo de uma execução não tem fim conhecido.
	MaxDepth    int
	MaxChildren int
	MaxTotal    int
}

// DefaultPolicy é o que vale quando ninguém configurou nada: conservadora o
// bastante para não assustar e permissiva o bastante para o app ser usável.
func DefaultPolicy() Policy {
	return Policy{
		Mode:        ModeEdits,
		AgentTools:  true,
		MaxDepth:    3,
		MaxChildren: 4,
		MaxTotal:    24,
	}
}

// Decision é o veredito do portão.
type Decision int

// As constantes começam em 1 de propósito: assim o zero do tipo — um Decision
// declarado e esquecido — não é DecisionAllow. Comparar contra DecisionAllow
// dá falso, que é o desfecho seguro.
const (
	DecisionAllow Decision = iota + 1
	DecisionDeny
	DecisionAsk
)

// String evita que 1, 2 e 3 vazem para log e telemetria.
func (d Decision) String() string {
	switch d {
	case DecisionAllow:
		return "allow"
	case DecisionDeny:
		return "deny"
	case DecisionAsk:
		return "ask"
	default:
		return "desconhecida"
	}
}

// Gate guarda a política e o que a pessoa já liberou nesta sessão.
type Gate struct {
	mu     sync.RWMutex
	policy Policy
	// digests guarda o par ferramenta+argumentos já aprovado. É o escopo do
	// "aprovar sempre": o mesmo comando naquele mesmo alvo.
	digests map[string]struct{}
	// session guarda a ferramenta liberada por inteiro. É mais largo do que o
	// digest e por isso só entra quando a pessoa escolhe explicitamente esse
	// escopo — nunca como consequência de um "sim" comum.
	session map[string]struct{}
}

// NewGate cria o portão com a política dada.
func NewGate(policy Policy) *Gate {
	return &Gate{
		policy:  clonePolicy(policy),
		digests: make(map[string]struct{}),
		session: make(map[string]struct{}),
	}
}

// SetPolicy troca a política em execução. As concessões já dadas NÃO são
// apagadas aqui porque não precisam ser: Evaluate consulta a política antes do
// cache, então apertar a política já invalida na prática o que foi concedido.
func (g *Gate) SetPolicy(policy Policy) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.policy = clonePolicy(policy)
}

// Policy devolve uma cópia. Cópia rasa compartilharia o array das listas, e
// quem chamasse Policy() poderia reescrever a lista de recusa por fora — sem
// passar pelo SetPolicy e sem o mutex.
func (g *Gate) Policy() Policy {
	g.mu.RLock()
	defer g.mu.RUnlock()
	return clonePolicy(g.policy)
}

// AllowsSpecialist diz se o especialista está liberado para esta sessão. O
// roteador usa isto para montar a lista de candidatos: especialista fora da
// política não deve nem aparecer como destino possível.
func (g *Gate) AllowsSpecialist(id string) bool {
	g.mu.RLock()
	defer g.mu.RUnlock()
	return specialistAllowed(g.policy.AllowedSpecialists, strings.TrimSpace(id))
}

// Evaluate decide uma chamada de ferramenta e devolve o motivo em português —
// a frase que a tela mostra. Motivo vazio transformaria o diálogo de aprovação
// num botão que se aperta no automático, que é o oposto do que ele existe para
// fazer.
//
// A ordem importa e é a mais restritiva primeiro: recusa dura, interruptor
// geral, catálogo do especialista, cache de concessões e só então o modo.
func (g *Gate) Evaluate(specialistID, tool string, risk protocol.Risk, digest string) (Decision, string) {
	specialistID = strings.TrimSpace(specialistID)
	tool = strings.TrimSpace(tool)
	digest = strings.TrimSpace(digest)

	g.mu.RLock()
	defer g.mu.RUnlock()

	// (1) Recusa dura do admin. Vem antes de tudo, inclusive de ModeAll: o que
	// a empresa proibiu não é assunto da automação.
	for _, denied := range g.policy.DeniedTools {
		if strings.EqualFold(strings.TrimSpace(denied), tool) {
			return DecisionDeny, fmt.Sprintf("a política recusa a ferramenta %s", tool)
		}
	}

	// (2) Interruptor geral.
	if !g.policy.AgentTools {
		return DecisionDeny, "a política desta sessão não libera ferramenta nenhuma — só texto"
	}

	// (3) Catálogo do especialista. GetOrDefault não falha por id desconhecido
	// (uma conversa antiga com id velho não pode derrubar a execução), e o
	// master, que não tem lista de ferramentas, não chama nada — ele só roteia.
	if !specialistAllowed(g.policy.AllowedSpecialists, specialistID) {
		return DecisionDeny, fmt.Sprintf("o especialista %s não está liberado para esta sessão", specialistID)
	}
	definition := specialist.GetOrDefault(specialistID)
	if !definition.AllowsTool(tool) {
		return DecisionDeny, fmt.Sprintf("o especialista %s não usa a ferramenta %s", definition.Name, tool)
	}

	// (4) O que a pessoa já liberou. O digest primeiro, porque é o escopo
	// estreito e o que carrega a informação útil para a frase da tela.
	if digest != "" {
		if _, ok := g.digests[grantKey(tool, digest)]; ok {
			return DecisionAllow, "você já aprovou esta ferramenta com estes mesmos argumentos"
		}
	}
	if _, ok := g.session[tool]; ok {
		return DecisionAllow, fmt.Sprintf("%s foi liberada para a sessão inteira", tool)
	}

	// (5) O modo.
	switch g.policy.Mode {
	case ModeAll:
		return DecisionAllow, "política \"aprovar tudo\" — sessão sem confirmação"
	case ModeEdits:
		// Rede fica de fora da lista que pergunta porque o destino já passou
		// pela blocklist da política (HostBlocked) e porque uma chamada de rede
		// não altera arquivo nem roda processo na estação.
		switch risk {
		case protocol.RiskWrite, protocol.RiskExecute, protocol.RiskSecret:
			return DecisionAsk, fmt.Sprintf("risco %s pede confirmação na política \"aprovar edições\"", risk)
		default:
			return DecisionAllow, fmt.Sprintf("risco %s não altera nem executa nada no projeto", risk)
		}
	case ModeAsk:
		return DecisionAsk, "política \"perguntar sempre\""
	default:
		// Modo que ninguém reconhece é tratado como o mais exigente — mesma
		// regra do ranking de aprovação do app anterior.
		return DecisionAsk, fmt.Sprintf("política %q desconhecida — tratada como \"perguntar sempre\"", string(g.policy.Mode))
	}
}

// Grant registra o que a pessoa liberou. O escopo é a diferença entre um sim e
// um cheque em branco:
//
//   - "once" não guarda NADA. A chamada em curso já foi liberada por quem
//     clicou; guardar transformaria uma resposta pontual em regra;
//   - "digest" prende a liberação ao par ferramenta+argumentos. É o "aprovar
//     sempre" honesto: vale para este comando neste alvo, e o próximo alvo
//     pergunta de novo;
//   - "session" libera a ferramenta inteira até o Revoke. É o escopo largo, e
//     só existe porque a pessoa pode escolhê-lo de propósito.
//
// Digest vazio com escopo "digest" não guarda nada: sem argumentos para
// prender, a concessão viraria exatamente o cheque em branco por nome de
// ferramenta que este pacote existe para impedir. Escopo desconhecido também
// não guarda nada, pelo mesmo motivo de sempre — na dúvida, fecha.
func (g *Gate) Grant(scope, tool, digest string) {
	scope = strings.ToLower(strings.TrimSpace(scope))
	tool = strings.TrimSpace(tool)
	digest = strings.TrimSpace(digest)
	if tool == "" {
		return
	}

	g.mu.Lock()
	defer g.mu.Unlock()
	switch scope {
	case "digest":
		if digest == "" {
			return
		}
		g.digests[grantKey(tool, digest)] = struct{}{}
	case "session":
		g.session[tool] = struct{}{}
	}
}

// Revoke apaga tudo o que foi concedido. É o que o botão "revogar aprovações"
// chama, e o que a troca de projeto deve chamar: aprovação dada olhando um
// repositório não vale para outro.
func (g *Gate) Revoke() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.digests = make(map[string]struct{})
	g.session = make(map[string]struct{})
}

// Granted descreve, em português e em ordem estável, o que está concedido.
// Ordem estável porque esta lista aparece numa tela: mapa em Go itera em ordem
// aleatória e a lista dançaria a cada render.
func (g *Gate) Granted() []string {
	g.mu.RLock()
	defer g.mu.RUnlock()

	out := make([]string, 0, len(g.digests)+len(g.session))
	for key := range g.digests {
		tool, digest, _ := strings.Cut(key, grantSeparator)
		out = append(out, fmt.Sprintf("%s — argumentos %s", tool, shortDigest(digest)))
	}
	for tool := range g.session {
		out = append(out, fmt.Sprintf("%s — sessão inteira", tool))
	}
	sort.Strings(out)
	return out
}

// grantSeparator separa ferramenta e digest na chave do mapa. O byte nulo não
// aparece em nome de ferramenta nem em digest hexadecimal, então não há como
// forjar a chave de um par escrevendo o separador dentro do outro campo.
const grantSeparator = "\x00"

func grantKey(tool, digest string) string {
	return tool + grantSeparator + digest
}

// shortDigest encurta o digest para caber na tela sem virar ilegível. Corta
// por runa porque cortar por byte poderia partir um caractere ao meio e
// entregar UTF-8 inválido para a interface.
func shortDigest(digest string) string {
	const limite = 12
	runes := []rune(digest)
	if len(runes) <= limite {
		return digest
	}
	return string(runes[:limite]) + "…"
}

// specialistAllowed trata lista vazia como "todos" — ver Policy.
func specialistAllowed(allowed []string, id string) bool {
	if len(allowed) == 0 {
		return true
	}
	for _, item := range allowed {
		if strings.EqualFold(strings.TrimSpace(item), id) {
			return true
		}
	}
	return false
}

// clonePolicy copia as listas para que a política guardada e a devolvida não
// compartilhem array com quem as passou.
func clonePolicy(policy Policy) Policy {
	policy.AllowedSpecialists = cloneStrings(policy.AllowedSpecialists)
	policy.DeniedTools = cloneStrings(policy.DeniedTools)
	policy.BlockedDomains = cloneStrings(policy.BlockedDomains)
	return policy
}

func cloneStrings(list []string) []string {
	if len(list) == 0 {
		// Preserva nil como nil: lista vazia e lista ausente significam a mesma
		// coisa aqui, e alocar por nada em todo Policy() seria desperdício.
		return nil
	}
	out := make([]string, len(list))
	copy(out, list)
	return out
}

/* --------------------------- bloqueio de domínio --------------------------- */

// HostBlocked devolve a regra que bloqueia o host, se alguma bloquear.
//
// Portado do app anterior com o comportamento idêntico, porque a armadilha que
// ele evita é sutil: `strings.HasSuffix(host, "exemplo.com")` casa também
// "malexemplo.com" — um domínio sem relação nenhuma, que qualquer um registra
// de graça e que passaria pelo bloqueio. O casamento respeita a fronteira do
// rótulo: ou é o domínio exato, ou termina em ".exemplo.com".
//
//   - "exemplo.com" bloqueia exemplo.com e qualquer subdomínio;
//   - "*.exemplo.com" bloqueia SÓ os subdomínios (o apex fica liberado);
//   - "malexemplo.com" NÃO é bloqueado por "exemplo.com".
//
// A regra devolvida é a original em minúsculas — quem apanhar precisa saber
// exatamente o que pedir ao admin para liberar.
func HostBlocked(rules []string, host string) (string, bool) {
	for _, rule := range rules {
		if ruleMatchesHost(rule, host) {
			return strings.ToLower(strings.TrimSpace(rule)), true
		}
	}
	return "", false
}

func ruleMatchesHost(rule, host string) bool {
	normalizedRule := normalizeHost(rule)
	normalizedHost := normalizeHost(host)
	if normalizedRule == "" || normalizedHost == "" {
		return false
	}
	if base, ok := strings.CutPrefix(normalizedRule, "*."); ok {
		if base == "" {
			return false
		}
		return strings.HasSuffix(normalizedHost, "."+base)
	}
	return normalizedHost == normalizedRule || strings.HasSuffix(normalizedHost, "."+normalizedRule)
}

// normalizeHost deixa o host comparável: minúsculas, sem porta e sem o ponto
// final do FQDN ("exemplo.com." e "exemplo.com" são o mesmo nome).
//
// A porta só aparece quando a entrada veio digitada pelo admin — URL já
// chega com host separado. E o corte do ':' pula quem começa com '[': endereço
// IPv6 tem ':' no meio do nome e seria decapitado no primeiro deles.
//
// O ponto final é aparado DEPOIS da porta, e não antes, para que
// "exemplo.com.:8080" — que junta as duas sujeiras — também caia em
// "exemplo.com" em vez de sobrar com o ponto e escapar do bloqueio.
func normalizeHost(host string) string {
	clean := strings.ToLower(strings.TrimSpace(host))
	if !strings.HasPrefix(clean, "[") {
		if index := strings.Index(clean, ":"); index >= 0 {
			clean = clean[:index]
		}
	}
	return strings.TrimRight(clean, ".")
}

/* ------------------------------- risco ------------------------------- */

// riskByTool é tabela fixa, só de leitura — não é estado: nada nela muda
// depois da compilação, então não precisa (nem deve) de mutex.
var riskByTool = map[string]protocol.Risk{
	// Lê e não altera nada. web.fetch entra aqui porque não toca no projeto;
	// o que ele tem de perigoso é o destino, e quem cuida disso é HostBlocked.
	"fs.read":         protocol.RiskRead,
	"fs.list":         protocol.RiskRead,
	"fs.search":       protocol.RiskRead,
	"git.status":      protocol.RiskRead,
	"git.diff":        protocol.RiskRead,
	"web.search":      protocol.RiskRead,
	"web.fetch":       protocol.RiskRead,
	"memory.read":     protocol.RiskRead,
	"office.open":     protocol.RiskRead,
	"pdf.extract":     protocol.RiskRead,
	"runtime.status":  protocol.RiskRead,
	"finetune.status": protocol.RiskRead,

	// Deixa rastro: arquivo novo, arquivo alterado, worktree criada, commit
	// feito. image.generate está aqui porque termina em arquivo no disco.
	"fs.write":         protocol.RiskWrite,
	"fs.patch":         protocol.RiskWrite,
	"office.edit":      protocol.RiskWrite,
	"office.export":    protocol.RiskWrite,
	"memory.write":     protocol.RiskWrite,
	"schema.export":    protocol.RiskWrite,
	"sql.render":       protocol.RiskWrite,
	"flow.validate":    protocol.RiskWrite,
	"design.replicate": protocol.RiskWrite,
	"image.generate":   protocol.RiskWrite,
	"finetune.submit":  protocol.RiskWrite,
	"worktree.create":  protocol.RiskWrite,
	"worktree.remove":  protocol.RiskWrite,
	"git.commit":       protocol.RiskWrite,

	// Roda processo com o token de quem está logado. O confinamento de caminho
	// limita onde se escreve, não o que o comando faz.
	"proc.run":        protocol.RiskExecute,
	"term.open":       protocol.RiskExecute,
	"diagnostics.run": protocol.RiskExecute,
	"task.dispatch":   protocol.RiskExecute,
	"task.gate":       protocol.RiskExecute,

	// Sai para fora da estação.
	"webhook.post":    protocol.RiskNetwork,
	"mcp.call":        protocol.RiskNetwork,
	"osv.query":       protocol.RiskNetwork,
	"schedule.create": protocol.RiskNetwork,

	// Toca segredo.
	"secrets.scan": protocol.RiskSecret,
}

// RiskOf classifica a ferramenta. Ferramenta que a tabela não conhece é
// tratada como execute — o mais restritivo — de propósito: ferramenta nova
// (ou vinda de servidor MCP externo) não pode nascer liberada só porque
// ninguém lembrou de classificá-la aqui.
func RiskOf(tool string) protocol.Risk {
	if risk, ok := riskByTool[strings.ToLower(strings.TrimSpace(tool))]; ok {
		return risk
	}
	return protocol.RiskExecute
}
