// Testes do catálogo publicado.
//
// Todos apontam para a mesma direção: o overlay só pode errar RECUSANDO
// INTEIRO. Um catálogo publicado pela metade — porque um especialista tinha
// superfície inventada e os outros nove entraram — é uma tela em branco para
// quem estivesse naquele especialista e um roteador com candidato que não
// desenha. O catálogo anterior continuar de pé é sempre o desfecho melhor.
package specialist

import (
	"encoding/json"
	"strings"
	"sync"
	"testing"
)

/* --------------------------------- apoio ---------------------------------- */

// validDefinition é um especialista mínimo e VÁLIDO. Cada teste estraga um
// campo só, para o motivo da recusa ser inequívoco.
func validDefinition(id string) Definition {
	return Definition{
		ID:          id,
		Name:        "Publicado " + id,
		Tagline:     "veio do servidor",
		Glyph:       "chat",
		Hue:         200,
		Surface:     SurfaceConversation,
		Rail:        RailConversations,
		System:      "Você é o especialista publicado.",
		Placeholder: "Escreva…",
		NewLabel:    "Nova conversa",
		Avatar: Avatar{
			Seed: 7, Shape: "orb", Eyes: "dot", Mouth: "smile",
			Accessory: "none", Motion: "breathe", Hue: 200, Saturation: 62,
		},
	}
}

// overlayOf serializa o documento como ele chegaria do servidor.
func overlayOf(t *testing.T, version string, definitions ...Definition) []byte {
	t.Helper()
	raw, err := json.Marshal(Overlay{
		SchemaVersion: OverlaySchemaVersion,
		Version:       version,
		Specialists:   definitions,
	})
	if err != nil {
		t.Fatalf("serializar o overlay: %v", err)
	}
	return raw
}

// restoreCompiled devolve o pacote ao estado de fábrica no fim do teste. O
// catálogo é global por natureza (é um registro), então cada teste limpa o que
// sujou — sem isto a ordem dos testes passaria a importar.
func restoreCompiled(t *testing.T) {
	t.Helper()
	t.Cleanup(func() {
		ResetOverlay()
		SetToolChecker(nil)
	})
}

/* ------------------------------ aplica e volta ---------------------------- */

func TestLoadOverlayReplacesTheCatalogAndSaysWhereItCameFrom(t *testing.T) {
	restoreCompiled(t)

	if origin := Origin(); origin != originCompiled {
		t.Fatalf("antes de publicar, Origin() = %q, esperava %q", origin, originCompiled)
	}
	compiled := len(All())

	published := overlayOf(t, "0.2.0", validDefinition(DefaultID), validDefinition("publicado"))
	if err := LoadOverlay(published); err != nil {
		t.Fatalf("LoadOverlay recusou um documento válido: %v", err)
	}

	if got, want := Origin(), "publicado v0.2.0"; got != want {
		t.Errorf("Origin() = %q, esperava %q", got, want)
	}
	if got := len(All()); got != 2 {
		t.Errorf("o catálogo tem %d especialistas, esperava os 2 publicados (o compilado tinha %d)", got, compiled)
	}
	if definition, ok := Get("publicado"); !ok {
		t.Error("Get(\"publicado\"): o especialista publicado não entrou no índice")
	} else if definition.Name != "Publicado publicado" {
		t.Errorf("o especialista publicado veio com Name %q", definition.Name)
	}
	// Quem não veio no overlay some: o documento é o catálogo COMPLETO, não um
	// patch. Se ele fosse mesclado, duas estações com binários diferentes
	// acabariam com catálogos diferentes a partir do mesmo documento.
	if Exists("security") {
		t.Error("um especialista que não está no overlay continuou existindo — o documento é o catálogo inteiro, não um patch")
	}
	// O master é do roteador e não vem do overlay: ele continua respondendo.
	if !Exists(MasterID) {
		t.Error("o master sumiu do índice depois da publicação")
	}

	ResetOverlay()
	if origin := Origin(); origin != originCompiled {
		t.Errorf("depois de ResetOverlay, Origin() = %q, esperava %q", origin, originCompiled)
	}
	if got := len(All()); got != compiled {
		t.Errorf("depois de ResetOverlay o catálogo tem %d, esperava os %d compilados", got, compiled)
	}
	if !Exists("security") {
		t.Error("o catálogo compilado não voltou inteiro")
	}
}

