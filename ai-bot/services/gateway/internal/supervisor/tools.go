// Registro e implementação das ferramentas.
//
// Existem DOIS tipos, e a diferença é onde a coisa acontece:
//
//   - ferramenta local do gateway (arquivo, git, memória, rede, MCP) roda aqui;
//   - ferramenta de MÁQUINA (rodar processo, abrir terminal, ler o binário de um
//     DOCX que está no disco da pessoa, cofre do SO) roda no Rust, e o gateway
//     só despacha pelo mesmo `tool.call` do protocolo.
//
// A segunda categoria não é preguiça: o isolamento por Job Object do Windows, o
// ConPTY e o Credential Manager não existem na biblioteca padrão do Go, e
// trazê-los seria dependência de terceiro no processo que executa comando. O
// Rust já tem essas crates homologadas. Como o protocolo canônico já tem
// `tool.call`/`tool.result`, o host Tauri entra como mais um participante — não
// como um caso especial.
//
// UMA REGRA QUE NÃO MUDA NO PORT: `pty_write` do host NÃO é ferramenta e não
// está aqui. Escrever num terminal interativo é execução sem portão — bastaria
// o modelo digitar `rm -rf .\n`. Quem precisa de shell usa `proc.run`, que
// passa pela aprovação.
package supervisor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"aibot/gateway/internal/mcphub"
	"aibot/gateway/internal/memory"
	"aibot/gateway/internal/modelrouter"
	"aibot/gateway/internal/netguard"
	"aibot/gateway/internal/sandbox"
	"aibot/gateway/internal/schedule"
	"aibot/gateway/internal/workspace"
	"aibot/gateway/internal/worktree"
)

// ToolFunc executa uma ferramenta.
type ToolFunc func(ctx context.Context, sessionID string, args json.RawMessage) (string, error)

// HostBridge despacha a ferramenta para o host Tauri e espera o resultado.
type HostBridge interface {
	Call(ctx context.Context, sessionID, tool string, args json.RawMessage) (string, error)
}

type registration struct {
	description string
	fn          ToolFunc
	host        bool
	owner       string
	token       uint64
}

// Registry é o catálogo executável.
type Registry struct {
	mu     sync.RWMutex
	tools  map[string]registration
	bridge HostBridge
	next   uint64
}

// NewRegistry monta um catálogo vazio.
func NewRegistry() *Registry {
	return &Registry{tools: make(map[string]registration)}
}

// Register acrescenta uma ferramenta local.
func (r *Registry) Register(name, description string, fn ToolFunc) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.next++
	r.tools[name] = registration{description: description, fn: fn, owner: "core", token: r.next}
}

// RegisterHost declara uma ferramenta que roda no host.
func (r *Registry) RegisterHost(name, description string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.next++
	r.tools[name] = registration{description: description, host: true, owner: "core", token: r.next}
}

// RegisterOwned publica uma ferramenta com dono e devolve o efeito reversível
// que a remove. Plugins não podem substituir silenciosamente ferramenta de
// outro dono: colisão é erro de composição, não ordem acidental de boot.
func (r *Registry) RegisterOwned(owner, name, description string, fn ToolFunc) (func(), error) {
	return r.registerOwned(owner, name, registration{description: description, fn: fn})
}

// RegisterHostOwned é a variante para capacidade implementada pela casca
// nativa. O manifesto publica o contrato; o host continua sendo quem executa.
func (r *Registry) RegisterHostOwned(owner, name, description string) (func(), error) {
	return r.registerOwned(owner, name, registration{description: description, host: true})
}

func (r *Registry) registerOwned(owner, name string, entry registration) (func(), error) {
	owner = strings.TrimSpace(owner)
	name = strings.TrimSpace(name)
	if owner == "" || name == "" {
		return nil, errors.New("registro de ferramenta exige owner e name")
	}
	r.mu.Lock()
	if current, exists := r.tools[name]; exists {
		r.mu.Unlock()
		return nil, fmt.Errorf("ferramenta %s já pertence a %s", name, current.owner)
	}
	r.next++
	entry.owner = owner
	entry.token = r.next
	token := entry.token
	r.tools[name] = entry
	r.mu.Unlock()

	return func() {
		r.mu.Lock()
		defer r.mu.Unlock()
		current, exists := r.tools[name]
		if exists && current.owner == owner && current.token == token {
			delete(r.tools, name)
		}
	}, nil
}

