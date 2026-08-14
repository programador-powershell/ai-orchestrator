// Testes do laço da atualização e da trilha C.
//
// A pergunta que todos respondem é a mesma: em que condições este serviço se
// RECUSA a agir? Ele existe para trazer código de fora e deixá-lo pronto para
// rodar na estação de quem instalou o AI-BOT, então cada porta que ele mantém
// fechada — sem chave, outro canal, outro produto, versão que não é mais nova —
// vale mais que qualquer coisa que ele saiba fazer.
package update

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"aibot/gateway/internal/protocol"
)

/* --------------------------------- apoio ---------------------------------- */

func quietLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, &slog.HandlerOptions{Level: slog.LevelError}))
}

// publisher é o servidor de publicação de mentira: serve o que foi registrado e
// conta quantas vezes cada caminho foi buscado.
type publisher struct {
	server *httptest.Server
	files  map[string][]byte
	hits   atomic.Int64
}

func newPublisher(t *testing.T) *publisher {
	t.Helper()
	p := &publisher{files: make(map[string][]byte)}
	p.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, ok := p.files[r.URL.Path]
		if !ok {
			http.NotFound(w, r)
			return
		}
		p.hits.Add(1)
		_, _ = w.Write(body)
	}))
	t.Cleanup(p.server.Close)
	return p
}

// publish registra um artefato e devolve a descrição dele para o manifesto.
func (p *publisher) publish(track Track, id, path string, content []byte) Artifact {
	p.files[path] = content
	sum := sha256.Sum256(content)
	return Artifact{
		Track:  track,
		ID:     id,
		URL:    p.server.URL + path,
		Size:   int64(len(content)),
		SHA256: hex.EncodeToString(sum[:]),
	}
}

// manifest assina e serve o manifesto, devolvendo a URL dele.
func (p *publisher) manifest(t *testing.T, private ed25519.PrivateKey, m Manifest) string {
	t.Helper()
	signed := sign(t, private, m)
	raw, err := json.Marshal(signed)
	if err != nil {
		t.Fatalf("serializar o manifesto: %v", err)
	}
	p.files["/manifest.json"] = raw
	return p.server.URL + "/manifest.json"
}

// scenario junta o que quase todo teste precisa: chaves, servidor, buscador
// apontado para um diretório temporário e um lugar de mentira para o executável.
type scenario struct {
	public     ed25519.PublicKey
	private    ed25519.PrivateKey
	publisher  *publisher
	fetcher    *Fetcher
	guard      *loopbackNet
	installDir string
	applied    [][]byte
	announced  []protocol.State
}

func newScenario(t *testing.T) *scenario {
	t.Helper()
	public, private := keyPair(t)
	guard := &loopbackNet{}
	return &scenario{
		public:     public,
		private:    private,
		publisher:  newPublisher(t),
		fetcher:    &Fetcher{guard: guard, dir: t.TempDir()},
		guard:      guard,
		installDir: t.TempDir(),
	}
}

// service monta o serviço do cenário. `mutate` ajusta as opções do caso.
func (s *scenario) service(mutate func(*Options)) *Service {
	opts := Options{
		PublicKey: s.public,
		Channel:   DefaultChannel,
		Version:   "0.1.0",
		// O executável de mentira: o `aibotd.new` é gravado ao lado dele.
		Executable: filepath.Join(s.installDir, "aibotd.exe"),
		Fetcher:    s.fetcher,
		ApplyData: map[string]func([]byte) error{
			ArtifactSpecialists: func(raw []byte) error {
				s.applied = append(s.applied, raw)
				return nil
			},
		},
		Announce: func(state protocol.State) { s.announced = append(s.announced, state) },
		Log:      quietLogger(),
	}
	if mutate != nil {
		mutate(&opts)
	}
	return NewService(opts)
}

