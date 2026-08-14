// Package pack é o Corporate Capability Pack: um pacote que a TI instala UMA
// vez e que dá a todo mundo da empresa especialistas, conectores, prompts,
// políticas, modelos de documento e ganchos de auditoria — sem recompilar nada.
//
// Um pacote é um DIRETÓRIO (ou um .tar) com um manifest.json na raiz. Tudo o
// que o manifesto referencia mora DENTRO do pacote, por caminho relativo: um
// pacote que aponta para fora de si mesmo é um pacote que lê o disco de quem o
// instala, e é recusado na validação.
//
// Duas regras que definem o pacote:
//
//  1. TUDO OU NADA. `Load` valida o pacote inteiro e recusa inteiro — mesma
//     regra do overlay de especialistas (specialist.LoadOverlay), pelo mesmo
//     motivo: meio pacote aplicado é um estado que ninguém consegue explicar
//     olhando a tela. A validação junta TODOS os problemas antes de recusar,
//     para quem publica não descobrir os erros um por um.
//
//  2. PACOTE SÓ RESTRINGE. As políticas do manifesto entram em UNIÃO com a
//     política em vigor (deniedTools soma, blockedDomains soma) e NENHUM campo
//     permissivo é tocado. Se instalar um pacote pudesse afrouxar uma recusa,
//     o pacote seria o caminho barato de escapar da política do admin.
//
// O pacote também NÃO executa código próprio: os ganchos são DECLARATIVOS
// (audit/webhook/deny — ver supervisor/hooks.go), pela mesma razão que plugin
// declarativo era a regra no produto anterior — código de terceiro rodando no
// processo que guarda credencial não passa por análise nenhuma.
package pack

import (
	"archive/tar"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"aibot/gateway/internal/permissions"
	"aibot/gateway/internal/specialist"
)

// SchemaVersion é o contrato do manifest.json. Versão diferente é recusada,
// inclusive maior: gateway antigo não sabe ler pacote novo, e adivinhar o que
// um campo desconhecido significa é como se aplica meio pacote sem perceber.
const SchemaVersion = 1

// ErrPack marca recusa de pacote. Quem chama distingue "o pacote é inválido"
// de "não deu para ler o disco" sem parsear a frase do erro.
var ErrPack = errors.New("pacote recusado")

// Tetos da extração de .tar. Sem eles, um tar hostil (ou só corrompido) com
// entradas gigantes ou infinitas enche o disco da estação durante um simples
// `pack install` — o processo que morre é o nosso, não o de quem publicou.
const (
	maxTarFiles    = 2000
	maxTarFileSize = 64 << 20  // 64 MiB por arquivo
	maxTarTotal    = 256 << 20 // 256 MiB no total
)

// MCPServer é um conector MCP declarado pelo pacote. SecretRef é o NOME do
// segredo no cofre, nunca o valor — a mesma indireção do mcphub.
type MCPServer struct {
	Name      string `json:"name"`
	URL       string `json:"url"`
	SecretRef string `json:"secretRef,omitempty"`
}

// Policies são as restrições que o pacote SOMA à política em vigor.
type Policies struct {
	DeniedTools    []string `json:"deniedTools,omitempty"`
	BlockedDomains []string `json:"blockedDomains,omitempty"`
}

// HookSpec é um gancho declarativo do manifesto. Os valores válidos de On e
// Action espelham supervisor/hooks.go — a lista vive nos dois lugares porque
// este pacote é DADO e não importa o supervisor; quando um evento novo nascer,
// os dois mudam juntos (o teste de validação abaixo é o lembrete).
type HookSpec struct {
	On        string `json:"on"`
	Tool      string `json:"tool,omitempty"`
	Action    string `json:"action"`
	SecretRef string `json:"secretRef,omitempty"`
}

// Manifest é o manifest.json exatamente como publicado.
type Manifest struct {
	SchemaVersion int    `json:"schemaVersion"`
	Name          string `json:"name"`
	Version       string `json:"version"`
	// Specialists é o caminho (relativo ao pacote) do overlay de especialistas,
	// no MESMO formato que specialist.LoadOverlay lê.
	Specialists string      `json:"specialists,omitempty"`
	MCP         []MCPServer `json:"mcp,omitempty"`
	// Prompts anexa texto ao prompt de sistema de especialistas: chave = id do
	// especialista, valor = caminho relativo do arquivo de prompt.
	Prompts   map[string]string `json:"prompts,omitempty"`
	Policies  Policies          `json:"policies,omitempty"`
	Templates []string          `json:"templates,omitempty"`
	Hooks     []HookSpec        `json:"hooks,omitempty"`
}

