// O DESTRAVADOR da Onda 4: a interface invocando ferramenta FORA do turno do
// modelo — sem virar porta lateral.
//
// A tela do especialista Código precisa de fs.list para a árvore de arquivos,
// fs.read para abrir arquivo, fs.search para o Ctrl+Shift+F e fs.write para o
// Ctrl+S — tudo coisa que hoje só acontece se o MODELO pedir. A tentação era
// uma rota nova chamando o Toolbox direto, e é exatamente a tentação que este
// arquivo recusa: no app anterior a aprovação valia na UI e não valia no
// caminho MCP porque cada transporte decidia sozinho o que era legítimo. Aqui
// a rota é só MAIS UM CHAMADOR do mesmo funil — o pedido da interface passa
// pelo MESMO executeTool do turno (Gate.Evaluate com o especialista da sessão,
// digest por escopo, approval.request quando o risco pede, ganchos de pacote,
// Tool Output Gateway) e deixa os MESMOS envelopes tool.call/tool.result no
// log da sessão. Se um dia o portão mudar, este caminho muda junto, porque é
// o mesmo código.
package supervisor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"

	"aibot/gateway/internal/modelrouter"
	"aibot/gateway/internal/protocol"
	"aibot/gateway/internal/specialist"
	"aibot/gateway/internal/store"
)

// uiAllowedTools é o que a INTERFACE pode pedir por conta própria.
//
// A lista é FECHADA e menor que o catálogo de propósito: o funil de permissão
// decide COMO uma ferramenta roda, mas não decide QUEM tem o direito de
// iniciá-la. Quando o MODELO pede um proc.run, a pessoa lê na conversa o
// raciocínio que levou ao comando antes de aprovar; um POST de qualquer código
// que tenha o token não carrega raciocínio nenhum — um XSS na webview viraria
// execução a um clique de aprovação apertado no automático. Por isso
// ferramenta de processo, rede, segredo e commit NÃO entram aqui, nem com
// aprovação: quem precisa delas fala com o modelo, que é o caminho auditável.
//
// O catálogo do especialista continua valendo POR CIMA desta lista (dentro do
// Gate.Evaluate): a whitelist diz o que a UI pode PEDIR; o especialista da
// sessão diz o que pode RODAR.
var uiAllowedTools = map[string]bool{
	"fs.read": true, "fs.list": true, "fs.search": true,
	"fs.write": true, "fs.patch": true,
	"git.status": true, "git.diff": true,
	"flow.validate": true, "context.fetch": true,
}

// uiAllowedList devolve a lista em ordem estável — a recusa cita o que É
// permitido, senão quem integra a UI descobre a lista por tentativa e erro.
func uiAllowedList() string {
	names := make([]string, 0, len(uiAllowedTools))
	for name := range uiAllowedTools {
		names = append(names, name)
	}
	sort.Strings(names)
	return strings.Join(names, ", ")
}

// uiFallbackSpecialist atende a sessão que ainda não tem modo.
//
// O padrão do roteador é o "chat" (specialist.DefaultID), mas ele não tem
// ferramenta de arquivo nenhuma — cair nele faria a árvore de arquivos nascer
// morta justamente na conversa recém-criada. As ferramentas desta whitelist
// são a superfície do editor, e o dono natural delas é o Código.
const uiFallbackSpecialist = "code"

// uiCompleteMaxTokens é o teto DURO do one-shot de autocomplete. O cliente até
// pode pedir menos; mais que isso não é completar, é gerar — e o autocomplete
// dispara a cada pausa de digitação, então o teto é o que impede a conta do
// provedor de crescer com o tamanho do pedido de quem chama.
const uiCompleteMaxTokens = 512

// UIToolResult é o desfecho de uma chamada de ferramenta feita pela interface —
// exatamente o contrato {ok, output|error} da rota POST /v1/tools/call.
type UIToolResult struct {
	OK     bool   `json:"ok"`
	Output string `json:"output,omitempty"`
	Error  string `json:"error,omitempty"`
}

