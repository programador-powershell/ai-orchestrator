// O LAÇO: quem pergunta ao servidor, de tempos em tempos, se há publicação
// nova — e o que ele faz com cada trilha.
//
// A divisão de trabalho, que é o desenho inteiro em três linhas:
//
//	A · dado     aplica NA HORA, sem reiniciar nada
//	C · gateway  prepara `aibotd.new` e para aí; quem troca é a casca
//	B/D          este serviço só ANUNCIA — bundle e instalador não são dele
//
// Duas regras governam tudo aqui:
//
//  1. Sem chave pública, o serviço NÃO SOBE. Buscar sem verificar é pior do
//     que não buscar: dá ao produto a aparência de ter atualização segura e a
//     um servidor qualquer o poder de entregar o próximo aibotd.
//  2. Falha de rede NÃO é erro visível. Ela é registrada e a próxima passada
//     tenta de novo. O app precisa funcionar no notebook em viagem, e um aviso
//     vermelho de "não consegui atualizar" a cada seis horas treina a pessoa a
//     ignorar avisos — inclusive os que importam.

package update

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"aibot/gateway/internal/protocol"
)

// DefaultInterval é de seis horas.
//
// Curto o bastante para uma correção de prompt chegar no mesmo dia de trabalho,
// e longo o bastante para mil estações não virarem carga no servidor de
// publicação. O caso urgente não é resolvido diminuindo isto: é resolvido pelo
// fato de a trilha A aplicar sem reiniciar, então a espera é a única latência.
const DefaultInterval = 6 * time.Hour

// checkTimeout limita UMA passada inteira (manifesto + artefatos).
//
// Sem ele, um servidor que aceita a conexão e transmite um byte por minuto
// prende a goroutine até o fim do processo — e a passada seguinte nunca
// acontece. Generoso porque o artefato do gateway tem dezenas de megabytes.
const checkTimeout = 10 * time.Minute

// DefaultChannel é o canal de quem não escolheu.
const DefaultChannel = "stable"

// DefaultProduct é o nome que o manifesto precisa declarar.
const DefaultProduct = "AI-BOT"

// ArtifactSpecialists é o id do artefato de catálogo de especialistas — a
// trilha A. O nome é combinado com quem publica.
const ArtifactSpecialists = "specialists"

// Options é tudo o que o serviço precisa saber.
type Options struct {
	// ManifestURL é AIBOT_UPDATE_MANIFEST_URL. Vazia desliga o serviço.
	ManifestURL string
	// PublicKey é a chave EMBUTIDA no build. Vazia desliga o serviço — ver a
	// regra 1 no cabeçalho.
	PublicKey ed25519.PublicKey
	// Channel é o canal desta estação. Manifesto de outro canal é ignorado sem
	// erro: `beta` publicando não é problema nenhum para quem está em `stable`.
	Channel string
	// Product protege contra apontar a estação para o manifesto de outro
	// produto assinado pela mesma chave.
	Product string
	// Version é a versão do aibotd EM EXECUÇÃO. É a régua do `Newer`.
	Version string
	// ShellVersion é a versão da casca instalada, quando ela se dá a conhecer
	// (AIBOT_SHELL_VERSION). Vazia significa "não sei", e não "é antiga": o
	// piso deixa de ser conferido em vez de bloquear tudo.
	ShellVersion string
	// Executable é o aibotd em execução — o vizinho de quem o `aibotd.new` fica.
	Executable string

	Fetcher *Fetcher

	// ApplyData é quem aplica cada artefato da trilha A, por id. O id
	// `specialists` cai em specialist.LoadOverlay. Artefato de dado sem quem o
	// aplique é IGNORADO (e registrado): é uma publicação que fala de algo que
	// esta versão do gateway ainda não conhece.
	ApplyData map[string]func(raw []byte) error

	// Announce leva o resultado às janelas abertas. Nil desliga o aviso, e o
	// serviço continua aplicando — o aviso é sobre o que ficou PENDENTE.
	Announce func(protocol.State)

	Interval time.Duration
	Log      *slog.Logger
}