// SetBridge liga o despacho para o host. Sem ponte, ferramenta de host recusa
// com motivo — que é melhor que ficar pendurada esperando alguém que não existe.
func (r *Registry) SetBridge(bridge HostBridge) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.bridge = bridge
}

// Describe devolve a descrição, ou "" se a ferramenta não existe.
func (r *Registry) Describe(name string) string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.tools[name].description
}

// Has diz se a ferramenta existe no catálogo.
//
// Existe para a validação do catálogo publicado (trilha A de
// docs/atualizacao.md): um especialista que declara uma ferramenta inexistente
// promete ao modelo uma permissão que ninguém executa, e o turno vira uma
// sequência de pedidos recusados. Perguntar `Describe() != ""` funcionaria por
// acidente — descrição é texto, e o dia em que uma ferramenta nascer sem
// descrição a checagem passaria a mentir.
func (r *Registry) Has(name string) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	_, ok := r.tools[name]
	return ok
}

// Names lista o catálogo em ordem.
func (r *Registry) Names() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]string, 0, len(r.tools))
	for name := range r.tools {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

// Call executa. O portão de permissão já rodou antes — este método NÃO decide
// se pode, só faz.
func (r *Registry) Call(ctx context.Context, name, sessionID string, args json.RawMessage) (string, error) {
	r.mu.RLock()
	entry, ok := r.tools[name]
	bridge := r.bridge
	r.mu.RUnlock()

	if !ok {
		return "", fmt.Errorf("ferramenta desconhecida: %s", name)
	}
	if entry.host {
		if bridge == nil {
			return "", errHostDisconnected(name)
		}
		return bridge.Call(ctx, sessionID, name, args)
	}
	if entry.fn == nil {
		return "", fmt.Errorf("a ferramenta %s não tem implementação", name)
	}
	return entry.fn(ctx, sessionID, args)
}

// CallHost despacha ao aplicativo nativo uma ferramenta que NÃO está declarada
// como de host.
//
// Existe por causa do `proc.run`: ele deixou de ser uma ferramenta de host fixa
// e virou uma que decide o destino pelo ambiente ativo da sessão (ver
// tools_process.go). No ambiente `local` o destino continua sendo o Rust, e é
// por aqui que ele chega lá — sem isto, a ferramenta teria de existir duas
// vezes no catálogo, com dois nomes, e o modelo escolheria um deles.
func (r *Registry) CallHost(ctx context.Context, sessionID, tool string, args json.RawMessage) (string, error) {
	r.mu.RLock()
	bridge := r.bridge
	r.mu.RUnlock()
	if bridge == nil {
		return "", errHostDisconnected(tool)
	}
	return bridge.Call(ctx, sessionID, tool, args)
}

func errHostDisconnected(tool string) error {
	return fmt.Errorf("a ferramenta %s roda na máquina e o aplicativo não está conectado", tool)
}

/* ------------------------------- toolbox -------------------------------- */

// Toolbox junta as dependências e instala as ferramentas locais.
type Toolbox struct {
	Memory    *memory.Store
	// Artifacts lê as saídas integrais guardadas pelo Tool Output Gateway. Por
	// interface porque a ferramenta só LÊ fatias — gravar é do supervisor.
	Artifacts ArtifactReader
	Net       *netguard.Guard
	MCP       *mcphub.Hub
	Worktrees *worktree.Manager
	// Models é o MESMO roteador que atende o turno de conversa. As ferramentas
	// que falam com o provedor (imagem, fine-tuning) passam por ele em vez de
	// abrir cliente próprio: uma segunda superfície de credencial é uma segunda
	// superfície para proteger, e a segunda é sempre a que fica desatualizada.
	Models *modelrouter.Router
	// Secrets é o cofre. Fica atrás de interface porque este pacote só pode
	// USAR o segredo dentro de um callback — nunca recebê-lo de volta.
	Secrets SecretUser
	// Schedule é a agenda local (internal/schedule). Nil quando o gateway subiu
	// sem pasta de dados gravável — e aí as ferramentas de agenda RECUSAM com
	// motivo, em vez de aceitar o gatilho e perdê-lo quando o processo morrer.
	Schedule *schedule.Store
	// Environments é o registro de ambientes de execução (local, docker, wsl,
	// vps, nuvem) e guarda qual deles está ativo em cada sessão. Nil = tudo roda
	// no local, que é o comportamento de antes de este seletor existir.
	Environments *sandbox.Registry
	// Search é o motor de busca contratado pelo cliente — searxng auto-hospedado,
	// Brave ou Tavily. Zerado significa NÃO CONFIGURADO, e web.search recusa
	// dizendo o que preencher e onde; um motor padrão embutido mandaria a
	// consulta do usuário para um terceiro que ninguém aprovou.
	Search SearchBackend
	// Notices publica os avisos animados de execução (KindNotice, efêmeros) —
	// "este passo vai rodar num container" ANTES de o container subir. Nil =
	// sem aviso, nunca sem execução. Ver tools_process.go.
	Notices NoticePublisher
	// Specialist devolve o especialista ativo da sessão, para o aviso desenhar
	// o avatar certo. Nil ou vazio = o popup sai com o bot padrão.
	Specialist func(sessionID string) string
}

// ArtifactReader é o que o context.fetch precisa do store.
type ArtifactReader interface {
	ReadArtifact(sessionID, ref string, offset, limit int) (string, int, error)
}

// gitTimeout limita cada chamada ao git.
const gitTimeout = 120 * time.Second

// Install registra tudo o que roda dentro do gateway.
func (t *Toolbox) Install(registry *Registry) {
	registry.Register("fs.read", "lê um arquivo do projeto, inteiro ou por faixa. args: {path, offset?, limit?}", t.fsRead)
	registry.Register("fs.write", "grava um arquivo do projeto. args: {path, content}", t.fsWrite)
	registry.Register("fs.list", "lista uma pasta do projeto. args: {path}", t.fsList)
	registry.Register("fs.search", "procura texto literal nos arquivos. args: {query, path?}", t.fsSearch)
	registry.Register("fs.patch", "troca um trecho exato dentro de um arquivo. args: {path, find, replace}", t.fsPatch)

	registry.Register("git.status", "estado do repositório. args: {}", t.gitStatus)
	registry.Register("git.diff", "diff do que mudou. args: {staged?}", t.gitDiff)
	registry.Register("git.commit", "registra o que mudou. args: {message}", t.gitCommit)

	// Recuperação sob demanda do Context Runtime — universal (ver specialist.AllowsTool).
	registry.Register("context.fetch",
		"lê uma fatia de um artefato desta conversa. args: {ref, offset?, maxBytes?}", t.contextFetch)

	registry.Register("memory.read", "procura na memória do usuário. args: {query, limit?}", t.memoryRead)
	registry.Register("memory.write", "guarda um fato na memória. args: {kind, title, content, tags?}", t.memoryWrite)

	registry.Register("web.fetch", "baixa uma página pública. args: {url}", t.webFetch)
	registry.Register("mcp.call", "chama uma ferramenta de um conector MCP. args: {tool, arguments}", t.mcpCall)

	registry.Register("worktree.create", "cria uma cópia isolada do repositório. args: {id, base?}", t.worktreeCreate)
	registry.Register("worktree.remove", "descarta uma cópia isolada. args: {id, force?}", t.worktreeRemove)

	// `proc.run` NÃO está na lista de host abaixo, e a ausência é a mudança: ela
	// olha o ambiente ativo da sessão antes de decidir o destino. Ver
	// tools_process.go.
	t.installProcessTools(registry)

	// Ferramentas de MÁQUINA — despachadas ao host Tauri.
	//
	// `term.open` NÃO ESTÁ MAIS AQUI, e a ausência é a correção. Ela abria um
	// ConPTY de verdade no host e respondia "terminal aberto para a pessoa
	// usar" — só que a interface não tem painel de terminal, então não havia
	// para quem mostrar. O modelo lia sucesso e seguia raciocinando sobre uma
	// janela que a pessoa não tem, enquanto cada chamada deixava um shell
	// invisível vivo até o teto de oito sessões do host recusar tudo para
	// sempre. Ferramenta ausente é melhor: sem ela o modelo cai no `proc.run`,
	// que passa pela aprovação e cuja saída a pessoa lê.
	//
	// Ela volta — com esta linha e o braço correspondente no `tools::execute` do
	// Rust — quando a interface tiver painel de terminal.
	registry.RegisterHost("diagnostics.run", "roda o verificador do projeto. args: {}")
	registry.RegisterHost("office.open", "lê o texto de um DOCX/PPTX/XLSX/PDF. args: {path}")
	registry.RegisterHost("office.edit", "substitui texto dentro do binário do documento. args: {path, find, replace}")
	registry.RegisterHost("office.export", "exporta o documento. args: {path, format}")
	registry.RegisterHost("pdf.extract", "extrai o texto de um PDF. args: {path}")
	registry.RegisterHost("runtime.status", "estado do runtime local. args: {}")

	// Vídeo — o ffmpeg DA ESTAÇÃO (aprovado pela TI, instalado por winget),
	// executado pelo host. O gateway não linka nada de mídia: quem tem o
	// binário é a máquina da pessoa, e sem ele a ferramenta recusa com a
	// instrução de instalação em vez de fingir que funcionou. A implementação
	// e as regras (confinamento, timeout de 10 min com kill da árvore, escape
	// do drawtext via textfile) moram em apps/desktop/src-tauri/src/video.rs.
	registry.RegisterHost("video.probe", "duração, resolução e faixas de um vídeo. args: {path}")
	registry.RegisterHost("video.trim", "corta um trecho do vídeo — sem reencodar quando o corte cai em keyframe. args: {path, start, end, output}")
	registry.RegisterHost("video.concat", "emenda vídeos de MESMO codec na ordem dada. args: {paths[], output}")
	registry.RegisterHost("video.text", "grava um texto sobre o vídeo. args: {path, text, output, position?}")
	registry.RegisterHost("video.export", "transcodifica o vídeo (mp4, webm, gif, mp3). args: {path, output, format}")

	// E as que o gateway resolve sozinho — ver tools_extra.go, tools_flow.go e
	// tools_ship.go.
	t.InstallExtraTools(registry)
	t.InstallFlowTools(registry)
	t.installShipTools(registry)
}

/* --------------------------- confinamento de fs -------------------------- */

var errNoRoot = errors.New("esta sessão não tem pasta de projeto definida")

// resolveInside devolve o caminho absoluto de `relative` dentro de `root`,
// recusando qualquer coisa que escape.
//
// São três checagens, e nenhuma delas basta sozinha:
//  1. texto — recusa caminho absoluto e `..` antes de tocar no disco;
//  2. prefixo sobre o caminho limpo — pega o `a/../../b` que sobrou;
//  3. symlink — o caminho `raiz/link` ESTÁ dentro da raiz, mas escrever nele
//     escreve no alvo, que pode estar em qualquer lugar. É a checagem que a
//     maioria esquece, e a única que fecha o caso do link apontando para fora.
func resolveInside(root, relative string) (string, error) {
	if root == "" {
		return "", errNoRoot
	}
	if relative == "" {
		relative = "."
	}
	if filepath.IsAbs(relative) || strings.HasPrefix(relative, "~") {
		return "", fmt.Errorf("caminho precisa ser relativo à pasta do projeto: %q", relative)
	}
	if strings.Contains(filepath.ToSlash(relative), "../") || filepath.ToSlash(relative) == ".." {
		return "", fmt.Errorf("caminho não pode sair da pasta do projeto: %q", relative)
	}

	absoluteRoot, err := filepath.Abs(root)
	if err != nil {
		return "", fmt.Errorf("raiz inválida: %w", err)
	}
	// A própria raiz pode ser um link; comparar contra o caminho não resolvido
	// reprovaria tudo.
	if resolved, err := filepath.EvalSymlinks(absoluteRoot); err == nil {
		absoluteRoot = resolved
	}

	candidate := filepath.Clean(filepath.Join(absoluteRoot, relative))
	if !withinRoot(absoluteRoot, candidate) {
		return "", fmt.Errorf("caminho fora da pasta do projeto: %q", relative)
	}

	// Se o alvo existe, ele não pode ser link; se não existe, o PAI é conferido
	// (o arquivo a criar herda o destino do link do diretório).
	if info, err := os.Lstat(candidate); err == nil {
		if info.Mode()&os.ModeSymlink != 0 {
			return "", fmt.Errorf("caminho é um atalho e não pode ser usado: %q", relative)
		}
		resolved, err := filepath.EvalSymlinks(candidate)
		if err == nil && !withinRoot(absoluteRoot, resolved) {
			return "", fmt.Errorf("caminho aponta para fora da pasta do projeto: %q", relative)
		}
	} else if !os.IsNotExist(err) {
		return "", fmt.Errorf("verificar %q: %w", relative, err)
	} else {
		parent := filepath.Dir(candidate)
		if resolved, err := filepath.EvalSymlinks(parent); err == nil && !withinRoot(absoluteRoot, resolved) {
			return "", fmt.Errorf("a pasta de destino aponta para fora do projeto: %q", relative)
		}
	}
	return candidate, nil
}

func withinRoot(root, candidate string) bool {
	if candidate == root {
		return true
	}
	return strings.HasPrefix(candidate, root+string(filepath.Separator))
}

// root devolve a raiz do workspace da EXECUÇÃO pendurada no contexto — quem a
// congela é o supervisor, no começo do turno/tarefa (workspace.Plan +
// Materialize). A ferramenta nunca calcula um diretório: ela recebe uma
// execução cujo workspace já foi decidido. Vazio = a sessão não tem pasta de
// projeto (ou o contexto veio sem execução), e cada ferramenta recusa com o
// motivo dela — cair na pasta do processo seria trabalhar dentro do binário
// do gateway.
func (t *Toolbox) root(ctx context.Context) string {
	execution, ok := workspace.FromContext(ctx)
	if !ok {
		return ""
	}
	return execution.LocalRoot
}

/* ------------------------------- arquivos -------------------------------- */

// maxReadBytes é o teto de leitura de arquivo. Ler um binário de 300 MB para
// dentro do prompt não ajuda o modelo e derruba a sessão.
const maxReadBytes = 512 << 10

func (t *Toolbox) fsRead(ctx context.Context, sessionID string, raw json.RawMessage) (string, error) {
	var args struct {
		Path string `json:"path"`
		// A LEITURA POR FAIXA do Context Runtime: `offset` é a primeira linha
		// (1-based) e `limit` quantas linhas. Sessenta linhas certas valem mais
		// que o arquivo inteiro ocupando a janela — quem sabe onde procurar
		// (fs.search primeiro) lê só o intervalo.
		Offset int `json:"offset"`
		Limit  int `json:"limit"`
	}
	if err := decodeArgs(raw, &args); err != nil {
		return "", err
	}
	path, err := resolveInside(t.root(ctx), args.Path)
	if err != nil {
		return "", err
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("ler %s: %w", args.Path, err)
	}

	if args.Offset > 0 || args.Limit > 0 {
		lines := strings.Split(string(content), "\n")
		start := args.Offset
		if start <= 0 {
			start = 1
		}
		if start > len(lines) {
			return fmt.Sprintf("(o arquivo tem %d linha(s); a faixa pedida começa depois do fim)", len(lines)), nil
		}
		count := args.Limit
		if count <= 0 {
			count = len(lines)
		}
		end := start - 1 + count
		if end > len(lines) {
			end = len(lines)
		}
		slice := strings.Join(lines[start-1:end], "\n")
		return fmt.Sprintf("(linhas %d-%d de %d)\n%s", start, end, len(lines), slice), nil
	}

	if len(content) > maxReadBytes {
		return string(content[:maxReadBytes]) +
			fmt.Sprintf("\n… (arquivo cortado: %d de %d bytes — peça por faixa: {path, offset, limit})",
				maxReadBytes, len(content)), nil
	}
	return string(content), nil
}

// contextFetch é a RECUPERAÇÃO SOB DEMANDA do Context Runtime: lê uma fatia de
// um artefato desta conversa (a saída integral que o gateway projetou). O
// modelo pede o trecho que precisa em vez de reter o dump na janela — e a
// fatia é obrigatória: o teto por chamada impede o dump de voltar inteiro.
func (t *Toolbox) contextFetch(_ context.Context, sessionID string, raw json.RawMessage) (string, error) {
	if t.Artifacts == nil {
		return "", errors.New("este gateway subiu sem armazenamento de artefatos")
	}
	var args struct {
		Ref      string `json:"ref"`
		Offset   int    `json:"offset"`
		MaxBytes int    `json:"maxBytes"`
	}
	if err := decodeArgs(raw, &args); err != nil {
		return "", err
	}
	if strings.TrimSpace(args.Ref) == "" {
		return "", errors.New("faltou a referência — ex.: {\"ref\":\"artifact://proc_run/ab12cd34\"}")
	}
	limit := args.MaxBytes
	if limit <= 0 || limit > 16<<10 {
		limit = 16 << 10
	}
	chunk, total, err := t.Artifacts.ReadArtifact(sessionID, args.Ref, args.Offset, limit)
	if err != nil {
		return "", err
	}
	if chunk == "" {
		return fmt.Sprintf("(o artefato tem %d bytes; o offset pedido está depois do fim)", total), nil
	}
	return fmt.Sprintf("(bytes %d-%d de %d — offset negativo lê do fim)\n%s",
		args.Offset, args.Offset+len(chunk), total, chunk), nil
}

func (t *Toolbox) fsWrite(ctx context.Context, sessionID string, raw json.RawMessage) (string, error) {
	var args struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	if err := decodeArgs(raw, &args); err != nil {
		return "", err
	}
	path, err := resolveInside(t.root(ctx), args.Path)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", fmt.Errorf("criar pasta de %s: %w", args.Path, err)
	}
	if err := os.WriteFile(path, []byte(args.Content), 0o644); err != nil {
		return "", fmt.Errorf("gravar %s: %w", args.Path, err)
	}
	return fmt.Sprintf("gravado: %s (%d bytes)", args.Path, len(args.Content)), nil
}

