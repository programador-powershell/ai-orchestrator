// Testes do ambiente VPS.
//
// As mesmas duas regras de sandbox_test.go: nada executa de verdade (o `ssh`
// entra por `run`/`runStdin`/`lookPath`, que o teste substitui) e a montagem
// dos argumentos é medida ELEMENTO A ELEMENTO — o comando vem do modelo, e a
// regressão de concatená-lo numa string é a mais cara do pacote.
//
// O terceiro invariante daqui é o de SEGURANÇA: a fingerprint divergente tem
// de recusar SEM tocar o ssh. Um teste que só olhasse a mensagem deixaria
// passar uma implementação que avisa e conecta mesmo assim.
package sandbox

import (
	"context"
	"strings"
	"testing"

	"aibot/gateway/internal/protocol"
)

// configuracaoDeTeste é uma VPS completa e bem formada.
func configuracaoDeTeste() VPSConfig {
	return VPSConfig{
		Host:        "vps.orchestrator.example",
		Port:        2222,
		User:        "aibot",
		Workdir:     "/srv/projetos/ai-bot",
		Fingerprint: "SHA256:abcdefabcdefabcdefabcdefabcdefabcdefabcdefa",
	}
}

// stdinRecorder guarda o que teria ido para o `ssh-keygen -lf -`.
type stdinRecorder struct {
	stdin  string
	names  []string
	answer func(stdin, name string, args []string) (Result, error)
}

func (r *stdinRecorder) exec(_ context.Context, stdin, name string, args []string) (Result, error) {
	r.stdin = stdin
	r.names = append(r.names, name)
	if r.answer != nil {
		return r.answer(stdin, name, args)
	}
	return Result{}, nil
}

// runnerDeTeste monta um VPSRunner com os três duplos já ligados: o keyscan
// devolve uma chave e o keygen devolve a fingerprint pedida.
func runnerDeTeste(config VPSConfig, presented string) (*VPSRunner, *recorder, *stdinRecorder) {
	calls := &recorder{answer: func(name string, _ []string) (Result, error) {
		if name == "ssh-keyscan" {
			return Result{Stdout: "vps.orchestrator.example ssh-ed25519 AAAAC3Nza..."}, nil
		}
		return Result{Stdout: "rodou na vps"}, nil
	}}
	keygen := &stdinRecorder{answer: func(_, _ string, _ []string) (Result, error) {
		return Result{Stdout: "256 " + presented + " vps.orchestrator.example (ED25519)"}, nil
	}}
	runner := NewVPSRunner(config)
	runner.lookPath = found
	runner.run = calls.exec
	runner.runStdin = keygen.exec
	return runner, calls, keygen
}

/* -------------------------- montagem de argumentos ------------------------ */

func TestSSHArgsSemSenhaESemStrictNo(t *testing.T) {
	args := sshArgs(configuracaoDeTeste(), "cd '/srv' && make")

	// As quatro opções de segurança, cada uma como PAR "-o" + valor. A tabela
	// é o contrato: se alguém trocar accept-new por "no", este teste é o que
	// grita — "no" desliga o alarme de servidor trocado.
	for _, want := range []string{
		"BatchMode=yes",
		"StrictHostKeyChecking=accept-new",
		"PasswordAuthentication=no",
		"KbdInteractiveAuthentication=no",
	} {
		if !hasOptionPair(args, want) {
			t.Errorf("faltou a opção %q em pares -o separados: %q", want, args)
		}
	}
	for _, arg := range args {
		if strings.Contains(arg, "StrictHostKeyChecking=no") {
			t.Fatalf("StrictHostKeyChecking=no é proibido: %q", args)
		}
		if strings.Contains(strings.ToLower(arg), "password=") && !strings.Contains(arg, "PasswordAuthentication=no") {
			t.Fatalf("nenhuma senha pode viajar em argumento: %q", arg)
		}
	}

	// A porta em elementos separados, e o destino com o usuário do catálogo.
	if !hasPair(args, "-p", "2222") {
		t.Fatalf("a porta tinha de ir como par -p 2222: %q", args)
	}
	if args[len(args)-2] != "aibot@vps.orchestrator.example" {
		t.Fatalf("destino inesperado: %q", args[len(args)-2])
	}
	// O comando remoto é o ÚLTIMO elemento, inteiro: o ssh junta argumentos
	// soltos com espaço, e essa junção seria remontar o comando fora daqui.
	if args[len(args)-1] != "cd '/srv' && make" {
		t.Fatalf("o comando remoto tinha de ser UM argumento intacto: %q", args[len(args)-1])
	}
}

