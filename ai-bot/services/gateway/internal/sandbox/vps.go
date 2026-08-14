// O ambiente VPS — o servidor da TI, dirigido pelo OpenSSH do sistema.
//
// A decisão portada do produto anterior, que fica: NÃO embutir biblioteca SSH.
// Chamar o `ssh` instalado herda o agente de chaves, o ~/.ssh/config e o
// known_hosts que a TI já administra — a mesma identidade, os mesmos apelidos
// de host e o mesmo alarme de chave trocada que a pessoa tem no terminal dela.
// Uma biblioteca SSH dentro do gateway seria uma SEGUNDA pilha de autenticação
// para manter (armazém de chaves próprio, parser de config próprio, política de
// host key própria), e justamente no processo que guarda a conversa e os
// segredos. É a mesma régua do `sbx` e do `git`: dirigimos a ferramenta do
// sistema, não a redistribuímos nem a reimplementamos.
//
// # O ai-jail — confinamento honesto DENTRO da VPS
//
// `Run` nunca manda o comando cru: ele vai embrulhado em
//
//	cd <workdir> && nice -n 10 timeout <s> bash -c 'ulimit -v <kb> -f <kb>; <cmd>'
//
// — prioridade baixa (nice), teto de tempo (timeout), teto de memória virtual e
// de tamanho de arquivo (ulimit) e diretório preso ao workdir do projeto na
// VPS.
//
// O QUE ISTO NÃO É: isolamento de kernel. O processo continua enxergando o
// sistema de arquivos, a rede e os outros processos do usuário na VPS — ulimit
// não é namespace e nice não é cgroup. É cinto de segurança contra o comando
// desastrado (o build que come a RAM da máquina compartilhada, o log que enche
// o disco, o loop que não termina), não jaula contra código hostil. Quem
// precisa de jaula de verdade usa o ambiente Docker, que existe para isso.
package sandbox

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"aibot/gateway/internal/protocol"
)

// Os tetos do ai-jail. Constantes, e não configuração: quem edita o
// catalog.json é quem APONTA a VPS, e deixar os limites editáveis ali seria
// convidar o primeiro build que estourar a memória a resolver o problema
// afrouxando o cinto.
const (
	// jailTimeoutSeconds casa com o procTimeout do supervisor (15 min) de
	// propósito: o teto REMOTO tem de valer o mesmo que o local, senão uma
	// conexão que cai deixa o processo vivo na VPS por mais tempo do que o
	// turno que o pediu existiu.
	jailTimeoutSeconds = 900
	// jailMemoryKB limita a memória virtual (ulimit -v, em KiB no bash): 4 GiB.
	jailMemoryKB = 4 * 1024 * 1024
	// jailFileKB limita o maior arquivo que o comando escreve (ulimit -f, em
	// KiB no bash): 2 GiB — cabe artefato de build, não cabe log desgovernado
	// enchendo o disco que é de todo mundo.
	jailFileKB = 2 * 1024 * 1024
)

// As frases de recusa. Cada uma diz O QUE fazer, porque "indisponível" sozinho
// não resolve nada para quem está olhando a opção cinza.
const (
	vpsUnconfigured = "a VPS não está configurada — preencha o campo \"vps\" " +
		"({host, port, user, workdir, fingerprint}) em <AIBOT_DATA_DIR>/catalog.json"
	vpsMissingSSH = "o cliente OpenSSH não está instalado — habilite o OpenSSH do sistema " +
		"(ssh, ssh-keyscan e ssh-keygen no PATH) para usar a VPS"
)

/* ------------------------------ configuração ----------------------------- */

// VPSConfig é o campo `vps` do catalog.json — o servidor que a TI aponta.
//
// A fingerprint é a parte que transforma "um servidor" em "AQUELE servidor":
// sem ela, o primeiro uso confia em quem responder pelo DNS naquele momento.
type VPSConfig struct {
	Host string `json:"host"`
	// Port zero usa o padrão do ssh (22, ou o que o ~/.ssh/config disser para
	// este host — herdar a config do sistema é o motivo de chamar o OpenSSH).
	Port int    `json:"port"`
	User string `json:"user,omitempty"`
	// Workdir é a pasta do projeto DENTRO da VPS. Todo comando roda confinado
	// a ela pelo ai-jail.
	Workdir string `json:"workdir"`
	// Fingerprint é o SHA256:… da chave do servidor, conferido A CADA uso.
	// Obtém-se com `ssh-keyscan -p <porta> <host> | ssh-keygen -lf -`.
	Fingerprint string `json:"fingerprint"`
}

