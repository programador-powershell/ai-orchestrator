// A busca da atualização. Tudo aqui é rede — e por isso tudo aqui passa pelo
// netguard.
//
// Buscar código de um servidor e executá-lo é, literalmente, "baixar ou
// executar arquivo de fonte não confiável". O que torna isso aceitável é o
// conjunto inteiro, não um pedaço dele: assinatura sobre o manifesto (ver
// manifest.go), SHA-256 por artefato conferido em streaming, e HTTPS com IP
// fixado no dial. Sem a última, "atualização" é o caminho mais curto de um SSRF
// até execução: basta um manifesto apontar o artefato para um endereço interno.

package update

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"aibot/gateway/internal/netguard"
)

// maxManifestSize é o teto do manifesto. É JSON com uma dezena de artefatos;
// megabyte já é folga de sobra, e o teto existe para uma URL que serve um fluxo
// infinito não consumir a memória do processo.
const maxManifestSize = 1 << 20

// maxArtifactSize é o teto de um artefato. O aibotd tem dezenas de megabytes e
// o bundle da interface alguns; meio giga é folga larga e continua sendo um
// teto — que é o ponto, porque quem declara o tamanho é o manifesto.
const maxArtifactSize = 512 << 20

// guardedNet é o netguard visto daqui: só o que a busca precisa. Interface, e
// não o tipo concreto, pelo mesmo motivo de internal/policy — o httptest escuta
// em loopback, que o guarda de verdade recusa (corretamente, é o SSRF que ele
// existe para fechar), então o teste precisa de um canal que não passe por ele.
type guardedNet interface {
	Check(ctx context.Context, raw string) (*url.URL, []string, error)
	Client(approved []string) *http.Client
}

// Fetcher busca manifesto e artefatos, sempre pelo guarda de rede, e grava os
// artefatos em dir.
type Fetcher struct {
	guard guardedNet
	dir   string
}

// NewFetcher monta o buscador. dir é onde os artefatos verificados ficam.
func NewFetcher(guard *netguard.Guard, dir string) *Fetcher {
	if guard == nil {
		// Um *netguard.Guard nil guardado numa interface produz uma interface
		// NÃO-nil, e o `f.guard == nil` lá embaixo passaria batido para estourar
		// em pânico na primeira busca. Recusar sem rede é o desfecho certo.
		return &Fetcher{dir: dir}
	}
	return &Fetcher{guard: guard, dir: dir}
}

// Manifest busca o manifesto e só o devolve depois de a assinatura conferir.
//
// A ordem é assinatura ANTES de qualquer outra checagem. Não é economia de
// linha: assim não existe caminho em que um campo de manifesto não verificado
// tenha influenciado alguma decisão, nem que seja a de qual erro relatar.
func (f *Fetcher) Manifest(ctx context.Context, rawURL string, key ed25519.PublicKey) (Manifest, error) {
	response, err := f.get(ctx, rawURL)
	if err != nil {
		return Manifest{}, err
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxManifestSize+1))
	_ = response.Body.Close()
	if err != nil {
		return Manifest{}, fmt.Errorf("ler o manifesto: %w", err)
	}
	if int64(len(body)) > maxManifestSize {
		return Manifest{}, fmt.Errorf("manifesto acima de %d bytes", maxManifestSize)
	}

	var manifest Manifest
	if err := json.Unmarshal(body, &manifest); err != nil {
		return Manifest{}, fmt.Errorf("ler o manifesto: %w", err)
	}
	if err := Verify(manifest, key); err != nil {
		return Manifest{}, err
	}
	if manifest.SchemaVersion != SchemaVersion {
		// Assinado e mesmo assim recusado: a assinatura diz que o publicador é
		// quem diz ser, não que este binário entende o que ele publicou.
		return Manifest{}, fmt.Errorf("manifesto de esquema %d; este binário entende %d", manifest.SchemaVersion, SchemaVersion)
	}
	return manifest, nil
}