// Pack é um pacote já lido e validado: o manifesto mais o CONTEÚDO dos
// arquivos que ele referencia — quem instala não volta ao disco de origem.
type Pack struct {
	Manifest
	// Dir é de onde o pacote foi lido (o diretório extraído, no caso do .tar).
	Dir string `json:"-"`
	// SpecialistsRaw é o overlay já em memória — o que LoadOverlay recebe.
	SpecialistsRaw []byte `json:"-"`
	// PromptTexts é o texto de cada prompt, por id de especialista.
	PromptTexts map[string]string `json:"-"`
	// extracted marca pacote que veio de .tar: o Dir é temporário e Cleanup
	// pode apagá-lo depois do Install.
	extracted bool
}

// Cleanup apaga o diretório temporário de um pacote extraído de .tar. Para
// pacote lido de diretório é um no-op: o diretório é de quem o publicou.
func (p Pack) Cleanup() {
	if p.extracted && p.Dir != "" {
		_ = os.RemoveAll(p.Dir)
	}
}

// Deps são as capacidades que o Install usa para aplicar o pacote. São funções
// (e não os pacotes concretos) por dois motivos: o subcomando `aibotd pack
// install` roda num processo sem supervisor de pé, e os testes provam a soma
// de política sem subir gateway nenhum. Campo nil = etapa pulada.
type Deps struct {
	// DataDir é a pasta de dados do gateway. Obrigatório: é onde os templates e
	// a cópia persistida do pacote moram.
	DataDir string
	// ApplyOverlay aplica o catálogo de especialistas (specialist.LoadOverlay no
	// gateway de verdade). A recusa dele aborta o Install INTEIRO.
	ApplyOverlay func(raw []byte) error
	// RegisterMCP registra um conector (mcphub.Register embrulhado).
	RegisterMCP func(server MCPServer) error
	// RegisterHooks entrega os ganchos ao executor (supervisor.HookRunner).
	RegisterHooks func(packName string, hooks []HookSpec) error
	// Gate recebe as restrições SOMADAS — ver mergePolicies.
	Gate *permissions.Gate
}

/* ------------------------------ estado ativo ------------------------------ */

// O registro dos pacotes instalados NESTE processo. Estado de pacote, como o
// catálogo de especialistas: o supervisor lê PromptFor no caminho quente do
// turno, então leitura é RWMutex e escrita (Install/Remove) é rara.
var (
	stateMu   sync.RWMutex
	installed = map[string]Pack{}
	// root é o DataDir do último Install/Discover — o que Remove precisa para
	// achar o que apagar sem carregar um parâmetro que só ele usa.
	root string
)

// reset zera o estado do pacote. Só os testes chamam.
func reset() {
	stateMu.Lock()
	defer stateMu.Unlock()
	installed = map[string]Pack{}
	root = ""
}

/* --------------------------------- Load ---------------------------------- */

// Load lê e valida um pacote (diretório ou .tar). Valida TUDO ou recusa
// inteiro: um pacote com UM problema não é aplicado pela metade.
func Load(path string) (Pack, error) {
	if strings.TrimSpace(path) == "" {
		return Pack{}, fmt.Errorf("%w: caminho vazio", ErrPack)
	}
	info, err := os.Stat(path)
	if err != nil {
		return Pack{}, fmt.Errorf("ler o pacote %s: %w", path, err)
	}

	dir := path
	extracted := false
	if !info.IsDir() {
		// Arquivo = .tar. A extração vai para um diretório temporário porque a
		// validação e a instalação leem ARQUIVOS — e extrair uma vez é mais
		// barato (e mais auditável) que ler o tar três vezes.
		if dir, err = extractTar(path); err != nil {
			return Pack{}, err
		}
		extracted = true
	}

	loaded, err := loadDir(dir)
	if err != nil {
		if extracted {
			_ = os.RemoveAll(dir)
		}
		return Pack{}, err
	}
	loaded.extracted = extracted
	return loaded, nil
}

// loadDir lê o pacote de um diretório já materializado.
func loadDir(dir string) (Pack, error) {
	raw, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		return Pack{}, fmt.Errorf("%w: sem manifest.json legível: %v", ErrPack, err)
	}
	var manifest Manifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return Pack{}, fmt.Errorf("%w: manifest.json não é JSON válido: %v", ErrPack, err)
	}

	loaded := Pack{Manifest: manifest, Dir: dir}
	if err := validate(&loaded); err != nil {
		return Pack{}, err
	}
	return loaded, nil
}

