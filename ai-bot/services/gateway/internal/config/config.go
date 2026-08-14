// Package config lê a configuração do processo do AMBIENTE.
//
// Não há arquivo de configuração por decisão, não por preguiça. O caso normal
// deste binário é ser sidecar: o Rust o executa com um bloco de variáveis e
// espera a porta abrir. Um arquivo seria uma SEGUNDA fonte da verdade — editável
// com o app no ar, versionável por engano, e capaz de discordar do que o Rust
// acabou de passar. Ambiente é o canal que o pai já controla.
//
// A segunda decisão é que os padrões precisam ser suficientes: numa estação
// Windows sem nenhuma variável definida, Load() tem de devolver uma configuração
// que sobe. O que não pode ter padrão — token e chave mestra — é MATERIALIZADO
// no primeiro boot e lido do disco nos seguintes; regerar invalidaria todo
// segredo já selado, então arquivo existente é lido, nunca sobrescrito.
//
// Nada aqui sai da biblioteca padrão: é leitura de ambiente, base64 e escrita de
// arquivo, tudo em `os`, `crypto/rand` e `encoding/base64`.
package config

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Nomes das variáveis de ambiente. Exportados porque o instalador e o lado Rust
// precisam escrever exatamente estas chaves, e string solta nos dois lados é
// como se erra o nome de uma delas por um underscore.
const (
	EnvBind         = "AIBOT_BIND"
	EnvDataDir      = "AIBOT_DATA_DIR"
	EnvToken        = "AIBOT_TOKEN"
	EnvMasterKey    = "AIBOT_MASTER_KEY"
	EnvAllowOrigins = "AIBOT_ALLOW_ORIGINS"
	EnvLog          = "AIBOT_LOG"
	EnvManaged      = "AIBOT_MANAGED"
	EnvPolicyURL    = "AIBOT_POLICY_URL"
	EnvWorktreeRoot = "AIBOT_WORKTREE_ROOT"
)

const (
	// DefaultBind é loopback de propósito. Ver o comentário do campo Bind.
	DefaultBind = "127.0.0.1:8799"

	// DefaultLogLevel é "info": debug numa estação de usuário enche disco com
	// conteúdo de conversa, que é o dado mais sensível que este processo toca.
	DefaultLogLevel = "info"

	// MasterKeySize é fixo: internal/secrets sela com AES-256-GCM, e AES-256 não
	// negocia o tamanho da chave. Chave de 31 bytes não é "quase" — é erro.
	MasterKeySize = 32

	// tokenSize em bytes antes do base64. 32 bytes aleatórios são 256 bits de
	// entropia, muito além do que um atacante local consegue adivinhar.
	tokenSize = 32

	tokenFile     = "token"
	masterKeyFile = "master.key"
)

// defaultAllowOrigins cobre as três origens legítimas do app: a janela do Tauri
// em produção (os dois esquemas que ele usa, conforme a plataforma) e o Vite em
// desenvolvimento. Qualquer outra origem é navegador de terceiro falando com um
// gateway que executa comando — e isso precisa ser escolha explícita.
var defaultAllowOrigins = []string{
	"tauri://localhost",
	"http://tauri.localhost",
	// A porta do Vite é FIXA em 1421 e casada em três lugares:
	// apps/desktop/vite.config.ts (server.port com strictPort), o `devUrl` do
	// apps/desktop/src-tauri/tauri.conf.json e esta linha. Fixa porque a janela
	// do Tauri carrega uma URL literal — se o Vite escorregar para outra porta,
	// a janela abre em branco; e se esta lista discordar dela, o gateway recusa
	// a origem da PRÓPRIA janela no handshake e o app sobe sem canal ao vivo.
	// Não deixamos 1420 junto: origem a mais aqui é navegador de terceiro
	// autorizado a falar com um gateway que executa comando na máquina.
	"http://localhost:1421",
}

// logLevels é a lista fechada aceita em AIBOT_LOG.
var logLevels = []string{"debug", "info", "warn", "error"}

