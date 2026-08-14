// Package update é o núcleo da atualização do AI-BOT: o manifesto, a
// verificação da assinatura e o download conferido.
//
// A atualização é dividida por O QUE MUDA, não por "o app" (ver
// docs/atualizacao.md): dado (catálogo de especialistas, de modelos, política),
// interface (o bundle web), cérebro (o próprio aibotd) e casca nativa (o
// Tauri/Rust, que só troca por instalador). As três primeiras trilhas são
// descritas por um manifesto único, assinado, e é ele que este pacote entende.
//
// # Por que quem verifica é o Go
//
// A cadeia de confiança é esta, e cada elo confia no anterior por um motivo
// diferente:
//
//	instalador assinado (Authenticode + updater do Tauri)
//	 └─ casca Rust                       confia porque foi instalada
//	     └─ aibotd, do diretório de instalação   confia porque a casca o lançou
//	         └─ manifesto Ed25519        verificado AQUI, com a stdlib
//	             └─ dados, bundle da interface, próximo aibotd
//
// Verificar aqui resolve a dependência sem negociar segurança: `crypto/ed25519`
// e `crypto/sha256` são biblioteca padrão, então nenhuma linguagem do produto
// ganha crate ou pacote novo por causa da atualização. Escrever criptografia à
// mão está fora de questão — e aqui não é preciso.
//
// # As regras que sustentam isso
//
//  1. A chave pública é EMBUTIDA em tempo de compilação e chega aqui como
//     parâmetro. Chave que viaja junto com o que ela assina não assina nada.
//  2. O que é assinado é o corpo CANÔNICO (ver Canonical), não o JSON que veio
//     na resposta.
//  3. Cada artefato tem SHA-256 próprio, conferido em streaming (ver fetch.go).
//     A assinatura do manifesto cobre o hash; o hash cobre os bytes.
//
// O que NUNCA passa por aqui: a casca Rust, a CSP e a semântica do portão de
// permissão. Quem pode trocar o portão por rede não tem portão.
package update

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// SchemaVersion é a única forma de manifesto que este binário entende.
//
// Recusar o que não conhece é deliberado: um manifesto de esquema mais novo
// pode dar significado diferente a um campo que já existe, e aplicar metade de
// um contrato novo é pior do que recusar o contrato inteiro.
const SchemaVersion = 1

// Track é a trilha do artefato — o "o que muda" de docs/atualizacao.md.
type Track string

const (
	// TrackData é catálogo e política: aplica a quente, em segundos.
	TrackData Track = "data"
	// TrackUI é o bundle web. Roda com acesso a invoke(), então tem o MESMO
	// rigor de assinatura do instalador — não é "só o front-end".
	TrackUI Track = "ui"
	// TrackGateway é o próprio aibotd: é sidecar, basta reiniciá-lo.
	TrackGateway Track = "gateway"
	// TrackShell é a casca Tauri/Rust. Aparece no manifesto para o app saber
	// que existe versão nova, mas quem aplica é o updater do Tauri.
	TrackShell Track = "shell"
)

