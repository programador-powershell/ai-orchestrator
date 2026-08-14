// Este arquivo é a TRILHA A da atualização (ver docs/atualizacao.md): o
// catálogo de especialistas deixa de ser só o que foi compilado e passa a
// aceitar um catálogo PUBLICADO por cima.
//
// O compilado continua sendo o padrão, e isso não é conservadorismo: o app tem
// de abrir na PRIMEIRA execução, offline, antes de qualquer download existir.
// Um catálogo que só existe depois da rede é um app que abre em branco no
// notebook em viagem.
//
// Por que dá para atualizar isto sem instalador: um especialista é DADO —
// prompt, radicais, superfície, ferramentas, avatar. Nada disso é lógica.
// Trocar uma frase de prompt não precisa de compilador, de instalador nem de
// assinatura de código; precisa de um JSON assinado, e quem verifica a
// assinatura é o gateway (internal/update).
//
// # A regra dura: tudo ou nada
//
// Um overlay com UM especialista inválido é recusado INTEIRO. Meio catálogo
// aplicado é pior que nenhum: a tela some para metade dos ids já gravados nas
// conversas, o roteador passa a ter candidatos que a interface não desenha, e
// ninguém consegue explicar por quê olhando a tela.
//
// O que a validação existe para impedir, em concreto:
//
//   - `Surface`/`Rail` fora do conjunto conhecido — o mapa de superfícies da
//     interface é literal (apps/desktop/src/shell/Stage.tsx) e o que não está
//     nele não tem componente. O mesmo vale para as partes do avatar, cujo
//     desenho é um `switch` sem default (avatar/BotAvatar.tsx): forma
//     desconhecida é retrato vazio.
//   - especialista sem `ID` — o id é a chave do roteamento e do modo gravado
//     na conversa; sem ele a mensagem não tem para onde ir.
//   - ferramenta que não existe no registro — o especialista declararia uma
//     permissão para algo que ninguém executa, e o modelo passaria o turno
//     pedindo o que não há.
//   - catálogo sem o especialista padrão — `GetOrDefault` cai nele, e um
//     padrão ausente devolve Definition zerada: superfície vazia, tela branca.
//
// # Concorrência
//
// O catálogo é lido no CAMINHO QUENTE (Score em todo primeiro input,
// GetOrDefault em toda decoração de rota). Por isso a troca é um
// `atomic.Pointer` para um snapshot imutável, e não uma trava por leitura: a
// escrita acontece no máximo uma vez a cada seis horas, e cobrar um mutex de
// cada leitura para proteger contra ela seria pagar o tempo todo pelo que quase
// nunca acontece.

package specialist

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
)

// OverlaySchemaVersion é o contrato do documento publicado.
//
// Um documento com versão diferente é RECUSADO, inclusive quando ela é maior:
// gateway antigo não sabe ler catálogo novo, e adivinhar o que fazer com um
// campo que ele não conhece é como se aplica meio catálogo sem perceber.
const OverlaySchemaVersion = 1

// Overlay é o documento da trilha A, exatamente como ele é publicado.
//
// O master fica FORA de propósito: o prompt dele é casado com o parser de JSON
// do classificador (supervisor/classifier.go), então ele é código com cara de
// dado. Publicar um master novo para um gateway que ainda parseia o formato
// antigo quebraria o roteamento inteiro — e roteamento quebrado é o app inteiro.
type Overlay struct {
	SchemaVersion int    `json:"schemaVersion"`
	Version       string `json:"version"`
	// Specialists é o catálogo COMPLETO, na ordem de exibição. Não é um patch:
	// mesclar por id daria dois catálogos diferentes em duas estações conforme o
	// que cada uma tinha compilado, e o defeito só apareceria na estação errada.
	Specialists []Definition `json:"specialists"`
}

// ErrOverlay marca recusa de overlay. Quem chama distingue "o documento é
// inválido" de "não deu para buscar" sem ler a frase do erro.
var ErrOverlay = errors.New("overlay recusado")

// originCompiled é o que Origin() devolve enquanto ninguém publicou nada.
const originCompiled = "compilado"