// Config é a configuração do processo, já resolvida e validada.
type Config struct {
	// Bind escuta em LOOPBACK por padrão. Este processo executa ferramenta na
	// máquina e guarda chave de provedor; publicar em 0.0.0.0 é decisão
	// consciente de quem opera, e por isso mora numa variável, não no default.
	Bind string

	// DataDir é a pasta única do produto: log de sessões, token, chave mestra e
	// worktrees. Atenção em domínio com perfil roaming — %APPDATA% acompanha o
	// usuário pela rede, então quem não quer segredo trafegando aponta
	// AIBOT_DATA_DIR para %LOCALAPPDATA%.
	DataDir string

	// Token é o segredo que o Rust lê de DataDir/token para autenticar. Sem ele,
	// loopback não protege nada: qualquer processo da estação — até página aberta
	// no navegador do usuário — mandaria o AI-BOT rodar comando.
	Token string

	// MasterKey sela os segredos de internal/secrets. Exatamente MasterKeySize
	// bytes; ver decodeMasterKey.
	MasterKey []byte

	// AllowOrigins é a lista de origens de navegador aceitas no handshake.
	AllowOrigins []string

	// LogLevel é um de logLevels.
	LogLevel string

	// Managed liga a edição gerenciada: sem BYOK direto e sem runtime local, o
	// que a política da empresa exige em estação corporativa.
	Managed bool

	// PolicyURL é de onde buscar a política assinada. Vazio = sem política
	// remota, que é o caso do uso pessoal do app.
	PolicyURL string

	// WorktreeRoot é onde os workers criam worktree de git. Fica dentro do
	// DataDir por padrão para o desinstalador ter um lugar só para limpar.
	WorktreeRoot string
}

// Load lê o ambiente, cria o DataDir e materializa token e chave mestra.
//
// É chamada uma vez, no início do processo. Falha aqui é falha de boot: o
// gateway sem chave mestra abriria o WebSocket e só descobriria o problema no
// primeiro segredo a selar, com a sessão do usuário já em andamento.
func Load() (Config, error) {
	fallbackDir, err := defaultDataDir()
	if err != nil {
		return Config{}, err
	}

	c := Config{
		Bind:         envOr(EnvBind, DefaultBind),
		LogLevel:     strings.ToLower(envOr(EnvLog, DefaultLogLevel)),
		Managed:      parseBool(os.Getenv(EnvManaged)),
		PolicyURL:    strings.TrimSpace(os.Getenv(EnvPolicyURL)),
		AllowOrigins: allowOrigins(),
	}

	if !validLogLevel(c.LogLevel) {
		return Config{}, fmt.Errorf("nível de log %q inválido em %s, use debug|info|warn|error", c.LogLevel, EnvLog)
	}

	// Caminho relativo é resolvido agora porque o sidecar HERDA o diretório de
	// trabalho do Rust, e esse diretório muda quando o usuário abre outro
	// projeto. Guardar relativo faria a mesma configuração apontar para pastas
	// diferentes ao longo da execução.
	c.DataDir, err = absolutePath(envOr(EnvDataDir, fallbackDir), EnvDataDir)
	if err != nil {
		return Config{}, err
	}
	if err := os.MkdirAll(c.DataDir, 0o700); err != nil {
		return Config{}, fmt.Errorf("criar diretório de dados %s: %w", c.DataDir, err)
	}

	c.WorktreeRoot, err = absolutePath(envOr(EnvWorktreeRoot, filepath.Join(c.DataDir, "worktrees")), EnvWorktreeRoot)
	if err != nil {
		return Config{}, err
	}

	c.Token = strings.TrimSpace(os.Getenv(EnvToken))
	if c.Token == "" {
		c.Token, err = materializeSecret(filepath.Join(c.DataDir, tokenFile), tokenSize)
		if err != nil {
			return Config{}, err
		}
	}

	// A chave mestra vem do ambiente OU do disco, e o texto é o mesmo base64 nos
	// dois casos — quem opera pode tirar a chave do cofre e injetar por variável
	// sem mudar formato.
	keyText := strings.TrimSpace(os.Getenv(EnvMasterKey))
	keyOrigin := EnvMasterKey
	if keyText == "" {
		keyPath := filepath.Join(c.DataDir, masterKeyFile)
		keyOrigin = keyPath
		keyText, err = materializeSecret(keyPath, MasterKeySize)
		if err != nil {
			return Config{}, err
		}
	}
	c.MasterKey, err = decodeMasterKey(keyText)
	if err != nil {
		// Chave ilegível é erro, nunca motivo para gerar outra: uma chave nova
		// transformaria todo segredo já selado em lixo silencioso.
		return Config{}, fmt.Errorf("chave mestra de %s: %w", keyOrigin, err)
	}

	return c, nil
}

