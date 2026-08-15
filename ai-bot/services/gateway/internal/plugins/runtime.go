// Package plugins é o microkernel de composição do AI-BOT.
//
// O núcleo não conhece implementações concretas: conhece TIPOS de contribuição
// e instaladores. Um plugin monta contribuições em ordem; cada registro devolve
// um efeito reversível. Se a contribuição seguinte falhar, as anteriores são
// desfeitas na ordem inversa e o plugin nunca aparece como montado.
package plugins

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

const SchemaVersion = 1

type Contribution struct {
	Kind   string          `json:"kind"`
	ID     string          `json:"id"`
	Config json.RawMessage `json:"config"`
}

type Manifest struct {
	SchemaVersion int            `json:"schemaVersion"`
	Name          string         `json:"name"`
	Version       string         `json:"version"`
	Requires      []string       `json:"requires,omitempty"`
	Contributes   []Contribution `json:"contributes"`
}

type Profile struct {
	SchemaVersion int      `json:"schemaVersion"`
	Name          string   `json:"name"`
	Plugins       []string `json:"plugins"`
}

type Dispose func() error
type Installer func(context.Context, string, Contribution) (Dispose, error)

type mounted struct {
	manifest Manifest
	effects  []Dispose
}

type Runtime struct {
	opMu sync.Mutex
	mu   sync.RWMutex

	installers map[string]Installer
	mounted    map[string]mounted
}

func NewRuntime() *Runtime {
	return &Runtime{
		installers: make(map[string]Installer),
		mounted:    make(map[string]mounted),
	}
}

