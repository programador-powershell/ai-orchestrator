// As rotas de administração do catálogo — provedores, modelos e o teste de
// conexão.
//
// Até aqui o catalog.json só se editava na mão, com o gateway parado. Estas
// rotas fecham o ciclo: a UI cadastra provedor e modelo, o arquivo é regravado
// ATOMICAMENTE (tmp+rename, como o cofre faz) e a mudança é aplicada a quente
// com SetProviders/SetModels — sem reiniciar o processo.
//
// A regra que não pode ser afrouxada, herdada do cofre: A CHAVE NUNCA TOCA O
// ARQUIVO. O apiKey que chega no POST/PATCH vai direto para o cofre
// (vault.Set) e o catalog.json guarda só o secretRef — o NOME da chave. A
// resposta diz se a chave foi gravada e nunca a ecoa; o GET devolve os
// provedores sem o campo, só com o booleano "tem chave".
//
// A política continua mandando: nada aqui chama SetAllowed. Um modelo
// cadastrado fora de AllowedModels entra no arquivo e continua FORA do
// catálogo utilizável — cadastrar não é liberar.
package transport

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"aibot/gateway/internal/modelrouter"
	"aibot/gateway/internal/protocol"
)

// CatalogVault é o cofre visto por estas rotas: grava, apaga e responde se
// existe. NÃO há leitura de valor — nem esta camada precisa dela, nem ela
// deve existir num handler HTTP, que é o lugar de onde segredo vaza para
// resposta e log. `*secrets.Vault` satisfaz.
type CatalogVault interface {
	Set(ref, value string) error
	Delete(ref string) error
	Has(ref string) bool
}

// testProviderTimeout limita o teste de conexão. O cliente do roteador tem
// timeout de minutos (streaming); um teste que demora minutos é um teste que
// já respondeu "não" — só falta dizer isso à pessoa.
const testProviderTimeout = 10 * time.Second

// catalogDocument é o catalog.json visto daqui: as DUAS seções que estas
// rotas possuem (providers e models) tipadas, e todo o resto preservado como
// bytes crus em `extras`.
//
// O arquivo tem outros donos — `search` é da ferramenta web.search, `vps` é do
// ambiente de execução, e seções novas vão continuar aparecendo. Uma regravação
// que só conhecesse os próprios campos apagaria a seção alheia na primeira
// edição de provedor; o mapa cru atravessa o que estas rotas não entendem.
type catalogDocument struct {
	Providers []modelrouter.Provider
	Models    []modelrouter.Entry
	extras    map[string]json.RawMessage
}

// providerView é o provedor SEM o secretRef: a tela só precisa saber se a
// chave existe, e o nome da referência é detalhe do cofre que não muda nenhuma
// decisão do lado de lá.
type providerView struct {
	ID      string           `json:"id"`
	Name    string           `json:"name"`
	Kind    modelrouter.Kind `json:"kind"`
	BaseURL string           `json:"baseUrl"`
	Enabled bool             `json:"enabled"`
	// NeedsKey diz se este tipo de provedor usa chave (o local não usa).
	NeedsKey bool `json:"needsKey"`
	// HasKey é o "cadastrada/ausente" da tela.
	HasKey    bool `json:"hasKey"`
	CanDelete bool `json:"canDelete"`
}

type modelView struct {
	modelrouter.Entry
	CanDelete bool `json:"canDelete"`
}

/* ------------------------------ persistência ------------------------------ */

