// Package supervisor decide QUEM atende e vigia a execução.
//
// Este arquivo é o master. A regra de produto que ele implementa é: A CONVERSA
// TEM UM MODO, decidido no PRIMEIRO input e gravado nela. Da segunda mensagem
// em diante não há classificação nenhuma — tudo vai para o mesmo executor.
//
// Reclassificar a cada linha parecia mais esperto e é pior de três jeitos:
// custa latência antes de cada resposta; faz "agora corrija o login" (que só faz
// sentido dentro do assunto anterior) ser lido como pedido isolado; e troca a
// tela debaixo de quem estava no meio de um trabalho. Modo é contexto, e
// contexto não se renegocia a cada frase.
//
// Só duas coisas mudam o modo de uma conversa em andamento:
//
//  1. `/mode <id>` escrito pela pessoa;
//  2. a escolha manual no seletor da interface (que chega como Explicit).
//
// No primeiro input, a decisão desce uma CASCATA, e o barato vem primeiro:
//
//	INPUT
//	  ↓
//	FAST ROUTER (Go puro, léxico, ~microssegundos, offline)
//	  ├── decisão óbvia ─────────────────────────────→ executor
//	  ↓ não sabemos
//	NEEDLE (modelo local de 14 MB via cgo, ~milissegundos, offline)
//	  ├── confiança OK ─────────────────────────────→ executor
//	  ↓ incerto
//	LLM (o modelo grande, rede, ~segundos)
//	  ↓
//	executor
//
// Nem toda decisão precisa de IA: "corrige o bug de compilação" tem cinco sinais
// léxicos de código e não merece uma ida à rede. E quando precisa de IA, quase
// nunca precisa da CARA: o Needle resolve o que o léxico não pega, na máquina,
// sem rede e sem custo por token. O modelo grande fica para o resto.
package supervisor

import (
	"context"
	"sort"
	"strings"
	"sync/atomic"
	"unicode"

	"aibot/gateway/internal/protocol"
	"aibot/gateway/internal/specialist"
)

// MinConfidence é a confiança mínima para o léxico decidir sozinho.
const MinConfidence = 0.55

// MinMargin é a distância mínima até o segundo colocado. Sem margem, "revisa a
// segurança desse código" (que pontua alto em security E em code) seria decidido
// por diferença de um radical — e a mesma frase cairia em especialistas
// diferentes conforme a redação, que é exatamente o que faz o roteamento
// parecer aleatório.
const MinMargin = 0.15

// saturation é onde a pontuação bruta vira confiança 1.0. Calibrado para que
// um radical específico (>=8 letras) e um genérico juntos já cheguem perto do
// limiar, e dois específicos passem com folga.
const saturation = 26.0

// NeedleMinConfidence é a confiança mínima para aceitar o veredito do modelo
// local. Abaixo dela a decisão sobe para o modelo grande.
//
// 0.78 é o limiar CALIBRADO pelo harness de pesquisa
// (needle-router-pro/config/router.json, `confidence_threshold`), medido sobre
// holdout — não um chute redondo. O próprio harness avisa que o Needle 2.0.5
// desabilita a confiança calibrada em pesos LoRA, então o `.cact` treinado só
// vale com este portão externo por cima. Um modelo de 45 milhões de parâmetros
// erra, e o custo do erro aqui é a conversa INTEIRA ir para o executor errado —
// o modo é gravado e não se reavalia. Empurrar o caso duvidoso para o modelo
// grande custa alguns segundos uma vez; errar o modo custa a conversa toda.
const NeedleMinConfidence = 0.78

// NeedleToolBudget é quantos candidatos são declarados ao Needle.
//
// Cinco porque é onde o Needle 2 renderiza as ferramentas DIRETO na gramática;
// acima disso ele liga a recuperação por embedding e escolhe as cinco melhores
// sozinho — o que acrescenta uma decisão heurística em cima da nossa, feita com
// menos informação. Como o fast router já ordena os dez, ele entrega os cinco
// primeiros e o Needle decide entre eles, na faixa em que é determinístico.
const NeedleToolBudget = 5

// ClassifierVerdict é o que um classificador devolve. Serve tanto para o Needle
// quanto para o modelo grande — o formato da resposta é o mesmo, o que muda é o
// preço.
type ClassifierVerdict struct {
	Specialist string  `json:"specialist"`
	Confidence float64 `json:"confidence"`
	Why        string  `json:"why"`
}

