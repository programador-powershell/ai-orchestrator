// Ferramentas que falam com o PROVEDOR: imagem e fine-tuning.
//
// Elas eram "de host" porque no app anterior a chave do provedor morava no
// Credential Manager e quem chamava a API era o Rust. No AI-BOT a chave já está
// no cofre do gateway e o roteador de modelos já sabe usá-la sem revelá-la — o
// que sobrava para o host era só o cliente HTTP, e cliente HTTP a padrão do Go
// tem.
//
// As três usam o MESMO roteador do turno de conversa (Toolbox.Models). Abrir um
// cliente próprio aqui criaria uma segunda superfície de credencial: dois
// lugares para acertar o cabeçalho, dois para vazar em log, dois para revisar
// quando a política mudar.
package supervisor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"aibot/gateway/internal/modelrouter"
)

// imageDir é onde a imagem gerada cai, dentro do projeto da sessão. Pasta
// própria e escondida: o modelo pede imagem em rajada, e espalhar PNG pela raiz
// do repositório é o tipo de sujeira que acaba num commit.
const imageDir = ".aibot/imagens"

// imageMaxCount é o teto por chamada.
const imageMaxCount = 4

// providerToolsInstall registra as três. Chamado por InstallExtraTools.
func (t *Toolbox) providerToolsInstall(registry *Registry) {
	registry.Register("image.generate",
		"gera imagem pelo provedor e grava em "+imageDir+". args: {prompt, size?, count?}", t.imageGenerate)
	registry.Register("finetune.submit",
		"envia um treino ao provedor. args: {model, trainingFile, suffix?, hyperparameters?}", t.finetuneSubmit)
	registry.Register("finetune.status",
		"estado dos treinos no provedor. args: {jobId?}", t.finetuneStatus)
}

/* --------------------------------- imagem --------------------------------- */

func (t *Toolbox) imageGenerate(ctx context.Context, sessionID string, raw json.RawMessage) (string, error) {
	if t.Models == nil {
		return "", errors.New("o roteador de modelos não está disponível")
	}
	var args struct {
		Prompt string `json:"prompt"`
		Size   string `json:"size"`
		Count  int    `json:"count"`
	}
	if err := decodeArgs(raw, &args); err != nil {
		return "", err
	}
	if strings.TrimSpace(args.Prompt) == "" {
		return "", errors.New("descreva a imagem em \"prompt\"")
	}
	count := args.Count
	if count <= 0 {
		count = 1
	}
	if count > imageMaxCount {
		// Recusa em vez de cortar em silêncio: se o modelo pediu 8 e recebesse
		// 4 sem aviso, ele trataria as 4 como a resposta completa do pedido.
		return "", fmt.Errorf("peça no máximo %d imagens por chamada", imageMaxCount)
	}
	// A pasta de destino é o confinamento; sem raiz de projeto não há onde
	// gravar, e devolver base64 no lugar comeria o contexto inteiro do turno.
	root := t.root(sessionID)
	if root == "" {
		return "", errNoRoot
	}

	result, err := t.Models.GenerateImage(ctx, modelrouter.ImageRequest{
		Prompt: args.Prompt,
		Size:   args.Size,
		Count:  count,
	})
	if err != nil {
		return "", err
	}

	// As linhas são montadas antes do cabeçalho para que a contagem seja a das
	// imagens GRAVADAS. Anunciar "4 imagens" e listar 2 arquivos faria o modelo
	// citar caminho que não existe.
	var lines []string
	saved := 0
	for index, image := range result.Images {
		content := image.Bytes
		if len(content) == 0 && image.URL != "" {
			// Link ESCOLHIDO PELO PROVEDOR é URL de terceiro: baixar passa pelo
			// guarda de rede, que é quem fecha SSRF e rebinding. Sem guarda, o
			// link é reportado e não baixado — inventar o arquivo seria pior.
			if t.Net == nil {
				lines = append(lines, fmt.Sprintf(
					"- imagem %d ficou só como link (a saída de rede não está disponível): %s",
					index+1, image.URL))
				continue
			}
			response, body, err := t.Net.Fetch(ctx, image.URL, nil)
			if err != nil || response.StatusCode < 200 || response.StatusCode > 299 {
				lines = append(lines, fmt.Sprintf(
					"- imagem %d não pôde ser baixada do link do provedor: %s", index+1, image.URL))
				continue
			}
			content = body
			if image.Mime == "" {
				image.Mime = response.Header.Get("Content-Type")
			}
		}
		if len(content) == 0 {
			lines = append(lines, fmt.Sprintf("- imagem %d veio vazia", index+1))
			continue
		}

		relative, err := t.saveImage(root, content, image.Mime)
		if err != nil {
			return "", err
		}
		saved++
		lines = append(lines, fmt.Sprintf("- %s (%d KB)", relative, (len(content)+1023)/1024))
	}
	if saved == 0 {
		return "", errors.New("nenhuma imagem pôde ser gravada")
	}

	var report strings.Builder
	fmt.Fprintf(&report, "%d imagem(ns) de %s gravada(s):\n", saved, result.Model)
	report.WriteString(strings.Join(lines, "\n"))
	report.WriteString("\nAs imagens ficaram no disco de propósito: base64 dentro da conversa " +
		"consome o contexto inteiro e ainda assim o modelo não vê o que desenhou. " +
		"Use o caminho acima para mostrá-las ou movê-las.")
	return report.String(), nil
}

