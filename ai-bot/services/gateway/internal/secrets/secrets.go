// Package secrets é o cofre do gateway.
//
// A regra herdada do app anterior, e que não pode ser afrouxada: quem chama
// trabalha com REFERÊNCIA, nunca com valor. A UI manda "provider:openai" e o
// gateway resolve na hora de usar. O valor não volta por API, não entra em
// log e não aparece em mensagem de erro — e isso não é purismo: metade dos
// segredos deste produto é uma URL de webhook, onde a própria URL É o segredo.
// Propagar cru o erro do cliente HTTP ("Post \"https://hooks.../T0/B0/xxx\":
// dial tcp: timeout") vaza o segredo inteiro dentro da mensagem. Por isso Use
// passa o valor para um callback e censura o erro que ele devolver.
//
// Formato do valor selado, idêntico ao do gateway em Rust para os dois lados
// lerem o mesmo arquivo: base64( nonce[12] || ciphertext+tag ), AES-256-GCM.
//
// O que este pacote NÃO faz, de propósito: derivar chave a partir de senha.
// scrypt/argon2 vivem em golang.org/x/crypto e PBKDF2 só entrou na biblioteca
// padrão depois do Go 1.22 — as duas coisas violariam a regra de zero
// dependências do módulo. Então a chave mestra chega aqui pronta, 32 bytes,
// vinda de quem tem o cofre do sistema operacional (a camada Rust do desktop).
// Se um dia a derivação precisar acontecer no Go, ela entra como pacote novo
// com KDF escrito à mão e revisão de TI/SI — não como import de terceiro.
package secrets

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

// ErrNoSecret diz que a referência pedida não existe no cofre. É erro comum e
// esperado (usuário ainda não configurou o provedor), não falha de sistema.
var ErrNoSecret = errors.New("segredo não encontrado")

const (
	// fileVersion trava o formato em disco. Versão diferente = recusar em vez
	// de reescrever: o arquivo é a única cópia dos segredos do usuário.
	fileVersion = 1

	// masterKeyLen são os 32 bytes do AES-256.
	masterKeyLen = 32

	// nonceLen é o nonce padrão do GCM. Está fixo aqui porque é contrato de
	// arquivo com o lado Rust, não detalhe interno.
	nonceLen = 12

	// minSealedLen é o mínimo que faz sentido fatiar: nonce + pelo menos um
	// byte. A conferência tem de vir ANTES do slice — fatiar um buffer curto
	// entra em panic, e panic em caminho normal é proibido no gateway.
	minSealedLen = nonceLen + 1

	// minRedactLen é o piso para censurar. Trocar uma string de 3 caracteres
	// destruiria texto legítimo (o "id" de "id do usuário" viraria "•••").
	minRedactLen = 8

	// mask é o que fica no lugar do segredo.
	mask = "•••"
)

// vaultFile é o JSON em disco: {"version":1,"entries":{"<ref>":"<selado>"}}.
type vaultFile struct {
	Version int               `json:"version"`
	Entries map[string]string `json:"entries"`
}

// Vault é o cofre aberto em memória. Guarda apenas valores selados; o texto
// claro só existe dentro de Use, pelo tempo do callback.
type Vault struct {
	mu   sync.RWMutex
	path string
	// aead guarda a chave já expandida. Preferido a guardar os 32 bytes: quem
	// chamou Open pode zerar o slice dele em seguida sem quebrar o cofre, e o
	// pacote não mantém uma segunda cópia da chave crua passeando pelo heap.
	aead    cipher.AEAD
	entries map[string]string
}