// Classifier é o degrau do modelo GRANDE. Fica atrás de interface para o
// roteador ser testável sem rede — e para o gateway funcionar quando não há
// modelo nenhum disponível.
type Classifier interface {
	Classify(ctx context.Context, prompt string, candidates []specialist.Definition) (ClassifierVerdict, error)
}

// IntentClassifier é o degrau do modelo LOCAL (Needle).
//
// Interface separada de Classifier de propósito, ainda que a assinatura seja
// igual: são degraus diferentes da cascata, com limiares diferentes, e um pode
// existir sem o outro. Amarrar os dois no mesmo tipo faria "sem Needle" e "sem
// rede" virarem a mesma configuração.
type IntentClassifier interface {
	Intent(ctx context.Context, prompt string, candidates []specialist.Definition) (ClassifierVerdict, error)
	// Ready diz se a biblioteca nativa está carregada. Falso quando o build saiu
	// sem a tag `needle` ou quando a DLL não foi encontrada — e aí a cascata
	// pula o degrau em vez de falhar.
	Ready() bool
}

// RouteInput é tudo o que a decisão considera.
type RouteInput struct {
	// Text é o prompt cru da pessoa (ainda com o `/mode`, se houver).
	Text string
	// Explicit é o especialista escolhido na mão pelo seletor da interface.
	Explicit string
	// Current é o modo JÁ GRAVADO na conversa. Preenchido = a conversa tem modo,
	// e nada mais é classificado.
	Current string
	// Allowed limita os candidatos ao que a política liberou. Vazio = todos.
	Allowed []string
	// Attachments são os NOMES dos anexos do prompt. Só a extensão importa:
	// formato de arquivo é sinal FORTE de destino — quem manda um .docx quer
	// trabalhar no documento, diga o texto o que disser. Como todo sinal de
	// classificação, só conta no PRIMEIRO input: anexo em conversa com modo não
	// reclassifica nada.
	Attachments []string
}

// Router é o master.
type Router struct {
	needle     IntentClassifier
	classifier Classifier
}

// NewRouter monta o roteador.
//
// Os dois classificadores podem ser nil, e a cascata encurta sozinha: sem
// Needle ela é léxico → modelo grande; sem nenhum dos dois é léxico → chat. É
// degradação, não falha — o app precisa abrir e funcionar numa estação sem a
// biblioteca nativa e sem rede.
func NewRouter(needle IntentClassifier, classifier Classifier) *Router {
	return &Router{needle: needle, classifier: classifier}
}

// ParseModeCommand extrai o `/mode <id>` do início do texto.
//
// Devolve o modo pedido, o texto SEM o comando e se houve comando. O comando
// vale sozinho ("/mode code") ou com o pedido na mesma linha
// ("/mode code corrige o login") — obrigar duas mensagens para trocar de modo e
// pedir a coisa seria uma cerimônia que ninguém cumpre.
func ParseModeCommand(text string) (mode string, rest string, ok bool) {
	trimmed := strings.TrimSpace(text)
	if !strings.HasPrefix(trimmed, "/mode") {
		return "", text, false
	}
	after := strings.TrimSpace(trimmed[len("/mode"):])
	if after == "" {
		return "", text, false
	}
	// Corta no primeiro ESPAÇO EM BRANCO, não no literal " ": quem escreve
	// `/mode office`, aperta Shift+Enter e digita o pedido na linha de baixo
	// mandava o candidato "office\ncorrige", que não existe no catálogo — o
	// comando era devolvido como texto comum e a troca de modo simplesmente não
	// acontecia, sem uma palavra de aviso.
	candidate, remainder := after, ""
	if index := strings.IndexFunc(after, unicode.IsSpace); index >= 0 {
		candidate, remainder = after[:index], after[index:]
	}
	candidate = strings.ToLower(strings.TrimSpace(candidate))
	if !specialist.Exists(candidate) || candidate == specialist.MasterID {
		// Modo inexistente NÃO é comando: fica como texto e o master trata como
		// pergunta. Engolir "/mode xpto" em silêncio faria a pessoa achar que
		// trocou de modo quando não trocou.
		return "", text, false
	}
	return candidate, strings.TrimSpace(remainder), true
}

