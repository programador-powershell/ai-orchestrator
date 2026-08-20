//go:build !windows

package store

import (
	"errors"
	"time"
)

// Fora do Windows as sondas ainda não existem — e a resposta conservadora é
// NÃO derrubar ninguém: o chamador segue recebendo ErrLocked, exatamente o
// comportamento de antes deste arquivo. O cenário do órfão de build velho foi
// observado (e dói) no Windows, onde o app é distribuído; quando o gateway
// rodar em unix de verdade, /proc/<pid>/exe e o campo starttime de
// /proc/<pid>/stat dão as mesmas duas respostas.
func holderImage(int) (string, time.Time, error) {
	return "", time.Time{}, errors.New("takeover de trava ainda não implementado fora do Windows")
}

func terminateHolder(int) error {
	return errors.New("takeover de trava ainda não implementado fora do Windows")
}