// problem diz por que esta configuração NÃO serve, em frase acionável.
// Vazio = serve.
func (c VPSConfig) problem() string {
	host := strings.TrimSpace(c.Host)
	if host == "" {
		return vpsUnconfigured
	}
	// Host ou usuário começando com "-" viraria FLAG do ssh na linha de
	// comando — é o único jeito de um valor do catálogo escapar dos elementos
	// separados do argv, então morre aqui, na validação, e não lá.
	if strings.HasPrefix(host, "-") || strings.HasPrefix(strings.TrimSpace(c.User), "-") {
		return "o host e o usuário da VPS não podem começar com \"-\" — confira o campo \"vps\" do catalog.json"
	}
	if strings.TrimSpace(c.Workdir) == "" {
		return "a VPS está sem \"workdir\" no catalog.json — sem ele não há a que pasta confinar a execução"
	}
	if strings.TrimSpace(c.Fingerprint) == "" {
		return "a VPS está sem \"fingerprint\" no catalog.json — rode " +
			"`ssh-keyscan -p <porta> <host> | ssh-keygen -lf -` e cole o SHA256:… " +
			"para o gateway poder conferir que o servidor é o da TI"
	}
	return ""
}

// Configured diz se há uma VPS utilizável declarada. É o que o registro
// consulta para decidir se o PADRÃO do gateway pode ser a VPS.
func (c VPSConfig) Configured() bool { return c.problem() == "" }

// destination monta o alvo do ssh (user@host, ou só host quando o usuário fica
// por conta do ~/.ssh/config).
func (c VPSConfig) destination() string {
	host := strings.TrimSpace(c.Host)
	if user := strings.TrimSpace(c.User); user != "" {
		return user + "@" + host
	}
	return host
}

/* ------------------------- montagem de argumentos ------------------------ */

// sshArgs monta a linha do `ssh`. PURA, elementos SEPARADOS, e o comando
// remoto é o ÚLTIMO elemento, inteiro — as três regras que não se negociam.
//
// As opções vão explícitas na linha (e não confiadas ao ssh_config) porque são
// as de SEGURANÇA: um ssh_config editado não pode reabrir o que está fechado
// aqui.
func sshArgs(config VPSConfig, remoteCommand string) []string {
	args := []string{
		// Sem prompt interativo NENHUM: processo filho não tem quem digite, e
		// um prompt pendurado seria um turno travado até o timeout.
		"-o", "BatchMode=yes",
		// accept-new, NUNCA "no": a primeira conexão grava a chave no
		// known_hosts e as seguintes RECUSAM se ela mudar. "no" desligaria
		// exatamente o alarme de servidor trocado que se quer ligado — e a
		// fingerprint do catálogo ainda é conferida ANTES, a cada uso.
		"-o", "StrictHostKeyChecking=accept-new",
		// Nada de senha nem teclado-interativo: a autenticação é por chave, do
		// agente e do ~/.ssh/config que a TI administra. Senha em processo
		// filho não existe — nem digitada, nem em variável.
		"-o", "PasswordAuthentication=no",
		"-o", "KbdInteractiveAuthentication=no",
	}
	if config.Port > 0 {
		// Flag e valor em elementos separados; ver sbxArgs para o porquê.
		args = append(args, "-p", strconv.Itoa(config.Port))
	}
	// O comando remoto é UM argumento: o ssh junta múltiplos argumentos com
	// espaço e entrega a string ao shell remoto — deixar essa junção acontecer
	// seria remontar o comando fora do nosso controle.
	args = append(args, config.destination(), remoteCommand)
	return args
}

// keyscanArgs monta a linha do `ssh-keyscan` da conferência de fingerprint.
func keyscanArgs(config VPSConfig) []string {
	// -T limita a espera pelo servidor: a conferência roda na sondagem do
	// handshake, e um host mudo não pode segurar a tela além do probeTimeout.
	args := []string{"-T", "5"}
	if config.Port > 0 {
		args = append(args, "-p", strconv.Itoa(config.Port))
	}
	return append(args, strings.TrimSpace(config.Host))
}