// Route decide quem atende.
func (r *Router) Route(ctx context.Context, in RouteInput) protocol.Route {
	candidates := candidatesFor(in.Allowed)
	if len(candidates) == 0 {
		return decorate(protocol.Route{
			Specialist: specialist.DefaultID,
			Previous:   in.Current,
			Reason:     protocol.RouteFallback,
		})
	}

	text := in.Text
	explicit := in.Explicit
	// `/mode` vence o seletor: é a escolha mais recente e a mais deliberada.
	denied := ""
	if requested, rest, found := ParseModeCommand(in.Text); found {
		if allowedContains(candidates, requested) {
			explicit = requested
			text = rest
		} else {
			// O modo pedido existe no catálogo mas a POLÍTICA o barra.
			//
			// Antes o pedido era aceito aqui, o texto era esvaziado junto, e só
			// depois o id caía fora na checagem de permissão — a cascata inteira
			// descia com prompt VAZIO, gastando o Needle e o modelo grande para
			// classificar nada, e gravava na conversa um modo que ninguém pediu.
			// Agora o comando é reconhecido e RECUSADO: o modo não troca, e o
			// pedido que veio junto continua com quem já atendia.
			denied = requested
			text = rest
		}
	}

	if denied != "" {
		blocked := "modo " + denied + " bloqueado pela política desta sessão"
		// Com dono, a conversa fica onde está. Sem dono E sem pedido junto, não há
		// o que classificar — devolver o padrão aqui evita descer a cascata com
		// texto vazio.
		if keep := in.Current; keep != "" && allowedContains(candidates, keep) {
			return decorate(protocol.Route{
				Specialist: keep,
				Previous:   in.Current,
				Reason:     protocol.RouteSticky,
				Confidence: 1,
				Signals:    []string{blocked},
			})
		}
		if strings.TrimSpace(text) == "" {
			return decorate(protocol.Route{
				Specialist: candidates[0].ID,
				Previous:   in.Current,
				Reason:     protocol.RouteFallback,
				Signals:    []string{blocked},
			})
		}
		// Sobrou pedido de verdade numa conversa sem dono: a cascata decide pelo
		// conteúdo, como decidiria se o `/mode` não tivesse sido escrito.
	}

	// --- escolha explícita ---
	if explicit != "" && allowedContains(candidates, explicit) {
		return decorate(protocol.Route{
			Specialist: explicit,
			Previous:   in.Current,
			Reason:     protocol.RouteExplicit,
			Confidence: 1,
		})
	}

	// --- a conversa JÁ TEM modo ---
	//
	// Este é o caminho de quase toda mensagem, e ele custa zero: nada é
	// pontuado, nenhum modelo é chamado, nem o local. "agora corrija o login"
	// vai direto para o executor de código porque a conversa já é de código.
	if in.Current != "" && allowedContains(candidates, in.Current) {
		return decorate(protocol.Route{
			Specialist: in.Current,
			Previous:   in.Current,
			Reason:     protocol.RouteSticky,
			Confidence: 1,
		})
	}

	// A partir daqui é o PRIMEIRO input da conversa. Só ele desce a cascata.

	// --- degrau 1: fast router (Go puro) ---
	scores := Score(text, candidates)

	// Anexo entra ANTES do limiar léxico: depois da escolha explícita, é o
	// sinal mais deliberado que existe — a pessoa ESCOLHEU um arquivo, enquanto
	// radical é coincidência de vocabulário. A pontuação é somada (texto capado
	// + peso por anexo; ver combineAttachments): um anexo decisivo encerra a
	// decisão aqui, e um empate entre formatos segue a cascata levando o
	// ranking combinado para o shortlist dos degraus seguintes.
	if len(in.Attachments) > 0 {
		combined, decisive := combineAttachments(scores, in.Attachments, candidates)
		if decisive {
			top := combined[0]
			return decorate(protocol.Route{
				Specialist: top.ID,
				Previous:   in.Current,
				Reason:     protocol.RouteHeuristic,
				Confidence: top.Confidence,
				Signals:    top.Signals,
			})
		}
		scores = combined
	}

	if len(scores) > 0 {
		top := scores[0]
		runnerUp := 0.0
		if len(scores) > 1 {
			runnerUp = scores[1].Confidence
		}
		if top.Confidence >= MinConfidence && top.Confidence-runnerUp >= MinMargin {
			return decorate(protocol.Route{
				Specialist: top.ID,
				Previous:   in.Current,
				Reason:     protocol.RouteHeuristic,
				Confidence: top.Confidence,
				Signals:    top.Signals,
			})
		}
	}

	// --- degrau 2: Needle, na máquina ---
	if r.needle != nil && r.needle.Ready() {
		// O fast router já ordenou os dez; entregamos os cinco melhores para o
		// Needle decidir na faixa em que ele renderiza a gramática direto.
		shortlist := shortlistFor(scores, candidates, NeedleToolBudget)
		verdict, err := r.needle.Intent(ctx, text, shortlist)
		if err == nil && allowedContains(candidates, verdict.Specialist) &&
			verdict.Confidence >= NeedleMinConfidence {
			return decorate(protocol.Route{
				Specialist: verdict.Specialist,
				Previous:   in.Current,
				Reason:     protocol.RouteNeedle,
				Confidence: verdict.Confidence,
			})
		}
	}

	// --- degrau 3: o modelo grande ---
	if r.classifier != nil {
		verdict, err := r.classifier.Classify(ctx, text, candidates)
		if err == nil && allowedContains(candidates, verdict.Specialist) {
			confidence := verdict.Confidence
			if confidence <= 0 || confidence > 1 {
				// Modelo que devolve confiança fora da faixa não derruba o turno;
				// só não merece que se acredite no número dele.
				confidence = MinConfidence
			}
			return decorate(protocol.Route{
				Specialist: verdict.Specialist,
				Previous:   in.Current,
				Reason:     protocol.RouteModel,
				Confidence: confidence,
			})
		}
	}

	fallback := specialist.DefaultID
	if !allowedContains(candidates, fallback) {
		fallback = candidates[0].ID
	}
	return decorate(protocol.Route{
		Specialist: fallback,
		Previous:   in.Current,
		Reason:     protocol.RouteFallback,
		Confidence: 0.25,
	})
}

