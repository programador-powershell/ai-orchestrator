// Package eventbus entrega o mesmo envelope a todo mundo que está olhando a
// sessão — a janela principal, o laboratório de avatares, um `aibot watch` no
// terminal, um agente externo conectado por ACP.
//
// A ordem das duas metades importa e não é intercambiável: PRIMEIRO grava no
// log durável (que atribui o `seq`), DEPOIS distribui. Distribuir antes de
// gravar entrega ao cliente um evento que pode não existir depois de uma queda,
// e o cliente que reconecta pedindo replay a partir dele nunca recebe resposta.
//
// Assinante lento é DESCONECTADO, não esperado. Segurar a produção porque uma
// janela minimizada parou de ler faz o modelo travar no meio da resposta por
// causa de quem não está olhando. Quem cai recebe `lagged` e se recupera pelo
// replay, que é justamente para isso que o log é numerado.
package eventbus

import (
	"sync"
	"sync/atomic"

	"aibot/gateway/internal/protocol"
	"aibot/gateway/internal/store"
)

// bufferSize é a folga de cada assinante. Grande o bastante para uma rajada de
// deltas de streaming, pequeno o bastante para a memória não crescer sem limite
// quando um cliente trava.
const bufferSize = 256

// Subscription é a assinatura de uma sessão.
type Subscription struct {
	// Events entrega os envelopes em ordem de `seq`.
	Events <-chan protocol.Envelope
	// Lagged fecha quando o assinante ficou para trás e foi desconectado. Quem
	// escuta reage refazendo o replay a partir do último seq que processou.
	Lagged <-chan struct{}

	id      uint64
	session string
	bus     *Bus
}

// Close cancela a assinatura. Idempotente.
func (s *Subscription) Close() {
	if s == nil || s.bus == nil {
		return
	}
	s.bus.unsubscribe(s.session, s.id)
	s.bus = nil
}

type subscriber struct {
	events chan protocol.Envelope
	lagged chan struct{}
	once   sync.Once
}

// drop desconecta o assinante uma única vez.
func (s *subscriber) drop() {
	s.once.Do(func() {
		close(s.lagged)
		close(s.events)
	})
}

// Bus é o distribuidor.
type Bus struct {
	store *store.Store

	mu     sync.RWMutex
	topics map[string]map[uint64]*subscriber
	nextID atomic.Uint64
}

// New monta o barramento sobre um log durável.
func New(durable *store.Store) *Bus {
	return &Bus{store: durable, topics: make(map[string]map[uint64]*subscriber)}
}

// Publish grava e distribui. Devolve o `seq` atribuído.
func (b *Bus) Publish(sessionID string, envelope *protocol.Envelope) (uint64, error) {
	seq, err := b.store.Append(sessionID, envelope)
	if err != nil {
		return 0, err
	}
	b.fanout(sessionID, *envelope)
	return seq, nil
}

// PublishEphemeral distribui SEM gravar.
//
// Existe para um caso só: sinal que perde o sentido depois de entregue e que
// não pertence ao histórico — o pulso de "digitando", a barra de progresso de
// um download. Gravá-los encheria o log de ruído que o replay reencenaria, e
// ver a barra de progresso de ontem reaparecer ao abrir a conversa é defeito.
func (b *Bus) PublishEphemeral(sessionID string, envelope protocol.Envelope) {
	b.fanout(sessionID, envelope)
}