// jailCommand embrulha o comando no ai-jail (ver o cabeçalho do arquivo: cinto
// de segurança, não jaula). PURA: é ela que o teste mede.
func jailCommand(config VPSConfig, command string) string {
	// O ulimit entra DENTRO do bash -c: limite de shell vale para o processo e
	// os filhos, e é barato — não requer root nem cgroup na VPS.
	inner := fmt.Sprintf("ulimit -v %d -f %d; %s", jailMemoryKB, jailFileKB, command)
	return fmt.Sprintf("cd %s && nice -n 10 timeout %d bash -c %s",
		shellQuote(strings.TrimSpace(config.Workdir)), jailTimeoutSeconds, shellQuote(inner))
}

// shellQuote põe o texto em aspas simples de POSIX, o único quoting em que
// NADA é interpretado. O apóstrofo interno vira '\” (fecha, escapa, reabre) —
// é o mesmo truque do drawtext do ffmpeg, e o único que existe.
func shellQuote(text string) string {
	return "'" + strings.ReplaceAll(text, "'", `'\''`) + "'"
}

/* -------------------------------- VPSRunner ------------------------------ */

// stdinExecFunc dispara um processo alimentando o stdin. Separado do execFunc
// de propósito: só a conferência de fingerprint precisa de stdin (o
// `ssh-keygen -lf -` lê as chaves dele), e pendurar o parâmetro no execFunc
// obrigaria todos os runners a carregar um campo que nunca usam.
type stdinExecFunc func(ctx context.Context, stdin, name string, args []string) (Result, error)

// runProcessWithStdin é o disparo real. Mesma classificação de desfecho do
// runProcess: sair com código != 0 é resultado, não erro do ambiente.
func runProcessWithStdin(ctx context.Context, stdin, name string, args []string) (Result, error) {
	started := time.Now()
	command := exec.CommandContext(ctx, name, args...)
	command.Stdin = strings.NewReader(stdin)
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr

	err := command.Run()
	result := Result{
		Stdout:  strings.TrimRight(stdout.String(), "\r\n"),
		Stderr:  strings.TrimRight(stderr.String(), "\r\n"),
		Elapsed: time.Since(started),
	}
	var exitErr *exec.ExitError
	switch {
	case err == nil:
		return result, nil
	case errors.As(err, &exitErr):
		result.ExitCode = exitErr.ExitCode()
		return result, nil
	default:
		result.ExitCode = -1
		return result, fmt.Errorf("executar %s: %w", name, err)
	}
}

// VPSRunner executa no servidor da TI, pelo OpenSSH do sistema, sempre dentro
// do ai-jail. Ver o cabeçalho do arquivo.
type VPSRunner struct {
	Config VPSConfig

	lookPath lookupFunc
	run      execFunc
	runStdin stdinExecFunc
}

// NewVPSRunner monta o ambiente da VPS. Config zerada é um ambiente DECLARADO
// e indisponível — aparece cinza dizendo o que preencher, em vez de sumir.
func NewVPSRunner(config VPSConfig) *VPSRunner {
	return &VPSRunner{
		Config:   config,
		lookPath: exec.LookPath,
		run:      runProcess,
		runStdin: runProcessWithStdin,
	}
}

// ID identifica o ambiente.
func (v *VPSRunner) ID() protocol.Environment { return protocol.EnvVPS }

// binariesPresent confere as três ferramentas do OpenSSH que este runner
// dirige. Uma frase só para as três: quem instala o cliente OpenSSH ganha
// todas juntas, então separar os avisos não daria ação nova a ninguém.
func (v *VPSRunner) binariesPresent() string {
	for _, binary := range []string{"ssh", "ssh-keyscan", "ssh-keygen"} {
		if _, err := v.lookPath(binary); err != nil {
			return vpsMissingSSH
		}
	}
	return ""
}