// readCatalogDocument lê o arquivo. Ausente NÃO é erro: o documento nasce
// vazio e a primeira gravação o cria — é o caso do teste e de um DataDir novo.
func (s *Server) readCatalogDocument() (catalogDocument, error) {
	document := catalogDocument{extras: map[string]json.RawMessage{}}
	raw, err := os.ReadFile(s.catalogPath)
	if errors.Is(err, os.ErrNotExist) {
		return document, nil
	}
	if err != nil {
		return document, fmt.Errorf("ler o catálogo: %w", err)
	}

	fields := map[string]json.RawMessage{}
	if err := json.Unmarshal(raw, &fields); err != nil {
		// Arquivo ilegível PARA a edição em vez de regravar por cima: o JSON
		// quebrado pode ser um catálogo inteiro editado à mão com um erro de
		// vírgula, e "consertar" reescrevendo apagaria o trabalho da pessoa.
		return document, fmt.Errorf("o catalog.json está ilegível e não será sobrescrito: %w", err)
	}
	if rawProviders, found := fields["providers"]; found {
		if err := json.Unmarshal(rawProviders, &document.Providers); err != nil {
			return document, fmt.Errorf("a seção providers do catalog.json está ilegível: %w", err)
		}
		delete(fields, "providers")
	}
	if rawModels, found := fields["models"]; found {
		if err := json.Unmarshal(rawModels, &document.Models); err != nil {
			return document, fmt.Errorf("a seção models do catalog.json está ilegível: %w", err)
		}
		delete(fields, "models")
	}
	// O que sobrou é dos outros donos (search, vps, o que vier) e atravessa
	// intacto até a regravação.
	document.extras = fields
	return document, nil
}

// writeCatalogDocument grava por temporário + rename e aplica a quente.
//
// A ordem é gravar ANTES de aplicar: se o disco recusar, a memória continua
// igual ao arquivo e o erro volta para quem pediu. Aplicar antes deixaria o
// gateway servindo um catálogo que não sobrevive ao próximo boot.
func (s *Server) writeCatalogDocument(document catalogDocument) error {
	// Fatias nulas viram vazias no arquivo: `"providers": null` obrigaria todo
	// leitor a tratar dois formatos para o mesmo significado.
	if document.Providers == nil {
		document.Providers = []modelrouter.Provider{}
	}
	if document.Models == nil {
		document.Models = []modelrouter.Entry{}
	}

	fields := make(map[string]json.RawMessage, len(document.extras)+2)
	for key, value := range document.extras {
		fields[key] = value
	}
	rawProviders, err := json.Marshal(document.Providers)
	if err != nil {
		return fmt.Errorf("serializar os provedores: %w", err)
	}
	rawModels, err := json.Marshal(document.Models)
	if err != nil {
		return fmt.Errorf("serializar os modelos: %w", err)
	}
	fields["providers"] = rawProviders
	fields["models"] = rawModels

	// MarshalIndent de mapa reindenta inclusive o conteúdo RawMessage e ordena
	// as chaves — o arquivo sai legível e estável entre duas gravações iguais.
	raw, err := json.MarshalIndent(fields, "", "  ")
	if err != nil {
		return fmt.Errorf("serializar o catálogo: %w", err)
	}
	temporary := s.catalogPath + ".tmp"
	// 0600 espelha o cofre: o arquivo não guarda chave, mas guarda a topologia
	// de provedores da estação — não é dado para outros usuários da máquina.
	file, err := os.OpenFile(temporary, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("gravar o catálogo: %w", err)
	}
	if _, err := file.Write(raw); err != nil {
		_ = file.Close()
		_ = os.Remove(temporary)
		return fmt.Errorf("gravar o catálogo: %w", err)
	}
	// Sync antes do rename: sem ele o rename pode alcançar o disco antes do
	// conteúdo, e uma queda deixa um catálogo vazio no lugar do definitivo.
	if err := file.Sync(); err != nil {
		_ = file.Close()
		_ = os.Remove(temporary)
		return fmt.Errorf("sincronizar o catálogo: %w", err)
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(temporary)
		return fmt.Errorf("fechar o catálogo: %w", err)
	}
	if err := os.Rename(temporary, s.catalogPath); err != nil {
		_ = os.Remove(temporary)
		return fmt.Errorf("publicar o catálogo: %w", err)
	}

	// A aplicação a quente. SetAllowed NÃO é chamado: a lista permitida é da
	// política (boot gerenciado e sync remoto), e recalculá-la aqui faria um
	// cadastro de modelo virar liberação de modelo.
	s.models.SetProviders(document.Providers)
	s.models.SetModels(document.Models)
	return nil
}

