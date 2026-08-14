// Fork de sessão: copia o PREFIXO do log para uma conversa nova.
//
// O caso de uso que paga o recurso sozinho: a conversa chegou a uma bifurcação
// real ("faz em PostgreSQL ou em SQL Server?") e a pessoa quer explorar os dois
// caminhos SEM perder o contexto acumulado — dois futuros sobre o mesmo
// passado. Sem fork, a alternativa é recontar a história inteira numa conversa
// nova, e ninguém reconta igual.
//
// A decisão central deste arquivo: os envelopes copiados MANTÊM o `seq`; o
// único campo reescrito em cada linha é o `session`. Não é preguiça — é o
// contrato do replay. O fork é um prefixo IDÊNTICO do log original, então a
// numeração contínua por sessão continua verdadeira (1..N sem buracos), e todo
// mecanismo que anda por `seq` — o replay do WebSocket, o cursor `Since`, o
// espelho `SyncedSeq`, o índice esparso — funciona na sessão nova sem nenhum
// caso especial. Renumerar quebraria a única invariante que o pacote inteiro
// defende, para não ganhar nada: o prefixo já é denso a partir de 1.
package store

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	"aibot/gateway/internal/protocol"
)

// forkCounter desempata ids de fork nascidos no mesmo milissegundo.
var forkCounter atomic.Uint64

// ForkSession copia o log de `id` até `fromSeq` (0 = o log inteiro) para uma
// sessão NOVA, herdando ProjectID, CWD e Specialist. Devolve o cabeçalho da
// sessão criada.
func (s *Store) ForkSession(id string, fromSeq uint64, title string) (SessionMeta, error) {
	handle, err := s.handle(id)
	if err != nil {
		return SessionMeta{}, err
	}

	// A foto da origem sai de dentro do lock; a CÓPIA acontece fora dele. Isso
	// não é uma corrida: o log é append-only, então o prefixo até `cut` é
	// imutável — o que chegar durante a cópia está DEPOIS do corte e não
	// interessa ao fork. Segurar o mutex pela cópia inteira travaria o Append
	// (e o turno em andamento) pelo tempo de ler um log possivelmente grande.
	handle.mu.Lock()
	source := handle.meta
	sourcePath := handle.path
	handle.mu.Unlock()

	cut := fromSeq
	if cut == 0 || cut > source.LastSeq {
		// Pedir "além do fim" não é erro: é "tudo o que existe agora".
		cut = source.LastSeq
	}

	newID := forkID(id)
	if strings.TrimSpace(title) == "" {
		original := strings.TrimSpace(source.Title)
		if original == "" {
			original = id
		}
		title = "fork: " + original
	}

	now := time.Now().UTC()
	meta := SessionMeta{
		ID:    newID,
		Title: title,
		// Herdados: reabrir o fork restaura a mesma superfície e a mesma pasta
		// de projeto — o fork é a MESMA conversa até o corte, só o futuro muda.
		Specialist: source.Specialist,
		Model:      source.Model,
		CWD:        source.CWD,
		ProjectID:  source.ProjectID,
		CreatedAt:  now,
		UpdatedAt:  now,
		// SyncedSeq começa em zero mesmo que a origem já tenha espelhado: o
		// servidor nunca viu ESTA sessão, e herdar o cursor faria o espelho
		// pular exatamente o prefixo que o fork acabou de criar.
		SyncedSeq: 0,
	}

	directory := s.sessionDir(newID)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return SessionMeta{}, fmt.Errorf("criar a sessão do fork: %w", err)
	}

	copied, turns, err := copyLogPrefix(sourcePath, filepath.Join(directory, "log.jsonl"), newID, cut)
	if err != nil {
		// Fork pela metade não pode sobrar parecendo sessão: apagar o diretório
		// é o que mantém a regra de tudo-ou-nada de quem lista a barra lateral.
		_ = os.RemoveAll(directory)
		return SessionMeta{}, err
	}
	meta.LastSeq = copied
	meta.Turns = turns

	if err := writeJSONAtomic(filepath.Join(directory, "meta.json"), meta); err != nil {
		_ = os.RemoveAll(directory)
		return SessionMeta{}, err
	}
	return meta, nil
}

