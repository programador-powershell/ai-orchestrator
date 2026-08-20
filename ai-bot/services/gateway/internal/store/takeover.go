package store

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// TakeoverStale derruba o dono da trava quando ele é um GATEWAY ÓRFÃO DE BUILD
// VELHO — e só nesse caso.
//
// O cenário que este arquivo mata: o gateway de ontem sobrevive ao fechamento
// do app (filho que não foi colhido), o dev recompila o binário, o app novo
// sobe... e o aibotd novo desiste na trava ("diretório de dados já está em
// uso"), enquanto o app conecta NO VELHO pela porta de sempre. Resultado
// vivido: a pessoa recompila quanto quiser e continua conversando com o código
// de ontem — o clique numa conversa do histórico ficava no vazio porque o
// binário órfão era de antes do re-hello. Nenhum log do app denunciava.
//
// O critério é ESTREITO de propósito, porque roubar a trava de um processo
// legítimo faria dois donos numerarem `seq` sobre as mesmas sessões — a
// corrupção que a trava existe para impedir:
//
//  1. o executável do dono da trava é O MESMO ARQUIVO que o nosso (mesmo
//     caminho — outro aibotd de outra pasta é outra instalação, não órfão); e
//  2. o dono começou a rodar ANTES da última escrita do executável. Um
//     processo não pode estar executando uma imagem gravada depois de ele
//     nascer; se o arquivo é mais novo que o processo, o processo roda um
//     build anterior, por definição.
//
// Empate ou dúvida (sonda falhou, caminho diferente, horário inconclusivo)
// mantém a trava de pé — o chamador segue recebendo ErrLocked, que é o
// comportamento de sempre.
//
// Devolve true quando derrubou o órfão E a trava soltou; o chamador tenta o
// Open de novo (o caminho de trava órfã do Open faz a limpeza do arquivo).
func TakeoverStale(root string) (bool, error) {
	raw, err := os.ReadFile(filepath.Join(root, ".lock"))
	if err != nil {
		return false, fmt.Errorf("ler a trava: %w", err)
	}
	var pid int
	if _, err := fmt.Sscanf(strings.TrimSpace(string(raw)), "%d", &pid); err != nil || pid <= 0 {
		return false, fmt.Errorf("trava sem pid legível")
	}
	if pid == os.Getpid() {
		return false, fmt.Errorf("a trava é deste próprio processo")
	}

	self, err := os.Executable()
	if err != nil {
		return false, fmt.Errorf("descobrir o próprio executável: %w", err)
	}
	info, err := os.Stat(self)
	if err != nil {
		return false, fmt.Errorf("idade do próprio executável: %w", err)
	}

	image, started, err := holderImage(pid)
	if err != nil {
		return false, fmt.Errorf("sondar o dono da trava (pid %d): %w", pid, err)
	}

	decision := staleHolder(self, info.ModTime(), image, started)
	if decision != "" {
		return false, fmt.Errorf("dono da trava (pid %d) não é órfão de build velho: %s", pid, decision)
	}

	if err := terminateHolder(pid); err != nil {
		return false, fmt.Errorf("derrubar o gateway órfão (pid %d): %w", pid, err)
	}

	// A morte é assíncrona: espera a trava virar órfã de verdade antes de
	// declarar vitória, senão o Open seguinte perde a corrida e falha igual.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if !processAlive(pid) {
			return true, nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	return false, fmt.Errorf("o gateway órfão (pid %d) não terminou no prazo", pid)
}

// staleHolder é a DECISÃO, separada das sondas para ser testável de mesa.
// Devolve "" quando o dono é um órfão de build velho (pode derrubar) ou o
// motivo humano da recusa.
func staleHolder(selfExe string, selfMtime time.Time, holderExe string, holderStart time.Time) string {
	// Caminhos comparados sem caixa: NTFS não diferencia, e o mesmo arquivo
	// chega ora como C:\Users, ora como c:\users dependendo de quem lançou.
	if !strings.EqualFold(filepath.Clean(selfExe), filepath.Clean(holderExe)) {
		return fmt.Sprintf("executável %q não é o nosso %q", holderExe, selfExe)
	}
	if holderStart.IsZero() {
		return "hora de início desconhecida"
	}
	if !holderStart.Before(selfMtime) {
		// Começou DEPOIS da última escrita do exe: pode muito bem estar rodando
		// exatamente este build — é um segundo gateway legítimo, não um órfão.
		return fmt.Sprintf("começou às %s, depois da escrita do executável (%s) — provavelmente roda este mesmo build",
			holderStart.Format(time.RFC3339), selfMtime.Format(time.RFC3339))
	}
	return ""
}
