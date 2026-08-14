// Testes da atualização.
//
// Todos apontam para a mesma direção da falha: o caminho da atualização só pode
// errar RECUSANDO. Manifesto adulterado, assinado por outra chave, sem
// assinatura, artefato com hash errado, artefato com tamanho diferente do
// declarado, destino que o guarda de rede reprova — em nenhum desses casos pode
// sobrar arquivo válido no disco. Aceitar por engano aqui é executar código de
// outra pessoa na estação de quem instalou o AI-BOT.
//
// O par de chaves é gerado no próprio teste: chave de verdade não entra em
// repositório, e a chave pública real é embutida em tempo de compilação.
package update

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

/* --------------------------------- apoio ---------------------------------- */

func keyPair(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("gerar par de chaves: %v", err)
	}
	return public, private
}

// sign devolve o manifesto com a assinatura do corpo canônico.
func sign(t *testing.T, private ed25519.PrivateKey, manifest Manifest) Manifest {
	t.Helper()
	body, err := Canonical(manifest)
	if err != nil {
		t.Fatalf("Canonical: %v", err)
	}
	manifest.Signature = base64.RawURLEncoding.EncodeToString(ed25519.Sign(private, body))
	return manifest
}

func sampleManifest() Manifest {
	return Manifest{
		SchemaVersion:       SchemaVersion,
		Product:             "AI-BOT",
		Channel:             "stable",
		Version:             "0.2.0",
		PublishedAt:         time.Date(2026, 8, 14, 12, 0, 0, 0, time.UTC),
		MinimumShellVersion: "0.1.0",
		Artifacts: []Artifact{
			{Track: TrackData, ID: "specialists", URL: "https://exemplo.com/specialists.json", Size: 24576, SHA256: strings.Repeat("ab", 32)},
			{Track: TrackGateway, ID: "aibotd", URL: "https://exemplo.com/aibotd-0.2.0.exe", Size: 12582912, SHA256: strings.Repeat("cd", 32)},
		},
	}
}

// loopbackNet é o guarda de rede do teste. O netguard de verdade recusa
// loopback — corretamente, é o SSRF que ele existe para fechar — e o httptest
// escuta exatamente lá. A interface guardedNet existe por isto.
type loopbackNet struct{ checks atomic.Int64 }

func (l *loopbackNet) Check(_ context.Context, raw string) (*url.URL, []string, error) {
	l.checks.Add(1)
	target, err := url.Parse(raw)
	if err != nil {
		return nil, nil, err
	}
	return target, []string{target.Host}, nil
}

func (l *loopbackNet) Client([]string) *http.Client {
	// Não segue redirect sozinho, igual ao netguard: cada salto tem de voltar
	// para o Check.
	return &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
}

// blockingNet recusa tudo, como o guarda de verdade faria com um endereço
// interno.
type blockingNet struct{}

func (blockingNet) Check(context.Context, string) (*url.URL, []string, error) {
	return nil, nil, errors.New("destino bloqueado")
}

func (blockingNet) Client([]string) *http.Client {
	panic("o guarda reprovou: não podia chegar a discar")
}

func testFetcher(t *testing.T) (*Fetcher, *loopbackNet) {
	t.Helper()
	guard := &loopbackNet{}
	return &Fetcher{guard: guard, dir: t.TempDir()}, guard
}

// serveBytes serve o mesmo corpo sempre e conta quantas vezes foi buscado.
func serveBytes(t *testing.T, payload []byte, hits *atomic.Int64) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		_, _ = w.Write(payload)
	}))
	t.Cleanup(server.Close)
	return server
}

func listDir(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("ler %s: %v", dir, err)
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	return names
}

/* ------------------------------- assinatura ------------------------------- */

func TestVerifyAcceptsManifestSignedWithTheMatchingKey(t *testing.T) {
	public, private := keyPair(t)
	manifest := sign(t, private, sampleManifest())

	if err := Verify(manifest, public); err != nil {
		t.Fatalf("Verify com a chave correta: esperava sucesso, obteve %v", err)
	}
}