// catalogReady é o portão comum das rotas: sem cofre ou sem caminho não há
// edição possível, e a recusa diz o que faltou em vez de um 500 genérico.
func (s *Server) catalogReady(w http.ResponseWriter) bool {
	if s.vault == nil || s.catalogPath == "" {
		s.fail(w, http.StatusServiceUnavailable, "sem_catalogo",
			"este gateway subiu sem cofre ou sem caminho de catálogo; configuração de provedores indisponível")
		return false
	}
	return true
}

/* -------------------------------- validação ------------------------------- */

// knownKinds fecha a lista de dialetos. Um kind desconhecido não é "vai que
// funciona": o roteador recusaria o stream depois, no meio de um turno — a
// hora errada de descobrir um erro de digitação.
var knownKinds = map[modelrouter.Kind]bool{
	modelrouter.KindOpenAI:     true,
	modelrouter.KindXAI:        true,
	modelrouter.KindAnthropic:  true,
	modelrouter.KindGemini:     true,
	modelrouter.KindCompatible: true,
	modelrouter.KindLocal:      true,
}

func kindList() string {
	return strings.Join([]string{
		string(modelrouter.KindOpenAI),
		string(modelrouter.KindXAI),
		string(modelrouter.KindAnthropic),
		string(modelrouter.KindGemini),
		string(modelrouter.KindCompatible),
		string(modelrouter.KindLocal),
	}, ", ")
}

// validateCatalogID aceita o que atravessa URL, cofre e JSON sem escape. O id
// vira segmento de rota (DELETE /v1/catalog/providers/{id}) e referência de
// cofre ("provider:<id>") — barra e espaço quebrariam os dois.
func validateCatalogID(id string) error {
	if id == "" {
		return errors.New("informe um id")
	}
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '-', r == '_', r == '.':
		default:
			return fmt.Errorf("id %q inválido: use letras, números, ponto, hífen e underscore", id)
		}
	}
	return nil
}

// validateBaseURL exige https; http só em loopback.
//
// O baseUrl recebe a CHAVE no cabeçalho de toda chamada. Aceitar http para um
// host de fora mandaria a credencial em claro pela rede — e o erro não
// apareceria nunca, porque a chamada funciona. Loopback é a exceção honesta:
// o runtime local e o teste falam http sem sair da máquina.
func validateBaseURL(raw string) error {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return errors.New("informe o baseUrl")
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return fmt.Errorf("baseUrl inválida: %v", err)
	}
	if parsed.Host == "" {
		return fmt.Errorf("baseUrl %q sem host — use https://host/caminho", trimmed)
	}
	switch parsed.Scheme {
	case "https":
		return nil
	case "http":
		if isLoopbackHost(parsed.Hostname()) {
			return nil
		}
		return fmt.Errorf("http só é aceito em loopback (127.0.0.1, ::1, localhost); use https para %s", parsed.Hostname())
	default:
		return fmt.Errorf("esquema %q não aceito no baseUrl — use https (ou http em loopback)", parsed.Scheme)
	}
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// providerSecretRef é a convenção de nome no cofre. Fixa aqui porque o mesmo
// nome já é a semente do catálogo padrão (cmd/aibotd) — dois formatos seriam
// duas chaves para o mesmo provedor.
func providerSecretRef(id string) string { return "provider:" + id }

/* ---------------------------------- GET ----------------------------------- */

