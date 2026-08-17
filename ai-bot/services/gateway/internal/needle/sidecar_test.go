// Testes do degrau local por processo separado.
//
// O sidecar de mentira é o PRÓPRIO binário de teste, reexecutado com uma
// variável de ambiente (o truque clássico do TestHelperProcess). Assim os
// cenários rodam sem Python, sem o modelo de 14 MB e sem rede — e mesmo assim
// exercitam processo de verdade, pipe de verdade e as falhas que só aparecem
// entre dois processos: morrer no meio, responder lixo, demorar demais.
package needle

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"aibot/gateway/internal/specialist"
)

// helperMode escolhe o comportamento do sidecar de mentira.
const helperMode = "AIBOT_TESTE_SIDECAR"

// TestMain intercepta a reexecução: quando a variável está posta, este processo
// NÃO é o teste — é o sidecar.
func TestMain(m *testing.M) {
	if mode := os.Getenv(helperMode); mode != "" {
		fakeSidecar(mode)
		return
	}
	os.Exit(m.Run())
}

func fakeSidecar(mode string) {
	saudacao := func() { fmt.Println(`{"specialist":"","confidence":0}`) }

	switch mode {
	case "nao-sauda":
		// Sobe e fica mudo: exercita o prazo do aperto de mão.
		select {}
	case "recusa":
		fmt.Println(`{"error":"modelo nao encontrado em ~/.cache/needle"}`)
		return
	case "saudacao-invalida":
		fmt.Println("Traceback (most recent call last):")
		return
	case "morre-na-primeira":
		saudacao()
		os.Exit(1)
	}

	saudacao()
	decoder := json.NewDecoder(os.Stdin)
	for {
		var pedido sidecarRequest
		if err := decoder.Decode(&pedido); err != nil {
			return
		}
		switch mode {
		case "lixo":
			fmt.Println("isto não é json")
		case "fora-da-lista":
			fmt.Println(`{"specialist":"security","confidence":0.99}`)
		case "confianca-absurda":
			fmt.Println(`{"specialist":"code","confidence":7.5}`)
		case "erro-por-pedido":
			fmt.Println(`{"error":"o modelo nao decidiu"}`)
		case "lento":
			time.Sleep(10 * time.Second)
		default:
			// O "modelo": devolve o primeiro candidato, com a confiança embutida
			// no prompt quando ele traz "conf=".
			confianca := 0.91
			if _, depois, achou := strings.Cut(pedido.Prompt, "conf="); achou {
				fmt.Sscanf(depois, "%f", &confianca)
			}
			resposta, _ := json.Marshal(sidecarResponse{
				Specialist: pedido.Candidates[0],
				Confidence: confianca,
				Why:        "sidecar de mentira",
			})
			fmt.Println(string(resposta))
		}
	}
}

/* ------------------------------- bancada --------------------------------- */

func sidecarDeTeste(t *testing.T, mode string) *Sidecar {
	t.Helper()
	sidecar := &Sidecar{command: []string{os.Args[0]}}
	sidecar.env = append(os.Environ(), helperMode+"="+mode)
	t.Cleanup(sidecar.Close)
	return sidecar
}

func candidatos(ids ...string) []specialist.Definition {
	out := make([]specialist.Definition, 0, len(ids))
	for _, id := range ids {
		out = append(out, specialist.GetOrDefault(id))
	}
	return out
}

/* -------------------------------- cenários -------------------------------- */

func TestSidecarClassificaEConfereAResposta(t *testing.T) {
	sidecar := sidecarDeTeste(t, "ok")
	if err := sidecar.Start(context.Background()); err != nil {
		t.Fatalf("subir o sidecar: %v", err)
	}
	if !sidecar.Ready() {
		t.Fatal("o sidecar subiu e não se diz pronto")
	}

	verdict, err := sidecar.Classify(context.Background(), "conf=0.88", candidatos("code", "data"))
	if err != nil {
		t.Fatalf("classificar: %v", err)
	}
	if verdict.Specialist != "code" {
		t.Errorf("especialista: esperava code, veio %q", verdict.Specialist)
	}
	if verdict.Confidence != 0.88 {
		t.Errorf("confiança: esperava 0.88, veio %v", verdict.Confidence)
	}

	// Duas seguidas na MESMA sessão: o pipe não pode embaralhar as respostas.
	if _, err := sidecar.Classify(context.Background(), "conf=0.5", candidatos("data", "code")); err != nil {
		t.Fatalf("segunda classificação: %v", err)
	}
}

// O sidecar é processo de TERCEIRO. Um id fora dos candidatos seria um
// especialista que a política desta sessão não liberou atendendo a conversa.
func TestSidecarRecusaEspecialistaForaDosCandidatos(t *testing.T) {
	sidecar := sidecarDeTeste(t, "fora-da-lista")
	if err := sidecar.Start(context.Background()); err != nil {
		t.Fatalf("subir: %v", err)
	}
	_, err := sidecar.Classify(context.Background(), "qualquer", candidatos("code", "data"))
	if err == nil {
		t.Fatal("um id fora da lista de candidatos tem de ser recusado")
	}
	if !strings.Contains(err.Error(), "candidatos") {
		t.Errorf("a recusa precisa dizer o motivo: %v", err)
	}
	// E o processo continua de pé: resposta errada não é motivo para derrubar.
	if !sidecar.Ready() {
		t.Error("uma resposta recusada não pode derrubar o sidecar")
	}
}