// validate confere o manifesto e LÊ os arquivos referenciados, juntando todos
// os problemas antes de recusar — mesma disciplina do validateOverlay.
func validate(p *Pack) error {
	var problems []error
	fail := func(format string, args ...any) {
		problems = append(problems, fmt.Errorf(format, args...))
	}

	if p.SchemaVersion != SchemaVersion {
		// Sai aqui mesmo: com o esquema errado, todo campo abaixo pode
		// significar outra coisa, e apontar erro de campo seria adivinhação.
		return fmt.Errorf("%w: esquema %d, este gateway lê %d", ErrPack, p.SchemaVersion, SchemaVersion)
	}
	if !validName(p.Name) {
		// O nome vira diretório em <dataDir>/packs e <dataDir>/templates — o
		// alfabeto fechado é o que impede um nome de escapar da pasta de dados.
		fail("`name` %q fora do formato (minúsculas, dígitos, `-` e `_`, até 64 caracteres)", p.Name)
	}
	if strings.TrimSpace(p.Version) == "" {
		fail("sem `version` — é ela que diz qual pacote a estação está rodando")
	}

	// Overlay de especialistas: a validação SEMÂNTICA completa é do
	// specialist.LoadOverlay (que é atômico e recusa inteiro); aqui a estrutura
	// é conferida para o pacote quebrado morrer no Load, não no meio do Install.
	if p.Specialists != "" {
		if raw, err := readInside(p.Dir, p.Specialists); err != nil {
			fail("`specialists` %q: %v", p.Specialists, err)
		} else {
			var overlay specialist.Overlay
			if err := json.Unmarshal(raw, &overlay); err != nil {
				fail("`specialists` %q não é um overlay JSON válido: %v", p.Specialists, err)
			} else if overlay.SchemaVersion != specialist.OverlaySchemaVersion {
				fail("`specialists` %q: esquema %d, este gateway lê %d",
					p.Specialists, overlay.SchemaVersion, specialist.OverlaySchemaVersion)
			} else if len(overlay.Specialists) == 0 {
				fail("`specialists` %q não traz especialista nenhum", p.Specialists)
			} else {
				p.SpecialistsRaw = raw
			}
		}
	}

	// Conectores MCP. As regras espelham o mcphub (nome sem ponto, https ou
	// http só em loopback) para a recusa acontecer AQUI, com o pacote inteiro —
	// e não no meio do Install, com metade das etapas já aplicadas.
	seenMCP := map[string]bool{}
	for position, server := range p.MCP {
		where := fmt.Sprintf("mcp na posição %d", position)
		if server.Name != "" {
			where = fmt.Sprintf("mcp %q", server.Name)
		}
		name := strings.TrimSpace(server.Name)
		switch {
		case name == "":
			fail("%s: sem `name`", where)
		case strings.Contains(name, "."):
			fail("%s: nome de servidor não pode conter ponto — o ponto separa servidor de ferramenta", where)
		case seenMCP[name]:
			fail("%s: nome repetido — o segundo esconderia o primeiro", where)
		default:
			seenMCP[name] = true
		}
		if err := validateMCPURL(server.URL); err != nil {
			fail("%s: %v", where, err)
		}
	}

	// Prompts: o id precisa ser plausível e o arquivo precisa existir e ter
	// texto — prompt vazio anexado ao system é ruído que ninguém percebe.
	p.PromptTexts = make(map[string]string, len(p.Prompts))
	for id, file := range p.Prompts {
		if strings.TrimSpace(id) == "" {
			fail("prompt com id de especialista em branco")
			continue
		}
		raw, err := readInside(p.Dir, file)
		if err != nil {
			fail("prompt de %q (%s): %v", id, file, err)
			continue
		}
		text := strings.TrimSpace(string(raw))
		if text == "" {
			fail("prompt de %q (%s) está vazio", id, file)
			continue
		}
		p.PromptTexts[id] = text
	}

	// Políticas: entrada em branco em deniedTools não recusa nada, e em
	// blockedDomains não bloqueia nada — as duas são erro de quem publicou.
	for _, tool := range p.Policies.DeniedTools {
		if strings.TrimSpace(tool) == "" {
			fail("`policies.deniedTools` com entrada em branco")
		}
	}
	for _, domain := range p.Policies.BlockedDomains {
		if strings.TrimSpace(domain) == "" {
			fail("`policies.blockedDomains` com entrada em branco")
		}
	}

	// Templates: o destino é <dataDir>/templates/<pacote>/<nome do arquivo>,
	// então dois templates com o mesmo nome de arquivo se sobrescreveriam.
	seenTemplate := map[string]bool{}
	for _, template := range p.Templates {
		if _, err := readableInside(p.Dir, template); err != nil {
			fail("template %q: %v", template, err)
			continue
		}
		base := filepath.Base(filepath.FromSlash(template))
		if seenTemplate[base] {
			fail("template %q repete o nome de arquivo %q — o segundo sobrescreveria o primeiro", template, base)
		}
		seenTemplate[base] = true
	}

	for position, hook := range p.Hooks {
		validateHook(position, hook, fail)
	}

	if len(problems) == 0 {
		return nil
	}
	return fmt.Errorf("%w: %w", ErrPack, errors.Join(problems...))
}