// getCatalog devolve a COMPOSIÇÃO completa — arquivo mais plugins — inclusive
// provedores desligados e modelos fora da política. A tela administra o que o
// runtime realmente enxerga; /v1/models continua sendo a visão utilizável.
func (s *Server) getCatalog(w http.ResponseWriter, _ *http.Request) {
	if !s.catalogReady(w) {
		return
	}
	s.catalogMu.Lock()
	document, err := s.readCatalogDocument()
	s.catalogMu.Unlock()
	if err != nil {
		s.fail(w, http.StatusInternalServerError, "catalogo", err.Error())
		return
	}

	providers, models := s.models.Configuration()
	persistedProviders := make(map[string]bool, len(document.Providers))
	for _, provider := range document.Providers {
		persistedProviders[provider.ID] = true
	}
	views := make([]providerView, 0, len(providers))
	for _, provider := range providers {
		view := s.viewOf(provider)
		view.CanDelete = persistedProviders[provider.ID]
		views = append(views, view)
	}
	persistedModels := make(map[string]bool, len(document.Models))
	for _, model := range document.Models {
		persistedModels[model.ID] = true
	}
	modelViews := make([]modelView, 0, len(models))
	for _, model := range models {
		modelViews = append(modelViews, modelView{Entry: model, CanDelete: persistedModels[model.ID]})
	}
	// `search` sai cru do arquivo: o dono do formato é o web.search, e esta
	// rota só o repassa para a tela mostrar qual motor está configurado.
	s.ok(w, map[string]any{
		"providers": views,
		"models":    modelViews,
		"search":    document.extras["search"],
	})
}

func (s *Server) viewOf(provider modelrouter.Provider) providerView {
	needsKey := provider.Kind != modelrouter.KindLocal
	return providerView{
		ID:        provider.ID,
		Name:      provider.Name,
		Kind:      provider.Kind,
		BaseURL:   provider.BaseURL,
		Enabled:   provider.Enabled,
		NeedsKey:  needsKey,
		HasKey:    provider.SecretRef != "" && s.vault.Has(provider.SecretRef),
		CanDelete: true,
	}
}

/* ------------------------------- provedores ------------------------------- */

// providerRequest é o corpo do POST. `Enabled` é ponteiro para distinguir
// "não mandei" (nasce ligado — quem cadastra quer usar) de "mandei false".
type providerRequest struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Kind    string `json:"kind"`
	BaseURL string `json:"baseUrl"`
	// APIKey vai DIRETO para o cofre e nunca para o arquivo. Ver o cabeçalho.
	APIKey  string `json:"apiKey"`
	Enabled *bool  `json:"enabled"`
}