// O manifesto trafega como JSON e é reinterpretado do outro lado. Se a
// assinatura não sobrevivesse ao round-trip, o corpo canônico estaria assinando
// formatação em vez de conteúdo — que é justamente o defeito que Canonical
// existe para evitar.
func TestVerifySurvivesTheJSONRoundTrip(t *testing.T) {
	public, private := keyPair(t)
	original := sampleManifest()
	// Fuso diferente de UTC de propósito: o mesmo instante escrito de outro
	// jeito tem de produzir o mesmo corpo canônico.
	original.PublishedAt = time.Date(2026, 8, 14, 9, 0, 0, 0, time.FixedZone("BRT", -3*60*60))
	signed := sign(t, private, original)

	raw, err := json.Marshal(signed)
	if err != nil {
		t.Fatalf("serializar o manifesto: %v", err)
	}
	var received Manifest
	if err := json.Unmarshal(raw, &received); err != nil {
		t.Fatalf("interpretar o manifesto: %v", err)
	}

	if err := Verify(received, public); err != nil {
		t.Fatalf("Verify depois do round-trip JSON: esperava sucesso, obteve %v", err)
	}
}

func TestVerifyRejectsEverythingThatIsNotTheSignedBody(t *testing.T) {
	public, private := keyPair(t)
	other, _ := keyPair(t)
	signed := sign(t, private, sampleManifest())

	tampered := signed
	tampered.Version = "0.3.0" // um byte trocado DEPOIS de assinado

	// O ataque que mais importa: manter tudo igual e trocar só o hash de um
	// artefato, que é o que aponta para os bytes que vão rodar na máquina.
	swapped := signed
	swapped.Artifacts = append([]Artifact(nil), signed.Artifacts...)
	swapped.Artifacts[1].SHA256 = strings.Repeat("ef", 32)

	unsigned := signed
	unsigned.Signature = ""

	garbled := signed
	garbled.Signature = "isto não é base64url!!"

	// base64url válido, tamanho errado: passa pelo decode e reprova no tamanho,
	// sem chegar ao ed25519.Verify (que entraria em pânico).
	short := signed
	short.Signature = base64.RawURLEncoding.EncodeToString([]byte("curto demais"))

	// Padding é da forma padrão, não da base64url crua — e aceitar as duas
	// formas seria aceitar duas representações da mesma assinatura.
	padded := signed
	padded.Signature = base64.URLEncoding.EncodeToString(make([]byte, ed25519.SignatureSize))

	cases := []struct {
		name     string
		manifest Manifest
		key      ed25519.PublicKey
		want     error
	}{
		{"assinado por outra chave", signed, other, ErrSignatureMismatch},
		{"corpo alterado depois de assinado", tampered, public, ErrSignatureMismatch},
		{"hash de artefato trocado", swapped, public, ErrSignatureMismatch},
		{"sem o campo signature", unsigned, public, ErrMalformedSignature},
		{"assinatura que não é base64url", garbled, public, ErrMalformedSignature},
		{"assinatura de tamanho errado", short, public, ErrMalformedSignature},
		{"assinatura com padding", padded, public, ErrMalformedSignature},
		{"sem chave embutida", signed, nil, ErrNoPublicKey},
		{"chave truncada", signed, public[:10], ErrNoPublicKey},
	}

	for _, each := range cases {
		t.Run(each.name, func(t *testing.T) {
			err := Verify(each.manifest, each.key)
			if err == nil {
				t.Fatalf("Verify(%s): esperava recusa, obteve sucesso", each.name)
			}
			if !errors.Is(err, each.want) {
				t.Errorf("Verify(%s): esperava um erro de %q, obteve %q", each.name, each.want, err)
			}
		})
	}
}

/* ---------------------------- corpo canônico ------------------------------ */