// hookEvents e hookActions são os conjuntos fechados que o executor de ganchos
// conhece (supervisor/hooks.go). Fechados porque gancho desconhecido não é
// "gancho que não roda" — é auditoria que a TI acha que tem e não tem.
var hookEvents = map[string]bool{
	"before_tool": true, "after_tool": true,
	"before_edit": true, "after_edit": true,
	"on_error": true, "on_complete": true,
}

var hookActions = map[string]bool{"audit": true, "webhook": true, "deny": true}

func validateHook(position int, hook HookSpec, fail func(string, ...any)) {
	where := fmt.Sprintf("gancho na posição %d", position)
	if !hookEvents[hook.On] {
		fail("%s: evento %q desconhecido (use before_tool, after_tool, before_edit, after_edit, on_error ou on_complete)", where, hook.On)
	}
	if !hookActions[hook.Action] {
		fail("%s: ação %q desconhecida (use audit, webhook ou deny)", where, hook.Action)
	}
	if hook.Action == "webhook" && strings.TrimSpace(hook.SecretRef) == "" {
		fail("%s: ação webhook exige `secretRef` — a URL do webhook mora no cofre, nunca no manifesto", where)
	}
	// Deny só faz sentido ANTES: recusar uma ferramenta que já rodou não recusa
	// nada, e aceitar a declaração fingiria uma proteção que não existe.
	if hook.Action == "deny" && hook.On != "before_tool" && hook.On != "before_edit" {
		fail("%s: ação deny só vale em before_tool/before_edit — depois do fato não há o que recusar", where)
	}
}

// validateMCPURL espelha a regra do mcphub: https em qualquer lugar, http só
// em loopback. Um conector em texto claro deixa qualquer intermediário ler o
// prompt e reescrever a resposta que o modelo obedece.
func validateMCPURL(raw string) error {
	endpoint := strings.TrimSpace(raw)
	if endpoint == "" {
		return errors.New("sem `url`")
	}
	parsed, err := url.Parse(endpoint)
	if err != nil {
		return fmt.Errorf("url inválida: %v", err)
	}
	host := parsed.Hostname()
	if host == "" {
		return fmt.Errorf("url sem host: %q", endpoint)
	}
	switch parsed.Scheme {
	case "https":
		return nil
	case "http":
		if strings.EqualFold(host, "localhost") || strings.HasPrefix(host, "127.") || host == "::1" {
			return nil
		}
		return fmt.Errorf("http só é aceito em loopback e %q não é", host)
	default:
		return fmt.Errorf("esquema %q não suportado, use https", parsed.Scheme)
	}
}

/* -------------------------------- Install -------------------------------- */