func (s *Server) postCatalogProvider(w http.ResponseWriter, r *http.Request) {
	if !s.catalogReady(w) {
		return
	}
	var body providerRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		s.fail(w, http.StatusBadRequest, "bad_request", "corpo inválido: "+err.Error())
		return
	}

	body.ID = strings.TrimSpace(body.ID)
	if err := validateCatalogID(body.ID); err != nil {
		s.fail(w, http.StatusBadRequest, "provedor_invalido", err.Error())
		return
	}
	kind := modelrouter.Kind(strings.TrimSpace(body.Kind))
	if !knownKinds[kind] {
		s.fail(w, http.StatusBadRequest, "kind_desconhecido",
			fmt.Sprintf("kind %q desconhecido — use um de: %s", body.Kind, kindList()))
		return
	}
	if err := validateBaseURL(body.BaseURL); err != nil {
		s.fail(w, http.StatusBadRequest, "baseurl_invalida", err.Error())
		return
	}
	if kind == modelrouter.KindLocal && body.APIKey != "" {
		// Aceitar e guardar seria pior que recusar: a chave ficaria "cadastrada"
		// no cofre sem nenhum caminho de código que a use.
		s.fail(w, http.StatusBadRequest, "chave_sem_uso",
			"o provedor local não usa chave — remova o campo apiKey")
		return
	}

	name := strings.TrimSpace(body.Name)
	if name == "" {
		name = body.ID
	}
	enabled := true
	if body.Enabled != nil {
		enabled = *body.Enabled
	}

	s.catalogMu.Lock()
	defer s.catalogMu.Unlock()

	document, err := s.readCatalogDocument()
	if err != nil {
		s.fail(w, http.StatusInternalServerError, "catalogo", err.Error())
		return
	}
	for _, existing := range document.Providers {
		if existing.ID == body.ID {
			s.fail(w, http.StatusConflict, "provedor_existente",
				fmt.Sprintf("o provedor %q já existe — use PATCH para alterá-lo", body.ID))
			return
		}
	}
	if _, exists := s.models.ProviderConfig(body.ID); exists {
		s.fail(w, http.StatusConflict, "provedor_existente",
			fmt.Sprintf("o provedor %q já existe — use PATCH para alterá-lo", body.ID))
		return
	}

	secretRef := ""
	if kind != modelrouter.KindLocal {
		// O secretRef nasce SEMPRE em provedor remoto, com ou sem chave no
		// corpo: é ele que faz `usable` exigir a chave. Sem a referência, o
		// roteador trataria o provedor como "não precisa de credencial" e os
		// modelos dele entrariam no catálogo sem chave nenhuma.
		secretRef = providerSecretRef(body.ID)
	}

	keyStored := false
	if body.APIKey != "" {
		// Cofre ANTES do arquivo: se o cofre recusar, nada foi cadastrado. Na
		// ordem inversa, um provedor sem a chave que a pessoa acabou de digitar
		// ficaria registrado como se a chave tivesse sido aceita.
		if err := s.vault.Set(secretRef, body.APIKey); err != nil {
			s.fail(w, http.StatusInternalServerError, "cofre", "não foi possível guardar a chave: "+err.Error())
			return
		}
		keyStored = true
	}

	provider := modelrouter.Provider{
		ID:        body.ID,
		Name:      name,
		Kind:      kind,
		BaseURL:   strings.TrimSpace(body.BaseURL),
		SecretRef: secretRef,
		Enabled:   enabled,
	}
	document.Providers = append(document.Providers, provider)
	if err := s.writeCatalogDocument(document); err != nil {
		// A chave já está no cofre e FICA: reenviar o cadastro regrava por cima
		// sem perder nada, enquanto apagá-la aqui poderia destruir uma chave
		// que um PATCH anterior tinha acabado de renovar.
		s.fail(w, http.StatusInternalServerError, "catalogo", err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusCreated)
	s.ok(w, map[string]any{"provider": s.viewOf(provider), "keyStored": keyStored})
}

// providerPatch usa ponteiros: campo AUSENTE mantém o que está — inclusive a
// chave, que é o contrato da rota ("apiKey ausente mantém a atual").
type providerPatch struct {
	Name    *string `json:"name"`
	Kind    *string `json:"kind"`
	BaseURL *string `json:"baseUrl"`
	APIKey  *string `json:"apiKey"`
	Enabled *bool   `json:"enabled"`
}