func (t *Toolbox) fsList(ctx context.Context, sessionID string, raw json.RawMessage) (string, error) {
	var args struct {
		Path string `json:"path"`
	}
	if err := decodeArgs(raw, &args); err != nil {
		return "", err
	}
	path, err := resolveInside(t.root(ctx), args.Path)
	if err != nil {
		return "", err
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return "", fmt.Errorf("listar %s: %w", args.Path, err)
	}
	lines := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			lines = append(lines, entry.Name()+"/")
			continue
		}
		info, err := entry.Info()
		if err != nil {
			lines = append(lines, entry.Name())
			continue
		}
		lines = append(lines, fmt.Sprintf("%s (%d bytes)", entry.Name(), info.Size()))
	}
	if len(lines) == 0 {
		return "(pasta vazia)", nil
	}
	return strings.Join(lines, "\n"), nil
}

// searchLimits mantém a varredura barata o bastante para rodar dentro de um turno.
const (
	searchMaxFiles   = 400
	searchMaxResults = 120
	searchMaxSize    = 1 << 20
)

func (t *Toolbox) fsSearch(ctx context.Context, sessionID string, raw json.RawMessage) (string, error) {
	var args struct {
		Query string `json:"query"`
		Path  string `json:"path"`
	}
	if err := decodeArgs(raw, &args); err != nil {
		return "", err
	}
	if strings.TrimSpace(args.Query) == "" {
		return "", errors.New("informe o texto a procurar em \"query\"")
	}
	base, err := resolveInside(t.root(ctx), args.Path)
	if err != nil {
		return "", err
	}

	var results []string
	scanned := 0
	walkErr := filepath.WalkDir(base, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return nil // pasta sem permissão não interrompe a busca inteira
		}
		if entry.IsDir() {
			if skipDir(entry.Name()) {
				return filepath.SkipDir
			}
			return nil
		}
		if scanned >= searchMaxFiles || len(results) >= searchMaxResults {
			return filepath.SkipAll
		}
		info, err := entry.Info()
		if err != nil || info.Size() > searchMaxSize {
			return nil
		}
		content, err := os.ReadFile(path)
		if err != nil || !isProbablyText(content) {
			return nil
		}
		scanned++
		relative, _ := filepath.Rel(base, path)
		for number, line := range strings.Split(string(content), "\n") {
			if !strings.Contains(line, args.Query) {
				continue
			}
			results = append(results, fmt.Sprintf("%s:%d: %s",
				filepath.ToSlash(relative), number+1, strings.TrimSpace(line)))
			if len(results) >= searchMaxResults {
				return filepath.SkipAll
			}
		}
		return nil
	})
	if walkErr != nil && !errors.Is(walkErr, filepath.SkipAll) {
		return "", fmt.Errorf("procurar: %w", walkErr)
	}
	if len(results) == 0 {
		return fmt.Sprintf("nenhuma ocorrência de %q em %d arquivos", args.Query, scanned), nil
	}
	return strings.Join(results, "\n"), nil
}