func TestCanonicalIsStableAndIgnoresTheSignature(t *testing.T) {
	manifest := sampleManifest()

	first, err := Canonical(manifest)
	if err != nil {
		t.Fatalf("Canonical: %v", err)
	}
	second, err := Canonical(manifest)
	if err != nil {
		t.Fatalf("Canonical (segunda vez): %v", err)
	}
	if string(first) != string(second) {
		t.Fatalf("Canonical não é estável:\n%s\n%s", first, second)
	}

	// O campo signature não entra no corpo — se entrasse, assinar exigiria já
	// ter a assinatura.
	withSignature := manifest
	withSignature.Signature = "qualquer-coisa"
	third, err := Canonical(withSignature)
	if err != nil {
		t.Fatalf("Canonical com assinatura: %v", err)
	}
	if string(third) != string(first) {
		t.Errorf("Canonical mudou por causa do campo signature:\n%s\n%s", first, third)
	}
	if strings.Contains(string(first), "signature") {
		t.Errorf("Canonical: o corpo assinado não pode conter o campo signature: %s", first)
	}

	// Chaves ordenadas: é o que sobrevive a qualquer reserialização no caminho.
	body := string(first)
	for _, pair := range [][2]string{
		{"artifacts", "channel"}, {"channel", "minimumShellVersion"},
		{"minimumShellVersion", "product"}, {"product", "publishedAt"},
		{"publishedAt", "schemaVersion"}, {"schemaVersion", "version"},
	} {
		if strings.Index(body, `"`+pair[0]+`"`) > strings.Index(body, `"`+pair[1]+`"`) {
			t.Errorf("Canonical: %q devia vir antes de %q em %s", pair[0], pair[1], body)
		}
	}
}

// `null` e `[]` significam a mesma coisa — nenhum artefato —, e o corpo
// assinado não pode depender de qual das duas o publicador escreveu.
func TestCanonicalTreatsNilAndEmptyArtifactsAlike(t *testing.T) {
	empty := sampleManifest()
	empty.Artifacts = []Artifact{}
	none := sampleManifest()
	none.Artifacts = nil

	withEmpty, err := Canonical(empty)
	if err != nil {
		t.Fatalf("Canonical: %v", err)
	}
	withNil, err := Canonical(none)
	if err != nil {
		t.Fatalf("Canonical: %v", err)
	}
	if string(withEmpty) != string(withNil) {
		t.Errorf("Canonical distinguiu artifacts nil de vazio:\n%s\n%s", withEmpty, withNil)
	}
}

/* --------------------------------- versão --------------------------------- */

func TestNewerComparesNumbersNotText(t *testing.T) {
	// A comparação de texto erra este caso, e é por ele que a função existe.
	if !("0.10.0" < "0.9.0") {
		t.Fatalf("premissa do teste furou: como texto, 0.10.0 devia ser menor que 0.9.0")
	}

	cases := []struct {
		version string
		current string
		want    bool
	}{
		{"0.10.0", "0.9.0", true},
		{"0.9.0", "0.10.0", false},
		{"0.9.0", "0.9.0", false}, // igual não é mais novo
		{"0.9.1", "0.9.0", true},
		{"1.0.0", "0.99.99", true},
		{"0.2.0", "0.2.0-rc1", false}, // pré-lançamento não é ordenado aqui
		{"v0.3.0", "0.2.9", true},
		{"0.10", "0.9.3", true},
	}

	for _, each := range cases {
		manifest := Manifest{Version: each.version}
		if got := manifest.Newer(each.current); got != each.want {
			t.Errorf("Manifest{Version:%q}.Newer(%q) = %v, esperava %v", each.version, each.current, got, each.want)
		}
	}
}

func TestNewerSurvivesGarbageWithoutPanicking(t *testing.T) {
	cases := []struct {
		version string
		current string
		want    bool
	}{
		{"", "", false},
		{"", "0.1.0", false},
		{"não é versão", "0.1.0", false},         // ilegível nunca é mais novo
		{"0.1.0", "não é versão", true},          // versão local ilegível não trava a atualização
		{"99999999999999999999", "0.1.0", false}, // estoura o int: vira 0, não pânico
		{"0.1.0-rc1+build.5", "0.0.9", true},     // sufixo cortado
		{"..", "0.0.0", false},
		{"0.1.0.0.0.0", "0.1.0", false}, // partes a mais são ignoradas
		{"-1.0.0", "0.0.0", false},      // negativo vira 0
		{"  0.2.0  ", "0.1.0", true},    // espaço em volta
		{"0.2.0", "\t\n", true},         // versão corrente em branco
		{"0x10.0.0", "0.0.0", false},    // hexadecimal não é versão
		{strings.Repeat("9", 400), "0.1.0", false},
	}

	for _, each := range cases {
		manifest := Manifest{Version: each.version}
		if got := manifest.Newer(each.current); got != each.want {
			t.Errorf("Manifest{Version:%q}.Newer(%q) = %v, esperava %v", each.version, each.current, got, each.want)
		}
	}
}

