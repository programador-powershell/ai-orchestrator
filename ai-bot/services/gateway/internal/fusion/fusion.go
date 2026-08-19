// O motor do Fusion: várias cabeças num turno só.
//
// Porte de `apps/desktop/src/lib/engine.ts` do orquestrador, com uma diferença
// de lugar que muda o desenho: lá o motor roda no cliente e fala com o provedor
// direto; aqui ele roda no GATEWAY, que é quem tem o cofre, o roteador e o
// orçamento do turno. Por isso as chamadas de modelo entram INJETADAS
// (`Deps`): o motor não conhece HTTP, e o teste exercita as três estratégias
// sem uma linha de rede.
//
// O que este motor NÃO é: não é a equipe de especialistas. A equipe divide um
// OBJETIVO em tarefas com dependências, cada uma com suas ferramentas e sua
// cópia do repositório. O fusion divide UMA RESPOSTA entre modelos diferentes,
// e o produto é um texto só. Os dois coexistem: um bot da equipe pode responder
// a tarefa dele usando fusion.
package fusion

import (
	"context"
	"errors"
	"strings"
	"sync"

	"aibot/gateway/internal/modelrouter"
)

// Strategy é como as cabeças se dividem.
type Strategy string

const (
	// StrategyMerge decompõe em focos exclusivos e integra as partes.
	StrategyMerge Strategy = "merge"
	// StrategyOrchestrate especifica, executa e revisa conformidade.
	StrategyOrchestrate Strategy = "orchestrate"
	// StrategyRace dispara todos e fica com quem responder primeiro.
	StrategyRace Strategy = "race"
)

// Valid diz se a estratégia existe. Lista fechada: id desconhecido morre na
// borda, e não três chamadas de modelo depois.
func (s Strategy) Valid() bool {
	switch s {
	case StrategyMerge, StrategyOrchestrate, StrategyRace:
		return true
	}
	return false
}

// Preset é a configuração de um fusion, como a pessoa a salvou.
type Preset struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Description  string   `json:"description"`
	Strategy     Strategy `json:"strategy"`
	Orchestrator string   `json:"orchestrator"`
	Executors    []string `json:"executors"`
}

// MaxExecutors é o teto de executores de um preset.
//
// Quatro é o teto do plano adaptativo do orquestrador (as quatro lentes), e
// passar disso só multiplicaria custo sem acrescentar ângulo.
const MaxExecutors = 4

// Deps são as duas maneiras de falar com um modelo.
//
// Stream é a que a pessoa VÊ (a resposta aparecendo); Quiet é trabalho de
// bastidor. A separação não é estilo: transmitir quatro executores ao mesmo
// tempo embaralharia quatro textos na mesma bolha.
type Deps struct {
	// Quiet roda um modelo e devolve o texto inteiro.
	Quiet func(ctx context.Context, model string, messages []modelrouter.ChatMessage) (string, error)
	// Stream roda um modelo entregando pedaço a pedaço; devolve o texto completo.
	Stream func(ctx context.Context, model string, messages []modelrouter.ChatMessage) (string, error)
	// Stage anuncia a etapa para a tela ("planejando", "3 executores"…). Pode
	// ser nil.
	Stage func(text string)
	// PlanReady entrega o plano adaptativo para a tela desenhar os cartões. Pode
	// ser nil.
	PlanReady func(plan Plan, models []string)
}

// ErrSemModelo é o preset que não tem com que trabalhar.
var ErrSemModelo = errors.New("preset de fusion sem orquestrador")

