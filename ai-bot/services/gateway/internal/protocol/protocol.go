// Package protocol define o CANONICAL AGENT PROTOCOL — o único vocabulário que
// atravessa o gateway.
//
// Por que um envelope só, e não um tipo por transporte: o gateway fala HTTP,
// WebSocket, ACP (JSON-RPC no stdio), MCP e CLI. Se cada transporte tivesse a
// sua mensagem, "aprovar uma ferramenta" existiria cinco vezes e divergiria
// cinco vezes — foi assim que, no app anterior, a aprovação valia na UI e não
// valia no caminho MCP. Aqui o transporte só serializa: quem decide o que é
// legítimo é o supervisor, sobre este envelope.
//
// O envelope é APPEND-ONLY e numerado por sessão (Seq). Isso é o que permite
// replay: um cliente que caiu reconecta dizendo o último Seq que viu e recebe
// o resto. Sem numeração, reconectar significaria recomeçar a resposta.
package protocol

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// Version é a versão do envelope. Sobe quando um campo muda de significado —
// nunca quando um campo novo é acrescentado (acrescentar é compatível).
const Version = 1

// Kind é o verbo da mensagem. A lista é fechada de propósito: um verbo novo é
// uma decisão de protocolo, não um detalhe de implementação.
type Kind string

const (
	// --- ciclo de vida da conexão ---

	// KindHello abre a sessão e declara quem está do outro lado.
	KindHello Kind = "hello"
	// KindReady responde ao hello com o estado que o cliente precisa para pintar a tela.
	KindReady Kind = "ready"
	// KindError encerra um turno com motivo legível.
	KindError Kind = "error"
	// KindDone fecha um turno com sucesso.
	KindDone Kind = "done"

	// --- conversa ---

	// KindPrompt é o texto que a pessoa enviou.
	KindPrompt Kind = "prompt"
	// KindRoute é a decisão do supervisor: qual especialista assume esta linha.
	KindRoute Kind = "route"
	// KindDelta é um pedaço de texto em streaming.
	KindDelta Kind = "delta"
	// KindMessage é uma mensagem completa (usada em replay e em transportes sem stream).
	KindMessage Kind = "message"
	// KindThinking sinaliza raciocínio em andamento — a UI mostra o orbe, não o texto.
	KindThinking Kind = "thinking"

	// --- ferramentas ---

	// KindToolCall é o modelo pedindo para executar uma ferramenta.
	KindToolCall Kind = "tool.call"
	// KindToolResult é o retorno da ferramenta (ou o erro dela).
	KindToolResult Kind = "tool.result"

	// --- permissão ---

	// KindApprovalRequest suspende a execução até uma pessoa decidir.
	KindApprovalRequest Kind = "approval.request"
	// KindApprovalDecision é a decisão humana que libera ou recusa.
	KindApprovalDecision Kind = "approval.decision"

	// --- orquestração ---
	//
	// Vocabulário levantado do Orca (MIT) em regime clean-room: despacho de
	// tarefa para trabalhador, espera por worker_done ou escalação, perguntas
	// bloqueantes entre agentes, DAG de tarefas e portões de decisão. Ver
	// docs/creditos-inspiracao.md.

	// KindTaskDispatch entrega uma tarefa a um trabalhador.
	KindTaskDispatch Kind = "task.dispatch"
	// KindTaskProgress informa andamento sem encerrar a tarefa.
	KindTaskProgress Kind = "task.progress"
	// KindWorkerDone encerra a tarefa de um trabalhador com resultado.
	KindWorkerDone Kind = "worker.done"
	// KindEscalate devolve a tarefa para cima quando o trabalhador não consegue decidir.
	KindEscalate Kind = "escalate"
	// KindAsk é uma pergunta BLOQUEANTE de um agente para outro (ou para a pessoa).
	KindAsk Kind = "ask"
	// KindReply responde um KindAsk e destrava quem perguntou.
	KindReply Kind = "reply"
	// KindGate é um portão de decisão do DAG: segue, refaz ou aborta.
	KindGate Kind = "gate"

	// --- delegação ---

	// KindDelegate é um especialista chamando OUTRO por conta própria, dentro do
	// mesmo turno e sem perguntar nada à pessoa.
	//
	// Por que isto NÃO é KindTaskDispatch: aquele monta uma EQUIPE — DAG de
	// tarefas com dependências, ondas, portão entre elas e cópia isolada do
	// repositório por trabalhador — e quem o emite é o especialista `agent`,
	// deliberadamente, porque o pedido é grande o bastante para valer um plano.
	// Este aqui é o contrário: um especialista qualquer percebendo, no meio da
	// própria resposta, que um pedaço do pedido é de outra especialidade, e
	// pedindo aquela coisa pontual. Não há plano, não há onda, não há worktree e
	// não há segundo turno — o dono da conversa continua sendo quem delegou.
	//
	// Enfiar os dois no mesmo verbo obrigaria a tela a adivinhar, pelo formato do
	// payload, se desenha um quadro de equipe ou o popup de um bot só.
	KindDelegate Kind = "delegate"

	// --- estado ---

	// KindState publica uma mudança de estado observável (sessão, especialista, modelo).
	KindState Kind = "state"

	// --- aviso ---

	// KindNotice é o supervisor contando, ANTES de fazer, onde um passo vai
	// rodar — o popup animado de alguns segundos na tela.
	//
	// Não é KindApprovalRequest: não pede decisão nenhuma e não para o turno.
	// Não é KindState: não muda o ambiente da sessão — anuncia UM passo. Nasceu
	// para o Docker: decidir "isto vai para um container" (ou "o sbx não está
	// instalado, vai para o ai-jail da VPS") sem contar é exatamente o silêncio
	// de execução que o seletor de ambiente existe para acabar.
	KindNotice Kind = "notice"
)

