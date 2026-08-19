package supervisor

import (
	"context"
	"strings"
	"testing"
	"time"

	"aibot/gateway/internal/eventbus"
	"aibot/gateway/internal/permissions"
	"aibot/gateway/internal/protocol"
	"aibot/gateway/internal/specialist"
	"aibot/gateway/internal/store"
)

// mensagensDe devolve as falas (papel + texto) de uma conversa, na ordem.
func mensagensDe(t *testing.T, dataStore *store.Store, sessionID string) []protocol.Message {
	t.Helper()
	envelopes, err := dataStore.Since(sessionID, 0, 1000)
	if err != nil {
		t.Fatalf("ler o log de %s: %v", sessionID, err)
	}
	out := make([]protocol.Message, 0, 2)
	for _, envelope := range envelopes {
		if envelope.Kind != protocol.KindMessage {
			continue
		}
		var msg protocol.Message
		if err := envelope.Decode(&msg); err != nil {
			t.Fatalf("decodificar mensagem: %v", err)
		}
		out = append(out, msg)
	}
	return out
}

// O bot delegado ganha CONVERSA PRÓPRIA, pendurada na que o chamou.
//
// Antes, pedir uma coisa ao Conversa fazia ele chamar o Código, o Código
// respondia dentro da conversa do Conversa e sumia: não sobrava com quem falar.
// Quem quisesse continuar com o Código — "agora faça o site inteiro" — tinha de
// passar tudo pelo dono de novo, repetindo o contexto a cada pedido.
//
// O que este teste guarda é o par: a conversa existe, e o id dela viaja no
// envelope de delegação (é ele que faz a linha aparecer na barra na hora certa).
func TestDelegateAbreAConversaDoBot(t *testing.T) {
	dataStore, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("abrir o store: %v", err)
	}
	defer dataStore.Close()

	const sessionID = "s-conversa-do-bot"
	if _, err := dataStore.CreateSession(store.SessionMeta{
		ID: sessionID, Title: "cobrança", Specialist: "code", Model: "m1",
	}); err != nil {
		t.Fatalf("criar sessão: %v", err)
	}

	server := scriptedProvider(t, []string{"cobranca(id, valor, vencimento)"}, nil)
	defer server.Close()

	supervisor := New(Deps{
		Store:  dataStore,
		Bus:    eventbus.New(dataStore),
		Models: scriptedRouter(server.URL),
		Gate:   permissions.NewGate(permissions.DefaultPolicy()),
		Tools:  NewRegistry(),
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	budget := &delegationBudget{}
	supervisor.delegate(ctx, sessionID, "t1",
		specialist.GetOrDefault("code"), goodRequest(), budget, firstDelegationDepth)

	filhoID := store.ChildSessionID(sessionID, "data")

	// 1. O id da filha viaja nos DOIS envelopes — o que abre e o que fecha.
	// A tela lê o primeiro para desenhar a linha; o segundo não pode "perder" o
	// vínculo, senão o mesmo acontecimento chega contando duas histórias.
	delegations := delegateEnvelopes(t, dataStore, sessionID)
	if len(delegations) != 2 {
		t.Fatalf("esperava 2 envelopes de delegação, obtive %d: %+v", len(delegations), delegations)
	}
	for i, payload := range delegations {
		if payload.Session != filhoID {
			t.Errorf("envelope %d aponta para a conversa %q, esperava %q", i, payload.Session, filhoID)
		}
	}

	// 2. A conversa existe, e é do BOT: quem abrir e escrever fala com ELE.
	meta, err := dataStore.GetSession(filhoID)
	if err != nil {
		t.Fatalf("a conversa do bot não foi criada: %v", err)
	}
	if meta.ParentID != sessionID {
		t.Errorf("a filha aponta para %q como origem, esperava %q", meta.ParentID, sessionID)
	}
	if meta.BotID != "data" || meta.Specialist != "data" {
		t.Errorf("dono da conversa: bot=%q especialista=%q, esperava \"data\" nos dois", meta.BotID, meta.Specialist)
	}

	// 3. Ela é CONTINUÁVEL: tem o pedido e a resposta, nessa ordem. Só o
	// resultado, sem o pedido, seria uma conversa que começa no meio.
	falas := mensagensDe(t, dataStore, filhoID)
	if len(falas) != 2 {
		t.Fatalf("a conversa do bot tem %d fala(s), esperava o par pedido/resposta: %+v", len(falas), falas)
	}
	if falas[0].Role != "user" || falas[0].Text != goodRequest().Goal {
		t.Errorf("a primeira fala tinha de ser o pedido, como fala do usuário: %+v", falas[0])
	}
	if falas[1].Role != "assistant" || !strings.Contains(falas[1].Text, "cobranca(id, valor, vencimento)") {
		t.Errorf("a segunda fala tinha de ser a resposta do bot: %+v", falas[1])
	}

	// 4. ESPELHO, e não mudança de lugar: a conversa do dono continua mostrando
	// a delegação inteira — é ela que a pessoa está lendo.
	if !strings.Contains(delegations[1].Result, "cobranca(id, valor, vencimento)") {
		t.Errorf("o resultado sumiu da conversa de quem delegou: %q", delegations[1].Result)
	}

	// 5. O pedido vira o SUBTÍTULO da linha: o título diz de quem a conversa é,
	// o LastGoal diz o que ele está fazendo — sem isso, duas filhas do mesmo
	// bot em conversas diferentes são linhas idênticas na barra.
	if meta, err := dataStore.GetSession(filhoID); err != nil || meta.LastGoal != goodRequest().Goal {
		t.Errorf("o subtítulo da filha devia ser o pedido: %q (%v)", meta.LastGoal, err)
	}
}

// A segunda chamada ao mesmo bot é uma CONTINUAÇÃO: o sub-turno dele desce com
// o que ele mesmo já conversou nesta conversa. Sem essa memória, "agora faça o
// site inteiro" chegava a um bot que não lembrava nem do próprio HTML.
func TestDelegateMessagesCarregamAMemoriaDoBot(t *testing.T) {
	dataStore, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("abrir o store: %v", err)
	}
	defer dataStore.Close()

	const sessionID = "s-continuacao"
	if _, err := dataStore.CreateSession(store.SessionMeta{ID: sessionID, Title: "site"}); err != nil {
		t.Fatalf("criar sessão: %v", err)
	}

	supervisor := New(Deps{
		Store: dataStore,
		Bus:   eventbus.New(dataStore),
		Gate:  permissions.NewGate(permissions.DefaultPolicy()),
		Tools: NewRegistry(),
	})

	// Primeira chamada já aconteceu: a conversa do bot tem o par pedido/resposta.
	filho := supervisor.mirrorDelegation(sessionID, specialist.GetOrDefault("data"), "modele a tabela de clientes")
	if filho == "" {
		t.Fatal("o espelho não abriu a conversa do bot")
	}
	if err := supervisor.emit(filho, "t0", protocol.KindMessage,
		protocol.Actor{Kind: protocol.ActorSpecialist, ID: "data", Specialist: "data"},
		protocol.Message{Role: "assistant", Text: "cliente(id, nome, email)"}); err != nil {
		t.Fatalf("gravar a resposta anterior: %v", err)
	}

	// Segunda chamada: a memória é lida ANTES de o espelho gravar o pedido novo.
	memoria := supervisor.childHistory(sessionID, "data")
	_ = supervisor.mirrorDelegation(sessionID, specialist.GetOrDefault("data"), "agora a tabela de pedidos")

	messages := supervisor.delegateMessages(
		specialist.GetOrDefault("code"), specialist.GetOrDefault("data"),
		delegateRequest{Specialist: "data", Goal: "agora a tabela de pedidos"},
		firstDelegationDepth, memoria)

	texto := ""
	pedidoNovo := 0
	for _, message := range messages {
		texto += message.Role + ": " + message.Content + "\n"
		if strings.Contains(message.Content, "agora a tabela de pedidos") {
			pedidoNovo++
		}
	}
	if !strings.Contains(texto, "modele a tabela de clientes") {
		t.Errorf("o pedido anterior não desceu ao sub-turno:\n%s", texto)
	}
	if !strings.Contains(texto, "cliente(id, nome, email)") {
		t.Errorf("a resposta anterior do próprio bot não desceu ao sub-turno:\n%s", texto)
	}
	// O objetivo atual aparece UMA vez (no briefing) — a memória foi lida antes
	// de o espelho gravá-lo, senão ele chegaria em dobro.
	if pedidoNovo != 1 {
		t.Errorf("o objetivo atual aparece %d vezes no sub-turno, esperava 1:\n%s", pedidoNovo, texto)
	}
}

