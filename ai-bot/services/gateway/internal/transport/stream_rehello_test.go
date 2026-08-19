// O segundo `hello` na mesma conexão TROCA a sessão.
//
// O cliente sempre falou assim — "nova conversa" e "abrir outra conversa" são
// um novo hello na conexão de pé —, mas o gateway ignorava o frame em
// silêncio: o handleInbound não tinha case para ele. O resultado era o defeito
// relatado com cinco sintomas e uma causa: "nova sessão" só limpava a tela, e
// todo pedido seguinte caía na sessão ANTIGA, cujo modo gravado respondia
// sempre com o mesmo especialista ("independente do que peço ele sempre
// carrega no design").
//
// O cliente de teste daqui é RFC 6455 escrito à mão de propósito — foi um
// cliente de teste permissivo (que não conferia o Sec-WebSocket-Accept) que
// escondeu o bug do GUID por semanas. Este confere o handshake e mascara os
// frames como um navegador faria.
package transport

import (
	"bufio"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"aibot/gateway/internal/config"
	"aibot/gateway/internal/eventbus"
	"aibot/gateway/internal/fusion"
	"aibot/gateway/internal/modelrouter"
	"aibot/gateway/internal/permissions"
	"aibot/gateway/internal/protocol"
	"aibot/gateway/internal/store"
	"aibot/gateway/internal/supervisor"
)

const streamTestToken = "token-de-teste-do-stream"

/* ------------------------- cliente RFC 6455 mínimo ------------------------ */

type wsClient struct {
	conn   net.Conn
	reader *bufio.Reader
	t      *testing.T
}

func dialStream(t *testing.T, serverURL string) *wsClient {
	t.Helper()
	address := strings.TrimPrefix(serverURL, "http://")
	conn, err := net.Dial("tcp", address)
	if err != nil {
		t.Fatalf("conectar ao servidor de teste: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })

	key := base64.StdEncoding.EncodeToString([]byte("0123456789abcdef"))
	request := "GET /v1/stream HTTP/1.1\r\n" +
		"Host: " + address + "\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Key: " + key + "\r\n" +
		"Sec-WebSocket-Version: 13\r\n\r\n"
	if _, err := conn.Write([]byte(request)); err != nil {
		t.Fatalf("mandar o upgrade: %v", err)
	}

	reader := bufio.NewReader(conn)
	status, err := reader.ReadString('\n')
	if err != nil || !strings.Contains(status, "101") {
		t.Fatalf("esperava 101, veio %q (%v)", status, err)
	}
	accept := ""
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatalf("ler cabeçalhos do upgrade: %v", err)
		}
		if line == "\r\n" {
			break
		}
		if name, value, found := strings.Cut(line, ":"); found &&
			strings.EqualFold(strings.TrimSpace(name), "Sec-WebSocket-Accept") {
			accept = strings.TrimSpace(value)
		}
	}
	// A lição do bug do GUID: cliente que não confere o accept esconde defeito
	// de handshake. O navegador confere; aqui também.
	if want := acceptKey(key); accept != want {
		t.Fatalf("Sec-WebSocket-Accept errado: %q, esperava %q", accept, want)
	}
	return &wsClient{conn: conn, reader: reader, t: t}
}

// writeJSON manda um frame de texto MASCARADO (obrigatório para cliente).
func (c *wsClient) writeJSON(value any) {
	c.t.Helper()
	payload, err := json.Marshal(value)
	if err != nil {
		c.t.Fatalf("serializar frame: %v", err)
	}
	head := []byte{0x80 | OpText}
	switch {
	case len(payload) < 126:
		head = append(head, 0x80|byte(len(payload)))
	case len(payload) <= 0xFFFF:
		head = append(head, 0x80|126, byte(len(payload)>>8), byte(len(payload)))
	default:
		c.t.Fatalf("frame de teste grande demais: %d bytes", len(payload))
	}
	mask := [4]byte{0x11, 0x22, 0x33, 0x44}
	head = append(head, mask[:]...)
	masked := make([]byte, len(payload))
	for i, b := range payload {
		masked[i] = b ^ mask[i%4]
	}
	if _, err := c.conn.Write(append(head, masked...)); err != nil {
		c.t.Fatalf("mandar frame: %v", err)
	}
}