func TestLoadOverlayNormalizesThePrefixOfTheVersion(t *testing.T) {
	restoreCompiled(t)

	if err := LoadOverlay(overlayOf(t, "v1.4.0", validDefinition(DefaultID))); err != nil {
		t.Fatalf("LoadOverlay: %v", err)
	}
	if got, want := Origin(), "publicado v1.4.0"; got != want {
		t.Errorf("Origin() = %q, esperava %q — o `v` do documento não pode virar `vv`", got, want)
	}
}

/* -------------------------------- recusas --------------------------------- */

// O teste central do arquivo: um único especialista inválido derruba o
// documento INTEIRO, e o catálogo que já valia continua sem um arranhão.
func TestLoadOverlayRefusesTheWholeDocumentWhenOneSpecialistIsInvalid(t *testing.T) {
	restoreCompiled(t)

	quebrado := validDefinition("quebrado")
	quebrado.Surface = "holograma"

	raw := overlayOf(t, "0.3.0", validDefinition(DefaultID), validDefinition("bom"), quebrado)
	err := LoadOverlay(raw)
	if err == nil {
		t.Fatal("LoadOverlay aceitou um documento com superfície inventada")
	}
	if !strings.Contains(err.Error(), "holograma") {
		t.Errorf("o erro não diz qual superfície reprovou: %v", err)
	}

	if origin := Origin(); origin != originCompiled {
		t.Errorf("Origin() = %q — o catálogo trocou apesar da recusa", origin)
	}
	// Nem o especialista VÁLIDO do mesmo documento pode ter entrado.
	if Exists("bom") {
		t.Error("um especialista válido do documento recusado entrou no catálogo — meio catálogo aplicado é o desfecho que a recusa existe para impedir")
	}
	if !Exists("chat") || !Exists("code") {
		t.Error("o catálogo compilado não sobreviveu à recusa")
	}
}

// Depois de UM overlay bom, um overlay ruim não pode derrubar o bom de volta
// para o compilado: "recusar" é não fazer nada, não é voltar.
func TestLoadOverlayKeepsThePreviousOverlayWhenTheNextOneIsRefused(t *testing.T) {
	restoreCompiled(t)

	if err := LoadOverlay(overlayOf(t, "0.2.0", validDefinition(DefaultID), validDefinition("primeiro"))); err != nil {
		t.Fatalf("primeira publicação: %v", err)
	}

	semID := validDefinition("")
	if err := LoadOverlay(overlayOf(t, "0.3.0", validDefinition(DefaultID), semID)); err == nil {
		t.Fatal("LoadOverlay aceitou um especialista sem id")
	}

	if got, want := Origin(), "publicado v0.2.0"; got != want {
		t.Errorf("Origin() = %q, esperava %q — a recusa voltou ao compilado em vez de não fazer nada", got, want)
	}
	if !Exists("primeiro") {
		t.Error("o overlay anterior foi perdido pela recusa do seguinte")
	}
}

func TestLoadOverlayRefusesTheCatalogWithoutTheDefaultSpecialist(t *testing.T) {
	restoreCompiled(t)

	// Um catálogo sem o padrão passaria em qualquer validação campo a campo, e
	// quebraria no primeiro id desconhecido: GetOrDefault devolveria Definition
	// zerada, com Surface vazia — tela em branco sem erro nenhum.
	err := LoadOverlay(overlayOf(t, "0.4.0", validDefinition("outro")))
	if err == nil {
		t.Fatal("LoadOverlay aceitou um catálogo sem o especialista padrão")
	}
	if !strings.Contains(err.Error(), DefaultID) {
		t.Errorf("o erro não cita o especialista padrão: %v", err)
	}
	if GetOrDefault("id-que-nao-existe").Surface == "" {
		t.Error("GetOrDefault caiu num especialista zerado")
	}
}

