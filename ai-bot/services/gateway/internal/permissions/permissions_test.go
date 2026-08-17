// Testes do portão de aprovação.
//
// Este é o último degrau antes do efeito colateral, e tudo aqui é escrito para
// falhar FECHADO. Os dois casos que mais importam:
//
//   - ferramenta que a tabela não conhece cai em execute, não em leitura;
//   - "aprovar sempre" fica preso ao digest dos argumentos, senão um "sim" para
//     um arquivo vira cheque em branco para qualquer outro.
package permissions

import (
	"strings"
	"testing"

	"aibot/gateway/internal/protocol"
)

/* ------------------------------ auxiliares ------------------------------ */

func editsGate(t *testing.T) *Gate {
	t.Helper()
	policy := DefaultPolicy()
	if policy.Mode != ModeEdits {
		t.Fatalf("DefaultPolicy: esperava o modo %q, obteve %q", ModeEdits, policy.Mode)
	}
	if !policy.AgentTools {
		t.Fatalf("DefaultPolicy: esperava AgentTools=true, obteve false")
	}
	return NewGate(policy)
}

// assertDecision confere o veredito e devolve o motivo — que nunca pode ser
// vazio: sem frase, o diálogo de aprovação vira um botão apertado no automático.
func assertDecision(t *testing.T, gate *Gate, specialistID, tool string, risk protocol.Risk, digest string, want Decision) string {
	t.Helper()
	decision, reason := gate.Evaluate(specialistID, tool, risk, digest)
	if decision != want {
		t.Fatalf("Evaluate(%q, %q, risco %q, digest %q): esperava %s, obteve %s (motivo %q)",
			specialistID, tool, risk, digest, want, decision, reason)
	}
	if strings.TrimSpace(reason) == "" {
		t.Fatalf("Evaluate(%q, %q): esperava um motivo legível para a tela, obteve vazio", specialistID, tool)
	}
	return reason
}

/* ----------------------------- HostBlocked ------------------------------ */

func TestHostBlockedRespectsLabelBoundary(t *testing.T) {
	cases := []struct {
		name     string
		rules    []string
		host     string
		wantRule string
		wantHit  bool
	}{
		{"apex exato", []string{"exemplo.com"}, "exemplo.com", "exemplo.com", true},
		{"subdomínio", []string{"exemplo.com"}, "a.exemplo.com", "exemplo.com", true},
		{"subdomínio profundo", []string{"exemplo.com"}, "b.a.exemplo.com", "exemplo.com", true},
		{"domínio parecido não casa", []string{"exemplo.com"}, "malexemplo.com", "", false},
		{"curinga pega o subdomínio", []string{"*.exemplo.com"}, "a.exemplo.com", "*.exemplo.com", true},
		{"curinga não pega o apex", []string{"*.exemplo.com"}, "exemplo.com", "", false},
		{"curinga sozinho não bloqueia nada", []string{"*."}, "exemplo.com", "", false},
		{"host com porta", []string{"exemplo.com"}, "exemplo.com:8443", "exemplo.com", true},
		{"host com ponto final", []string{"exemplo.com"}, "exemplo.com.", "exemplo.com", true},
		{"host com ponto final e porta", []string{"exemplo.com"}, "exemplo.com.:8080", "exemplo.com", true},
		{"regra em maiúsculas volta minúscula", []string{"EXEMPLO.COM"}, "a.exemplo.com", "exemplo.com", true},
		{"regra com espaço em volta", []string{"  exemplo.com  "}, "exemplo.com", "exemplo.com", true},
		{"ipv6 entre colchetes", []string{"[::1]"}, "[::1]", "[::1]", true},
		{"lista vazia", nil, "exemplo.com", "", false},
		{"host vazio", []string{"exemplo.com"}, "", "", false},
		{"primeira regra que casa é a devolvida", []string{"outra.com", "exemplo.com"}, "a.exemplo.com", "exemplo.com", true},
	}

	for _, each := range cases {
		t.Run(each.name, func(t *testing.T) {
			rule, hit := HostBlocked(each.rules, each.host)
			if hit != each.wantHit {
				t.Fatalf("HostBlocked(%v, %q): esperava bloqueio=%v, obteve %v (regra %q)",
					each.rules, each.host, each.wantHit, hit, rule)
			}
			if rule != each.wantRule {
				t.Errorf("HostBlocked(%v, %q): esperava a regra %q, obteve %q",
					each.rules, each.host, each.wantRule, rule)
			}
		})
	}
}

