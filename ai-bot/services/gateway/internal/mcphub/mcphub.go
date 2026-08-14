// Package mcphub conversa com servidores MCP externos e publica as ferramentas
// deles como se fossem nativas do supervisor.
//
// Não há SDK de MCP aqui, nem viria a ser adicionado: MCP é JSON-RPC 2.0 com
// dois métodos que interessam (`tools/list` e `tools/call`), e escrever isso na
// mão custa menos que submeter um SDK à análise de TI/SI — ainda mais neste
// processo, que é o que segura credencial e fala com servidor de terceiro. Os
// tipos Request/Response/RPCError são deliberadamente genéricos porque ACP fala
// o mesmo dialeto: quando o transporte ACP entrar, ele reusa estes tipos em vez
// de clonar o mesmo JSON-RPC com outro nome.
//
// ESCOPO REDUZIDO, de propósito: só o transporte HTTP com resposta JSON. MCP
// também admite `text/event-stream` (streamable HTTP) e stdio; nenhum dos dois
// é tratado aqui. Servidor que só fala SSE ou só fala stdio precisa de um
// transporte próprio — e é melhor ele falhar alto na primeira chamada do que
// este pacote fingir que entende meia resposta.
//
// Duas decisões que parecem detalhe e não são:
//
//  1. Toda ferramenta é publicada como "<servidor>.<ferramenta>". Sem prefixo,
//     o segundo servidor que registrar um "search" sequestra as chamadas do
//     primeiro — e o sintoma disso é o modelo "alucinando" resultado errado,
//     que é caro de diagnosticar.
//  2. O hub NUNCA vê o token. Ele guarda o NOME do segredo (SecretRef) e
//     delega a um `authorize` injetado a tarefa de carimbar o Authorization no
//     request. É a mesma indireção do app anterior, em que o renderer manda o
//     nome do conector e jamais o valor: assim um servidor MCP hostil, um log
//     do hub ou um dump de `Servers()` não têm por onde vazar credencial.
package mcphub

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"unicode"
	"unicode/utf8"
)

// JSONRPCVersion é o único valor aceito no campo `jsonrpc`.
const JSONRPCVersion = "2.0"

// maxResponseBytes limita o corpo lido de um servidor MCP. Sem teto, um
// servidor hostil (ou só quebrado) responde um fluxo infinito e derruba o
// gateway inteiro por consumo de memória — o processo que morre não é o do
// servidor, é o nosso.
const maxResponseBytes = 8 << 20 // 8 MiB

// maxExcerptBytes é o tanto de corpo que pode aparecer numa mensagem de erro.
// O corpo inteiro está fora de cogitação: resposta de erro costuma ecoar o
// cabeçalho da requisição, e o cabeçalho leva o Bearer.
const maxExcerptBytes = 512

// maxToolPages limita a paginação de `tools/list`. Um servidor que devolve
// sempre o mesmo cursor prenderia a descoberta num laço infinito segurando o
// contexto até o timeout — com o teto, ele apenas publica menos ferramentas.
const maxToolPages = 32

// ErrServerNotFound e ErrServerDisabled são sentinelas para o chamador
// distinguir "configuração errada" de "servidor fora do ar" sem parsear texto.
var (
	ErrServerNotFound = errors.New("servidor mcp não registrado")
	ErrServerDisabled = errors.New("servidor mcp desabilitado")
)

// Request é uma requisição JSON-RPC 2.0.
type Request struct {
	JSONRPC string `json:"jsonrpc"`
	// ID ausente marca notificação (sem resposta). Por isso `omitempty`.
	ID     any    `json:"id,omitempty"`
	Method string `json:"method"`
	Params any    `json:"params,omitempty"`
}