// Run executa o preset e devolve o texto final.
//
// `history` é a conversa SEM a última pergunta — os construtores de prompt já a
// incluem. Prefixar o histórico em cada sub-chamada é o que impede o fusion de
// "esquecer" a conversa: sem isso cada etapa via só a pergunta isolada, e trocar
// de modelo parecia recomeçar do zero.
func Run(
	ctx context.Context,
	preset Preset,
	specialist string,
	question string,
	history []modelrouter.ChatMessage,
	deps Deps,
) (string, error) {
	if strings.TrimSpace(preset.Orchestrator) == "" {
		return "", ErrSemModelo
	}
	if deps.Quiet == nil || deps.Stream == nil {
		return "", errors.New("fusion sem as chamadas de modelo")
	}

	comContexto := func(construido []modelrouter.ChatMessage) []modelrouter.ChatMessage {
		saida := make([]modelrouter.ChatMessage, 0, len(history)+len(construido))
		saida = append(saida, history...)
		return append(saida, construido...)
	}
	etapa := func(texto string) {
		if deps.Stage != nil {
			deps.Stage(texto)
		}
	}
	executores := preset.Executors
	if len(executores) == 0 {
		executores = []string{preset.Orchestrator}
	}

	switch preset.Strategy {
	case StrategyRace:
		return corrida(ctx, preset, executores, history, question, deps, etapa)
	case StrategyOrchestrate:
		return orquestrar(ctx, preset, executores, specialist, question, history, deps, comContexto, etapa)
	default:
		return fundir(ctx, preset, executores, specialist, question, history, deps, comContexto, etapa)
	}
}

/* --------------------------------- merge --------------------------------- */

func fundir(
	ctx context.Context,
	preset Preset,
	executores []string,
	specialist, question string,
	history []modelrouter.ChatMessage,
	deps Deps,
	comContexto func([]modelrouter.ChatMessage) []modelrouter.ChatMessage,
	etapa func(string),
) (string, error) {
	teto := len(executores)
	if teto > MaxExecutors {
		teto = MaxExecutors
	}

	// 1) O orquestrador decide a complexidade e QUANTOS executores acionar —
	//    pergunta simples não gasta o painel inteiro.
	etapa("Fusion · " + preset.Orchestrator + " planejando")
	texto, err := deps.Quiet(ctx, preset.Orchestrator, comContexto(AdaptivePlanRequest(specialist, question, teto)))
	if err != nil && ctx.Err() != nil {
		return "", ctx.Err()
	}
	plano, ok := ParsePlan(texto, teto)
	if !ok {
		plano = FallbackPlan(question, teto)
	}

	// Um modelo por executor planejado; cicla quando o painel tem menos modelos
	// do que focos.
	painel := make([]string, len(plano.Executors))
	for i := range plano.Executors {
		painel[i] = executores[i%len(executores)]
	}
	if deps.PlanReady != nil {
		deps.PlanReady(plano, painel)
	}

	// Complexidade baixa com um executor só: responde direto, transmitindo —
	// sem pagar decomposição e integração por uma pergunta simples.
	if len(plano.Executors) == 1 {
		etapa("Fusion · resposta direta (" + painel[0] + ")")
		return deps.Stream(ctx, painel[0], append(append([]modelrouter.ChatMessage{}, history...),
			modelrouter.ChatMessage{Role: "user", Content: question}))
	}

	// 2) Execução paralela: cada executor SOMENTE no seu recorte.
	etapa("Fusion · " + itoa(len(plano.Executors)) + " executores em focos exclusivos")
	partes := make([]Part, len(plano.Executors))
	var grupo sync.WaitGroup
	for indice, spec := range plano.Executors {
		grupo.Add(1)
		go func(i int, s ExecutorSpec) {
			defer grupo.Done()
			conteudo, erro := deps.Quiet(ctx, painel[i],
				comContexto(SubtaskRequest(specialist, question, s.Focus, i, len(plano.Executors))))
			if erro != nil || strings.TrimSpace(conteudo) == "" {
				// Executor que falha não derruba o turno: a integração costura o
				// que sobrou. Perder um ângulo é pior que perder a resposta.
				return
			}
			partes[i] = Part{Focus: s.Role + " — " + s.Focus, Content: conteudo}
		}(indice, spec)
	}
	grupo.Wait()
	if ctx.Err() != nil {
		return "", ctx.Err()
	}

	produzidas := make([]Part, 0, len(partes))
	for _, parte := range partes {
		if parte.Content != "" {
			produzidas = append(produzidas, parte)
		}
	}
	if len(produzidas) == 0 {
		return "", errors.New("nenhum executor do fusion respondeu")
	}

	// 3) Integração: costura sem reescrever — e é ELA que a pessoa vê chegando.
	etapa("Fusion · " + preset.Orchestrator + " integrando " + itoa(len(produzidas)) + " partes")
	integrado, err := deps.Stream(ctx, preset.Orchestrator,
		comContexto(IntegrateRequest(specialist, question, produzidas)))
	if err != nil || strings.TrimSpace(integrado) == "" {
		// Integração que falha não pode engolir o trabalho dos executores: o
		// concatenado é pior que o costurado, e infinitamente melhor que nada.
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		bruto := make([]string, 0, len(produzidas))
		for _, parte := range produzidas {
			bruto = append(bruto, parte.Content)
		}
		return strings.Join(bruto, "\n\n"), nil
	}
	return integrado, nil
}

