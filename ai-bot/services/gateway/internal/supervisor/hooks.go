// Ganchos de ciclo de vida do turno — a parte EXECUTÁVEL do Corporate
// Capability Pack (internal/pack).
//
// As ações são DECLARATIVAS, e isso é a decisão central do arquivo: um pacote
// nunca executa código próprio, pela mesma razão que plugin declarativo era a
// regra no produto anterior — código de terceiro dentro do processo que guarda
// credencial e conversa não passa por análise nenhuma. O que um gancho PODE
// fazer é uma lista fechada de três verbos:
//
//	"audit"   → grava uma linha em <dataDir>/audit.log (quem, o quê, quando,
//	            deu certo ou não) — a trilha que a SI pede;
//	"webhook" → dispara o webhook.post JÁ EXISTENTE, com o evento como corpo
//	            (o secretRef aponta a URL no cofre; o gancho nunca a vê);
//	"deny"    → em before_tool/before_edit, RECUSA a ferramenta — é a política
//	            de pacote em tempo de execução.
//
// Falha de gancho NUNCA derruba o turno (exceto o deny, que existe para isso):
// auditoria que mata a resposta do usuário vira auditoria desligada na primeira
// semana. Erro de ação é registrado no log do processo e o turno segue.
package supervisor

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// HookEvent é o momento do turno em que o gancho dispara. Lista fechada — os
// mesmos nomes validados em internal/pack (os dois mudam juntos).
type HookEvent string

const (
	HookBeforeTool HookEvent = "before_tool"
	HookAfterTool  HookEvent = "after_tool"
	HookBeforeEdit HookEvent = "before_edit"
	HookAfterEdit  HookEvent = "after_edit"
	HookOnError    HookEvent = "on_error"
	HookOnComplete HookEvent = "on_complete"
)

// Hook é um gancho declarado por um pacote.
type Hook struct {
	On HookEvent
	// Tool restringe o gancho a UMA ferramenta; vazio casa com qualquer uma.
	Tool string
	// Action é "audit", "webhook" ou "deny".
	Action string
	// SecretRef é o nome do webhook no cofre (só a ação webhook usa).
	SecretRef string
}

// HookInfo é o que um gancho enxerga de um acontecimento — e também o corpo do
// webhook e a linha da auditoria, então só carrega o que pode ir para fora:
// identificadores e digest, nunca argumentos nem conteúdo de conversa.
type HookInfo struct {
	Event      HookEvent `json:"event"`
	TS         time.Time `json:"ts"`
	Session    string    `json:"session"`
	Turn       string    `json:"turn,omitempty"`
	Specialist string    `json:"specialist,omitempty"`
	Tool       string    `json:"tool,omitempty"`
	// Digest identifica os argumentos sem expô-los (o mesmo do portão de
	// aprovação): a auditoria diz "este comando com estes argumentos" sem
	// copiar um caminho de arquivo ou um trecho de código para o audit.log.
	Digest string `json:"digest,omitempty"`
	OK     bool   `json:"ok"`
	Error  string `json:"error,omitempty"`
}

// auditMaxBytes é o teto do audit.log antes da rotação. 10 MB seguram meses de
// uso normal e cabem num anexo de chamado — que é para onde este arquivo vai
// quando a SI pede a trilha.
const auditMaxBytes = 10 << 20

// webhookTimeout limita a ação webhook. O gancho roda DENTRO do turno (para a
// ordem dos eventos ser a ordem real), então um webhook pendurado não pode
// segurar a resposta por minutos — dez segundos e o turno segue sem ele.
const webhookTimeout = 10 * time.Second

// editTools são as ferramentas que CONTAM como edição: um gancho registrado em
// before_edit/after_edit dispara para elas, além do before_tool/after_tool
// normal. A lista é fechada porque "o que é edição" é uma decisão de auditoria,
// não uma heurística.
var editTools = map[string]bool{
	"fs.write":    true,
	"fs.patch":    true,
	"office.edit": true,
}

