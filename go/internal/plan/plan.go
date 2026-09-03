// Package plan groups findings into work items: what one person or one
// agent fixes in one change. Findings that disagree with the same contract
// field are one item, and items that touch the same file are merged, so
// two fixes never edit one file.
package plan

import (
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"strings"

	"github.com/ufs-lab/contract-fidelity/go/internal/constraint"
	"github.com/ufs-lab/contract-fidelity/go/internal/scan"
)

// Item is one unit of work.
type Item struct {
	// ID is stable across runs and edits: a hash of the contract keys, not
	// of lines or files.
	ID        string                 `json:"id"`
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

// Build groups the findings of one program.
func Build(module string, dead []scan.DeadGuard, wide []scan.WideningFinding) Plan {
	groups := map[string]*group{}
	get := func(key string) *group {
		g, ok := groups[key]
		if !ok {
			g = &group{keys: map[string]bool{key: true}, files: map[string]bool{}}
			groups[key] = g
		}
		return g
	}
	for _, d := range dead {
		g := get(keyOf(d.Origin, d.Contract, d.File, d.Fingerprint()))
		g.dead = append(g.dead, d)
		g.files[d.File] = true
	}
	for _, w := range wide {
		g := get(keyOf(w.Origin, w.Contract, w.File, w.Fingerprint()))
		g.wide = append(g.wide, w)
		g.files[w.File] = true
	}
	items := mergeByFile(groups)
	sort.Slice(items, func(i, j int) bool {
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

// mergeByFile joins groups that share a file (union-find on the group
// keys) and turns each joined set into an Item.
func mergeByFile(groups map[string]*group) []Item {
	keys := sortedKeys(groups)
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
		for f := range groups[k].files {
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
		g := groups[k]
		for kk := range g.keys {
			m.keys[kk] = true
		}
		for f := range g.files {
			m.files[f] = true
		}
		m.dead = append(m.dead, g.dead...)
		m.wide = append(m.wide, g.wide...)
	}
	items := make([]Item, 0, len(merged))
	for _, m := range merged {
		items = append(items, item(m))
	}
	return items
}

func item(g *group) Item {
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
	return Item{ID: idOf(contracts), Contracts: contracts, Files: files, Dead: dead, Widening: wide}
}

// idOf hashes the contract keys. Lines and files stay out of it: an edit
// above a finding or a move between files is the same work.
func idOf(contracts []string) string {
	h := sha256.New()
	for _, c := range contracts {
		h.Write([]byte(c))
		h.Write([]byte{'\n'})
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