// validKinds existe para que um envelope malformado morra na borda, e não três
// camadas adiante com um switch caindo no default silencioso.
var validKinds = map[Kind]bool{
	KindHello: true, KindReady: true, KindError: true, KindDone: true,
	KindPrompt: true, KindRoute: true, KindDelta: true, KindMessage: true, KindThinking: true,
	KindToolCall: true, KindToolResult: true,
	KindApprovalRequest: true, KindApprovalDecision: true,
	KindTaskDispatch: true, KindTaskProgress: true, KindWorkerDone: true,
	KindEscalate: true, KindAsk: true, KindReply: true, KindGate: true,
	KindDelegate: true,
	KindState:    true,
	KindNotice:   true,
}

// Valid diz se o verbo é conhecido.
func (k Kind) Valid() bool { return validKinds[k] }

// ActorKind separa quem PODE decidir de quem apenas executa. A distinção não é
// decorativa: só `user` aprova ferramenta, e só `supervisor` roteia.
type ActorKind string

const (
	ActorUser       ActorKind = "user"
	ActorSupervisor ActorKind = "supervisor"
	ActorSpecialist ActorKind = "specialist"
	ActorWorker     ActorKind = "worker"
	ActorTool       ActorKind = "tool"
	ActorSystem     ActorKind = "system"
)

// Actor identifica a origem ou o destino de um envelope.
type Actor struct {
	Kind ActorKind `json:"kind"`
	// ID é estável dentro da sessão (id do trabalhador, nome da ferramenta…).
	ID string `json:"id,omitempty"`
	// Specialist é o especialista sob o qual o ator agiu. É o que a UI usa para
	// desenhar o ícone na frente da linha — por isso viaja no envelope e não é
	// deduzido depois: deduzir dá certo até a conversa trocar de especialista no
	// meio, que é justamente o caso normal aqui.
	Specialist string `json:"specialist,omitempty"`
}

// Envelope é a unidade de tráfego do protocolo.
type Envelope struct {
	V   int       `json:"v"`
	ID  string    `json:"id"`
	TS  time.Time `json:"ts"`
	Seq uint64    `json:"seq"`

	Session string `json:"session"`
	// Turn agrupa tudo o que nasceu de um mesmo prompt: a rota, os deltas, as
	// chamadas de ferramenta e o done. A UI colapsa um turno inteiro por este id.
	Turn string `json:"turn,omitempty"`

	Kind Kind  `json:"kind"`
	From Actor `json:"from"`
	// To é ponteiro porque "sem destino" é o caso comum (broadcast para a UI) e
	// precisa serializar como ausente. `omitempty` em struct não omite nada — o
	// campo sairia como {"kind":""} em todo envelope.
	To *Actor `json:"to,omitempty"`

	Payload json.RawMessage `json:"payload,omitempty"`
}