/* --------------------------------- RiskOf -------------------------------- */

func TestRiskOfClassifiesEveryFamily(t *testing.T) {
	cases := []struct {
		tool string
		want protocol.Risk
	}{
		{"fs.read", protocol.RiskRead},
		{"fs.list", protocol.RiskRead},
		{"git.diff", protocol.RiskRead},
		{"web.fetch", protocol.RiskRead},
		{"fs.write", protocol.RiskWrite},
		{"fs.patch", protocol.RiskWrite},
		{"git.commit", protocol.RiskWrite},
		{"image.generate", protocol.RiskWrite},
		{"proc.run", protocol.RiskExecute},
		{"term.open", protocol.RiskExecute},
		{"task.dispatch", protocol.RiskExecute},
		{"webhook.post", protocol.RiskNetwork},
		{"mcp.call", protocol.RiskNetwork},
		{"schedule.create", protocol.RiskNetwork},
		{"secrets.scan", protocol.RiskSecret},
		{"FS.READ", protocol.RiskRead},
		{"  fs.read  ", protocol.RiskRead},
	}

	for _, each := range cases {
		if got := RiskOf(each.tool); got != each.want {
			t.Errorf("RiskOf(%q): esperava %q, obteve %q", each.tool, each.want, got)
		}
	}
}

// Ferramenta nova (ou vinda de um servidor MCP externo) não pode nascer
// liberada só porque ninguém lembrou de classificá-la.
func TestRiskOfDefaultsToExecute(t *testing.T) {
	for _, tool := range []string{"", "ferramenta.que.ninguem.classificou", "mcp.externo/qualquer"} {
		if got := RiskOf(tool); got != protocol.RiskExecute {
			t.Errorf("RiskOf(%q): esperava o mais restritivo (%q), obteve %q", tool, protocol.RiskExecute, got)
		}
	}
}

/* -------------------------------- Evaluate ------------------------------- */

func TestEvaluateDeniesToolsOnTheDenyList(t *testing.T) {
	policy := DefaultPolicy()
	policy.DeniedTools = []string{"proc.run"}
	gate := NewGate(policy)

	reason := assertDecision(t, gate, "code", "proc.run", protocol.RiskExecute, "", DecisionDeny)
	if !strings.Contains(reason, "proc.run") {
		t.Errorf("motivo da recusa: esperava citar a ferramenta, obteve %q", reason)
	}

	// A recusa dura do admin vem antes de tudo, inclusive de "aprovar tudo".
	policy.Mode = ModeAll
	gate.SetPolicy(policy)
	assertDecision(t, gate, "code", "proc.run", protocol.RiskExecute, "", DecisionDeny)

	// E não é sensível a caixa: a lista é escrita por gente.
	policy.DeniedTools = []string{"PROC.RUN"}
	gate.SetPolicy(policy)
	assertDecision(t, gate, "code", "proc.run", protocol.RiskExecute, "", DecisionDeny)
}

func TestEvaluateDeniesEverythingWhenAgentToolsIsOff(t *testing.T) {
	policy := DefaultPolicy()
	policy.AgentTools = false
	gate := NewGate(policy)

	// Nem leitura passa: o interruptor geral é "só texto".
	assertDecision(t, gate, "code", "fs.read", protocol.RiskRead, "", DecisionDeny)
	assertDecision(t, gate, "code", "fs.write", protocol.RiskWrite, "", DecisionDeny)
}

