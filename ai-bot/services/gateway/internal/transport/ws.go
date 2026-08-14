// Package transport implementa, na mão e só com a biblioteca padrão, os fios
// por onde o envelope do protocolo trafega.
//
// Este arquivo é o servidor WebSocket (RFC 6455). Escrever isto à mão parece
// exagero até lembrar QUEM é este processo: o gateway carrega a conversa
// inteira do usuário, a chave dos provedores e o direito de executar
// ferramenta na máquina dele. gorilla/websocket é boa biblioteca, mas seria
// dependência de terceiro exatamente aqui — e, pela política da casa, teria de
// passar por TI/SI antes de entrar. O subconjunto que o AI-BOT usa cabe em um
// arquivo: servidor (nunca cliente), sem extensões, sem permessage-deflate,
// texto e binário, ping/pong e close.
//
// O que deliberadamente NÃO existe aqui, e por quê:
//   - compressão: economizaria banda em loopback, onde banda não é problema, e
//     traria uma máquina de estado inteira (e CVEs) junto;
//   - fragmentação na escrita: o gateway sempre escreve a mensagem completa; na
//     LEITURA a fragmentação é aceita, porque o cliente pode fragmentar;
//   - cliente WebSocket: quem fala com provedor externo usa net/http.
package transport

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// Opcodes que o gateway usa. Os reservados não aparecem de propósito: receber
// um deles é erro de protocolo, não um caso a tratar.
const (
	OpText   byte = 0x1
	OpBinary byte = 0x2
	OpClose  byte = 0x8
	OpPing   byte = 0x9
	OpPong   byte = 0xA
)

// opContinuation é o opcode 0x0: "continua a mensagem que já começou".
const opContinuation byte = 0x0

// MaxMessage é o teto de uma mensagem remontada. Frame ou mensagem maior
// derruba a conexão com 1009. Existe porque o tamanho vem no cabeçalho e é
// escolhido pelo cliente: sem teto, um único frame anunciando 2^40 bytes faria
// o gateway alocar até morrer — negação de serviço de graça.
const MaxMessage = 8 << 20 // 8 MiB

// maxControlPayload é o limite da RFC para frames de controle.
const maxControlPayload = 125

// Códigos de fechamento usados pelo gateway (RFC 6455 §7.4.1).
const (
	CloseNormal        uint16 = 1000
	CloseGoingAway     uint16 = 1001
	CloseProtocolError uint16 = 1002
	ClosePolicy        uint16 = 1008
	CloseTooBig        uint16 = 1009
	CloseInternal      uint16 = 1011
)

// websocketGUID é a constante mágica do handshake, fixada pela RFC.
const websocketGUID = "258EAFA5-E914-47DA-95CA-5AB0DC85B11C"

// handshakeTimeout limita o tempo de escrita do 101. Sem prazo, um cliente que
// abre a conexão e não lê nunca prenderia a goroutine para sempre.
const handshakeTimeout = 10 * time.Second

// ErrClosed é devolvido por escrita em conexão já fechada.
var ErrClosed = errors.New("conexão websocket fechada")

// Conn é uma conexão WebSocket já negociada.
//
// Contrato de concorrência: UM leitor (ReadMessage não é seguro para chamadas
// concorrentes) e QUANTOS escritores quiser — as escritas são serializadas por
// trava. Sem essa trava, dois emissores intercalariam bytes de frames
// diferentes e o cliente veria lixo; é o bug clássico de quem escreve
// WebSocket na mão.
type Conn struct {
	conn net.Conn
	rw   *bufio.ReadWriter

	// remote é guardado na criação porque depois do Close o endereço do socket
	// já não é confiável, e ele ainda é útil no log do erro.
	remote string

	writeMu sync.Mutex

	stateMu sync.Mutex
	closed  bool
}