// CallToolFromUI executa UMA ferramenta a pedido da interface, fora do turno.
//
// O erro (segundo retorno) é só infraestrutura — sessão inexistente, log que
// não grava. Recusa de whitelist, recusa do portão, recusa humana e falha da
// própria ferramenta voltam DENTRO do UIToolResult, porque para a interface
// todas são o mesmo evento: "não rodou, e este é o motivo que se mostra".
func (s *Supervisor) CallToolFromUI(ctx context.Context, sessionID, tool string, args json.RawMessage) (UIToolResult, error) {
	tool = strings.TrimSpace(tool)
	if tool == "" {
		return UIToolResult{Error: "faltou o nome da ferramenta em \"tool\""}, nil
	}

	// A whitelist vem ANTES de qualquer coisa — inclusive de abrir a sessão. E a
	// recusa NÃO deixa envelope: o pedido nem chegou ao funil, é violação do
	// contrato da rota, não decisão de política. Se a recusa fosse logada, a UI
	// teria um jeito de encher o log da conversa sem passar por portão nenhum.
	if !uiAllowedTools[tool] {
		return UIToolResult{Error: fmt.Sprintf(
			"a interface não pode pedir %s fora do turno — as ferramentas liberadas para a UI são: %s",
			tool, uiAllowedList())}, nil
	}

	session, err := s.deps.Store.GetSession(sessionID)
	if err != nil {
		return UIToolResult{}, err
	}

	// O especialista avaliado é o DA SESSÃO: é o catálogo dele que o portão
	// confere, e é ao par (projeto, especialista) dele que um "aprovar sempre"
	// fica preso — o mesmo escopo do turno, senão a concessão dada por um
	// caminho não valeria no outro e as duas superfícies divergiriam.
	specialistID := strings.TrimSpace(session.Specialist)
	if specialistID == "" {
		specialistID = uiFallbackSpecialist
	}
	definition := specialist.GetOrDefault(specialistID)

	// Marca de onde começa a fatia nova do log — é dela que o desfecho é lido
	// depois (ver uiOutcome).
	before, err := s.deps.Store.LastSeq(sessionID)
	if err != nil {
		return UIToolResult{}, err
	}

	// Um id de turno próprio ("ui-…"), e NÃO o registro em `running`: isto não é
	// turno de conversa — não pode ser derrubado por Cancel, não deve marcar a
	// sessão como ocupada e não disputa com o modelo. O id existe porque todo
	// envelope carrega um, e é por ele que a tela agrupa (e o teste encontra)
	// o que esta chamada produziu.
	turn := s.nextID("ui")

	// O workspace é congelado pelo MESMO comWorkspace do turno: fs.read daqui e
	// fs.write do próximo turno enxergam a mesma raiz porque leem a mesma
	// decisão — nenhuma ferramenta calcula diretório sozinha.
	ctx = s.comWorkspace(ctx, sessionID, "", "")

	// O ator é a PESSOA agindo pela interface — não o especialista. É o que a
	// auditoria precisa distinguir: "o modelo pediu" e "a UI pediu" são origens
	// diferentes do mesmo funil. O Specialist vai junto porque é ele que o
	// Grant usa para prender a concessão de sessão ao especialista certo.
	actor := protocol.Actor{Kind: protocol.ActorUser, ID: "ui", Specialist: definition.ID}

	// Daqui em diante é o MESMO caminho do turno: portão, aprovação, ganchos,
	// execução, projeção e envelopes. O retorno textual é formato para modelo;
	// o desfecho estruturado da rota sai do envelope durável logo abaixo.
	raw, _ := s.executeTool(ctx, sessionID, turn, actor, definition, toolInvocation{
		Tool: tool,
		Args: args,
		raw:  string(args),
	})

	// O desfecho é lido do LOG, não deduzido do texto: o envelope tool.result é
	// o contrato do protocolo (ok/output/error), enquanto o texto do executeTool
	// é frase para modelo ler — parseá-la acoplaria a rota a uma redação.
	if result, found := s.uiOutcome(sessionID, before, turn); found {
		return result, nil
	}
	// Sem envelope só há uma explicação: o log recusou a escrita. Uma execução
	// que não deixou rastro não pode voltar como sucesso numa rota que existe
	// para ser auditável — falha alto, com o texto cru para o diagnóstico.
	return UIToolResult{}, fmt.Errorf("a execução não deixou registro no log da sessão: %s", truncate(raw, 300))
}