func TestSSHArgsSemPortaESemUsuarioHerdaOSSHConfig(t *testing.T) {
	config := configuracaoDeTeste()
	config.Port = 0
	config.User = ""
	args := sshArgs(config, "true")

	for _, arg := range args {
		if arg == "-p" {
			t.Fatalf("sem porta no catálogo o ssh_config decide — a flag não podia aparecer: %q", args)
		}
	}
	if args[len(args)-2] != "vps.orchestrator.example" {
		t.Fatalf("sem usuário no catálogo o destino é só o host: %q", args[len(args)-2])
	}
}

func hasOptionPair(args []string, value string) bool {
	for index := 0; index+1 < len(args); index++ {
		if args[index] == "-o" && args[index+1] == value {
			return true
		}
	}
	return false
}

func hasPair(args []string, flag, value string) bool {
	for index := 0; index+1 < len(args); index++ {
		if args[index] == flag && args[index+1] == value {
			return true
		}
	}
	return false
}

/* --------------------------------- ai-jail -------------------------------- */

func TestJailCommandEnvolveNiceTimeoutEUlimit(t *testing.T) {
	jail := jailCommand(configuracaoDeTeste(), comandoHostil)

	// A espinha do confinamento, na ordem: cd → nice → timeout → bash -c.
	for _, want := range []string{
		"cd '/srv/projetos/ai-bot' && ",
		"nice -n 10 ",
		"timeout 900 ",
		"bash -c ",
		"ulimit -v 4194304 -f 2097152; ",
	} {
		if !strings.Contains(jail, want) {
			t.Errorf("o ai-jail perdeu um pedaço do cinto: falta %q em %q", want, jail)
		}
	}
	// O comando hostil sobrevive DENTRO do jail com o apóstrofo escapado do
	// único jeito que o POSIX tem ('\''): sem o escape, o quoting fecharia no
	// meio e o resto viraria comando solto no shell remoto.
	if !strings.Contains(jail, `printf '\''$HOME'\''`) {
		t.Fatalf("o apóstrofo do comando não foi escapado: %q", jail)
	}
	if !strings.Contains(jail, `echo "olá; rm -rf /"`) {
		t.Fatalf("o comando do modelo foi reescrito dentro do jail: %q", jail)
	}
}

func TestVPSRunPassaOJailComoUmArgumento(t *testing.T) {
	config := configuracaoDeTeste()
	runner, calls, keygen := runnerDeTeste(config, config.Fingerprint)

	result, err := runner.Run(context.Background(), "C:\\estacao\\projeto", comandoHostil)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if result.Stdout != "rodou na vps" {
		t.Fatalf("a saída do servidor sumiu: %+v", result)
	}

	// A conferência veio ANTES da conexão: keyscan → keygen → ssh.
	if len(calls.names) != 2 || calls.names[0] != "ssh-keyscan" || calls.names[1] != "ssh" {
		t.Fatalf("ordem de processos inesperada: %q", calls.names)
	}
	if len(keygen.names) != 1 || keygen.names[0] != "ssh-keygen" {
		t.Fatalf("a fingerprint tinha de ser calculada pelo ssh-keygen: %q", keygen.names)
	}
	if !strings.Contains(keygen.stdin, "ssh-ed25519") {
		t.Fatalf("o keygen tinha de receber a chave do keyscan pelo stdin: %q", keygen.stdin)
	}

	// O último argumento do ssh é o jail INTEIRO, com o comando dentro.
	last := calls.args[len(calls.args)-1]
	remote := last[len(last)-1]
	if !strings.HasPrefix(remote, "cd '/srv/projetos/ai-bot' && nice -n 10 timeout 900 bash -c ") {
		t.Fatalf("o comando remoto não é o ai-jail: %q", remote)
	}
	if !strings.Contains(remote, "ulimit -v") || !strings.Contains(remote, `echo "olá; rm -rf /"`) {
		t.Fatalf("o comando do modelo não chegou intacto dentro do jail: %q", remote)
	}
	// E o workdir LOCAL da estação não contamina nada: a execução é remota.
	if dir := calls.dirs[len(calls.dirs)-1]; dir != "" {
		t.Fatalf("o processo ssh não roda 'dentro' de pasta local nenhuma, veio %q", dir)
	}
}

