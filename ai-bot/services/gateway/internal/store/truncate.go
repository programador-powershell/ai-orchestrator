// Truncar sessão: corta o FIM do log de forma durável.
//
// O caso de uso que paga o recurso: "regenerar a última resposta" e "editar a
// última pergunta". Sem um corte de verdade no log, o reenvio só teria como
// ACRESCENTAR — a pergunta duplicaria para sempre no histórico, e o modelo
// veria as duas de lá em diante (o histórico do supervisor É o log).
//
// A decisão central espelha a do fork, invertida: o fork copia um prefixo para
// uma sessão nova; aqui o prefixo VIRA a sessão. Os envelopes mantidos ficam
// intactos (mesmo seq, mesmo conteúdo), então a numeração contínua 1..N segue
// verdadeira e o replay, o cursor `Since`, o espelho `SyncedSeq` e o índice
// esparso continuam funcionando sem caso especial — o Append seguinte continua
// do novo fim.
//
// A reescrita é por arquivo temporário + rename, como o writeJSONAtomic: se o
// processo morrer no meio, o log original continua inteiro. Meio-corte não
// existe — ou cortou, ou não cortou.
package store

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"time"

	"aibot/gateway/internal/protocol"
)

// TruncateBefore remove do log todo envelope com seq >= beforeSeq e devolve o
// cabeçalho atualizado. `beforeSeq` além do fim é no-op (não há o que cortar) —
// tratar como erro puniria o clique repetido de quem já conseguiu o que queria.
//
// Quem garante que não há turno RODANDO na sessão é o chamador (o transporte
// consulta o supervisor): o store não conhece turnos em execução, só o log.
func (s *Store) TruncateBefore(id string, beforeSeq uint64) (SessionMeta, error) {
	if beforeSeq == 0 {
		return SessionMeta{}, errors.New("corte em zero apagaria a sessão inteira — informe o seq do primeiro envelope a remover")
	}
	handle, err := s.handle(id)
	if err != nil {
		return SessionMeta{}, err
	}

	// O mutex fica seguro durante a reescrita INTEIRA, e isso é decisão: um
	// Append concorrente no meio do rename gravaria numa geração do arquivo que
	// está prestes a ser substituída, e a linha sumiria sem erro. O corte é um
	// gesto raro de usuário; segurar a sessão por ele é barato.
	handle.mu.Lock()
	defer handle.mu.Unlock()

	if beforeSeq > handle.meta.LastSeq {
		return handle.meta, nil
	}

	// O descritor de escrita precisa fechar ANTES do rename: no Windows, trocar
	// um arquivo aberto falha. O Append seguinte reabre sozinho (ele já trata
	// `file == nil` como "abrir agora").
	if handle.file != nil {
		_ = handle.file.Sync()
		_ = handle.file.Close()
		handle.file = nil
	}

	kept, turns, err := rewriteLogPrefix(handle.path, beforeSeq-1)
	if err != nil {
		return SessionMeta{}, err
	}

	handle.meta.LastSeq = kept
	handle.meta.Turns = turns
	// O espelho nunca pode apontar para além do que existe: um cursor à frente
	// do fim faria o sync pular exatamente o que for gravado a seguir.
	if handle.meta.SyncedSeq > kept {
		handle.meta.SyncedSeq = kept
	}
	handle.meta.UpdatedAt = time.Now().UTC()
	// O índice esparso aponta bytes do arquivo ANTIGO; qualquer marco além do
	// corte entregaria o envelope errado. Zerar tudo é o simples e correto —
	// a primeira leitura semeia de novo.
	handle.index = nil

	// Direto ao disco, sem debounce: quem trunca vai reabrir a conversa já —
	// e um cabeçalho atrasado diria um LastSeq que o log não tem mais.
	if err := handle.writeMeta(); err != nil {
		return SessionMeta{}, err
	}
	return handle.meta, nil
}

