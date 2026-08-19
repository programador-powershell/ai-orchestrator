// A Cápsula de Estado do Context Runtime: JANELA DO MODELO != MEMÓRIA DO AGENTE.
//
// O histórico integral vive no log da sessão (o Event Store deste produto) e
// nunca é requisito para continuar a conversa. O que o modelo recebe é o
// working set: instruções + ESTA cápsula + a cauda recente verbatim. Antes
// dela, tudo além da janela recente simplesmente SUMIA do contexto — a conversa
// de 200 turnos chegava ao modelo como as últimas 40 mensagens e nada mais.
//
// A dobra é DETERMINÍSTICA e incremental de propósito: uma passada sobre os
// envelopes novos desde o cursor, sem chamada de modelo. Compactar com um LLM
// produziria cápsulas melhores em prosa e piores em três coisas que importam
// mais aqui: custo (um sub-turno por compactação), disponibilidade (o gateway
// precisa funcionar sem nenhum provedor configurado) e validade (resumo de
// modelo pode inventar; uma dobra só reorganiza o que aconteceu). O polimento
// por modelo pode entrar depois COMO REFINO, nunca como única fonte.
package contextrt

import (
	"encoding/json"
	"fmt"
	"strings"

	"aibot/gateway/internal/protocol"
)

// Os tetos de cada lista. A cápsula é working set, não arquivo: o que passar
// do teto cai — o integral continua no log, recuperável.
const (
	maxDecisions = 12
	maxFiles     = 24
	maxErrors    = 8
	maxPending   = 6
	maxArtifacts = 10
	// maxFieldChars limita cada texto individual da cápsula.
	maxFieldChars = 240
)

// Decision é uma escolha que moldou a sessão — rota, delegação, entrega.
type Decision struct {
	Decision string `json:"decision"`
	Reason   string `json:"reason,omitempty"`
}

// FileNote registra um arquivo tocado e como.
type FileNote struct {
	Path   string `json:"path"`
	Status string `json:"status"` // read | modified
}

// ErrorNote registra um erro e o estado dele.
type ErrorNote struct {
	Symptom string `json:"symptom"`
	Status  string `json:"status"` // open | resolved
	// tool guarda quem falhou, para o sucesso posterior da mesma ferramenta
	// marcar o erro como resolvido.
	Tool string `json:"tool,omitempty"`
}

// ArtifactNote aponta uma saída integral guardada fora da janela.
type ArtifactNote struct {
	Ref         string `json:"ref"`
	Description string `json:"description"`
}

// Telemetry separa as três contagens que a especificação manda nunca
// confundir: o que está ATIVO na janela é medido por chamada (context_budget);
// aqui ficam o CUMULATIVO da sessão e o tamanho da memória externa.
type Telemetry struct {
	// CumulativeChars é o total de conteúdo dobrado ao longo da sessão —
	// caracteres, não tokens, porque a estimativa de token é regra de bolso e a
	// contagem crua não mente.
	CumulativeChars int64 `json:"cumulativeChars"`
	// Events é quantos envelopes a dobra já processou.
	Events int64 `json:"events"`
	// Folds é quantas dobras já rodaram (a "compaction count" da spec).
	Folds int64 `json:"folds"`
}

// Capsule é o estado operacional mínimo para continuar a sessão — o que um
// agente sucessor precisaria para retomar exatamente daqui.
type Capsule struct {
	Version     int            `json:"version"`
	Goal        string         `json:"goal"`
	Decisions   []Decision     `json:"decisions,omitempty"`
	Files       []FileNote     `json:"files,omitempty"`
	Errors      []ErrorNote    `json:"errors,omitempty"`
	Artifacts   []ArtifactNote `json:"artifacts,omitempty"`
	Pending     []string       `json:"pending,omitempty"`
	CurrentWork string         `json:"currentWork,omitempty"`
	// Cursor é o Seq do último envelope dobrado: a próxima dobra começa dele.
	Cursor    uint64    `json:"cursor"`
	Telemetry Telemetry `json:"telemetry"`

	// pares casa tool.call com tool.result DENTRO de uma dobra e entre dobras
	// (workers paralelos intercalam no log). Serializado porque um call pode
	// fechar só na dobra seguinte.
	OpenCalls map[string]string `json:"openCalls,omitempty"`
}

// New abre uma cápsula vazia na versão atual.
func New() *Capsule {
	return &Capsule{Version: 1, OpenCalls: map[string]string{}}
}

// Load desserializa; vazio ou ilegível devolve uma nova — cápsula corrompida
// não pode derrubar o turno, ela se refaz sozinha nas dobras seguintes.
func Load(data []byte) *Capsule {
	if len(data) == 0 {
		return New()
	}
	capsule := New()
	if err := json.Unmarshal(data, capsule); err != nil {
		return New()
	}
	if capsule.OpenCalls == nil {
		capsule.OpenCalls = map[string]string{}
	}
	return capsule
}