/* ------------------------------- fingerprint ------------------------------ */

func TestVPSRunRecusaFingerprintDivergente(t *testing.T) {
	config := configuracaoDeTeste()
	// O servidor apresenta OUTRA chave — o cenário de DNS sequestrado ou de
	// troca de máquina que ninguém avisou.
	runner, calls, _ := runnerDeTeste(config, "SHA256:outraChaveQueNinguemConferiu")

	_, err := runner.Run(context.Background(), "", "make")
	if err == nil {
		t.Fatal("fingerprint divergente tinha de RECUSAR, não avisar e seguir")
	}
	if !strings.Contains(err.Error(), "DIVERGIU") || !strings.Contains(err.Error(), config.Fingerprint) {
		t.Fatalf("a recusa tem de dizer o que divergiu e de quê: %v", err)
	}
	// A parte que importa: o ssh NUNCA foi chamado. Conectar depois de
	// divergir mandaria o comando para a máquina suspeita.
	for _, name := range calls.names {
		if name == "ssh" {
			t.Fatalf("o ssh foi chamado mesmo com a fingerprint divergente: %q", calls.names)
		}
	}

	// E a sondagem conta a mesma história para a tela.
	if available, detail := runner.Available(context.Background()); available || !strings.Contains(detail, "DIVERGIU") {
		t.Fatalf("Available tinha de reprovar com o motivo, veio (%v, %q)", available, detail)
	}
}

func TestFingerprintNaoCasaPorPrefixo(t *testing.T) {
	listing := "256 SHA256:abcdef vps (ED25519)"
	if fingerprintMatches(listing, "SHA256:abc") {
		t.Fatal("prefixo não é fingerprint — casar por substring aceitaria chave não conferida")
	}
	if !fingerprintMatches(listing, "SHA256:abcdef") {
		t.Fatal("o campo inteiro igual tinha de casar")
	}
	if fingerprintMatches(listing, "") {
		t.Fatal("fingerprint vazia não casa com nada")
	}
}

/* ------------------------------ configuração ------------------------------ */

func TestVPSSemConfiguracaoRecusaComFraseAcionavel(t *testing.T) {
	runner := NewVPSRunner(VPSConfig{})
	runner.lookPath = found

	available, detail := runner.Available(context.Background())
	if available {
		t.Fatal("sem configuração a VPS não pode ser oferecida")
	}
	if !strings.Contains(detail, "catalog.json") || !strings.Contains(detail, "vps") {
		t.Fatalf("a frase tem de dizer ONDE configurar: %q", detail)
	}
	if _, err := runner.Run(context.Background(), "", "make"); err == nil || !strings.Contains(err.Error(), "catalog.json") {
		t.Fatalf("Run sem configuração tinha de recusar com o mesmo caminho: %v", err)
	}
}