// saveImage grava um arquivo dentro da pasta do projeto e devolve o caminho
// relativo (o absoluto revelaria a estrutura do disco de quem está usando).
func (t *Toolbox) saveImage(root string, content []byte, mime string) (string, error) {
	stamp := time.Now().UTC().Format("20060102-150405")
	extension := extensionFor(mime)

	for attempt := 0; attempt < 1000; attempt++ {
		name := fmt.Sprintf("imagem-%s-%d%s", stamp, attempt+1, extension)
		relative := imageDir + "/" + name
		path, err := resolveInside(root, relative)
		if err != nil {
			return "", err
		}
		if _, err := os.Lstat(path); err == nil {
			continue // já existe: outra imagem do mesmo segundo
		} else if !os.IsNotExist(err) {
			return "", fmt.Errorf("verificar %s: %w", relative, err)
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return "", fmt.Errorf("criar %s: %w", imageDir, err)
		}
		if err := os.WriteFile(path, content, 0o644); err != nil {
			return "", fmt.Errorf("gravar %s: %w", relative, err)
		}
		return relative, nil
	}
	return "", errors.New("não foi possível achar um nome livre em " + imageDir)
}

// extensionFor traduz o tipo em extensão. O padrão é .png porque é o que os
// provedores devolvem quando não dizem nada — e um arquivo sem extensão
// nenhuma o sistema não sabe abrir.
func extensionFor(mime string) string {
	base, _, _ := strings.Cut(strings.ToLower(strings.TrimSpace(mime)), ";")
	switch strings.TrimSpace(base) {
	case "image/jpeg", "image/jpg":
		return ".jpg"
	case "image/webp":
		return ".webp"
	case "image/gif":
		return ".gif"
	case "image/avif":
		return ".avif"
	default:
		return ".png"
	}
}

/* ------------------------------- fine-tuning ------------------------------ */