func skipDir(name string) bool {
	switch name {
	case ".git", "node_modules", "target", "dist", "build", ".next", "vendor", ".venv", "__pycache__":
		return true
	}
	return false
}

// isProbablyText recusa binário por byte nulo nos primeiros 8 KiB — o mesmo
// critério que o `grep` usa, e pelo mesmo motivo: despejar um PNG no prompt
// gasta o contexto inteiro sem informar nada.
func isProbablyText(content []byte) bool {
	limit := len(content)
	if limit > 8192 {
		limit = 8192
	}
	for _, symbol := range content[:limit] {
		if symbol == 0 {
			return false
		}
	}
	return true
}

func (t *Toolbox) fsPatch(ctx context.Context, sessionID string, raw json.RawMessage) (string, error) {
	var args struct {
		Path    string `json:"path"`
		Find    string `json:"find"`
		Replace string `json:"replace"`
	}
	if err := decodeArgs(raw, &args); err != nil {
		return "", err
	}
	if args.Find == "" {
		return "", errors.New("informe o trecho exato a trocar em \"find\"")
	}
	path, err := resolveInside(t.root(ctx), args.Path)
	if err != nil {
		return "", err
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("ler %s: %w", args.Path, err)
	}
	text := string(content)
	occurrences := strings.Count(text, args.Find)
	switch occurrences {
	case 0:
		return "", fmt.Errorf("o trecho não foi encontrado em %s — leia o arquivo e copie o texto exato", args.Path)
	case 1:
	default:
		// Trocar todas seria trocar o que não foi pedido. Exigir trecho único
		// obriga o modelo a incluir contexto suficiente para desambiguar.
		return "", fmt.Errorf("o trecho aparece %d vezes em %s — inclua mais contexto para deixá-lo único",
			occurrences, args.Path)
	}
	if err := os.WriteFile(path, []byte(strings.Replace(text, args.Find, args.Replace, 1)), 0o644); err != nil {
		return "", fmt.Errorf("gravar %s: %w", args.Path, err)
	}
	return fmt.Sprintf("trecho trocado em %s", args.Path), nil
}

