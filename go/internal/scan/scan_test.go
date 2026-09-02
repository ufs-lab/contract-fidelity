package scan

import (
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/ufs-lab/contract-fidelity/go/internal/constraint"
)

func load(t *testing.T, censusTests bool) *Program {
	t.Helper()
	dir, err := filepath.Abs(filepath.Join("..", "..", "testdata", "consumer"))
	if err != nil {
		t.Fatal(err)
	}
	p, err := Load(Options{
		Dir:              dir,
		Patterns:         []string{"./app/..."},
		ContractPackages: []string{"example.com/client"},
		TrustContract:    true,
		ClosedWorld:      true,
		CensusTests:      censusTests,
	})
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func guards(p *Program) []string {
	var out []string
	for _, f := range p.DeadGuards() {
		out = append(out, f.Guard+" -> "+string(f.Verdict))
	}
	sort.Strings(out)
	return out
}

func TestContractIndex(t *testing.T) {
	p := load(t, true)
	ix := p.Index()
	f, ok := ix.Lookup("example.com/client", "BatchError", "Status")
	if !ok {
		t.Fatal("BatchError.Status not indexed")
	}
	kinds := map[constraint.Kind]bool{}
	for _, g := range f.Guarantees {
		kinds[g.Kind] = true
	}
	if !kinds[constraint.KindRange] || !kinds[constraint.KindIntegerWidth] || !kinds[constraint.KindRequiredNonNull] {
		t.Fatalf("BatchError.Status guarantees: %+v", f.Guarantees)
	}
	if _, ok := ix.LookupEnum("example.com/client", "ResultStatus"); !ok {
		t.Fatal("ResultStatus with a strict UnmarshalJSON is an enum")
	}
	if _, ok := ix.LookupEnum("example.com/client", "LooseStatus"); ok {
		t.Fatal("LooseStatus without a strict decode is not an enum")
	}
	amount, _ := ix.Lookup("example.com/client", "Movement", "Amount")
	if _, ok := constraint.Has(amount.Guarantees, constraint.KindPositive); !ok {
		t.Fatalf("Movement.Amount prose: %+v", amount.Guarantees)
	}
	errField, _ := ix.Lookup("example.com/client", "BatchResult", "Error")
	if errField.Required || !errField.Optional {
		t.Fatal("a pointer with omitempty is optional")
	}
}

func TestDeadGuardsWithTestWriters(t *testing.T) {
	got := guards(load(t, true))
	// `c.ID` is guarded in narrow and in registry.lookup; a field carrier
	// is per type, so both are dead.
	want := []string{
		"c.ID > 2147483647 -> always-false",
		"c.ID > 2147483647 -> always-false",
		"idx < 0 -> always-false",
		"len(r.Items) == 0 -> always-false",
		"m.Amount > 0 -> always-true",
		"status <= 599 -> always-true",
		"status >= 400 -> always-true",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("dead guards (census with tests):\n got %v\nwant %v", got, want)
	}
}

func TestDeadGuardsWithoutTestWriters(t *testing.T) {
	got := guards(load(t, false))
	// The test file writes `view{Status: "PARTIAL"}`; without it the
	// default branch becomes unreachable. `site > 100` stays undecided
	// either way: an int32 width says nothing about 100.
	want := []string{
		"c.ID > 2147483647 -> always-false",
		"c.ID > 2147483647 -> always-false",
		"idx < 0 -> always-false",
		"len(r.Items) == 0 -> always-false",
		"m.Amount > 0 -> always-true",
		"status <= 599 -> always-true",
		"status >= 400 -> always-true",
		"switch v.Status { default: } -> always-false",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("dead guards (census without tests):\n got %v\nwant %v", got, want)
	}
}

func TestWidenings(t *testing.T) {
	var got []string
	for _, f := range load(t, false).Widenings() {
		got = append(got, f.Declared+": "+f.Type+" -> "+f.Suggested)
	}
	sort.Strings(got)
	// A struct-typed carrier (`project: v: view`) never widens: only a
	// basic declaration can be narrowed to a named type or width.
	want := []string{
		"code.ID: int64 -> int32",
		"index result 0: int -> int32",
		"index: idx: int -> int32",
		"isDeclared(status): int -> int32",
		"liveParam(site): int -> int32",
		"view.Index: int -> int32",
		"view.Status: string -> client.ResultStatus",
		"viewErr.Status: int -> int32",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("widenings:\n got %v\nwant %v", got, want)
	}
}

func TestBoundaryFlag(t *testing.T) {
	for _, f := range load(t, true).DeadGuards() {
		direct := strings.HasPrefix(f.Guard, "len(r.Items)") || strings.HasPrefix(f.Guard, "m.Amount")
		if f.Boundary != direct {
			t.Errorf("%s: boundary=%v", f.Guard, f.Boundary)
		}
	}
}

func TestFingerprintOmitsTheLine(t *testing.T) {
	for _, f := range load(t, true).DeadGuards() {
		if strings.Contains(f.Fingerprint(), ":") && strings.Contains(f.Fingerprint(), ".go") {
			t.Fatalf("fingerprint carries a location: %s", f.Fingerprint())
		}
	}
}