// readEnvelope devolve o próximo envelope de texto, pulando ping/pong.
func (c *wsClient) readEnvelope() (protocol.Envelope, error) {
	for {
		_ = c.conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		head := make([]byte, 2)
		if _, err := io.ReadFull(c.reader, head); err != nil {
			return protocol.Envelope{}, err
		}
		opcode := head[0] & 0x0F
		length := uint64(head[1] & 0x7F)
		switch length {
		case 126:
			extended := make([]byte, 2)
			if _, err := io.ReadFull(c.reader, extended); err != nil {
				return protocol.Envelope{}, err
			}
			length = uint64(binary.BigEndian.Uint16(extended))
		case 127:
			extended := make([]byte, 8)
			if _, err := io.ReadFull(c.reader, extended); err != nil {
				return protocol.Envelope{}, err
			}
			length = binary.BigEndian.Uint64(extended)
		}
		payload := make([]byte, length)
		if _, err := io.ReadFull(c.reader, payload); err != nil {
			return protocol.Envelope{}, err
		}
		switch opcode {
		case OpText:
			var envelope protocol.Envelope
			if err := json.Unmarshal(payload, &envelope); err != nil {
				return protocol.Envelope{}, err
			}
			return envelope, nil
		case 0x8:
			return protocol.Envelope{}, fmt.Errorf("servidor fechou: %q", payload)
		default:
			// ping/pong não interessam ao teste.
		}
	}
}

// waitReady consome envelopes até o próximo `ready` e devolve o payload.
func (c *wsClient) waitReady() protocol.Ready {
	c.t.Helper()
	for i := 0; i < 50; i++ {
		envelope, err := c.readEnvelope()
		if err != nil {
			c.t.Fatalf("esperando ready: %v", err)
		}
		if envelope.Kind == protocol.KindReady {
			var ready protocol.Ready
			if err := envelope.Decode(&ready); err != nil {
				c.t.Fatalf("decodificar ready: %v", err)
			}
			return ready
		}
	}
	c.t.Fatal("50 envelopes sem nenhum ready")
	return protocol.Ready{}
}

func (c *wsClient) sendHello(hint string) {
	c.t.Helper()
	c.writeJSON(map[string]any{
		"v": 1, "id": "c-hello", "ts": time.Now().UTC().Format(time.RFC3339),
		"seq": 0, "session": "", "kind": "hello", "from": map[string]any{"kind": "user"},
		"payload": map[string]any{
			"client": "teste", "version": "0", "token": streamTestToken,
			"sessionHint": hint, "resumeFrom": 0,
		},
	})
}

/* --------------------------------- o teste -------------------------------- */

func newStreamHarness(t *testing.T) (*httptest.Server, *store.Store) {
	t.Helper()
	dataStore, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("abrir o store: %v", err)
	}
	t.Cleanup(func() { _ = dataStore.Close() })

	bus := eventbus.New(dataStore)
	// Roteador sem provedor nenhum: o turno falha em "sem modelo", mas falha
	// DENTRO da sessão certa — e é só isso que o teste precisa observar.
	models := modelrouter.New(nil, nil)
	sup := supervisor.New(supervisor.Deps{
		Store:  dataStore,
		Bus:    bus,
		Models: models,
		Gate:   permissions.NewGate(permissions.DefaultPolicy()),
		Tools:  supervisor.NewRegistry(),
	})
	server := NewServer(
		config.Config{Token: streamTestToken},
		dataStore, bus, sup, models,
		fusion.NewRegistry(),
		permissions.NewGate(permissions.DefaultPolicy()),
		nil, nil, "",
		slog.New(slog.NewTextHandler(io.Discard, nil)),
	)
	web := httptest.NewServer(server.Handler())
	t.Cleanup(web.Close)
	return web, dataStore
}