// HookRunner guarda os ganchos registrados (por pacote) e executa as ações.
type HookRunner struct {
	log *slog.Logger
	// webhook dispara pelo webhook.post existente: recebe a REFERÊNCIA do
	// segredo e o corpo, nunca a URL. Nil = ação webhook vira erro registrado.
	webhook func(ctx context.Context, secretRef string, body json.RawMessage) error

	auditPath string
	// auditMax é campo (e não a constante direto) para o teste de rotação não
	// precisar escrever 10 MB de verdade.
	auditMax int64

	mu    sync.Mutex
	hooks map[string][]Hook
}

// NewHookRunner monta o executor. `dataDir` diz onde mora o audit.log;
// `webhook` pode ser nil (aí a ação webhook registra o motivo e segue).
func NewHookRunner(
	dataDir string,
	webhook func(ctx context.Context, secretRef string, body json.RawMessage) error,
	log *slog.Logger,
) *HookRunner {
	if log == nil {
		log = slog.Default()
	}
	return &HookRunner{
		log:       log,
		webhook:   webhook,
		auditPath: filepath.Join(dataDir, "audit.log"),
		auditMax:  auditMaxBytes,
		hooks:     make(map[string][]Hook),
	}
}

// Register grava os ganchos de um pacote, substituindo os anteriores do mesmo
// pacote — reinstalar um pacote não pode duplicar a auditoria dele.
func (r *HookRunner) Register(pack string, hooks []Hook) {
	pack = strings.TrimSpace(pack)
	if pack == "" {
		return
	}
	copied := make([]Hook, len(hooks))
	copy(copied, hooks)
	r.mu.Lock()
	defer r.mu.Unlock()
	r.hooks[pack] = copied
}

// Unregister esquece os ganchos de um pacote.
func (r *HookRunner) Unregister(pack string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.hooks, pack)
}

// Before roda os ganchos de ANTES (before_tool e, para ferramenta de edição,
// before_edit). É o único ponto em que gancho muda o rumo do turno: um "deny"
// recusa a ferramenta e devolve o motivo — com o nome do pacote, porque é a
// frase que a pessoa lê e a TI procura.
//
// As ações que só observam (audit, webhook) rodam ANTES de qualquer deny
// decidir: a trilha precisa registrar inclusive a tentativa que foi recusada.
func (r *HookRunner) Before(ctx context.Context, info HookInfo) (denied bool, reason string) {
	matches := r.matching(info)
	if len(matches) == 0 {
		return false, ""
	}
	for _, match := range matches {
		if match.hook.Action != "deny" {
			r.act(ctx, match, info)
		}
	}
	for _, match := range matches {
		if match.hook.Action == "deny" {
			return true, fmt.Sprintf("o pacote %s recusa %s neste gateway", match.pack, info.Tool)
		}
	}
	return false, ""
}

// Notify roda os ganchos que só OBSERVAM (after_tool/after_edit, on_error,
// on_complete). Nunca devolve erro: falha de gancho é registrada e o turno
// segue — é o contrato do arquivo.
func (r *HookRunner) Notify(ctx context.Context, info HookInfo) {
	for _, match := range r.matching(info) {
		if match.hook.Action == "deny" {
			// Deny fora de before_* não recusa nada (a validação do pacote já
			// barra isso); ignorar aqui é a defesa contra um registro manual.
			continue
		}
		r.act(ctx, match, info)
	}
}

// matched é um gancho que casou, com o pacote de origem — o audit e a frase do
// deny precisam dizer DE QUEM é a regra.
type matched struct {
	pack string
	hook Hook
}

// matching devolve os ganchos que casam com o acontecimento, em ordem estável
// de pacote — mapa itera aleatório, e auditoria com ordem aleatória entre duas
// execuções iguais parece adulterada.
func (r *HookRunner) matching(info HookInfo) []matched {
	events := eventsFor(info)

	r.mu.Lock()
	packs := make([]string, 0, len(r.hooks))
	for pack := range r.hooks {
		packs = append(packs, pack)
	}
	sort.Strings(packs)
	var out []matched
	for _, pack := range packs {
		for _, hook := range r.hooks[pack] {
			if !events[hook.On] {
				continue
			}
			if hook.Tool != "" && !strings.EqualFold(hook.Tool, info.Tool) {
				continue
			}
			out = append(out, matched{pack: pack, hook: hook})
		}
	}
	r.mu.Unlock()
	return out
}

