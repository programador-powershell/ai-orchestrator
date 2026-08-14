// Package schedule é a agenda local do AI-BOT: gatilhos que disparam um prompt
// numa sessão sem ninguém na frente da máquina.
//
// Local de propósito. Um agendador no servidor teria de guardar do lado de lá a
// sessão, a chave do provedor e o projeto da pessoa — três coisas que o produto
// mantém na estação justamente para não precisar de servidor. Aqui o gatilho é
// uma linha num JSON ao lado da memória, e ele só corre enquanto o gateway da
// pessoa estiver de pé: quem desliga o computador não fica devendo execução.
//
// SOMENTE biblioteca padrão (política de dependências do gateway). As duas
// tentações normais foram resolvidas assim:
//
//   - cron: não existe expressão cron aqui. "a cada 15m" e "às 08:30" cobrem o
//     que a interface oferece, e um parser de cron de verdade (dia da semana,
//     lista, passo, @reboot) é dependência de terceiro ou algumas centenas de
//     linhas para um campo que ninguém digita à mão. Se a interface um dia
//     pedir cron, o lugar de escrever é este arquivo — não um require.
//   - fuso horário: não há banco de fusos. O horário de `At` é o LOCAL da
//     máquina, que é o que a pessoa quis dizer ao escrever "08:30".
package schedule

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// ErrNotFound diz que o id não está na agenda.
var ErrNotFound = errors.New("gatilho não encontrado")

const (
	// fileVersion versiona o formato em disco. Gravado desde o primeiro dia
	// porque migrar arquivo sem número de versão exige adivinhar o formato.
	fileVersion = 1

	// maxTriggers é teto de sanidade, não de capacidade. Cada gatilho é um turno
	// de modelo rodando sem ninguém olhando; um modelo que entra em laço criando
	// gatilho montaria, sozinho, uma máquina de gastar dinheiro.
	maxTriggers = 64

	// minEvery é o menor intervalo aceito. Abaixo do tique (30s) o gatilho não
	// teria como cumprir o combinado — "a cada 5s" viraria "a cada 30s" em
	// silêncio, e promessa que o código não cumpre é pior que recusa. O minuto
	// dá folga de sobra sobre o tique.
	minEvery = time.Minute

	// tickInterval é o passo do Runner. Trinta segundos significa que um gatilho
	// pode sair até meio minuto atrasado, o que é irrelevante para algo marcado
	// em minutos ou horas, e evita acordar o processo à toa.
	tickInterval = 30 * time.Second
)

// Trigger é um gatilho da agenda.
//
// Every e At são exclusivos: um é intervalo ("a cada 2h"), o outro é hora do dia
// ("todo dia às 08:30"). Aceitar os dois juntos obrigaria a inventar uma
// combinação ("a cada 2h, mas só depois das 08:30"?) que ninguém pediu e que
// cada leitor entenderia de um jeito.
type Trigger struct {
	ID      string    `json:"id"`
	Session string    `json:"session"`
	Prompt  string    `json:"prompt"`
	Every   string    `json:"every"`
	At      string    `json:"at"`
	Enabled bool      `json:"enabled"`
	NextRun time.Time `json:"nextRun"`
	LastRun time.Time `json:"lastRun"`
	// Runs conta DISPAROS AGENDADOS, não sucessos: ele sobe dentro da mesma
	// trava que adia o gatilho, e é o adiamento que impede o disparo duplo.
	// Contar só o que deu certo exigiria voltar na agenda depois de executar —
	// exatamente a janela que Due existe para fechar.
	Runs int    `json:"runs"`
	Note string `json:"note"`
}

// Schedule descreve o gatilho em uma linha, para relatório e log.
func (t Trigger) Schedule() string {
	switch {
	case t.Every != "":
		return "a cada " + t.Every
	case t.At != "":
		return "todo dia às " + t.At
	default:
		return "sem horário"
	}
}

type fileContent struct {
	Version  int       `json:"version"`
	Triggers []Trigger `json:"triggers"`
}

// Store é o dono do arquivo da agenda.
//
// A lista é slice e não mapa: a ordem de inclusão é a ordem que a pessoa vê na
// tela e a que sai em List. Mapa daria ordem sorteada a cada execução, e uma
// lista que se embaralha sozinha parece defeito.
type Store struct {
	mu       sync.Mutex
	path     string
	triggers []Trigger
	// counter desempata ids gerados no mesmo segundo.
	counter uint64
}

