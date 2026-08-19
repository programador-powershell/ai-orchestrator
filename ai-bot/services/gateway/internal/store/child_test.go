package store

import "testing"

// A conversa do bot delegado: uma por (conversa de origem, bot).
//
// Antes, o Codigo chamado pelo Conversa respondia dentro da conversa do Conversa
// e sumia — nao sobrava com quem falar depois. Agora o trabalho dele mora numa
// conversa propria, aninhada sob a que a criou.
func TestChildSessionBuscaOuCria(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	pai, err := s.CreateSession(SessionMeta{ID: "s1", Title: "qual a capital da franca?"})
	if err != nil {
		t.Fatal(err)
	}

	filho, err := s.ChildSession(pai.ID, "code", "Codigo")
	if err != nil {
		t.Fatalf("ChildSession: %v", err)
	}
	if filho.ParentID != "s1" {
		t.Fatalf("a filha precisa apontar para a origem, veio %q", filho.ParentID)
	}
	if filho.BotID != "code" {
		t.Fatalf("o dono da filha e o bot, veio %q", filho.BotID)
	}
	// `Specialist` nasce igual ao dono: quem abrir e escrever continua falando
	// com ELE, porque o roteamento por conversa respeita o ultimo especialista.
	if filho.Specialist != "code" {
		t.Fatalf("o especialista da filha devia nascer como o bot, veio %q", filho.Specialist)
	}

	// Chamar o mesmo bot de novo NAO cria outra conversa: um bot chamado dez
	// vezes tem UMA conversa com dez trechos.
	denovo, err := s.ChildSession(pai.ID, "code", "Codigo")
	if err != nil {
		t.Fatal(err)
	}
	if denovo.ID != filho.ID {
		t.Fatalf("a segunda chamada criou outra conversa: %q e %q", filho.ID, denovo.ID)
	}

	// Bot diferente, conversa diferente.
	outro, err := s.ChildSession(pai.ID, "design", "Design")
	if err != nil {
		t.Fatal(err)
	}
	if outro.ID == filho.ID {
		t.Fatal("dois bots nao podem dividir a mesma conversa")
	}

	// E as tres aparecem na listagem, com o vinculo preservado em disco.
	lista, err := s.ListSessions()
	if err != nil {
		t.Fatal(err)
	}
	filhas := 0
	for _, meta := range lista {
		if meta.ParentID == "s1" {
			filhas++
		}
	}
	if filhas != 2 {
		t.Fatalf("esperava 2 conversas filhas na listagem, achei %d", filhas)
	}
}

func TestChildSessionRecusaSemPaiOuSemBot(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	if _, err := s.ChildSession("", "code", "Codigo"); err == nil {
		t.Fatal("conversa filha sem origem tinha de ser recusada")
	}
	if _, err := s.ChildSession("s1", "  ", "Codigo"); err == nil {
		t.Fatal("conversa filha sem bot dono tinha de ser recusada")
	}
}

// O id e estavel e sobrevive ao safeID: o que a tela pede e o que existe em
// disco.
func TestChildSessionIDEstavel(t *testing.T) {
	if a, b := ChildSessionID("s1", "code"), ChildSessionID("s1", "code"); a != b {
		t.Fatalf("o id devia ser estavel: %q e %q", a, b)
	}
	id := ChildSessionID("s1787", "security")
	if safeID(id) != id {
		t.Fatalf("o id vira %q no disco — a tela pediria um id que nao existe", safeID(id))
	}
}