func TestSupportedByShellRefusesWhenTheShellIsBelowTheFloor(t *testing.T) {
	manifest := sampleManifest() // piso 0.1.0

	cases := []struct {
		shell string
		want  bool
	}{
		{"0.1.0", true},
		{"0.2.0", true},
		{"0.10.0", true},
		{"0.0.9", false},
		{"", false},       // casca ilegível não libera
		{"sei lá", false}, //
	}
	for _, each := range cases {
		if got := manifest.SupportedByShell(each.shell); got != each.want {
			t.Errorf("SupportedByShell(%q) = %v, esperava %v", each.shell, got, each.want)
		}
	}

	// Sem piso declarado, qualquer casca serve.
	semPiso := manifest
	semPiso.MinimumShellVersion = ""
	if !semPiso.SupportedByShell("0.0.1") {
		t.Errorf("SupportedByShell sem piso declarado: esperava true")
	}
}

/* -------------------------- busca do manifesto ---------------------------- */

func TestFetcherManifestVerifiesBeforeReturning(t *testing.T) {
	public, private := keyPair(t)
	signed := sign(t, private, sampleManifest())

	t.Run("assinado passa", func(t *testing.T) {
		fetcher, _ := testFetcher(t)
		var hits atomic.Int64
		body, err := json.Marshal(signed)
		if err != nil {
			t.Fatalf("serializar: %v", err)
		}
		server := serveBytes(t, body, &hits)

		got, err := fetcher.Manifest(context.Background(), server.URL+"/manifest.json", public)
		if err != nil {
			t.Fatalf("Manifest: esperava sucesso, obteve %v", err)
		}
		if got.Version != "0.2.0" || len(got.Artifacts) != 2 {
			t.Errorf("Manifest devolveu %+v", got)
		}
	})

	t.Run("adulterado no caminho falha", func(t *testing.T) {
		fetcher, _ := testFetcher(t)
		var hits atomic.Int64
		body, err := json.Marshal(signed)
		if err != nil {
			t.Fatalf("serializar: %v", err)
		}
		// Um proxy trocando a URL do artefato — assinatura intacta, corpo não.
		body = []byte(strings.Replace(string(body), "https://exemplo.com/aibotd-0.2.0.exe", "https://malvado.com/aibotd.exe", 1))
		server := serveBytes(t, body, &hits)

		_, err = fetcher.Manifest(context.Background(), server.URL+"/manifest.json", public)
		if !errors.Is(err, ErrSignatureMismatch) {
			t.Fatalf("Manifest com corpo trocado: esperava %q, obteve %v", ErrSignatureMismatch, err)
		}
	})

	t.Run("sem chave embutida falha", func(t *testing.T) {
		fetcher, _ := testFetcher(t)
		var hits atomic.Int64
		body, err := json.Marshal(signed)
		if err != nil {
			t.Fatalf("serializar: %v", err)
		}
		server := serveBytes(t, body, &hits)

		_, err = fetcher.Manifest(context.Background(), server.URL+"/manifest.json", nil)
		if !errors.Is(err, ErrNoPublicKey) {
			t.Fatalf("Manifest sem chave: esperava %q, obteve %v", ErrNoPublicKey, err)
		}
	})

	t.Run("esquema desconhecido falha mesmo assinado", func(t *testing.T) {
		fetcher, _ := testFetcher(t)
		future := sampleManifest()
		future.SchemaVersion = SchemaVersion + 1
		body, err := json.Marshal(sign(t, private, future))
		if err != nil {
			t.Fatalf("serializar: %v", err)
		}
		var hits atomic.Int64
		server := serveBytes(t, body, &hits)

		_, err = fetcher.Manifest(context.Background(), server.URL+"/manifest.json", public)
		if err == nil {
			t.Fatalf("Manifest de esquema mais novo: esperava recusa")
		}
		if !strings.Contains(err.Error(), "esquema") {
			t.Errorf("Manifest de esquema mais novo: erro devia citar o esquema, obteve %q", err)
		}
	})

	t.Run("resposta de erro não vira manifesto", func(t *testing.T) {
		fetcher, _ := testFetcher(t)
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "sem manifesto", http.StatusNotFound)
		}))
		t.Cleanup(server.Close)

		if _, err := fetcher.Manifest(context.Background(), server.URL+"/manifest.json", public); err == nil {
			t.Fatalf("Manifest com 404: esperava recusa")
		}
	})
}