// Open carrega a agenda, criando uma vazia se ainda não existir.
//
// Gatilho torto no arquivo é PULADO em vez de derrubar a abertura: um byte
// errado numa linha não pode custar o acesso a toda a agenda — nem, pior,
// impedir o gateway de subir.
func Open(path string) (*Store, error) {
	if strings.TrimSpace(path) == "" {
		return nil, errors.New("caminho da agenda vazio")
	}
	store := &Store{path: path}

	raw, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			return nil, fmt.Errorf("ler agenda: %w", err)
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return nil, fmt.Errorf("criar diretório da agenda: %w", err)
		}
		// Grava o arquivo vazio já na abertura para que erro de permissão
		// apareça aqui, e não daqui a três horas quando o primeiro gatilho for
		// criado. Sem concorrência ainda: ninguém mais tem o ponteiro.
		if err := store.persist(); err != nil {
			return nil, err
		}
		return store, nil
	}

	if strings.TrimSpace(string(raw)) == "" {
		// Arquivo de zero byte é o que sobra de uma queda entre criar e gravar.
		// Vale como agenda vazia; tratar como erro travaria o produto por nada.
		return store, nil
	}

	var content fileContent
	if err := json.Unmarshal(raw, &content); err != nil {
		return nil, fmt.Errorf("ler agenda %s: %w", filepath.Base(path), err)
	}

	now := time.Now()
	seen := make(map[string]bool, len(content.Triggers))
	for _, trigger := range content.Triggers {
		trigger = trim(trigger)
		if trigger.ID == "" || trigger.Session == "" || trigger.Prompt == "" || seen[trigger.ID] {
			continue
		}
		if err := validate(trigger); err != nil {
			continue
		}
		if trigger.NextRun.IsZero() {
			// Arquivo editado à mão costuma vir sem nextRun. Calcular aqui é o
			// que faz o gatilho existir de verdade; sem isso ele ficaria na
			// lista para sempre sem nunca disparar.
			next, err := nextRun(trigger, time.Time{}, now)
			if err != nil {
				continue
			}
			trigger.NextRun = next
		}
		seen[trigger.ID] = true
		store.triggers = append(store.triggers, trigger)
	}
	return store, nil
}

// Path devolve o arquivo em uso.
func (s *Store) Path() string { return s.path }

// Add grava um gatilho novo e devolve como ele ficou.
//
// NextRun, LastRun e Runs NÃO são aceitos do chamador: são histórico e agenda,
// não pedido. Quem cria um gatilho diz o quando e o quê; o resto é consequência.
func (s *Store) Add(t Trigger) (Trigger, error) {
	trigger := trim(t)
	if trigger.Session == "" {
		return Trigger{}, errors.New("o gatilho precisa da sessão onde o prompt vai rodar")
	}
	if trigger.Prompt == "" {
		return Trigger{}, errors.New("o gatilho precisa do prompt que vai ser disparado")
	}
	if err := validate(trigger); err != nil {
		return Trigger{}, err
	}
	// Enabled é forçado: gatilho que nasce desligado é gatilho que não existe, e
	// quem chama Add está pedindo para agendar. Pausar é editar o arquivo (o
	// campo é preservado na leitura) ou remover.
	trigger.Enabled = true
	trigger.Runs = 0
	trigger.LastRun = time.Time{}

	s.mu.Lock()
	defer s.mu.Unlock()

	if len(s.triggers) >= maxTriggers {
		return Trigger{}, fmt.Errorf("a agenda já tem %d gatilhos, que é o limite", maxTriggers)
	}
	now := time.Now()
	if trigger.ID == "" {
		trigger.ID = s.nextID(now)
	} else if s.indexOf(trigger.ID) >= 0 {
		// Sobrescrever calado transformaria id repetido por engano em automação
		// perdida — e ninguém iria procurar o gatilho que sumiu.
		return Trigger{}, fmt.Errorf("já existe um gatilho %s", trigger.ID)
	}
	next, err := nextRun(trigger, time.Time{}, now)
	if err != nil {
		return Trigger{}, err
	}
	trigger.NextRun = next

	s.triggers = append(s.triggers, trigger)
	if err := s.persist(); err != nil {
		// O que está em RAM não pode ficar à frente do disco: na próxima
		// abertura o gatilho sumiria e a pessoa juraria ter agendado.
		s.triggers = s.triggers[:len(s.triggers)-1]
		return Trigger{}, err
	}
	return trigger, nil
}