func TestVPSConfigExigeFingerprintEWorkdir(t *testing.T) {
	semFingerprint := configuracaoDeTeste()
	semFingerprint.Fingerprint = ""
	if problem := semFingerprint.problem(); !strings.Contains(problem, "ssh-keygen -lf") {
		t.Fatalf("sem fingerprint a frase tem de ensinar a obtê-la: %q", problem)
	}

	semWorkdir := configuracaoDeTeste()
	semWorkdir.Workdir = ""
	if problem := semWorkdir.problem(); !strings.Contains(problem, "workdir") {
		t.Fatalf("sem workdir não há a que confinar: %q", problem)
	}

	hostil := configuracaoDeTeste()
	hostil.Host = "-oProxyCommand=calc"
	if problem := hostil.problem(); problem == "" {
		t.Fatal("host começando com '-' viraria flag do ssh e tinha de ser recusado")
	}
}

func TestVPSSemOpenSSHDizOQueHabilitar(t *testing.T) {
	runner := NewVPSRunner(configuracaoDeTeste())
	runner.lookPath = missing

	available, detail := runner.Available(context.Background())
	if available || detail != vpsMissingSSH {
		t.Fatalf("esperava (false, %q), veio (%v, %q)", vpsMissingSSH, available, detail)
	}
}

/* --------------------------------- padrão --------------------------------- */

func TestDefaultEnvironmentSemVPSCaiNoLocal(t *testing.T) {
	// Sem VPS no catálogo o padrão é o de sempre. O teste cobre os dois jeitos
	// de "não ter": registro sem o runner e runner com config zerada.
	semRunner := NewRegistry(NewLocalRunner())
	if got := semRunner.DefaultEnvironment(context.Background()); got != protocol.EnvLocal {
		t.Fatalf("sem runner de VPS o padrão tinha de ser local, veio %q", got)
	}

	naoConfigurada := NewRegistry(NewLocalRunner(), NewVPSRunner(VPSConfig{}))
	if got := naoConfigurada.DefaultEnvironment(context.Background()); got != protocol.EnvLocal {
		t.Fatalf("com VPS não configurada o padrão tinha de ser local, veio %q", got)
	}
}

func TestDefaultEnvironmentViraVPSQuandoASondagemPassa(t *testing.T) {
	config := configuracaoDeTeste()
	vps, _, _ := runnerDeTeste(config, config.Fingerprint)
	registry := NewRegistry(NewLocalRunner(), vps)

	if got := registry.DefaultEnvironment(context.Background()); got != protocol.EnvVPS {
		t.Fatalf("com VPS configurada e respondendo o padrão tinha de ser vps, veio %q", got)
	}
	// E a sessão NOVA nasce nesse padrão — é o que o `ready` reflete.
	if got := registry.Active(context.Background(), "sessao-nova"); got != protocol.EnvVPS {
		t.Fatalf("sessão sem escolha tinha de nascer na vps, veio %q", got)
	}
	// A escolha explícita continua mandando mais que o padrão.
	if err := registry.Set("sessao-nova", protocol.EnvLocal); err != nil {
		t.Fatalf("Set: %v", err)
	}
	if got := registry.Active(context.Background(), "sessao-nova"); got != protocol.EnvLocal {
		t.Fatalf("a escolha explícita tinha de vencer o padrão, veio %q", got)
	}
}

func TestDefaultEnvironmentNaoPromoveVPSForaDoAr(t *testing.T) {
	config := configuracaoDeTeste()
	runner := NewVPSRunner(config)
	runner.lookPath = found
	// O keyscan não devolve chave nenhuma: servidor mudo.
	runner.run = (&recorder{answer: func(string, []string) (Result, error) {
		return Result{Stdout: ""}, nil
	}}).exec
	runner.runStdin = (&stdinRecorder{}).exec

	registry := NewRegistry(NewLocalRunner(), runner)
	if got := registry.DefaultEnvironment(context.Background()); got != protocol.EnvLocal {
		t.Fatalf("VPS configurada e fora do ar não pode ser padrão, veio %q", got)
	}
}
