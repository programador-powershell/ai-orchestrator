package plugins

import (
	"embed"
	"encoding/json"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
)

//go:embed builtin/*.json
var builtinFS embed.FS

func Builtin(name string) (Manifest, error) {
	raw, err := builtinFS.ReadFile("builtin/" + name + ".json")
	if err != nil {
		return Manifest{}, fmt.Errorf("plugin embutido %q: %w", name, err)
	}
	var manifest Manifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return Manifest{}, fmt.Errorf("plugin embutido %q ilegível: %w", name, err)
	}
	if err := Validate(manifest); err != nil {
		return Manifest{}, err
	}
	return manifest, nil
}

func Builtins() (map[string]Manifest, error) {
	entries, err := builtinFS.ReadDir("builtin")
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() && strings.EqualFold(filepath.Ext(entry.Name()), ".json") {
			names = append(names, strings.TrimSuffix(entry.Name(), filepath.Ext(entry.Name())))
		}
	}
	sort.Strings(names)
	out := make(map[string]Manifest, len(names))
	for _, name := range names {
		manifest, err := Builtin(name)
		if err != nil {
			return nil, err
		}
		out[manifest.Name] = manifest
	}
	return out, nil
}