// uiOutcome procura, na fatia do log gravada depois de `from`, o tool.result
// do turno desta chamada. Paginado porque um turno de modelo pode estar
// correndo em paralelo e enchendo o log entre a marca e o desfecho.
func (s *Supervisor) uiOutcome(sessionID string, from uint64, turn string) (UIToolResult, bool) {
	for {
		batch, err := s.deps.Store.Since(sessionID, from, store.MaxEventBatch)
		if err != nil || len(batch) == 0 {
			return UIToolResult{}, false
		}
		for _, envelope := range batch {
			from = envelope.Seq
			if envelope.Kind != protocol.KindToolResult || envelope.Turn != turn {
				continue
			}
			var payload protocol.ToolResult
			if err := envelope.Decode(&payload); err != nil {
				continue
			}
			output := payload.Output
			// A INTERFACE recebe o INTEGRAL, nunca a projeção. O Tool Output
			// Gateway projeta a saída grande para a JANELA DO MODELO (início +
			// fim + referência) — mas a projeção no editor seria um arquivo
			// CORROMPIDO E SALVÁVEL: fs.read de 200 KB abriria picotado e o
			// Ctrl+S gravaria o picote por cima do arquivo real. O integral já
			// está no Artifact Store (é o gateway que o guardou ao projetar);
			// daqui ele volta inteiro, limitado pelo próprio teto da ferramenta.
			if payload.OK && payload.Truncated {
				if payload.ArtifactRef == "" {
					return UIToolResult{Error: "a saída passou do teto e o artefato integral não pôde ser " +
						"guardado — rode de novo ou peça um trecho menor"}, true
				}
				raw, _, err := s.deps.Store.ReadArtifact(sessionID, payload.ArtifactRef, 0, payload.RawBytes)
				if err != nil {
					return UIToolResult{Error: "a saída integral não pôde ser lida do artefato: " + err.Error()}, true
				}
				output = raw
			}
			return UIToolResult{OK: payload.OK, Output: output, Error: payload.Error}, true
		}
		if len(batch) < store.MaxEventBatch {
			return UIToolResult{}, false
		}
	}
}

/* ----------------------------- autocomplete ------------------------------ */

// CompleteFromUI é o one-shot de modelo do autocomplete (fill-in-the-middle):
// um prompt, uma resposta, e NADA além disso — sem contrato de ferramentas
// (o texto que voltar não tem como executar nada), sem histórico da conversa
// (o contexto do completar é o buffer do editor, que o cliente já recorta —
// ver lib/fim.ts do orquestrador de referência) e sem entrar no log (a cada
// pausa de digitação sai um pedido; gravá-los afogaria a conversa em ruído,
// pelo mesmo motivo de os deltas serem efêmeros).
func (s *Supervisor) CompleteFromUI(ctx context.Context, sessionID, prompt string, maxTokens int) (string, error) {
	if strings.TrimSpace(prompt) == "" {
		return "", errors.New("prompt vazio")
	}
	if s.deps.Models == nil {
		return "", errors.New("este gateway subiu sem roteador de modelos")
	}

	session, err := s.deps.Store.GetSession(sessionID)
	if err != nil {
		return "", err
	}
	specialistID := strings.TrimSpace(session.Specialist)
	if specialistID == "" {
		specialistID = uiFallbackSpecialist
	}

	// O modelo é resolvido pelo MESMO Resolve do turno — escolha da sessão
	// primeiro, preferência do especialista depois — para o autocomplete sair
	// do mesmo modelo que atende a conversa. E o Resolve é onde a política de
	// modelos do admin vale: um modelo fora da lista não atende nem por aqui.
	entry, _, err := s.deps.Models.Resolve(specialistID, session.Model)
	if err != nil {
		return "", err
	}

	// Teto DURO: pedido ausente, zerado ou acima do limite cai em 512. O teto é
	// aplicado aqui, do lado de quem paga, e não confiado ao cliente.
	if maxTokens <= 0 || maxTokens > uiCompleteMaxTokens {
		maxTokens = uiCompleteMaxTokens
	}

	// O prompt master do admin vai junto MESMO no one-shot: a política da casa
	// vale para toda chamada de modelo, e o autocomplete não pode ser o único
	// caminho em que ela não passa. O system do especialista NÃO vai — ele é
	// persona de conversa ("entregue diff aplicável…") e contaminaria a
	// completação com prosa; o prompt de FIM inteiro é responsabilidade do
	// cliente, como na referência.
	messages := make([]modelrouter.ChatMessage, 0, 2)
	if s.deps.PromptMaster != nil {
		if master := strings.TrimSpace(s.deps.PromptMaster()); master != "" {
			messages = append(messages, modelrouter.ChatMessage{Role: "system", Content: master})
		}
	}
	messages = append(messages, modelrouter.ChatMessage{Role: "user", Content: prompt})

	text, _, err := s.deps.Models.Complete(ctx, modelrouter.Request{
		Model:          entry.Model.ID,
		Messages:       messages,
		MaxTokens:      maxTokens,
		ConversationID: sessionID,
	})
	return text, err
}