// Remove apaga o gatilho.
func (s *Store) Remove(id string) error {
	clean := strings.TrimSpace(id)

	s.mu.Lock()
	defer s.mu.Unlock()

	index := s.indexOf(clean)
	if index < 0 {
		return fmt.Errorf("%w: %s", ErrNotFound, clean)
	}
	// Cópia da lista inteira antes de mexer: se a gravação falhar, o estado em
	// RAM volta ao que está no disco sem remendo de índice.
	previous := append([]Trigger(nil), s.triggers...)
	s.triggers = append(s.triggers[:index], s.triggers[index+1:]...)
	if err := s.persist(); err != nil {
		s.triggers = previous
		return err
	}
	return nil
}

// List devolve os gatilhos na ordem em que foram criados.
func (s *Store) List() []Trigger {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Cópia: quem recebe a lista não pode editar o que está guardado só por
	// mexer no que leu.
	out := make([]Trigger, len(s.triggers))
	copy(out, s.triggers)
	return out
}

// Due devolve os gatilhos vencidos em `now` e JÁ OS ADIA — tudo dentro da mesma
// trava.
//
// A ordem importa e é o ponto deste método. Disparar primeiro e adiar depois
// deixa uma janela em que o gatilho continua vencido: basta o tique atrasar
// (máquina ocupada, disco lento) ou alguém chamar Due de outro lugar para o
// mesmo gatilho sair duas vezes — e "duas vezes" aqui significa o prompt
// rodando duas vezes na sessão da pessoa, cobrando dois turnos de modelo.
//
// Por isso o adiamento acontece ANTES do return, com a trava segurada: quem
// recebeu o gatilho recebeu também a garantia de que ninguém mais vai recebê-lo
// nesta janela.
func (s *Store) Due(now time.Time) []Trigger {
	s.mu.Lock()
	defer s.mu.Unlock()

	due := make([]Trigger, 0, 2)
	changed := false
	for index := range s.triggers {
		trigger := &s.triggers[index]
		if !trigger.Enabled || trigger.NextRun.IsZero() || trigger.NextRun.After(now) {
			continue
		}
		next, err := nextRun(*trigger, trigger.NextRun, now)
		if err != nil {
			// Não dá para adiar o que não dá para calcular (arquivo editado à
			// mão com intervalo inválido, por exemplo). Disparar assim mesmo
			// deixaria o gatilho vencido para sempre, saindo a cada tique — o
			// laço infinito que este método existe para evitar. Desligar é a
			// única parada segura.
			trigger.Enabled = false
			trigger.NextRun = time.Time{}
			changed = true
			continue
		}
		trigger.LastRun = now
		trigger.Runs++
		trigger.NextRun = next
		changed = true
		due = append(due, *trigger)
	}

	if changed {
		// A falha de gravação é engolida DE PROPÓSITO, e é o único lugar do
		// pacote onde a RAM fica à frente do disco. Desfazer o adiamento faria o
		// gatilho sair de novo daqui a trinta segundos, e de novo, enquanto o
		// disco estivesse ruim; mantendo o adiamento, o pior caso é uma repetição
		// depois de reiniciar o gateway. Repetir uma vez é melhor que repetir
		// para sempre.
		_ = s.persist()
	}
	return due
}

/* -------------------------------- horário -------------------------------- */

// validate confere o par Every/At. Os erros não embrulham causa (%w) quando não
// há causa embaixo: é validação de dado, e a mensagem É o que a pessoa lê.
func validate(t Trigger) error {
	hasEvery := strings.TrimSpace(t.Every) != ""
	hasAt := strings.TrimSpace(t.At) != ""
	switch {
	case hasEvery && hasAt:
		return errors.New(`informe "every" ou "at", não os dois — intervalo e hora do dia são agendas diferentes`)
	case !hasEvery && !hasAt:
		return errors.New(`informe "every" (ex.: "15m", "2h") ou "at" (ex.: "08:30")`)
	case hasEvery:
		_, err := parseEvery(t.Every)
		return err
	default:
		_, _, err := parseAt(t.At)
		return err
	}
}

func parseEvery(value string) (time.Duration, error) {
	every, err := time.ParseDuration(strings.TrimSpace(value))
	if err != nil {
		return 0, fmt.Errorf(`intervalo inválido em "every" (use "15m", "2h", "24h"): %w`, err)
	}
	if every < minEvery {
		return 0, fmt.Errorf("o intervalo mínimo é %s — abaixo disso o agendador não conseguiria cumprir o combinado", minEvery)
	}
	return every, nil
}

