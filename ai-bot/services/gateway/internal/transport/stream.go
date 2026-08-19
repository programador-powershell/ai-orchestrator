// O canal ao vivo: um WebSocket por sessão.
//
// A autenticação é NO PRIMEIRO FRAME, nunca na URL. Token em query string entra
// em log de proxy, em histórico do navegador e em mensagem de erro — e o
// WebSocket não passa por CORS, então sem token qualquer página aberta na
// estação abriria este socket e mandaria o AI-BOT executar ferramenta.
package transport

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"aibot/gateway/internal/protocol"
	"aibot/gateway/internal/specialist"
	"aibot/gateway/internal/store"
)

const (
	// helloDeadline é quanto o servidor espera pelo `hello`. Conexão que abre e
	// fica calada é sonda ou cliente quebrado; nos dois casos, fechar é o certo.
	helloDeadline = 15 * time.Second
	// pingInterval mantém a conexão viva através de proxies que matam socket
	// ocioso — e detecta o cliente que sumiu sem fechar.
	pingInterval = 25 * time.Second
	// writeDeadline evita que um cliente que parou de ler prenda a goroutine.
	writeDeadline = 20 * time.Second
	// readySessionLimit é quantas conversas vão na lista do `ready`. A barra
	// lateral só mostra as recentes, e mandar o histórico inteiro atrasaria o
	// primeiro quadro da janela em nome de linhas que ninguém rolou até ver.
	readySessionLimit = 50
)