func (t *Toolbox) finetuneSubmit(ctx context.Context, _ string, raw json.RawMessage) (string, error) {
	provider, err := t.finetuneProvider()
	if err != nil {
		return "", err
	}
	var args struct {
		Model           string          `json:"model"`
		TrainingFile    string          `json:"trainingFile"`
		Suffix          string          `json:"suffix"`
		Hyperparameters json.RawMessage `json:"hyperparameters"`
	}
	if err := decodeArgs(raw, &args); err != nil {
		return "", err
	}
	if strings.TrimSpace(args.Model) == "" {
		return "", errors.New("informe o modelo base a treinar em \"model\"")
	}
	trainingFile := strings.TrimSpace(args.TrainingFile)
	if trainingFile == "" {
		return "", errors.New("informe em \"trainingFile\" o id do arquivo já enviado ao provedor")
	}
	if looksLikePath(trainingFile) {
		// O upload é um passo SEPARADO e ainda não existe aqui de propósito:
		// mandar arquivo do disco da pessoa para um terceiro a partir de um
		// prompt é uma decisão que precisa de aprovação própria, e ela não foi
		// dada. Recusa com o caminho de saída, não silêncio.
		return "", fmt.Errorf("%q parece um caminho local — \"trainingFile\" é o id de um arquivo "+
			"JÁ enviado ao provedor (ex.: file-abc123); envie o arquivo pelo painel do provedor "+
			"e passe o id que ele devolver", trainingFile)
	}

	body := map[string]any{"model": args.Model, "training_file": trainingFile}
	if suffix := strings.TrimSpace(args.Suffix); suffix != "" {
		body["suffix"] = suffix
	}
	if len(args.Hyperparameters) > 0 && string(args.Hyperparameters) != "null" {
		// Repassado como veio: a lista de hiperparâmetros muda a cada versão da
		// API, e uma tradução aqui viraria filtro que descarta o parâmetro novo.
		body["hyperparameters"] = args.Hyperparameters
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return "", fmt.Errorf("montar pedido: %w", err)
	}

	status, response, err := t.Models.ProviderFetch(ctx, provider.ID,
		http.MethodPost, "/fine_tuning/jobs", payload)
	if err != nil {
		return "", err
	}
	if status < 200 || status > 299 {
		return "", fmt.Errorf("%s recusou o treino (%d): %s",
			provider.ID, status, providerMessage(response))
	}

	var job finetuneJob
	if err := json.Unmarshal(response, &job); err != nil {
		return "", fmt.Errorf("resposta inesperada de %s: %w", provider.ID, err)
	}
	return "treino enviado a " + provider.ID + "\n" + job.describe(), nil
}

func (t *Toolbox) finetuneStatus(ctx context.Context, _ string, raw json.RawMessage) (string, error) {
	provider, err := t.finetuneProvider()
	if err != nil {
		return "", err
	}
	var args struct {
		JobID string `json:"jobId"`
	}
	if err := decodeArgs(raw, &args); err != nil {
		return "", err
	}
	jobID := strings.TrimSpace(args.JobID)

	path := "/fine_tuning/jobs?limit=20"
	if jobID != "" {
		if strings.ContainsAny(jobID, "/?#& \t") {
			// O id entra no CAMINHO da URL; um "../" ou um "?" ali muda a rota
			// chamada, e a rota decide o que a chave autoriza.
			return "", fmt.Errorf("id de treino inválido: %q", jobID)
		}
		path = "/fine_tuning/jobs/" + url.PathEscape(jobID)
	}

	status, response, err := t.Models.ProviderFetch(ctx, provider.ID, http.MethodGet, path, nil)
	if err != nil {
		return "", err
	}
	if status < 200 || status > 299 {
		return "", fmt.Errorf("%s respondeu %d: %s", provider.ID, status, providerMessage(response))
	}

	if jobID != "" {
		var job finetuneJob
		if err := json.Unmarshal(response, &job); err != nil {
			return "", fmt.Errorf("resposta inesperada de %s: %w", provider.ID, err)
		}
		return job.describe(), nil
	}

	var listing struct {
		Data []finetuneJob `json:"data"`
	}
	if err := json.Unmarshal(response, &listing); err != nil {
		return "", fmt.Errorf("resposta inesperada de %s: %w", provider.ID, err)
	}
	if len(listing.Data) == 0 {
		return "nenhum treino registrado em " + provider.ID, nil
	}
	var report strings.Builder
	fmt.Fprintf(&report, "%d treino(s) em %s:\n", len(listing.Data), provider.ID)
	for _, job := range listing.Data {
		report.WriteString(job.describe())
		report.WriteString("\n")
	}
	return strings.TrimRight(report.String(), "\n"), nil
}

