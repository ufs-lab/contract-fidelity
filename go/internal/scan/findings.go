package scan

import (
	"go/types"
	"sort"

	"github.com/ufs-lab/contract-fidelity/go/internal/constraint"
)

// Origin is a contract read a finding's value traces back to.
type Origin struct {
	File  string `json:"file"`
	Line  int    `json:"line"`
	Text  string `json:"text"`
	Field string `json:"field"`
}

// Widening names the declaration that dropped the guarantee on the way to
// a dead guard.
type Widening struct {
	Declared  string `json:"declared"`
	Type      string `json:"type"`
	Suggested string `json:"suggested,omitempty"`
}

// DeadGuard is a check the guarantee makes statically decidable.
type DeadGuard struct {
	File     string             `json:"file"`
	Line     int                `json:"line"`
	Guard    string             `json:"guard"`
	Verdict  constraint.Verdict `json:"verdict"`
	Contract string             `json:"contract"`
	Kind     constraint.Kind    `json:"kind"`
	Why      string             `json:"why"`
	Evidence string             `json:"evidence,omitempty"`
	Origins  []Origin           `json:"origins"`
	Widening *Widening          `json:"widening,omitempty"`
	// Boundary is true when the guard reads the contract directly.
	Boundary bool `json:"boundary"`
	// Origin is "contract" or "inferred": which source supplied the
	// guarantee.
	Origin string `json:"origin"`
}

// Fingerprint identifies the finding across edits: the guard text, the
// contract it disagrees with, and the kind of guarantee. Not the line.
func (f DeadGuard) Fingerprint() string {
	return f.Guard + " :: " + f.Contract + " :: " + string(f.Kind)
}

// WideningFinding is a declaration wider than every value that reaches it.
type WideningFinding struct {
	File      string          `json:"file"`
	Line      int             `json:"line"`
	Declared  string          `json:"declared"`
	Type      string          `json:"type"`
	Suggested string          `json:"suggested"`
	Contract  string          `json:"contract"`
	Kind      constraint.Kind `json:"kind"`
	Why       string          `json:"why"`
	Origins   []Origin        `json:"origins"`
	Origin    string          `json:"origin"`
}

// Fingerprint mirrors the upstream tool: declaration, declared type,
// contract field and kind.
func (f WideningFinding) Fingerprint() string {
	return f.Declared + " :: " + f.Type + " :: " + f.Contract + " :: " + string(f.Kind)
}

func toOrigins(os []origin) []Origin {
	out := make([]Origin, 0, len(os))
	for _, o := range os {
		out = append(out, Origin{File: o.file, Line: o.line, Text: o.text, Field: o.field})
	}
	return out
}

// contractOf names what a finding disagrees with: the contract field for a
// contract guarantee, the program's own type for an inferred one.
func contractOf(os []origin, g constraint.Guarantee) string {
	if len(os) > 0 && g.Origin == constraint.OriginContract {
		return os[0].field
	}
	if g.EnumType != "" {
		return g.EnumType
	}
	return "(inferred " + string(g.Kind) + ")"
}

func typeString(t types.Type) string {
	return types.TypeString(t, func(p *types.Package) string { return p.Name() })
}

func sortDeadGuards(fs []DeadGuard) {
	sort.Slice(fs, func(i, j int) bool {
		if fs[i].File != fs[j].File {
			return fs[i].File < fs[j].File
		}
		if fs[i].Line != fs[j].Line {
			return fs[i].Line < fs[j].Line
		}
		return fs[i].Guard < fs[j].Guard
	})
}

func sortWidenings(fs []WideningFinding) {
	sort.Slice(fs, func(i, j int) bool {
		if fs[i].File != fs[j].File {
			return fs[i].File < fs[j].File
		}
		if fs[i].Line != fs[j].Line {
			return fs[i].Line < fs[j].Line
		}
		return fs[i].Declared < fs[j].Declared
	})
}