// String é o resumo que vai para o log de boot. Existe principalmente para que
// um `%v` distraído numa Config NÃO despeje token e chave mestra: com este
// método, fmt nunca alcança os campos secretos.
func (c Config) String() string {
	origins := strings.Join(c.AllowOrigins, ",")
	if origins == "" {
		origins = "nenhuma"
	}
	var out strings.Builder
	fmt.Fprintf(&out, "bind=%s", c.Bind)
	fmt.Fprintf(&out, " data_dir=%s", c.DataDir)
	fmt.Fprintf(&out, " worktree_root=%s", c.WorktreeRoot)
	fmt.Fprintf(&out, " log=%s", c.LogLevel)
	fmt.Fprintf(&out, " gerenciado=%t", c.Managed)
	fmt.Fprintf(&out, " origens=%s", origins)
	fmt.Fprintf(&out, " token=%s", presence(c.Token != ""))
	fmt.Fprintf(&out, " chave_mestra=%s", presence(len(c.MasterKey) == MasterKeySize))
	// A política vira presença e não URL porque link assinado costuma carregar
	// token na query, e o log de boot vai parar em anexo de chamado.
	fmt.Fprintf(&out, " politica=%s", presence(c.PolicyURL != ""))
	return out.String()
}

// presence troca segredo por estado no resumo legível.
func presence(defined bool) string {
	if defined {
		return "definido"
	}
	return "ausente"
}

// envOr devolve a variável, ou o padrão quando ela está ausente ou em branco.
//
// O TrimSpace não é preciosismo: variável definida por .bat ou por painel do
// Windows chega com espaço ou CR no fim mais vezes do que se imagina, e
// "127.0.0.1:8799\r" não escuta em porta nenhuma.
func envOr(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

// parseBool é tolerante de propósito: quem escreve a variável é uma pessoa no
// painel do Windows ou um script de instalação, não um parser.
func parseBool(raw string) bool {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "1", "true", "yes", "y", "on", "sim":
		return true
	default:
		return false
	}
}

func validLogLevel(level string) bool {
	for _, candidate := range logLevels {
		if candidate == level {
			return true
		}
	}
	return false
}

// allowOrigins distingue variável AUSENTE de variável VAZIA.
//
// Ausente é o caso normal e recebe a lista padrão. Vazia é alguém dizendo "não
// aceite navegador nenhum" — e aí a lista fica vazia mesmo. Cair no padrão
// quando a variável foi definida em branco seria abrir origem que o operador
// acabou de mandar fechar.
func allowOrigins() []string {
	raw, defined := os.LookupEnv(EnvAllowOrigins)
	if !defined {
		// Cópia: a fatia padrão é do pacote, e quem receber a Config não pode
		// alterá-la para os próximos leitores.
		out := make([]string, len(defaultAllowOrigins))
		copy(out, defaultAllowOrigins)
		return out
	}
	origins := []string{}
	for _, part := range strings.Split(raw, ",") {
		if part = strings.TrimSpace(part); part != "" {
			origins = append(origins, part)
		}
	}
	return origins
}

// defaultDataDir escolhe a pasta do produto por plataforma.
func defaultDataDir() (string, error) {
	if runtime.GOOS == "windows" {
		// No Windows os.UserConfigDir devolve %APPDATA%.
		base, err := os.UserConfigDir()
		if err != nil {
			return "", fmt.Errorf("descobrir %%APPDATA%%: %w", err)
		}
		return filepath.Join(base, "AI-BOT"), nil
	}
	// Fora do Windows o dado do usuário é XDG_DATA_HOME, não UserConfigDir (que
	// aponta para config): o log de sessões é dado, não configuração.
	if xdg := strings.TrimSpace(os.Getenv("XDG_DATA_HOME")); xdg != "" {
		return filepath.Join(xdg, "ai-bot"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("descobrir o diretório do usuário: %w", err)
	}
	return filepath.Join(home, ".local", "share", "ai-bot"), nil
}

func absolutePath(path, envName string) (string, error) {
	if filepath.IsAbs(path) {
		return filepath.Clean(path), nil
	}
	resolved, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("resolver o caminho de %s: %w", envName, err)
	}
	return resolved, nil
}