// snapshot é o catálogo ATIVO. Imutável depois de publicado: quem trocar o
// catálogo monta outro e troca o ponteiro, nunca escreve neste.
type snapshot struct {
	origin string
	list   []Definition
	byID   map[string]Definition
}

var active atomic.Pointer[snapshot]

// stateMu serializa as ESCRITAS (troca de catálogo, registro de gancho,
// instalação do verificador de ferramentas). Nenhuma leitura do catálogo passa
// por aqui — elas vão direto no atomic.
var stateMu sync.Mutex

// hooks são avisados depois de toda troca, com a troca JÁ publicada.
//
// Existe por uma razão medida: o roteador monta uma vez o catálogo de
// candidatos e o mapa de radicais já normalizados (supervisor/router.go). São
// caches do catálogo — e cache que não é reconstruído na troca faz o roteador
// continuar decidindo pelo catálogo velho enquanto a tela já mostra o novo.
var hooks []func()

// toolChecker diz se uma ferramenta existe no registro do gateway.
//
// Chega por injeção porque o registro vive em internal/supervisor, que importa
// este pacote: perguntar direto a ele fecharia um ciclo de importação. Sem
// verificador instalado a checagem é PULADA, e isso é aceitável só porque o
// único caminho que não o instala é teste — no gateway de verdade o main liga.
var toolChecker func(string) bool

func init() {
	active.Store(newSnapshot(originCompiled, catalog))
}

// newSnapshot monta o catálogo ativo a partir da lista.
//
// O master entra no ÍNDICE mas não na lista: `Exists("master")` e
// `Get("master")` precisam responder (o transporte serve o avatar dele), e ao
// mesmo tempo ele não é uma opção que a pessoa escolhe na barra.
func newSnapshot(origin string, list []Definition) *snapshot {
	copied := make([]Definition, len(list))
	copy(copied, list)
	index := make(map[string]Definition, len(copied)+1)
	for _, definition := range copied {
		index[definition.ID] = definition
	}
	index[MasterID] = Master
	return &snapshot{origin: origin, list: copied, byID: index}
}

// LoadOverlay valida o documento publicado e TROCA o catálogo ativo.
//
// Erro significa que NADA mudou: o catálogo anterior — compilado ou de um
// overlay que já valia — continua inteiro de pé. É a diferença entre uma
// publicação errada custar um aviso no log e custar o app.
func LoadOverlay(raw []byte) error {
	var document Overlay
	if err := json.Unmarshal(raw, &document); err != nil {
		return fmt.Errorf("%w: não é JSON válido: %w", ErrOverlay, err)
	}

	stateMu.Lock()
	defer stateMu.Unlock()

	if err := validateOverlay(document, toolChecker); err != nil {
		return err
	}

	version := strings.TrimPrefix(strings.TrimSpace(document.Version), "v")
	active.Store(newSnapshot("publicado v"+version, document.Specialists))
	notifyLocked()
	return nil
}

// ResetOverlay volta ao catálogo compilado.
//
// É o caminho de volta quando uma publicação passa na validação e mesmo assim
// está errada — um prompt ruim, um radical que sequestra o roteamento. Sem ele
// a única saída seria publicar de novo, o que depende exatamente do servidor
// que acabou de publicar o problema.
func ResetOverlay() {
	stateMu.Lock()
	defer stateMu.Unlock()
	active.Store(newSnapshot(originCompiled, catalog))
	notifyLocked()
}

// Origin diz de onde veio o catálogo em vigor: "compilado" ou "publicado
// v0.2.0". Vai para o log de boot e para o diagnóstico — quando alguém relata
// que o especialista responde diferente do esperado, a primeira pergunta é qual
// catálogo a estação está rodando.
func Origin() string {
	return active.Load().origin
}

// OnChange registra um gancho chamado depois de toda troca de catálogo.
//
// O gancho roda com a troca JÁ publicada, então ele pode ler o catálogo novo
// por All()/Get(). Ele NÃO pode chamar LoadOverlay, ResetOverlay nem OnChange:
// a trava de escrita está segurada durante o aviso, e reentrar nela trava o
// processo. Gancho é para reconstruir cache, e é só isso que os nossos fazem.
func OnChange(hook func()) {
	if hook == nil {
		return
	}
	stateMu.Lock()
	defer stateMu.Unlock()
	hooks = append(hooks, hook)
}