/* ---------------------------------- git ---------------------------------- */

func (t *Toolbox) git(ctx context.Context, sessionID string, arguments ...string) (string, error) {
	root := t.root(ctx)
	if root == "" {
		return "", errNoRoot
	}
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()

	// Argumentos como elementos separados, nunca uma string montada: uma
	// mensagem de commit com aspas viraria injeção de argumento.
	command := exec.CommandContext(ctx, "git", append([]string{"-C", root}, arguments...)...)
	output, err := command.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git %s: %v: %s",
			strings.Join(arguments, " "), err, strings.TrimSpace(string(output)))
	}
	return strings.TrimSpace(string(output)), nil
}

func (t *Toolbox) gitStatus(ctx context.Context, sessionID string, _ json.RawMessage) (string, error) {
	output, err := t.git(ctx, sessionID, "status", "--porcelain=v1", "--branch")
	if err != nil {
		return "", err
	}
	if output == "" {
		return "árvore limpa", nil
	}
	return output, nil
}

func (t *Toolbox) gitDiff(ctx context.Context, sessionID string, raw json.RawMessage) (string, error) {
	var args struct {
		Staged bool `json:"staged"`
	}
	_ = decodeArgs(raw, &args)
	arguments := []string{"diff"}
	if args.Staged {
		arguments = append(arguments, "--staged")
	}
	output, err := t.git(ctx, sessionID, arguments...)
	if err != nil {
		return "", err
	}
	if output == "" {
		return "(sem alterações)", nil
	}
	return output, nil
}

