// O Tool Output Gateway do Context Runtime: nenhuma ferramenta despeja saída
// ilimitada na janela do modelo.
//
// A saída que passa do teto inline vira artefato integral no store, e o modelo
// recebe uma PROJEÇÃO: início + fim + referência + tamanho. Ele pode pedir o
// resto por `context.fetch`, em fatias — recuperação sob demanda, nunca dump.
//
// A política de corte é POR TIPO de ferramenta, porque a informação não mora
// no mesmo lugar: em compilador, teste e log, o fim carrega o erro final; em
// listagem e busca, o começo carrega o que foi pedido.
package supervisor

import (
	"fmt"
	"strings"
)

const (
	// inlineToolLimit é o teto do que volta inline ao modelo e ao log. Acima
	// disso, projeção + artefato. Bem menor que o truncate antigo (20 000): o
	// integral agora tem para onde ir, então a janela não precisa carregá-lo.
	inlineToolLimit = 12 << 10 // 12 KiB

	// As fatias da projeção — o exemplo da especificação: 1500 do começo,
	// 3000 do fim (o erro final de um build mora no fim).
	projectionHead = 1500
	projectionTail = 3000
)

// tailHeavy diz se o FIM da saída importa mais que o começo para esta
// ferramenta.
func tailHeavy(tool string) bool {
	switch tool {
	case "proc.run", "diagnostics.run", "git.commit", "git.diff":
		return true
	}
	return false
}

// projectToolOutput aplica o gateway: saída pequena passa intacta; grande vira
// artefato + projeção. Falha ao gravar o artefato NÃO derruba a ferramenta —
// cai no truncamento antigo, que era o comportamento de antes do gateway.
func (s *Supervisor) projectToolOutput(sessionID, tool, output string) (projected, ref string, rawBytes int, truncated bool) {
	if len(output) <= inlineToolLimit {
		return output, "", len(output), false
	}
	rawBytes = len(output)

	if s.deps.Store != nil {
		if saved, err := s.deps.Store.SaveArtifact(sessionID, tool, []byte(output)); err == nil {
			ref = saved
		}
	}

	head, tail := projectionHead, projectionTail
	if !tailHeavy(tool) {
		head, tail = projectionTail, projectionHead
	}
	if head+tail > len(output) {
		head = len(output) / 2
		tail = len(output) - head
	}

	var out strings.Builder
	fmt.Fprintf(&out, "SAÍDA GRANDE (%d KB) — projetada. ", rawBytes/1024)
	if ref != "" {
		fmt.Fprintf(&out, "Integral em %s: peça context.fetch {\"ref\":\"%s\",\"offset\":N,\"maxBytes\":M} "+
			"para ler qualquer trecho (offset negativo lê do fim).", ref, ref)
	} else {
		out.WriteString("O integral não pôde ser guardado; só esta projeção existe.")
	}
	out.WriteString("\n\n[início]\n")
	out.WriteString(safeCut(output[:head]))
	fmt.Fprintf(&out, "\n\n[… %d KB omitidos …]\n\n[fim]\n", (len(output)-head-tail)/1024)
	out.WriteString(safeCutStart(output[len(output)-tail:]))
	return out.String(), ref, rawBytes, true
}

// safeCut apara o fim para não terminar no meio de um rune.
func safeCut(text string) string {
	cut := len(text)
	for cut > 0 && text[cut-1]&0xC0 == 0x80 {
		cut--
	}
	if cut > 0 && text[cut-1]&0x80 != 0 {
		cut--
	}
	return text[:cut]
}

// safeCutStart apara o começo pelo mesmo motivo.
func safeCutStart(text string) string {
	start := 0
	for start < len(text) && text[start]&0xC0 == 0x80 {
		start++
	}
	return text[start:]
}