func (s *Server) stream(w http.ResponseWriter, r *http.Request) {
	connection, err := Upgrade(w, r, s.cfg.AllowOrigins)
	if err != nil {
		s.log.Warn("upgrade recusado", "erro", err, "remoto", r.RemoteAddr)
		// Upgrade que falha não escreve nada na resposta — o contrato dele é que
		// o ResponseWriter continua nosso. Sem esta linha o cliente receberia um
		// 200 vazio e não saberia que o handshake foi recusado. O motivo NÃO vai
		// junto: dizer qual checagem reprovou é ajuda para quem está sondando.
		s.fail(w, http.StatusBadRequest, "upgrade", "handshake de websocket inválido")
		return
	}
	defer connection.Close(1000, "encerrado")

	// 1. hello — autenticação e escolha da sessão.
	_ = connection.SetReadDeadline(time.Now().Add(helloDeadline))
	opcode, payload, err := connection.ReadMessage()
	if err != nil || opcode != OpText {
		_ = connection.Close(1002, "esperava hello")
		return
	}

	var opening protocol.Envelope
	if err := json.Unmarshal(payload, &opening); err != nil || opening.Kind != protocol.KindHello {
		_ = connection.Close(1002, "primeiro frame precisa ser hello")
		return
	}
	var hello protocol.Hello
	if err := opening.Decode(&hello); err != nil {
		_ = connection.Close(1002, "hello inválido")
		return
	}
	if !constantTimeEqual(hello.Token, s.cfg.Token) {
		// Ao CLIENTE não se diz qual parte falhou: mensagem detalhada é ajuda
		// para quem está adivinhando. Mas ao LOG do servidor se diz, porque o
		// silêncio aqui já custou uma tarde de diagnóstico — a janela dizia
		// "gateway fora do ar" e o gateway não registrava nada, então não havia
		// como saber que a recusa era de token. O comprimento não é o segredo:
		// ele separa "token vazio" (o cliente não conseguiu lê-lo) de "token
		// errado" (leu o de outra instalação), que são defeitos diferentes.
		s.log.Warn("handshake recusado: token não confere",
			"origem", r.Header.Get("Origin"),
			"tamanho_recebido", len(hello.Token),
			"tamanho_esperado", len(s.cfg.Token))
		_ = connection.Close(1008, "não autorizado")
		return
	}

	sessionID, meta, err := s.resolveSession(hello.SessionHint, hello.Specialist)
	if err != nil {
		_ = connection.Close(1011, "não foi possível abrir a sessão")
		s.log.Error("abrir sessão", "erro", err)
		return
	}

	// 2. Assina ANTES do replay. Assinar depois abre uma janela em que um evento
	// nasce entre a última linha lida do log e a assinatura — e some para sempre.
	subscription := s.bus.Subscribe(sessionID)
	// Numa closure porque a troca de sessão SUBSTITUI a assinatura: o defer
	// direto congelaria a primeira e vazaria a vigente no encerramento.
	defer func() { subscription.Close() }()

	// 3. ready — tudo o que a tela precisa para se montar sem uma segunda chamada.
	lastSeq, err := s.sendReady(r.Context(), connection, sessionID, meta)
	if err != nil {
		return
	}

	// 4. replay a partir do cursor do cliente.
	delivered := hello.ResumeFrom
	if hello.LiveOnly {
		// Quem pediu `liveOnly` descarta histórico (é a ponte de ferramentas do
		// aplicativo nativo). O cursor começa no MESMO lastSeq que acabou de ir no
		// `ready`: tudo até ali conta como entregue, e o laço ao vivo abaixo já
		// descarta `Seq <= delivered`. Assim nada anterior trafega e, mesmo assim,
		// nada nasce nesta janela e some — a assinatura do passo 2 é anterior à
		// leitura de lastSeq.
		delivered = lastSeq
	} else {
		if delivered, err = s.replay(connection, sessionID, delivered); err != nil {
			return
		}
	}

	// 5. leitura e escrita em goroutines separadas. O Conn tem trava de escrita
	// própria, então as duas podem escrever sem corromper o fluxo.
	//
	// `switches` é a TROCA DE SESSÃO: o cliente manda um segundo `hello` na
	// mesma conexão (nova conversa, abrir outra na barra) e o leitor o entrega
	// aqui, porque quem assina o barramento e faz replay é o escritor. O leitor
	// então ESPERA o `ack` antes de ler o próximo frame — o prompt que vier
	// depois do hello é da sessão nova, e processá-lo antes da troca o gravaria
	// na conversa errada. Foi exatamente o defeito que isto conserta: o segundo
	// hello era IGNORADO em silêncio, "nova conversa" só limpava a tela, e todo
	// pedido seguinte caía na sessão antiga — cujo modo gravado respondia sempre
	// com o mesmo especialista.
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	switches := make(chan protocol.Hello, 1)
	acks := make(chan string, 1)
	go s.readLoop(ctx, cancel, connection, sessionID, switches, acks)

	ticker := time.NewTicker(pingInterval)
	defer ticker.Stop()

	for {
		select {
		case hello := <-switches:
			// O hello de troca REAPRESENTA o token: um frame forjado dentro de
			// uma conexão autenticada não pode escolher a sessão de ninguém.
			if !constantTimeEqual(hello.Token, s.cfg.Token) {
				s.log.Warn("troca de sessão recusada: token não confere",
					"origem", r.Header.Get("Origin"),
					"tamanho_recebido", len(hello.Token),
					"tamanho_esperado", len(s.cfg.Token))
				_ = connection.Close(1008, "não autorizado")
				return
			}
			next, nextMeta, err := s.resolveSession(hello.SessionHint, hello.Specialist)
			if err != nil {
				_ = connection.Close(1011, "não foi possível abrir a sessão")
				s.log.Error("abrir sessão na troca", "erro", err)
				return
			}
			// Mesma ordem do começo: assina ANTES de ler o lastSeq que vai no
			// ready — invertido, um evento nascido no meio some para sempre.
			subscription.Close()
			subscription = s.bus.Subscribe(next)
			sessionID = next
			lastSeq, err := s.sendReady(ctx, connection, sessionID, nextMeta)
			if err != nil {
				return
			}
			delivered = hello.ResumeFrom
			if hello.LiveOnly {
				delivered = lastSeq
			} else {
				if delivered, err = s.replay(connection, sessionID, delivered); err != nil {
					return
				}
			}
			// Só agora o leitor volta a ler: tudo o que chegar depois deste ack
			// é tratado como sendo da sessão nova.
			acks <- sessionID

		case envelope, open := <-subscription.Events:
			if !open {
				return
			}
			// O replay já entregou tudo até `delivered`; reentregar duplicaria a
			// mensagem na tela de quem reconectou no meio do turno.
			if envelope.Seq != 0 && envelope.Seq <= delivered {
				continue
			}
			if envelope.Seq != 0 {
				delivered = envelope.Seq
			}
			_ = connection.SetWriteDeadline(time.Now().Add(writeDeadline))
			if err := connection.WriteJSON(envelope); err != nil {
				return
			}

		case <-subscription.Lagged:
			// O cliente ficou para trás e foi desconectado do barramento. Ele
			// reconecta e refaz o replay — por isso o log é numerado.
			_ = connection.Close(1013, "cliente atrasado — reconecte pedindo replay")
			return

		case <-ticker.C:
			_ = connection.SetWriteDeadline(time.Now().Add(writeDeadline))
			if err := connection.Ping(); err != nil {
				return
			}

		case <-ctx.Done():
			return
		}
	}
}