func TestEvaluateDeniesToolOutsideSpecialistCatalog(t *testing.T) {
	gate := editsGate(t)

	// "chat" lê arquivo, mas não roda processo — um especialista de conversa
	// que executa é um especialista de execução com outro nome.
	reason := assertDecision(t, gate, "chat", "proc.run", protocol.RiskExecute, "", DecisionDeny)
	if !strings.Contains(reason, "proc.run") {
		t.Errorf("motivo da recusa: esperava citar a ferramenta, obteve %q", reason)
	}
	assertDecision(t, gate, "office", "fs.write", protocol.RiskWrite, "", DecisionDeny)

	// O mesmo pedido com o especialista certo não é recusado.
	assertDecision(t, gate, "code", "proc.run", protocol.RiskExecute, "", DecisionAsk)
}

func TestEvaluateDeniesSpecialistOutsideThePolicy(t *testing.T) {
	policy := DefaultPolicy()
	policy.AllowedSpecialists = []string{"chat"}
	gate := NewGate(policy)

	reason := assertDecision(t, gate, "code", "fs.write", protocol.RiskWrite, "", DecisionDeny)
	if !strings.Contains(reason, "code") {
		t.Errorf("motivo da recusa: esperava citar o especialista, obteve %q", reason)
	}
	if gate.AllowsSpecialist("code") {
		t.Errorf("AllowsSpecialist(%q): esperava false com a lista %v, obteve true", "code", policy.AllowedSpecialists)
	}
	if !gate.AllowsSpecialist("chat") {
		t.Errorf("AllowsSpecialist(%q): esperava true, obteve false", "chat")
	}

	// Lista vazia é "todos": política não configurada não pode bloquear todo
	// mundo no dia seguinte à migração.
	if !NewGate(DefaultPolicy()).AllowsSpecialist("code") {
		t.Errorf("AllowsSpecialist com lista vazia: esperava true, obteve false")
	}
}

func TestEvaluateInEditsModeAllowsReadsAndAsksOnChanges(t *testing.T) {
	gate := editsGate(t)

	cases := []struct {
		specialist string
		tool       string
		risk       protocol.Risk
		want       Decision
	}{
		{"code", "fs.read", protocol.RiskRead, DecisionAllow},
		{"code", "git.diff", protocol.RiskRead, DecisionAllow},
		{"work", "webhook.post", protocol.RiskNetwork, DecisionAllow},
		{"code", "fs.write", protocol.RiskWrite, DecisionAsk},
		{"code", "fs.patch", protocol.RiskWrite, DecisionAsk},
		{"code", "proc.run", protocol.RiskExecute, DecisionAsk},
		{"security", "secrets.scan", protocol.RiskSecret, DecisionAsk},
	}

	for _, each := range cases {
		assertDecision(t, gate, each.specialist, each.tool, each.risk, "", each.want)
	}
}

func TestEvaluateAsksInUnknownAndAskModes(t *testing.T) {
	policy := DefaultPolicy()
	policy.Mode = ModeAsk
	gate := NewGate(policy)

	// Em "perguntar sempre" nem leitura passa: ler arquivo do projeto é o
	// caminho mais barato de exfiltração que existe.
	assertDecision(t, gate, "code", "fs.read", protocol.RiskRead, "", DecisionAsk)

	policy.Mode = Mode("modo-que-ninguem-conhece")
	gate.SetPolicy(policy)
	reason := assertDecision(t, gate, "code", "fs.read", protocol.RiskRead, "", DecisionAsk)
	if !strings.Contains(reason, "desconhecida") {
		t.Errorf("motivo do modo desconhecido: esperava dizer que a política é desconhecida, obteve %q", reason)
	}

	policy.Mode = ModeAll
	gate.SetPolicy(policy)
	assertDecision(t, gate, "code", "proc.run", protocol.RiskExecute, "", DecisionAllow)
}