// ErrInvalidEnvelope marca rejeição na borda.
var ErrInvalidEnvelope = errors.New("envelope inválido")

// Validate recusa o que não tem como ser processado adiante.
func (e *Envelope) Validate() error {
	if e == nil {
		return fmt.Errorf("%w: nulo", ErrInvalidEnvelope)
	}
	if e.V != Version {
		return fmt.Errorf("%w: versão %d (esperada %d)", ErrInvalidEnvelope, e.V, Version)
	}
	if e.Session == "" {
		return fmt.Errorf("%w: sessão vazia", ErrInvalidEnvelope)
	}
	if !e.Kind.Valid() {
		return fmt.Errorf("%w: verbo desconhecido %q", ErrInvalidEnvelope, e.Kind)
	}
	if e.From.Kind == "" {
		return fmt.Errorf("%w: remetente sem tipo", ErrInvalidEnvelope)
	}
	return nil
}

// Decode preenche `dst` com o payload. Erro de payload é erro de protocolo, e
// não um zero-value silencioso adiante.
func (e *Envelope) Decode(dst any) error {
	if len(e.Payload) == 0 {
		return fmt.Errorf("%w: payload ausente para %s", ErrInvalidEnvelope, e.Kind)
	}
	if err := json.Unmarshal(e.Payload, dst); err != nil {
		return fmt.Errorf("%w: payload de %s: %v", ErrInvalidEnvelope, e.Kind, err)
	}
	return nil
}

// SetPayload serializa `src` no envelope.
func (e *Envelope) SetPayload(src any) error {
	if src == nil {
		e.Payload = nil
		return nil
	}
	raw, err := json.Marshal(src)
	if err != nil {
		return fmt.Errorf("payload de %s: %w", e.Kind, err)
	}
	e.Payload = raw
	return nil
}

/* ------------------------------ payloads ------------------------------- */

// Hello abre a sessão.
type Hello struct {
	Client  string `json:"client"`
	Version string `json:"version"`
	// Token autentica a conexão. Vai NO PRIMEIRO FRAME e nunca na query string
	// da URL: query entra em log de proxy, em histórico e em mensagem de erro,
	// e o navegador não aplica CORS a WebSocket — sem token, qualquer página
	// aberta na estação conversa com o gateway.
	Token       string `json:"token,omitempty"`
	SessionHint string `json:"sessionHint,omitempty"`
	// Specialist é o DONO da conversa nova: "novo schema" na tela de Dados abre
	// uma conversa que já nasce do bot de Dados — a pessoa fica na tela em que
	// está, e o primeiro pedido vai direto ao bot, sem descer a cascata.
	// Ignorado quando a sessão já existe (o modo gravado é dela) e quando o id
	// não é de nenhum especialista.
	Specialist string `json:"specialist,omitempty"`
	// ResumeFrom pede replay a partir deste Seq (exclusivo). Zero = do começo.
	ResumeFrom uint64 `json:"resumeFrom,omitempty"`
	// LiveOnly pede SÓ os eventos novos: o servidor pula o replay inteiro e o
	// cursor começa no Seq que foi para o `ready`.
	//
	// Existe por causa de quem não tem tela. A ponte de ferramentas do aplicativo
	// nativo conecta para responder `tool.result` e joga fora tudo o que é
	// histórico — sem este campo, cada reconexão dela reenvia a conversa inteira
	// desde o Seq 1. Numa sessão longa isso é megabyte por reconexão, lido do
	// disco, serializado e transmitido para ser descartado do outro lado.
	//
	// Quem tem tela NÃO usa isto: para a janela, o replay é o que reconstrói a
	// conversa depois de uma queda no meio do turno.
	LiveOnly bool `json:"liveOnly,omitempty"`
}