// readLoop processa o que o cliente manda.
//
// O `hello` de troca não é tratado aqui: ele vai pelo canal ao escritor (que é
// quem assina o barramento e faz replay), e a leitura PARA até o ack. É essa
// parada que garante a ordem — o frame seguinte ao hello já pertence à sessão
// nova.
func (s *Server) readLoop(
	ctx context.Context,
	cancel context.CancelFunc,
	connection *Conn,
	sessionID string,
	switches chan<- protocol.Hello,
	acks <-chan string,
) {
	defer cancel()
	for {
		if ctx.Err() != nil {
			return
		}
		// Sem prazo de leitura no laço normal: uma conversa pode ficar minutos
		// sem nada vindo do cliente, e o ping é quem detecta a queda.
		_ = connection.SetReadDeadline(time.Time{})
		opcode, payload, err := connection.ReadMessage()
		if err != nil {
			if !errors.Is(err, io.EOF) {
				s.log.Debug("leitura encerrada", "sessao", sessionID, "erro", err)
			}
			return
		}
		if opcode != OpText {
			continue
		}

		var envelope protocol.Envelope
		if err := json.Unmarshal(payload, &envelope); err != nil {
			continue
		}

		if envelope.Kind == protocol.KindHello {
			var hello protocol.Hello
			if err := envelope.Decode(&hello); err != nil {
				continue
			}
			select {
			case switches <- hello:
			case <-ctx.Done():
				return
			}
			select {
			case next := <-acks:
				sessionID = next
			case <-ctx.Done():
				// A troca falhou (token, sessão ilegível): o escritor fechou a
				// conexão e cancelou o contexto — não há mais o que ler.
				return
			}
			continue
		}

		s.handleInbound(ctx, sessionID, envelope)
	}
}

// sendReady manda o `ready` da sessão — tudo o que a tela precisa para se
// montar sem uma segunda chamada — e devolve o lastSeq que foi nele.
func (s *Server) sendReady(ctx context.Context, connection *Conn, sessionID string, meta store.SessionMeta) (uint64, error) {
	lastSeq, _ := s.store.LastSeq(sessionID)
	activeEnvironment, environments := s.environmentState(ctx, sessionID)
	_ = connection.SetWriteDeadline(time.Now().Add(writeDeadline))
	return lastSeq, writeEnvelope(connection, sessionID, protocol.KindReady, protocol.Ready{
		Session:          sessionID,
		Seq:              lastSeq,
		Specialists:      specialistIDs(),
		Models:           s.models.Catalog(),
		ActiveSpecialist: meta.Specialist,
		ActiveModel:      meta.Model,
		Environment:      activeEnvironment,
		Environments:     environments,
		Sessions:         s.sessionSummaries(),
	})
}