// Artifact é um arquivo publicado: imutável e endereçado por hash.
//
// Imutável não é adjetivo de folheto — é o que faz reverter ser um caminho
// comum em vez de um caminho especial que ninguém testa: publicar de novo a
// versão anterior baixa um artefato que já foi verificado uma vez.
type Artifact struct {
	Track Track  `json:"track"`
	ID    string `json:"id"`
	URL   string `json:"url"`
	// Size é o tamanho declarado. Além de conferir o que chegou, ele é o teto
	// do download: sem tamanho declarado, um servidor que transmite para sempre
	// enche o disco antes de o hash ter chance de reprovar nada.
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

// Manifest descreve uma publicação inteira.
type Manifest struct {
	SchemaVersion int       `json:"schemaVersion"`
	Product       string    `json:"product"`
	Channel       string    `json:"channel"`
	Version       string    `json:"version"`
	PublishedAt   time.Time `json:"publishedAt"`
	// MinimumShellVersion é o piso da casca nativa. Existe porque as trilhas
	// não são independentes de verdade: uma interface que chama um comando
	// Tauri que a casca instalada não tem abre em branco. O manifesto declara o
	// piso e o app recusa a atualização em vez de se quebrar.
	MinimumShellVersion string     `json:"minimumShellVersion"`
	Artifacts           []Artifact `json:"artifacts"`
	// Signature é Ed25519 sobre o corpo canônico, em base64url SEM padding.
	Signature string `json:"signature"`
}

/* ------------------------------ corpo canônico ---------------------------- */

// Canonical devolve o corpo que é assinado: o manifesto SEM o campo signature,
// com as chaves ORDENADAS.
//
// O ponto está em não assinar "o JSON como veio". Assinar os bytes da resposta
// seria assinar a FORMATAÇÃO: espaço a mais, ordem de chave trocada por um
// proxy ou um CDN que reserializa, e a assinatura de um manifesto legítimo para
// de conferir. Do outro lado, guardar o texto original só para verificar
// depois obriga o resto do programa a carregar bytes crus junto do struct — e o
// dia em que alguém verificar os bytes e usar o struct de outra origem é o dia
// em que a verificação vira decoração.
//
// Então o corpo canônico é derivado do struct JÁ interpretado, e é sempre o
// mesmo para o mesmo conteúdo:
//
//   - chaves ordenadas — o encoder da stdlib ordena chave de map, e por isso
//     tanto o manifesto quanto cada artefato viram map aqui (struct seria
//     serializado na ordem de declaração, que é uma convenção do Go, não do
//     formato);
//   - `publishedAt` normalizado em UTC, para "+00:00" e "Z" não produzirem
//     corpos diferentes do mesmo instante;
//   - `artifacts` sempre array, para `null` e `[]` — que significam a mesma
//     coisa — não produzirem corpos diferentes;
//   - sem escape de HTML, para o corpo bater com o que um publicador em outra
//     linguagem produz naturalmente.
//
// Campo que NÃO está aqui não é assinado. Consequência prática, e ela é a razão
// de SchemaVersion existir: nada fora deste struct pode decidir coisa alguma,
// porque qualquer um pode acrescentar um campo desconhecido sem quebrar a
// assinatura.
func Canonical(m Manifest) ([]byte, error) {
	artifacts := make([]any, 0, len(m.Artifacts))
	for _, artifact := range m.Artifacts {
		artifacts = append(artifacts, map[string]any{
			"track":  string(artifact.Track),
			"id":     artifact.ID,
			"url":    artifact.URL,
			"size":   artifact.Size,
			"sha256": artifact.SHA256,
		})
	}

	body := map[string]any{
		"schemaVersion":       m.SchemaVersion,
		"product":             m.Product,
		"channel":             m.Channel,
		"version":             m.Version,
		"publishedAt":         m.PublishedAt.UTC().Format(time.RFC3339Nano),
		"minimumShellVersion": m.MinimumShellVersion,
		"artifacts":           artifacts,
	}

	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(body); err != nil {
		return nil, fmt.Errorf("serializar o corpo canônico: %w", err)
	}
	// O Encode termina com \n. Ele não faz parte do corpo assinado.
	return bytes.TrimRight(buffer.Bytes(), "\n"), nil
}

/* ------------------------------- assinatura ------------------------------- */

var (
	// ErrNoPublicKey é a recusa mais importante do pacote: sem chave embutida,
	// este binário NÃO aceita atualização. O modo de falha que ele fecha é o
	// mais barato de todos — compilar sem a chave e o verificador passar a
	// aceitar qualquer coisa "porque não havia com o que comparar".
	ErrNoPublicKey = errors.New("sem chave pública de atualização embutida neste binário")
	// ErrMalformedSignature é assinatura que nem chega a ser conferida.
	ErrMalformedSignature = errors.New("assinatura malformada")
	// ErrSignatureMismatch é assinatura bem formada que não confere com o
	// corpo. É o caso do manifesto adulterado depois de assinado.
	ErrSignatureMismatch = errors.New("assinatura não confere com o manifesto")
)

// Verify confere a assinatura Ed25519 do manifesto com a chave embutida.
//
// Os três erros são distintos de propósito: "sem chave" é defeito de build,
// "malformada" é publicação errada e "não confere" é a única que significa
// manifesto adulterado (ou chave trocada). Colapsar os três num só erro faz o
// primeiro incidente de verdade parecer um erro de digitação.
func Verify(m Manifest, publicKey ed25519.PublicKey) error {
	if len(publicKey) == 0 {
		return ErrNoPublicKey
	}
	if len(publicKey) != ed25519.PublicKeySize {
		// ed25519.Verify entra em PÂNICO com chave de tamanho errado. Uma chave
		// truncada por erro de build derrubaria o gateway em vez de recusar a
		// atualização, então o tamanho é conferido antes.
		return fmt.Errorf("%w: a chave tem %d bytes, e Ed25519 usa %d", ErrNoPublicKey, len(publicKey), ed25519.PublicKeySize)
	}
	if strings.TrimSpace(m.Signature) == "" {
		return fmt.Errorf("%w: manifesto sem o campo signature", ErrMalformedSignature)
	}

	// base64url SEM padding, e só isso. Aceitar também a forma padrão (ou o
	// padding opcional) dobraria as representações do mesmo valor sem ganhar
	// nada: quem publica é a nossa própria ferramenta.
	signature, err := base64.RawURLEncoding.DecodeString(m.Signature)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrMalformedSignature, err)
	}
	if len(signature) != ed25519.SignatureSize {
		return fmt.Errorf("%w: tem %d bytes, e Ed25519 usa %d", ErrMalformedSignature, len(signature), ed25519.SignatureSize)
	}

	body, err := Canonical(m)
	if err != nil {
		return err
	}
	if !ed25519.Verify(publicKey, body, signature) {
		return ErrSignatureMismatch
	}
	return nil
}