// RegisterKind liga um contrato de contribuição à capacidade que o aplica.
// Dois instaladores para o mesmo kind são ambiguidade e por isso são recusados.
func (r *Runtime) RegisterKind(kind string, installer Installer) error {
	kind = strings.TrimSpace(kind)
	if kind == "" || installer == nil {
		return errors.New("registro de kind exige nome e installer")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.installers[kind]; exists {
		return fmt.Errorf("kind %q já tem installer", kind)
	}
	r.installers[kind] = installer
	return nil
}

func (r *Runtime) Mount(ctx context.Context, manifest Manifest) error {
	r.opMu.Lock()
	defer r.opMu.Unlock()
	return r.mount(ctx, manifest)
}

func (r *Runtime) mount(ctx context.Context, manifest Manifest) error {
	if err := Validate(manifest); err != nil {
		return err
	}

	r.mu.RLock()
	if current, exists := r.mounted[manifest.Name]; exists {
		r.mu.RUnlock()
		return fmt.Errorf("plugin %q já está montado na versão %s", manifest.Name, current.manifest.Version)
	}
	for _, dependency := range manifest.Requires {
		if _, exists := r.mounted[dependency]; !exists {
			r.mu.RUnlock()
			return fmt.Errorf("plugin %q exige %q, que não está montado", manifest.Name, dependency)
		}
	}
	installers := make(map[string]Installer, len(manifest.Contributes))
	for _, contribution := range manifest.Contributes {
		installers[contribution.Kind] = r.installers[contribution.Kind]
	}
	r.mu.RUnlock()

	effects := make([]Dispose, 0, len(manifest.Contributes))
	for _, contribution := range manifest.Contributes {
		installer := installers[contribution.Kind]
		if installer == nil {
			rollback(effects)
			return fmt.Errorf("plugin %q: kind %q não existe neste runtime", manifest.Name, contribution.Kind)
		}
		effect, err := installer(ctx, manifest.Name, contribution)
		if err != nil {
			rollback(effects)
			return fmt.Errorf("plugin %q, contribuição %s/%s: %w",
				manifest.Name, contribution.Kind, contribution.ID, err)
		}
		if effect == nil {
			effect = func() error { return nil }
		}
		effects = append(effects, effect)
	}

	r.mu.Lock()
	r.mounted[manifest.Name] = mounted{manifest: manifest, effects: effects}
	r.mu.Unlock()
	return nil
}

func (r *Runtime) Unmount(name string) error {
	r.opMu.Lock()
	defer r.opMu.Unlock()
	return r.unmount(strings.TrimSpace(name), false)
}

func (r *Runtime) unmount(name string, rollbackMode bool) error {
	r.mu.RLock()
	entry, exists := r.mounted[name]
	if !exists {
		r.mu.RUnlock()
		return nil
	}
	if !rollbackMode {
		for other, candidate := range r.mounted {
			if other != name && contains(candidate.manifest.Requires, name) {
				r.mu.RUnlock()
				return fmt.Errorf("plugin %q ainda é exigido por %q", name, other)
			}
		}
	}
	r.mu.RUnlock()

	var problems []error
	for i := len(entry.effects) - 1; i >= 0; i-- {
		if err := entry.effects[i](); err != nil {
			problems = append(problems, err)
		}
	}
	r.mu.Lock()
	delete(r.mounted, name)
	r.mu.Unlock()
	return errors.Join(problems...)
}

// MountProfile resolve dependências e monta a árvore inteira. Falha em uma
// folha desfaz apenas o que esta operação acabou de montar.
func (r *Runtime) MountProfile(ctx context.Context, profile Profile, available map[string]Manifest) error {
	if profile.SchemaVersion != SchemaVersion || !validName(profile.Name) {
		return fmt.Errorf("perfil inválido: %q (schema %d)", profile.Name, profile.SchemaVersion)
	}
	r.opMu.Lock()
	defer r.opMu.Unlock()

	var order []Manifest
	visiting := map[string]bool{}
	visited := map[string]bool{}
	var visit func(string) error
	visit = func(name string) error {
		if visiting[name] {
			return fmt.Errorf("ciclo de dependência envolvendo %q", name)
		}
		if visited[name] {
			return nil
		}
		manifest, ok := available[name]
		if !ok {
			return fmt.Errorf("perfil %q referencia plugin ausente %q", profile.Name, name)
		}
		visiting[name] = true
		for _, dependency := range manifest.Requires {
			if err := visit(dependency); err != nil {
				return err
			}
		}
		delete(visiting, name)
		visited[name] = true
		order = append(order, manifest)
		return nil
	}
	for _, name := range profile.Plugins {
		if err := visit(name); err != nil {
			return err
		}
	}

	var mountedNow []string
	for _, manifest := range order {
		r.mu.RLock()
		_, already := r.mounted[manifest.Name]
		r.mu.RUnlock()
		if already {
			continue
		}
		if err := r.mount(ctx, manifest); err != nil {
			for i := len(mountedNow) - 1; i >= 0; i-- {
				_ = r.unmount(mountedNow[i], true)
			}
			return err
		}
		mountedNow = append(mountedNow, manifest.Name)
	}
	return nil
}

func (r *Runtime) Mounted() []Manifest {
	r.mu.RLock()
	out := make([]Manifest, 0, len(r.mounted))
	for _, entry := range r.mounted {
		out = append(out, entry.manifest)
	}
	r.mu.RUnlock()
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// Close descarrega tudo em ordem de dependência (folhas antes das bases).
// É idempotente e serve ao encerramento do processo e a testes de ciclo de vida.
func (r *Runtime) Close() error {
	r.opMu.Lock()
	defer r.opMu.Unlock()

	var problems []error
	for {
		r.mu.RLock()
		if len(r.mounted) == 0 {
			r.mu.RUnlock()
			break
		}
		names := make([]string, 0, len(r.mounted))
		for name := range r.mounted {
			names = append(names, name)
		}
		sort.Strings(names)
		leaf := ""
		for _, candidate := range names {
			required := false
			for other, entry := range r.mounted {
				if other != candidate && contains(entry.manifest.Requires, candidate) {
					required = true
					break
				}
			}
			if !required {
				leaf = candidate
				break
			}
		}
		r.mu.RUnlock()
		if leaf == "" {
			problems = append(problems, errors.New("não foi possível ordenar plugins montados para descarregar"))
			break
		}
		if err := r.unmount(leaf, true); err != nil {
			problems = append(problems, fmt.Errorf("descarregar plugin %s: %w", leaf, err))
		}
	}
	return errors.Join(problems...)
}

func Validate(manifest Manifest) error {
	if manifest.SchemaVersion != SchemaVersion {
		return fmt.Errorf("plugin %q usa schema %d; este runtime lê %d",
			manifest.Name, manifest.SchemaVersion, SchemaVersion)
	}
	if !validName(manifest.Name) {
		return fmt.Errorf("nome de plugin inválido: %q", manifest.Name)
	}
	if strings.TrimSpace(manifest.Version) == "" {
		return fmt.Errorf("plugin %q não declara version", manifest.Name)
	}
	seen := map[string]bool{}
	for _, dependency := range manifest.Requires {
		if !validName(dependency) || dependency == manifest.Name {
			return fmt.Errorf("plugin %q tem dependência inválida %q", manifest.Name, dependency)
		}
	}
	for _, contribution := range manifest.Contributes {
		key := contribution.Kind + "\x00" + contribution.ID
		if strings.TrimSpace(contribution.Kind) == "" || strings.TrimSpace(contribution.ID) == "" {
			return fmt.Errorf("plugin %q tem contribuição sem kind/id", manifest.Name)
		}
		if seen[key] {
			return fmt.Errorf("plugin %q repete contribuição %s/%s", manifest.Name, contribution.Kind, contribution.ID)
		}
		seen[key] = true
		if len(contribution.Config) == 0 || !json.Valid(contribution.Config) {
			return fmt.Errorf("plugin %q, contribuição %s/%s tem config inválida",
				manifest.Name, contribution.Kind, contribution.ID)
		}
	}
	return nil
}

func Load(path string) (Manifest, error) {
	file := path
	if info, err := os.Stat(path); err != nil {
		return Manifest{}, err
	} else if info.IsDir() {
		file = filepath.Join(path, "plugin.json")
	}
	raw, err := os.ReadFile(file)
	if err != nil {
		return Manifest{}, fmt.Errorf("ler plugin %s: %w", path, err)
	}
	var manifest Manifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return Manifest{}, fmt.Errorf("plugin %s não é JSON válido: %w", path, err)
	}
	if err := Validate(manifest); err != nil {
		return Manifest{}, err
	}
	return manifest, nil
}

// LoadProfile lê a composição ordenada que uma estação decidiu ativar. Perfil
// não instala nada sozinho; ele só escolhe plugins disponíveis, e MountProfile
// continua responsável por dependências, atomicidade e rollback.
func LoadProfile(path string) (Profile, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return Profile{}, fmt.Errorf("ler perfil %s: %w", path, err)
	}
	var profile Profile
	if err := json.Unmarshal(raw, &profile); err != nil {
		return Profile{}, fmt.Errorf("perfil %s não é JSON válido: %w", path, err)
	}
	if profile.SchemaVersion != SchemaVersion || !validName(profile.Name) {
		return Profile{}, fmt.Errorf("perfil inválido: %q (schema %d)", profile.Name, profile.SchemaVersion)
	}
	seen := make(map[string]bool, len(profile.Plugins))
	for _, name := range profile.Plugins {
		if !validName(name) {
			return Profile{}, fmt.Errorf("perfil %q contém plugin inválido %q", profile.Name, name)
		}
		if seen[name] {
			return Profile{}, fmt.Errorf("perfil %q repete plugin %q", profile.Name, name)
		}
		seen[name] = true
	}
	return profile, nil
}

func Discover(root string) (map[string]Manifest, error) {
	entries, err := os.ReadDir(root)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]Manifest{}, nil
		}
		return nil, err
	}
	found := make(map[string]Manifest)
	var problems []error
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		manifest, err := Load(filepath.Join(root, entry.Name()))
		if err != nil {
			problems = append(problems, fmt.Errorf("plugin %s: %w", entry.Name(), err))
			continue
		}
		if _, duplicate := found[manifest.Name]; duplicate {
			problems = append(problems, fmt.Errorf("plugin repetido: %s", manifest.Name))
			continue
		}
		found[manifest.Name] = manifest
	}
	return found, errors.Join(problems...)
}

func rollback(effects []Dispose) {
	for i := len(effects) - 1; i >= 0; i-- {
		_ = effects[i]()
	}
}

func contains(list []string, needle string) bool {
	for _, item := range list {
		if item == needle {
			return true
		}
	}
	return false
}

func validName(name string) bool {
	if name == "" || len(name) > 80 {
		return false
	}
	for _, symbol := range name {
		switch {
		case symbol >= 'a' && symbol <= 'z':
		case symbol >= '0' && symbol <= '9':
		case symbol == '-' || symbol == '_':
		default:
			return false
		}
	}
	return true
}
