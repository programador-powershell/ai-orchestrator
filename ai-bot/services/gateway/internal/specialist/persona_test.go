// Testes das PERSONAS de trabalho — o texto do system é dado, não prosa.
//
// O defeito que este arquivo guarda foi flagrado em produção: pedido um site,
// o Código respondeu com o HTML inteiro num bloco de markdown NO CHAT e a
// janela do editor ficou em "nenhum arquivo aberto". A superfície de cada
// especialista de trabalho só mostra o que as FERRAMENTAS produziram no
// projeto — então a persona tem de mandar USAR a ferramenta, e a lista de
// permitidas tem de cobrir o que a persona manda fazer. As duas metades andam
// juntas: ordem sem permissão vira recusa no portão; permissão sem ordem vira
// artefato colado no chat.
package specialist

import (
	"regexp"
	"strings"
	"testing"
)

// persona busca o especialista compilado e falha alto se ele sumir — um teste
// de conteúdo sobre uma Definition zerada passaria em silêncio.
func persona(t *testing.T, id string) Definition {
	t.Helper()
	definition, ok := Get(id)
	if !ok {
		t.Fatalf("o especialista %q não existe no catálogo compilado", id)
	}
	return definition
}

// O Código GRAVA com ferramenta e não cola o arquivo no chat. As frases
// verificadas são as que carregam a regra: o nome das ferramentas de escrita
// (sem elas o modelo não sabe COMO gravar) e a proibição do arquivo inteiro
// (sem ela o modelo grava E cola, ou só cola).
func TestPersonaDoCodigoMandaGravarComFerramentaENaoColarNoChat(t *testing.T) {
	code := persona(t, "code")

	for _, want := range []string{"fs.write", "fs.patch"} {
		if !strings.Contains(code.System, want) {
			t.Errorf("a persona do código não cita a ferramenta %q — sem o nome, o modelo não sabe como gravar:\n%s",
				want, code.System)
		}
		// A ordem só vale se a permissão cobre: mandar gravar sem liberar a
		// ferramenta é recusa garantida no portão.
		if !code.AllowsTool(want) {
			t.Errorf("a persona manda usar %q e a lista de permitidas não cobre", want)
		}
	}
	if !strings.Contains(code.System, "arquivo inteiro") {
		t.Errorf("a persona do código não proíbe colar o arquivo inteiro no chat:\n%s", code.System)
	}
	if !strings.Contains(code.System, "trecho ilustrativo") {
		t.Errorf("a persona do código não delimita o que PODE ir ao chat (trecho ilustrativo):\n%s", code.System)
	}
}

// O Código RODA os próprios comandos. O flagrante que este teste guarda:
// pedida uma aplicação, o Código mandou a PESSOA operar a máquina ("crie a
// pasta, rode git init…"). Scaffold, dependência e build são trabalho dele,
// via proc.run no ambiente da sessão, pelo funil de aprovação — e a persona
// tem de dizer isso com o nome da ferramenta E proibir a ordem à pessoa.
func TestPersonaDoCodigoRodaComandoEmVezDeMandarAPessoa(t *testing.T) {
	code := persona(t, "code")

	if !strings.Contains(code.System, "proc.run") {
		t.Errorf("a persona do código não cita proc.run — sem o nome, o modelo volta a ditar comandos no chat:\n%s",
			code.System)
	}
	if !code.AllowsTool("proc.run") {
		t.Error("a persona manda executar com proc.run e a lista de permitidas não cobre")
	}
	if !strings.Contains(code.System, "NUNCA mande a pessoa") {
		t.Errorf("a persona não proíbe mandar a pessoa rodar comando — o flagrante volta:\n%s", code.System)
	}
	// A frase antiga terminava entregando a verificação à pessoa ("o que rodar
	// para verificar") — ela não pode voltar.
	if strings.Contains(code.System, "o que rodar para verificar") {
		t.Errorf("a persona voltou a entregar a verificação à pessoa:\n%s", code.System)
	}
}

// O Código DELEGA o visual ao Design — o gatilho é do OFÍCIO, não do roteador
// (docs/execucao-na-janela.md, item 3): a cascata decide UM vencedor no
// primeiro input, então "site completo" vencia no code e o design nunca
// entrava. O que este teste prende é o texto que carrega a regra: a ORDEM
// (depois de gravar a estrutura — chamado antes, o design desenha de cabeça),
// o canal (delegar ao design), o que trafega (os CAMINHOS gravados no projeto
// compartilhado) e o que NUNCA trafega (HTML inline estoura goal/contexto;
// URL de localhost morre na guarda anti-SSRF do design.replicate).
func TestPersonaDoCodigoDelegaAoDesignDepoisDeGravarAEstrutura(t *testing.T) {
	code := persona(t, "code")

	for _, want := range []string{
		"DEPOIS de gravar",
		"delegue ao especialista design",
		"CAMINHOS gravados",
		"projeto compartilhado",
	} {
		if !strings.Contains(code.System, want) {
			t.Errorf("a persona do código não carrega %q — sem o gatilho, o design nunca entra num pedido misto:\n%s",
				want, code.System)
		}
	}
	// As duas proibições do canal: o goal leva caminho, nunca o artefato nem
	// uma URL local para o replicate buscar.
	if !strings.Contains(code.System, "HTML inline") {
		t.Errorf("a persona não proíbe o HTML inline no goal:\n%s", code.System)
	}
	if !strings.Contains(code.System, "localhost") {
		t.Errorf("a persona não proíbe a URL de localhost:\n%s", code.System)
	}
	// A camada visual precisa estar NOMEADA: é ela que dispara o gesto.
	for _, sinal := range []string{"paleta", "tokens", "tipografia", "responsivo"} {
		if !strings.Contains(code.System, sinal) {
			t.Errorf("a persona não nomeia o sinal visual %q que dispara a delegação:\n%s", sinal, code.System)
		}
	}
}