// A delegação volta ao histórico da MÃE: sem a dobra de KindDelegate, o turno
// seguinte via só a síntese final do dono — nem o fato "deleguei X ao bot Y",
// nem o resultado bruto — e o dono redelegava a mesma coisa.
func TestHistoryDobraADelegacao(t *testing.T) {
	dataStore, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("abrir o store: %v", err)
	}
	defer dataStore.Close()

	const sessionID = "s-historia"
	if _, err := dataStore.CreateSession(store.SessionMeta{ID: sessionID, Title: "site"}); err != nil {
		t.Fatalf("criar sessão: %v", err)
	}

	supervisor := New(Deps{
		Store: dataStore,
		Bus:   eventbus.New(dataStore),
		Gate:  permissions.NewGate(permissions.DefaultPolicy()),
		Tools: NewRegistry(),
	})
	actor := protocol.Actor{Kind: protocol.ActorSpecialist, ID: "chat", Specialist: "chat"}

	// O par abre/fecha, como o delegate() grava.
	_ = supervisor.emit(sessionID, "t1", protocol.KindDelegate, actor,
		protocol.Delegate{From: "chat", To: "code", Goal: "faça o html", Depth: 1})
	_ = supervisor.emit(sessionID, "t1", protocol.KindDelegate, actor,
		protocol.Delegate{From: "chat", To: "code", Goal: "faça o html", Depth: 1,
			Done: true, Result: "<html>pronto</html>"})

	history, err := supervisor.history(sessionID)
	if err != nil {
		t.Fatalf("ler o histórico: %v", err)
	}
	texto := ""
	for _, message := range history {
		texto += message.Role + ": " + message.Content + "\n"
	}
	if !strings.Contains(texto, "Deleguei ao especialista code: faça o html") {
		t.Errorf("o fato da delegação não voltou ao histórico:\n%s", texto)
	}
	if !strings.Contains(texto, "<html>pronto</html>") {
		t.Errorf("o resultado do delegado não voltou ao histórico:\n%s", texto)
	}
}

