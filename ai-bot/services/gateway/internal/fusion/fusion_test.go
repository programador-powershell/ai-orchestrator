package fusion

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"

	"aibot/gateway/internal/modelrouter"
)

// Um dublê de modelo: responde pelo id e anota quem foi chamado, com o quê.
type duble struct {
	mu        sync.Mutex
	respostas map[string]string
	falhas    map[string]error
	chamadas  []chamada
	streamed  []string
}

type chamada struct {
	modelo    string
	mensagens []modelrouter.ChatMessage
	stream    bool
}

func novoDuble() *duble {
	return &duble{respostas: map[string]string{}, falhas: map[string]error{}}
}

func (d *duble) deps() Deps {
	responder := func(stream bool) func(context.Context, string, []modelrouter.ChatMessage) (string, error) {
		return func(ctx context.Context, modelo string, mensagens []modelrouter.ChatMessage) (string, error) {
			d.mu.Lock()
			d.chamadas = append(d.chamadas, chamada{modelo: modelo, mensagens: mensagens, stream: stream})
			if stream {
				d.streamed = append(d.streamed, modelo)
			}
			erro := d.falhas[modelo]
			texto := d.respostas[modelo]
			d.mu.Unlock()
			if erro != nil {
				return "", erro
			}
			return texto, nil
		}
	}
	return Deps{Quiet: responder(false), Stream: responder(true)}
}

func (d *duble) chamadasDe(modelo string) int {
	d.mu.Lock()
	defer d.mu.Unlock()
	total := 0
	for _, c := range d.chamadas {
		if c.modelo == modelo {
			total++
		}
	}
	return total
}

func (d *duble) primeiraMensagem(modelo string) string {
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, c := range d.chamadas {
		if c.modelo == modelo && len(c.mensagens) > 0 {
			return c.mensagens[0].Content
		}
	}
	return ""
}

/* --------------------------------- merge --------------------------------- */

// O merge NAO repete a pergunta em N modelos: o orquestrador decompoe em focos
// exclusivos, cada executor trabalha no seu, e a integracao costura. E a
// diferenca entre pagar tres vezes pelo mesmo texto e pagar uma vez por parte.
func TestMergeDecompoeEIntegra(t *testing.T) {
	d := novoDuble()
	d.respostas["orquestrador"] = "{\"complexity\":0.9,\"executors\":[" +
		"{\"role\":\"Nucleo\",\"focus\":\"o essencial\"}," +
		"{\"role\":\"Riscos\",\"focus\":\"o que pode dar errado\"}]}"
	d.respostas["executor-a"] = "parte do nucleo"
	d.respostas["executor-b"] = "parte dos riscos"

	deps := d.deps()
	deps.Stream = func(ctx context.Context, modelo string, m []modelrouter.ChatMessage) (string, error) {
		d.mu.Lock()
		d.chamadas = append(d.chamadas, chamada{modelo: modelo, mensagens: m, stream: true})
		d.streamed = append(d.streamed, modelo)
		d.mu.Unlock()
		return "texto costurado", nil
	}

	saida, err := Run(context.Background(), Preset{
		Strategy:     StrategyMerge,
		Orchestrator: "orquestrador",
		Executors:    []string{"executor-a", "executor-b"},
	}, "chat", "como faco X?", nil, deps)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if saida != "texto costurado" {
		t.Fatalf("esperava o texto integrado, veio %q", saida)
	}

	// Cada executor foi chamado UMA vez, com o foco que e so dele.
	if n := d.chamadasDe("executor-a"); n != 1 {
		t.Fatalf("executor-a chamado %d vezes", n)
	}
	if n := d.chamadasDe("executor-b"); n != 1 {
		t.Fatalf("executor-b chamado %d vezes", n)
	}
	if foco := d.primeiraMensagem("executor-a"); !strings.Contains(foco, "SOMENTE no seu foco") {
		t.Fatalf("o executor nao recebeu a instrucao de exclusividade: %q", foco)
	}

	// So a integracao e transmitida: quatro executores ao vivo embaralhariam
	// quatro textos na mesma bolha.
	d.mu.Lock()
	defer d.mu.Unlock()
	if len(d.streamed) != 1 || d.streamed[0] != "orquestrador" {
		t.Fatalf("o transmitido devia ser so a integracao, veio %v", d.streamed)
	}
}