// Ready devolve o que a tela precisa para se montar sem uma segunda chamada.
type Ready struct {
	Session     string   `json:"session"`
	Seq         uint64   `json:"seq"`
	Specialists []string `json:"specialists"`
	Models      []Model  `json:"models"`
	// ActiveSpecialist é o especialista em que a sessão parou. Vazio numa sessão
	// nova: é o master que decide, e ele só decide depois do primeiro prompt.
	ActiveSpecialist string `json:"activeSpecialist,omitempty"`
	ActiveModel      string `json:"activeModel,omitempty"`
	// Environment é onde o próximo comando roda. Vem no `ready` para a tela
	// NASCER sabendo onde está: um rodapé que abre em "Local" e só descobre o
	// ambiente de verdade no primeiro `state` mostra o lugar errado justamente
	// no quadro em que a pessoa decide se manda o comando.
	Environment Environment `json:"environment,omitempty"`
	// Environments é o catálogo com disponibilidade JÁ medida. Sem ele a tela
	// listaria os cinco e ofereceria opção que não funciona.
	Environments []EnvironmentInfo `json:"environments,omitempty"`
	// Sessions são as conversas recentes, mais nova primeiro.
	//
	// Viaja no `ready` porque a barra lateral do cliente lista as conversas e não
	// tinha de onde tirá-las: o socket entregava só a sessão corrente, então a
	// lista nascia e ficava permanentemente vazia — a pessoa não alcançava
	// nenhuma conversa anterior pela janela. O mesmo motivo do resto do `ready`:
	// a tela se monta com o que já chegou, sem uma segunda chamada.
	Sessions []SessionSummary `json:"sessions"`
}

// SessionSummary é o cabeçalho de uma conversa — o mínimo para desenhar a linha
// da barra lateral (título, ícone do especialista, quando foi e quanto rendeu)
// sem abrir o log de nenhuma delas.
type SessionSummary struct {
	ID         string    `json:"id"`
	Title      string    `json:"title"`
	Specialist string    `json:"specialist,omitempty"`
	Model      string    `json:"model,omitempty"`
	UpdatedAt  time.Time `json:"updatedAt"`
	Turns      int       `json:"turns"`
	// O bot dono e a conversa de origem. Vazios numa conversa comum; num par,
	// dizem que esta linha é a conversa daquele bot pendurada naquela outra.
	//
	// Vêm no resumo porque a barra lateral desenha o aninhamento no PRIMEIRO
	// quadro: buscar o vínculo depois faria as filhas aparecerem soltas na raiz
	// por um instante e depois pularem para baixo do dono.
	BotID    string `json:"botId,omitempty"`
	ParentID string `json:"parentId,omitempty"`
	// O último pedido feito ao bot desta conversa — o subtítulo da linha. O
	// título diz de QUEM a conversa é; este diz O QUE ele está fazendo.
	LastGoal string `json:"lastGoal,omitempty"`
}

// Model é um modelo oferecido ao usuário. O usuário escolhe; a política decide
// o que aparece na lista.
type Model struct {
	ID       string   `json:"id"`
	Provider string   `json:"provider"`
	Label    string   `json:"label"`
	Context  int      `json:"context"`
	Skills   []string `json:"skills,omitempty"`
	Local    bool     `json:"local,omitempty"`
}

/* ------------------------------- ambiente -------------------------------- */

// Environment é ONDE o próximo comando roda.
//
// Não é preferência de exibição: é o destino real da execução. O produto
// anterior tinha este seletor no rodapé e roteava SÓ o terminal — o agente
// compilava no servidor e lia os arquivos na estação, sem ninguém perceber que
// eram duas máquinas. Por isso o ambiente viaja no protocolo e é o supervisor
// que o consulta antes de despachar `proc.run`.
type Environment string

const (
	// EnvLocal é a estação da pessoa. Quem executa é o aplicativo nativo (Rust),
	// que tem Job Object e ConPTY — o gateway não roda comando na estação.
	EnvLocal Environment = "local"
	// EnvDocker é o Docker Sandboxes (`sbx`) instalado na máquina.
	EnvDocker Environment = "docker"
	// EnvWSL é o subsistema Linux do Windows.
	EnvWSL Environment = "wsl"
	// EnvVPS é o servidor configurado pela TI.
	EnvVPS Environment = "vps"
	// EnvCloud é o executor de nuvem (GitHub, GitLab, Gitea…).
	EnvCloud Environment = "cloud"
)

// validEnvironments fecha a lista na borda: ambiente desconhecido tem de morrer
// na rota que o recebe, e não virar um `default` silencioso lá dentro que roda
// o comando no lugar errado.
var validEnvironments = map[Environment]bool{
	EnvLocal: true, EnvDocker: true, EnvWSL: true, EnvVPS: true, EnvCloud: true,
}

// Valid diz se o ambiente é conhecido.
func (e Environment) Valid() bool { return validEnvironments[e] }