// Install aplica um pacote já validado e o PERSISTE em <dataDir>/packs/<nome>,
// de onde o boot o reaplica (ver Discover). A ordem das etapas é a do risco:
//
//  1. o overlay de especialistas primeiro, porque é a única etapa com validação
//     semântica própria (LoadOverlay é atômico) — se ela recusar, nada mudou;
//  2. depois o disco (persistência e templates), que só falha por I/O;
//  3. por último o que é em memória e não falha (prompts, conectores, ganchos,
//     políticas) — e as políticas fecham a fila porque SÓ RESTRINGEM: aplicá-las
//     por último garante que um erro anterior nunca deixa a estação mais aberta
//     do que estava.
func Install(p Pack, deps Deps) error {
	if strings.TrimSpace(deps.DataDir) == "" {
		return fmt.Errorf("%w: Deps.DataDir vazio — sem pasta de dados não há onde persistir o pacote", ErrPack)
	}
	if !validName(p.Name) {
		return fmt.Errorf("%w: pacote sem nome válido — rode Load antes de Install", ErrPack)
	}

	// (1) Overlay. A recusa dele recusa o Install inteiro, com nada aplicado.
	if deps.ApplyOverlay != nil && len(p.SpecialistsRaw) > 0 {
		if err := deps.ApplyOverlay(p.SpecialistsRaw); err != nil {
			return fmt.Errorf("pacote %s: overlay de especialistas: %w", p.Name, err)
		}
	}

	// (2) Disco: a cópia persistida e os templates.
	if err := persist(p, deps.DataDir); err != nil {
		return fmt.Errorf("pacote %s: %w", p.Name, err)
	}
	if err := copyTemplates(p, deps.DataDir); err != nil {
		return fmt.Errorf("pacote %s: %w", p.Name, err)
	}

	// (3) Conectores e ganchos.
	if deps.RegisterMCP != nil {
		for _, server := range p.MCP {
			if err := deps.RegisterMCP(server); err != nil {
				return fmt.Errorf("pacote %s: conector mcp %q: %w", p.Name, server.Name, err)
			}
		}
	}
	if deps.RegisterHooks != nil && len(p.Hooks) > 0 {
		if err := deps.RegisterHooks(p.Name, p.Hooks); err != nil {
			return fmt.Errorf("pacote %s: ganchos: %w", p.Name, err)
		}
	}

	// (4) Políticas: pack só RESTRINGE — ver mergePolicies.
	if deps.Gate != nil {
		mergePolicies(deps.Gate, p.Policies)
	}

	// (5) O registro. Depois de registrado, PromptFor passa a servir os prompts
	// deste pacote aos turnos seguintes.
	stateMu.Lock()
	installed[p.Name] = p
	root = deps.DataDir
	stateMu.Unlock()
	return nil
}

// mergePolicies SOMA as restrições do pacote à política em vigor.
//
// A regra, escrita por extenso porque ela é o contrato: o pacote só RESTRINGE,
// nunca afrouxa. `DeniedTools` e `BlockedDomains` entram em UNIÃO com o que já
// estava — nada é removido — e NENHUM campo permissivo (Mode, AgentTools,
// Allowed*) é tocado. O motivo é o mesmo do prompt master vir primeiro no
// turno: se instalar um pacote pudesse remover uma recusa do admin, o pacote
// seria a saída barata da política — bastaria publicar um "pacote" que apaga a
// blocklist.
func mergePolicies(gate *permissions.Gate, extra Policies) {
	if len(extra.DeniedTools) == 0 && len(extra.BlockedDomains) == 0 {
		return
	}
	policy := gate.Policy()
	policy.DeniedTools = union(policy.DeniedTools, extra.DeniedTools)
	policy.BlockedDomains = union(policy.BlockedDomains, extra.BlockedDomains)
	gate.SetPolicy(policy)
}

// union junta as listas sem duplicar, preservando a ordem (o que já estava
// primeiro). A comparação ignora caixa porque é assim que o Gate compara na
// hora de recusar — duas grafias da mesma ferramenta são UMA regra.
func union(base, extra []string) []string {
	out := make([]string, 0, len(base)+len(extra))
	seen := make(map[string]bool, len(base)+len(extra))
	for _, list := range [][]string{base, extra} {
		for _, item := range list {
			item = strings.TrimSpace(item)
			if item == "" {
				continue
			}
			key := strings.ToLower(item)
			if seen[key] {
				continue
			}
			seen[key] = true
			out = append(out, item)
		}
	}
	return out
}

/* ------------------------- persistência e templates ------------------------ */

