// Testes das ferramentas de VÍDEO no catálogo — o par do que o host promete
// em apps/desktop/src-tauri/src/video.rs.
//
// O contrato tem três pernas e cada teste segura uma: as cinco existem no
// catálogo (senão o especialista promete o que ninguém executa), são de HOST
// (o gateway não tem ffmpeg — registrá-las como locais penduraria a chamada
// num executor que não existe) e o especialista de design as lista (senão
// elas existem e nenhum turno pode pedi-las).
package supervisor

import (
	"testing"

	"aibot/gateway/internal/specialist"
)

var videoTools = []string{
	"video.probe",
	"video.trim",
	"video.concat",
	"video.text",
	"video.export",
}

func TestFerramentasDeVideoEstaoNoCatalogoComoHost(t *testing.T) {
	registry := catalogo(t)
	for _, name := range videoTools {
		if !registry.Has(name) {
			t.Errorf("%s deveria estar no catálogo", name)
			continue
		}
		if description := registry.Describe(name); description == "" {
			t.Errorf("%s está sem descrição — é a descrição que o modelo lê para decidir a chamada", name)
		}
		// `host: true` é o que despacha para a ponte; uma registração local
		// sem função seria um catálogo que promete e um executor que não há.
		registry.mu.RLock()
		entry := registry.tools[name]
		registry.mu.RUnlock()
		if !entry.host {
			t.Errorf("%s precisa ser ferramenta de HOST: o ffmpeg mora na estação, não no gateway", name)
		}
	}
}

// Vídeo é entrega visual: as cinco pertencem ao especialista de design.
func TestDesignGanhaAsCincoFerramentasDeVideo(t *testing.T) {
	design, ok := specialist.Get("design")
	if !ok {
		t.Fatal("o especialista design deveria existir")
	}
	for _, name := range videoTools {
		if !design.AllowsTool(name) {
			t.Errorf("o design deveria poder pedir %s", name)
		}
	}
}