// O zero do tipo — um Decision declarado e esquecido — não pode ser "liberar".
func TestDecisionZeroValueIsNotAllow(t *testing.T) {
	var forgotten Decision
	if forgotten == DecisionAllow {
		t.Fatalf("o zero de Decision virou DecisionAllow — o desfecho seguro é não liberar")
	}
	if got := forgotten.String(); got != "desconhecida" {
		t.Errorf("Decision(0).String(): esperava %q, obteve %q", "desconhecida", got)
	}
	if got := DecisionAllow.String(); got != "allow" {
		t.Errorf("DecisionAllow.String(): esperava %q, obteve %q", "allow", got)
	}
}

/* --------------------------------- Grant --------------------------------- */

func TestGrantDigestUnlocksOnlyTheSameArguments(t *testing.T) {
	gate := editsGate(t)
	const tool = "fs.write"
	const digest = "aprovado0001"
	const other = "outrodigest2"

	assertDecision(t, gate, "code", tool, protocol.RiskWrite, digest, DecisionAsk)

	gate.Grant("digest", "code", tool, digest)

	reason := assertDecision(t, gate, "code", tool, protocol.RiskWrite, digest, DecisionAllow)
	if !strings.Contains(reason, "mesmos argumentos") {
		t.Errorf("motivo da liberação: esperava citar os mesmos argumentos, obteve %q", reason)
	}

	// A armadilha: o "sim" de um arquivo não pode virar cheque em branco.
	assertDecision(t, gate, "code", tool, protocol.RiskWrite, other, DecisionAsk)
	assertDecision(t, gate, "code", tool, protocol.RiskWrite, "", DecisionAsk)
	// Nem para outra ferramenta com o mesmo digest.
	assertDecision(t, gate, "code", "fs.patch", protocol.RiskWrite, digest, DecisionAsk)
}

func TestGrantIgnoresScopesThatWouldWidenTheYes(t *testing.T) {
	gate := editsGate(t)
	const digest = "aprovado0001"

	// "once" não guarda nada: a chamada em curso já foi liberada por quem
	// clicou, e guardar transformaria uma resposta pontual em regra.
	gate.Grant("once", "code", "fs.write", digest)
	assertDecision(t, gate, "code", "fs.write", protocol.RiskWrite, digest, DecisionAsk)

	// digest vazio com escopo "digest" seria o cheque em branco por nome.
	gate.Grant("digest", "code", "fs.write", "   ")
	assertDecision(t, gate, "code", "fs.write", protocol.RiskWrite, digest, DecisionAsk)

	// Escopo desconhecido não guarda nada.
	gate.Grant("para-sempre", "code", "fs.write", digest)
	assertDecision(t, gate, "code", "fs.write", protocol.RiskWrite, digest, DecisionAsk)

	// Ferramenta vazia não guarda nada.
	gate.Grant("session", "code", "   ", digest)
	if granted := gate.Granted(); len(granted) != 0 {
		t.Errorf("Granted: esperava nenhuma concessão guardada, obteve %v", granted)
	}
}

func TestGrantSessionScopeIsWiderAndRevokeClearsEverything(t *testing.T) {
	gate := editsGate(t)
	const tool = "fs.write"

	gate.Grant("session", "code", tool, "")
	reason := assertDecision(t, gate, "code", tool, protocol.RiskWrite, "qualquer-digest", DecisionAllow)
	if !strings.Contains(reason, "nesta sessão") {
		t.Errorf("motivo da liberação por sessão: esperava dizer que vale para o especialista nesta sessão, obteve %q", reason)
	}

	gate.Grant("digest", "code", "fs.patch", "aprovado0001")
	if granted := gate.Granted(); len(granted) != 2 {
		t.Fatalf("Granted: esperava 2 concessões descritas, obteve %v", granted)
	}

	gate.Revoke()
	assertDecision(t, gate, "code", tool, protocol.RiskWrite, "qualquer-digest", DecisionAsk)
	assertDecision(t, gate, "code", "fs.patch", protocol.RiskWrite, "aprovado0001", DecisionAsk)
	if granted := gate.Granted(); len(granted) != 0 {
		t.Errorf("Granted depois de Revoke: esperava lista vazia, obteve %v", granted)
	}
}