// persist copia o pacote para <dataDir>/packs/<nome>: o manifesto e TODOS os
// arquivos que ele referencia, preservando os caminhos relativos. É desta
// cópia que o boot reaplica o pacote — o diretório de origem (um pendrive da
// TI, um download) não precisa continuar existindo.
func persist(p Pack, dataDir string) error {
	destination := filepath.Join(dataDir, "packs", p.Name)
	if same, err := samePath(p.Dir, destination); err == nil && same {
		// Boot: o pacote JÁ é a cópia persistida. Copiar sobre si mesmo
		// truncaria os arquivos que estão sendo lidos.
		return nil
	}

	// Reinstalar substitui: sobras da versão anterior (um prompt renomeado, um
	// template que saiu) virariam parte fantasma do pacote novo.
	if err := os.RemoveAll(destination); err != nil {
		return fmt.Errorf("limpar a cópia anterior: %w", err)
	}

	files := []string{"manifest.json"}
	if p.Specialists != "" {
		files = append(files, p.Specialists)
	}
	for _, file := range p.Prompts {
		files = append(files, file)
	}
	files = append(files, p.Templates...)

	for _, file := range files {
		source, err := readableInside(p.Dir, file)
		if err != nil {
			return fmt.Errorf("persistir %q: %w", file, err)
		}
		target := filepath.Join(destination, filepath.FromSlash(file))
		if err := copyFile(source, target); err != nil {
			return fmt.Errorf("persistir %q: %w", file, err)
		}
	}
	return nil
}

// copyTemplates materializa os modelos em <dataDir>/templates/<pacote>/ — o
// lugar único onde os especialistas de documento os procuram.
func copyTemplates(p Pack, dataDir string) error {
	if len(p.Templates) == 0 {
		return nil
	}
	destination := filepath.Join(dataDir, "templates", p.Name)
	// Recomeça do zero pela mesma razão do persist: template removido do
	// manifesto não pode sobreviver como sobra da versão anterior.
	if err := os.RemoveAll(destination); err != nil {
		return fmt.Errorf("limpar os templates anteriores: %w", err)
	}
	for _, template := range p.Templates {
		source, err := readableInside(p.Dir, template)
		if err != nil {
			return fmt.Errorf("template %q: %w", template, err)
		}
		target := filepath.Join(destination, filepath.Base(source))
		if err := copyFile(source, target); err != nil {
			return fmt.Errorf("template %q: %w", template, err)
		}
	}
	return nil
}

/* --------------------------- Installed / Remove --------------------------- */

// Installed devolve os pacotes aplicados neste processo, em ordem de nome —
// ordem estável porque a lista vai para a ferramenta `pack.list`, e mapa em Go
// itera em ordem aleatória.
func Installed() []Pack {
	stateMu.RLock()
	defer stateMu.RUnlock()
	out := make([]Pack, 0, len(installed))
	for _, p := range installed {
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// Remove apaga o pacote do disco e do registro.
//
// O que ele NÃO desfaz, de propósito: overlay, conectores, ganchos e políticas
// já aplicados continuam valendo até o próximo boot. Não é limitação aceita a
// contragosto — é a direção segura: tudo o que um pacote muda em memória ou
// RESTRINGE (política, deny) ou é catálogo que o boot seguinte reconstrói sem
// ele. Desfazer política em execução seria o único "remove" capaz de deixar a
// estação mais aberta no meio de uma sessão.
func Remove(name string) error {
	if !validName(name) {
		return fmt.Errorf("%w: nome %q inválido", ErrPack, name)
	}
	stateMu.Lock()
	defer stateMu.Unlock()
	base := root
	if base == "" {
		return fmt.Errorf("%w: nenhuma pasta de dados conhecida — instale ou descubra pacotes antes de remover", ErrPack)
	}
	if _, ok := installed[name]; !ok {
		// Ainda pode existir só no disco (instalado por outro processo): apagar
		// vale, mas o chamador precisa saber que aqui ninguém o tinha aplicado.
		if _, err := os.Stat(filepath.Join(base, "packs", name)); err != nil {
			return fmt.Errorf("%w: pacote %q não está instalado", ErrPack, name)
		}
	}
	if err := os.RemoveAll(filepath.Join(base, "packs", name)); err != nil {
		return fmt.Errorf("remover o pacote %s: %w", name, err)
	}
	if err := os.RemoveAll(filepath.Join(base, "templates", name)); err != nil {
		return fmt.Errorf("remover os templates de %s: %w", name, err)
	}
	delete(installed, name)
	return nil
}

// Describe resume os pacotes em texto — uma linha por pacote, com o que ele
// traz. É a MESMA frase para o subcomando `aibotd pack list` e a ferramenta
// `pack.list`: dois textos para o mesmo inventário divergiriam na primeira
// manutenção, e a TI confere os dois no mesmo chamado.
func Describe(packs []Pack) string {
	var out strings.Builder
	for _, p := range packs {
		fmt.Fprintf(&out, "- %s v%s", p.Name, p.Version)
		var parts []string
		if len(p.SpecialistsRaw) > 0 {
			parts = append(parts, "catálogo de especialistas")
		}
		if len(p.PromptTexts) > 0 {
			parts = append(parts, fmt.Sprintf("%d prompt(s)", len(p.PromptTexts)))
		}
		if len(p.MCP) > 0 {
			parts = append(parts, fmt.Sprintf("%d conector(es) MCP", len(p.MCP)))
		}
		if len(p.Templates) > 0 {
			parts = append(parts, fmt.Sprintf("%d template(s)", len(p.Templates)))
		}
		if len(p.Hooks) > 0 {
			parts = append(parts, fmt.Sprintf("%d gancho(s)", len(p.Hooks)))
		}
		if denied, blocked := len(p.Policies.DeniedTools), len(p.Policies.BlockedDomains); denied+blocked > 0 {
			parts = append(parts, fmt.Sprintf("políticas (+%d ferramenta(s) recusada(s), +%d domínio(s) bloqueado(s))", denied, blocked))
		}
		if len(parts) > 0 {
			fmt.Fprintf(&out, ": %s", strings.Join(parts, ", "))
		}
		out.WriteString("\n")
	}
	return strings.TrimRight(out.String(), "\n")
}

// Discover lê os pacotes persistidos em <dataDir>/packs, SEM aplicá-los — é o
// boot que decide instalar cada um. Pacote quebrado não derruba os demais: ele
// volta no erro (joined) e fica de fora da lista.
func Discover(dataDir string) ([]Pack, error) {
	entries, err := os.ReadDir(filepath.Join(dataDir, "packs"))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("listar pacotes: %w", err)
	}
	var (
		packs    []Pack
		problems []error
	)
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		loaded, err := loadDir(filepath.Join(dataDir, "packs", entry.Name()))
		if err != nil {
			problems = append(problems, fmt.Errorf("pacote %s: %w", entry.Name(), err))
			continue
		}
		packs = append(packs, loaded)
	}
	sort.Slice(packs, func(i, j int) bool { return packs[i].Name < packs[j].Name })

	stateMu.Lock()
	root = dataDir
	stateMu.Unlock()
	return packs, errors.Join(problems...)
}