// Marshal serializa para o blob da sessão.
func (c *Capsule) Marshal() ([]byte, error) { return json.Marshal(c) }

/* ---------------------------------- dobra --------------------------------- */

// Fold incorpora envelopes novos ao estado. Uma passada, sem modelo, sem
// relógio; chamada ao fim de cada turno (a compactação POR FASE da spec — o
// done do turno é o fim de fase natural de uma conversa).
func (c *Capsule) Fold(envelopes []protocol.Envelope) {
	if len(envelopes) == 0 {
		return
	}
	c.Telemetry.Folds++
	for _, envelope := range envelopes {
		if envelope.Seq != 0 && envelope.Seq <= c.Cursor {
			continue // já dobrado — a dobra é idempotente por cursor
		}
		c.Telemetry.Events++
		c.Telemetry.CumulativeChars += int64(len(envelope.Payload))
		c.foldOne(envelope)
		if envelope.Seq > c.Cursor {
			c.Cursor = envelope.Seq
		}
	}
	c.trim()
}

func (c *Capsule) foldOne(envelope protocol.Envelope) {
	switch envelope.Kind {
	case protocol.KindMessage:
		var message protocol.Message
		if envelope.Decode(&message) != nil || strings.TrimSpace(message.Text) == "" {
			return
		}
		if message.Role == "user" {
			text := clip(message.Text)
			if c.Goal == "" {
				c.Goal = text
			}
			c.CurrentWork = text
			// Mensagem nova responde/substitui o que estava pendente.
			c.Pending = nil
		}

	case protocol.KindRoute:
		var route protocol.Route
		if envelope.Decode(&route) != nil || route.Specialist == "" {
			return
		}
		last := ""
		if n := len(c.Decisions); n > 0 {
			last = c.Decisions[n-1].Decision
		}
		decision := "a conversa está com o especialista " + route.Specialist
		if decision != last {
			c.Decisions = append(c.Decisions, Decision{Decision: decision, Reason: string(route.Reason)})
		}

	case protocol.KindDelegate:
		var delegation protocol.Delegate
		if envelope.Decode(&delegation) != nil || delegation.To == "" {
			return
		}
		if !delegation.Done {
			c.Decisions = append(c.Decisions, Decision{
				Decision: "delegou a " + delegation.To + ": " + clip(delegation.Goal),
			})
			return
		}
		if strings.TrimSpace(delegation.Result) != "" {
			c.Decisions = append(c.Decisions, Decision{
				Decision: delegation.To + " entregou: " + clip(delegation.Result),
			})
		}

	case protocol.KindToolCall:
		var call protocol.ToolCall
		if envelope.Decode(&call) != nil || call.Tool == "" {
			return
		}
		c.OpenCalls[call.CallID] = call.Tool
		if path := pathOf(call.Args); path != "" {
			status := "read"
			switch call.Tool {
			case "fs.write", "fs.patch":
				status = "modified"
			case "fs.read", "fs.search", "fs.list":
				status = "read"
			default:
				return
			}
			c.noteFile(path, status)
		}

	case protocol.KindToolResult:
		var result protocol.ToolResult
		if envelope.Decode(&result) != nil || result.Tool == "" {
			return
		}
		delete(c.OpenCalls, result.CallID)
		if !result.OK {
			c.noteError(result.Tool, result.Error)
			return
		}
		// Sucesso da MESMA ferramenta resolve o erro aberto dela: é o padrão
		// "deu erro, corrigiu, rodou de novo" virando estado em vez de história.
		for index := range c.Errors {
			if c.Errors[index].Tool == result.Tool && c.Errors[index].Status == "open" {
				c.Errors[index].Status = "resolved"
			}
		}
		if result.ArtifactRef != "" {
			c.noteArtifact(result.ArtifactRef, "saída integral de "+result.Tool)
		}

	case protocol.KindError:
		var failure protocol.Error
		if envelope.Decode(&failure) != nil || failure.Message == "" {
			return
		}
		c.noteError(failure.Code, failure.Message)

	case protocol.KindAsk:
		var ask protocol.Ask
		if envelope.Decode(&ask) != nil || ask.Question == "" {
			return
		}
		c.Pending = append(c.Pending, clip(ask.Question))

	case protocol.KindReply:
		// A resposta fecha o que estava pendente; a continuação repõe se voltar
		// a perguntar.
		c.Pending = nil
	}
}

func (c *Capsule) noteFile(path, status string) {
	for index := range c.Files {
		if c.Files[index].Path == path {
			// modified vence read: uma leitura posterior não desfaz a edição.
			if status == "modified" {
				c.Files[index].Status = status
			}
			return
		}
	}
	c.Files = append(c.Files, FileNote{Path: clip(path), Status: status})
}