// eventsFor expande o acontecimento nos eventos que ele significa: fs.write,
// fs.patch e office.edit CONTAM como edição, então before_tool delas também
// acorda os ganchos de before_edit (e o mesmo no after).
func eventsFor(info HookInfo) map[HookEvent]bool {
	events := map[HookEvent]bool{info.Event: true}
	if editTools[strings.ToLower(strings.TrimSpace(info.Tool))] {
		switch info.Event {
		case HookBeforeTool:
			events[HookBeforeEdit] = true
		case HookAfterTool:
			events[HookAfterEdit] = true
		}
	}
	return events
}

// act executa UMA ação observadora. Erro nunca sobe: vai para o log do
// processo com o pacote e a ação, que é o que a TI precisa para consertar.
func (r *HookRunner) act(ctx context.Context, match matched, info HookInfo) {
	var err error
	switch match.hook.Action {
	case "audit":
		err = r.audit(info)
	case "webhook":
		err = r.fireWebhook(ctx, match.hook.SecretRef, info)
	default:
		err = fmt.Errorf("ação %q desconhecida", match.hook.Action)
	}
	if err != nil {
		r.log.Warn("gancho de pacote falhou — o turno segue",
			"pacote", match.pack, "acao", match.hook.Action, "evento", string(info.Event), "erro", err)
	}
}

/* -------------------------------- auditoria -------------------------------- */

// audit grava UMA linha JSON no audit.log.
//
// A linha é montada inteira e escrita numa única chamada, com o arquivo em
// O_APPEND e o mutex segurado: é o que garante que duas ferramentas em paralelo
// não entrelaçam bytes no meio de uma linha — auditoria com linha corrompida é
// auditoria que não prova nada. A rotação acontece ANTES da escrita, quando o
// arquivo já passou do teto: o audit.log vira audit.log.1 (substituindo o
// anterior) e a linha nova abre o arquivo seguinte.
func (r *HookRunner) audit(info HookInfo) error {
	line, err := json.Marshal(info)
	if err != nil {
		return fmt.Errorf("serializar o evento: %w", err)
	}
	line = append(line, '\n')

	r.mu.Lock()
	defer r.mu.Unlock()

	if stat, err := os.Stat(r.auditPath); err == nil && stat.Size() >= r.auditMax {
		// Uma geração só de histórico, de propósito: auditoria não é backup —
		// quem precisa de retenção longa aponta um gancho webhook para o SIEM.
		if err := os.Rename(r.auditPath, r.auditPath+".1"); err != nil {
			return fmt.Errorf("rotacionar o audit.log: %w", err)
		}
	}

	file, err := os.OpenFile(r.auditPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return fmt.Errorf("abrir o audit.log: %w", err)
	}
	if _, err := file.Write(line); err != nil {
		_ = file.Close()
		return fmt.Errorf("gravar no audit.log: %w", err)
	}
	// Sync porque auditoria que some numa queda de energia é pior que nenhuma:
	// ela teria sido citada num chamado como existente.
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return fmt.Errorf("sincronizar o audit.log: %w", err)
	}
	return file.Close()
}

/* --------------------------------- webhook --------------------------------- */

// fireWebhook dispara o evento pelo webhook.post existente. O corpo é o
// próprio HookInfo — identificadores e digest, nunca conteúdo.
//
// O contexto é DESTACADO do turno (WithoutCancel) de propósito: o on_error de
// um turno cancelado dispara com o contexto já morto, e é justamente esse
// evento que a SI mais quer receber. O prazo próprio (webhookTimeout) impede o
// destacamento de virar espera infinita.
func (r *HookRunner) fireWebhook(ctx context.Context, secretRef string, info HookInfo) error {
	if r.webhook == nil {
		return fmt.Errorf("nenhum despachante de webhook configurado para %q", secretRef)
	}
	if strings.TrimSpace(secretRef) == "" {
		return fmt.Errorf("gancho webhook sem secretRef")
	}
	body, err := json.Marshal(info)
	if err != nil {
		return fmt.Errorf("serializar o evento: %w", err)
	}
	detached, cancel := context.WithTimeout(context.WithoutCancel(ctx), webhookTimeout)
	defer cancel()
	return r.webhook(detached, secretRef, body)
}