// parseAt lê "HH:MM" em 24 horas.
func parseAt(value string) (int, int, error) {
	parsed, err := time.Parse("15:04", strings.TrimSpace(value))
	if err != nil {
		// A causa não é embrulhada aqui porque o erro do time.Parse fala de
		// layout de referência ("15:04"), vocabulário que não ajuda quem
		// escreveu o horário errado.
		return 0, 0, fmt.Errorf(`horário inválido em "at": %q — use HH:MM em 24 horas, como "08:30"`, value)
	}
	return parsed.Hour(), parsed.Minute(), nil
}

// nextRun calcula o próximo disparo DEPOIS de `now`.
//
// `anchor` é o horário programado anterior e existe para preservar a FASE do
// gatilho: "a cada 2h" marcado às 09:00 continua caindo em horas pares mesmo
// depois de o computador ficar desligado uma tarde. Com `now + intervalo` a fase
// escorregaria um pouco a cada reinício até o gatilho cair em qualquer hora.
//
// A regra que manda no caso da máquina desligada: um gatilho que perdeu N
// janelas NÃO dispara N vezes. O salto é direto para a primeira ocorrência
// futura, porque uma rajada de dez execuções ao ligar o computador é pior que a
// execução perdida — a rajada gasta dez turnos de modelo e escreve dez vezes na
// conversa, e ninguém pediu isso.
func nextRun(t Trigger, anchor, now time.Time) (time.Time, error) {
	switch {
	case strings.TrimSpace(t.Every) != "":
		every, err := parseEvery(t.Every)
		if err != nil {
			return time.Time{}, err
		}
		if anchor.IsZero() {
			anchor = now
		}
		next := anchor.Add(every)
		if !next.After(now) {
			// Aritmética em vez de laço: com intervalo de um minuto e a máquina
			// desligada por um mês, somar de um em um seriam quarenta mil voltas
			// para chegar ao mesmo lugar.
			missed := now.Sub(next) / every
			next = next.Add(every * (missed + 1))
		}
		if !next.After(now) {
			// Rede de segurança para âncora absurda vinda de arquivo editado à
			// mão (ano 1, ano 3000): a subtração satura em time.Duration e a
			// conta acima pode devolver passado. Melhor perder a fase que
			// devolver um gatilho vencido de nascença.
			next = now.Add(every)
		}
		return next, nil

	case strings.TrimSpace(t.At) != "":
		hour, minute, err := parseAt(t.At)
		if err != nil {
			return time.Time{}, err
		}
		// Hora LOCAL de propósito: quem escreve "08:30" quer 08:30 na mesa dele,
		// não 08:30 em UTC. Guardar em UTC daria o horário certo só para quem
		// mora em Greenwich, e o gatilho mudaria de hora sozinho na virada do
		// horário de verão de quem viaja com o notebook.
		//
		// time.Date normaliza horário local inexistente ou repetido (a hora que
		// some ou volta na virada), então a virada não trava o agendador — no
		// máximo desloca um disparo em um dia do ano.
		next := time.Date(now.Year(), now.Month(), now.Day(), hour, minute, 0, 0, now.Location())
		if !next.After(now) {
			next = next.AddDate(0, 0, 1)
		}
		return next, nil
	}
	return time.Time{}, errors.New(`gatilho sem "every" e sem "at"`)
}

/* -------------------------------- runner --------------------------------- */

// Runner é quem olha o relógio. Ele não sabe o que é um prompt: recebe `fire` e
// chama. Assim o pacote não depende do supervisor (que dependeria de volta) e o
// teste dispara sem subir modelo nenhum.
type Runner struct {
	store *Store
	fire  func(ctx context.Context, sessionID, prompt string) error
	log   *slog.Logger
	// tick é campo e não constante para o teste não precisar esperar meio minuto.
	tick time.Duration
}

// NewRunner liga a agenda ao disparo.
func NewRunner(store *Store, fire func(ctx context.Context, sessionID, prompt string) error, log *slog.Logger) *Runner {
	if log == nil {
		log = slog.Default()
	}
	return &Runner{store: store, fire: fire, log: log, tick: tickInterval}
}

// Start sobe a goroutine do relógio e volta na hora. Chame uma vez; ela morre no
// ctx.Done().
//
// Sem agenda ou sem `fire` o Runner não sobe: uma goroutine que acorda a cada
// trinta segundos para não fazer nada é só consumo de bateria.
func (r *Runner) Start(ctx context.Context) {
	if r == nil || r.store == nil || r.fire == nil {
		return
	}
	go r.loop(ctx)
}

func (r *Runner) loop(ctx context.Context) {
	ticker := time.NewTicker(r.tick)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			r.step(ctx, now)
		}
	}
}