// SetToolChecker liga a validação de ferramentas do overlay ao registro real do
// gateway. Chamado UMA vez, na subida, antes de qualquer busca.
func SetToolChecker(check func(name string) bool) {
	stateMu.Lock()
	defer stateMu.Unlock()
	toolChecker = check
}

// notifyLocked avisa os ganchos. Só é chamada com stateMu segurada — ver o
// contrato documentado em OnChange.
func notifyLocked() {
	for _, hook := range hooks {
		hook()
	}
}

/* ------------------------------- validação ------------------------------- */

// surfaces e rails são os conjuntos FECHADOS que a interface sabe desenhar.
// Eles espelham packages/contracts/src (SURFACES, RAILS) e o mapa literal de
// Stage.tsx — quando um valor novo nascer, os três mudam juntos.
var surfaces = map[Surface]bool{
	SurfaceConversation: true, SurfaceEditor: true, SurfaceDocument: true,
	SurfaceCanvas: true, SurfaceSchema: true, SurfaceBoard: true,
	SurfaceFindings: true, SurfaceCrew: true, SurfaceFlow: true, SurfaceTrain: true,
}

var rails = map[RailKind]bool{
	RailConversations: true, RailFiles: true, RailDocument: true,
	RailLayers: true, RailTables: true, RailTasks: true,
	RailFindings: true, RailCrew: true, RailNodes: true, RailRuns: true,
}

// As partes do avatar. O desenho é um switch sem default no cliente, então
// forma desconhecida não é "avatar diferente" — é avatar que não aparece.
var (
	avatarShapes      = set("orb", "squircle", "hex", "shield", "bloom", "chip")
	avatarEyes        = set("dot", "arc", "visor", "spark", "scan", "ring")
	avatarMouths      = set("none", "line", "smile", "wave", "grid")
	avatarAccessories = set("none", "antenna", "halo", "bolt", "glasses", "crown", "shield")
	avatarMotions     = set("idle", "breathe", "pulse", "scan", "orbit")
)

func set(values ...string) map[string]bool {
	out := make(map[string]bool, len(values))
	for _, value := range values {
		out[value] = true
	}
	return out
}

// maxIDLength é folgado para nome legível e curto o bastante para o id caber em
// seletor de CSS, atributo de dado e chave de log sem virar linha própria.
const maxIDLength = 40