// Artifact baixa o artefato, confere o SHA-256 em streaming e devolve o caminho
// do arquivo verificado.
//
// A gravação é em `.part` e o arquivo só ganha o nome final depois de tamanho e
// hash baterem. É o que garante que arquivo meio baixado nunca vira arquivo
// válido — o processo pode morrer no meio, a rede pode cair, o servidor pode
// cortar a conexão, e o pior desfecho é um `.part` órfão, que ninguém executa.
//
// Se o arquivo final já existir com o hash certo, NÃO baixa de novo: o artefato
// é imutável e endereçado por hash, então rebaixar é desperdício — e é o caso
// comum do rollback, que republica a versão anterior.
func (f *Fetcher) Artifact(ctx context.Context, artifact Artifact) (string, error) {
	digest, err := parseDigest(artifact.SHA256)
	if err != nil {
		return "", err
	}
	if err := checkArtifactID(artifact.ID); err != nil {
		return "", err
	}
	if artifact.Size <= 0 || artifact.Size > maxArtifactSize {
		return "", fmt.Errorf("artefato %q declara tamanho %d, fora do aceitável (1..%d)", artifact.ID, artifact.Size, maxArtifactSize)
	}
	if err := os.MkdirAll(f.dir, 0o700); err != nil {
		return "", fmt.Errorf("preparar o diretório de atualização: %w", err)
	}

	final := artifactPath(f.dir, artifact.ID, digest)
	if ok, err := fileMatches(final, artifact.Size, digest); err != nil {
		return "", err
	} else if ok {
		return final, nil
	}

	response, err := f.get(ctx, artifact.URL)
	if err != nil {
		return "", err
	}
	defer func() { _ = response.Body.Close() }()

	part := final + ".part"
	// 0600: este arquivo vira executável (o aibotd) ou código que roda com
	// acesso a invoke() (o bundle). Um artefato que outro usuário da máquina
	// pode escrever entre a verificação e o uso é escalada de privilégio local
	// — e teria passado por toda a assinatura sem ela servir para nada.
	file, err := os.OpenFile(part, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return "", fmt.Errorf("gravar o artefato %q: %w", artifact.ID, err)
	}
	discard := func(cause error) (string, error) {
		_ = file.Close()
		_ = os.Remove(part)
		return "", cause
	}

	// O hash é calculado enquanto os bytes passam, não relendo o arquivo depois:
	// reler é uma segunda leitura do disco e, pior, deixa uma janela entre o
	// que foi gravado e o que foi conferido.
	//
	// O LimitReader é o tamanho declarado MAIS UM byte: com o teto exato, um
	// corpo maior que o declarado chegaria truncado e reprovaria apenas no
	// hash; com o byte extra, a diferença de tamanho aparece como tal.
	hasher := sha256.New()
	written, err := io.Copy(file, io.TeeReader(io.LimitReader(response.Body, artifact.Size+1), hasher))
	if err != nil {
		return discard(fmt.Errorf("baixar o artefato %q: %w", artifact.ID, err))
	}
	if written != artifact.Size {
		return discard(fmt.Errorf("artefato %q: chegaram %d bytes e o manifesto declara %d", artifact.ID, written, artifact.Size))
	}
	if sum := hasher.Sum(nil); !bytes.Equal(sum, digest) {
		return discard(fmt.Errorf("artefato %q: sha256 %s, e o manifesto declara %s",
			artifact.ID, hex.EncodeToString(sum), hex.EncodeToString(digest)))
	}

	// Sync antes do rename: sem ele, uma queda de energia logo depois pode
	// deixar o nome final publicado apontando para bytes que nunca chegaram ao
	// disco — que é exatamente o "arquivo meio baixado vira arquivo válido" que
	// o `.part` existe para impedir.
	if err := file.Sync(); err != nil {
		return discard(fmt.Errorf("sincronizar o artefato %q: %w", artifact.ID, err))
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(part)
		return "", fmt.Errorf("fechar o artefato %q: %w", artifact.ID, err)
	}
	// No Windows os.Rename usa MoveFileEx com REPLACE_EXISTING, então substituir
	// arquivo existente funciona igual ao Unix.
	if err := os.Rename(part, final); err != nil {
		_ = os.Remove(part)
		return "", fmt.Errorf("publicar o artefato %q: %w", artifact.ID, err)
	}
	return final, nil
}

/* --------------------------------- apoio ---------------------------------- */

// get faz o GET guardado e devolve a resposta com o CORPO ABERTO, para quem
// chama decidir se lê tudo na memória (manifesto) ou em streaming (artefato).
//
// O redirect é seguido à mão porque cada salto é uma URL nova e precisa passar
// pelas mesmas checagens — cliente que segue redirect sozinho valida o primeiro
// endereço e conecta no que o servidor mandar, que é o furo inteiro com um
// passo a mais. Vale a pena para valer: artefato costuma morar em CDN, e CDN
// redireciona.
func (f *Fetcher) get(ctx context.Context, rawURL string) (*http.Response, error) {
	if f.guard == nil {
		return nil, errors.New("sem canal de rede guardado para buscar a atualização")
	}

	current := rawURL
	for hop := 0; hop <= netguard.MaxRedirects; hop++ {
		target, approved, err := f.guard.Check(ctx, current)
		if err != nil {
			return nil, err
		}
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
		if err != nil {
			return nil, fmt.Errorf("montar requisição: %w", err)
		}
		request.Header.Set("User-Agent", "AI-BOT/1.0")

		response, err := f.guard.Client(approved).Do(request)
		if err != nil {
			return nil, fmt.Errorf("buscar %s: %w", target.Host, err)
		}

		if isRedirect(response.StatusCode) {
			location := response.Header.Get("Location")
			_ = response.Body.Close()
			if location == "" {
				return nil, fmt.Errorf("%s respondeu %d sem Location", target.Host, response.StatusCode)
			}
			next, err := target.Parse(location)
			if err != nil {
				return nil, fmt.Errorf("redirect inválido: %w", err)
			}
			current = next.String()
			continue
		}
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			_ = response.Body.Close()
			return nil, fmt.Errorf("%s respondeu %d", target.Host, response.StatusCode)
		}
		return response, nil
	}
	return nil, fmt.Errorf("%w: mais de %d redirecionamentos", netguard.ErrBlocked, netguard.MaxRedirects)
}