// verifyFingerprint compara a chave que o servidor APRESENTA AGORA com a que a
// TI gravou no catálogo. Roda a cada uso, não só na sondagem: entre um comando
// e outro o DNS pode trocar de dono, e é nessa janela que um impostor aparece.
//
// Divergência é RECUSA, não aviso: um aviso que deixa o comando seguir manda o
// comando (e a autenticação do agente) exatamente para a máquina suspeita.
//
// O cálculo é do próprio OpenSSH (`ssh-keygen -lf` sobre a saída do
// `ssh-keyscan`), não nosso: reimplementar o hash de fingerprint seria criar a
// segunda fonte da verdade que este pacote existe para evitar.
func (v *VPSRunner) verifyFingerprint(ctx context.Context) error {
	scan, err := probe(ctx, v.run, "ssh-keyscan", keyscanArgs(v.Config))
	if err != nil {
		return fmt.Errorf("a VPS %s não respondeu ao ssh-keyscan: %v", v.Config.Host, err)
	}
	keys := strings.TrimSpace(scan.Stdout)
	if keys == "" {
		return fmt.Errorf("a VPS %s não apresentou chave nenhuma — servidor fora do ar, porta errada ou firewall no caminho", v.Config.Host)
	}
	listing, err := v.runStdin(ctx, keys+"\n", "ssh-keygen", []string{"-lf", "-"})
	if err != nil {
		return fmt.Errorf("calcular a fingerprint da VPS %s: %v", v.Config.Host, err)
	}
	if !fingerprintMatches(listing.Stdout, v.Config.Fingerprint) {
		return fmt.Errorf("a fingerprint da VPS %s DIVERGIU da configurada (%s) — pode ser troca legítima de chave ou interceptação; confirme com a TI antes de atualizar o catalog.json",
			v.Config.Host, v.Config.Fingerprint)
	}
	return nil
}

// fingerprintMatches procura a fingerprint configurada na saída do
// `ssh-keygen -lf` (linhas "256 SHA256:… host (ED25519)"). A comparação é por
// CAMPO inteiro, nunca substring: "SHA256:abc" configurado não pode casar com
// "SHA256:abcdef" por prefixo — seria aceitar uma chave que ninguém conferiu.
func fingerprintMatches(listing, configured string) bool {
	want := strings.TrimSpace(configured)
	if want == "" {
		return false
	}
	for _, line := range strings.Split(listing, "\n") {
		for _, field := range strings.Fields(line) {
			if field == want {
				return true
			}
		}
	}
	return false
}

// Available diz se a VPS pode ser usada agora — e a sondagem já É a
// conferência de fingerprint. Não é redundância com o Run: é ela que decide se
// o PADRÃO do gateway pode ser a VPS (ver Registry.DefaultEnvironment), e um
// padrão que aponta para servidor fora do ar ou ilegítimo faria toda sessão
// nova falhar no primeiro comando.
func (v *VPSRunner) Available(ctx context.Context) (bool, string) {
	if problem := v.Config.problem(); problem != "" {
		return false, problem
	}
	if detail := v.binariesPresent(); detail != "" {
		return false, detail
	}
	if err := v.verifyFingerprint(ctx); err != nil {
		return false, err.Error()
	}
	return true, ""
}

// Run executa o comando na VPS, dentro do ai-jail.
//
// O workdir LOCAL é ignorado de propósito (o `_`): a execução acontece no
// servidor, confinada ao workdir do catálogo — um caminho C:\ da estação não
// significa nada lá, e fingir que significa foi o erro de duas-máquinas que
// este pacote existe para não repetir.
func (v *VPSRunner) Run(ctx context.Context, _ string, command string) (Result, error) {
	if strings.TrimSpace(command) == "" {
		return Result{ExitCode: -1}, errors.New("comando vazio")
	}
	if problem := v.Config.problem(); problem != "" {
		return Result{ExitCode: -1}, errors.New(problem)
	}
	if detail := v.binariesPresent(); detail != "" {
		return Result{ExitCode: -1}, errors.New(detail)
	}
	// A cada uso, não só na sondagem — ver verifyFingerprint.
	if err := v.verifyFingerprint(ctx); err != nil {
		return Result{ExitCode: -1}, err
	}
	return v.run(ctx, "", "ssh", sshArgs(v.Config, jailCommand(v.Config, command)))
}