// shortlistFor devolve os `limit` melhores candidatos segundo o fast router,
// completando com o resto do catálogo quando o léxico não pontuou o bastante.
//
// Completar importa: se o texto não casou com radical nenhum, `scores` vem
// vazio e o Needle receberia ZERO ferramentas — decidindo nada, sempre.
func shortlistFor(scores []Scored, candidates []specialist.Definition, limit int) []specialist.Definition {
	if limit <= 0 || limit >= len(candidates) {
		return candidates
	}
	byID := make(map[string]specialist.Definition, len(candidates))
	for _, definition := range candidates {
		byID[definition.ID] = definition
	}

	out := make([]specialist.Definition, 0, limit)
	taken := make(map[string]bool, limit)
	for _, scored := range scores {
		if len(out) >= limit {
			break
		}
		if definition, ok := byID[scored.ID]; ok && !taken[scored.ID] {
			out = append(out, definition)
			taken[scored.ID] = true
		}
	}
	for _, definition := range candidates {
		if len(out) >= limit {
			break
		}
		if !taken[definition.ID] {
			out = append(out, definition)
			taken[definition.ID] = true
		}
	}
	return out
}

/* -------------------------------- anexos --------------------------------- */

// attachmentWeight é o peso de UM anexo reconhecido na pontuação combinada.
//
// Dois × saturation, e não um número redondo qualquer, porque a garantia de
// "extensão vence radical" vem da aritmética: a parcela de TEXTO entra capada
// em `saturation` (a confiança já satura ali — acima disso o léxico não fica
// "mais certo", só mais verboso), então com o dobro do teto UM anexo passa
// QUALQUER pontuação de radical, inclusive a de um texto entupido de palavras
// de código. Sem o cap não haveria peso que garantisse: a soma léxica não tem
// teto teórico.
const attachmentWeight = 2 * saturation

// extensionOwner mapeia a extensão do anexo para o especialista dono do
// formato.
//
// A lista é decisão de produto, não detecção de MIME: quem manda um .docx quer
// trabalhar NO documento, quem manda um .sql quer o dado. Extensão ambígua
// (json, md, html, css…) fica FORA de propósito — melhor descer a cascata sem
// opinião do que errar com convicção.
var extensionOwner = map[string]string{
	// Documentos de escritório: o artefato final é o arquivo binário.
	"docx": "office", "pptx": "office", "xlsx": "office", "pdf": "office", "odt": "office",
	// Dados: consulta, base e amostra.
	"sql": "data", "db": "data", "csv": "data",
	// Design: imagem — e vídeo, que por decisão de produto mora lá.
	"png": "design", "jpg": "design", "jpeg": "design", "svg": "design", "fig": "design",
	"mp4": "design", "mov": "design", "webm": "design", "srt": "design",
	// Código-fonte.
	"go": "code", "rs": "code", "ts": "code", "tsx": "code", "py": "code", "js": "code",
	"jsx": "code", "java": "code", "c": "code", "h": "code", "cpp": "code", "cs": "code",
	"rb": "code", "php": "code", "kt": "code", "swift": "code", "sh": "code", "ps1": "code",
	// Fine-tuning: dataset e pesos.
	"jsonl": "tune", "gguf": "tune", "safetensors": "tune",
}