// Open abre (ou cria) o cofre em path. masterKey precisa ter exatamente 32
// bytes; qualquer outro tamanho é erro, não ajuste silencioso.
func Open(path string, masterKey []byte) (*Vault, error) {
	if path == "" {
		return nil, errors.New("caminho do cofre vazio")
	}
	aead, err := newAEAD(masterKey)
	if err != nil {
		return nil, err
	}
	vault := &Vault{path: path, aead: aead, entries: make(map[string]string)}

	raw, err := os.ReadFile(path)
	switch {
	case err == nil:
		var file vaultFile
		if err := json.Unmarshal(raw, &file); err != nil {
			// Não recriamos o arquivo aqui. JSON quebrado ainda é o único
			// lugar onde os segredos existem: recriar vazio seria apagá-los
			// para "consertar" o erro.
			return nil, fmt.Errorf("ler cofre %s: %w", filepath.Base(path), err)
		}
		if file.Version != fileVersion {
			return nil, fmt.Errorf("versão de cofre desconhecida: %d", file.Version)
		}
		if file.Entries != nil {
			vault.entries = file.Entries
		}
	case os.IsNotExist(err):
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return nil, fmt.Errorf("criar diretório do cofre: %w", err)
		}
		// Grava já na criação para o arquivo nascer com 0600, e não com a
		// permissão que sobrar do primeiro Set.
		if err := vault.persistLocked(); err != nil {
			return nil, err
		}
	default:
		return nil, fmt.Errorf("abrir cofre %s: %w", filepath.Base(path), err)
	}

	if err := vault.checkKey(); err != nil {
		return nil, err
	}
	return vault, nil
}

// checkKey falha cedo quando a chave mestra não é a deste cofre. Sem isso o
// sintoma apareceria só no primeiro Use, disfarçado de "segredo inválido" no
// meio de uma chamada ao provedor — a hora errada de descobrir.
//
// Tenta as entradas até uma abrir: se travasse na primeira, um bit trocado num
// único segredo trancaria o acesso a todos os outros.
func (v *Vault) checkKey() error {
	if len(v.entries) == 0 {
		return nil
	}
	for _, sealed := range v.entries {
		plain, err := openWith(v.aead, sealed)
		if err == nil {
			zero(plain)
			return nil
		}
	}
	return errors.New("chave mestra não abre este cofre")
}

// Set sela o valor e grava. Cada Set sorteia um nonce novo — reutilizar nonce
// com a mesma chave quebra o GCM por inteiro, não só a mensagem repetida.
func (v *Vault) Set(ref string, value string) error {
	if ref == "" {
		return errors.New("referência vazia")
	}
	if value == "" {
		// Segredo vazio é quase sempre variável de ambiente que não existia.
		// Aceitar deixaria Has dizendo "configurado" e o provedor devolvendo
		// 401 sem ninguém entender o porquê.
		return fmt.Errorf("valor vazio para %s", ref)
	}
	sealed, err := sealWith(v.aead, []byte(value))
	if err != nil {
		return fmt.Errorf("selar %s: %w", ref, err)
	}

	v.mu.Lock()
	defer v.mu.Unlock()
	previous, existed := v.entries[ref]
	v.entries[ref] = sealed
	if err := v.persistLocked(); err != nil {
		// Desfaz para memória e disco não divergirem: um cofre que "tem" na
		// memória o que não tem no arquivo volta diferente no próximo boot.
		if existed {
			v.entries[ref] = previous
		} else {
			delete(v.entries, ref)
		}
		return err
	}
	return nil
}

// Has responde se a referência existe. NUNCA devolve o valor — é o que a UI
// usa para desenhar "configurado / não configurado".
func (v *Vault) Has(ref string) bool {
	v.mu.RLock()
	defer v.mu.RUnlock()
	_, ok := v.entries[ref]
	return ok
}

// Delete remove a referência. Apagar o que já não existe não é erro: o estado
// final pedido é o mesmo, e falhar aí só geraria tratamento inútil em quem chama.
func (v *Vault) Delete(ref string) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	previous, existed := v.entries[ref]
	if !existed {
		return nil
	}
	delete(v.entries, ref)
	if err := v.persistLocked(); err != nil {
		v.entries[ref] = previous
		return err
	}
	return nil
}

// Refs lista só os nomes, ordenados para a UI não dançar entre dois desenhos.
func (v *Vault) Refs() []string {
	v.mu.RLock()
	refs := make([]string, 0, len(v.entries))
	for ref := range v.entries {
		refs = append(refs, ref)
	}
	v.mu.RUnlock()
	sort.Strings(refs)
	return refs
}