/* --------------------------------- versão --------------------------------- */

// Newer diz se o manifesto é mais novo do que a versão em uso.
//
// A comparação é SEMÂNTICA, não lexicográfica, e essa é a razão de a função
// existir: como texto, "0.10.0" é MENOR que "0.9.0" — o '1' vem antes do '9' —
// e o app pararia de se atualizar exatamente na décima versão menor, em
// silêncio, sem nenhum erro para investigar.
func (m Manifest) Newer(current string) bool {
	return CompareVersions(m.Version, current) > 0
}

// SupportedByShell diz se a casca nativa instalada alcança o piso do manifesto.
//
// Versão de casca ilegível conta como 0.0.0, ou seja, recusa quando há piso
// declarado. É a direção segura: o preço de recusar é "atualize o instalador",
// e o preço de aceitar é uma janela em branco.
func (m Manifest) SupportedByShell(shell string) bool {
	if strings.TrimSpace(m.MinimumShellVersion) == "" {
		return true
	}
	return CompareVersions(shell, m.MinimumShellVersion) >= 0
}

// CompareVersions compara major.minor.patch e devolve -1, 0 ou 1.
func CompareVersions(a, b string) int {
	left, right := parseVersion(a), parseVersion(b)
	for i := range left {
		switch {
		case left[i] > right[i]:
			return 1
		case left[i] < right[i]:
			return -1
		}
	}
	return 0
}

// parseVersion extrai major.minor.patch sem NUNCA falhar: o que não dá para ler
// vale 0.
//
// Não falhar é escolha, não desleixo. Versão vem de três origens diferentes (o
// manifesto, o binário em execução e a casca instalada) e uma delas eventualmente
// chega vazia ou suja; um erro aqui só empurraria a decisão para o chamador, que
// teria de inventar um valor mesmo assim. Com "ilegível é 0.0.0" as duas pontas
// caem no lado seguro: manifesto ilegível nunca é mais novo (0.0.0 não supera
// nada), e piso de casca ilegível nunca libera.
//
// Sufixo de pré-lançamento ("-rc1", "+build") é cortado, não ordenado: quem
// separa pré-lançamento aqui é o `channel` do manifesto, e meia implementação de
// semver ordenaria errado com toda a aparência de estar certa.
func parseVersion(raw string) [3]int {
	text := strings.TrimPrefix(strings.TrimSpace(raw), "v")
	if cut := strings.IndexAny(text, "-+"); cut >= 0 {
		text = text[:cut]
	}

	var out [3]int
	for i, part := range strings.SplitN(text, ".", len(out)+1) {
		if i >= len(out) {
			break
		}
		number, err := strconv.Atoi(strings.TrimSpace(part))
		if err != nil || number < 0 {
			continue // fica 0
		}
		out[i] = number
	}
	return out
}
