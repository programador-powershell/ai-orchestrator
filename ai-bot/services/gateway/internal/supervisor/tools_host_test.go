// Testes do catálogo de ferramentas de MÁQUINA — as que o gateway não executa,
// só despacha ao host Tauri.
//
// O catálogo é o que o modelo lê para decidir o que chamar (ver toolContract).
// Anunciar ali uma ferramenta que o host não entrega é pior do que não ter
// ferramenta nenhuma: o modelo a chama, lê "sucesso" e continua raciocinando em
// cima de algo que não aconteceu — e nada na tela contradiz isso.
package supervisor

import (
	"testing"

	"aibot/gateway/internal/specialist"
)

// catalogo monta o registro COMPLETO num registro limpo — as duas instalações
// que o `cmd/aibotd` faz, na mesma ordem.
//
// A Toolbox e o Supervisor zerados bastam: instalar só REGISTRA nomes e
// funções; as dependências (memória, MCP, agenda, modelos) só são tocadas
// quando alguém chama a ferramenta. Deixar `InstallCrewTools` de fora daria um
// catálogo incompleto, e o teste de cobertura lá embaixo acusaria `task.dispatch`
// como ausente sem que nada estivesse errado.
func catalogo(t *testing.T) *Registry {
	t.Helper()
	registry := NewRegistry()
	toolbox := &Toolbox{}
	toolbox.Install(registry)
	(&Supervisor{}).InstallCrewTools(registry)
	return registry
}

// term.open abria um ConPTY de verdade no host e respondia "terminal aberto para
// a pessoa usar" — mas a interface não tem painel de terminal, então o terminal
// não existia para ninguém além do gerenciador de tarefas. Enquanto o painel não
// existir, o catálogo não pode oferecê-la.
func TestTermOpenForaDoCatalogoEnquantoNaoHouverPainel(t *testing.T) {
	registry := catalogo(t)

	if description := registry.Describe("term.open"); description != "" {
		t.Fatalf("term.open continua no catálogo (%q): o host abre um terminal que a interface não mostra", description)
	}
	for _, name := range registry.Names() {
		if name == "term.open" {
			t.Fatal("term.open apareceu em Names(): o modelo passaria a vê-la de novo")
		}
	}
}

// Nenhum especialista pode listar term.open: `toolContract` descarta em silêncio
// a ferramenta que não está no catálogo, então a lista do especialista e o
// registro divergiriam sem que nada reclamasse.
func TestNenhumEspecialistaOfereceTermOpen(t *testing.T) {
	for _, definition := range specialist.All() {
		if definition.AllowsTool("term.open") {
			t.Errorf("o especialista %q ainda permite term.open", definition.ID)
		}
	}
}

// O par que o teste acima protege pela outra ponta: toda ferramenta que um
// especialista promete tem de existir no catálogo.
//
// Sem isto, tirar uma ferramenta do registro e esquecê-la na lista de um
// especialista não quebra nada visível — `toolContract` simplesmente não a
// anuncia —, mas `AllowsTool` continua dizendo sim, e a chamada morre em
// "ferramenta desconhecida" depois que o modelo já apostou nela.
func TestFerramentaDeEspecialistaExisteNoCatalogo(t *testing.T) {
	registry := catalogo(t)
	disponivel := make(map[string]bool, len(registry.Names()))
	for _, name := range registry.Names() {
		disponivel[name] = true
	}

	for _, definition := range specialist.All() {
		for _, tool := range definition.Tools {
			if !disponivel[tool] {
				t.Errorf("o especialista %q promete %q, que não está no catálogo", definition.ID, tool)
			}
		}
	}
}
