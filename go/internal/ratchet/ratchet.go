// Package ratchet is the down-only baseline shared with the TypeScript
// tool: the same version-2 JSON, a SET of fingerprints per file rather than
// a count, so fixing one finding and adding another in the same file is
// still a new finding. A fingerprint omits the line number, which churns
// on every edit above it.
package ratchet

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
)

// FormatVersion is the baseline schema the TypeScript tool writes.
const FormatVersion = 2

// Entry is one finding's identity: the file it lives in and its
// line-free fingerprint.
type Entry struct {
	File        string
	Fingerprint string
}

type baseline struct {
	Version  int                 `json:"version"`
	Findings map[string][]string `json:"findings"`
}

// ErrOldFormat marks a version-1 baseline (a bare {file: count} map).
var ErrOldFormat = errors.New("baseline is not a version 2 baseline; re-seed it with --update-baseline --force")

// Read loads a baseline. A missing file is an empty baseline.
func Read(path string) (map[string][]string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string][]string{}, nil
		}
		return nil, err
	}
	var b baseline
	if err := json.Unmarshal(raw, &b); err != nil || b.Version != FormatVersion {
		return nil, fmt.Errorf("%s: %w", path, ErrOldFormat)
	}
	if b.Findings == nil {
		b.Findings = map[string][]string{}
	}
	return b.Findings, nil
}

// Write stores the baseline, files and entries sorted.
func Write(path string, findings map[string][]string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	out := map[string][]string{}
	for file, entries := range findings {
		if len(entries) == 0 {
			continue
		}
		sorted := append([]string(nil), entries...)
		sort.Strings(sorted)
		out[file] = sorted
	}
	// The TypeScript tool writes the same file with JSON.stringify, which
	// leaves `<`, `>` and `&` alone; Go's default HTML escaping would make
	// the two tools disagree on a fingerprint like `idx < 0`.
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(baseline{Version: FormatVersion, Findings: out}); err != nil {
		return err
	}
	return os.WriteFile(path, buf.Bytes(), 0o644)
}

// Entries turns findings into fingerprints per file. Two identical guards
// on the same contract in one file are distinct findings, so repeats are
// numbered: the set shrinks by one when one of them goes.
func Entries(items []Entry) map[string][]string {
	out := map[string][]string{}
	seen := map[string]int{}
	for _, it := range items {
		key := it.File + " :: " + it.Fingerprint
		seen[key]++
		fp := it.Fingerprint
		if n := seen[key]; n > 1 {
			fp = fmt.Sprintf("%s #%d", fp, n)
		}
		out[it.File] = append(out[it.File], fp)
	}
	return out
}

// Diff splits the current entries into those the baseline already holds
// and those it does not, and lists baselined entries that no longer occur.
func Diff(current, base map[string][]string) (added, fixed map[string][]string) {
	added = map[string][]string{}
	fixed = map[string][]string{}
	for file, entries := range current {
		known := set(base[file])
		for _, e := range entries {
			if !known[e] {
				added[file] = append(added[file], e)
			}
		}
	}
	for file, entries := range base {
		now := set(current[file])
		for _, e := range entries {
			if !now[e] {
				fixed[file] = append(fixed[file], e)
			}
		}
	}
	return added, fixed
}

// Total counts entries across files.
func Total(m map[string][]string) int {
	n := 0
	for _, entries := range m {
		n += len(entries)
	}
	return n
}

func set(entries []string) map[string]bool {
	out := make(map[string]bool, len(entries))
	for _, e := range entries {
		out[e] = true
	}
	return out
}