func (s *Server) patchCatalogProvider(w http.ResponseWriter, r *http.Request) {
	if !s.catalogReady(w) {
		return
	}
	providerID := r.PathValue("id")
	var body providerPatch
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		s.fail(w, http.StatusBadRequest, "bad_request", "corpo inválido: "+err.Error())
		return
	}

	s.catalogMu.Lock()
	defer s.catalogMu.Unlock()

	document, err := s.readCatalogDocument()
	if err != nil {
		s.fail(w, http.StatusInternalServerError, "catalogo", err.Error())
		return
	}
	index := -1
	for i := range document.Providers {
		if document.Providers[i].ID == providerID {
			index = i
			break
		}
	}
	if index < 0 {
		// Provedor de plugin ainda não existe no arquivo. O PATCH materializa
		// uma camada de configuração da pessoa; o manifesto continua sendo o
		// fallback que reaparece se esse override for removido fora daqui.
		provider, exists := s.models.ProviderConfig(providerID)
		if !exists {
			s.fail(w, http.StatusNotFound, "not_found", fmt.Sprintf("provedor %q não existe no catálogo", providerID))
			return
		}
		document.Providers = append(document.Providers, provider)
		index = len(document.Providers) - 1
	}
	provider := document.Providers[index]

	if body.Kind != nil {
		kind := modelrouter.Kind(strings.TrimSpace(*body.Kind))
		if !knownKinds[kind] {
			s.fail(w, http.StatusBadRequest, "kind_desconhecido",
				fmt.Sprintf("kind %q desconhecido — use um de: %s", *body.Kind, kindList()))
			return
		}
		provider.Kind = kind
	}
	if body.BaseURL != nil {
		if err := validateBaseURL(*body.BaseURL); err != nil {
			s.fail(w, http.StatusBadRequest, "baseurl_invalida", err.Error())
			return
		}
		provider.BaseURL = strings.TrimSpace(*body.BaseURL)
	}
	if body.Name != nil && strings.TrimSpace(*body.Name) != "" {
		provider.Name = strings.TrimSpace(*body.Name)
	}
	if body.Enabled != nil {
		provider.Enabled = *body.Enabled
	}

	keyStored := false
	// Chave vazia conta como ausente: um formulário que manda `apiKey: ""`
	// está dizendo "não digitei nada", não "apague a chave" — apagar é o DELETE.
	if body.APIKey != nil && *body.APIKey != "" {
		if provider.Kind == modelrouter.KindLocal {
			s.fail(w, http.StatusBadRequest, "chave_sem_uso",
				"o provedor local não usa chave — remova o campo apiKey")
			return
		}
		if provider.SecretRef == "" {
			// Provedor remoto sem referência só existe por edição manual do
			// arquivo; a chave nova ganha a referência da convenção.
			provider.SecretRef = providerSecretRef(provider.ID)
		}
		if err := s.vault.Set(provider.SecretRef, *body.APIKey); err != nil {
			s.fail(w, http.StatusInternalServerError, "cofre", "não foi possível guardar a chave: "+err.Error())
			return
		}
		keyStored = true
	}

	document.Providers[index] = provider
	if err := s.writeCatalogDocument(document); err != nil {
		s.fail(w, http.StatusInternalServerError, "catalogo", err.Error())
		return
	}
	s.ok(w, map[string]any{"provider": s.viewOf(provider), "keyStored": keyStored})
}

func (s *Server) deleteCatalogProvider(w http.ResponseWriter, r *http.Request) {
	if !s.catalogReady(w) {
		return
	}
	providerID := r.PathValue("id")

	s.catalogMu.Lock()
	defer s.catalogMu.Unlock()

	document, err := s.readCatalogDocument()
	if err != nil {
		s.fail(w, http.StatusInternalServerError, "catalogo", err.Error())
		return
	}
	index := -1
	for i := range document.Providers {
		if document.Providers[i].ID == providerID {
			index = i
			break
		}
	}
	if index < 0 {
		s.fail(w, http.StatusNotFound, "not_found", fmt.Sprintf("provedor %q não existe no catálogo", providerID))
		return
	}
	provider := document.Providers[index]

	// Cofre ANTES do arquivo, de propósito: se a remoção da chave falhar, o
	// provedor continua listado e o DELETE pode ser repetido. Na ordem inversa
	// o provedor sumiria do catálogo com a chave órfã no cofre — e não haveria
	// mais rota para limpá-la.
	if provider.SecretRef != "" {
		if err := s.vault.Delete(provider.SecretRef); err != nil {
			s.fail(w, http.StatusInternalServerError, "cofre",
				"a chave não pôde sair do cofre; nada foi removido — tente de novo: "+err.Error())
			return
		}
	}

	document.Providers = append(document.Providers[:index], document.Providers[index+1:]...)

	// Os modelos vão junto: um modelo apontando para provedor que não existe
	// nunca mais seria utilizável e ficaria no arquivo como lixo permanente.
	kept := document.Models[:0]
	removed := 0
	for _, entry := range document.Models {
		if entry.ProviderID == providerID {
			removed++
			continue
		}
		kept = append(kept, entry)
	}
	document.Models = kept

	if err := s.writeCatalogDocument(document); err != nil {
		s.fail(w, http.StatusInternalServerError, "catalogo", err.Error())
		return
	}
	s.ok(w, map[string]any{"status": "removido", "removedModels": removed})
}

/* --------------------------------- modelos -------------------------------- */