// Use é a ÚNICA forma de ler um segredo. O valor vive dentro do callback e não
// é devolvido: assim ele não escorre para log, resposta HTTP nem para uma
// variável de quem chamou que depois vira %v em algum lugar.
//
// Se fn devolver erro, a mensagem é censurada antes de subir (ver Redact). O
// caso que motiva isso é o webhook, onde o cliente HTTP põe a URL — o segredo —
// dentro do texto do erro.
func (v *Vault) Use(ref string, fn func(secret string) error) error {
	if fn == nil {
		return errors.New("callback nulo")
	}

	// Copia o selado e solta o lock antes de chamar fn: o callback é código de
	// terceiro que pode demorar (chamada de rede) e pode reentrar no cofre —
	// RWMutex do Go não é reentrante, e segurar aqui travaria tudo.
	v.mu.RLock()
	sealed, ok := v.entries[ref]
	v.mu.RUnlock()
	if !ok {
		return fmt.Errorf("%s: %w", ref, ErrNoSecret)
	}

	plain, err := openWith(v.aead, sealed)
	if err != nil {
		return fmt.Errorf("abrir segredo %s: %w", ref, err)
	}
	secret := string(plain)
	// string(plain) copiou; o buffer intermediário pode ir a zero. A cópia em
	// si não dá para limpar — string em Go é imutável e some só com o GC.
	zero(plain)

	if err := fn(secret); err != nil {
		clean := Redact(err.Error(), []string{secret})
		if clean == err.Error() {
			return err
		}
		return &redactedError{msg: clean, cause: err}
	}
	return nil
}

// redactedError troca a mensagem visível pela versão sem o segredo.
type redactedError struct {
	msg   string
	cause error
}

func (e *redactedError) Error() string { return e.msg }

// Unwrap mantém errors.Is e errors.As funcionando (essas duas nunca chamam
// Error(), então não vazam). Quem chamar errors.Unwrap e imprimir o resultado
// volta a expor o segredo — a rede de proteção é a mensagem, não a corrente.
func (e *redactedError) Unwrap() error { return e.cause }

// Seal sela um valor avulso, para quem precisa gravar em outro lugar que não o
// cofre (o arquivo de projeto, por exemplo) mantendo o mesmo formato.
func Seal(masterKey []byte, plaintext string) (string, error) {
	aead, err := newAEAD(masterKey)
	if err != nil {
		return "", err
	}
	return sealWith(aead, []byte(plaintext))
}

// Open2 abre um valor selado avulso. O nome tem o 2 porque Open já é o
// construtor do cofre; renomear o construtor seria pior, é ele que aparece em
// todo lugar. Devolve o texto claro na mão de quem chamou — prefira Use
// sempre que o segredo estiver no cofre.
func Open2(masterKey []byte, sealed string) (string, error) {
	aead, err := newAEAD(masterKey)
	if err != nil {
		return "", err
	}
	plain, err := openWith(aead, sealed)
	if err != nil {
		return "", err
	}
	secret := string(plain)
	zero(plain)
	return secret, nil
}

// Redact troca cada segredo por mask no texto. Roda antes de gravar saída de
// ferramenta no log, onde o segredo entra por acidente (um curl com o token no
// header ecoado de volta, por exemplo).
//
// Segredo com menos de minRedactLen bytes é ignorado de propósito. Bytes, não
// runas: segredo com acento não existe no mundo real e a contagem exata não
// mudaria nenhuma decisão aqui.
func Redact(text string, secrets []string) string {
	if text == "" || len(secrets) == 0 {
		return text
	}
	ordered := make([]string, 0, len(secrets))
	for _, secret := range secrets {
		if len(secret) < minRedactLen {
			continue
		}
		ordered = append(ordered, secret)
	}
	if len(ordered) == 0 {
		return text
	}
	// Do maior para o menor: quando um segredo é prefixo de outro (a URL base
	// e a URL com o caminho do webhook), trocar o curto primeiro deixaria o
	// resto do longo visível no texto.
	sort.Slice(ordered, func(i, j int) bool { return len(ordered[i]) > len(ordered[j]) })
	for _, secret := range ordered {
		text = strings.ReplaceAll(text, secret, mask)
	}
	return text
}