// forkID nomeia a sessão nova. Deriva do relógio + contador (como os ids do
// transporte) em vez de derivar do id de origem: dois forks da mesma conversa
// precisam de nomes diferentes, e o id de origem já está no título.
func forkID(source string) string {
	return fmt.Sprintf("%s-fork-%d-%d", safeID(source), time.Now().UnixMilli(), forkCounter.Add(1))
}

// copyLogPrefix copia as linhas com seq <= cut do log de origem para o de
// destino, reescrevendo APENAS o campo `session` de cada envelope. Devolve o
// último seq copiado e quantos turnos (KindDone) o prefixo carrega — os dois
// campos que o cabeçalho novo precisa.
//
// A cópia é por STREAMING, linha a linha, porque o log de uma conversa longa
// tem dezenas de MB: carregá-lo inteiro em memória para copiar um prefixo
// faria o fork custar a RAM do histórico — e o fork acontece com o app aberto,
// no meio do uso.
func copyLogPrefix(sourcePath, targetPath, newSession string, cut uint64) (lastSeq uint64, turns int, err error) {
	if cut == 0 {
		// Sessão sem eventos (ou corte em zero): o fork nasce vazio e válido.
		return 0, 0, nil
	}

	source, err := os.Open(sourcePath)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, 0, nil
		}
		return 0, 0, fmt.Errorf("abrir o log de origem: %w", err)
	}
	defer source.Close()

	target, err := os.OpenFile(targetPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return 0, 0, fmt.Errorf("criar o log do fork: %w", err)
	}
	defer func() {
		// Sync antes de confirmar: o fork devolvido ao cliente precisa existir
		// de verdade depois de uma queda — é a mesma regra do Append durável.
		if err == nil {
			err = target.Sync()
		}
		if closeErr := target.Close(); err == nil && closeErr != nil {
			err = closeErr
		}
	}()

	writer := bufio.NewWriter(target)
	scanner := bufio.NewScanner(source)
	scanner.Buffer(make([]byte, 0, 64*1024), maxLineSize)

	for scanner.Scan() {
		line := scanner.Bytes()
		var envelope protocol.Envelope
		if err := json.Unmarshal(line, &envelope); err != nil || envelope.Seq == 0 {
			// Linha partida por queda de energia: o log tolera (só a última pode
			// estar assim), então a cópia tolera igual — pular, nunca abortar.
			continue
		}
		if envelope.Seq > cut {
			// O log é ordenado por construção (um escritor, O_APPEND): passou do
			// corte, o resto do arquivo inteiro está depois dele.
			break
		}
		// A ÚNICA mudança: a linha passa a pertencer à sessão nova. Payload,
		// seq, turn e timestamps ficam intactos — é o mesmo passado.
		envelope.Session = newSession
		rewritten, err := json.Marshal(&envelope)
		if err != nil {
			return lastSeq, turns, fmt.Errorf("reescrever o envelope %d: %w", envelope.Seq, err)
		}
		if _, err := writer.Write(append(rewritten, '\n')); err != nil {
			return lastSeq, turns, fmt.Errorf("gravar o log do fork: %w", err)
		}
		lastSeq = envelope.Seq
		if envelope.Kind == protocol.KindDone {
			turns++
		}
	}
	if scanErr := scanner.Err(); scanErr != nil && !errors.Is(scanErr, io.EOF) {
		return lastSeq, turns, fmt.Errorf("ler o log de origem: %w", scanErr)
	}
	if err := writer.Flush(); err != nil {
		return lastSeq, turns, fmt.Errorf("descarregar o log do fork: %w", err)
	}
	return lastSeq, turns, nil
}
