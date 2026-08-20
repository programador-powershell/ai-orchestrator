//go:build windows

package store

import (
	"fmt"
	"syscall"
	"time"
	"unsafe"
)

// holderImage devolve o caminho do executável e a hora de INÍCIO do processo.
//
// As duas respostas vêm do núcleo, não de heurística: QueryFullProcessImageName
// resolve o caminho real da imagem (não o que o .lock diz), e GetProcessTimes
// dá o instante de criação — o par que permite afirmar "este processo não pode
// estar rodando o binário atual" sem adivinhar versão nenhuma.
func holderImage(pid int) (string, time.Time, error) {
	const access = syscall.PROCESS_QUERY_INFORMATION
	handle, err := syscall.OpenProcess(access, false, uint32(pid))
	if err != nil {
		return "", time.Time{}, fmt.Errorf("abrir o processo: %w", err)
	}
	defer syscall.CloseHandle(handle)

	// QueryFullProcessImageNameW não está no pacote syscall; a chamada direta à
	// kernel32 continua stdlib-only — regra da casa preservada.
	kernel32 := syscall.NewLazyDLL("kernel32.dll")
	query := kernel32.NewProc("QueryFullProcessImageNameW")
	buffer := make([]uint16, syscall.MAX_LONG_PATH)
	size := uint32(len(buffer))
	ok, _, callErr := query.Call(
		uintptr(handle),
		0, // formato Win32 clássico (C:\...), o mesmo que os.Executable devolve
		uintptr(unsafe.Pointer(&buffer[0])),
		uintptr(unsafe.Pointer(&size)),
	)
	if ok == 0 {
		return "", time.Time{}, fmt.Errorf("caminho da imagem: %w", callErr)
	}
	image := syscall.UTF16ToString(buffer[:size])

	var creation, exit, kernelTime, userTime syscall.Filetime
	if err := syscall.GetProcessTimes(handle, &creation, &exit, &kernelTime, &userTime); err != nil {
		return image, time.Time{}, fmt.Errorf("hora de início: %w", err)
	}
	started := time.Unix(0, creation.Nanoseconds())
	return image, started, nil
}

// terminateHolder derruba o processo. Sem gentileza gradual de propósito: o
// gateway não tem canal de shutdown externo (o encerramento limpo é do app
// pai), e o alvo aqui é por definição um órfão cujo pai já se foi.
func terminateHolder(pid int) error {
	handle, err := syscall.OpenProcess(syscall.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		return fmt.Errorf("abrir para término: %w", err)
	}
	defer syscall.CloseHandle(handle)
	if err := syscall.TerminateProcess(handle, 1); err != nil {
		return fmt.Errorf("terminar: %w", err)
	}
	return nil
}