func (t *Toolbox) gitCommit(ctx context.Context, sessionID string, raw json.RawMessage) (string, error) {
	var args struct {
		Message string `json:"message"`
	}
	if err := decodeArgs(raw, &args); err != nil {
		return "", err
	}
	if strings.TrimSpace(args.Message) == "" {
		return "", errors.New("informe a mensagem do commit")
	}
	if _, err := t.git(ctx, sessionID, "add", "-A"); err != nil {
		return "", err
	}
	return t.git(ctx, sessionID, "commit", "-m", args.Message)
}

/* -------------------------------- memória -------------------------------- */

func (t *Toolbox) memoryRead(_ context.Context, _ string, raw json.RawMessage) (string, error) {
	if t.Memory == nil {
		return "", errors.New("a memória não está disponível")
	}
	var args struct {
		Query string `json:"query"`
		Limit int    `json:"limit"`
	}
	if err := decodeArgs(raw, &args); err != nil {
		return "", err
	}
	if args.Limit <= 0 {
		args.Limit = 8
	}
	hits := t.Memory.Search(args.Query, args.Limit)
	if len(hits) == 0 {
		return "(nada na memória sobre isso)", nil
	}
	lines := make([]string, 0, len(hits))
	for _, hit := range hits {
		lines = append(lines, fmt.Sprintf("[%s] %s — %s", hit.Item.Kind, hit.Item.Title, hit.Item.Content))
	}
	return strings.Join(lines, "\n"), nil
}

