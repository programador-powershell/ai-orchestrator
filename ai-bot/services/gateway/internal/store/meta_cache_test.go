package store

import "testing"

// O cache de listagem: o disco é lido UMA vez por sessão na vida do processo,
// e cada escritor de meta.json o espelha — inclusive o fork, que grava direto
// (esse cai no fallback de disco no primeiro encontro, porque a pasta é nova).
func TestListSessionsUsaOCacheEEnxergaTodoEscritor(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	if _, err := s.CreateSession(SessionMeta{ID: "s1", Title: "primeira"}); err != nil {
		t.Fatal(err)
	}
	lista, err := s.ListSessions()
	if err != nil || len(lista) != 1 {
		t.Fatalf("listagem inicial: %d itens (%v)", len(lista), err)
	}

	// Atualização pelo caminho quente (UpdateSession → touchMeta → writeMeta).
	if _, err := s.UpdateSession("s1", func(meta *SessionMeta) { meta.Title = "renomeada" }); err != nil {
		t.Fatal(err)
	}
	lista, _ = s.ListSessions()
	if lista[0].Title != "renomeada" {
		t.Fatalf("a listagem não viu a atualização: %q", lista[0].Title)
	}

	// A filha (ChildSession → CreateSession) e a apagada também aparecem certo.
	if _, err := s.ChildSession("s1", "code", "Código"); err != nil {
		t.Fatal(err)
	}
	lista, _ = s.ListSessions()
	if len(lista) != 2 {
		t.Fatalf("a filha não entrou na listagem: %d itens", len(lista))
	}
	if err := s.DeleteSession("s1-code"); err != nil {
		t.Fatal(err)
	}
	lista, _ = s.ListSessions()
	if len(lista) != 1 {
		t.Fatalf("a apagada não saiu da listagem: %d itens", len(lista))
	}
}