// EnvironmentInfo é um ambiente como a tela precisa vê-lo.
//
// `Available` e `Detail` existem juntos de propósito: oferecer uma opção que
// não funciona é pior do que não oferecer, e ESCONDER a que não funciona faz a
// pessoa procurar por ela. O certo é mostrar cinza com o motivo — "o Docker
// Sandboxes não está instalado" é acionável; a opção sumir, não.
type EnvironmentInfo struct {
	ID    Environment `json:"id"`
	Label string      `json:"label"`
	Hint  string      `json:"hint"`
	// Available diz se este ambiente PODE ser escolhido agora.
	Available bool `json:"available"`
	// Detail diz por que não, quando não.
	Detail string `json:"detail,omitempty"`
}

// Prompt é o texto enviado pela pessoa.
type Prompt struct {
	Text string `json:"text"`
	// Specialist fixa o especialista desta linha. Vazio = o master decide, que é
	// o caminho normal. Preenchido só quando a pessoa escolheu na mão.
	Specialist string `json:"specialist,omitempty"`
	// Model sobrepõe o modelo desta linha. Vazio = o do especialista.
	Model       string       `json:"model,omitempty"`
	Attachments []Attachment `json:"attachments,omitempty"`
	// Mentions são caminhos citados com @ no composer.
	Mentions []string `json:"mentions,omitempty"`
}

// Attachment é um anexo já materializado (o transporte não carrega arquivo solto).
type Attachment struct {
	Name  string `json:"name"`
	Mime  string `json:"mime"`
	Bytes int64  `json:"bytes"`
	// Ref é o identificador no store local. Conteúdo não trafega no envelope.
	Ref string `json:"ref"`
}

// RouteReason diz COMO a rota foi decidida. A UI mostra isso ao passar o mouse
// no ícone do especialista: uma troca de especialista que a pessoa não entende
// parece defeito.
type RouteReason string

const (
	// RouteExplicit — a pessoa escolheu.
	RouteExplicit RouteReason = "explicit"
	// RouteClarified — a pessoa respondeu à CLARIFICAÇÃO do master.
	//
	// Não é o mesmo gesto que o explicit: quem escreve /mode (ou abre a conversa
	// já no bot) pediu uma conversa DAQUELE bot, e a conversa vira dele; quem
	// clicou numa opção do cartão só disse QUEM TRABALHA — a raiz delega como se
	// a cascata tivesse decidido com confiança 1, e esta razão é a transparência
	// disso na conversa FILHA, sem sequestrar a raiz.
	RouteClarified RouteReason = "clarified"
	// RouteHeuristic — o classificador léxico decidiu sozinho, com folga.
	RouteHeuristic RouteReason = "heuristic"
	// RouteNeedle — o modelo local minúsculo (Needle) classificou, na máquina,
	// sem rede.
	RouteNeedle RouteReason = "needle"
	// RouteModel — o modelo master (o grande) classificou.
	RouteModel RouteReason = "model"
	// RouteSticky — a conversa JÁ TEM modo. Não houve classificação nenhuma:
	// depois do primeiro turno, a conversa inteira vai para o mesmo executor.
	RouteSticky RouteReason = "sticky"
	// RouteFallback — nada decidiu; caiu no especialista padrão.
	RouteFallback RouteReason = "fallback"
)

// Route é a decisão do supervisor para uma linha da conversa.
type Route struct {
	Specialist string      `json:"specialist"`
	Previous   string      `json:"previous,omitempty"`
	Reason     RouteReason `json:"reason"`
	// Confidence em [0,1]. Abaixo do limiar o supervisor consulta o modelo.
	Confidence float64 `json:"confidence"`
	// Surface é a superfície que a tela deve assumir. Viaja junto porque a troca
	// de especialista e a troca de tela são o MESMO evento — separá-las deixa a
	// tela um quadro atrás do ícone.
	Surface string `json:"surface"`
	Model   string `json:"model"`
	// Signals são os termos que pesaram na decisão (vazio quando veio do modelo).
	Signals []string `json:"signals,omitempty"`
	// Standby é o ELENCO DE APOIO: quem entra em espera junto com o dono.
	//
	// Escolher o dono nunca foi o trabalho todo. "Crie uma aplicação completa" é
	// do Código, mas se ela tem interface o Design tem o que fazer, e depois de
	// existir código alguém revisa a segurança. Sem isto a pessoa precisaria
	// lembrar de pedir cada um — devolvendo a ela o roteamento que o master
	// existe para fazer.
	Standby []Standby `json:"standby,omitempty"`
}

