//go:build windows

package store

import "syscall"

// processAlive diz se o PID ainda está RODANDO, e não apenas se ele existe como
// objeto do núcleo.
//
// A diferença derrubou o aplicativo inteiro uma vez. A versão anterior confiava
// em `os.FindProcess` falhar para pid morto — no Windows ele chama OpenProcess,
// e o objeto do processo sobrevive à morte enquanto ALGUÉM segurar um handle.
// Quem segura, aqui, é o próprio aplicativo: ele é o pai do gateway e guarda o
// Child para colher no encerramento. Resultado: gateway morto de qualquer jeito
// que não seja o encerramento limpo (queda, `taskkill`, atualização mal
// sucedida) deixava o `.lock` com um pid que "existe", a trava nunca era
// considerada órfã, e NENHUM gateway subia mais naquela pasta enquanto a janela
// estivesse aberta. A tela dizia "gateway fora do ar" para sempre.
//
// Quem responde a pergunta certa é o handle como OBJETO SINCRONIZÁVEL: o
// processo é sinalizado quando termina. Espera de zero milissegundo devolve
// WAIT_TIMEOUT enquanto ele roda e WAIT_OBJECT_0 depois que morreu — sem
// depender do código de saída (o 259 de STILL_ACTIVE é ambíguo com um processo
// que legitimamente sai com 259).
func processAlive(pid int) bool {
	const (
		waitTimeout = 0x00000102
		access      = syscall.PROCESS_QUERY_INFORMATION | syscall.SYNCHRONIZE
	)

	handle, err := syscall.OpenProcess(access, false, uint32(pid))
	if err != nil {
		// Sem handle nenhum: o objeto já foi embora, então o processo também.
		return false
	}
	defer syscall.CloseHandle(handle)

	state, err := syscall.WaitForSingleObject(handle, 0)
	if err != nil {
		// Não deu para perguntar. Dizer "vivo" mantém a trava de pé, que é o
		// lado seguro: roubar a trava de um processo vivo faria dois donos
		// numerarem `seq` sobre a mesma sessão.
		return true
	}
	return state == waitTimeout
}
