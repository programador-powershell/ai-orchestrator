// A TRILHA C: o próprio aibotd.
//
// O gateway é sidecar — o Rust o lança, vigia e derruba. Por isso trocar o
// cérebro do produto não precisa tocar na janela, na CSP nem no instalador:
// basta um binário novo no lugar certo e um reinício.
//
// # Por que ele NÃO troca o binário em execução
//
// Dá para fazer. No Windows, um EXE em uso não pode ser apagado, mas PODE ser
// renomeado — então o truque conhecido é renomear `aibotd.exe` para
// `aibotd.old` e gravar o novo no nome livre, com o processo antigo ainda
// rodando. Funciona nas demonstrações.
//
// Cada truque desses, porém, é uma forma nova de ficar SEM gateway:
//
//   - se o processo morre entre o rename e a gravação, sobra um diretório sem
//     `aibotd.exe`, e o app não abre mais — o conserto é reinstalar;
//   - se o antivírus segura o arquivo no meio (e ele segura, justamente quando
//     um executável aparece do nada num diretório de programa), o rename falha
//     depois do primeiro passo já ter acontecido;
//   - se o novo binário não sobe, quem faria o rollback seria o processo que
//     acabou de ser substituído.
//
// Então aqui a atualização PARA no arquivo pronto: `aibotd.new`, ao lado do
// executável atual, verificado. Quem troca é a casca, no próximo início, com
// ninguém executando o arquivo — o momento em que renomear é uma operação
// comum e reversível, e em que existe alguém vivo (o Rust) para desfazer.
//
// A versão anterior continua no disco o tempo todo: é ela que roda até o
// próximo início, e é ela que volta se o rename falhar.

package update

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// GatewayPendingName é o nome que a casca procura no próximo início.
//
// O nome é literal dos DOIS lados — aqui e no Rust, que renomeia este arquivo
// sobre o executável antes de lançar o sidecar. Combinar por constante em um
// lado só é como os dois lados divergem depois de um refactor inocente.
const GatewayPendingName = "aibotd.new"

// ErrWrongTrack marca artefato oferecido para a trilha errada.
var ErrWrongTrack = errors.New("artefato de outra trilha")

// PrepareGateway baixa o aibotd novo, confere e o deixa pronto ao lado do
// atual. Devolve o caminho do arquivo pendente.
//
// `executable` é o caminho do binário EM EXECUÇÃO — o vizinho de quem o novo
// vai ficar. Vem de fora (os.Executable no chamador) para o teste poder apontar
// um diretório temporário sem precisar de um binário de verdade.
//
// A cópia é do artefato verificado para o nome pendente, e não um rename: o
// artefato fica no cache endereçado por hash, que é o que faz republicar a
// versão anterior não baixar nada de novo. Copiar dezenas de megabytes uma vez
// por publicação é barato; perder o cache do rollback não é.
func PrepareGateway(ctx context.Context, fetcher *Fetcher, artifact Artifact, executable string) (string, error) {
	if fetcher == nil {
		return "", errors.New("sem buscador para a trilha do gateway")
	}
	if artifact.Track != TrackGateway {
		// Conferido mesmo vindo de manifesto assinado: a assinatura diz QUEM
		// publicou, não que o campo esteja certo. Gravar o bundle da interface
		// com o nome do executável seria um jeito silencioso de a casca lançar
		// um tar no próximo início.
		return "", fmt.Errorf("%w: %q não é da trilha %q", ErrWrongTrack, artifact.Track, TrackGateway)
	}
	if executable == "" {
		return "", errors.New("sem o caminho do executável atual")
	}
	digest, err := parseDigest(artifact.SHA256)
	if err != nil {
		return "", err
	}

	// Já está pronto? Enquanto a pessoa não reabre o app, toda passada de seis
	// horas veria o mesmo manifesto e reescreveria os mesmos dezenas de
	// megabytes no diretório de INSTALAÇÃO — que é o lugar onde o antivírus
	// olha com mais atenção, e reescrever executável ali de tempos em tempos é
	// como se ganha uma quarentena. O hash é a mesma prova que o download usa.
	pending := filepath.Join(filepath.Dir(executable), GatewayPendingName)
	if ready, err := fileMatches(pending, artifact.Size, digest); err == nil && ready {
		return pending, nil
	}

	verified, err := fetcher.Artifact(ctx, artifact)
	if err != nil {
		return "", err
	}
	if err := copyExecutable(verified, pending); err != nil {
		return "", err
	}
	return pending, nil
}

// copyExecutable copia por `.part` + rename, com 0700.
//
// O `.part` vale aqui pelo mesmo motivo do download: a casca renomeia
// `aibotd.new` sobre o executável SEM reconferir nada — ela confia porque quem
// gravou fomos nós, depois da assinatura. Um `aibotd.new` truncado por uma
// queda no meio da cópia seria, no próximo início, um gateway que não existe.
//
// 0700 e não 0600: no Linux o arquivo precisa do bit de execução para a casca
// conseguir lançá-lo. No Windows o modo é praticamente ignorado — quem protege
// é a ACL do diretório de instalação, que é justamente o que impede outro
// usuário de plantar um `aibotd.new` sem passar por aqui.
func copyExecutable(source, destination string) error {
	input, err := os.Open(source)
	if err != nil {
		return fmt.Errorf("abrir o artefato verificado: %w", err)
	}
	defer func() { _ = input.Close() }()

	part := destination + ".part"
	output, err := os.OpenFile(part, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o700)
	if err != nil {
		return fmt.Errorf("gravar %s: %w", filepath.Base(destination), err)
	}
	discard := func(cause error) error {
		_ = output.Close()
		_ = os.Remove(part)
		return cause
	}

	if _, err := io.Copy(output, input); err != nil {
		return discard(fmt.Errorf("copiar o gateway novo: %w", err))
	}
	if err := output.Sync(); err != nil {
		return discard(fmt.Errorf("sincronizar %s: %w", filepath.Base(destination), err))
	}
	if err := output.Close(); err != nil {
		_ = os.Remove(part)
		return fmt.Errorf("fechar %s: %w", filepath.Base(destination), err)
	}
	if err := os.Rename(part, destination); err != nil {
		_ = os.Remove(part)
		return fmt.Errorf("publicar %s: %w", filepath.Base(destination), err)
	}
	return nil
}

// ArtifactFor devolve o primeiro artefato da trilha, se houver.
//
// Primeiro e não "o único": um manifesto pode declarar mais de um artefato da
// mesma trilha (a trilha A publica catálogo de especialistas E de modelos), e
// quem chama diz qual trilha quer resolver.
func (m Manifest) ArtifactFor(track Track) (Artifact, bool) {
	for _, artifact := range m.Artifacts {
		if artifact.Track == track {
			return artifact, true
		}
	}
	return Artifact{}, false
}

// Tracks lista as trilhas do manifesto, sem repetição e na ordem em que
// aparecem. É o que vai para a tela dizer o que a publicação traz.
func (m Manifest) Tracks() []string {
	out := make([]string, 0, len(m.Artifacts))
	seen := make(map[Track]bool, len(m.Artifacts))
	for _, artifact := range m.Artifacts {
		if seen[artifact.Track] {
			continue
		}
		seen[artifact.Track] = true
		out = append(out, string(artifact.Track))
	}
	return out
}