// Delegação que NÃO deu certo não abre a conversa do bot com um erro que não é
// dele. O espelho registra trabalho; recusa e falha ficam na conversa do dono,
// que é onde a pessoa está lendo.
func TestDelegateNaoEspelhaFracasso(t *testing.T) {
	dataStore, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("abrir o store: %v", err)
	}
	defer dataStore.Close()

	const sessionID = "s-delegacao-falha"
	if _, err := dataStore.CreateSession(store.SessionMeta{
		ID: sessionID, Title: "cobrança", Specialist: "code", Model: "m1",
	}); err != nil {
		t.Fatalf("criar sessão: %v", err)
	}

	server := scriptedProvider(t, []string{"resposta que não vai sair"}, nil)
	defer server.Close()

	supervisor := New(Deps{
		Store:  dataStore,
		Bus:    eventbus.New(dataStore),
		Models: scriptedRouter(server.URL),
		Gate:   permissions.NewGate(permissions.DefaultPolicy()),
		Tools:  NewRegistry(),
	})

	// Contexto já cancelado: o delegado nem chega a responder.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	budget := &delegationBudget{}
	back := supervisor.delegate(ctx, sessionID, "t1",
		specialist.GetOrDefault("code"), goodRequest(), budget, firstDelegationDepth)
	if !strings.Contains(back, "NÃO DEU CERTO") {
		t.Fatalf("o cenário exige uma delegação que falha, e ela passou: %q", back)
	}

	// A conversa do bot pode até existir (o pedido foi feito a ele), mas a
	// resposta que nunca veio não pode estar lá — e a falha TEM de estar, como
	// aviso do sistema: pergunta sem resposta e sem marcador parece que o bot
	// ignorou a pessoa, e falha é estado de primeira classe.
	filhoID := store.ChildSessionID(sessionID, "data")
	registroDeFalha := false
	for _, fala := range mensagensDe(t, dataStore, filhoID) {
		if fala.Role == "assistant" {
			t.Errorf("a conversa do bot guardou uma resposta que não existiu: %+v", fala)
		}
		if fala.Role == "system" && strings.Contains(fala.Text, "A tarefa não terminou") {
			registroDeFalha = true
		}
	}
	if !registroDeFalha {
		t.Error("a falha não foi registrada na conversa do bot — ficou pergunta sem resposta")
	}
}
