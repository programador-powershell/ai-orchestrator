// O workspace automático (estilo Grok Build): a pasta do projeto nasce quando
// um especialista de TRABALHO vai executar e a sessão ainda não tem uma.
//
// O defeito que este arquivo fecha: NENHUMA sessão nascia com cwd, então a
// árvore da IDE morria em "esta sessão não tem pasta de projeto definida" e o
// especialista recusava gravar arquivos — o bot "trabalhava" numa conversa que
// não enxergava disco nenhum. Pedir à pessoa que escolha uma pasta antes do
// primeiro arquivo é devolver a ela uma decisão que o produto sabe tomar: um
// projeto novo mora em <dataDir>/projects/<slug>, durável e nomeado pelo que
// foi pedido.
//
// É um PONTO ÚNICO de propósito. A delegação do master (masterDelegate), o
// /mode explícito e a conversa nascida no bot (hello.specialist) provisionam
// pela mesma função — duas cópias desta regra divergiriam em silêncio no dia
// em que uma mudasse, e a filha delegada herdaria uma pasta que a raiz não
// conhece.
package supervisor

import (
	"os"
	"path/filepath"
	"strings"

	"aibot/gateway/internal/protocol"
	"aibot/gateway/internal/specialist"
	"aibot/gateway/internal/store"
)

// provisionSlugMax limita a parte "humana" do slug. O sufixo com o id da
// sessão é quem garante unicidade; o título só existe para a pasta ser
// reconhecível num `ls` — e um caminho quilométrico no Windows estoura o
// MAX_PATH antes de ajudar alguém.
const provisionSlugMax = 24

// provisionaProjeto garante a pasta durável do projeto de uma sessão cujo
// especialista de TRABALHO vai executar. Devolve true quando o meta MUDOU —
// é o sinal de que o chamador precisa recongelar o workspace do turno, porque
// o congelamento do começo leu o meta antes de a pasta existir.
//
// Quando NÃO provisiona, e por quê:
//   - sessão com CWD: a pasta é uma escolha (da pessoa ou de uma provisão
//     anterior) e provisionar de novo trocaria o projeto debaixo do trabalho —
//     a segunda delegação na mesma raiz continua na MESMA pasta;
//   - especialista de conversa (ou o master): pergunta não precisa de disco, e
//     uma pasta por bate-papo encheria o projects/ de cascas vazias;
//   - falha de disco/store: o turno segue sem pasta e as ferramentas de
//     arquivo recusam com o motivo de sempre — pior que recusar seria fingir.
//
// A sessão FILHA não ganha pasta própria: ela trabalha no projeto da MÃE
// (mesmo trabalho, mesma árvore). Se a mãe tem pasta, a filha a copia; a pasta
// nova só nasce em conversa sem pai.
func (s *Supervisor) provisionaProjeto(sessionID, turn string, definition specialist.Definition, seed string) bool {
	if s.deps.Store == nil || !especialistaDeTrabalho(definition) {
		return false
	}
	meta, err := s.deps.Store.GetSession(sessionID)
	if err != nil || strings.TrimSpace(meta.CWD) != "" {
		return false
	}

	dir := ""
	if meta.ParentID != "" {
		// Filha sem pasta com mãe que tem: compartilha em vez de criar — raiz e
		// filha são o mesmo projeto, e duas pastas seriam dois "repositórios"
		// para o mesmo pedido.
		if parent, err := s.deps.Store.GetSession(meta.ParentID); err == nil {
			dir = strings.TrimSpace(parent.CWD)
		}
	}

	if dir == "" {
		if strings.TrimSpace(seed) == "" {
			seed = meta.Title
		}
		// O caminho NUNCA sai da pasta de dados: o slug só contém [a-z0-9-]
		// (projectSlug descarta separadores, `..` e afins) e é UM componente —
		// não há como um título malicioso virar traversal.
		dir = filepath.Join(s.deps.Store.Root(), "projects", projectSlug(seed, sessionID))

		// O gesto fica visível: a pessoa vê "preparando a pasta…" em vez de a
		// árvore simplesmente aparecer povoada do nada. Efêmero de propósito —
		// é etapa, não conteúdo da conversa.
		master := protocol.Actor{Kind: protocol.ActorSupervisor, ID: specialist.MasterID}
		if s.deps.Bus != nil {
			s.thinking(sessionID, turn, master, "preparando a pasta do projeto…", false)
		}
		err = os.MkdirAll(dir, 0o755)
		if s.deps.Bus != nil {
			s.thinking(sessionID, turn, master, "", true)
		}
		if err != nil {
			return false
		}
	}

	if _, err := s.deps.Store.UpdateSession(sessionID, func(m *store.SessionMeta) {
		// Recheca dentro da atualização: se outra mão gravou uma pasta entre a
		// leitura lá em cima e agora, a escolha dela vence — provisão nunca
		// sobrescreve decisão.
		if strings.TrimSpace(m.CWD) == "" {
			m.CWD = dir
		}
	}); err != nil {
		return false
	}
	return true
}

// projectSlug monta o nome da pasta em projects/: um pedaço curto e legível do
// título/pedido + o id da sessão. A colisão é impossível pelo SUFIXO — o id é
// único por sessão e uma sessão só provisiona uma vez (o CWD gravado barra a
// segunda) — e não pelo título, que pode se repetir à vontade.
func projectSlug(seed, sessionID string) string {
	name := slugify(seed, provisionSlugMax)
	id := slugify(sessionID, 64)
	if id == "" {
		// Sem id não há unicidade que prometa nada; "sessao" espelha o safeID do
		// store, que resolve o mesmo problema para as pastas de sessão.
		id = "sessao"
	}
	if name == "" {
		return "projeto-" + id
	}
	return name + "-" + id
}

// slugify reduz um texto a UM componente de caminho seguro: minúsculas, só
// [a-z0-9-], hífens colapsados. Tudo o que poderia significar outra coisa num
// caminho (`/`, `\`, `..`, `:`) vira hífen — o slug não tem como subir de
// diretório porque não tem com o quê.
func slugify(text string, limit int) string {
	var builder strings.Builder
	builder.Grow(limit)
	lastHyphen := true // começa true para não abrir com hífen
	for _, symbol := range strings.ToLower(text) {
		if builder.Len() >= limit {
			break
		}
		if (symbol >= 'a' && symbol <= 'z') || (symbol >= '0' && symbol <= '9') {
			builder.WriteRune(symbol)
			lastHyphen = false
			continue
		}
		if !lastHyphen {
			builder.WriteByte('-')
			lastHyphen = true
		}
	}
	return strings.Trim(builder.String(), "-")
}