// materializeSecret devolve o segredo em base64: lê o arquivo se ele existir,
// sorteia e grava se não existir.
//
// A ordem importa. Ler primeiro é o que garante que o token de hoje é o mesmo de
// ontem — o Rust guarda o dele, e um gateway que regera a cada boot derruba a
// janela aberta e, no caso da chave mestra, apaga o acesso a tudo que já foi
// selado.
func materializeSecret(path string, size int) (string, error) {
	existing, err := os.ReadFile(path)
	switch {
	case err == nil:
		if text := strings.TrimSpace(string(existing)); text != "" {
			return text, nil
		}
		// Arquivo vazio só acontece se um boot antigo morreu no meio da
		// gravação. Não há segredo a preservar ali: segue e gera.
	case errors.Is(err, os.ErrNotExist):
		// Primeira execução nesta estação.
	default:
		return "", fmt.Errorf("ler %s: %w", filepath.Base(path), err)
	}

	buffer := make([]byte, size)
	if _, err := rand.Read(buffer); err != nil {
		return "", fmt.Errorf("sortear %s: %w", filepath.Base(path), err)
	}
	// RawURLEncoding: sem padding e sem "+" nem "/", então o valor atravessa
	// linha de comando, header e arquivo .env sem precisar de escape.
	text := base64.RawURLEncoding.EncodeToString(buffer)
	if err := writeSecretAtomic(path, text); err != nil {
		return "", err
	}
	return text, nil
}

// writeSecretAtomic grava por temporário + rename, com 0600.
//
// O temporário evita o pior caso: queda no meio da escrita deixaria um segredo
// truncado no lugar definitivo, e um token pela metade é indistinguível de um
// token legítimo até a primeira autenticação falhar.
//
// Sobre o 0600 no Windows: o modo é praticamente ignorado ali, quem protege é a
// ACL herdada da pasta do usuário. Vale mesmo assim porque o mesmo binário roda
// em Linux, onde 0600 é a diferença entre segredo do usuário e segredo da
// máquina inteira.
//
// Concorrência não é tratada aqui: dois gateways sobre o mesmo DataDir já são
// impedidos pela trava de internal/store.
func writeSecretAtomic(path, text string) error {
	name := filepath.Base(path)
	temporary := path + ".tmp"
	file, err := os.OpenFile(temporary, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("gravar %s: %w", name, err)
	}
	if _, err := file.WriteString(text + "\n"); err != nil {
		_ = file.Close()
		_ = os.Remove(temporary)
		return fmt.Errorf("gravar %s: %w", name, err)
	}
	// Sync antes do rename: sem ele o rename pode chegar ao disco antes do
	// conteúdo, e um corte de energia deixa o arquivo definitivo vazio.
	if err := file.Sync(); err != nil {
		_ = file.Close()
		_ = os.Remove(temporary)
		return fmt.Errorf("sincronizar %s: %w", name, err)
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(temporary)
		return fmt.Errorf("fechar %s: %w", name, err)
	}
	if err := os.Rename(temporary, path); err != nil {
		_ = os.Remove(temporary)
		return fmt.Errorf("renomear %s: %w", name, err)
	}
	return nil
}

// masterKeyEncodings são os alfabetos base64 aceitos na chave mestra.
//
// O gateway gera em RawURL, mas a chave também é digitada por gente que a tirou
// de um cofre — e cofre entrega padrão (com "+", "/" e "="). Aceitar as quatro
// variantes na LEITURA custa este slice e evita um erro que, do lado de quem
// colou, parece "a chave certa foi recusada".
var masterKeyEncodings = []*base64.Encoding{
	base64.RawURLEncoding,
	base64.StdEncoding,
	base64.RawStdEncoding,
	base64.URLEncoding,
}

// decodeMasterKey exige exatamente MasterKeySize bytes.
//
// O tamanho é verificado aqui, e não em internal/secrets, porque erro de boot é
// visível e erro no primeiro selo acontece com o usuário no meio de uma sessão.
func decodeMasterKey(text string) ([]byte, error) {
	for _, encoding := range masterKeyEncodings {
		key, err := encoding.DecodeString(text)
		if err != nil {
			continue
		}
		if len(key) != MasterKeySize {
			return nil, fmt.Errorf("tem %d bytes depois do base64, precisa de exatamente %d", len(key), MasterKeySize)
		}
		return key, nil
	}
	return nil, errors.New("não é base64 válido")
}
