// Package openapi reads the schema keywords a generated Go client does not
// carry in its types. openapi-generator ships the spec beside the client
// (`api/openapi.yaml`), so `minimum`, `maximum`, `minItems` and `enum` are
// available verbatim instead of through prose heuristics.
package openapi

import (
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

// Property is the subset of schema keywords the analyzer turns into
// guarantees.
type Property struct {
	Minimum          *float64 `yaml:"minimum"`
	Maximum          *float64 `yaml:"maximum"`
	ExclusiveMinimum *float64 `yaml:"exclusiveMinimum"`
	ExclusiveMaximum *float64 `yaml:"exclusiveMaximum"`
	MinItems         *int     `yaml:"minItems"`
	Enum             []string `yaml:"enum"`
	Nullable         bool     `yaml:"nullable"`
	Type             string   `yaml:"type"`
	Description      string   `yaml:"description"`
}

// Schema is one entry of components.schemas.
type Schema struct {
	Required   []string            `yaml:"required"`
	Properties map[string]Property `yaml:"properties"`
	Enum       []string            `yaml:"enum"`
	Type       string              `yaml:"type"`
}

// Spec is the parsed components section of an OpenAPI document.
type Spec struct {
	Schemas map[string]Schema
	// byGoName maps the generator's Go type name back to the schema key, so
	// `CursorOffsetResponse[AccountResponse]` is found from
	// `CursorOffsetResponseAccountResponse`.
	byGoName map[string]string
}

type document struct {
	Components struct {
		Schemas map[string]Schema `yaml:"schemas"`
	} `yaml:"components"`
}

// Load reads `api/openapi.yaml` (or `api/openapi.yml`) under dir. A missing
// file is not an error: the spec is a bonus source, and the types alone
// still index required fields, enums and integer width.
func Load(dir string) (*Spec, bool, error) {
	for _, name := range []string{"api/openapi.yaml", "api/openapi.yml"} {
		raw, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return nil, false, err
		}
		var doc document
		if err := yaml.Unmarshal(raw, &doc); err != nil {
			return nil, false, err
		}
		spec := &Spec{Schemas: doc.Components.Schemas, byGoName: map[string]string{}}
		for key := range spec.Schemas {
			spec.byGoName[GoTypeName(key)] = key
		}
		return spec, true, nil
	}
	return nil, false, nil
}

// Schema resolves a Go model type name to its schema.
func (s *Spec) Schema(goType string) (Schema, bool) {
	if s == nil {
		return Schema{}, false
	}
	if sc, ok := s.Schemas[goType]; ok {
		return sc, true
	}
	key, ok := s.byGoName[goType]
	if !ok {
		return Schema{}, false
	}
	return s.Schemas[key], true
}

// Property resolves a Go model type and a JSON property name.
func (s *Spec) Property(goType, jsonName string) (Property, bool) {
	sc, ok := s.Schema(goType)
	if !ok {
		return Property{}, false
	}
	p, ok := sc.Properties[jsonName]
	return p, ok
}

// GoTypeName mirrors openapi-generator's model naming: every run of
// non-alphanumerics is a word break and each word is capitalised.
func GoTypeName(schema string) string {
	var b strings.Builder
	upper := true
	for _, r := range schema {
		switch {
		case r >= '0' && r <= '9', r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z':
			if upper && r >= 'a' && r <= 'z' {
				r -= 'a' - 'A'
			}
			b.WriteRune(r)
			upper = false
		default:
			upper = true
		}
	}
	return b.String()
}