/* --------------------------- busca do artefato ---------------------------- */

func TestArtifactStoresOnlyWhatMatchesTheDeclaredHash(t *testing.T) {
	payload := []byte("os bytes do aibotd, digamos")
	sum := sha256.Sum256(payload)

	t.Run("hash certo grava com o nome final", func(t *testing.T) {
		fetcher, _ := testFetcher(t)
		var hits atomic.Int64
		server := serveBytes(t, payload, &hits)

		path, err := fetcher.Artifact(context.Background(), Artifact{
			Track: TrackGateway, ID: "aibotd", URL: server.URL + "/aibotd",
			Size: int64(len(payload)), SHA256: hex.EncodeToString(sum[:]),
		})
		if err != nil {
			t.Fatalf("Artifact: esperava sucesso, obteve %v", err)
		}

		wanted := filepath.Join(fetcher.dir, "aibotd-"+hex.EncodeToString(sum[:])[:12])
		if path != wanted {
			t.Errorf("Artifact devolveu %q, esperava %q", path, wanted)
		}
		content, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("ler o artefato gravado: %v", err)
		}
		if string(content) != string(payload) {
			t.Errorf("o artefato gravado tem %q", content)
		}
		if names := listDir(t, fetcher.dir); len(names) != 1 {
			t.Errorf("o diretório devia ter só o artefato, tem %v", names)
		}
	})

	t.Run("hash errado não deixa arquivo final", func(t *testing.T) {
		fetcher, _ := testFetcher(t)
		var hits atomic.Int64
		server := serveBytes(t, payload, &hits)

		_, err := fetcher.Artifact(context.Background(), Artifact{
			Track: TrackGateway, ID: "aibotd", URL: server.URL + "/aibotd",
			Size: int64(len(payload)), SHA256: strings.Repeat("00", sha256.Size),
		})
		if err == nil {
			t.Fatalf("Artifact com hash declarado errado: esperava recusa")
		}
		if names := listDir(t, fetcher.dir); len(names) != 0 {
			// Nem final nem `.part`: arquivo meio verificado é arquivo que
			// alguém executa por engano.
			t.Errorf("depois da recusa o diretório devia estar vazio, tem %v", names)
		}
	})

	t.Run("hash declarado que nem é sha256 nem chega a discar", func(t *testing.T) {
		fetcher, guard := testFetcher(t)
		var hits atomic.Int64
		server := serveBytes(t, payload, &hits)

		for _, declared := range []string{"", "abc", strings.Repeat("zz", 32), hex.EncodeToString(sum[:])[:32]} {
			_, err := fetcher.Artifact(context.Background(), Artifact{
				Track: TrackGateway, ID: "aibotd", URL: server.URL + "/aibotd",
				Size: int64(len(payload)), SHA256: declared,
			})
			if err == nil {
				t.Fatalf("Artifact com sha256 %q: esperava recusa", declared)
			}
		}
		if hits.Load() != 0 || guard.checks.Load() != 0 {
			t.Errorf("hash inválido devia reprovar antes da rede, houve %d buscas", hits.Load())
		}
	})
}