// step dispara os gatilhos vencidos, EM SÉRIE.
//
// Uma goroutine por gatilho pareceria mais rápido e seria pior: dois prompts
// entrando ao mesmo tempo na mesma sessão embaralham o histórico, e o supervisor
// cancela o turno anterior quando chega outro — o segundo gatilho mataria o
// primeiro. Em série, cada um espera a vez.
func (r *Runner) step(ctx context.Context, now time.Time) {
	for _, trigger := range r.store.Due(now) {
		if err := r.fire(ctx, trigger.Session, trigger.Prompt); err != nil {
			// Falha não desliga o gatilho nem tenta de novo agora: ele já foi
			// adiado para a próxima janela. Repetir na hora é justamente a
			// rajada que o adiamento evita.
			r.log.Warn("gatilho falhou", "id", trigger.ID, "sessao", trigger.Session, "erro", err)
			continue
		}
		r.log.Info("gatilho disparado", "id", trigger.ID, "sessao", trigger.Session,
			"disparos", trigger.Runs, "proximo", trigger.NextRun.Format(time.RFC3339))
	}
}

/* -------------------------------- interno -------------------------------- */

// trim apara o que veio de fora. Vale para o arquivo e para o chamador — os dois
// mentem do mesmo jeito, e id com espaço na ponta nunca casa com o que a pessoa
// digita depois para remover.
func trim(t Trigger) Trigger {
	t.ID = strings.TrimSpace(t.ID)
	t.Session = strings.TrimSpace(t.Session)
	t.Prompt = strings.TrimSpace(t.Prompt)
	t.Every = strings.TrimSpace(t.Every)
	t.At = strings.TrimSpace(t.At)
	t.Note = strings.TrimSpace(t.Note)
	return t
}

// indexOf assume a trava segurada. Busca linear porque são no máximo 64 itens, e
// um índice em mapa aqui seria estado duplicado para manter em sincronia.
func (s *Store) indexOf(id string) int {
	for index := range s.triggers {
		if s.triggers[index].ID == id {
			return index
		}
	}
	return -1
}

// nextID gera id legível a olho nu — hora mais contador. Legível importa porque
// esse id aparece no log, na recusa e no `schedule.remove` que a pessoa (ou o
// modelo) digita depois; um UUID não diz quando o gatilho nasceu.
func (s *Store) nextID(now time.Time) string {
	for {
		s.counter++
		id := fmt.Sprintf("trg-%s-%04d", now.Format("20060102T150405"), s.counter)
		if s.indexOf(id) < 0 {
			return id
		}
	}
}

// persist grava o arquivo inteiro por temporário + rename. Assume a trava.
//
// Escrever por cima do original deixa a agenda truncada se o processo morrer no
// meio, e agenda truncada é automação que some sem avisar. O rename é a única
// operação que o sistema de arquivos promete atômica, então é ele quem publica.
func (s *Store) persist() error {
	// Indentado porque este arquivo é feito para a pessoa abrir no editor e ver
	// o que está agendado em nome dela.
	raw, err := json.MarshalIndent(fileContent{Version: fileVersion, Triggers: s.triggers}, "", "  ")
	if err != nil {
		return fmt.Errorf("serializar agenda: %w", err)
	}
	raw = append(raw, '\n')

	temporary := s.path + ".tmp"
	// 0600: o prompt agendado conta o que a pessoa está fazendo, e o campo
	// sessão diz onde. Outro usuário da máquina não tem nada que ler isso.
	file, err := os.OpenFile(temporary, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("gravar agenda: %w", err)
	}
	if _, err := file.Write(raw); err != nil {
		_ = file.Close()
		_ = os.Remove(temporary)
		return fmt.Errorf("gravar agenda: %w", err)
	}
	// Sync antes do rename: sem ele o rename pode chegar ao disco antes do
	// conteúdo, e a queda no meio publica um arquivo vazio.
	if err := file.Sync(); err != nil {
		_ = file.Close()
		_ = os.Remove(temporary)
		return fmt.Errorf("sincronizar agenda: %w", err)
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(temporary)
		return fmt.Errorf("fechar agenda: %w", err)
	}
	// No Windows os.Rename usa MoveFileEx com REPLACE_EXISTING, então substituir
	// arquivo existente funciona igual ao Unix.
	if err := os.Rename(temporary, s.path); err != nil {
		_ = os.Remove(temporary)
		return fmt.Errorf("publicar agenda: %w", err)
	}
	return nil
}