// newAEAD monta o AES-256-GCM a partir da chave mestra.
func newAEAD(masterKey []byte) (cipher.AEAD, error) {
	if len(masterKey) != masterKeyLen {
		return nil, fmt.Errorf("chave mestra precisa de %d bytes, veio com %d", masterKeyLen, len(masterKey))
	}
	block, err := aes.NewCipher(masterKey)
	if err != nil {
		return nil, fmt.Errorf("montar cifra: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("montar gcm: %w", err)
	}
	// Hoje o GCM padrão da biblioteca é sempre 12; a conferência existe para o
	// dia em que não for, porque aí o arquivo deixaria de abrir no lado Rust
	// silenciosamente. Erro, não panic.
	if gcm.NonceSize() != nonceLen {
		return nil, fmt.Errorf("nonce do gcm mudou de tamanho: %d", gcm.NonceSize())
	}
	return gcm, nil
}

// sealWith produz base64( nonce || ciphertext+tag ).
func sealWith(aead cipher.AEAD, plaintext []byte) (string, error) {
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", fmt.Errorf("sortear nonce: %w", err)
	}
	// Seal escrevendo no próprio nonce: o retorno já sai como nonce || cifra,
	// que é exatamente o formato do arquivo.
	sealed := aead.Seal(nonce, nonce, plaintext, nil)
	// StdEncoding com padding — é o que o lado Rust escreve e lê.
	return base64.StdEncoding.EncodeToString(sealed), nil
}

// openWith desfaz sealWith. Devolve []byte para quem chamou poder zerar.
func openWith(aead cipher.AEAD, sealed string) ([]byte, error) {
	raw, err := base64.StdEncoding.DecodeString(sealed)
	if err != nil {
		return nil, fmt.Errorf("selado não é base64: %w", err)
	}
	if len(raw) < minSealedLen {
		return nil, errors.New("selado curto demais")
	}
	nonce := raw[:aead.NonceSize()]
	plain, err := aead.Open(nil, nonce, raw[aead.NonceSize():], nil)
	if err != nil {
		// A tag do GCM já pegou adulteração. O erro sai genérico de propósito:
		// distinguir "chave errada" de "byte trocado" é dica de graça para
		// quem estiver mexendo no arquivo.
		return nil, errors.New("selado inválido ou adulterado")
	}
	return plain, nil
}

// persistLocked grava o cofre inteiro. Exige v.mu tomado em modo escrita (ou
// que o cofre ainda não esteja publicado, como acontece dentro de Open).
func (v *Vault) persistLocked() error {
	raw, err := json.MarshalIndent(vaultFile{Version: fileVersion, Entries: v.entries}, "", "  ")
	if err != nil {
		return fmt.Errorf("serializar cofre: %w", err)
	}
	return writeFileAtomic(v.path, raw)
}

// writeFileAtomic grava por temporário + rename. Escrever por cima do original
// deixa o cofre truncado se o processo morrer no meio — e cofre truncado é a
// chave do usuário perdida, não um arquivo a reconstruir.
//
// O 0600 vale no POSIX; no Windows a ACL vem herdada do diretório de dados do
// app, que já é do usuário. O temporário nasce com a mesma permissão para não
// existir nem por um instante um arquivo de segredos legível por todos.
func writeFileAtomic(path string, raw []byte) error {
	temporary := path + ".tmp"
	file, err := os.OpenFile(temporary, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("gravar cofre: %w", err)
	}
	if _, err := file.Write(raw); err != nil {
		_ = file.Close()
		_ = os.Remove(temporary)
		return fmt.Errorf("gravar cofre: %w", err)
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		_ = os.Remove(temporary)
		return fmt.Errorf("sincronizar cofre: %w", err)
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(temporary)
		return fmt.Errorf("fechar cofre: %w", err)
	}
	if err := os.Rename(temporary, path); err != nil {
		_ = os.Remove(temporary)
		return fmt.Errorf("publicar cofre: %w", err)
	}
	return nil
}

// zero limpa o buffer de texto claro assim que ele deixa de ser necessário.
func zero(buffer []byte) {
	for i := range buffer {
		buffer[i] = 0
	}
}
