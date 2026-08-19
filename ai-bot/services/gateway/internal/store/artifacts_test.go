package store

import (
	"strings"
	"testing"
)

// O Artifact Store: o integral vive aqui, a janela do modelo recebe fatias.
func TestArtifactSalvaELeEmFatias(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err := s.CreateSession(SessionMeta{ID: "s1", Title: "t"}); err != nil {
		t.Fatal(err)
	}

	conteudo := strings.Repeat("linha de log qualquer\n", 1000)
	ref, err := s.SaveArtifact("s1", "proc.run", []byte(conteudo))
	if err != nil {
		t.Fatalf("gravar: %v", err)
	}
	if !strings.HasPrefix(ref, "artifact://proc_run/") {
		t.Fatalf("referência fora do formato: %q", ref)
	}

	// Endereçado por conteúdo: gravar de novo devolve a MESMA referência.
	denovo, err := s.SaveArtifact("s1", "proc.run", []byte(conteudo))
	if err != nil || denovo != ref {
		t.Fatalf("a regravação tinha de ser idempotente: %q vs %q (%v)", ref, denovo, err)
	}

	// Fatia do começo.
	chunk, total, err := s.ReadArtifact("s1", ref, 0, 22)
	if err != nil || chunk != "linha de log qualquer\n" || total != len(conteudo) {
		t.Fatalf("fatia do começo: %q total=%d err=%v", chunk, total, err)
	}
	// Offset negativo lê do FIM — o jeito de pedir o rabo do log.
	cauda, _, err := s.ReadArtifact("s1", ref, -22, 100)
	if err != nil || cauda != "linha de log qualquer\n" {
		t.Fatalf("fatia do fim: %q err=%v", cauda, err)
	}
	// Depois do fim: vazio com o total, nunca erro.
	vazio, total2, err := s.ReadArtifact("s1", ref, total+10, 10)
	if err != nil || vazio != "" || total2 != total {
		t.Fatalf("depois do fim: %q %d %v", vazio, total2, err)
	}
}

func TestArtifactRecusaOInvalido(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	if _, err := s.SaveArtifact("s1", "x", nil); err == nil {
		t.Error("artefato vazio tinha de ser recusado")
	}
	if _, _, err := s.ReadArtifact("s1", "http://alheio/coisa", 0, 10); err == nil {
		t.Error("referência fora do esquema tinha de ser recusada")
	}
	// Uma referência com travessia não pode escapar da pasta da sessão.
	if _, _, err := s.ReadArtifact("s1", "artifact://../../segredo/x", 0, 10); err == nil {
		t.Error("travessia na referência tinha de ser recusada")
	}
}

// O blob nomeado (a cápsula usa isto): ausente é (nil, nil), não erro.
func TestSessionBlobIdaEVolta(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	if data, err := s.LoadSessionBlob("s1", "capsule"); err != nil || data != nil {
		t.Fatalf("blob ausente tinha de ser (nil, nil): %q %v", data, err)
	}
	if err := s.SaveSessionBlob("s1", "capsule", []byte(`{"v":1}`)); err != nil {
		t.Fatalf("gravar: %v", err)
	}
	data, err := s.LoadSessionBlob("s1", "capsule")
	if err != nil || string(data) != `{"v":1}` {
		t.Fatalf("ler de volta: %q %v", data, err)
	}
}