func TestArtifactRefusesWhenTheSizeDoesNotMatch(t *testing.T) {
	payload := []byte("os bytes do aibotd, digamos")
	sum := sha256.Sum256(payload)

	cases := []struct {
		name string
		size int64
	}{
		{"declara mais do que envia", int64(len(payload)) + 5},
		{"declara menos do que envia", int64(len(payload)) - 5},
		{"declara zero", 0},
		{"declara acima do teto", maxArtifactSize + 1},
	}

	for _, each := range cases {
		t.Run(each.name, func(t *testing.T) {
			fetcher, _ := testFetcher(t)
			var hits atomic.Int64
			server := serveBytes(t, payload, &hits)

			_, err := fetcher.Artifact(context.Background(), Artifact{
				Track: TrackGateway, ID: "aibotd", URL: server.URL + "/aibotd",
				Size: each.size, SHA256: hex.EncodeToString(sum[:]),
			})
			if err == nil {
				t.Fatalf("Artifact com tamanho declarado %d: esperava recusa", each.size)
			}
			if names := listDir(t, fetcher.dir); len(names) != 0 {
				t.Errorf("depois da recusa o diretório devia estar vazio, tem %v", names)
			}
		})
	}
}

// O artefato é imutável e endereçado por hash: rebaixar o que já está conferido
// é desperdício, e é o caso comum do rollback.
func TestArtifactDoesNotDownloadTwice(t *testing.T) {
	payload := []byte("os bytes do aibotd, digamos")
	sum := sha256.Sum256(payload)

	fetcher, _ := testFetcher(t)
	var hits atomic.Int64
	server := serveBytes(t, payload, &hits)
	artifact := Artifact{
		Track: TrackGateway, ID: "aibotd", URL: server.URL + "/aibotd",
		Size: int64(len(payload)), SHA256: hex.EncodeToString(sum[:]),
	}

	first, err := fetcher.Artifact(context.Background(), artifact)
	if err != nil {
		t.Fatalf("Artifact (primeira): %v", err)
	}
	if hits.Load() != 1 {
		t.Fatalf("primeira busca: esperava 1 requisição, houve %d", hits.Load())
	}

	second, err := fetcher.Artifact(context.Background(), artifact)
	if err != nil {
		t.Fatalf("Artifact (segunda): %v", err)
	}
	if second != first {
		t.Errorf("segunda chamada devolveu %q, esperava %q", second, first)
	}
	if hits.Load() != 1 {
		t.Errorf("segunda chamada: esperava nenhuma requisição nova, o total foi %d", hits.Load())
	}

	// Arquivo com o nome certo e conteúdo trocado NÃO conta como baixado: o
	// nome carrega 12 dígitos do hash, não o hash.
	if err := os.WriteFile(first, bytes.Repeat([]byte("x"), len(payload)), 0o600); err != nil {
		t.Fatalf("adulterar o artefato em disco: %v", err)
	}
	third, err := fetcher.Artifact(context.Background(), artifact)
	if err != nil {
		t.Fatalf("Artifact (terceira): %v", err)
	}
	if third != first {
		t.Errorf("terceira chamada devolveu %q, esperava %q", third, first)
	}
	if hits.Load() != 2 {
		t.Errorf("artefato adulterado em disco: esperava um download novo, o total foi %d", hits.Load())
	}
	content, err := os.ReadFile(third)
	if err != nil {
		t.Fatalf("ler o artefato: %v", err)
	}
	if string(content) != string(payload) {
		t.Errorf("o artefato em disco continuou adulterado: %q", content)
	}
}

// O id vem de documento assinado e ainda assim é conferido: o nome do arquivo é
// montado com ele, e assinatura garante QUEM publicou, não que o campo esteja
// certo.
func TestArtifactRefusesIDThatEscapesTheDirectory(t *testing.T) {
	payload := []byte("os bytes do aibotd, digamos")
	sum := sha256.Sum256(payload)

	fetcher, guard := testFetcher(t)
	var hits atomic.Int64
	server := serveBytes(t, payload, &hits)

	for _, id := range []string{"", "..", "../aibotd", `..\..\aibotd`, "sub/aibotd", "ai bot", strings.Repeat("a", 65)} {
		_, err := fetcher.Artifact(context.Background(), Artifact{
			Track: TrackGateway, ID: id, URL: server.URL + "/aibotd",
			Size: int64(len(payload)), SHA256: hex.EncodeToString(sum[:]),
		})
		if err == nil {
			t.Errorf("Artifact com id %q: esperava recusa", id)
		}
	}
	if hits.Load() != 0 || guard.checks.Load() != 0 {
		t.Errorf("id inválido devia reprovar antes da rede, houve %d buscas", hits.Load())
	}
	if names := listDir(t, fetcher.dir); len(names) != 0 {
		t.Errorf("nenhum arquivo devia ter sido criado, há %v", names)
	}
}