func isRedirect(status int) bool {
	switch status {
	case http.StatusMovedPermanently, http.StatusFound, http.StatusSeeOther,
		http.StatusTemporaryRedirect, http.StatusPermanentRedirect:
		return true
	default:
		return false
	}
}

// artifactPath é o nome do artefato em disco, e existe em UM lugar só.
//
// O nome carrega o hash porque o conteúdo é a identidade: duas publicações do
// mesmo id com bytes diferentes são dois arquivos, e nenhuma sobrescreve a
// outra. É isso que deixa a versão anterior no disco para o rollback.
//
// Uma função porque há dois chamadores — quem baixa (aqui) e quem reencontra o
// que já foi aplicado depois de reiniciar (service.go). Duas cópias da regra de
// nomes divergiriam no dia em que o prefixo mudasse de tamanho, e a divergência
// apareceria como "baixa tudo de novo a cada boot", que ninguém investiga.
func artifactPath(dir, id string, digest []byte) string {
	return filepath.Join(dir, id+"-"+hex.EncodeToString(digest)[:12])
}

// parseDigest lê o SHA-256 declarado. Maiúscula ou minúscula dá no mesmo — hex
// não tem caixa —, mas o tamanho é exato: hash curto é hash que confere com
// prefixo, e prefixo não é hash.
func parseDigest(text string) ([]byte, error) {
	digest, err := hex.DecodeString(strings.ToLower(strings.TrimSpace(text)))
	if err != nil {
		return nil, fmt.Errorf("sha256 declarado não é hexadecimal: %w", err)
	}
	if len(digest) != sha256.Size {
		return nil, fmt.Errorf("sha256 declarado tem %d bytes, e SHA-256 usa %d", len(digest), sha256.Size)
	}
	return digest, nil
}

// checkArtifactID recusa id que não sirva de nome de arquivo.
//
// O id vem de um documento assinado, e ainda assim é conferido: o nome final é
// montado com ele, então um id como `..\..\aibotd` transformaria "gravar
// artefato verificado" em escrita de arquivo arbitrária. Confiar aqui é
// apostar que o publicador nunca vai errar um campo — e a assinatura garante
// QUEM publicou, não que o conteúdo esteja certo.
func checkArtifactID(id string) error {
	if id == "" {
		return errors.New("artefato sem id")
	}
	if len(id) > 64 {
		return fmt.Errorf("id de artefato longo demais (%d caracteres)", len(id))
	}
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9',
			r == '.', r == '_', r == '-':
		default:
			return fmt.Errorf("id de artefato %q tem caractere inválido %q", id, r)
		}
	}
	if strings.Trim(id, ".") == "" {
		return fmt.Errorf("id de artefato %q não é nome de arquivo", id)
	}
	return nil
}

// fileMatches diz se o arquivo já no disco é o artefato esperado.
//
// Confere tamanho e hash, não só a existência: o nome carrega apenas 12 dígitos
// do hash, e um arquivo com o nome certo continua sendo um arquivo que alguém
// pode ter trocado depois de gravado. Rebaixar custa rede; reconferir custa uma
// leitura de disco.
func fileMatches(path string, size int64, digest []byte) (bool, error) {
	info, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("conferir o artefato em disco: %w", err)
	}
	if !info.Mode().IsRegular() || info.Size() != size {
		return false, nil
	}

	file, err := os.Open(path)
	if err != nil {
		return false, fmt.Errorf("conferir o artefato em disco: %w", err)
	}
	defer func() { _ = file.Close() }()

	hasher := sha256.New()
	if _, err := io.Copy(hasher, file); err != nil {
		return false, fmt.Errorf("conferir o artefato em disco: %w", err)
	}
	return bytes.Equal(hasher.Sum(nil), digest), nil
}