/* ------------------------------- PromptFor -------------------------------- */

// PromptFor devolve o texto agregado dos prompts de pacote para um
// especialista — o que o supervisor anexa ao system dele (Deps.PackPrompt).
// A agregação percorre os pacotes em ordem de nome para o prompt final ser o
// MESMO em toda estação com os mesmos pacotes, independente da ordem de
// instalação.
func PromptFor(specialistID string) string {
	stateMu.RLock()
	defer stateMu.RUnlock()
	if len(installed) == 0 {
		return ""
	}
	names := make([]string, 0, len(installed))
	for name := range installed {
		names = append(names, name)
	}
	sort.Strings(names)

	var parts []string
	for _, name := range names {
		if text, ok := installed[name].PromptTexts[specialistID]; ok && text != "" {
			parts = append(parts, text)
		}
	}
	return strings.Join(parts, "\n\n")
}

/* --------------------------------- apoio ---------------------------------- */

// validName aceita o alfabeto que vira diretório com segurança: minúsculas,
// dígitos, `-` e `_`. É o MESMO alfabeto dos ids de especialista — e é ele que
// garante que <dataDir>/packs/<nome> nunca escapa da pasta de dados.
func validName(name string) bool {
	if name == "" || len(name) > 64 {
		return false
	}
	for _, symbol := range name {
		switch {
		case symbol >= 'a' && symbol <= 'z':
		case symbol >= '0' && symbol <= '9':
		case symbol == '-' || symbol == '_':
		default:
			return false
		}
	}
	return true
}

// insidePack resolve um caminho RELATIVO dentro do pacote, recusando o que
// escapa. Caminho absoluto ou com `..` faria o manifesto ler (e o persist
// copiar) qualquer arquivo do disco de quem instala — este é o único ponto em
// que um caminho vindo do manifesto encosta no sistema de arquivos.
func insidePack(dir, relative string) (string, error) {
	clean := strings.TrimSpace(relative)
	if clean == "" {
		return "", errors.New("caminho vazio")
	}
	if filepath.IsAbs(clean) || strings.HasPrefix(filepath.ToSlash(clean), "/") {
		return "", fmt.Errorf("caminho precisa ser relativo ao pacote: %q", relative)
	}
	for _, segment := range strings.Split(filepath.ToSlash(clean), "/") {
		if segment == ".." {
			return "", fmt.Errorf("caminho não pode sair do pacote: %q", relative)
		}
	}
	return filepath.Join(dir, filepath.FromSlash(clean)), nil
}

