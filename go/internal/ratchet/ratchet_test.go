package ratchet

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEntriesNumberRepeats(t *testing.T) {
	got := Entries([]Entry{
		{File: "a.go", Fingerprint: "x :: c :: k"},
		{File: "a.go", Fingerprint: "x :: c :: k"},
		{File: "b.go", Fingerprint: "y :: c :: k"},
	})
	if len(got["a.go"]) != 2 || got["a.go"][1] != "x :: c :: k #2" {
		t.Fatalf("repeats must be numbered: %v", got["a.go"])
	}
}

func TestDiffIsASetNotACount(t *testing.T) {
	base := map[string][]string{"a.go": {"old :: c :: k"}}
	current := map[string][]string{"a.go": {"new :: c :: k"}}
	added, fixed := Diff(current, base)
	if Total(added) != 1 || Total(fixed) != 1 {
		t.Fatalf("swapping one finding for another is one added and one fixed: %v %v", added, fixed)
	}
}

func TestWriteReadRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".contract-fidelity", "dead-code-baseline.json")
	in := map[string][]string{"b.go": {"z"}, "a.go": {"y", "x"}, "empty.go": {}}
	if err := Write(path, in); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	if !strings.Contains(string(raw), `"version": 2`) || strings.Contains(string(raw), "empty.go") {
		t.Fatalf("unexpected baseline body:\n%s", raw)
	}
	out, err := Read(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 2 || out["a.go"][0] != "x" {
		t.Fatalf("round trip lost order or files: %v", out)
	}
}

func TestReadRejectsVersionOne(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old.json")
	_ = os.WriteFile(path, []byte(`{"a.go": 3}`), 0o644)
	if _, err := Read(path); err == nil {
		t.Fatal("a version 1 baseline must be refused")
	}
	if got, err := Read(filepath.Join(t.TempDir(), "missing.json")); err != nil || len(got) != 0 {
		t.Fatal("a missing baseline is empty")
	}
}