// Upgrade valida o handshake e assume o socket.
//
// Em caso de erro NADA foi escrito na resposta: quem chama continua dono do
// ResponseWriter e deve responder 400 (ou 403, no caso de origem recusada).
// Em caso de sucesso o inverso vale — a resposta HTTP já foi enviada e o
// ResponseWriter não pode mais ser tocado. O chamador é dono do Conn e deve
// fechá-lo (defer conn.Close(...)), inclusive quando ReadMessage devolve EOF.
func Upgrade(w http.ResponseWriter, r *http.Request, allowedOrigins []string) (*Conn, error) {
	if r.Method != http.MethodGet {
		return nil, fmt.Errorf("upgrade websocket exige GET, veio %s", r.Method)
	}
	// Connection é lista de tokens ("keep-alive, Upgrade") e a caixa é livre;
	// comparar a string inteira reprova clientes legítimos.
	if !headerHasToken(r.Header, "Connection", "upgrade") {
		return nil, errors.New("cabeçalho Connection não pede upgrade")
	}
	if !strings.EqualFold(strings.TrimSpace(r.Header.Get("Upgrade")), "websocket") {
		return nil, errors.New("cabeçalho Upgrade não é websocket")
	}
	if version := strings.TrimSpace(r.Header.Get("Sec-WebSocket-Version")); version != "13" {
		return nil, fmt.Errorf("versão de websocket não suportada: %q", version)
	}

	key := strings.TrimSpace(r.Header.Get("Sec-WebSocket-Key"))
	if key == "" {
		return nil, errors.New("cabeçalho Sec-WebSocket-Key ausente")
	}
	// A chave tem de ser 16 bytes em base64. Conferir o tamanho separa um
	// cliente WebSocket de verdade de um GET comum com cabeçalhos copiados.
	raw, decodeErr := base64.StdEncoding.DecodeString(key)
	if decodeErr != nil {
		return nil, fmt.Errorf("cabeçalho Sec-WebSocket-Key não é base64 válida: %w", decodeErr)
	}
	if len(raw) != 16 {
		return nil, fmt.Errorf("cabeçalho Sec-WebSocket-Key tem %d bytes, esperados 16", len(raw))
	}

	if err := checkOrigin(r.Header.Get("Origin"), allowedOrigins); err != nil {
		return nil, err
	}

	// Extensões (permessage-deflate e afins) são simplesmente ignoradas: não
	// ecoar Sec-WebSocket-Extensions na resposta é, pela RFC, recusá-las.

	hijacker, ok := w.(http.Hijacker)
	if !ok {
		return nil, fmt.Errorf("o ResponseWriter %T não implementa http.Hijacker: websocket não sobe sobre HTTP/2 nem sob middleware que embrulha a resposta", w)
	}
	// O bufio devolvido pelo Hijack pode já conter bytes que o servidor leu
	// adiantado depois dos cabeçalhos. Descartar esse leitor e ler do net.Conn
	// cru perderia o primeiro frame — por isso o Conn fica com ESTE rw.
	conn, rw, err := hijacker.Hijack()
	if err != nil {
		return nil, fmt.Errorf("assumindo o socket: %w", err)
	}

	if err := conn.SetWriteDeadline(time.Now().Add(handshakeTimeout)); err != nil {
		conn.Close()
		return nil, fmt.Errorf("definindo prazo do handshake: %w", err)
	}
	response := "HTTP/1.1 101 Switching Protocols\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + acceptKey(key) + "\r\n\r\n"
	if _, err := rw.WriteString(response); err != nil {
		conn.Close()
		return nil, fmt.Errorf("escrevendo resposta 101: %w", err)
	}
	if err := rw.Flush(); err != nil {
		conn.Close()
		return nil, fmt.Errorf("descarregando resposta 101: %w", err)
	}
	// Prazo do handshake não pode virar prazo da sessão: quem manda no tempo
	// das mensagens é o chamador, via SetWriteDeadline.
	if err := conn.SetWriteDeadline(time.Time{}); err != nil {
		conn.Close()
		return nil, fmt.Errorf("limpando prazo do handshake: %w", err)
	}

	return &Conn{conn: conn, rw: rw, remote: conn.RemoteAddr().String()}, nil
}

// checkOrigin decide se a página que abriu o socket tem direito de falar com o
// gateway.
//
// Este é o ponto de segurança mais importante do arquivo. O navegador NÃO
// aplica CORS a WebSocket: qualquer aba aberta na estação pode dar
// new WebSocket("ws://127.0.0.1:.../ws") e conversar com o gateway em
// loopback. Sem esta checagem, um site qualquer manda o AI-BOT executar
// ferramenta na máquina do usuário — é CSRF, com o agravante de o alvo ser um
// executor de comandos.
//
// Requisição SEM Origin é aceita porque cliente nativo (o app Tauri, a CLI, o
// teste) não manda o cabeçalho, enquanto navegador manda SEMPRE. Lista vazia
// recusa tudo que mandar Origin, e de propósito não existe curinga: liberar
// "*" aqui seria desfazer o parágrafo acima com uma linha de configuração.
func checkOrigin(origin string, allowedOrigins []string) error {
	origin = strings.TrimSpace(origin)
	if origin == "" {
		return nil
	}
	for _, allowed := range allowedOrigins {
		if strings.EqualFold(strings.TrimSpace(allowed), origin) {
			return nil
		}
	}
	return fmt.Errorf("origem recusada: %q", origin)
}