/* ------------------------------ guarda de rede ---------------------------- */

// Sem guarda não há busca: um manifesto apontando o artefato para
// 169.254.169.254 é SSRF com crachá.
func TestFetcherGoesThroughTheGuard(t *testing.T) {
	payload := []byte("os bytes do aibotd, digamos")
	sum := sha256.Sum256(payload)
	artifact := func(rawURL string) Artifact {
		return Artifact{Track: TrackGateway, ID: "aibotd", URL: rawURL,
			Size: int64(len(payload)), SHA256: hex.EncodeToString(sum[:])}
	}

	t.Run("guarda que reprova impede o download", func(t *testing.T) {
		var hits atomic.Int64
		server := serveBytes(t, payload, &hits)
		fetcher := &Fetcher{guard: blockingNet{}, dir: t.TempDir()}

		if _, err := fetcher.Artifact(context.Background(), artifact(server.URL+"/aibotd")); err == nil {
			t.Fatalf("Artifact com o guarda reprovando: esperava recusa")
		}
		if hits.Load() != 0 {
			t.Errorf("o guarda reprovou e mesmo assim houve %d buscas", hits.Load())
		}
	})

	t.Run("sem guarda nenhum recusa em vez de estourar", func(t *testing.T) {
		// NewFetcher(nil, ...) tem de produzir um Fetcher que recusa: um
		// *netguard.Guard nil guardado numa interface daria uma interface
		// não-nil e um pânico na primeira busca.
		fetcher := NewFetcher(nil, t.TempDir())
		if _, err := fetcher.Artifact(context.Background(), artifact("https://exemplo.com/aibotd")); err == nil {
			t.Fatalf("Artifact sem guarda: esperava recusa")
		}
		if _, err := fetcher.Manifest(context.Background(), "https://exemplo.com/manifest.json", nil); err == nil {
			t.Fatalf("Manifest sem guarda: esperava recusa")
		}
	})

	// CDN redireciona, e cada salto é uma URL nova que precisa passar pelas
	// mesmas checagens — por isso o redirect é seguido à mão, e por isso este
	// teste conta as passagens pelo guarda.
	t.Run("redirect volta para o guarda a cada salto", func(t *testing.T) {
		fetcher, guard := testFetcher(t)
		var hits atomic.Int64
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/cdn/aibotd" {
				// Location relativo: resolvê-lo contra a URL do salto anterior
				// é parte do que o seguidor de redirect à mão precisa fazer.
				http.Redirect(w, r, "/cdn/aibotd", http.StatusFound)
				return
			}
			hits.Add(1)
			_, _ = w.Write(payload)
		}))
		t.Cleanup(server.Close)

		path, err := fetcher.Artifact(context.Background(), artifact(server.URL+"/aibotd"))
		if err != nil {
			t.Fatalf("Artifact com redirect: %v", err)
		}
		if hits.Load() != 1 {
			t.Errorf("esperava 1 entrega, houve %d", hits.Load())
		}
		if guard.checks.Load() != 2 {
			t.Errorf("esperava 2 passagens pelo guarda (a URL e o destino do redirect), houve %d", guard.checks.Load())
		}
		if _, err := os.Stat(path); err != nil {
			t.Errorf("o artefato devia estar gravado: %v", err)
		}
	})

	t.Run("redirect sem fim para", func(t *testing.T) {
		fetcher, _ := testFetcher(t)
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, "/de-novo", http.StatusFound)
		}))
		t.Cleanup(server.Close)

		if _, err := fetcher.Artifact(context.Background(), artifact(server.URL+"/aibotd")); err == nil {
			t.Fatalf("Artifact com redirect infinito: esperava recusa")
		}
	})
}