// extensionOf extrai a extensão do nome, minúscula e sem o ponto. Vazio quando
// não há extensão — e aí o anexo simplesmente não opina.
func extensionOf(name string) string {
	dot := strings.LastIndexByte(name, '.')
	if dot < 0 || dot == len(name)-1 {
		return ""
	}
	return strings.ToLower(name[dot+1:])
}

// combineAttachments soma o peso dos anexos à pontuação léxica do texto.
//
// Devolve o ranking combinado e se o primeiro colocado é DECISIVO: estritamente
// à frente do segundo e com pelo menos um anexo a seu favor. A parcela de texto
// entra capada em saturation (Confidence×saturation É o bruto capado — nada a
// recalcular), então um anexo sozinho vence qualquer radical; anexos de donos
// diferentes disputam por quantidade e o texto desempata; e o empate EXATO não
// decide — segue para os degraus seguintes com o ranking combinado, que é o que
// alimenta o shortlist do Needle e as opções de clarificação.
//
// Sem anexo reconhecido (extensão desconhecida, ou dono barrado pela política)
// devolve as pontuações INTACTAS: prompt sem anexo roteia exatamente como
// antes.
func combineAttachments(scores []Scored, names []string, candidates []specialist.Definition) ([]Scored, bool) {
	attachRaw := make(map[string]float64, 2)
	attachSignals := make(map[string][]string, 2)
	for _, name := range names {
		extension := extensionOf(name)
		owner, known := extensionOwner[extension]
		if !known || !allowedContains(candidates, owner) {
			// Dono fora da política não pontua: rotear para quem o admin barrou
			// seria usar o anexo como porta de trás da lista.
			continue
		}
		attachRaw[owner] += attachmentWeight
		// O sinal vai para a tela do mesmo jeito que um radical iria: quem passa
		// o mouse na rota precisa ver O QUE pesou — aqui, o arquivo.
		attachSignals[owner] = append(attachSignals[owner], "anexo ."+extension)
	}
	if len(attachRaw) == 0 {
		return scores, false
	}

	raw := make(map[string]float64, len(scores)+len(attachRaw))
	signals := make(map[string][]string, len(scores)+len(attachRaw))
	for _, scored := range scores {
		raw[scored.ID] = scored.Confidence * saturation
		signals[scored.ID] = scored.Signals
	}
	for id, points := range attachRaw {
		raw[id] += points
		// Anexo na frente dos radicais: foi ele que decidiu, e a ordem dos
		// sinais é a ordem em que a explicação se lê.
		signals[id] = append(append([]string{}, attachSignals[id]...), signals[id]...)
	}

	out := make([]Scored, 0, len(raw))
	for id, value := range raw {
		confidence := value / saturation
		if confidence > 1 {
			confidence = 1
		}
		out = append(out, Scored{ID: id, Confidence: confidence, Signals: signals[id]})
	}
	// O bruto ordena (a confiança capada empata em 1.0 justamente nos casos que
	// interessam), e o id desempata pelo mesmo motivo do Score: empate não pode
	// virar sorteio entre execuções.
	sort.SliceStable(out, func(i, j int) bool {
		if raw[out[i].ID] != raw[out[j].ID] {
			return raw[out[i].ID] > raw[out[j].ID]
		}
		return out[i].ID < out[j].ID
	})

	decisive := attachRaw[out[0].ID] > 0 &&
		(len(out) == 1 || raw[out[0].ID] > raw[out[1].ID])
	return out, decisive
}

// decorate preenche o que a tela precisa junto com a decisão.
func decorate(route protocol.Route) protocol.Route {
	definition := specialist.GetOrDefault(route.Specialist)
	route.Specialist = definition.ID
	route.Surface = string(definition.Surface)
	return route
}

/* ---------------------------- classificador ---------------------------- */