// Standby é um especialista de apoio, e QUANDO ele entra.
type Standby struct {
	Specialist string `json:"specialist"`
	// When é "parallel" (trabalha junto do dono) ou "after" (trabalha sobre o
	// que o dono produziu). É o formato do plano, não enfeite: paralelizar quem
	// depende produz um parecer sobre trabalho que ainda não existe, e
	// serializar quem é independente dobra o tempo por nada.
	When string `json:"when"`
	// Why é a frase que a tela mostra, escrita para a pessoa ler.
	Why string `json:"why"`
}

// Delta é um pedaço de resposta.
type Delta struct {
	Text string `json:"text"`
}

// Message é uma mensagem inteira.
type Message struct {
	Role string `json:"role"` // user | assistant | system
	Text string `json:"text"`
	// Specialist redundante com From.Specialist de propósito: o replay lê a
	// mensagem sem precisar do envelope que a embrulhou.
	Specialist string `json:"specialist,omitempty"`
	Model      string `json:"model,omitempty"`
}

// Thinking é o sinal de raciocínio. `Label` é o nome do orbe na UI.
type Thinking struct {
	Label string `json:"label"`
	Done  bool   `json:"done,omitempty"`
	// Reasoning marca que `Label` é TEXTO DE RACIOCÍNIO do modelo, não rótulo
	// de etapa. Os dois sempre viajaram pelo mesmo verbo e o cliente não tinha
	// como separá-los — o raciocínio piscava no orbe e era descartado. O campo
	// é opcional dos dois lados de propósito: payload antigo decodifica com
	// `false` (rótulo, como era) e cliente antigo ignora o campo extra.
	Reasoning bool `json:"reasoning,omitempty"`
}

// ToolCall é o pedido de execução de ferramenta.
type ToolCall struct {
	CallID string          `json:"callId"`
	Tool   string          `json:"tool"`
	Args   json.RawMessage `json:"args,omitempty"`
	// Digest identifica argumentos iguais entre chamadas — é o que permite
	// "aprovar sempre" sem virar cheque em branco para qualquer argumento.
	Digest string `json:"digest,omitempty"`
}

// ToolResult é o retorno.
type ToolResult struct {
	CallID string `json:"callId"`
	Tool   string `json:"tool"`
	OK     bool   `json:"ok"`
	Output string `json:"output,omitempty"`
	Error  string `json:"error,omitempty"`
	// Elapsed em milissegundos.
	Elapsed int64 `json:"elapsedMs,omitempty"`
	// A saída passou do teto inline: `Output` é uma PROJEÇÃO (início + fim) e o
	// integral vive no Artifact Store, recuperável em fatias por context.fetch.
	// Nenhuma ferramenta despeja saída ilimitada na janela do modelo.
	Truncated   bool   `json:"truncated,omitempty"`
	ArtifactRef string `json:"artifactRef,omitempty"`
	RawBytes    int    `json:"rawBytes,omitempty"`
}

// Risk classifica o estrago possível de uma ferramenta.
type Risk string

const (
	RiskRead    Risk = "read"    // lê e não altera nada
	RiskWrite   Risk = "write"   // altera arquivo do projeto
	RiskExecute Risk = "execute" // roda processo
	RiskNetwork Risk = "network" // sai para a rede
	RiskSecret  Risk = "secret"  // toca segredo
)

// ApprovalRequest suspende a execução.
type ApprovalRequest struct {
	CallID string `json:"callId"`
	Tool   string `json:"tool"`
	Risk   Risk   `json:"risk"`
	// Summary é a frase que a pessoa lê antes de decidir. Sem ela a aprovação
	// vira um botão que se aperta no automático.
	Summary string `json:"summary"`
	Detail  string `json:"detail,omitempty"`
	Digest  string `json:"digest,omitempty"`
}

// ApprovalDecision é a resposta humana.
type ApprovalDecision struct {
	CallID  string `json:"callId"`
	Allow   bool   `json:"allow"`
	Scope   string `json:"scope,omitempty"` // once | digest | session
	Comment string `json:"comment,omitempty"`
}