type modelRequest struct {
	ID         string   `json:"id"`
	ProviderID string   `json:"providerId"`
	Label      string   `json:"label"`
	Context    int      `json:"context"`
	Skills     []string `json:"skills"`
	Default    bool     `json:"default"`
}

func (s *Server) postCatalogModel(w http.ResponseWriter, r *http.Request) {
	if !s.catalogReady(w) {
		return
	}
	var body modelRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		s.fail(w, http.StatusBadRequest, "bad_request", "corpo inválido: "+err.Error())
		return
	}
	body.ID = strings.TrimSpace(body.ID)
	if err := validateCatalogID(body.ID); err != nil {
		s.fail(w, http.StatusBadRequest, "modelo_invalido", err.Error())
		return
	}
	if body.Context < 0 {
		s.fail(w, http.StatusBadRequest, "modelo_invalido", "context não pode ser negativo")
		return
	}
	body.ProviderID = strings.TrimSpace(body.ProviderID)

	s.catalogMu.Lock()
	defer s.catalogMu.Unlock()

	document, err := s.readCatalogDocument()
	if err != nil {
		s.fail(w, http.StatusInternalServerError, "catalogo", err.Error())
		return
	}

	var provider *modelrouter.Provider
	for i := range document.Providers {
		if document.Providers[i].ID == body.ProviderID {
			provider = &document.Providers[i]
			break
		}
	}
	if provider == nil {
		if composed, exists := s.models.ProviderConfig(body.ProviderID); exists {
			provider = &composed
		} else {
			s.fail(w, http.StatusBadRequest, "provedor_desconhecido",
				fmt.Sprintf("o provedor %q não existe — cadastre-o antes do modelo", body.ProviderID))
			return
		}
	}
	_, configuredModels := s.models.Configuration()
	for _, existing := range configuredModels {
		if existing.ID == body.ID {
			s.fail(w, http.StatusConflict, "modelo_existente",
				fmt.Sprintf("o modelo %q já existe no catálogo", body.ID))
			return
		}
	}

	label := strings.TrimSpace(body.Label)
	if label == "" {
		label = body.ID
	}
	if body.Default {
		// Só um padrão: o Resolve pega o primeiro `Default` utilizável, e dois
		// marcados fariam a escolha depender da ordem do arquivo — que ninguém
		// enxerga pela tela.
		for i := range document.Models {
			document.Models[i].Default = false
		}
	}

	entry := modelrouter.Entry{
		Model: protocol.Model{
			ID:       body.ID,
			Provider: provider.ID,
			Label:    label,
			Context:  body.Context,
			Skills:   body.Skills,
			// Local vem do PROVEDOR, não do formulário: é o tipo dele que diz
			// se o tráfego sai da máquina, e essa marca decide custo e política.
			Local: provider.Kind == modelrouter.KindLocal,
		},
		ProviderID: provider.ID,
		Default:    body.Default,
	}
	document.Models = append(document.Models, entry)
	if err := s.writeCatalogDocument(document); err != nil {
		s.fail(w, http.StatusInternalServerError, "catalogo", err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusCreated)
	s.ok(w, map[string]any{"model": entry})
}

func (s *Server) deleteCatalogModel(w http.ResponseWriter, r *http.Request) {
	if !s.catalogReady(w) {
		return
	}
	modelID := r.PathValue("id")

	s.catalogMu.Lock()
	defer s.catalogMu.Unlock()

	document, err := s.readCatalogDocument()
	if err != nil {
		s.fail(w, http.StatusInternalServerError, "catalogo", err.Error())
		return
	}
	index := -1
	for i := range document.Models {
		if document.Models[i].ID == modelID {
			index = i
			break
		}
	}
	if index < 0 {
		s.fail(w, http.StatusNotFound, "not_found", fmt.Sprintf("modelo %q não existe no catálogo", modelID))
		return
	}
	document.Models = append(document.Models[:index], document.Models[index+1:]...)
	if err := s.writeCatalogDocument(document); err != nil {
		s.fail(w, http.StatusInternalServerError, "catalogo", err.Error())
		return
	}
	s.ok(w, map[string]any{"status": "removido"})
}