// replay entrega o histórico a partir do cursor (exclusivo) e devolve o último
// Seq entregue. Erro de LEITURA encerra o replay e preserva a conexão — o log
// ilegível não pode derrubar a sessão que a pessoa está abrindo; erro de
// ESCRITA volta para o chamador, porque sem socket não há conexão a preservar.
func (s *Server) replay(connection *Conn, sessionID string, from uint64) (uint64, error) {
	delivered := from
	for {
		batch, err := s.store.Since(sessionID, delivered, store.MaxEventBatch)
		if err != nil || len(batch) == 0 {
			return delivered, nil
		}
		for _, envelope := range batch {
			_ = connection.SetWriteDeadline(time.Now().Add(writeDeadline))
			if err := connection.WriteJSON(envelope); err != nil {
				return delivered, err
			}
			delivered = envelope.Seq
		}
		if len(batch) < store.MaxEventBatch {
			return delivered, nil
		}
	}
}

// handleInbound trata cada verbo que o cliente pode emitir.
//
// A lista é curta de propósito: o cliente PEDE (prompt, decisão, resposta) e o
// gateway decide. Um cliente que pudesse emitir `route` ou `tool.result` de
// especialista estaria escrevendo no histórico como se fosse o supervisor.
func (s *Server) handleInbound(ctx context.Context, sessionID string, envelope protocol.Envelope) {
	switch envelope.Kind {
	case protocol.KindPrompt:
		var prompt protocol.Prompt
		if err := envelope.Decode(&prompt); err != nil {
			return
		}
		go func() {
			turnCtx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
			defer cancel()
			if err := s.sup.Prompt(turnCtx, sessionID, prompt); err != nil {
				s.log.Error("turno falhou", "sessao", sessionID, "erro", err)
				// E também PARA A PESSOA: as saídas antecipadas de runTurn devolvem
				// erro sem ter emitido envelope nenhum, e um log de servidor não
				// fecha o `busy` de quem está olhando a tela.
				s.sup.ReportTurnFailure(sessionID, err)
			}
		}()

	case protocol.KindApprovalDecision:
		var decision protocol.ApprovalDecision
		if err := envelope.Decode(&decision); err != nil {
			return
		}
		if err := s.sup.Decide(decision); err != nil {
			s.log.Debug("aprovação sem pendência", "erro", err)
		}

	case protocol.KindGate:
		var gate protocol.Gate
		if err := envelope.Decode(&gate); err != nil {
			return
		}
		if err := s.sup.DecideGate(gate); err != nil {
			s.log.Debug("portão sem pendência", "erro", err)
		}

	case protocol.KindReply:
		// Resposta humana de um `ask` bloqueante (clarificação de rota,
		// aprovação de plano). Ela RETOMA um turno inteiro, então segue o mesmo
		// caminho assíncrono do prompt — a leitura do socket não pode ficar
		// presa atrás de um turno de modelo.
		var reply protocol.Reply
		if err := envelope.Decode(&reply); err != nil {
			return
		}
		go func() {
			turnCtx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
			defer cancel()
			if err := s.sup.Reply(turnCtx, sessionID, reply); err != nil {
				// Sem pendência não é falha do gateway: é um reply atrasado de
				// uma pergunta que a próxima mensagem já matou.
				s.log.Debug("reply sem pendência", "sessao", sessionID, "erro", err)
			}
		}()

	case protocol.KindToolResult:
		// Resultado de ferramenta de MÁQUINA, vindo do aplicativo nativo.
		var result protocol.ToolResult
		if err := envelope.Decode(&result); err != nil {
			return
		}
		s.mu.Lock()
		channel := s.hostCalls[result.CallID]
		s.mu.Unlock()
		if channel == nil {
			return
		}
		failure := result.Error
		if !result.OK && failure == "" {
			failure = "a ferramenta falhou sem detalhe"
		}
		select {
		case channel <- hostResult{output: result.Output, err: failure}:
		default:
		}

	case protocol.KindDone:
		// O cliente usa `done` para PEDIR o cancelamento do turno em andamento —
		// é o botão "Parar". Cancelar não é falha: o texto já entregue fica.
		s.sup.Cancel(sessionID)

	default:
		_ = ctx
	}
}

/* --------------------------------- apoio --------------------------------- */