func (t *Toolbox) memoryWrite(_ context.Context, _ string, raw json.RawMessage) (string, error) {
	if t.Memory == nil {
		return "", errors.New("a memória não está disponível")
	}
	var args struct {
		Kind    string   `json:"kind"`
		Title   string   `json:"title"`
		Content string   `json:"content"`
		Tags    []string `json:"tags"`
	}
	if err := decodeArgs(raw, &args); err != nil {
		return "", err
	}
	kind := memory.Kind(args.Kind)
	if args.Kind == "" {
		kind = memory.KindFact
	}
	item, err := t.Memory.Add(memory.Item{
		Kind:       kind,
		Title:      args.Title,
		Content:    args.Content,
		Tags:       args.Tags,
		Importance: 3,
		Source:     "conversa",
	})
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("memória gravada: %s", item.Title), nil
}

/* ---------------------------------- rede --------------------------------- */

func (t *Toolbox) webFetch(ctx context.Context, _ string, raw json.RawMessage) (string, error) {
	if t.Net == nil {
		return "", errors.New("a saída de rede não está disponível")
	}
	var args struct {
		URL string `json:"url"`
	}
	if err := decodeArgs(raw, &args); err != nil {
		return "", err
	}
	response, body, err := t.Net.Fetch(ctx, args.URL, nil)
	if err != nil {
		return "", err
	}
	contentType := response.Header.Get("Content-Type")
	if strings.Contains(contentType, "text/html") {
		return htmlToText(string(body)), nil
	}
	return truncate(string(body), 100000), nil
}