// acceptKey devolve a prova de que o servidor entendeu o handshake.
//
// SHA-1 aqui não é escolha de segurança e não guarda segredo nenhum: é o
// algoritmo fixado pela RFC 6455, e trocá-lo quebraria todo cliente do mundo.
func acceptKey(key string) string {
	sum := sha1.Sum([]byte(key + websocketGUID))
	return base64.StdEncoding.EncodeToString(sum[:])
}

// headerHasToken procura um token dentro de um cabeçalho de lista separada por
// vírgula, ignorando caixa e espaço.
func headerHasToken(header http.Header, name, token string) bool {
	for _, value := range header.Values(name) {
		for _, part := range strings.Split(value, ",") {
			if strings.EqualFold(strings.TrimSpace(part), token) {
				return true
			}
		}
	}
	return false
}

// ReadMessage devolve a próxima mensagem completa da aplicação.
//
// Fragmentos (FIN=0 seguido de continuation) são remontados aqui, de modo que
// quem chama nunca vê frame pela metade. Ping é respondido com Pong sem
// interromper a espera. Close devolve io.EOF depois de ecoar o fechamento —
// io.EOF é fim de conversa normal, não falha.
//
// Não é seguro para chamadas concorrentes: um leitor por conexão.
func (c *Conn) ReadMessage() (byte, []byte, error) {
	if c.isClosed() {
		return 0, nil, io.EOF
	}

	// fragmentOp guarda o opcode da mensagem em montagem; 0 significa "nenhuma
	// mensagem aberta", já que opcode de dado é sempre 1 ou 2.
	var fragmentOp byte
	var buffer []byte

	for {
		fin, opcode, payload, err := c.readFrame()
		if err != nil {
			return 0, nil, err
		}

		switch opcode {
		case OpPing:
			// Responder na hora e voltar a ler: ping é sinal de vida, não é
			// assunto da aplicação.
			if err := c.WriteMessage(OpPong, payload); err != nil {
				return 0, nil, fmt.Errorf("respondendo ping: %w", err)
			}

		case OpPong:
			// Resposta ao nosso Ping. Quem mede latência é a camada de cima;
			// aqui só não pode atrapalhar a montagem da mensagem.

		case OpClose:
			code := CloseNormal
			if len(payload) >= 2 {
				code = sanitizeCloseCode(binary.BigEndian.Uint16(payload[:2]))
			}
			// Eco sem motivo: devolver o texto do cliente seria refletir bytes
			// não confiáveis, e a RFC só exige o código.
			_ = c.Close(code, "")
			return 0, nil, io.EOF

		case OpText, OpBinary:
			if fragmentOp != 0 {
				return 0, nil, c.fail(CloseProtocolError, "mensagem nova no meio de outra fragmentada")
			}
			if fin {
				return opcode, payload, nil
			}
			fragmentOp = opcode
			buffer = payload

		case opContinuation:
			if fragmentOp == 0 {
				return 0, nil, c.fail(CloseProtocolError, "frame de continuação sem mensagem aberta")
			}
			// O teto vale para a mensagem REMONTADA: sem isto, mil frames de
			// 8 MiB passariam um a um e estourariam a memória juntos.
			if len(buffer)+len(payload) > MaxMessage {
				return 0, nil, c.fail(CloseTooBig, "mensagem remontada acima do teto")
			}
			buffer = append(buffer, payload...)
			if fin {
				return fragmentOp, buffer, nil
			}

		default:
			return 0, nil, c.fail(CloseProtocolError, fmt.Sprintf("opcode reservado 0x%X", opcode))
		}
	}
}