// FirstSeqOfTurn devolve o seq do PRIMEIRO envelope do turno — o ponto de corte
// natural do "regenerar". Zero quando o turno não aparece no log.
func (s *Store) FirstSeqOfTurn(id, turn string) (uint64, error) {
	if turn == "" {
		return 0, nil
	}
	var cursor uint64
	for {
		batch, err := s.Since(id, cursor, MaxEventBatch)
		if err != nil {
			return 0, err
		}
		if len(batch) == 0 {
			return 0, nil
		}
		for _, envelope := range batch {
			if envelope.Turn == turn {
				return envelope.Seq, nil
			}
			cursor = envelope.Seq
		}
		if len(batch) < MaxEventBatch {
			return 0, nil
		}
	}
}

// rewriteLogPrefix grava em `path` só as linhas com seq <= keepThrough,
// devolvendo o último seq mantido e quantos turnos (KindDone) sobraram — os
// dois campos que o cabeçalho precisa refletir. Streaming linha a linha, como a
// cópia do fork: o log de uma conversa longa não cabe (nem precisa caber) na
// memória.
func rewriteLogPrefix(path string, keepThrough uint64) (lastSeq uint64, turns int, err error) {
	source, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			// Sessão sem log ainda: não há nada a cortar e nada a reescrever.
			return 0, 0, nil
		}
		return 0, 0, fmt.Errorf("abrir o log para truncar: %w", err)
	}

	temporary := path + ".tmp"
	target, err := os.OpenFile(temporary, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		_ = source.Close()
		return 0, 0, fmt.Errorf("criar o log truncado: %w", err)
	}

	writer := bufio.NewWriter(target)
	scanner := bufio.NewScanner(source)
	scanner.Buffer(make([]byte, 0, 64*1024), maxLineSize)

	for scanner.Scan() {
		line := scanner.Bytes()
		seq, valid := seqOfLine(line)
		if !valid {
			// Linha partida por queda de energia: o log tolera (só a última pode
			// estar assim) e a reescrita descarta — ela nunca foi legível.
			continue
		}
		if seq > keepThrough {
			// O log é ordenado por construção: passou do corte, acabou o prefixo.
			break
		}
		// A quebra vai em escrita separada: `append` sobre scanner.Bytes()
		// escreveria dentro do buffer interno do scanner, que ainda vai ser
		// lido pela próxima volta.
		_, writeErr := writer.Write(line)
		if writeErr == nil {
			writeErr = writer.WriteByte('\n')
		}
		if writeErr != nil {
			_ = source.Close()
			_ = target.Close()
			_ = os.Remove(temporary)
			return 0, 0, fmt.Errorf("gravar o log truncado: %w", writeErr)
		}
		lastSeq = seq
		// Contar o turno exige o kind, e o kind exige decodificar — mas só das
		// linhas mantidas, que são o prefixo curto de um gesto de "voltar".
		var head struct {
			Kind protocol.Kind `json:"kind"`
		}
		if json.Unmarshal(line, &head) == nil && head.Kind == protocol.KindDone {
			turns++
		}
	}
	if scanErr := scanner.Err(); scanErr != nil && !errors.Is(scanErr, io.EOF) {
		_ = source.Close()
		_ = target.Close()
		_ = os.Remove(temporary)
		return 0, 0, fmt.Errorf("ler o log para truncar: %w", scanErr)
	}
	_ = source.Close()

	if err := writer.Flush(); err != nil {
		_ = target.Close()
		_ = os.Remove(temporary)
		return 0, 0, fmt.Errorf("descarregar o log truncado: %w", err)
	}
	// Sync antes do rename: o corte prometido ao cliente precisa existir de
	// verdade depois de uma queda — a mesma regra do Append durável.
	if err := target.Sync(); err != nil {
		_ = target.Close()
		_ = os.Remove(temporary)
		return 0, 0, fmt.Errorf("sincronizar o log truncado: %w", err)
	}
	if err := target.Close(); err != nil {
		_ = os.Remove(temporary)
		return 0, 0, err
	}
	if err := os.Rename(temporary, path); err != nil {
		_ = os.Remove(temporary)
		return 0, 0, fmt.Errorf("substituir o log truncado: %w", err)
	}
	return lastSeq, turns, nil
}