func TestSidecarRecusaConfiancaForaDaFaixa(t *testing.T) {
	sidecar := sidecarDeTeste(t, "confianca-absurda")
	if err := sidecar.Start(context.Background()); err != nil {
		t.Fatalf("subir: %v", err)
	}
	if _, err := sidecar.Classify(context.Background(), "x", candidatos("code")); err == nil {
		t.Fatal("confiança 7.5 tinha de ser recusada")
	}
}

// Linha ilegível é `print` perdido do script, não crash — o turno segue pelo
// modelo grande e o sidecar continua vivo para a próxima.
func TestSidecarSobreviveALinhaIlegivel(t *testing.T) {
	sidecar := sidecarDeTeste(t, "lixo")
	if err := sidecar.Start(context.Background()); err != nil {
		t.Fatalf("subir: %v", err)
	}
	if _, err := sidecar.Classify(context.Background(), "x", candidatos("code")); err == nil {
		t.Fatal("linha ilegível tinha de virar erro")
	}
	if !sidecar.Ready() {
		t.Error("uma linha ilegível não pode derrubar o processo")
	}
}

// Morrer no meio é o modo de falha mais comum de um processo de terceiro. O que
// não pode acontecer é o gateway ficar pendurado.
func TestSidecarQueMorreDerrubaODegrauSemTravar(t *testing.T) {
	sidecar := sidecarDeTeste(t, "morre-na-primeira")
	if err := sidecar.Start(context.Background()); err != nil {
		t.Fatalf("subir: %v", err)
	}
	pronto := make(chan struct{})
	go func() {
		defer close(pronto)
		_, _ = sidecar.Classify(context.Background(), "x", candidatos("code"))
	}()
	select {
	case <-pronto:
	case <-time.After(10 * time.Second):
		t.Fatal("a chamada ficou pendurada num processo morto")
	}
	if sidecar.Ready() {
		t.Error("processo morto tem de deixar o degrau fora")
	}
	if sidecar.LastError() == nil {
		t.Error("o motivo precisa ficar registrado para o log de subida")
	}
}

// Sidecar lento perdeu a razão de existir: o degrau é para ser MAIS BARATO que
// a rede.
func TestSidecarLentoEstouraOPrazoENaoSeguraOTurno(t *testing.T) {
	sidecar := sidecarDeTeste(t, "lento")
	if err := sidecar.Start(context.Background()); err != nil {
		t.Fatalf("subir: %v", err)
	}
	inicio := time.Now()
	if _, err := sidecar.Classify(context.Background(), "x", candidatos("code")); err == nil {
		t.Fatal("o prazo tinha de estourar")
	}
	if passou := time.Since(inicio); passou > requestTimeout+2*time.Second {
		t.Errorf("a chamada demorou %s; o teto é %s", passou, requestTimeout)
	}
}

func TestSidecarQueRecusaSubirRegistraOMotivo(t *testing.T) {
	sidecar := sidecarDeTeste(t, "recusa")
	err := sidecar.Start(context.Background())
	if err == nil {
		t.Fatal("um sidecar que recusa subir tem de devolver erro")
	}
	if !strings.Contains(err.Error(), "modelo nao encontrado") {
		t.Errorf("o motivo do sidecar precisa chegar ao log: %v", err)
	}
	if sidecar.Ready() {
		t.Error("não subiu, não está pronto")
	}
}

// Traceback do Python na primeira linha: o erro tem de ser legível, não um
// "unexpected character".
func TestSidecarComSaudacaoInvalidaExplicaOQueVeio(t *testing.T) {
	sidecar := sidecarDeTeste(t, "saudacao-invalida")
	err := sidecar.Start(context.Background())
	if err == nil {
		t.Fatal("saudação ilegível tem de falhar a subida")
	}
	if !strings.Contains(err.Error(), "Traceback") {
		t.Errorf("o erro precisa citar o que veio na linha: %v", err)
	}
}

// Sem configuração o degrau simplesmente não existe — e não executa nada.
func TestSidecarDesligadoNaoExecutaNada(t *testing.T) {
	sidecar := NewSidecar("   ")
	if sidecar.Configured() {
		t.Fatal("comando vazio não pode contar como configurado")
	}
	if sidecar.Ready() {
		t.Error("desligado não pode se dizer pronto")
	}
	if err := sidecar.Start(context.Background()); err == nil {
		t.Error("Start sem comando tem de dizer que está desligado")
	}
	if _, err := sidecar.Classify(context.Background(), "x", candidatos("code")); err == nil {
		t.Error("classificar sem sidecar tem de falhar, não travar")
	}
}

// Guarda de sanidade do próprio truque do helper: se a reexecução parar de
// funcionar, os testes acima passariam por acidente.
func TestOHelperReexecutaEsteBinario(t *testing.T) {
	cmd := exec.Command(os.Args[0])
	cmd.Env = append(os.Environ(), helperMode+"=recusa")
	saida, err := cmd.Output()
	if err != nil {
		t.Fatalf("reexecutar o binário de teste: %v", err)
	}
	if !strings.Contains(string(saida), "modelo nao encontrado") {
		t.Errorf("o helper não rodou como sidecar; saída: %q", saida)
	}
}