// readableInside devolve o caminho absoluto de um arquivo do pacote,
// conferindo que ele existe e é arquivo comum.
func readableInside(dir, relative string) (string, error) {
	path, err := insidePack(dir, relative)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", fmt.Errorf("arquivo não encontrado no pacote: %q", relative)
	}
	if info.IsDir() {
		return "", fmt.Errorf("%q é um diretório, esperava um arquivo", relative)
	}
	return path, nil
}

// readInside lê um arquivo do pacote por caminho relativo validado.
func readInside(dir, relative string) ([]byte, error) {
	path, err := readableInside(dir, relative)
	if err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("ler %q: %v", relative, err)
	}
	return raw, nil
}

// copyFile copia criando as pastas do destino. 0600/0700 como o resto da pasta
// de dados: o pacote pode carregar prompt com contexto interno da empresa.
func copyFile(source, target string) error {
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return err
	}
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}

// samePath compara dois caminhos já resolvidos em absoluto.
func samePath(a, b string) (bool, error) {
	absoluteA, err := filepath.Abs(a)
	if err != nil {
		return false, err
	}
	absoluteB, err := filepath.Abs(b)
	if err != nil {
		return false, err
	}
	return strings.EqualFold(filepath.Clean(absoluteA), filepath.Clean(absoluteB)), nil
}

/* ---------------------------------- .tar ---------------------------------- */

// extractTar materializa um pacote .tar num diretório temporário.
//
// A sanitização do nome de cada entrada não é opcional: um tar montado à mão
// pode carregar `../../qualquer/coisa` ou caminho absoluto, e extrair isso
// escreveria fora do temporário — em qualquer lugar do disco de quem instalou.
func extractTar(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", fmt.Errorf("abrir o pacote %s: %w", path, err)
	}
	defer file.Close()

	dir, err := os.MkdirTemp("", "aibot-pack-")
	if err != nil {
		return "", fmt.Errorf("criar diretório temporário: %w", err)
	}

	reader := tar.NewReader(file)
	files, total := 0, int64(0)
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			_ = os.RemoveAll(dir)
			return "", fmt.Errorf("%w: .tar ilegível: %v", ErrPack, err)
		}
		switch header.Typeflag {
		case tar.TypeDir:
			continue // as pastas nascem com o MkdirAll de cada arquivo
		case tar.TypeReg:
		default:
			// Link, device, FIFO: nada disso é dado de pacote, e um link
			// simbólico extraído vira exatamente o escape que insidePack fecha.
			return "", cleanupTarError(dir, fmt.Errorf("%w: entrada %q de tipo não suportado no .tar", ErrPack, header.Name))
		}

		files++
		if files > maxTarFiles {
			return "", cleanupTarError(dir, fmt.Errorf("%w: .tar com mais de %d arquivos", ErrPack, maxTarFiles))
		}
		if header.Size > maxTarFileSize {
			return "", cleanupTarError(dir, fmt.Errorf("%w: %q passa de %d bytes", ErrPack, header.Name, int64(maxTarFileSize)))
		}
		total += header.Size
		if total > maxTarTotal {
			return "", cleanupTarError(dir, fmt.Errorf("%w: .tar passa de %d bytes no total", ErrPack, int64(maxTarTotal)))
		}

		target, err := insidePack(dir, header.Name)
		if err != nil {
			return "", cleanupTarError(dir, fmt.Errorf("%w: entrada %q do .tar: %v", ErrPack, header.Name, err))
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			return "", cleanupTarError(dir, err)
		}
		out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
		if err != nil {
			return "", cleanupTarError(dir, err)
		}
		// LimitReader com +1: se couber um byte a mais do que o header declarou,
		// o header mentiu — e header mentiroso é tar hostil.
		if _, err := io.Copy(out, io.LimitReader(reader, header.Size+1)); err != nil {
			_ = out.Close()
			return "", cleanupTarError(dir, err)
		}
		if err := out.Close(); err != nil {
			return "", cleanupTarError(dir, err)
		}
	}
	return dir, nil
}

func cleanupTarError(dir string, err error) error {
	_ = os.RemoveAll(dir)
	return err
}