/* ------------------------------ teste de conexão --------------------------- */

// testCatalogProvider faz UMA chamada mínima ao provedor e traduz o resultado
// numa frase. A chamada sai por ProviderFetch, que é o único caminho de
// credencial do roteador — a chave entra no cabeçalho dentro do callback do
// cofre e o erro volta censurado. Nada aqui toca o valor.
func (s *Server) testCatalogProvider(w http.ResponseWriter, r *http.Request) {
	if !s.catalogReady(w) {
		return
	}
	providerID := r.PathValue("id")

	s.catalogMu.Lock()
	document, err := s.readCatalogDocument()
	s.catalogMu.Unlock()
	if err != nil {
		s.fail(w, http.StatusInternalServerError, "catalogo", err.Error())
		return
	}
	var provider *modelrouter.Provider
	for i := range document.Providers {
		if document.Providers[i].ID == providerID {
			provider = &document.Providers[i]
			break
		}
	}
	if provider == nil {
		if composed, exists := s.models.ProviderConfig(providerID); exists {
			provider = &composed
		} else {
			s.fail(w, http.StatusNotFound, "not_found", fmt.Sprintf("provedor %q não existe no catálogo", providerID))
			return
		}
	}

	ctx, cancel := context.WithTimeout(r.Context(), testProviderTimeout)
	defer cancel()

	okResult, detail := s.probeProvider(ctx, *provider)
	// O teste que falha NÃO é erro HTTP: a rota funcionou e a resposta é a
	// informação ("a chave foi recusada"). Erro HTTP aqui faria a tela mostrar
	// "falha no gateway" quando a falha é do provedor.
	s.ok(w, map[string]any{"ok": okResult, "detail": detail})
}

// probeProvider decide a chamada por dialeto: GET /models onde o dialeto
// OpenAI vale (openai, openai-compatible, local) — que valida credencial de
// verdade — e HEAD na base nos outros, que só mede alcance sem arriscar um
// corpo que o dialeto não documenta.
func (s *Server) probeProvider(ctx context.Context, provider modelrouter.Provider) (bool, string) {
	if !provider.Enabled {
		return false, fmt.Sprintf("o provedor %s está desabilitado — habilite-o antes de testar", provider.ID)
	}
	if provider.Kind != modelrouter.KindLocal && provider.SecretRef != "" && !s.vault.Has(provider.SecretRef) {
		return false, "sem chave no cofre — cadastre a chave e teste de novo"
	}

	switch provider.Kind {
	case modelrouter.KindOpenAI, modelrouter.KindXAI, modelrouter.KindCompatible, modelrouter.KindLocal:
		status, _, err := s.models.ProviderFetch(ctx, provider.ID, http.MethodGet, "/models", nil)
		if err != nil {
			// O erro do ProviderFetch já vem sem URL e sem chave (ele reescreve
			// com o id do provedor e o cofre censura o callback).
			return false, "não deu para falar com o provedor: " + err.Error()
		}
		switch {
		case status >= 200 && status < 300:
			return true, fmt.Sprintf("conectado: o provedor respondeu %d em GET /models", status)
		case status == http.StatusUnauthorized || status == http.StatusForbidden:
			return false, fmt.Sprintf("a chave foi recusada (%d) — confira a credencial no cofre", status)
		default:
			return false, fmt.Sprintf("o provedor respondeu %d em GET /models", status)
		}
	default:
		status, _, err := s.models.ProviderFetch(ctx, provider.ID, http.MethodHead, "/", nil)
		if err != nil {
			return false, "não deu para falar com o provedor: " + err.Error()
		}
		// Para HEAD na base qualquer resposta HTTP conta como alcançado: os
		// dialetos anthropic/gemini não documentam a base, e um 404 vindo DELES
		// prova exatamente o que o teste quer provar — que há alguém lá.
		return true, fmt.Sprintf("endereço alcançado (HTTP %d); este dialeto não valida a chave no teste", status)
	}
}