func TestSegundoHelloTrocaASessao(t *testing.T) {
	web, dataStore := newStreamHarness(t)
	client := dialStream(t, web.URL)

	// 1. Primeiro hello sem dica: nasce a sessão A.
	client.sendHello("")
	sessaoA := client.waitReady().Session
	if sessaoA == "" {
		t.Fatal("o primeiro ready veio sem sessão")
	}

	// 2. Segundo hello sem dica NA MESMA CONEXÃO: tem de nascer OUTRA sessão.
	// Era exatamente isto que o gateway ignorava.
	client.sendHello("")
	sessaoB := client.waitReady().Session
	if sessaoB == "" || sessaoB == sessaoA {
		t.Fatalf("o segundo hello não abriu sessão nova: antes %q, depois %q", sessaoA, sessaoB)
	}

	// 3. O prompt que vem depois da troca cai na sessão NOVA — e só nela.
	// Era o sintoma visível: a pessoa clicava em "nova conversa", pedia outra
	// coisa, e a resposta saía da conversa antiga com o especialista antigo.
	client.writeJSON(map[string]any{
		"v": 1, "id": "c-prompt", "ts": time.Now().UTC().Format(time.RFC3339),
		"seq": 0, "session": sessaoB, "kind": "prompt", "from": map[string]any{"kind": "user"},
		"payload": map[string]any{"text": "crie uma aplicação simples"},
	})
	// Espera o turno TERMINAR (ask, erro ou done no log), não só começar: o
	// turno roda num goroutine desacoplado da conexão, e sair do teste com ele
	// vivo deixa o último append disputando o arquivo com a limpeza do TempDir
	// — no Windows isso é falha de verdade, não detalhe.
	prazo := time.Now().Add(5 * time.Second)
	for {
		envelopes, _ := dataStore.Since(sessaoB, 0, 1000)
		terminou := false
		for _, envelope := range envelopes {
			if envelope.Kind == protocol.KindAsk || envelope.Kind == protocol.KindError ||
				envelope.Kind == protocol.KindDone {
				terminou = true
			}
		}
		if terminou {
			break
		}
		if time.Now().After(prazo) {
			t.Fatal("o prompt enviado depois da troca nunca chegou à sessão nova")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if seqA, _ := dataStore.LastSeq(sessaoA); seqA != 0 {
		t.Fatalf("a sessão antiga recebeu %d envelope(s) de um prompt que não era dela", seqA)
	}

	// 4. Voltar por dica REABRE a sessão com replay: o hello com hint da B tem
	// de devolver ready da B e reentregar o que acabou de ser gravado nela.
	client.sendHello(sessaoB)
	if reaberta := client.waitReady().Session; reaberta != sessaoB {
		t.Fatalf("pedi a sessão %q de volta e o ready veio de %q", sessaoB, reaberta)
	}
	achouPrompt := false
	for i := 0; i < 50 && !achouPrompt; i++ {
		envelope, err := client.readEnvelope()
		if err != nil {
			t.Fatalf("esperando o replay: %v", err)
		}
		if envelope.Kind != protocol.KindMessage || envelope.Session != sessaoB {
			continue
		}
		var message protocol.Message
		if err := envelope.Decode(&message); err != nil {
			continue
		}
		achouPrompt = message.Role == "user" && message.Text == "crie uma aplicação simples"
	}
	if !achouPrompt {
		t.Fatal("o replay da sessão reaberta não trouxe o pedido gravado nela")
	}
}

// O hello de troca reapresenta o token; sem ele a conexão FECHA, porque um
// frame forjado dentro de uma conexão autenticada não pode escolher a sessão
// de ninguém.
func TestHelloDeTrocaSemTokenFechaAConexao(t *testing.T) {
	web, _ := newStreamHarness(t)
	client := dialStream(t, web.URL)

	client.sendHello("")
	_ = client.waitReady()

	client.writeJSON(map[string]any{
		"v": 1, "id": "c-forjado", "ts": time.Now().UTC().Format(time.RFC3339),
		"seq": 0, "session": "", "kind": "hello", "from": map[string]any{"kind": "user"},
		"payload": map[string]any{"client": "teste", "version": "0", "sessionHint": "alheia"},
	})

	for i := 0; i < 50; i++ {
		if _, err := client.readEnvelope(); err != nil {
			return // fechou (close frame ou conexão encerrada) — é o esperado
		}
	}
	t.Fatal("o hello sem token não fechou a conexão")
}