func (s *scenario) pendingGateway() string {
	return filepath.Join(s.installDir, GatewayPendingName)
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

/* ---------------------------- o serviço não sobe -------------------------- */

// A recusa mais importante do pacote: sem chave pública, NADA acontece — nem
// uma requisição sai. Buscar sem verificar daria a quem responder a URL o poder
// de entregar o próximo cérebro do produto.
func TestStartRefusesWithoutPublicKey(t *testing.T) {
	scene := newScenario(t)
	url := scene.publisher.manifest(t, scene.private, sampleManifest())

	service := scene.service(func(o *Options) {
		o.ManifestURL = url
		o.PublicKey = nil
	})

	err := service.Start(context.Background())
	if err == nil {
		t.Fatal("Start subiu sem chave pública")
	}
	if !errors.Is(err, ErrDisabled) || !errors.Is(err, ErrNoPublicKey) {
		t.Errorf("erro %v — esperava dizer que está desligado E que falta a chave", err)
	}
	if checks := scene.guard.checks.Load(); checks != 0 {
		t.Errorf("o guarda foi consultado %d vez(es): sem chave não pode sair requisição nenhuma", checks)
	}
	if hits := scene.publisher.hits.Load(); hits != 0 {
		t.Errorf("o servidor de publicação foi buscado %d vez(es) sem chave", hits)
	}
}

func TestStartRefusesWithATruncatedKey(t *testing.T) {
	scene := newScenario(t)
	service := scene.service(func(o *Options) {
		o.ManifestURL = "https://exemplo.com/manifest.json"
		// Chave cortada por erro de build: recusar é melhor do que descobrir no
		// pânico de ed25519.Verify, com o processo inteiro caindo.
		o.PublicKey = ed25519.PublicKey(scene.public[:16])
	})

	err := service.Start(context.Background())
	if err == nil {
		t.Fatal("Start subiu com uma chave de tamanho errado")
	}
	if !errors.Is(err, ErrDisabled) {
		t.Errorf("erro %v — esperava ErrDisabled", err)
	}
}

func TestStartRefusesWithoutManifestURL(t *testing.T) {
	scene := newScenario(t)
	service := scene.service(func(o *Options) { o.ManifestURL = "  " })

	err := service.Start(context.Background())
	if err == nil {
		t.Fatal("Start subiu sem URL de manifesto")
	}
	if !strings.Contains(err.Error(), "AIBOT_UPDATE_MANIFEST_URL") {
		t.Errorf("o erro não diz qual configuração falta: %v", err)
	}
}

/* ------------------------------ o que ignora ------------------------------ */

func TestCheckIgnoresManifestFromAnotherChannel(t *testing.T) {
	scene := newScenario(t)
	data := scene.publisher.publish(TrackData, ArtifactSpecialists, "/specialists.json", []byte(`{"schemaVersion":1}`))
	gateway := scene.publisher.publish(TrackGateway, "aibotd", "/aibotd.exe", []byte("MZ binário novo"))

	manifest := sampleManifest()
	manifest.Channel = "beta"
	manifest.Version = "9.9.9"
	manifest.Artifacts = []Artifact{data, gateway}
	url := scene.publisher.manifest(t, scene.private, manifest)

	// A estação está em `stable`.
	service := scene.service(func(o *Options) { o.ManifestURL = url })

	status, err := service.Check(context.Background())
	if err != nil {
		// Não é erro: é uma resposta que não interessa a esta estação.
		t.Fatalf("Check devolveu erro para um manifesto de outro canal: %v", err)
	}
	if status.Available {
		t.Error("um manifesto de outro canal foi anunciado como disponível")
	}
	if len(scene.applied) != 0 {
		t.Errorf("o dado de outro canal foi aplicado (%d vez(es))", len(scene.applied))
	}
	if exists(scene.pendingGateway()) {
		t.Error("o gateway de outro canal foi preparado")
	}
	if len(scene.announced) != 0 {
		t.Error("houve anúncio para um manifesto de outro canal")
	}
}

func TestCheckIgnoresManifestFromAnotherProduct(t *testing.T) {
	scene := newScenario(t)
	manifest := sampleManifest()
	manifest.Product = "OUTRO-PRODUTO"
	manifest.Version = "9.9.9"
	manifest.Artifacts = []Artifact{
		scene.publisher.publish(TrackGateway, "aibotd", "/aibotd.exe", []byte("MZ de outro produto")),
	}
	url := scene.publisher.manifest(t, scene.private, manifest)

	service := scene.service(func(o *Options) { o.ManifestURL = url })

	status, err := service.Check(context.Background())
	if err != nil {
		t.Fatalf("Check: %v", err)
	}
	if status.Available {
		t.Error("o manifesto de outro produto foi aceito — a mesma chave pode assinar a publicação de outro produto do time")
	}
	if exists(scene.pendingGateway()) {
		t.Error("o binário de outro produto foi gravado como aibotd.new")
	}
}

func TestCheckDoesNothingForTheSameOrOlderVersion(t *testing.T) {
	for _, published := range []string{"0.4.0", "0.3.9", "0.1.0"} {
		t.Run("publicada_"+published, func(t *testing.T) {
			scene := newScenario(t)
			manifest := sampleManifest()
			manifest.Version = published
			manifest.Artifacts = []Artifact{
				scene.publisher.publish(TrackData, ArtifactSpecialists, "/specialists.json", []byte(`{"schemaVersion":1}`)),
				scene.publisher.publish(TrackGateway, "aibotd", "/aibotd.exe", []byte("MZ binário novo")),
			}
			url := scene.publisher.manifest(t, scene.private, manifest)

			// A estação já está na 0.4.0.
			service := scene.service(func(o *Options) {
				o.ManifestURL = url
				o.Version = "0.4.0"
			})

			status, err := service.Check(context.Background())
			if err != nil {
				t.Fatalf("Check: %v", err)
			}
			if status.Available {
				t.Errorf("a versão %q foi tratada como novidade sobre a 0.4.0", published)
			}
			if len(scene.applied) != 0 {
				t.Error("o dado foi reaplicado sem publicação nova")
			}
			if exists(scene.pendingGateway()) {
				t.Error("um gateway que não é mais novo foi preparado")
			}
		})
	}
}

// A comparação é semântica: 0.10.0 é MAIS NOVA que 0.9.0, ainda que como texto
// seja menor. É o defeito que faria o app parar de se atualizar na décima versão
// menor, em silêncio.
func TestCheckAcceptsTheTenthMinorVersion(t *testing.T) {
	scene := newScenario(t)
	manifest := sampleManifest()
	manifest.Version = "0.10.0"
	manifest.Artifacts = []Artifact{
		scene.publisher.publish(TrackGateway, "aibotd", "/aibotd.exe", []byte("MZ binário novo")),
	}
	url := scene.publisher.manifest(t, scene.private, manifest)

	service := scene.service(func(o *Options) {
		o.ManifestURL = url
		o.Version = "0.9.0"
	})

	status, err := service.Check(context.Background())
	if err != nil {
		t.Fatalf("Check: %v", err)
	}
	if !status.Available {
		t.Fatal("0.10.0 não foi considerada mais nova que 0.9.0")
	}
}

/* --------------------------- aplica A, prepara C -------------------------- */

func TestCheckAppliesDataAndPreparesTheGateway(t *testing.T) {
	scene := newScenario(t)
	catalog := []byte(`{"schemaVersion":1,"version":"0.2.0","specialists":[]}`)
	binary := []byte("MZ este é o aibotd novo")

	manifest := sampleManifest()
	manifest.Version = "0.2.0"
	manifest.MinimumShellVersion = ""
	manifest.Artifacts = []Artifact{
		scene.publisher.publish(TrackData, ArtifactSpecialists, "/specialists.json", catalog),
		scene.publisher.publish(TrackGateway, "aibotd", "/aibotd.exe", binary),
	}
	url := scene.publisher.manifest(t, scene.private, manifest)

	service := scene.service(func(o *Options) { o.ManifestURL = url })

	status, err := service.Check(context.Background())
	if err != nil {
		t.Fatalf("Check: %v", err)
	}

	// --- trilha A: aplicou ---
	if len(scene.applied) != 1 {
		t.Fatalf("o dado foi aplicado %d vez(es), esperava 1", len(scene.applied))
	}
	if string(scene.applied[0]) != string(catalog) {
		t.Error("o conteúdo aplicado não é o publicado")
	}

	// --- trilha C: preparou e PAROU ---
	pending := scene.pendingGateway()
	written, err := os.ReadFile(pending)
	if err != nil {
		t.Fatalf("ler %s: %v", GatewayPendingName, err)
	}
	if string(written) != string(binary) {
		t.Error("o aibotd.new não tem os bytes publicados")
	}
	if exists(filepath.Join(scene.installDir, "aibotd.exe")) {
		t.Error("o executável em uso foi criado/substituído — quem troca é a casca, no próximo início")
	}
	if exists(pending + ".part") {
		t.Error("sobrou um .part ao lado do aibotd.new")
	}

	// --- o aviso ---
	if !status.Available {
		t.Fatal("o status não ficou disponível com um gateway pendente")
	}
	if status.Version != "0.2.0" {
		t.Errorf("versão anunciada %q, esperava 0.2.0", status.Version)
	}
	if len(status.Tracks) != 1 || status.Tracks[0] != string(TrackGateway) {
		// A trilha de dado NÃO entra: ela já está valendo e não pede nada de
		// ninguém. Anunciá-la treinaria a pessoa a reiniciar o app à toa.
		t.Errorf("trilhas pendentes %v, esperava só %q", status.Tracks, TrackGateway)
	}
	if len(scene.announced) != 1 {
		t.Fatalf("houve %d anúncio(s), esperava 1", len(scene.announced))
	}
	state := scene.announced[0]
	if !state.UpdateAvailable || state.UpdateVersion != "0.2.0" || len(state.UpdateTracks) != 1 {
		t.Errorf("o estado anunciado foi %+v", state)
	}
}

// Dado que aplica sozinho não vira aviso: uma publicação só de catálogo chega em
// segundos e não pede nada de ninguém.
func TestCheckDoesNotAnnounceADataOnlyPublication(t *testing.T) {
	scene := newScenario(t)
	manifest := sampleManifest()
	manifest.Version = "0.2.0"
	manifest.MinimumShellVersion = ""
	manifest.Artifacts = []Artifact{
		scene.publisher.publish(TrackData, ArtifactSpecialists, "/specialists.json", []byte(`{"a":1}`)),
	}
	url := scene.publisher.manifest(t, scene.private, manifest)

	service := scene.service(func(o *Options) { o.ManifestURL = url })
	status, err := service.Check(context.Background())
	if err != nil {
		t.Fatalf("Check: %v", err)
	}
	if len(scene.applied) != 1 {
		t.Fatalf("o dado não foi aplicado")
	}
	if status.Available || len(scene.announced) != 0 {
		t.Errorf("uma publicação só de dado virou aviso: %+v", status)
	}
}

// Documento assinado e íntegro que o aplicador RECUSA (um catálogo inválido, por
// exemplo) não derruba a passada: o gateway novo continua sendo preparado.
func TestCheckSurvivesDataRefusedByTheApplier(t *testing.T) {
	scene := newScenario(t)
	manifest := sampleManifest()
	manifest.Version = "0.2.0"
	manifest.MinimumShellVersion = ""
	manifest.Artifacts = []Artifact{
		scene.publisher.publish(TrackData, ArtifactSpecialists, "/specialists.json", []byte(`{"a":1}`)),
		scene.publisher.publish(TrackGateway, "aibotd", "/aibotd.exe", []byte("MZ binário novo")),
	}
	url := scene.publisher.manifest(t, scene.private, manifest)

	service := scene.service(func(o *Options) {
		o.ManifestURL = url
		o.ApplyData = map[string]func([]byte) error{
			ArtifactSpecialists: func([]byte) error { return errors.New("catálogo inválido") },
		}
	})

	status, err := service.Check(context.Background())
	if err != nil {
		t.Fatalf("Check virou erro por causa de um dado recusado: %v", err)
	}
	if !exists(scene.pendingGateway()) {
		t.Error("o gateway novo não foi preparado porque o catálogo publicado era inválido")
	}
	if !status.Available {
		t.Error("o status não ficou disponível")
	}
}

// Artefato de dado que este gateway não sabe aplicar é ignorado — e não impede
// o resto da publicação.
func TestCheckIgnoresUnknownDataArtifact(t *testing.T) {
	scene := newScenario(t)
	manifest := sampleManifest()
	manifest.Version = "0.2.0"
	manifest.MinimumShellVersion = ""
	manifest.Artifacts = []Artifact{
		scene.publisher.publish(TrackData, "coisa-do-futuro", "/futuro.json", []byte(`{}`)),
	}
	url := scene.publisher.manifest(t, scene.private, manifest)

	service := scene.service(func(o *Options) { o.ManifestURL = url })
	if _, err := service.Check(context.Background()); err != nil {
		t.Fatalf("Check: %v", err)
	}
	if len(scene.applied) != 0 {
		t.Error("um artefato desconhecido foi entregue ao aplicador do catálogo")
	}
}

/* -------------------------------- a casca --------------------------------- */

func TestCheckAnnouncesTheShellWhenItIsBelowTheFloor(t *testing.T) {
	scene := newScenario(t)
	manifest := sampleManifest()
	manifest.Version = "0.2.0"
	manifest.MinimumShellVersion = "0.5.0"
	manifest.Artifacts = []Artifact{
		scene.publisher.publish(TrackData, ArtifactSpecialists, "/specialists.json", []byte(`{"a":1}`)),
	}
	url := scene.publisher.manifest(t, scene.private, manifest)

	service := scene.service(func(o *Options) {
		o.ManifestURL = url
		o.ShellVersion = "0.4.0"
	})

	status, err := service.Check(context.Background())
	if err != nil {
		t.Fatalf("Check: %v", err)
	}
	if !contains(status.Tracks, string(TrackShell)) {
		t.Errorf("trilhas %v — a casca abaixo do piso precisa aparecer, senão a pessoa nunca sabe que falta rodar o instalador", status.Tracks)
	}
}

// Casca que não se identificou não bloqueia nem anuncia nada: "não sei" não é
// "é antiga".
func TestCheckDoesNotClaimTheShellIsOldWhenItIsUnknown(t *testing.T) {
	scene := newScenario(t)
	manifest := sampleManifest()
	manifest.Version = "0.2.0"
	manifest.MinimumShellVersion = "0.5.0"
	manifest.Artifacts = []Artifact{
		scene.publisher.publish(TrackData, ArtifactSpecialists, "/specialists.json", []byte(`{"a":1}`)),
	}
	url := scene.publisher.manifest(t, scene.private, manifest)

	service := scene.service(func(o *Options) {
		o.ManifestURL = url
		o.ShellVersion = ""
	})

	status, err := service.Check(context.Background())
	if err != nil {
		t.Fatalf("Check: %v", err)
	}
	if contains(status.Tracks, string(TrackShell)) {
		t.Errorf("trilhas %v — sem saber a versão da casca não dá para dizer que ela está velha", status.Tracks)
	}
}

/* ------------------------------ falha de rede ----------------------------- */

// Falha de rede não é erro visível: Check devolve erro, o laço registra e tenta
// de novo. Nada é aplicado e nada é anunciado.
func TestCheckReportsNetworkFailureWithoutTouchingAnything(t *testing.T) {
	scene := newScenario(t)
	service := scene.service(func(o *Options) {
		o.ManifestURL = "https://exemplo.com/manifest.json"
		o.Fetcher = &Fetcher{guard: blockingNet{}, dir: t.TempDir()}
	})

	if _, err := service.Check(context.Background()); err == nil {
		t.Fatal("Check não relatou a recusa do guarda de rede")
	}
	if len(scene.applied) != 0 || len(scene.announced) != 0 {
		t.Error("houve aplicação ou anúncio com a rede indisponível")
	}

	// E o laço sobe assim mesmo: o app precisa funcionar offline.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := service.Start(ctx); err != nil {
		t.Errorf("Start recusou por causa da rede: %v", err)
	}
}

