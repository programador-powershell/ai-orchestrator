// Comando fakeneedle — um sidecar do degrau local de mentira.
//
// Fala o MESMO protocolo do needle_sidecar.py (uma linha JSON por pergunta, ver
// internal/needle/sidecar.go) e decide por uma heurística boba. Existe para
// exercitar o caminho inteiro — gateway sobe o processo, aperta a mão, pergunta,
// confere a resposta e publica a rota com motivo `needle` — em máquina que não
// tem Python nem o binário de 14 MB do Needle.
//
// Não é mock de teste: é processo de verdade, com pipe de verdade. O que ele
// simula é só o CÉREBRO; a fiação exercitada é a mesma que o sidecar Python vai
// usar.
//
//	go build -o fakeneedle ./cmd/fakeneedle
//	AIBOT_NEEDLE_CMD="./fakeneedle" ./aibotd
package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
)

type pedido struct {
	Prompt     string   `json:"prompt"`
	Candidates []string `json:"candidates"`
}

type resposta struct {
	Specialist string  `json:"specialist"`
	Confidence float64 `json:"confidence"`
	Why        string  `json:"why,omitempty"`
	Error      string  `json:"error,omitempty"`
}

// pistas é a heurística: a primeira que casar decide. Deliberadamente diferente
// do léxico do fast router — o degrau só é consultado quando aquele não decidiu,
// então repetir as mesmas regras não exercitaria nada.
var pistas = []struct{ termo, especialista string }{
	{"melhora", "code"},
	{"arruma", "code"},
	{"organiza", "work"},
	{"material", "office"},
	{"olhada", "chat"},
	{"revisa", "security"},
}

func main() {
	confianca := flag.Float64("confianca", 0.92, "confiança devolvida (o gateway exige >= 0,78)")
	falhar := flag.Bool("falhar", false, "recusar a subida, para exercitar o caminho de erro")
	flag.Parse()

	linha := func(payload any) {
		texto, _ := json.Marshal(payload)
		fmt.Println(string(texto))
	}

	if *falhar {
		linha(resposta{Error: "modelo não encontrado (simulado)"})
		os.Exit(1)
	}

	// stderr é do diagnóstico; stdout é só protocolo.
	fmt.Fprintln(os.Stderr, "[fakeneedle] pronto")
	linha(resposta{})

	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		texto := strings.TrimSpace(scanner.Text())
		if texto == "" {
			continue
		}
		var entrada pedido
		if err := json.Unmarshal([]byte(texto), &entrada); err != nil {
			linha(resposta{Error: "pedido ilegível: " + err.Error()})
			continue
		}
		if len(entrada.Candidates) == 0 {
			linha(resposta{Error: "pedido sem candidatos"})
			continue
		}

		permitido := make(map[string]bool, len(entrada.Candidates))
		for _, id := range entrada.Candidates {
			permitido[id] = true
		}

		escolhido := ""
		minusculo := strings.ToLower(entrada.Prompt)
		for _, pista := range pistas {
			if strings.Contains(minusculo, pista.termo) && permitido[pista.especialista] {
				escolhido = pista.especialista
				break
			}
		}
		if escolhido == "" {
			// Sem pista, o degrau NÃO chuta: devolver erro faz a cascata seguir
			// para o modelo grande, que é o desenho.
			linha(resposta{Error: "sem pista suficiente"})
			continue
		}
		linha(resposta{Specialist: escolhido, Confidence: *confianca, Why: "fakeneedle"})
	}
}