// Scored é a pontuação de um especialista para um texto.
type Scored struct {
	ID         string
	Confidence float64
	Signals    []string
}

// Score pontua cada candidato contra o texto, do maior para o menor.
//
// Exportada porque é o coração do roteamento e precisa de teste próprio: um
// erro aqui não quebra nada visivelmente, só manda a conversa para o
// especialista errado de vez em quando — o tipo de defeito que sobrevive anos.
func Score(text string, candidates []specialist.Definition) []Scored {
	normalized := Normalize(text)
	if normalized == "" {
		return nil
	}

	// UMA leitura do ponteiro para a chamada inteira. Consultar o atômico a cada
	// radical seria ~150 leituras por Score, e ainda deixaria a pontuação de um
	// mesmo texto misturar dois catálogos se a troca caísse no meio do laço.
	cache := activeCatalog()

	out := make([]Scored, 0, len(candidates))
	for _, definition := range candidates {
		raw := 0.0
		var signals []string
		for _, trigger := range definition.Triggers {
			needle := cache.trigger(trigger)
			if needle == "" {
				continue
			}
			position := strings.Index(normalized, needle)
			if position < 0 {
				continue
			}
			// Radical específico vale mais que genérico: "vulnerab" só aparece
			// em pedido de segurança, "test" aparece em qualquer lugar.
			weight := float64(len(needle))
			if isWordStart(normalized, position) {
				// Casar no começo da palavra distingue "cor" de "corrige".
				weight *= 1.5
			}
			raw += weight
			if signals == nil {
				// Capacidade só no PRIMEIRO sinal, e não antes do laço: a maioria
				// dos especialistas não casa com radical nenhum, e reservar espaço
				// para todos eles alocaria dez fatias por chamada para descartar
				// oito. Medido: 10 alocações por Score contra 15, e ~9% menos
				// tempo. Oito cabe folgado no maior conjunto de sinais que um
				// especialista do catálogo produz.
				signals = make([]string, 0, 8)
			}
			signals = append(signals, trigger)
		}
		if raw == 0 {
			continue
		}
		confidence := raw / saturation
		if confidence > 1 {
			confidence = 1
		}
		out = append(out, Scored{ID: definition.ID, Confidence: confidence, Signals: signals})
	}

	// Ordem estável: confiança desc, depois id asc. Sem o desempate por id, dois
	// especialistas empatados trocariam de lugar entre execuções e a margem do
	// segundo colocado viraria sorteio.
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Confidence != out[j].Confidence {
			return out[i].Confidence > out[j].Confidence
		}
		return out[i].ID < out[j].ID
	})
	return out
}

// isWordStart diz se a posição começa uma palavra.
func isWordStart(text string, position int) bool {
	if position == 0 {
		return true
	}
	previous := rune(text[position-1])
	return !unicode.IsLetter(previous) && !unicode.IsDigit(previous)
}

// fold mapeia as letras acentuadas do português (mais as do espanhol que
// aparecem em texto colado) para a forma sem acento.
//
// Feito à mão porque a normalização Unicode não está na biblioteca padrão do Go,
// e trazer golang.org/x/text para dobrar dezoito letras seria uma dependência
// inteira — com revisão de TI/SI — por causa de um mapa.
var fold = map[rune]rune{
	'á': 'a', 'à': 'a', 'â': 'a', 'ã': 'a', 'ä': 'a', 'å': 'a',
	'é': 'e', 'è': 'e', 'ê': 'e', 'ë': 'e',
	'í': 'i', 'ì': 'i', 'î': 'i', 'ï': 'i',
	'ó': 'o', 'ò': 'o', 'ô': 'o', 'õ': 'o', 'ö': 'o',
	'ú': 'u', 'ù': 'u', 'û': 'u', 'ü': 'u',
	'ç': 'c', 'ñ': 'n', 'ý': 'y',
}