/* -------------------------------- Policy --------------------------------- */

// Cópia rasa deixaria quem chamou Policy() reescrever a lista de recusa por
// fora, sem passar pelo SetPolicy e sem o mutex.
func TestPolicyReturnsACopyOfTheLists(t *testing.T) {
	policy := DefaultPolicy()
	policy.DeniedTools = []string{"proc.run"}
	gate := NewGate(policy)

	copied := gate.Policy()
	copied.DeniedTools[0] = "fs.read"

	assertDecision(t, gate, "code", "proc.run", protocol.RiskExecute, "", DecisionDeny)
	assertDecision(t, gate, "code", "fs.read", protocol.RiskRead, "", DecisionAllow)
}

// AllowedModels é o único campo em que lista VAZIA e lista AUSENTE querem dizer
// coisas opostas: vazia é "nenhum modelo", nil é "todos". A cópia da política é
// a travessia mais banal que existe, e colapsar vazia em nil ali liberaria o
// catálogo inteiro justamente na estação gerenciada, cuja lista permitida é
// calculada e pode ser legitimamente vazia.
func TestPolicyPreservaListaVaziaDeModelos(t *testing.T) {
	policy := DefaultPolicy()
	policy.AllowedModels = []string{}
	gate := NewGate(policy)

	got := gate.Policy()
	if got.AllowedModels == nil {
		t.Fatalf("lista vazia virou nil na cópia — isso é o catálogo inteiro liberado")
	}
	if len(got.AllowedModels) != 0 {
		t.Fatalf("AllowedModels: esperava lista vazia, obteve %v", got.AllowedModels)
	}

	// E o outro lado: ausente continua ausente, sem alocar por nada.
	if aberta := NewGate(DefaultPolicy()).Policy(); aberta.AllowedModels != nil {
		t.Fatalf("política sem modelos declarados: esperava nil, obteve %v", aberta.AllowedModels)
	}
}

// A cópia também precisa isolar a fatia: quem chamou Policy() não pode reescrever
// a lista de modelos por fora do SetPolicy.
func TestPolicyIsolaAFatiaDeModelos(t *testing.T) {
	policy := DefaultPolicy()
	policy.AllowedModels = []string{"gpt-5"}
	gate := NewGate(policy)

	copied := gate.Policy()
	copied.AllowedModels[0] = "qualquer-um"

	if got := gate.Policy(); got.AllowedModels[0] != "gpt-5" {
		t.Fatalf("a lista de modelos foi reescrita por fora: %v", got.AllowedModels)
	}
}

// A liberação "para a sessão" fica presa a QUEM a recebeu.
//
// O mapa era `map[tool]`: aprovar `fs.write` olhando o especialista de código
// liberava a mesma ferramenta para o de design, que também a tem no catálogo. O
// "sim" foi dado olhando um bot; é a ele que ele pertence.
func TestSessionGrantNaoVazaParaOutroEspecialista(t *testing.T) {
	gate := editsGate(t)
	const tool = "fs.write"

	gate.Grant("session", "code", tool, "")

	// Quem recebeu passa.
	assertDecision(t, gate, "code", tool, protocol.RiskWrite, "qualquer", DecisionAllow)
	// Quem NÃO recebeu continua perguntando, mesmo tendo a ferramenta no catálogo.
	assertDecision(t, gate, "design", tool, protocol.RiskWrite, "qualquer", DecisionAsk)
}