// Broadcast entrega um envelope a TODAS as sessões com alguém olhando, sem
// gravar em nenhuma.
//
// Existe para o aviso que não pertence a conversa nenhuma: "há uma versão nova
// pronta" é do APLICATIVO, não do assunto que a pessoa está tratando. Publicar
// numa sessão escolhida a esmo faria o aviso aparecer só para quem estivesse
// naquela conversa — e sumir ao trocar de conversa.
//
// `build` monta o envelope de CADA sessão, e recebe o id porque parte do estado
// é por sessão. O caso concreto é o `busy`: o cliente aplica `state.busy` como
// veio, então um envelope com `busy:false` mandado para uma sessão que está no
// meio de um turno apagaria o indicador e liberaria o campo de texto com o
// modelo ainda respondendo. Quem monta o envelope é quem sabe disso.
//
// Devolver `false` pula a sessão — é a saída para o envelope que não pôde ser
// montado (falha ao serializar o payload, por exemplo).
//
// Efêmero pelo mesmo motivo do `state` de ambiente: o replay de um aviso de
// ontem reencenaria uma atualização que já foi aplicada.
func (b *Bus) Broadcast(build func(sessionID string) (protocol.Envelope, bool)) {
	if build == nil {
		return
	}
	b.mu.RLock()
	sessions := make([]string, 0, len(b.topics))
	for sessionID := range b.topics {
		sessions = append(sessions, sessionID)
	}
	b.mu.RUnlock()

	// A lista de sessões é tirada sob a trava e o fanout acontece FORA dela:
	// fanout pega a trava de escrita quando encontra assinante lento, e
	// chamá-lo com a de leitura na mão travaria o processo inteiro.
	for _, sessionID := range sessions {
		envelope, ok := build(sessionID)
		if !ok {
			continue
		}
		envelope.Session = sessionID
		b.fanout(sessionID, envelope)
	}
}

func (b *Bus) fanout(sessionID string, envelope protocol.Envelope) {
	// O envio acontece SOB a trava de leitura, sem cópia da lista — e isso é
	// CORREÇÃO, não economia: quem fecha um canal (drop) só roda depois de
	// remover o assinante sob a trava de ESCRITA, então enquanto a leitura está
	// na mão nenhum canal presente no mapa pode ser fechado. A versão anterior
	// soltava a trava antes de enviar, e um Close() concorrente (troca de
	// sessão, aba fechada) fechava o canal no meio do envio — send em canal
	// fechado é pânico, e o processo INTEIRO caía por causa de um clique.
	// Segurar a trava aqui não prende ninguém: o envio é não-bloqueante.
	// De carona, o snapshot por evento (uma alocação por delta) desaparece.
	b.mu.RLock()
	var slow []*subscriber
	for _, target := range b.topics[sessionID] {
		select {
		case target.events <- envelope:
		default:
			slow = append(slow, target)
		}
	}
	b.mu.RUnlock()

	if len(slow) == 0 {
		return
	}

	// Remoção sob trava de escrita, e só depois o drop: fechar o canal com a
	// trava de leitura segurada deixaria outro fanout escrevendo em canal
	// fechado — pânico, e o processo inteiro cai por causa de um cliente lento.
	b.mu.Lock()
	topic := b.topics[sessionID]
	for _, target := range slow {
		for id, candidate := range topic {
			if candidate == target {
				delete(topic, id)
				break
			}
		}
	}
	if len(topic) == 0 {
		delete(b.topics, sessionID)
	}
	b.mu.Unlock()

	for _, target := range slow {
		target.drop()
	}
}

// Subscribe abre uma assinatura da sessão.
func (b *Bus) Subscribe(sessionID string) *Subscription {
	entry := &subscriber{
		events: make(chan protocol.Envelope, bufferSize),
		lagged: make(chan struct{}),
	}
	id := b.nextID.Add(1)

	b.mu.Lock()
	topic := b.topics[sessionID]
	if topic == nil {
		topic = make(map[uint64]*subscriber)
		b.topics[sessionID] = topic
	}
	topic[id] = entry
	b.mu.Unlock()

	return &Subscription{
		Events:  entry.events,
		Lagged:  entry.lagged,
		id:      id,
		session: sessionID,
		bus:     b,
	}
}

func (b *Bus) unsubscribe(sessionID string, id uint64) {
	b.mu.Lock()
	topic := b.topics[sessionID]
	entry, ok := topic[id]
	if ok {
		delete(topic, id)
		if len(topic) == 0 {
			delete(b.topics, sessionID)
		}
	}
	b.mu.Unlock()

	if ok {
		// O drop DEPOIS da remoção sob a trava de escrita é o invariante que o
		// fanout inteiro apoia: ele envia segurando a trava de leitura, contando
		// que nenhum canal ainda presente no mapa possa ser fechado. Fechar aqui
		// dentro da trava (ou antes da remoção) reabriria o pânico de send em
		// canal fechado.
		entry.drop()
	}
}

// Listeners diz quantos assinantes a sessão tem. Usado pelo supervisor para
// decidir se vale continuar um turno que ninguém está vendo.
func (b *Bus) Listeners(sessionID string) int {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return len(b.topics[sessionID])
}
