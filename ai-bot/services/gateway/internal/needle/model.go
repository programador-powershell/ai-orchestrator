// Descoberta do arquivo de pesos do roteador local.
//
// Compila nos DOIS builds (com e sem a tag `needle`) de propósito: mesmo o
// binário sem o binding precisa saber dizer se o MODELO está instalado — senão
// o log de subida diria só "roteador indisponível" e ninguém saberia se o passo
// que falta é o build com a tag ou o arquivo de pesos.
package needle

import (
	"os"
	"path/filepath"
)

// ModelFileName é o artefato produzido pelo harness de pesquisa
// (needle-router-pro/), treinado SÓ para escolher o dono da primeira mensagem.
const ModelFileName = "needle-router-pro.cact"

// legacyModelFileName é o nome genérico aceito antes de o harness nomear o
// artefato. Fica como último candidato para não quebrar quem instalou à mão.
const legacyModelFileName = "needle2.bin"

// ModelCandidates devolve os caminhos onde o modelo é procurado, na ordem.
//
// A ordem é uma decisão: o que a pessoa apontou (env) vence tudo; depois o
// diretório de DADOS (é gravável e é onde a atualização em trilhas instala);
// por último o diretório do executável (onde um instalador antigo colocaria —
// e que costuma ser somente-leitura sob Program Files, por isso não é o
// primeiro).
func ModelCandidates(explicit, dataDir string) []string {
	candidates := make([]string, 0, 5)
	if explicit != "" {
		candidates = append(candidates, explicit)
	}
	if dataDir != "" {
		candidates = append(candidates,
			filepath.Join(dataDir, "models", ModelFileName),
			filepath.Join(dataDir, "models", legacyModelFileName),
		)
	}
	if executable, err := os.Executable(); err == nil {
		base := filepath.Dir(executable)
		candidates = append(candidates,
			filepath.Join(base, "models", ModelFileName),
			filepath.Join(base, "models", legacyModelFileName),
		)
	}
	return candidates
}

// ResolveModelPath acha o primeiro candidato que existe.
//
// O segundo retorno distingue "achei" de "não achei em lugar nenhum" — e no
// segundo caso o primeiro retorno traz o caminho PREFERIDO (onde instalar),
// para a mensagem de log dizer exatamente onde colocar o arquivo em vez de
// mandar a pessoa adivinhar.
func ResolveModelPath(explicit, dataDir string) (string, bool) {
	candidates := ModelCandidates(explicit, dataDir)
	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate, true
		}
	}
	if explicit != "" {
		return explicit, false
	}
	if dataDir != "" {
		return filepath.Join(dataDir, "models", ModelFileName), false
	}
	return ModelFileName, false
}