// environmentState devolve o ambiente ativo da sessão e o catálogo com a
// disponibilidade JÁ medida.
//
// A medição roda aqui, no handshake, e não na primeira vez que a pessoa abre o
// seletor: abrir uma lista e ver as opções acenderem uma a uma parece defeito.
// O custo é contido pelo cache curto do registro — sem ele, cada janela
// dispararia um `sbx version` e um `wsl -l -q` antes do primeiro quadro.
func (s *Server) environmentState(
	ctx context.Context,
	sessionID string,
) (protocol.Environment, []protocol.EnvironmentInfo) {
	if s.environments == nil {
		// Gateway montado sem ambientes: a tela recebe lista vazia e some com o
		// seletor, em vez de oferecer opções que este processo não tem.
		return "", nil
	}
	// Active ANTES do Describe, e com o mesmo ctx: é ele que mede o padrão do
	// gateway (a VPS configurada e de pé vira o ambiente de quem nunca
	// escolheu), e a medição fica no cache para o Describe logo atrás.
	return s.environments.Active(ctx, sessionID), s.environments.Describe(ctx)
}

// sessionSummaries monta a lista de conversas que vai no `ready`.
//
// Falha do store devolve lista VAZIA, nunca erro: a barra lateral é acessório e
// a sessão que a pessoa está abrindo funciona sem ela. Derrubar o handshake
// porque um meta.json ficou ilegível trocaria uma lista incompleta por um app
// que não abre.
func (s *Server) sessionSummaries() []protocol.SessionSummary {
	metas, err := s.store.ListSessions()
	if err != nil {
		s.log.Warn("listar sessões para o ready", "erro", err)
		return []protocol.SessionSummary{}
	}
	// ListSessions já vem ordenado por UpdatedAt decrescente, então cortar o
	// começo é ficar com as mais recentes.
	if len(metas) > readySessionLimit {
		metas = metas[:readySessionLimit]
	}
	out := make([]protocol.SessionSummary, 0, len(metas))
	for _, meta := range metas {
		out = append(out, protocol.SessionSummary{
			ID:         meta.ID,
			Title:      meta.Title,
			Specialist: meta.Specialist,
			Model:      meta.Model,
			UpdatedAt:  meta.UpdatedAt,
			Turns:      meta.Turns,
			BotID:      meta.BotID,
			ParentID:   meta.ParentID,
			LastGoal:   meta.LastGoal,
		})
	}
	return out
}

// resolveSession abre a sessão pedida ou cria uma nova.
func (s *Server) resolveSession(hint, owner string) (string, store.SessionMeta, error) {
	if hint != "" {
		if meta, err := s.store.GetSession(hint); err == nil {
			// Sessão existente IGNORA o dono pedido: o modo gravado é dela, e
			// deixar um hello trocá-lo reescreveria com quem a pessoa conversa.
			return meta.ID, meta, nil
		} else if !errors.Is(err, store.ErrNotFound) {
			return "", store.SessionMeta{}, err
		}
	}
	// O dono só vale na CRIAÇÃO, e só se for um especialista de verdade: é o
	// "novo schema" da tela de Dados — a conversa nasce do bot, a pessoa fica
	// na tela, e o primeiro pedido vai direto a ele em vez de descer a cascata.
	if !specialist.Exists(owner) {
		owner = ""
	}
	meta, err := s.store.CreateSession(store.SessionMeta{ID: s.newID("s"), Specialist: owner})
	if err != nil {
		return "", store.SessionMeta{}, err
	}
	return meta.ID, meta, nil
}

func writeEnvelope(connection *Conn, sessionID string, kind protocol.Kind, payload any) error {
	envelope := protocol.Envelope{
		V:       protocol.Version,
		TS:      time.Now().UTC(),
		Session: sessionID,
		Kind:    kind,
		From:    protocol.Actor{Kind: protocol.ActorSystem},
	}
	if err := envelope.SetPayload(payload); err != nil {
		return err
	}
	return connection.WriteJSON(envelope)
}