// readFrame lê um frame do cliente e devolve o payload já desmascarado.
func (c *Conn) readFrame() (bool, byte, []byte, error) {
	var head [2]byte
	if _, err := io.ReadFull(c.rw, head[:]); err != nil {
		if errors.Is(err, io.EOF) {
			// Nada começou a ser lido: o par sumiu entre frames. Fim normal.
			return false, 0, nil, io.EOF
		}
		return false, 0, nil, fmt.Errorf("lendo cabeçalho do frame: %w", err)
	}

	fin := head[0]&0x80 != 0
	// RSV1..3 ligados só fazem sentido com extensão negociada, e não
	// negociamos nenhuma — interpretar seria adivinhar.
	if head[0]&0x70 != 0 {
		return false, 0, nil, c.fail(CloseProtocolError, "bits RSV ligados sem extensão negociada")
	}
	opcode := head[0] & 0x0F
	masked := head[1]&0x80 != 0
	length := uint64(head[1] & 0x7F)

	// Tamanho em três degraus: 0..125 direto, 126 => uint16, 127 => uint64.
	switch length {
	case 126:
		var ext [2]byte
		if _, err := io.ReadFull(c.rw, ext[:]); err != nil {
			return false, 0, nil, fmt.Errorf("lendo tamanho estendido de 16 bits: %w", err)
		}
		length = uint64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err := io.ReadFull(c.rw, ext[:]); err != nil {
			return false, 0, nil, fmt.Errorf("lendo tamanho estendido de 64 bits: %w", err)
		}
		length = binary.BigEndian.Uint64(ext[:])
		// A RFC exige o bit mais significativo em 0; ligado, o valor não cabe
		// em int64 e vira número negativo em quem converter sem olhar.
		if length&(1<<63) != 0 {
			return false, 0, nil, c.fail(CloseProtocolError, "bit mais significativo do tamanho de 64 bits ligado")
		}
	}

	// Cliente é OBRIGADO a mascarar. Aceitar frame sem máscara é aceitar
	// tráfego que um proxy pode ter forjado a partir de conteúdo controlado
	// pelo atacante (é para isso que a máscara existe, não para privacidade).
	if !masked {
		return false, 0, nil, c.fail(CloseProtocolError, "frame de cliente sem máscara")
	}

	if opcode&0x08 != 0 {
		// Controle não fragmenta e não passa de 125 bytes: precisa poder ser
		// tratado no meio de uma mensagem grande.
		if !fin {
			return false, 0, nil, c.fail(CloseProtocolError, "frame de controle fragmentado")
		}
		if length > maxControlPayload {
			return false, 0, nil, c.fail(CloseProtocolError, "frame de controle acima de 125 bytes")
		}
	}

	if length > MaxMessage {
		return false, 0, nil, c.fail(CloseTooBig, "frame acima do teto de mensagem")
	}

	var mask [4]byte
	if _, err := io.ReadFull(c.rw, mask[:]); err != nil {
		return false, 0, nil, fmt.Errorf("lendo máscara do frame: %w", err)
	}

	payload := make([]byte, length)
	if length > 0 {
		if _, err := io.ReadFull(c.rw, payload); err != nil {
			return false, 0, nil, fmt.Errorf("lendo payload do frame: %w", err)
		}
		// A máscara é cíclica de 4 bytes e o índice é o do payload INTEIRO —
		// em frame fragmentado cada frame tem a sua máscara e recomeça em 0.
		for i := range payload {
			payload[i] ^= mask[i%4]
		}
	}

	return fin, opcode, payload, nil
}

// fail fecha a conexão com o código dado e devolve o erro correspondente.
func (c *Conn) fail(code uint16, motivo string) error {
	_ = c.Close(code, motivo)
	return fmt.Errorf("protocolo websocket violado: %s", motivo)
}

// WriteMessage escreve uma mensagem completa em um único frame.
//
// O servidor NÃO mascara (a máscara é obrigação exclusiva do cliente); mascarar
// aqui faria todo cliente conforme derrubar a conexão.
func (c *Conn) WriteMessage(opcode byte, payload []byte) error {
	if opcode&0x08 != 0 && len(payload) > maxControlPayload {
		return fmt.Errorf("frame de controle 0x%X com %d bytes, máximo %d", opcode, len(payload), maxControlPayload)
	}

	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.isClosed() {
		return ErrClosed
	}
	return c.writeFrameLocked(opcode, payload)
}

// writeFrameLocked monta e despacha um frame. Exige writeMu já travado.
func (c *Conn) writeFrameLocked(opcode byte, payload []byte) error {
	var header [10]byte
	header[0] = 0x80 | opcode // FIN=1, RSV zerados: nunca fragmentamos na saída
	size := 2
	switch {
	case len(payload) < 126:
		header[1] = byte(len(payload))
	case len(payload) <= 0xFFFF:
		header[1] = 126
		binary.BigEndian.PutUint16(header[2:4], uint16(len(payload)))
		size = 4
	default:
		header[1] = 127
		binary.BigEndian.PutUint64(header[2:10], uint64(len(payload)))
		size = 10
	}

	if _, err := c.rw.Write(header[:size]); err != nil {
		return fmt.Errorf("escrevendo cabeçalho do frame: %w", err)
	}
	if len(payload) > 0 {
		if _, err := c.rw.Write(payload); err != nil {
			return fmt.Errorf("escrevendo payload do frame: %w", err)
		}
	}
	// Sem Flush o frame fica no buffer do bufio e o cliente espera para sempre
	// por uma resposta que já foi "escrita".
	if err := c.rw.Flush(); err != nil {
		return fmt.Errorf("descarregando frame: %w", err)
	}
	return nil
}

