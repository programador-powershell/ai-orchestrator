//go:build !windows

package store

import (
	"os"
	"syscall"
)

// processAlive diz se o PID ainda está rodando.
//
// No Unix `os.FindProcess` NUNCA falha (só embrulha o número), então quem
// responde de verdade é o sinal 0 — o idioma do kill(2): o núcleo faz a
// checagem de existência e de permissão e não entrega sinal nenhum ao alvo.
// Erro é ESRCH (pid morto); nil é processo vivo.
//
// O sinal precisa ser syscall.Signal: os.Process.Signal faz uma asserção de
// tipo para ela, e qualquer outro os.Signal — inclusive nil — sai como
// "unsupported signal type", que é erro e seria lido como pid morto.
func processAlive(pid int) bool {
	process, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return process.Signal(syscall.Signal(0)) == nil
}