// Status é o que uma passada encontrou.
type Status struct {
	// Version é a versão publicada.
	Version string
	// Tracks são as trilhas PENDENTES — o que ainda precisa de um reinício, de
	// uma reabertura ou do instalador.
	//
	// A trilha A não entra aqui depois de aplicada, e é de propósito: dado
	// chega em segundos e não pede nada de ninguém. Anunciar "há atualização"
	// para algo que já está valendo é pedir que a pessoa reinicie o app à toa,
	// e treiná-la a reiniciar por nada é como o aviso da atualização que
	// IMPORTA vira ruído.
	Tracks []string
	// Available é `len(Tracks) > 0`.
	Available bool
}

// Service é o laço.
type Service struct {
	opts Options
	log  *slog.Logger
}

// NewService monta o serviço. Nada acontece até Start.
func NewService(opts Options) *Service {
	if opts.Interval <= 0 {
		opts.Interval = DefaultInterval
	}
	if strings.TrimSpace(opts.Channel) == "" {
		opts.Channel = DefaultChannel
	}
	if strings.TrimSpace(opts.Product) == "" {
		opts.Product = DefaultProduct
	}
	log := opts.Log
	if log == nil {
		log = slog.Default()
	}
	return &Service{opts: opts, log: log}
}

// ErrDisabled marca o serviço que não sobe por falta de configuração.
var ErrDisabled = errors.New("atualização desligada")