// Pergunta simples nao paga o painel inteiro: um executor planejado vira
// resposta direta, sem decomposicao nem integracao.
func TestMergeSimplesRespondeDireto(t *testing.T) {
	d := novoDuble()
	d.respostas["orquestrador"] = "{\"complexity\":0.1,\"executors\":[{\"role\":\"Nucleo\",\"focus\":\"responder\"}]}"
	d.respostas["executor-a"] = "resposta direta"

	saida, err := Run(context.Background(), Preset{
		Strategy: StrategyMerge, Orchestrator: "orquestrador", Executors: []string{"executor-a"},
	}, "chat", "que horas sao?", nil, d.deps())
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if saida != "resposta direta" {
		t.Fatalf("esperava a resposta direta, veio %q", saida)
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if len(d.chamadas) != 2 {
		t.Fatalf("pergunta simples devia custar 2 chamadas, custou %d", len(d.chamadas))
	}
}

// Executor que falha nao derruba o turno: a integracao costura o que sobrou.
func TestMergeSobreviveAExecutorQueFalha(t *testing.T) {
	d := novoDuble()
	d.respostas["orquestrador"] = "{\"complexity\":0.9,\"executors\":[{\"role\":\"A\",\"focus\":\"um\"},{\"role\":\"B\",\"focus\":\"dois\"}]}"
	d.respostas["executor-a"] = "parte boa"
	d.falhas["executor-b"] = errors.New("provedor fora do ar")

	deps := d.deps()
	deps.Stream = func(ctx context.Context, modelo string, m []modelrouter.ChatMessage) (string, error) {
		texto := m[len(m)-1].Content
		if strings.Contains(texto, "Parte 2") {
			t.Errorf("a parte do executor que falhou nao podia chegar a integracao:\n%s", texto)
		}
		return "costurado com uma parte", nil
	}

	saida, err := Run(context.Background(), Preset{
		Strategy: StrategyMerge, Orchestrator: "orquestrador", Executors: []string{"executor-a", "executor-b"},
	}, "chat", "pergunta complexa e longa o suficiente", nil, deps)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if saida != "costurado com uma parte" {
		t.Fatalf("veio %q", saida)
	}
}

// Integracao que falha nao pode engolir o trabalho dos executores.
func TestMergeCaiNoConcatenadoQuandoAIntegracaoFalha(t *testing.T) {
	d := novoDuble()
	d.respostas["orquestrador"] = "{\"complexity\":0.9,\"executors\":[{\"role\":\"A\",\"focus\":\"um\"},{\"role\":\"B\",\"focus\":\"dois\"}]}"
	d.respostas["executor-a"] = "primeira parte"
	d.respostas["executor-b"] = "segunda parte"

	deps := d.deps()
	deps.Stream = func(ctx context.Context, modelo string, m []modelrouter.ChatMessage) (string, error) {
		return "", errors.New("integracao caiu")
	}

	saida, err := Run(context.Background(), Preset{
		Strategy: StrategyMerge, Orchestrator: "orquestrador", Executors: []string{"executor-a", "executor-b"},
	}, "chat", "pergunta", nil, deps)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !strings.Contains(saida, "primeira parte") || !strings.Contains(saida, "segunda parte") {
		t.Fatalf("o concatenado devia trazer as duas partes, veio %q", saida)
	}
}

/* ------------------------------ orchestrate ------------------------------- */

func TestOrchestrateEspecificaExecutaRevisa(t *testing.T) {
	d := novoDuble()
	d.respostas["arquiteto"] = "spec: faca X"
	d.respostas["barato"] = "rascunho do codigo"

	deps := d.deps()
	deps.Stream = func(ctx context.Context, modelo string, m []modelrouter.ChatMessage) (string, error) {
		if modelo != "arquiteto" {
			t.Errorf("quem revisa (e transmite) e o orquestrador, veio %q", modelo)
		}
		if !strings.Contains(m[len(m)-1].Content, "rascunho do codigo") {
			t.Errorf("a revisao precisa receber o rascunho do executor")
		}
		return "entregavel revisado", nil
	}

	saida, err := Run(context.Background(), Preset{
		Strategy: StrategyOrchestrate, Orchestrator: "arquiteto", Executors: []string{"barato"},
	}, "code", "escreva a funcao", nil, deps)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if saida != "entregavel revisado" {
		t.Fatalf("veio %q", saida)
	}
	// A politica de codigo: o arquiteto especifica, o barato implementa.
	if spec := d.primeiraMensagem("barato"); !strings.Contains(spec, "IMPLEMENTADOR") {
		t.Fatalf("o executor de codigo devia receber o papel de implementador: %q", spec)
	}
}

// Orquestrador e executor no mesmo modelo nao pagam tres idas.
func TestOrchestrateComModeloUnicoRespondeDireto(t *testing.T) {
	d := novoDuble()
	d.respostas["unico"] = "resposta unica"

	saida, err := Run(context.Background(), Preset{
		Strategy: StrategyOrchestrate, Orchestrator: "unico", Executors: []string{"unico"},
	}, "chat", "oi", nil, d.deps())
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if saida != "resposta unica" {
		t.Fatalf("veio %q", saida)
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if len(d.chamadas) != 1 {
		t.Fatalf("mesmo modelo dos dois lados devia custar 1 chamada, custou %d", len(d.chamadas))
	}
}

/* --------------------------------- race ---------------------------------- */

func TestRaceFicaComQuemResponde(t *testing.T) {
	d := novoDuble()
	d.falhas["lento"] = errors.New("caiu")
	d.respostas["rapido"] = "cheguei primeiro"

	saida, err := Run(context.Background(), Preset{
		Strategy: StrategyRace, Orchestrator: "rapido", Executors: []string{"lento", "rapido"},
	}, "chat", "oi", nil, d.deps())
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if saida != "cheguei primeiro" {
		t.Fatalf("veio %q", saida)
	}
}

/* -------------------------------- guardas -------------------------------- */

func TestPresetSemOrquestradorERecusado(t *testing.T) {
	d := novoDuble()
	_, err := Run(context.Background(), Preset{Strategy: StrategyMerge}, "chat", "oi", nil, d.deps())
	if !errors.Is(err, ErrSemModelo) {
		t.Fatalf("esperava ErrSemModelo, veio %v", err)
	}
}

func TestEstrategiaInvalidaNaoEValida(t *testing.T) {
	if Strategy("banana").Valid() {
		t.Fatal("estrategia inventada nao pode ser valida")
	}
	for _, ok := range []Strategy{StrategyMerge, StrategyOrchestrate, StrategyRace} {
		if !ok.Valid() {
			t.Fatalf("%q devia ser valida", ok)
		}
	}
}

// O historico atravessa as sub-chamadas: sem isso, trocar de modelo no meio da
// conversa faria cada etapa comecar do zero.
func TestHistoricoAtravessaAsEtapas(t *testing.T) {
	d := novoDuble()
	d.respostas["orq"] = "{\"complexity\":0.1,\"executors\":[{\"role\":\"N\",\"focus\":\"f\"}]}"
	deps := d.deps()
	deps.Stream = func(ctx context.Context, modelo string, m []modelrouter.ChatMessage) (string, error) {
		if len(m) == 0 || m[0].Content != "conversa anterior" {
			t.Errorf("a etapa perdeu o historico: %v", m)
		}
		return "ok", nil
	}

	historico := []modelrouter.ChatMessage{{Role: "user", Content: "conversa anterior"}}
	_, err := Run(context.Background(), Preset{
		Strategy: StrategyMerge, Orchestrator: "orq", Executors: []string{"orq"},
	}, "chat", "e agora?", historico, deps)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if primeira := d.primeiraMensagem("orq"); primeira != "conversa anterior" {
		t.Fatalf("o plano devia vir depois do historico, veio %q", primeira)
	}
}