// finetuneProvider acha quem recebe o treino e recusa com endereço quando não
// há ninguém.
func (t *Toolbox) finetuneProvider() (modelrouter.Provider, error) {
	if t.Models == nil {
		return modelrouter.Provider{}, errors.New("o roteador de modelos não está disponível")
	}
	provider, err := t.Models.ProviderFor(modelrouter.CapabilityFinetune)
	if err != nil {
		return modelrouter.Provider{}, err
	}
	switch provider.Kind {
	case modelrouter.KindOpenAI, modelrouter.KindCompatible:
		return provider, nil
	default:
		// /fine_tuning/jobs é rota do dialeto da OpenAI. Chamar isso num
		// provedor de outro dialeto daria 404, que parece "treino não existe".
		return modelrouter.Provider{}, fmt.Errorf(
			"o provedor %s fala %s e esta ferramenta só sabe o fine-tuning no dialeto da OpenAI",
			provider.ID, provider.Kind)
	}
}

// finetuneJob é o job como a API devolve, no que interessa para a pessoa ler.
type finetuneJob struct {
	ID             string `json:"id"`
	Model          string `json:"model"`
	Status         string `json:"status"`
	CreatedAt      int64  `json:"created_at"`
	FineTunedModel string `json:"fine_tuned_model"`
	TrainingFile   string `json:"training_file"`
	Error          *struct {
		Message string `json:"message"`
	} `json:"error"`
}

func (j finetuneJob) describe() string {
	var line strings.Builder
	fmt.Fprintf(&line, "- %s", orDefault(j.ID, "(sem id)"))
	if j.Model != "" {
		fmt.Fprintf(&line, " — base %s", j.Model)
	}
	fmt.Fprintf(&line, " — estado %s", orDefault(j.Status, "desconhecido"))
	if j.CreatedAt > 0 {
		fmt.Fprintf(&line, " — criado em %s",
			time.Unix(j.CreatedAt, 0).UTC().Format("2006-01-02 15:04 UTC"))
	}
	if j.FineTunedModel != "" {
		// O id do modelo resultante é a única coisa acionável do relatório: é
		// ele que se põe no catalog.json para usar o que foi treinado.
		fmt.Fprintf(&line, " — modelo resultante %s", j.FineTunedModel)
	}
	if j.Error != nil && strings.TrimSpace(j.Error.Message) != "" {
		// Passa pelo mesmo filtro do corpo de erro: um treino que falhou por
		// credencial volta com HTTP 200 e a chave PARCIAL dentro do JSON do
		// job — o status 2xx não torna o conteúdo confiável.
		fmt.Fprintf(&line, " — erro: %s", redactProviderEcho(strings.TrimSpace(j.Error.Message)))
	}
	return line.String()
}

// looksLikePath separa id de arquivo de caminho de disco. Heurística, e ela
// erra para o lado seguro: um id que pareça caminho é recusado com explicação,
// enquanto um caminho aceito por engano viraria pedido de upload silencioso.
func looksLikePath(value string) bool {
	if strings.ContainsAny(value, `/\`) {
		return true
	}
	if strings.HasPrefix(value, ".") || strings.HasPrefix(value, "~") {
		return true
	}
	if len(value) > 1 && value[1] == ':' {
		return true // C:algo — caminho do Windows sem barra
	}
	switch strings.ToLower(filepath.Ext(value)) {
	case ".jsonl", ".json", ".csv", ".txt", ".parquet", ".zip", ".gz":
		return true
	}
	return false
}

// providerMessage tira a mensagem do erro do provedor e a limpa antes de
// mostrá-la.
func providerMessage(payload []byte) string {
	text := strings.TrimSpace(string(payload))

	var parsed struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(payload, &parsed); err == nil &&
		strings.TrimSpace(parsed.Error.Message) != "" {
		text = strings.TrimSpace(parsed.Error.Message)
	}
	return truncate(redactProviderEcho(text), 400)
}

// redactProviderEcho tira do texto do provedor qualquer coisa com cara de
// segredo, reusando os detectores de secrets.scan.
//
// Não é estética: a OpenAI devolve a chave PARCIAL na mensagem de erro
// ("Incorrect API key provided: sk-ab***"), e repetir isso levaria um pedaço do
// segredo para o histórico da conversa e para o log do gateway. Vale para
// QUALQUER texto vindo de fora, inclusive o que chega com status 200 — foi por
// aí que o eco passou na primeira versão deste arquivo.
func redactProviderEcho(text string) string {
	for _, candidate := range secretPatterns {
		text = candidate.pattern.ReplaceAllString(text, "«oculto»")
	}
	return text
}