/* ------------------------------ orchestrate ------------------------------- */

func orquestrar(
	ctx context.Context,
	preset Preset,
	executores []string,
	specialist, question string,
	history []modelrouter.ChatMessage,
	deps Deps,
	comContexto func([]modelrouter.ChatMessage) []modelrouter.ChatMessage,
	etapa func(string),
) (string, error) {
	executor := executores[0]

	// Orquestrador e executor no MESMO modelo não ganham nada com três idas:
	// responde direto, transmitindo desde o primeiro token.
	if len(executores) == 1 && executor == preset.Orchestrator {
		etapa("Fusion · " + preset.Orchestrator)
		return deps.Stream(ctx, preset.Orchestrator, append(append([]modelrouter.ChatMessage{}, history...),
			modelrouter.ChatMessage{Role: "user", Content: question}))
	}

	etapa("Fusion · " + preset.Orchestrator + " especificando")
	brief, err := deps.Quiet(ctx, preset.Orchestrator, comContexto(BriefRequest(specialist, question)))
	if err != nil && ctx.Err() != nil {
		return "", ctx.Err()
	}

	etapa("Fusion · " + executor + " executando a spec")
	comPergunta := append(append([]modelrouter.ChatMessage{}, history...),
		modelrouter.ChatMessage{Role: "user", Content: question})
	rascunho, err := deps.Quiet(ctx, executor, ExecuteRequest(specialist, brief, comPergunta))
	if err != nil && ctx.Err() != nil {
		return "", ctx.Err()
	}
	if strings.TrimSpace(rascunho) == "" {
		return "", errors.New("o executor do fusion não produziu rascunho")
	}

	// A revisão é o texto que a pessoa lê aparecendo ao vivo.
	etapa("Fusion · " + preset.Orchestrator + " revisando conformidade")
	final, err := deps.Stream(ctx, preset.Orchestrator, comContexto(ReviewRequest(specialist, question, rascunho)))
	if err != nil || strings.TrimSpace(final) == "" {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		// Revisão que falha devolve o rascunho: ele já é o entregável, só não
		// passou pela conferência.
		return rascunho, nil
	}
	return final, nil
}

/* --------------------------------- race ---------------------------------- */

func corrida(
	ctx context.Context,
	preset Preset,
	executores []string,
	history []modelrouter.ChatMessage,
	question string,
	deps Deps,
	etapa func(string),
) (string, error) {
	etapa("Fusion · corrida entre " + itoa(len(executores)) + " modelos")

	// Cancela os perdedores assim que alguém termina: a corrida existe para
	// ganhar tempo, e deixar os outros rodando gastaria o dinheiro que ela
	// economizou.
	corrida, cancelar := context.WithCancel(ctx)
	defer cancelar()

	mensagens := append(append([]modelrouter.ChatMessage{}, history...),
		modelrouter.ChatMessage{Role: "user", Content: question})

	type resultado struct {
		texto string
		erro  error
	}
	canal := make(chan resultado, len(executores))
	for _, modelo := range executores {
		go func(m string) {
			texto, err := deps.Quiet(corrida, m, mensagens)
			canal <- resultado{texto: texto, erro: err}
		}(modelo)
	}

	var ultimoErro error
	for range executores {
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case r := <-canal:
			if r.erro == nil && strings.TrimSpace(r.texto) != "" {
				return r.texto, nil
			}
			if r.erro != nil {
				ultimoErro = r.erro
			}
		}
	}
	if ultimoErro != nil {
		return "", ultimoErro
	}
	return "", errors.New("nenhum modelo da corrida respondeu")
}
