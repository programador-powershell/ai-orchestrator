//go:build needle

// Binding de verdade: Go → cgo → needle.dll / libneedle.so / libneedle.dylib.
//
// Compila só com `-tags needle`. Ver o cabeçalho de needle_shim.c: o nome dos
// símbolos da biblioteca precisa ser conferido contra o header da release, e a
// dependência precisa passar por TI/SI antes de virar padrão.
//
// Build típico no Windows:
//
//	set CGO_ENABLED=1
//	set CGO_CFLAGS=-I C:\needle\include
//	set CGO_LDFLAGS=-L C:\needle\lib -lneedle
//	go build -tags needle ./cmd/aibotd
package needle

/*
#cgo CFLAGS: -I${SRCDIR}
#cgo windows LDFLAGS: -lneedle
#cgo linux LDFLAGS: -lneedle -lm -ldl -lpthread
#cgo darwin LDFLAGS: -lneedle

#include <stdlib.h>
#include "needle_shim.h"
*/
import "C"

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"unsafe"
)

// Session é uma sessão viva do modelo local.
//
// Tem trava porque a sessão nativa NÃO é reentrante e o gateway roteia turnos em
// paralelo. Uma sessão por processo, serializada: como a classificação leva
// milissegundos, a fila nunca é o gargalo — e abrir uma sessão por goroutine
// multiplicaria os 28 MB de RAM por goroutine.
type Session struct {
	mu     sync.Mutex
	handle C.aibot_needle_handle
	closed bool
}

// Open carrega o modelo.
func Open(options Options) (*Session, error) {
	path := options.ModelPath
	if path == "" {
		path = defaultModelPath()
	}
	if _, err := os.Stat(path); err != nil {
		return nil, fmt.Errorf("%w: modelo não encontrado em %s", ErrUnavailable, path)
	}

	cPath := C.CString(path)
	defer C.free(unsafe.Pointer(cPath))

	var handle C.aibot_needle_handle
	code := C.aibot_needle_open(cPath, C.int(options.Threads), C.int(options.MaxTokens), &handle)
	if code != C.AIBOT_NEEDLE_OK {
		return nil, fmt.Errorf("%w: %s", ErrUnavailable, lastError())
	}
	return &Session{handle: handle}, nil
}

// defaultModelPath delega à descoberta de model.go — quem chama Open sem
// caminho (uso direto da biblioteca) acha o mesmo arquivo que o gateway acharia.
// Não procura no diretório de trabalho: o gateway sobe como sidecar e herda o
// cwd do aplicativo, que muda conforme o projeto aberto.
func defaultModelPath() string {
	path, _ := ResolveModelPath("", "")
	return path
}

// Ready diz se a sessão está utilizável.
func (s *Session) Ready() bool {
	if s == nil {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return !s.closed && s.handle != nil
}

// Call faz uma classificação e devolve o JSON cru do modelo.
func (s *Session) Call(ctx context.Context, prompt string, tools []Tool) (string, error) {
	if !s.Ready() {
		return "", ErrUnavailable
	}
	// A chamada nativa é bloqueante e não aceita cancelamento; conferir o
	// contexto ANTES evita ocupar a sessão por um turno que já morreu.
	if err := ctx.Err(); err != nil {
		return "", err
	}

	toolsJSON, err := json.Marshal(tools)
	if err != nil {
		return "", fmt.Errorf("serializar ferramentas: %w", err)
	}

	cPrompt := C.CString(prompt)
	defer C.free(unsafe.Pointer(cPrompt))
	cTools := C.CString(string(toolsJSON))
	defer C.free(unsafe.Pointer(cTools))

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.handle == nil {
		return "", ErrUnavailable
	}

	var out *C.char
	code := C.aibot_needle_call(s.handle, cPrompt, cTools, &out)
	if code != C.AIBOT_NEEDLE_OK {
		return "", fmt.Errorf("roteador local falhou: %s", lastError())
	}
	if out == nil {
		return "", errors.New("roteador local devolveu resposta vazia")
	}
	// GoString COPIA para a memória do Go; a original é liberada pelo alocador
	// que a criou, do outro lado da fronteira.
	answer := C.GoString(out)
	C.aibot_needle_free(out)
	return answer, nil
}

// Close libera a sessão. Idempotente.
func (s *Session) Close() error {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.handle == nil {
		return nil
	}
	C.aibot_needle_close(s.handle)
	s.handle = nil
	s.closed = true
	return nil
}

// Version diz com qual biblioteca estamos falando — vai para o log de subida.
func Version() string {
	return C.GoString(C.aibot_needle_version())
}

func lastError() string {
	message := C.GoString(C.aibot_needle_last_error())
	if message == "" {
		return "sem detalhe"
	}
	return message
}

// BuildTag documenta a tag que trouxe este arquivo para o build.
const BuildTag = "needle"