func TestLoadOverlayRefusesEverythingThatTheInterfaceCannotDraw(t *testing.T) {
	restoreCompiled(t)

	quebra := func(mutate func(*Definition)) Definition {
		definition := validDefinition("quebrado")
		mutate(&definition)
		return definition
	}

	cases := []struct {
		name       string
		definition Definition
		expect     string
	}{
		{"superfície desconhecida", quebra(func(d *Definition) { d.Surface = "tabuleiro" }), "tabuleiro"},
		{"trilho desconhecido", quebra(func(d *Definition) { d.Rail = "gavetas" }), "gavetas"},
		{"sem superfície", quebra(func(d *Definition) { d.Surface = "" }), "superfície"},
		{"sem trilho", quebra(func(d *Definition) { d.Rail = "" }), "trilho"},
		{"sem nome", quebra(func(d *Definition) { d.Name = "  " }), "name"},
		{"sem prompt", quebra(func(d *Definition) { d.System = "" }), "system"},
		{"id com maiúscula", quebra(func(d *Definition) { d.ID = "Codigo" }), "formato"},
		{"id com espaço", quebra(func(d *Definition) { d.ID = "meu especialista" }), "formato"},
		{"id do master", quebra(func(d *Definition) { d.ID = MasterID }), "reservado"},
		{"matiz fora da faixa", quebra(func(d *Definition) { d.Hue = 400 }), "hue"},
		{"forma de avatar inventada", quebra(func(d *Definition) { d.Avatar.Shape = "piramide" }), "piramide"},
		{"olhos de avatar inventados", quebra(func(d *Definition) { d.Avatar.Eyes = "laser" }), "laser"},
		{"movimento de avatar inventado", quebra(func(d *Definition) { d.Avatar.Motion = "cambalhota" }), "cambalhota"},
		{"saturação fora da faixa", quebra(func(d *Definition) { d.Avatar.Saturation = 900 }), "saturation"},
		{"radical em branco", quebra(func(d *Definition) { d.Triggers = []string{"codig", "  "} }), "radical"},
		{"atalho sem rótulo", quebra(func(d *Definition) { d.Actions = []Action{{ID: "x", Insert: "/x "}} }), "atalho"},
	}

	for _, each := range cases {
		t.Run(each.name, func(t *testing.T) {
			err := LoadOverlay(overlayOf(t, "0.5.0", validDefinition(DefaultID), each.definition))
			if err == nil {
				t.Fatalf("LoadOverlay aceitou %s", each.name)
			}
			if !strings.Contains(strings.ToLower(err.Error()), strings.ToLower(each.expect)) {
				t.Errorf("o erro não menciona %q: %v", each.expect, err)
			}
			if Origin() != originCompiled {
				t.Errorf("o catálogo trocou apesar da recusa: Origin() = %q", Origin())
			}
		})
	}
}

func TestLoadOverlayRefusesIDRepeated(t *testing.T) {
	restoreCompiled(t)

	// Sem esta checagem o segundo simplesmente esconderia o primeiro no índice,
	// e o catálogo mostraria dois cartões que levam ao mesmo lugar.
	err := LoadOverlay(overlayOf(t, "0.6.0", validDefinition(DefaultID), validDefinition("gemeo"), validDefinition("gemeo")))
	if err == nil {
		t.Fatal("LoadOverlay aceitou dois especialistas com o mesmo id")
	}
	if !strings.Contains(err.Error(), "repetido") {
		t.Errorf("o erro não diz que o id está repetido: %v", err)
	}
}

func TestLoadOverlayRefusesEmptyOrMalformedDocuments(t *testing.T) {
	restoreCompiled(t)

	cases := map[string][]byte{
		"não é JSON":        []byte("{isto não é json"),
		"sem especialistas": overlayOf(t, "0.7.0"),
		"sem versão":        overlayOf(t, "  ", validDefinition(DefaultID)),
		"esquema desconhecido": func() []byte {
			raw, _ := json.Marshal(Overlay{SchemaVersion: 99, Version: "9.0.0", Specialists: []Definition{validDefinition(DefaultID)}})
			return raw
		}(),
		"sem esquema": func() []byte {
			raw, _ := json.Marshal(Overlay{Version: "0.8.0", Specialists: []Definition{validDefinition(DefaultID)}})
			return raw
		}(),
	}

	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			if err := LoadOverlay(raw); err == nil {
				t.Fatalf("LoadOverlay aceitou um documento %s", name)
			}
			if Origin() != originCompiled {
				t.Errorf("o catálogo trocou apesar da recusa: Origin() = %q", Origin())
			}
		})
	}
}

