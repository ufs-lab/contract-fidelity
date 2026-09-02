// Package plan groups findings into work items: what one person or one
// agent fixes in one change. Findings that disagree with the same contract
// field are one item; items that touch the same file are merged, so two
// fixes never edit one file; and a guard on a direct contract read is a
// ruling for a person, kept apart from the fixes.
package plan

import (
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"strings"

	"github.com/ufs-lab/contract-fidelity/go/internal/constraint"
	"github.com/ufs-lab/contract-fidelity/go/internal/scan"
)

// Kinds of work item.
const (
	// KindFix is a change the contract already justifies: delete the guard,
	// narrow the declaration.
	KindFix = "fix"
	// KindRuling is a guard on a direct contract read. The code keeps it on
	// purpose against a server that breaks its own contract, or it is dead;
	// a person decides which.
	KindRuling = "ruling"
)

// Item is one unit of work.
type Item struct {
	// ID is stable across runs and edits: a hash of the kind and the
	// contract keys, not of lines or files.
	ID        string                 `json:"id"`
	Kind      string                 `json:"kind"`
	Contracts []string               `json:"contracts"`
	Files     []string               `json:"files"`
	Dead      []scan.DeadGuard       `json:"dead"`
	Widening  []scan.WideningFinding `json:"widening"`
}

// Plan is every work item for one consumer module.
type Plan struct {
	Module string `json:"module"`
	Items  []Item `json:"items"`
}

// Counts reports how many items of each kind the plan holds.
func (p Plan) Counts() (fix, ruling int) {
	for _, it := range p.Items {
		if it.Kind == KindRuling {
			ruling++
		} else {
			fix++
		}
	}
	return fix, ruling
}

// Build groups the findings of one program.
func Build(module string, dead []scan.DeadGuard, wide []scan.WideningFinding) Plan {
	fixes := newPartition(KindFix)
	rulings := newPartition(KindRuling)
	for _, d := range dead {
		part := fixes
		if d.Boundary {
			part = rulings
		}
		g := part.group(keyOf(d.Origin, d.Contract, d.File, d.Fingerprint()))
		g.dead = append(g.dead, d)
		g.files[d.File] = true
	}
	for _, w := range wide {
		g := fixes.group(keyOf(w.Origin, w.Contract, w.File, w.Fingerprint()))
		g.wide = append(g.wide, w)
		g.files[w.File] = true
	}
	items := append(fixes.items(), rulings.items()...)
	if items == nil {
		items = []Item{}
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].Kind != items[j].Kind {
			return items[i].Kind == KindFix
		}
		if items[i].Files[0] != items[j].Files[0] {
			return items[i].Files[0] < items[j].Files[0]
		}
		return items[i].ID < items[j].ID
	})
	return Plan{Module: module, Items: items}
}

// keyOf names what a finding disagrees with. A contract finding is keyed
// by its contract field, so every carrier of one field is one item. An
// inferred finding names no field; its key is its own file and
// fingerprint, so unrelated inferred guards stay apart unless a file joins
// them.
func keyOf(origin, contract, file, fingerprint string) string {
	if origin == constraint.OriginContract || !strings.HasPrefix(contract, "(inferred") {
		return contract
	}
	return file + " " + fingerprint
}

type group struct {
	keys  map[string]bool
	files map[string]bool
	dead  []scan.DeadGuard
	wide  []scan.WideningFinding
}

// partition is one kind's groups, merged by shared file before they become
// items.
type partition struct {
	kind   string
	groups map[string]*group
}

func newPartition(kind string) *partition {
	return &partition{kind: kind, groups: map[string]*group{}}
}

func (p *partition) group(key string) *group {
	g, ok := p.groups[key]
	if !ok {
		g = &group{keys: map[string]bool{key: true}, files: map[string]bool{}}
		p.groups[key] = g
	}
	return g
}

// items merges groups that share a file (union-find on the group keys) and
// turns each merged set into an Item.
func (p *partition) items() []Item {
	keys := sortedKeys(p.groups)
	parent := map[string]string{}
	for _, k := range keys {
		parent[k] = k
	}
	var find func(string) string
	find = func(k string) string {
		if parent[k] != k {
			parent[k] = find(parent[k])
		}
		return parent[k]
	}
	byFile := map[string]string{}
	for _, k := range keys {
		for f := range p.groups[k].files {
			if other, ok := byFile[f]; ok {
				parent[find(k)] = find(other)
				continue
			}
			byFile[f] = k
		}
	}
	merged := map[string]*group{}
	for _, k := range keys {
		root := find(k)
		m, ok := merged[root]
		if !ok {
			m = &group{keys: map[string]bool{}, files: map[string]bool{}}
			merged[root] = m
		}
		g := p.groups[k]
		for kk := range g.keys {
			m.keys[kk] = true
		}
		for f := range g.files {
			m.files[f] = true
		}
		m.dead = append(m.dead, g.dead...)
		m.wide = append(m.wide, g.wide...)
	}
	out := make([]Item, 0, len(merged))
	for _, m := range merged {
		out = append(out, p.item(m))
	}
	return out
}

func (p *partition) item(g *group) Item {
	contracts := sortedKeys(g.keys)
	files := sortedKeys(g.files)
	sort.Slice(g.dead, func(i, j int) bool {
		a, b := g.dead[i], g.dead[j]
		if a.File != b.File {
			return a.File < b.File
		}
		if a.Line != b.Line {
			return a.Line < b.Line
		}
		return a.Guard < b.Guard
	})
	sort.Slice(g.wide, func(i, j int) bool {
		a, b := g.wide[i], g.wide[j]
		if a.File != b.File {
			return a.File < b.File
		}
		if a.Line != b.Line {
			return a.Line < b.Line
		}
		return a.Declared < b.Declared
	})
	dead := g.dead
	if dead == nil {
		dead = []scan.DeadGuard{}
	}
	wide := g.wide
	if wide == nil {
		wide = []scan.WideningFinding{}
	}
	return Item{
		ID:        idOf(p.kind, contracts),
		Kind:      p.kind,
		Contracts: contracts,
		Files:     files,
		Dead:      dead,
		Widening:  wide,
	}
}

// idOf hashes the kind and the contract keys. Lines and files stay out of
// it: an edit above a finding or a move between files is the same work.
func idOf(kind string, contracts []string) string {
	h := sha256.New()
	h.Write([]byte(kind))
	for _, c := range contracts {
		h.Write([]byte{'\n'})
		h.Write([]byte(c))
	}
	return hex.EncodeToString(h.Sum(nil))[:10]
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