// Normalize deixa o texto comparável: minúsculas, sem acento, com os espaços
// colapsados. É o mesmo tratamento aplicado ao texto e aos radicais — se só um
// lado fosse dobrado, "segurança" nunca casaria com "seguranc".
func Normalize(text string) string {
	var builder strings.Builder
	builder.Grow(len(text))
	space := false
	// unicode.ToLower rune a rune, e não strings.ToLower na frase inteira: dá o
	// mesmo resultado (strings.ToLower é exatamente isto por dentro) sem
	// materializar uma string intermediária que só existe para ser percorrida.
	for _, symbol := range text {
		symbol = unicode.ToLower(symbol)
		// O mapa só é consultado fora do ASCII. Toda chave de `fold` é letra
		// acentuada, portanto acima de 0x7F: para 'a'..'z', espaço e pontuação —
		// a esmagadora maioria dos bytes de qualquer texto — a consulta era
		// garantidamente um erro e mesmo assim custava um hash por caractere.
		if symbol > unicode.MaxASCII {
			if folded, ok := fold[symbol]; ok {
				symbol = folded
			}
		}
		if unicode.IsSpace(symbol) {
			space = true
			continue
		}
		if space && builder.Len() > 0 {
			builder.WriteRune(' ')
		}
		space = false
		builder.WriteRune(symbol)
	}
	return builder.String()
}

/* ------------------------------ candidatos ------------------------------ */

// routerCatalog é o catálogo do jeito que o roteador precisa dele: a fatia de
// candidatos materializada e os radicais já normalizados.
//
// As duas coisas são caches, e existem por medida:
//
//   - specialist.All() devolve uma fatia nova a cada chamada, e Route chama
//     candidatesFor em TODA mensagem — inclusive no caminho sticky, que é o de
//     quase todas elas e que a arquitetura promete custar zero. Como Definition
//     carrega prompt, ações e ferramentas, essa cópia dava 4 KB alocados por
//     mensagem só para depois perguntar se um id está na lista.
//   - dobrar os ~150 radicais a cada Score era refazer para sempre um trabalho
//     cujo resultado não muda entre publicações.
//
// A fatia é tratada como SOMENTE LEITURA daqui para baixo. Isso não afrouxa
// nenhuma garantia: a cópia de All() sempre foi rasa — Triggers, Tools e
// Actions já eram compartilhados com o catálogo —, então quem escrevesse nela
// já corrompia o registro global.
type routerCatalog struct {
	candidates []specialist.Definition
	normalized map[string]string
}

// catalogCache guarda o routerCatalog em vigor.
//
// Ponteiro atômico, e não mapa fixo de inicialização, porque o catálogo DEIXOU
// de ser constante: a trilha A publica um catálogo novo a quente
// (specialist.LoadOverlay). Cache montado uma vez e nunca reconstruído era
// exatamente o defeito a evitar — a tela mostraria o catálogo publicado
// enquanto o roteador continuaria pontuando pelos radicais do compilado.
var catalogCache atomic.Pointer[routerCatalog]

func init() {
	rebuildCatalogCache()
	// O gancho fecha o ciclo. Sem ele os caches acima seriam a única parte do
	// gateway que não enxerga a publicação.
	specialist.OnChange(rebuildCatalogCache)
}

func rebuildCatalogCache() {
	candidates := specialist.All()
	index := make(map[string]string, 256)
	for _, definition := range candidates {
		for _, trigger := range definition.Triggers {
			if _, done := index[trigger]; done {
				continue
			}
			index[trigger] = Normalize(trigger)
		}
	}
	catalogCache.Store(&routerCatalog{candidates: candidates, normalized: index})
}

func activeCatalog() *routerCatalog {
	return catalogCache.Load()
}

// trigger devolve o radical já dobrado, do cache quando ele é do catálogo
// ativo.
//
// O caminho de fora do cache não é sobra: Score é exportada e recebe qualquer
// []specialist.Definition — os testes montam especialistas à mão para exercitar
// desempate, e um overlay recém-publicado traz radicais que o cache anterior
// não tinha. Cair para Normalize mantém esses casos com o MESMO resultado, só
// sem o atalho.
func (c *routerCatalog) trigger(raw string) string {
	if folded, cached := c.normalized[raw]; cached {
		return folded
	}
	return Normalize(raw)
}

func candidatesFor(allowed []string) []specialist.Definition {
	catalog := activeCatalog().candidates
	if len(allowed) == 0 {
		return catalog
	}
	permitted := make(map[string]bool, len(allowed))
	for _, id := range allowed {
		permitted[id] = true
	}
	out := make([]specialist.Definition, 0, len(catalog))
	for _, definition := range catalog {
		if permitted[definition.ID] {
			out = append(out, definition)
		}
	}
	return out
}

func allowedContains(candidates []specialist.Definition, id string) bool {
	for _, definition := range candidates {
		if definition.ID == id {
			return true
		}
	}
	return false
}