// Response é uma resposta JSON-RPC 2.0. Result fica cru porque o formato de
// cada método é assunto de quem chamou, não do transporte.
type Response struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      any             `json:"id,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *RPCError       `json:"error,omitempty"`
}

// RPCError é o erro do protocolo. Implementa `error` para atravessar o código
// Go como qualquer outro erro, sem tradução no meio do caminho.
type RPCError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

// Error formata o erro do protocolo. Message e Data vêm do servidor remoto e
// são recortados: é texto de terceiro indo parar em log nosso.
func (e *RPCError) Error() string {
	if e == nil {
		return "erro jsonrpc nulo"
	}
	message := excerpt([]byte(e.Message))
	if message == "" {
		message = "sem mensagem"
	}
	if len(e.Data) > 0 {
		return fmt.Sprintf("jsonrpc %d: %s (%s)", e.Code, message, excerpt(e.Data))
	}
	return fmt.Sprintf("jsonrpc %d: %s", e.Code, message)
}

// Server é um servidor MCP configurado.
type Server struct {
	Name string `json:"name"`
	URL  string `json:"url"`
	// Enabled desligado tira as ferramentas do catálogo e recusa chamadas. É o
	// interruptor que a pessoa mexe sem perder a configuração.
	Enabled bool `json:"enabled"`
	// SecretRef é o NOME do segredo no cofre, nunca o segredo. Quem resolve é o
	// `authorize` injetado no hub.
	SecretRef string `json:"secretRef,omitempty"`
	// Tools é o catálogo da última descoberta, já com o nome qualificado.
	Tools []Tool `json:"tools,omitempty"`
}

// Tool é uma ferramenta publicada por um servidor.
type Tool struct {
	// Name é o nome qualificado ("<servidor>.<ferramenta>"), que é o nome pelo
	// qual o supervisor e o modelo enxergam a ferramenta.
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	InputSchema json.RawMessage `json:"inputSchema,omitempty"`
	Server      string          `json:"server"`
}

// Hub guarda os servidores registrados e faz as chamadas.
type Hub struct {
	client    *http.Client
	authorize func(secretRef string, request *http.Request) error

	// nextID é o contador de ids de requisição. Atômico porque duas ferramentas
	// podem ser chamadas em paralelo pelo mesmo turno.
	nextID atomic.Uint64

	mu      sync.RWMutex
	servers map[string]*Server
}

// NewHub monta o hub. `client` nil vira um cliente padrão de propósito SEM
// Timeout: o prazo é do contexto de quem chama, e um timeout fixo no cliente
// mataria a chamada de ferramenta longa que o chamador decidiu esperar.
// `authorize` pode ser nil quando nenhum servidor exige credencial.
func NewHub(client *http.Client, authorize func(secretRef string, request *http.Request) error) *Hub {
	if client == nil {
		client = &http.Client{}
	}
	return &Hub{
		client:    client,
		authorize: authorize,
		servers:   make(map[string]*Server),
	}
}

// Register grava (ou substitui) um servidor. Substituir descarta o catálogo
// antigo: se a URL ou a credencial mudou, as ferramentas de antes viraram
// promessa sem lastro, e publicar promessa quebrada é pior que publicar nada.
func (h *Hub) Register(server Server) error {
	name := strings.TrimSpace(server.Name)
	if name == "" {
		return errors.New("servidor mcp sem nome")
	}
	// O ponto é o separador do nome qualificado e a divisão é no PRIMEIRO ponto:
	// um servidor chamado "a.b" nasceria com todas as ferramentas inalcançáveis,
	// porque "a.b.search" seria lido como servidor "a", ferramenta "b.search".
	if strings.Contains(name, ".") {
		return fmt.Errorf("nome de servidor mcp não pode conter ponto: %q", name)
	}
	endpoint := strings.TrimSpace(server.URL)
	if err := validateEndpoint(endpoint); err != nil {
		return fmt.Errorf("servidor mcp %q: %w", name, err)
	}

	entry := server
	entry.Name = name
	entry.URL = endpoint
	entry.Tools = normalizeTools(name, server.Tools)

	h.mu.Lock()
	defer h.mu.Unlock()
	h.servers[name] = &entry
	return nil
}

// Unregister remove o servidor. Idempotente.
func (h *Hub) Unregister(name string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.servers, strings.TrimSpace(name))
}

// Servers devolve uma cópia da configuração, ordenada por nome. SecretRef sai
// como está — é um nome de segredo, e o hub nunca teve o valor para vazar.
func (h *Hub) Servers() []Server {
	h.mu.RLock()
	out := make([]Server, 0, len(h.servers))
	for _, srv := range h.servers {
		copied := *srv
		copied.Tools = cloneTools(srv.Tools)
		out = append(out, copied)
	}
	h.mu.RUnlock()

	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// Discover chama `tools/list` e guarda o catálogo no servidor registrado.
func (h *Hub) Discover(ctx context.Context, name string) ([]Tool, error) {
	server := strings.TrimSpace(name)
	var (
		collected []Tool
		cursor    string
	)
	for page := 0; page < maxToolPages; page++ {
		var params any
		if cursor != "" {
			params = struct {
				Cursor string `json:"cursor"`
			}{Cursor: cursor}
		}
		raw, err := h.do(ctx, server, "tools/list", params)
		if err != nil {
			return nil, err
		}
		var listed toolsList
		if err := json.Unmarshal(raw, &listed); err != nil {
			return nil, fmt.Errorf("catálogo ilegível do servidor mcp %q: %w", server, err)
		}
		for _, t := range listed.Tools {
			tool := strings.TrimSpace(t.Name)
			// Ferramenta sem nome viraria "<servidor>." no catálogo: impossível
			// de chamar e confusa de ler. Descartar é mais honesto.
			if tool == "" {
				continue
			}
			collected = append(collected, Tool{
				Name:        Qualify(server, tool),
				Description: t.Description,
				InputSchema: t.InputSchema,
				Server:      server,
			})
		}
		if listed.NextCursor == "" || listed.NextCursor == cursor {
			break
		}
		cursor = listed.NextCursor
	}
	sortTools(collected)

	h.mu.Lock()
	// O servidor pode ter sido removido enquanto a rede respondia. Nesse caso o
	// catálogo simplesmente não é guardado — ressuscitar o registro seria pior.
	if srv, ok := h.servers[server]; ok {
		srv.Tools = collected
	}
	h.mu.Unlock()

	return cloneTools(collected), nil
}

// Tools devolve a união dos catálogos, ordenada por nome. Servidor desligado
// fica de fora: uma ferramenta visível que recusa toda chamada faz o modelo
// insistir nela turno após turno.
func (h *Hub) Tools() []Tool {
	h.mu.RLock()
	var all []Tool
	for _, srv := range h.servers {
		if !srv.Enabled {
			continue
		}
		all = append(all, srv.Tools...)
	}
	h.mu.RUnlock()

	all = cloneTools(all)
	sortTools(all)
	return all
}

// Call executa "<servidor>.<ferramenta>".
//
// O `isError` que o MCP devolve DENTRO do result não vira erro Go aqui: é
// resultado de ferramenta, e quem decide o que fazer com ele é o supervisor,
// que precisa mostrá-lo ao modelo. Erro Go é falha de transporte ou de
// protocolo — coisa que o modelo não tem como corrigir tentando de novo.
func (h *Hub) Call(ctx context.Context, qualifiedTool string, arguments json.RawMessage) (json.RawMessage, error) {
	server, tool, ok := Split(qualifiedTool)
	if !ok {
		return nil, fmt.Errorf("ferramenta %q não está no formato <servidor>.<ferramenta>", qualifiedTool)
	}
	args := arguments
	if len(args) == 0 {
		// Servidor valida `arguments` contra o schema; omitir o campo faz muitos
		// deles reclamarem de parâmetro obrigatório em ferramenta sem parâmetro.
		args = json.RawMessage(`{}`)
	}
	params := struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}{Name: tool, Arguments: args}

	return h.do(ctx, server, "tools/call", params)
}

// Call2 é a chamada crua a um servidor, para os métodos fora de `tools/*`
// (`initialize`, `resources/read`, `prompts/get`).
func (h *Hub) Call2(ctx context.Context, name, method string, params any) (json.RawMessage, error) {
	if strings.TrimSpace(method) == "" {
		return nil, errors.New("método jsonrpc vazio")
	}
	return h.do(ctx, strings.TrimSpace(name), method, params)
}

// Qualify monta o nome público de uma ferramenta.
func Qualify(server, tool string) string {
	return server + "." + tool
}

// Split desfaz Qualify no PRIMEIRO ponto. Existe exportado para o supervisor
// não reimplementar a regra com LastIndex e quebrar toda ferramenta cujo nome
// tenha ponto (que é legal no MCP).
func Split(qualifiedTool string) (server, tool string, ok bool) {
	i := strings.IndexByte(qualifiedTool, '.')
	if i <= 0 || i == len(qualifiedTool)-1 {
		return "", "", false
	}
	return qualifiedTool[:i], qualifiedTool[i+1:], true
}

// toolsList é o result de `tools/list`.
type toolsList struct {
	Tools []struct {
		Name        string          `json:"name"`
		Description string          `json:"description"`
		InputSchema json.RawMessage `json:"inputSchema"`
	} `json:"tools"`
	NextCursor string `json:"nextCursor"`
}

// do faz uma requisição JSON-RPC e devolve o result cru.
func (h *Hub) do(ctx context.Context, name, method string, params any) (json.RawMessage, error) {
	endpoint, secretRef, err := h.endpointOf(name)
	if err != nil {
		return nil, err
	}

	// O id é obrigatório e serve para correlacionar resposta quando o transporte
	// multiplexa (stdio, websocket). Sobre HTTP a correlação é a própria resposta
	// da requisição, então o contador existe para o servidor não recusar o
	// envelope — não é preciso conferir o eco.
	body, err := json.Marshal(Request{
		JSONRPC: JSONRPCVersion,
		ID:      h.nextID.Add(1),
		Method:  method,
		Params:  params,
	})
	if err != nil {
		return nil, fmt.Errorf("montando %q para o servidor mcp %q: %w", method, name, err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("montando requisição http para o servidor mcp %q: %w", name, err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	// O hub entrega o request pronto e o cofre carimba o Authorization: assim o
	// token existe só dentro do `authorize`, e nunca num campo do hub.
	if h.authorize != nil && secretRef != "" {
		if err := h.authorize(secretRef, req); err != nil {
			return nil, fmt.Errorf("autorizando chamada ao servidor mcp %q: %w", name, err)
		}
	}

	resp, err := h.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("chamando o servidor mcp %q: %w", name, err)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return nil, fmt.Errorf("lendo a resposta do servidor mcp %q: %w", name, err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		detail := excerpt(raw)
		if detail == "" {
			detail = "sem corpo"
		}
		// Só o código entra: o texto do status (resp.Status) é escrito pelo
		// servidor remoto e não merece mais crédito que o corpo.
		return nil, fmt.Errorf("servidor mcp %q respondeu http %d: %s", name, resp.StatusCode, detail)
	}

	var out Response
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("resposta ilegível do servidor mcp %q em %q: %w", name, method, err)
	}
	if out.Error != nil {
		return nil, fmt.Errorf("servidor mcp %q recusou %q: %w", name, method, out.Error)
	}
	if len(out.Result) == 0 {
		return nil, fmt.Errorf("servidor mcp %q respondeu %q sem result nem error", name, method)
	}
	return out.Result, nil
}

// endpointOf resolve o servidor sob leitura, copiando o que a chamada precisa
// para o lock não atravessar a ida à rede.
func (h *Hub) endpointOf(name string) (endpoint, secretRef string, err error) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	srv, ok := h.servers[name]
	if !ok {
		return "", "", fmt.Errorf("%w: %q", ErrServerNotFound, name)
	}
	if !srv.Enabled {
		return "", "", fmt.Errorf("%w: %q", ErrServerDisabled, name)
	}
	return srv.URL, srv.SecretRef, nil
}

// validateEndpoint aceita https em qualquer lugar e http só em loopback.
// Servidor MCP recebe prompt e devolve resultado que o modelo obedece: em
// texto claro, qualquer intermediário lê a conversa e reescreve a resposta.
// A exceção do loopback é para o servidor que roda na própria máquina, onde
// não há rede para escutar.
func validateEndpoint(raw string) error {
	if raw == "" {
		return errors.New("url vazia")
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("url inválida: %w", err)
	}
	host := parsed.Hostname()
	if host == "" {
		return fmt.Errorf("url sem host: %q", raw)
	}
	switch parsed.Scheme {
	case "https":
		return nil
	case "http":
		if isLoopback(host) {
			return nil
		}
		return fmt.Errorf("http só é aceito em loopback e %q não é", host)
	default:
		return fmt.Errorf("esquema %q não suportado, use https", parsed.Scheme)
	}
}

func isLoopback(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// normalizeTools prepara um catálogo vindo da configuração. Ele pode chegar com
// o nome já qualificado (relido de um arquivo que este pacote gravou) ou cru
// (escrito à mão), e os dois têm de terminar iguais.
func normalizeTools(server string, tools []Tool) []Tool {
	var out []Tool
	for _, t := range cloneTools(tools) {
		name := strings.TrimSpace(t.Name)
		if name == "" {
			continue
		}
		if !strings.HasPrefix(name, server+".") {
			name = Qualify(server, name)
		}
		t.Name = name
		t.Server = server
		out = append(out, t)
	}
	sortTools(out)
	return out
}

// cloneTools copia de verdade, InputSchema incluído: devolver a fatia interna
// deixaria o chamador editar o catálogo do hub sem passar por lock nenhum.
func cloneTools(src []Tool) []Tool {
	if len(src) == 0 {
		return nil
	}
	out := make([]Tool, len(src))
	copy(out, src)
	for i := range out {
		if len(out[i].InputSchema) == 0 {
			out[i].InputSchema = nil
			continue
		}
		schema := make(json.RawMessage, len(out[i].InputSchema))
		copy(schema, out[i].InputSchema)
		out[i].InputSchema = schema
	}
	return out
}

func sortTools(tools []Tool) {
	sort.Slice(tools, func(i, j int) bool { return tools[i].Name < tools[j].Name })
}

// excerpt recorta texto de terceiro para caber numa mensagem de erro: no
// máximo maxExcerptBytes, numa linha só e sem caractere de controle — erro vai
// para log e para tela, e nenhum dos dois merece receber o corpo inteiro.
func excerpt(b []byte) string {
	if len(b) > maxExcerptBytes {
		b = b[:maxExcerptBytes]
		// O corte pode ter partido um rune ao meio; apara a sobra para o erro
		// não terminar em caractere de substituição.
		for i := 0; i < utf8.UTFMax-1 && len(b) > 0; i++ {
			r, size := utf8.DecodeLastRune(b)
			if r != utf8.RuneError || size > 1 {
				break
			}
			b = b[:len(b)-1]
		}
	}
	flat := strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, string(b))
	return strings.Join(strings.Fields(flat), " ")
}