// validateOverlay junta TODOS os problemas antes de recusar.
//
// Recusar no primeiro faria quem publica descobrir os erros um por um, com uma
// publicação por descoberta. Como a recusa é do documento inteiro de qualquer
// forma, listar tudo de uma vez não custa nada e economiza rodadas.
func validateOverlay(document Overlay, knownTool func(string) bool) error {
	var problems []error
	fail := func(format string, args ...any) {
		problems = append(problems, fmt.Errorf(format, args...))
	}

	if document.SchemaVersion != OverlaySchemaVersion {
		// Sai aqui mesmo: com o esquema errado, todo campo abaixo pode significar
		// outra coisa, e apontar erro de campo seria adivinhação.
		return fmt.Errorf("%w: esquema %d, este gateway lê %d",
			ErrOverlay, document.SchemaVersion, OverlaySchemaVersion)
	}
	if strings.TrimSpace(document.Version) == "" {
		fail("sem `version` — é ela que aparece no diagnóstico como o catálogo em vigor")
	}
	if len(document.Specialists) == 0 {
		fail("sem especialista nenhum — catálogo vazio é a tela sem nada para escolher")
	}

	seen := make(map[string]bool, len(document.Specialists))
	for position, definition := range document.Specialists {
		where := fmt.Sprintf("especialista na posição %d", position)
		if definition.ID != "" {
			where = fmt.Sprintf("especialista %q", definition.ID)
		}

		switch {
		case definition.ID == "":
			fail("%s: sem `id` — o id é a chave do roteamento e do modo gravado na conversa", where)
		case !validID(definition.ID):
			fail("%s: `id` fora do formato (minúsculas, dígitos, `-` e `_`, até %d caracteres)", where, maxIDLength)
		case definition.ID == MasterID:
			fail("%s: `%s` é reservado ao roteador e não entra no catálogo", where, MasterID)
		case seen[definition.ID]:
			fail("%s: `id` repetido — o segundo esconderia o primeiro no índice", where)
		default:
			seen[definition.ID] = true
		}

		if strings.TrimSpace(definition.Name) == "" {
			fail("%s: sem `name` — é o rótulo do seletor e da barra", where)
		}
		if strings.TrimSpace(definition.System) == "" {
			fail("%s: sem `system` — especialista sem prompt não tem comportamento nenhum", where)
		}
		if !surfaces[definition.Surface] {
			fail("%s: superfície %q não existe nesta interface", where, definition.Surface)
		}
		if !rails[definition.Rail] {
			fail("%s: trilho %q não existe nesta interface", where, definition.Rail)
		}
		if definition.Hue < 0 || definition.Hue > 360 {
			fail("%s: `hue` %d fora de 0..360", where, definition.Hue)
		}

		validateAvatar(where, definition.Avatar, fail)

		for _, tool := range definition.Tools {
			if strings.TrimSpace(tool) == "" {
				fail("%s: ferramenta em branco", where)
				continue
			}
			if knownTool != nil && !knownTool(tool) {
				fail("%s: a ferramenta %q não existe neste gateway — o modelo passaria o turno pedindo o que ninguém executa", where, tool)
			}
		}
		for _, trigger := range definition.Triggers {
			if strings.TrimSpace(trigger) == "" {
				fail("%s: radical em branco — casaria com qualquer texto", where)
			}
		}
		for _, action := range definition.Actions {
			if strings.TrimSpace(action.ID) == "" || strings.TrimSpace(action.Label) == "" {
				fail("%s: atalho sem `id` ou sem `label`", where)
			}
			if strings.TrimSpace(action.Insert) == "" {
				fail("%s: atalho %q não insere nada no campo", where, action.ID)
			}
		}
	}

	// O padrão precisa existir NESTE catálogo: GetOrDefault cai nele, e um padrão
	// ausente devolveria Definition zerada — superfície vazia, tela branca, para
	// toda conversa com um id que o overlay não trouxe.
	if len(document.Specialists) > 0 && !seen[DefaultID] {
		fail("o catálogo não tem %q, que é para onde cai todo id desconhecido", DefaultID)
	}

	if len(problems) == 0 {
		return nil
	}
	return fmt.Errorf("%w: %w", ErrOverlay, errors.Join(problems...))
}

func validateAvatar(where string, avatar Avatar, fail func(string, ...any)) {
	if !avatarShapes[avatar.Shape] {
		fail("%s: avatar com forma %q, que o desenho não conhece", where, avatar.Shape)
	}
	if !avatarEyes[avatar.Eyes] {
		fail("%s: avatar com olhos %q, que o desenho não conhece", where, avatar.Eyes)
	}
	if !avatarMouths[avatar.Mouth] {
		fail("%s: avatar com boca %q, que o desenho não conhece", where, avatar.Mouth)
	}
	if !avatarAccessories[avatar.Accessory] {
		fail("%s: avatar com acessório %q, que o desenho não conhece", where, avatar.Accessory)
	}
	if !avatarMotions[avatar.Motion] {
		fail("%s: avatar com movimento %q, que o desenho não conhece", where, avatar.Motion)
	}
	if avatar.Hue < 0 || avatar.Hue > 360 {
		fail("%s: `avatar.hue` %d fora de 0..360", where, avatar.Hue)
	}
	if avatar.Saturation < 0 || avatar.Saturation > 100 {
		fail("%s: `avatar.saturation` %d fora de 0..100", where, avatar.Saturation)
	}
}

// validID aceita o mesmo alfabeto que os ids compilados usam.
//
// O id não é só chave interna: ele vira atributo de dado no HTML, seletor de
// CSS e campo de log. Aceitar espaço, aspas ou maiúscula deixaria um id
// publicado quebrar seletor na interface — e a falha apareceria como estilo
// sumido, não como catálogo inválido.
func validID(id string) bool {
	if id == "" || len(id) > maxIDLength {
		return false
	}
	for _, symbol := range id {
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