// Task é um nó do DAG de orquestração.
type Task struct {
	ID         string   `json:"id"`
	Title      string   `json:"title"`
	Specialist string   `json:"specialist"`
	Goal       string   `json:"goal"`
	DependsOn  []string `json:"dependsOn,omitempty"`
	// Worktree pede isolamento em cópia própria do repositório. Duas tarefas que
	// escrevem no mesmo arquivo sem isso se sobrescrevem sem aviso.
	Worktree bool   `json:"worktree,omitempty"`
	Model    string `json:"model,omitempty"`
}

// TaskDispatch entrega a tarefa ao trabalhador.
type TaskDispatch struct {
	Task Task `json:"task"`
	// WorkerID hoje é o processo lógico da onda (w-1-t1); no cluster ele passa
	// a ser o PC registrado ("pc-02") e o processo lógico vive no TaskRunID.
	// Os dois campos existem desde já para a tela não ter de reaprender o
	// contrato no dia da troca.
	WorkerID string `json:"workerId"`
	// TaskRunID identifica ESTA execução da tarefa (tentativa incluída).
	TaskRunID string `json:"taskRunId,omitempty"`
	// WorkspacePlanID é o plano congelado em que a execução trabalha, e
	// LeaseEpoch a época do lease no congelamento (ver internal/workspace).
	WorkspacePlanID string `json:"workspacePlanId,omitempty"`
	LeaseEpoch      uint64 `json:"leaseEpoch,omitempty"`
	// Wave é a onda topológica do DAG — tudo na mesma onda pode rodar junto.
	Wave int `json:"wave"`
}

// TaskProgress informa andamento.
type TaskProgress struct {
	TaskID   string  `json:"taskId"`
	WorkerID string  `json:"workerId"`
	Note     string  `json:"note"`
	Fraction float64 `json:"fraction,omitempty"`
}

// WorkerDone encerra a tarefa.
type WorkerDone struct {
	TaskID   string `json:"taskId"`
	WorkerID string `json:"workerId"`
	OK       bool   `json:"ok"`
	Result   string `json:"result,omitempty"`
	Error    string `json:"error,omitempty"`
	// Worktree é o caminho da cópia isolada, quando houve.
	Worktree string `json:"worktree,omitempty"`
	// Branch é o ramo que o trabalhador produziu.
	Branch string `json:"branch,omitempty"`
	// Escalated marca o trabalhador que PAROU PARA PERGUNTAR em vez de errar.
	//
	// Vem junto com OK=false — não houve resultado para as dependentes lerem — e
	// mesmo assim NÃO é falha: escalar é o trabalhador se recusando a adivinhar.
	// O campo existe porque quem sabe disso é aqui: deduzir do lado de fora
	// pediria cruzar o KindEscalate com este evento pelo TaskID, e as duas coisas
	// têm ciclo de vida diferente na tela — a lista de escalações só cresce
	// enquanto o `done` é sobrescrito por tarefa, então dois planos na mesma
	// conversa reusando o id `t1` fariam a escalação velha rotular a falha nova.
	Escalated bool `json:"escalated,omitempty"`
}

// Escalate devolve a decisão para cima.
type Escalate struct {
	TaskID   string   `json:"taskId"`
	WorkerID string   `json:"workerId"`
	Question string   `json:"question"`
	Options  []string `json:"options,omitempty"`
}

// Ask é uma pergunta bloqueante.
type Ask struct {
	AskID    string   `json:"askId"`
	Question string   `json:"question"`
	Options  []string `json:"options,omitempty"`
	// Detail é o corpo da decisão (o plano proposto, por exemplo), separado da
	// pergunta pelo mesmo motivo do ApprovalRequest: a pergunta é a frase que se
	// lê antes de decidir, e afogá-la num texto longo faria o botão ser apertado
	// no automático.
	Detail string `json:"detail,omitempty"`
	// Blocking=false permite seguir sem resposta (aviso, não pergunta).
	Blocking bool `json:"blocking"`
}

// Reply destrava um Ask.
type Reply struct {
	AskID  string `json:"askId"`
	Answer string `json:"answer"`
}

// GateDecision é o veredito de um portão do DAG.
type GateDecision string

const (
	GateProceed GateDecision = "proceed"
	GateRetry   GateDecision = "retry"
	GateAbort   GateDecision = "abort"
)