// O Design LÊ o projeto (o index.html que o Código gravou mora no mesmo cwd) e
// a permissão cobre a leitura — fs.read E fs.list, porque sem listar a pasta
// ele não acha o arquivo que a persona manda ler.
func TestPersonaDoDesignLeOProjetoEAPermissaoCobre(t *testing.T) {
	design := persona(t, "design")

	for _, want := range []string{"fs.read", "fs.list"} {
		if !strings.Contains(design.System, want) {
			t.Errorf("a persona do design não cita %q — é a leitura do projeto que a faz desenhar o front real:\n%s",
				want, design.System)
		}
		if !design.AllowsTool(want) {
			t.Errorf("a persona manda ler com %q e a lista de permitidas não cobre", want)
		}
	}
	// O ofício continua sendo desenhar pelas ferramentas de design.
	if !design.AllowsTool("design.replicate") {
		t.Error("o design perdeu a própria ferramenta de ofício (design.replicate)")
	}
}

// O Dados produz o schema pelo ferramental estruturado — é o JSON dessas
// ferramentas que a tela transforma em diagrama; schema colado no chat deixa o
// painel vazio.
func TestPersonaDeDadosProduzPeloFerramentalEstruturado(t *testing.T) {
	data := persona(t, "data")

	for _, want := range []string{"schema.export", "sql.render"} {
		if !strings.Contains(data.System, want) {
			t.Errorf("a persona de dados não cita %q — sem o nome, o artefato volta como texto no chat:\n%s",
				want, data.System)
		}
		if !data.AllowsTool(want) {
			t.Errorf("a persona manda usar %q e a lista de permitidas não cobre", want)
		}
	}
}

// A AUDITORIA (b) da paridade, generalizada: TODA persona de TRABALHO
// (Surface != conversation) manda trabalhar NA PRÓPRIA JANELA e cita pelo nome
// ao menos uma ferramenta do próprio catálogo — sem o nome, o modelo não sabe
// COMO produzir na superfície e volta a colar o artefato no chat. E toda
// ferramenta citada tem de estar coberta pela permissão: ordem sem permissão é
// recusa garantida no portão (o outro lado do defeito).
//
// Só tokens que SÃO ferramentas do catálogo contam — "index.html" e "next.js"
// têm a mesma cara e não são ordem nenhuma.
func TestPersonasDeTrabalhoMandamUsarFerramentaPropria(t *testing.T) {
	conhecidas := make(map[string]bool, 64)
	for _, definition := range All() {
		for _, tool := range definition.Tools {
			conhecidas[tool] = true
		}
	}
	padraoDeFerramenta := regexp.MustCompile(`[a-z]+\.[a-z]+`)

	for _, definition := range All() {
		if definition.Surface == SurfaceConversation {
			continue
		}
		if !strings.Contains(definition.System, "NA SUA JANELA") {
			t.Errorf("a persona de %s não manda trabalhar NA SUA JANELA — a superfície dele fica vazia:\n%s",
				definition.ID, definition.System)
		}
		citouPropria := false
		for _, token := range padraoDeFerramenta.FindAllString(definition.System, -1) {
			if !conhecidas[token] {
				continue
			}
			if !definition.AllowsTool(token) {
				t.Errorf("a persona de %s manda usar %q e a permissão não cobre — recusa garantida no portão",
					definition.ID, token)
				continue
			}
			citouPropria = true
		}
		if !citouPropria {
			t.Errorf("a persona de %s não cita nenhuma ferramenta própria pelo nome:\n%s",
				definition.ID, definition.System)
		}
	}
}

// O ajuste das listas NÃO abre escrita para quem não escreve: os ofícios de
// leitura continuam sem fs.write/fs.patch. Sem esta cerca, "cobrir a persona"
// viraria a desculpa pela qual todo especialista ganha escrita no projeto.
func TestOficiosDeLeituraContinuamSemEscrita(t *testing.T) {
	for _, id := range []string{"chat", "office", "security"} {
		definition := persona(t, id)
		for _, forbidden := range []string{"fs.write", "fs.patch"} {
			if definition.AllowsTool(forbidden) {
				t.Errorf("o especialista %q ganhou %q — ele é de leitura, e escrita nova exige decisão própria",
					id, forbidden)
			}
		}
	}
}
