// O Artifact Store: a saída INTEGRAL das ferramentas, fora da janela do modelo.
//
// A regra do Context Runtime (docs/context-runtime.md): nenhuma ferramenta
// despeja saída ilimitada no modelo. O que passa do teto vira arquivo aqui, o
// modelo recebe uma projeção (início + fim + referência) e pode pedir o resto
// por `context.fetch` — em fatias, nunca o dump inteiro de volta.
//
// Endereçado por CONTEÚDO (sha256 curto) de propósito: a mesma saída gravada
// duas vezes vira o mesmo arquivo (idempotente, sem relógio), e uma referência
// nunca aponta para conteúdo trocado — se o conteúdo mudou, a referência muda.
package store

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// artifactScheme é o prefixo das referências: artifact://<tipo>/<hash>.
const artifactScheme = "artifact://"

// maxArtifactBytes é o teto de UM artefato. Acima disso a gravação recusa: um
// artefato de gigabytes não é saída de ferramenta, é um arquivo do projeto — e
// o lugar dele é o workspace.
const maxArtifactBytes = 64 << 20 // 64 MiB

// SaveArtifact grava o conteúdo integral e devolve a referência estável.
func (s *Store) SaveArtifact(sessionID, kind string, data []byte) (string, error) {
	if len(data) == 0 {
		return "", errors.New("artefato vazio não é gravado")
	}
	if len(data) > maxArtifactBytes {
		return "", fmt.Errorf("artefato de %d bytes passa do teto de %d", len(data), maxArtifactBytes)
	}
	kind = safeID(kind)
	if kind == "" {
		kind = "saida"
	}
	sum := sha256.Sum256(data)
	hash := hex.EncodeToString(sum[:8])

	dir := filepath.Join(s.sessionDir(sessionID), "artifacts")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	path := filepath.Join(dir, kind+"-"+hash+".txt")
	ref := artifactScheme + kind + "/" + hash

	// Endereçado por conteúdo: se o arquivo já existe, é ESTE conteúdo.
	if _, err := os.Stat(path); err == nil {
		return ref, nil
	}
	// Escrita em dois tempos: o vizinho que ler no meio não vê metade.
	temp := path + ".tmp"
	if err := os.WriteFile(temp, data, 0o644); err != nil {
		return "", err
	}
	if err := os.Rename(temp, path); err != nil {
		_ = os.Remove(temp)
		return "", err
	}
	return ref, nil
}

// ReadArtifact devolve uma FATIA do artefato (offset em bytes) e o tamanho
// total. A fatia é obrigatória: devolver o integral recolocaria na janela
// exatamente o que a projeção tirou dela.
func (s *Store) ReadArtifact(sessionID, ref string, offset, limit int) (string, int, error) {
	rest, found := strings.CutPrefix(strings.TrimSpace(ref), artifactScheme)
	if !found {
		return "", 0, fmt.Errorf("referência inválida: %q (esperava %s<tipo>/<hash>)", ref, artifactScheme)
	}
	kind, hash, ok := strings.Cut(rest, "/")
	if !ok || safeID(kind) != kind || safeID(hash) != hash {
		return "", 0, fmt.Errorf("referência inválida: %q", ref)
	}
	path := filepath.Join(s.sessionDir(sessionID), "artifacts", kind+"-"+hash+".txt")
	// Abre e LÊ SÓ A FATIA — nunca o arquivo inteiro. A primeira versão fazia
	// os.ReadFile e cortava em memória: um artefato de 60 MB custava 60 MB de
	// heap por fetch de 16 KiB. O Stat dá o total (e resolve o offset negativo)
	// sem ler um byte; o artefato é imutável depois do rename, então não há
	// corrida com escritor.
	file, err := os.Open(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", 0, fmt.Errorf("artefato %s não existe nesta conversa", ref)
		}
		return "", 0, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return "", 0, err
	}
	total := int(info.Size())
	if offset < 0 {
		// Offset negativo lê do FIM — o jeito natural de pedir "as últimas N
		// linhas do log" sem saber o tamanho.
		offset = total + offset
	}
	if offset < 0 {
		offset = 0
	}
	if offset >= total {
		return "", total, nil
	}
	if limit <= 0 {
		limit = 16 << 10
	}
	end := offset + limit
	if end > total {
		end = total
	}
	chunk := make([]byte, end-offset)
	if _, err := file.ReadAt(chunk, int64(offset)); err != nil {
		return "", total, err
	}
	return string(chunk), total, nil
}

/* ------------------------------ blobs da sessão --------------------------- */

// SaveSessionBlob grava um documento nomeado da sessão (a cápsula de estado,
// por exemplo) com escrita em dois tempos. O nome passa pelo mesmo safeID dos
// ids: um nome vindo de fora não escolhe onde escrever.
func (s *Store) SaveSessionBlob(sessionID, name string, data []byte) error {
	dir := s.sessionDir(sessionID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	path := filepath.Join(dir, safeID(name)+".json")
	temp := path + ".tmp"
	if err := os.WriteFile(temp, data, 0o644); err != nil {
		return err
	}
	if err := os.Rename(temp, path); err != nil {
		_ = os.Remove(temp)
		return err
	}
	return nil
}

// LoadSessionBlob lê um documento nomeado. Ausente devolve (nil, nil): não ter
// cápsula ainda é o estado normal de uma conversa nova, não um erro.
func (s *Store) LoadSessionBlob(sessionID, name string) ([]byte, error) {
	data, err := os.ReadFile(filepath.Join(s.sessionDir(sessionID), safeID(name)+".json"))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	return data, err
}