// WriteText escreve uma mensagem de texto (UTF-8, responsabilidade de quem chama).
func (c *Conn) WriteText(payload []byte) error {
	return c.WriteMessage(OpText, payload)
}

// WriteJSON serializa e escreve como texto — é o caminho normal do envelope.
func (c *Conn) WriteJSON(value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("serializando mensagem para json: %w", err)
	}
	return c.WriteMessage(OpText, data)
}

// Ping envia um ping sem corpo. Serve para descobrir conexão morta em NAT que
// não avisa ninguém: TCP pode ficar minutos "aberto" contra um par que já foi.
func (c *Conn) Ping() error {
	return c.WriteMessage(OpPing, nil)
}

// Close envia o frame de fechamento e derruba o socket. É idempotente: a
// segunda chamada não faz nada e devolve nil, porque Close costuma sair por
// defer E pelo caminho de erro ao mesmo tempo.
func (c *Conn) Close(code uint16, reason string) error {
	c.stateMu.Lock()
	if c.closed {
		c.stateMu.Unlock()
		return nil
	}
	c.closed = true
	c.stateMu.Unlock()

	// Corpo do close: código em uint16 big-endian ANTES do motivo. Trocar a
	// ordem faz o cliente ler os dois primeiros bytes do texto como código.
	text := truncateReason(reason)
	body := make([]byte, 2, 2+len(text))
	binary.BigEndian.PutUint16(body, code)
	body = append(body, text...)

	c.writeMu.Lock()
	writeErr := c.writeFrameLocked(OpClose, body)
	c.writeMu.Unlock()

	// O socket cai de qualquer jeito: se o close não passou, o par já sumiu, e
	// deixar o descritor aberto vazaria conexão a cada erro.
	closeErr := c.conn.Close()
	if writeErr != nil {
		return writeErr
	}
	if closeErr != nil {
		return fmt.Errorf("fechando o socket: %w", closeErr)
	}
	return nil
}

// truncateReason encaixa o motivo nos 123 bytes que sobram do frame de
// controle depois do código, sem cortar rune no meio: o corpo do close tem de
// ser UTF-8 válido, e meio caractere derruba o cliente por outro motivo.
func truncateReason(reason string) string {
	const max = maxControlPayload - 2
	if len(reason) <= max && utf8.ValidString(reason) {
		return reason
	}
	cut := reason
	if len(cut) > max {
		cut = cut[:max]
	}
	for len(cut) > 0 && !utf8.ValidString(cut) {
		cut = cut[:len(cut)-1]
	}
	return cut
}

// sanitizeCloseCode troca por 1000 os códigos que a RFC proíbe de trafegar
// (1005, 1006 e 1015 só existem dentro da API) e os que não fazem sentido no
// fio. Ecoar um deles seria erro de protocolo nosso ao responder o do outro.
func sanitizeCloseCode(code uint16) uint16 {
	switch {
	case code == 1005 || code == 1006 || code == 1015:
		return CloseNormal
	case code < 1000 || code >= 5000:
		return CloseProtocolError
	default:
		return code
	}
}

// SetReadDeadline define o prazo da próxima leitura. Prazo esgotado devolve
// erro e a conexão precisa ser fechada: o frame ficou pela metade no fio.
func (c *Conn) SetReadDeadline(t time.Time) error {
	if err := c.conn.SetReadDeadline(t); err != nil {
		return fmt.Errorf("definindo prazo de leitura: %w", err)
	}
	return nil
}

// SetWriteDeadline define o prazo da próxima escrita.
func (c *Conn) SetWriteDeadline(t time.Time) error {
	if err := c.conn.SetWriteDeadline(t); err != nil {
		return fmt.Errorf("definindo prazo de escrita: %w", err)
	}
	return nil
}

// RemoteAddr devolve o endereço do par como texto, para log e auditoria.
func (c *Conn) RemoteAddr() string {
	return c.remote
}

func (c *Conn) isClosed() bool {
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	return c.closed
}