// Start dispara a sincronização em segundo plano e devolve na hora.
//
// Erro significa que o serviço NÃO SUBIU, e quem chama registra o motivo. Não é
// falha de boot: um gateway sem atualização automática continua sendo um
// gateway inteiro, e derrubar o app porque a chave não foi embutida trocaria
// "não atualiza" por "não abre".
func (s *Service) Start(ctx context.Context) error {
	switch {
	case s.opts.Fetcher == nil:
		return fmt.Errorf("%w: sem buscador", ErrDisabled)
	case strings.TrimSpace(s.opts.ManifestURL) == "":
		return fmt.Errorf("%w: sem %s", ErrDisabled, "AIBOT_UPDATE_MANIFEST_URL")
	case len(s.opts.PublicKey) == 0:
		return fmt.Errorf("%w: %w — buscar sem verificar seria entregar o próximo aibotd a quem responder a URL", ErrDisabled, ErrNoPublicKey)
	case len(s.opts.PublicKey) != ed25519.PublicKeySize:
		return fmt.Errorf("%w: a chave pública tem %d bytes, e Ed25519 usa %d",
			ErrDisabled, len(s.opts.PublicKey), ed25519.PublicKeySize)
	}

	// O catálogo publicado volta a valer ANTES da primeira busca. Sem isto, todo
	// reinício do sidecar (que acontece a cada abertura do app, e também logo
	// depois de uma atualização da trilha C) devolveria a estação ao catálogo
	// compilado — e ela só sairia dele na PRÓXIMA publicação, que pode levar
	// semanas. Aplicar dado a quente sem lembrar do que se aplicou é aplicar
	// dado até o próximo fechamento da janela.
	s.restore()

	go func() {
		ticker := time.NewTicker(s.opts.Interval)
		defer ticker.Stop()
		for {
			s.checkOnce(ctx)
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	return nil
}

// checkOnce é uma passada com o desfecho no log. A parte testável é Check, que
// devolve erro em vez de escrever.
func (s *Service) checkOnce(parent context.Context) {
	ctx, cancel := context.WithTimeout(parent, checkTimeout)
	defer cancel()

	status, err := s.Check(ctx)
	if err != nil {
		// A URL não vai para o log: link de publicação costuma carregar token na
		// query, e log de boot vira anexo de chamado.
		s.log.Info("atualização indisponível agora — tentando de novo na próxima passada", "motivo", err)
		return
	}
	if !status.Available {
		return
	}
	s.log.Info("atualização preparada", "versao", status.Version, "trilhas", strings.Join(status.Tracks, ","))
}

// Check faz UMA passada: busca o manifesto, aplica a trilha A, prepara a C e
// anuncia o que ficou pendente.
//
// Erro aqui é só o que impediu a passada de acontecer (rede, assinatura,
// manifesto ilegível). O que é decisão — outro canal, outro produto, versão
// igual ou menor — devolve Status vazio e nenhum erro: não houve falha, houve
// resposta.
func (s *Service) Check(ctx context.Context) (Status, error) {
	// Start já teria recusado, mas Check é exportada e o teste a chama direto:
	// sem esta linha, um serviço montado pela metade estoura em pânico dentro do
	// buscador em vez de dizer o que falta.
	if s.opts.Fetcher == nil {
		return Status{}, fmt.Errorf("%w: sem buscador", ErrDisabled)
	}
	manifest, err := s.opts.Fetcher.Manifest(ctx, s.opts.ManifestURL, s.opts.PublicKey)
	if err != nil {
		return Status{}, err
	}

	if !strings.EqualFold(strings.TrimSpace(manifest.Product), s.opts.Product) {
		// Assinado e ainda assim recusado: a mesma chave pode assinar a
		// publicação de outro produto do time, e instalar o cérebro do produto
		// errado é pior do que não instalar nada.
		s.log.Warn("manifesto de outro produto, ignorado", "produto", manifest.Product)
		return Status{}, nil
	}
	if !strings.EqualFold(strings.TrimSpace(manifest.Channel), s.opts.Channel) {
		s.log.Debug("manifesto de outro canal, ignorado", "canal", manifest.Channel, "estacao", s.opts.Channel)
		return Status{}, nil
	}
	// Igual ou menor não faz nada. Isso vale INCLUSIVE para reverter: voltar é
	// publicar um número MAIOR apontando para os artefatos antigos — que já
	// estão no disco, endereçados por hash, e por isso não são baixados de novo.
	// Publicar um número menor não seria "voltar", seria uma publicação que
	// nenhuma estação enxerga.
	if !manifest.Newer(s.opts.Version) {
		s.log.Debug("nada novo", "publicada", manifest.Version, "em_uso", s.opts.Version)
		return Status{}, nil
	}

	pending := make([]string, 0, len(manifest.Artifacts))

	// --- trilha A: aplica agora ---
	for _, artifact := range manifest.Artifacts {
		if artifact.Track != TrackData {
			continue
		}
		s.applyData(ctx, artifact, manifest.Version)
	}

	// --- trilha C: prepara e para ---
	if artifact, found := manifest.ArtifactFor(TrackGateway); found {
		if path, err := PrepareGateway(ctx, s.opts.Fetcher, artifact, s.executable()); err != nil {
			s.log.Warn("não foi possível preparar o gateway novo", "motivo", err)
		} else {
			s.log.Info("gateway novo pronto para o próximo início", "arquivo", filepath.Base(path))
			pending = append(pending, string(TrackGateway))
		}
	}

	// --- trilhas B e D: só o aviso ---
	//
	// O bundle da interface é trocado pela casca na próxima abertura e o
	// instalador é escolha da pessoa. Nenhum dos dois é aplicado daqui — quem
	// verifica o bundle é a casca, e quem instala é o updater do Tauri.
	if _, found := manifest.ArtifactFor(TrackUI); found {
		pending = append(pending, string(TrackUI))
	}
	if _, found := manifest.ArtifactFor(TrackShell); found {
		pending = append(pending, string(TrackShell))
	}
	// Casca abaixo do piso declarado entra como pendência mesmo sem artefato de
	// casca no manifesto: é a única forma de a pessoa saber que o resto da
	// publicação está esperando por um instalador que só ela pode rodar.
	if !s.shellSupports(manifest) && !contains(pending, string(TrackShell)) {
		s.log.Warn("a casca instalada está abaixo do piso do manifesto",
			"piso", manifest.MinimumShellVersion, "instalada", s.opts.ShellVersion)
		pending = append(pending, string(TrackShell))
	}

	status := Status{Version: manifest.Version, Tracks: pending, Available: len(pending) > 0}
	s.announce(status)
	return status, nil
}

// announce publica o KindState. Só quando há pendência: estado sem novidade
// nenhuma é tráfego que a tela descarta.
func (s *Service) announce(status Status) {
	if !status.Available || s.opts.Announce == nil {
		return
	}
	s.opts.Announce(protocol.State{
		UpdateAvailable: true,
		UpdateVersion:   status.Version,
		UpdateTracks:    status.Tracks,
	})
}

// shellSupports diz se a casca alcança o piso do manifesto. Casca que não se
// identificou não bloqueia nada — "não sei" não é "é antiga".
func (s *Service) shellSupports(manifest Manifest) bool {
	if strings.TrimSpace(s.opts.ShellVersion) == "" {
		return true
	}
	return manifest.SupportedByShell(s.opts.ShellVersion)
}

func (s *Service) executable() string {
	if s.opts.Executable != "" {
		return s.opts.Executable
	}
	path, err := os.Executable()
	if err != nil {
		return ""
	}
	return path
}

/* ------------------------------- trilha A -------------------------------- */

// applyData baixa, aplica e REGISTRA o artefato de dado.
//
// Falhar aqui não interrompe a passada: uma publicação com o catálogo de
// modelos quebrado não pode impedir o catálogo de especialistas de chegar, e
// muito menos o gateway novo de ser preparado.
func (s *Service) applyData(ctx context.Context, artifact Artifact, version string) {
	apply, known := s.opts.ApplyData[artifact.ID]
	if !known {
		s.log.Info("artefato de dado sem quem o aplique nesta versão do gateway — ignorado", "id", artifact.ID)
		return
	}
	if s.alreadyApplied(artifact) {
		return
	}

	path, err := s.opts.Fetcher.Artifact(ctx, artifact)
	if err != nil {
		s.log.Warn("não foi possível baixar o dado publicado", "id", artifact.ID, "motivo", err)
		return
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		s.log.Warn("não foi possível ler o dado publicado", "id", artifact.ID, "motivo", err)
		return
	}
	if err := apply(raw); err != nil {
		// Recusa de conteúdo, não de rede: o documento chegou inteiro e
		// assinado, e mesmo assim não descreve um catálogo utilizável. O log
		// carrega o motivo por extenso porque é ele que quem publicou precisa
		// ler para consertar.
		s.log.Warn("dado publicado recusado — seguindo com o anterior", "id", artifact.ID, "motivo", err)
		return
	}
	s.log.Info("dado publicado aplicado", "id", artifact.ID, "versao", version)
	s.remember(version, artifact)
}

/* ---------------------------- memória em disco ---------------------------- */

// appliedFile guarda o que já foi aplicado, para sobreviver ao reinício.
const appliedFile = "applied.json"

type appliedState struct {
	Version string `json:"version"`
	// KeyID é a impressão da chave pública que verificou o manifesto de onde
	// estes artefatos vieram.
	//
	// Existe para a rotação de chave. Trocar a chave embutida é o que se faz
	// quando a anterior foi comprometida — e se o registro não amarrasse os dois,
	// a estação continuaria reaplicando, a cada subida, o catálogo que a chave
	// comprometida assinou, até a próxima publicação chegar. Com a impressão
	// gravada, chave diferente descarta o que ficou para trás.
	KeyID     string     `json:"keyId"`
	Artifacts []Artifact `json:"artifacts"`
}

// keyID é a impressão curta da chave pública. Hash e não os bytes: chave
// pública não é segredo, mas registro que guarda material de chave convida
// alguém a copiá-lo de volta para o lugar errado.
func keyID(key ed25519.PublicKey) string {
	if len(key) == 0 {
		return ""
	}
	sum := sha256.Sum256(key)
	return hex.EncodeToString(sum[:8])
}

// restore reaplica o que a última execução tinha aplicado.
//
// O arquivo NÃO é assinado, e não precisa ser: ele só aponta para artefatos que
// continuam no disco, e cada um é reconferido contra o tamanho e o SHA-256 que
// vieram do manifesto assinado. Um artefato adulterado depois de gravado
// reprova aqui exatamente como reprovaria no download.
//
// O que este arquivo NÃO protege é o caso de alguém com escrita no diretório de
// dados: quem chega lá também alcança o cofre de segredos e o catálogo de
// modelos. Essa é a fronteira de confiança do DataDir inteiro, não uma folga
// desta função.
func (s *Service) restore() {
	state, err := s.readApplied()
	if err != nil || state == nil {
		if err != nil {
			s.log.Warn("não foi possível ler o que já havia sido aplicado", "motivo", err)
		}
		return
	}
	if state.KeyID != keyID(s.opts.PublicKey) {
		s.log.Warn("o dado aplicado antes veio de outra chave de publicação — descartado, seguindo com o compilado")
		return
	}
	for _, artifact := range state.Artifacts {
		apply, known := s.opts.ApplyData[artifact.ID]
		if !known {
			continue
		}
		path, ok := s.verifiedPath(artifact)
		if !ok {
			s.log.Warn("o dado aplicado antes não confere mais com o publicado — voltando ao compilado", "id", artifact.ID)
			continue
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			s.log.Warn("não foi possível reler o dado aplicado", "id", artifact.ID, "motivo", err)
			continue
		}
		if err := apply(raw); err != nil {
			s.log.Warn("o dado aplicado antes não vale mais para esta versão do gateway", "id", artifact.ID, "motivo", err)
			continue
		}
		s.log.Info("dado publicado restaurado", "id", artifact.ID, "versao", state.Version)
	}
}

// alreadyApplied diz se o artefato é exatamente o que já está valendo. Evita
// reaplicar (e re-registrar) o mesmo catálogo a cada seis horas.
func (s *Service) alreadyApplied(artifact Artifact) bool {
	state, err := s.readApplied()
	if err != nil || state == nil {
		return false
	}
	if state.KeyID != keyID(s.opts.PublicKey) {
		// Registro de outra chave não conta como aplicado: o dado dele foi
		// descartado no restore, então pular a aplicação deixaria a estação sem
		// catálogo publicado nenhum.
		return false
	}
	for _, applied := range state.Artifacts {
		if applied.ID == artifact.ID && strings.EqualFold(applied.SHA256, artifact.SHA256) {
			_, ok := s.verifiedPath(artifact)
			return ok
		}
	}
	return false
}

// remember grava o que passou a valer, substituindo o registro do mesmo id.
func (s *Service) remember(version string, artifact Artifact) {
	state, err := s.readApplied()
	if err != nil {
		s.log.Warn("não foi possível ler o registro do que está aplicado", "motivo", err)
	}
	if state == nil || state.KeyID != keyID(s.opts.PublicKey) {
		// Chave diferente recomeça o registro: misturar artefatos de duas chaves
		// no mesmo arquivo faria a checagem da rotação valer para uns e não para
		// outros.
		state = &appliedState{}
	}
	state.Version = version
	state.KeyID = keyID(s.opts.PublicKey)
	replaced := false
	for i, applied := range state.Artifacts {
		if applied.ID == artifact.ID {
			state.Artifacts[i] = artifact
			replaced = true
			break
		}
	}
	if !replaced {
		state.Artifacts = append(state.Artifacts, artifact)
	}
	if err := s.writeApplied(state); err != nil {
		// Não desfaz nada: o catálogo já está valendo nesta execução. O preço de
		// não conseguir gravar é reaplicar na próxima subida, não perder o que
		// acabou de ser aplicado.
		s.log.Warn("não foi possível registrar o que foi aplicado", "motivo", err)
	}
}

func (s *Service) appliedPath() string {
	return filepath.Join(s.opts.Fetcher.dir, appliedFile)
}

func (s *Service) readApplied() (*appliedState, error) {
	raw, err := os.ReadFile(s.appliedPath())
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var state appliedState
	if err := json.Unmarshal(raw, &state); err != nil {
		return nil, fmt.Errorf("ler %s: %w", appliedFile, err)
	}
	return &state, nil
}

func (s *Service) writeApplied(state *appliedState) error {
	if err := os.MkdirAll(s.opts.Fetcher.dir, 0o700); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	temporary := s.appliedPath() + ".tmp"
	if err := os.WriteFile(temporary, raw, 0o600); err != nil {
		return err
	}
	if err := os.Rename(temporary, s.appliedPath()); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	return nil
}

// verifiedPath devolve o caminho do artefato em disco, só se ele ainda casar
// com o tamanho e o hash declarados.
func (s *Service) verifiedPath(artifact Artifact) (string, bool) {
	digest, err := parseDigest(artifact.SHA256)
	if err != nil {
		return "", false
	}
	if err := checkArtifactID(artifact.ID); err != nil {
		return "", false
	}
	path := artifactPath(s.opts.Fetcher.dir, artifact.ID, digest)
	ok, err := fileMatches(path, artifact.Size, digest)
	if err != nil || !ok {
		return "", false
	}
	return path, true
}

func contains(list []string, value string) bool {
	for _, each := range list {
		if each == value {
			return true
		}
	}
	return false
}