func (t *Toolbox) mcpCall(ctx context.Context, _ string, raw json.RawMessage) (string, error) {
	if t.MCP == nil {
		return "", errors.New("nenhum conector MCP está registrado")
	}
	var args struct {
		Tool      string          `json:"tool"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if err := decodeArgs(raw, &args); err != nil {
		return "", err
	}
	result, err := t.MCP.Call(ctx, args.Tool, args.Arguments)
	if err != nil {
		return "", err
	}
	return string(result), nil
}

/* -------------------------------- worktree -------------------------------- */

func (t *Toolbox) worktreeCreate(ctx context.Context, _ string, raw json.RawMessage) (string, error) {
	if t.Worktrees == nil {
		return "", errors.New("o gerenciador de cópias isoladas não está disponível")
	}
	var args struct {
		ID   string `json:"id"`
		Base string `json:"base"`
	}
	if err := decodeArgs(raw, &args); err != nil {
		return "", err
	}
	created, err := t.Worktrees.Create(ctx, args.ID, args.Base)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("cópia isolada criada em %s (ramo %s)", created.Path, created.Branch), nil
}

func (t *Toolbox) worktreeRemove(ctx context.Context, _ string, raw json.RawMessage) (string, error) {
	if t.Worktrees == nil {
		return "", errors.New("o gerenciador de cópias isoladas não está disponível")
	}
	var args struct {
		ID    string `json:"id"`
		Force bool   `json:"force"`
	}
	if err := decodeArgs(raw, &args); err != nil {
		return "", err
	}
	if err := t.Worktrees.Remove(ctx, args.ID, args.Force); err != nil {
		return "", err
	}
	return fmt.Sprintf("cópia isolada %s descartada", args.ID), nil
}

/* --------------------------------- apoio --------------------------------- */

// decodeArgs aceita argumentos ausentes como objeto vazio: uma ferramenta sem
// parâmetro não deve exigir `"args":{}` do modelo.
func decodeArgs(raw json.RawMessage, dst any) error {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	if err := json.Unmarshal(raw, dst); err != nil {
		return fmt.Errorf("argumentos inválidos: %w", err)
	}
	return nil
}

// htmlToText tira marcação para o modelo ler o conteúdo, não as tags.
func htmlToText(html string) string {
	var builder strings.Builder
	builder.Grow(len(html) / 2)

	lower := strings.ToLower(html)
	skipUntil := func(from int, tag string) int {
		closing := "</" + tag
		index := strings.Index(lower[from:], closing)
		if index < 0 {
			return len(html)
		}
		end := strings.Index(lower[from+index:], ">")
		if end < 0 {
			return len(html)
		}
		return from + index + end + 1
	}

	inTag := false
	for position := 0; position < len(html); position++ {
		if !inTag && html[position] == '<' {
			if strings.HasPrefix(lower[position:], "<script") {
				position = skipUntil(position, "script") - 1
				continue
			}
			if strings.HasPrefix(lower[position:], "<style") {
				position = skipUntil(position, "style") - 1
				continue
			}
			inTag = true
			continue
		}
		if inTag {
			if html[position] == '>' {
				inTag = false
				builder.WriteByte(' ')
			}
			continue
		}
		builder.WriteByte(html[position])
	}

	text := strings.Join(strings.Fields(builder.String()), " ")
	return truncate(text, 100000)
}