// Gate é o portão entre ondas do DAG.
type Gate struct {
	GateID   string       `json:"gateId"`
	TaskID   string       `json:"taskId,omitempty"`
	Decision GateDecision `json:"decision"`
	Reason   string       `json:"reason,omitempty"`
}

// Delegate é um especialista chamando outro por conta própria.
//
// Sai DUAS vezes por delegação: uma com `Done` falso, antes de o delegado
// começar, e outra com `Done` verdadeiro e o resultado. O primeiro envelope é o
// que faz o popup do bot aparecer na hora certa — anunciar quem entrou só depois
// de ele já ter saído não anuncia nada.
type Delegate struct {
	From   string `json:"from"`             // quem delegou
	To     string `json:"to"`               // quem entrou
	Goal   string `json:"goal"`             // o que foi pedido a ele
	Reason string `json:"reason,omitempty"` // por que, em uma frase
	Depth  int    `json:"depth"`            // 1 = primeira delegação
	Done   bool   `json:"done,omitempty"`   // true quando o delegado terminou
	Result string `json:"result,omitempty"`
	// A conversa do bot delegado, pendurada nesta. Vazio quando não deu para
	// abrir — o espelho é acessório e não pode derrubar a delegação.
	Session string `json:"session,omitempty"`
}

// State publica uma mudança observável.
type State struct {
	Specialist string `json:"specialist,omitempty"`
	Model      string `json:"model,omitempty"`
	Surface    string `json:"surface,omitempty"`
	// Environment é o ambiente de execução ativo. Trocar de ambiente é uma
	// mudança de estado como qualquer outra — e precisa chegar a TODAS as
	// janelas da sessão, senão a segunda janela continua mostrando o anterior e
	// a pessoa manda o comando achando que ele roda em outro lugar.
	Environment Environment `json:"environment,omitempty"`
	Busy        bool        `json:"busy"`
	// Tokens gastos no turno, para o medidor de contexto.
	PromptTokens int `json:"promptTokens,omitempty"`
	OutputTokens int `json:"outputTokens,omitempty"`

	// UpdateAvailable diz que há publicação nova PENDENTE — algo que já foi
	// baixado e verificado e que ainda espera um reinício, uma reabertura ou o
	// instalador.
	//
	// Pendente, e não "existe versão nova": a trilha de DADOS (catálogo de
	// especialistas, prompts) aplica a quente e não aparece aqui. Avisar a
	// pessoa sobre o que já está valendo faria o aviso da atualização que
	// realmente pede algo dela virar ruído (ver internal/update).
	UpdateAvailable bool   `json:"updateAvailable,omitempty"`
	UpdateVersion   string `json:"updateVersion,omitempty"`
	// UpdateTracks são as trilhas pendentes: "gateway", "ui", "shell". A tela
	// escolhe a frase pelo que cada uma custa — o gateway reinicia sozinho, a
	// interface pede reabrir, a casca pede instalador.
	UpdateTracks []string `json:"updateTracks,omitempty"`
}

// Notice é o payload do KindNotice — o aviso animado de execução.
//
// Viaja EFÊMERO (PublishEphemeral), nunca no log durável: o aviso "este passo
// vai rodar num container" só faz sentido antes de o passo rodar, e um replay
// que reencenasse o popup de ontem ao abrir a conversa seria defeito.
type Notice struct {
	// Icon é o desenho que a tela põe ao lado do bot ("docker" → contêiner).
	Icon string `json:"icon"`
	// Title é a frase principal do popup.
	Title string `json:"title"`
	// Detail é o porquê, em uma frase — a parte que evita o aviso críptico.
	Detail string `json:"detail,omitempty"`
	// Specialist é o especialista ativo: é o avatar DELE que desliza no popup,
	// e a tela não tem como deduzir isso de um envelope efêmero fora de turno.
	Specialist string `json:"specialist,omitempty"`
}

// Error encerra o turno com motivo.
type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	// Retryable diz se refazer o mesmo pedido tem chance de dar certo.
	Retryable bool `json:"retryable,omitempty"`
}

// Done fecha o turno.
type Done struct {
	Turn         string `json:"turn"`
	Specialist   string `json:"specialist,omitempty"`
	OutputTokens int    `json:"outputTokens,omitempty"`
	Interrupted  bool   `json:"interrupted,omitempty"`
}
