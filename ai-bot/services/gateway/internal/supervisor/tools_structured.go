// O bloco JSON estruturado das ferramentas que alimentam tela.
//
// O padrão da Onda 1 (schema.export, tools_data.go) devolve JSON puro porque
// aquela saída NASCEU para a tela. As ferramentas desta onda (flow.validate,
// secrets.scan, osv.query, finetune.status) já tinham um relatório em texto que
// o modelo e a pessoa leem no transcript — trocá-lo por JSON puro apagaria o
// relatório da conversa para dar de comer à tela. Então o contrato aqui é
// duplo: o texto continua na frente, e o bloco JSON vem DEMARCADO no fim, numa
// cerca ```json. A superfície procura a ÚLTIMA cerca do resultado, porque é o
// gateway quem a escreve, sempre por último — um exemplo de fluxo com ```json
// no meio do texto legível não engana a tela.
//
// Todas as quatro estão na isenção de inlineLimitFor (tool_gateway.go): acima
// de 20 000 bytes o corte antigo pica o JSON e a tela volta ao estado vazio —
// comportamento conhecido, o mesmo do schema.export.
package supervisor

import (
	"encoding/json"
	"strings"
)

// appendStructuredJSON anexa o bloco demarcado ao texto legível. Falha de
// serialização devolve o texto puro: a tela fica sem o desenho, mas o modelo e
// a pessoa não ficam sem o relatório — casca de novo é melhor que erro novo.
func appendStructuredJSON(text string, value any) string {
	payload, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return text
	}
	return strings.TrimRight(text, "\n") + "\n\n```json\n" + string(payload) + "\n```"
}
