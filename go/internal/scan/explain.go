package scan

import (
	"fmt"
	"sort"
	"strings"

	"github.com/ufs-lab/contract-fidelity/go/internal/constraint"
)

// CarrierReport is the census view of one carrier, for `explain`: why a
// guard was or was not reported starts with what reached the value.
type CarrierReport struct {
	Name         string   `json:"name"`
	Kind         string   `json:"kind"`
	Type         string   `json:"type"`
	File         string   `json:"file"`
	Line         int      `json:"line"`
	Disqualified string   `json:"disqualified,omitempty"`
	Resolved     bool     `json:"resolved"`
	FromContract bool     `json:"fromContract"`
	Guarantees   []string `json:"guarantees"`
	Writes       []string `json:"writes"`
}

// Explain lists every carrier whose name contains match, with its writes
// and the verdict the census reached.
func (p *Program) Explain(match string) []CarrierReport {
	var out []CarrierReport
	for _, c := range p.carriers {
		if !strings.Contains(c.name, match) {
			continue
		}
		r := CarrierReport{
			Name:         c.name,
			Kind:         string(c.kind),
			Type:         typeString(c.declType),
			File:         p.relPath(c.pos.Filename),
			Line:         c.pos.Line,
			Disqualified: c.disqualified,
			Resolved:     c.resolvedOK,
			FromContract: c.fromContract,
		}
		for _, g := range c.resolved {
			r.Guarantees = append(r.Guarantees, describe(g))
		}
		for _, w := range c.writes {
			v := p.writeValue(c, w)
			state := "unknown"
			if v.ok {
				state = "known"
				if len(v.gs) > 0 {
					state += " " + describe(v.gs[0])
				}
			}
			tag := ""
			if w.test {
				tag = " [test]"
			}
			r.Writes = append(r.Writes, fmt.Sprintf("%s:%d `%s`%s -> %s", p.relPath(w.pos.Filename), w.pos.Line, w.text, tag, state))
		}
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].File != out[j].File {
			return out[i].File < out[j].File
		}
		return out[i].Line < out[j].Line
	})
	return out
}

func describe(g constraint.Guarantee) string {
	switch {
	case g.Kind == constraint.KindEnumMember:
		return fmt.Sprintf("%s{%s}", g.Kind, strings.Join(g.Members, "|"))
	case g.IsNumeric() || g.Kind == constraint.KindNonEmptyArray:
		s := fmt.Sprintf("%s%s", g.Kind, g.Interval)
		if g.IntType != "" {
			s += " " + g.IntType
		}
		return s
	}
	return string(g.Kind)
}