/* ----------------------------- entre execuções ---------------------------- */

// O catálogo publicado tem de sobreviver ao reinício do sidecar. Sem isto, toda
// abertura do app voltaria ao catálogo compilado e só sairia dele na PRÓXIMA
// publicação — que pode levar semanas.
func TestStartRestoresTheDataAppliedByAPreviousRun(t *testing.T) {
	scene := newScenario(t)
	catalog := []byte(`{"schemaVersion":1,"version":"0.2.0","specialists":[]}`)
	manifest := sampleManifest()
	manifest.Version = "0.2.0"
	manifest.MinimumShellVersion = ""
	manifest.Artifacts = []Artifact{
		scene.publisher.publish(TrackData, ArtifactSpecialists, "/specialists.json", catalog),
	}
	url := scene.publisher.manifest(t, scene.private, manifest)

	first := scene.service(func(o *Options) { o.ManifestURL = url })
	if _, err := first.Check(context.Background()); err != nil {
		t.Fatalf("primeira passada: %v", err)
	}
	if len(scene.applied) != 1 {
		t.Fatalf("a primeira passada não aplicou o dado")
	}

	// Segunda execução: mesmo diretório, SEM rede nenhuma.
	scene.applied = nil
	second := NewService(Options{
		ManifestURL: url,
		PublicKey:   scene.public,
		Version:     "0.1.0",
		Fetcher:     &Fetcher{guard: blockingNet{}, dir: scene.fetcher.dir},
		ApplyData: map[string]func([]byte) error{
			ArtifactSpecialists: func(raw []byte) error {
				scene.applied = append(scene.applied, raw)
				return nil
			},
		},
		Log: quietLogger(),
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := second.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if len(scene.applied) != 1 {
		t.Fatalf("a segunda execução restaurou %d vez(es), esperava 1", len(scene.applied))
	}
	if string(scene.applied[0]) != string(catalog) {
		t.Error("o dado restaurado não é o que estava aplicado")
	}
}

// E o que foi adulterado no disco depois de gravado NÃO é restaurado: o
// registro aponta para o artefato, mas quem manda é o hash do manifesto.
func TestStartDoesNotRestoreAnArtifactChangedOnDisk(t *testing.T) {
	scene := newScenario(t)
	manifest := sampleManifest()
	manifest.Version = "0.2.0"
	manifest.MinimumShellVersion = ""
	manifest.Artifacts = []Artifact{
		scene.publisher.publish(TrackData, ArtifactSpecialists, "/specialists.json", []byte(`{"bom":true}`)),
	}
	url := scene.publisher.manifest(t, scene.private, manifest)

	first := scene.service(func(o *Options) { o.ManifestURL = url })
	if _, err := first.Check(context.Background()); err != nil {
		t.Fatalf("primeira passada: %v", err)
	}

	// Alguém troca o conteúdo do artefato já verificado.
	for _, name := range listDir(t, scene.fetcher.dir) {
		if strings.HasPrefix(name, ArtifactSpecialists+"-") {
			if err := os.WriteFile(filepath.Join(scene.fetcher.dir, name), []byte(`{"adulterado":true}`), 0o600); err != nil {
				t.Fatalf("adulterar o artefato: %v", err)
			}
		}
	}

	scene.applied = nil
	second := NewService(Options{
		ManifestURL: url,
		PublicKey:   scene.public,
		Version:     "0.1.0",
		Fetcher:     &Fetcher{guard: blockingNet{}, dir: scene.fetcher.dir},
		ApplyData: map[string]func([]byte) error{
			ArtifactSpecialists: func(raw []byte) error {
				scene.applied = append(scene.applied, raw)
				return nil
			},
		},
		Log: quietLogger(),
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := second.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if len(scene.applied) != 0 {
		t.Errorf("o artefato adulterado foi aplicado: %s", scene.applied[0])
	}
}

// Chave trocada descarta o que a anterior tinha assinado. Trocar a chave
// embutida é o que se faz quando a antiga foi comprometida — e sem esta regra a
// estação continuaria reaplicando, a cada subida, o catálogo dela.
func TestStartDoesNotRestoreDataFromAnotherKey(t *testing.T) {
	scene := newScenario(t)
	manifest := sampleManifest()
	manifest.Version = "0.2.0"
	manifest.MinimumShellVersion = ""
	manifest.Artifacts = []Artifact{
		scene.publisher.publish(TrackData, ArtifactSpecialists, "/specialists.json", []byte(`{"a":1}`)),
	}
	url := scene.publisher.manifest(t, scene.private, manifest)

	first := scene.service(func(o *Options) { o.ManifestURL = url })
	if _, err := first.Check(context.Background()); err != nil {
		t.Fatalf("primeira passada: %v", err)
	}
	if len(scene.applied) != 1 {
		t.Fatalf("a primeira passada não aplicou o dado")
	}

	// A estação recebe um binário novo, com OUTRA chave embutida.
	rotated, _ := keyPair(t)
	scene.applied = nil
	second := NewService(Options{
		ManifestURL: url,
		PublicKey:   rotated,
		Version:     "0.1.0",
		Fetcher:     &Fetcher{guard: blockingNet{}, dir: scene.fetcher.dir},
		ApplyData: map[string]func([]byte) error{
			ArtifactSpecialists: func(raw []byte) error {
				scene.applied = append(scene.applied, raw)
				return nil
			},
		},
		Log: quietLogger(),
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := second.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if len(scene.applied) != 0 {
		t.Error("o dado assinado pela chave anterior foi restaurado depois da rotação")
	}
}

// Passar de novo pelo mesmo manifesto não rebaixa nem reaplica o que já vale.
func TestCheckDoesNotReapplyTheSameData(t *testing.T) {
	scene := newScenario(t)
	manifest := sampleManifest()
	manifest.Version = "0.2.0"
	manifest.MinimumShellVersion = ""
	manifest.Artifacts = []Artifact{
		scene.publisher.publish(TrackData, ArtifactSpecialists, "/specialists.json", []byte(`{"a":1}`)),
		scene.publisher.publish(TrackGateway, "aibotd", "/aibotd.exe", []byte("MZ binário novo")),
	}
	url := scene.publisher.manifest(t, scene.private, manifest)

	service := scene.service(func(o *Options) { o.ManifestURL = url })
	if _, err := service.Check(context.Background()); err != nil {
		t.Fatalf("primeira passada: %v", err)
	}
	if _, err := service.Check(context.Background()); err != nil {
		t.Fatalf("segunda passada: %v", err)
	}
	if len(scene.applied) != 1 {
		t.Errorf("o mesmo catálogo foi aplicado %d vezes", len(scene.applied))
	}
}

/* -------------------------------- trilha C -------------------------------- */

func TestPrepareGatewayRefusesArtifactFromAnotherTrack(t *testing.T) {
	scene := newScenario(t)
	// O bundle da interface oferecido como se fosse o gateway: gravá-lo com o
	// nome do executável faria a casca lançar um tar no próximo início.
	artifact := scene.publisher.publish(TrackUI, "bundle", "/ui.tar", []byte("tar da interface"))

	_, err := PrepareGateway(context.Background(), scene.fetcher, artifact, filepath.Join(scene.installDir, "aibotd.exe"))
	if err == nil {
		t.Fatal("PrepareGateway aceitou um artefato da trilha da interface")
	}
	if !errors.Is(err, ErrWrongTrack) {
		t.Errorf("erro %v, esperava ErrWrongTrack", err)
	}
	if exists(scene.pendingGateway()) {
		t.Error("o artefato da trilha errada foi gravado como aibotd.new")
	}
}

func TestPrepareGatewayLeavesNothingWhenTheHashDoesNotMatch(t *testing.T) {
	scene := newScenario(t)
	artifact := scene.publisher.publish(TrackGateway, "aibotd", "/aibotd.exe", []byte("MZ binário novo"))
	// O manifesto declara outro hash: é o caso do artefato trocado no caminho.
	artifact.SHA256 = strings.Repeat("ff", 32)

	if _, err := PrepareGateway(context.Background(), scene.fetcher, artifact, filepath.Join(scene.installDir, "aibotd.exe")); err == nil {
		t.Fatal("PrepareGateway aceitou um artefato com hash diferente do declarado")
	}
	if exists(scene.pendingGateway()) {
		t.Error("sobrou um aibotd.new de um artefato reprovado")
	}
	for _, name := range listDir(t, scene.fetcher.dir) {
		if strings.HasSuffix(name, ".part") {
			t.Errorf("sobrou %q: arquivo meio baixado não pode virar arquivo válido", name)
		}
	}
}

// Enquanto a pessoa não reabre o app, o mesmo manifesto reaparece a cada seis
// horas. Reescrever o executável pendente toda vez seria dezenas de megabytes
// no diretório de instalação sem motivo — e a segunda passada nem precisa de
// rede para descobrir isso.
func TestPrepareGatewayDoesNotRewriteThePendingFileItAlreadyHas(t *testing.T) {
	scene := newScenario(t)
	executable := filepath.Join(scene.installDir, "aibotd.exe")
	artifact := scene.publisher.publish(TrackGateway, "aibotd", "/aibotd.exe", []byte("MZ binário novo"))

	if _, err := PrepareGateway(context.Background(), scene.fetcher, artifact, executable); err != nil {
		t.Fatalf("primeira preparação: %v", err)
	}

	// Some com TUDO o que permitiria refazer o trabalho: o cache do artefato e o
	// arquivo no servidor. Só o pendente continua no lugar.
	for _, name := range listDir(t, scene.fetcher.dir) {
		if err := os.Remove(filepath.Join(scene.fetcher.dir, name)); err != nil {
			t.Fatalf("limpar o cache: %v", err)
		}
	}
	delete(scene.publisher.files, "/aibotd.exe")

	if _, err := PrepareGateway(context.Background(), scene.fetcher, artifact, executable); err != nil {
		t.Fatalf("segunda preparação: %v — ela reescreveu o pendente que já estava certo", err)
	}
	written, err := os.ReadFile(scene.pendingGateway())
	if err != nil {
		t.Fatalf("ler o pendente: %v", err)
	}
	if string(written) != "MZ binário novo" {
		t.Errorf("o pendente ficou com %q", written)
	}
}

// Preparar duas vezes sobrescreve o pendente: a publicação mais recente é a que
// a casca vai encontrar.
func TestPrepareGatewayOverwritesThePendingFile(t *testing.T) {
	scene := newScenario(t)
	executable := filepath.Join(scene.installDir, "aibotd.exe")

	first := scene.publisher.publish(TrackGateway, "aibotd", "/aibotd-1.exe", []byte("MZ primeiro"))
	if _, err := PrepareGateway(context.Background(), scene.fetcher, first, executable); err != nil {
		t.Fatalf("primeira preparação: %v", err)
	}
	second := scene.publisher.publish(TrackGateway, "aibotd", "/aibotd-2.exe", []byte("MZ segundo, mais novo"))
	if _, err := PrepareGateway(context.Background(), scene.fetcher, second, executable); err != nil {
		t.Fatalf("segunda preparação: %v", err)
	}

	written, err := os.ReadFile(scene.pendingGateway())
	if err != nil {
		t.Fatalf("ler o pendente: %v", err)
	}
	if string(written) != "MZ segundo, mais novo" {
		t.Errorf("o pendente ficou com %q", written)
	}
	// E os DOIS artefatos continuam no cache, endereçados por hash: é o que faz
	// republicar a versão anterior não baixar nada de novo.
	binaries := 0
	for _, name := range listDir(t, scene.fetcher.dir) {
		if strings.HasPrefix(name, "aibotd-") {
			binaries++
		}
	}
	if binaries != 2 {
		t.Errorf("há %d artefatos de gateway no cache, esperava 2 (a versão anterior fica para o rollback)", binaries)
	}
}

/* --------------------------------- o laço --------------------------------- */

// Start faz a primeira passada em segundo plano e não bloqueia o boot.
func TestStartChecksInTheBackground(t *testing.T) {
	scene := newScenario(t)
	manifest := sampleManifest()
	manifest.Version = "0.2.0"
	manifest.MinimumShellVersion = ""
	manifest.Artifacts = []Artifact{
		scene.publisher.publish(TrackData, ArtifactSpecialists, "/specialists.json", []byte(`{"a":1}`)),
	}
	url := scene.publisher.manifest(t, scene.private, manifest)

	applied := make(chan []byte, 1)
	service := scene.service(func(o *Options) {
		o.ManifestURL = url
		o.ApplyData = map[string]func([]byte) error{
			ArtifactSpecialists: func(raw []byte) error {
				applied <- raw
				return nil
			},
		}
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := service.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}

	select {
	case raw := <-applied:
		if len(raw) == 0 {
			t.Error("o dado chegou vazio")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("a primeira passada não aconteceu")
	}
}