func (c *Capsule) noteError(tool, message string) {
	symptom := clip(tool + ": " + message)
	for index := range c.Errors {
		if c.Errors[index].Symptom == symptom {
			c.Errors[index].Status = "open"
			return
		}
	}
	c.Errors = append(c.Errors, ErrorNote{Symptom: symptom, Status: "open", Tool: tool})
}

func (c *Capsule) noteArtifact(ref, description string) {
	for _, artifact := range c.Artifacts {
		if artifact.Ref == ref {
			return
		}
	}
	c.Artifacts = append(c.Artifacts, ArtifactNote{Ref: ref, Description: clip(description)})
}

// trim aplica os tetos, sempre descartando o MAIS ANTIGO: o estado recente é o
// que o próximo turno precisa; o antigo continua no log.
func (c *Capsule) trim() {
	if n := len(c.Decisions); n > maxDecisions {
		c.Decisions = append([]Decision(nil), c.Decisions[n-maxDecisions:]...)
	}
	if n := len(c.Files); n > maxFiles {
		c.Files = append([]FileNote(nil), c.Files[n-maxFiles:]...)
	}
	if n := len(c.Errors); n > maxErrors {
		c.Errors = append([]ErrorNote(nil), c.Errors[n-maxErrors:]...)
	}
	if n := len(c.Pending); n > maxPending {
		c.Pending = append([]string(nil), c.Pending[n-maxPending:]...)
	}
	if n := len(c.Artifacts); n > maxArtifacts {
		c.Artifacts = append([]ArtifactNote(nil), c.Artifacts[n-maxArtifacts:]...)
	}
	// Pares que nunca fecharam não podem crescer para sempre.
	if len(c.OpenCalls) > 64 {
		c.OpenCalls = map[string]string{}
	}
}

func clip(text string) string {
	text = strings.Join(strings.Fields(text), " ")
	if len(text) <= maxFieldChars {
		return text
	}
	cut := maxFieldChars
	for cut > 0 && text[cut]&0xC0 == 0x80 {
		cut-- // não corta rune no meio
	}
	return text[:cut] + "…"
}

/* --------------------------------- render --------------------------------- */

// Render produz a mensagem de sistema que entra no prompt. Compacta e
// ESTRUTURADA: o modelo lê estado, não narrativa.
//
// Vazia quando não há nada dobrado — cápsula sem conteúdo não gasta janela.
func (c *Capsule) Render() string {
	if c.Cursor == 0 {
		return ""
	}
	var out strings.Builder
	out.WriteString("ESTADO DA SESSÃO (destilado do histórico antigo; o integral vive no log e nos artefatos — " +
		"use context.fetch para recuperar uma saída completa):\n")
	if c.Goal != "" {
		out.WriteString("Objetivo: " + c.Goal + "\n")
	}
	if c.CurrentWork != "" && c.CurrentWork != c.Goal {
		out.WriteString("Trabalho atual: " + c.CurrentWork + "\n")
	}
	if len(c.Decisions) > 0 {
		out.WriteString("Decisões:\n")
		for _, decision := range c.Decisions {
			out.WriteString("- " + decision.Decision)
			if decision.Reason != "" {
				out.WriteString(" (" + decision.Reason + ")")
			}
			out.WriteString("\n")
		}
	}
	if len(c.Files) > 0 {
		out.WriteString("Arquivos tocados:\n")
		for _, file := range c.Files {
			out.WriteString("- " + file.Path + " (" + file.Status + ")\n")
		}
	}
	abertos := 0
	for _, failure := range c.Errors {
		if failure.Status == "open" {
			abertos++
		}
	}
	if abertos > 0 {
		out.WriteString("Erros AINDA ABERTOS:\n")
		for _, failure := range c.Errors {
			if failure.Status == "open" {
				out.WriteString("- " + failure.Symptom + "\n")
			}
		}
	}
	if len(c.Artifacts) > 0 {
		out.WriteString("Saídas integrais guardadas:\n")
		for _, artifact := range c.Artifacts {
			out.WriteString("- " + artifact.Ref + " — " + artifact.Description + "\n")
		}
	}
	if len(c.Pending) > 0 {
		out.WriteString("Pendente de resposta humana:\n")
		for _, pending := range c.Pending {
			out.WriteString("- " + pending + "\n")
		}
	}
	fmt.Fprintf(&out, "(memória externa: %d eventos, %d KB dobrados em %d dobras)\n",
		c.Telemetry.Events, c.Telemetry.CumulativeChars/1024, c.Telemetry.Folds)
	return out.String()
}

/* --------------------------------- apoio ---------------------------------- */

// pathOf extrai o `path` dos argumentos de uma ferramenta de arquivo.
func pathOf(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var args struct {
		Path string `json:"path"`
	}
	if json.Unmarshal(raw, &args) != nil {
		return ""
	}
	return strings.TrimSpace(args.Path)
}
