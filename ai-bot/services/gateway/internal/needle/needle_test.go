// Testes do roteador local que NÃO precisam da biblioteca nativa.
//
// O que é testável sem 14 MB de pesos é justamente o que mais tende a quebrar:
// a tradução da resposta. O formato de saída de um modelo pequeno muda entre
// versões, e um veredito mal lido manda a conversa INTEIRA para o executor
// errado — porque o modo é gravado no primeiro turno e não se reavalia.
package needle

import (
	"strings"
	"testing"

	"aibot/gateway/internal/specialist"
)

func candidates(t *testing.T, ids ...string) []specialist.Definition {
	t.Helper()
	out := make([]specialist.Definition, 0, len(ids))
	for _, id := range ids {
		definition, ok := specialist.Get(id)
		if !ok {
			t.Fatalf("especialista %q não existe no catálogo", id)
		}
		out = append(out, definition)
	}
	return out
}

func TestParseResponseAcceptsTheDocumentedShape(t *testing.T) {
	raw := `{"type":"call","function_calls":[{"name":"code","arguments":{}}],"confidence":0.97}`

	verdict, err := ParseResponse(raw, candidates(t, "code", "chat", "data"))
	if err != nil {
		t.Fatalf("esperava veredito válido, veio erro: %v", err)
	}
	if verdict.Specialist != "code" {
		t.Errorf("esperava especialista \"code\", veio %q", verdict.Specialist)
	}
	if verdict.Confidence != 0.97 {
		t.Errorf("esperava confiança 0.97, veio %v", verdict.Confidence)
	}
}

func TestParseResponseSurvivesProseAndFences(t *testing.T) {
	// Modelo pequeno desvia do formato com mais frequência que modelo grande.
	// Derrubar o roteamento porque vieram três palavras antes da chave seria
	// jogar fora uma decisão que já estava certa.
	raw := "Claro!\n```json\n{\"type\":\"call\"," +
		"\"function_calls\":[{\"name\":\"security\",\"arguments\":{}}]," +
		"\"confidence\":0.82}\n```"

	verdict, err := ParseResponse(raw, candidates(t, "security", "code"))
	if err != nil {
		t.Fatalf("esperava veredito válido, veio erro: %v", err)
	}
	if verdict.Specialist != "security" {
		t.Errorf("esperava \"security\", veio %q", verdict.Specialist)
	}
}

func TestParseResponseRejectsSpecialistOutsideTheShortlist(t *testing.T) {
	// A gramática do modelo deveria impedir isto. Confiar nisso é confiar num
	// detalhe de implementação de terceiro sobre a decisão de roteamento.
	raw := `{"type":"call","function_calls":[{"name":"tune","arguments":{}}],"confidence":0.99}`

	if _, err := ParseResponse(raw, candidates(t, "code", "chat")); err == nil {
		t.Fatal("esperava recusa de especialista fora dos candidatos, veio sucesso")
	}
}

func TestParseResponseRejectsPlainText(t *testing.T) {
	// Sem chamada de ferramenta não há decisão. Aceitar o texto como veredito
	// faria "não sei" virar um modo escolhido.
	raw := `{"type":"text","content":"não tenho certeza do que você quer"}`

	_, err := ParseResponse(raw, candidates(t, "code", "chat"))
	if err == nil {
		t.Fatal("esperava erro para resposta sem function_calls, veio sucesso")
	}
	if !strings.Contains(err.Error(), "não escolheu ferramenta") {
		t.Errorf("erro deveria explicar que não houve escolha, veio: %v", err)
	}
}

func TestParseResponseTreatsMissingConfidenceAsZero(t *testing.T) {
	// Ausência não é certeza. Se um `confidence` faltante virasse 1.0, toda
	// resposta sem o campo passaria direto pelo limiar da cascata.
	raw := `{"type":"call","function_calls":[{"name":"chat","arguments":{}}]}`

	verdict, err := ParseResponse(raw, candidates(t, "chat"))
	if err != nil {
		t.Fatalf("esperava veredito válido, veio erro: %v", err)
	}
	if verdict.Confidence != 0 {
		t.Errorf("esperava confiança 0 quando o campo falta, veio %v", verdict.Confidence)
	}
}

func TestParseResponseClampsConfidenceAboveOne(t *testing.T) {
	raw := `{"type":"call","function_calls":[{"name":"chat","arguments":{}}],"confidence":7}`

	verdict, err := ParseResponse(raw, candidates(t, "chat"))
	if err != nil {
		t.Fatalf("esperava veredito válido, veio erro: %v", err)
	}
	if verdict.Confidence != 1 {
		t.Errorf("esperava confiança limitada a 1, veio %v", verdict.Confidence)
	}
}

func TestToolsForDeclaresOneToolPerSpecialistWithoutArguments(t *testing.T) {
	list := candidates(t, "code", "data", "security")
	tools := ToolsFor(list)

	if len(tools) != len(list) {
		t.Fatalf("esperava %d ferramentas, vieram %d", len(list), len(tools))
	}
	for index, tool := range tools {
		if tool.Name != list[index].ID {
			t.Errorf("ferramenta %d: esperava nome %q, veio %q", index, list[index].ID, tool.Name)
		}
		// O nome da ferramenta É a decisão; um argumento aqui abriria espaço
		// para o modelo devolver uma string livre em vez de escolher.
		properties, ok := tool.Parameters["properties"].(map[string]any)
		if !ok {
			t.Fatalf("ferramenta %q: esquema sem \"properties\"", tool.Name)
		}
		if len(properties) != 0 {
			t.Errorf("ferramenta %q: esperava esquema sem argumento, veio %v", tool.Name, properties)
		}
		if !strings.Contains(tool.Description, list[index].Name) {
			t.Errorf("ferramenta %q: a descrição precisa citar o nome do especialista", tool.Name)
		}
	}
}

func TestSortByNameIsStableAcrossRuns(t *testing.T) {
	// Ordem de ferramenta influencia a decodificação. Sem ordem fixa, o mesmo
	// pedido pode cair em especialistas diferentes entre duas execuções — e esse
	// é o tipo de não-determinismo que ninguém consegue depurar depois.
	first := ToolsFor(candidates(t, "tune", "chat", "code"))
	SortByName(first)

	for attempt := 0; attempt < 20; attempt++ {
		other := ToolsFor(candidates(t, "code", "tune", "chat"))
		SortByName(other)
		for index := range first {
			if first[index].Name != other[index].Name {
				t.Fatalf("tentativa %d: ordem divergiu na posição %d (%q != %q)",
					attempt, index, first[index].Name, other[index].Name)
			}
		}
	}
}

func TestOpenWithoutTheBuildTagReportsUnavailable(t *testing.T) {
	// Este teste vale nos DOIS builds e diz coisas diferentes em cada um: sem a
	// tag, Open falha sempre; com a tag e sem o arquivo de pesos, também. O que
	// não pode acontecer, em nenhum dos dois, é o gateway subir achando que tem
	// roteador local quando não tem.
	session, err := Open(Options{ModelPath: "modelo-que-nao-existe.bin"})
	if err == nil {
		if session != nil && session.Ready() {
			t.Fatal("abriu uma sessão com um caminho de modelo inexistente")
		}
		return
	}
	if session != nil && session.Ready() {
		t.Fatal("Open falhou mas devolveu sessão pronta")
	}
}