/* ------------------------------- ferramentas ------------------------------ */

func TestLoadOverlayRefusesToolThatDoesNotExistInTheRegistry(t *testing.T) {
	restoreCompiled(t)

	// O registro real vive no supervisor; aqui ele é o conjunto que o gateway
	// diria conhecer.
	SetToolChecker(func(name string) bool {
		return name == "fs.read" || name == "web.search"
	})

	comFerramenta := validDefinition("pesquisa")
	comFerramenta.Tools = []string{"fs.read", "telepatia.ler"}

	err := LoadOverlay(overlayOf(t, "0.9.0", validDefinition(DefaultID), comFerramenta))
	if err == nil {
		t.Fatal("LoadOverlay aceitou um especialista com ferramenta que não existe")
	}
	if !strings.Contains(err.Error(), "telepatia.ler") {
		t.Errorf("o erro não diz qual ferramenta não existe: %v", err)
	}

	// E o mesmo documento, com as ferramentas que existem, passa.
	comFerramenta.Tools = []string{"fs.read", "web.search"}
	if err := LoadOverlay(overlayOf(t, "0.9.0", validDefinition(DefaultID), comFerramenta)); err != nil {
		t.Fatalf("LoadOverlay recusou ferramentas que existem: %v", err)
	}
}

/* --------------------------------- ganchos -------------------------------- */

func TestOnChangeRunsAfterEverySwap(t *testing.T) {
	restoreCompiled(t)

	// O gancho é o que faz os caches do roteador acompanharem a publicação. Ele
	// tem de rodar com a troca JÁ publicada — um gancho que enxerga o catálogo
	// antigo reconstruiria o cache velho.
	var seen []string
	OnChange(func() { seen = append(seen, Origin()) })
	t.Cleanup(func() {
		stateMu.Lock()
		hooks = nil
		stateMu.Unlock()
	})

	if err := LoadOverlay(overlayOf(t, "1.0.0", validDefinition(DefaultID))); err != nil {
		t.Fatalf("primeira publicação: %v", err)
	}
	// Uma recusa NÃO é uma troca: o gancho no meio dela reconstruiria o cache
	// por um catálogo que não passou a valer.
	if err := LoadOverlay(overlayOf(t, "1.1.0")); err == nil {
		t.Fatal("LoadOverlay aceitou um documento sem especialistas")
	}
	ResetOverlay()

	want := []string{"publicado v1.0.0", originCompiled}
	if len(seen) != len(want) {
		t.Fatalf("o gancho rodou %d vez(es), esperava uma por troca aplicada: %v", len(seen), seen)
	}
	for i := range want {
		if seen[i] != want[i] {
			t.Errorf("na troca %d o gancho viu %q, esperava %q — ele precisa rodar com a troca JÁ publicada", i, seen[i], want[i])
		}
	}
}

/* ------------------------------- concorrência ----------------------------- */

// A leitura do catálogo é caminho quente e acontece em qualquer goroutine de
// turno; a troca acontece a cada seis horas. Este teste existe para o `-race`
// ter o que encontrar se alguém trocar o atomic.Pointer por um mapa comum.
func TestCatalogSurvivesReadsDuringASwap(t *testing.T) {
	restoreCompiled(t)

	stop := make(chan struct{})
	var readers sync.WaitGroup
	for i := 0; i < 4; i++ {
		readers.Add(1)
		go func() {
			defer readers.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				// GetOrDefault nunca pode devolver especialista zerado, nem no
				// instante exato da troca.
				if GetOrDefault("id-inexistente").Surface == "" {
					t.Error("GetOrDefault devolveu um especialista sem superfície durante a troca")
					return
				}
				_ = All()
				_ = IDs()
			}
		}()
	}

	for i := 0; i < 20; i++ {
		if err := LoadOverlay(overlayOf(t, "2.0.0", validDefinition(DefaultID), validDefinition("extra"))); err != nil {
			t.Errorf("LoadOverlay: %v", err)
			break
		}
		ResetOverlay()
	}
	close(stop)
	readers.Wait()
}
