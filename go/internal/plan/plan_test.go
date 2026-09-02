package plan

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/ufs-lab/contract-fidelity/go/internal/constraint"
	"github.com/ufs-lab/contract-fidelity/go/internal/scan"
)

func dead(file string, line int, guard, contract string, boundary bool) scan.DeadGuard {
	origin := constraint.OriginContract
	if contract == "(inferred required-non-null)" {
		origin = constraint.OriginInferred
	}
	return scan.DeadGuard{
		File: file, Line: line, Guard: guard, Verdict: constraint.AlwaysFalse,
		Contract: contract, Kind: constraint.KindIntegerWidth, Boundary: boundary, Origin: origin,
	}
}

func wide(file string, line int, declared, contract string) scan.WideningFinding {
	return scan.WideningFinding{
		File: file, Line: line, Declared: declared, Type: "int64", Suggested: "int32",
		Contract: contract, Kind: constraint.KindIntegerWidth, Origin: constraint.OriginContract,
	}
}

func fixture() ([]scan.DeadGuard, []scan.WideningFinding) {
	deads := []scan.DeadGuard{
		dead("svc/client.go", 245, "req.ID > math.MaxInt32", "client.Account.id", false),
		dead("svc/client.go", 352, "body.CreatedIds == nil", "client.Bulk.created_ids", true),
		dead("svc/client.go", 543, "body.CreatedIds == nil", "client.Bulk.created_ids", true),
		dead("ingest/classify.go", 163, "status <= 599", "client.Error.status", false),
		dead("ingest/client.go", 485, "len(r.Results) == 0", "client.Batch.results", true),
		dead("boot/boot.go", 1543, "a.done != nil", "(inferred required-non-null)", false),
		dead("fix/fix.go", 159, "items == nil", "(inferred required-non-null)", false),
	}
	wides := []scan.WideningFinding{
		wide("svc/types.go", 36, "Request.ID", "client.Account.id"),
		wide("svc/types.go", 80, "Request.Code", "client.Account.code"),
		wide("prov/ports.go", 55, "Ports.ID", "client.Account.id"),
		wide("ingest/classify.go", 25, "wire.Index", "client.Result.index"),
		wide("ingest/client.go", 521, "parse: idx", "client.Result.index"),
	}
	return deads, wides
}

func summary(p Plan) []string {
	var out []string
	for _, it := range p.Items {
		b, _ := json.Marshal(struct {
			Contracts []string
			Files     []string
			Dead      int
			Wide      int
		}{it.Contracts, it.Files, len(it.Dead), len(it.Widening)})
		out = append(out, string(b))
	}
	return out
}

func TestBuildGroupsByContractAndFile(t *testing.T) {
	deads, wides := fixture()
	p := Build("example.com/consumer", deads, wides)
	if p.Module != "example.com/consumer" {
		t.Fatalf("module: %q", p.Module)
	}
	want := []string{
		// A file (boot.go) alone: an inferred guard is its own item.
		`{"Contracts":["boot/boot.go a.done != nil :: (inferred required-non-null) :: integer-width"],"Files":["boot/boot.go"],"Dead":1,"Wide":0}`,
		// The second inferred guard shares the contract text but not a file: apart.
		`{"Contracts":["fix/fix.go items == nil :: (inferred required-non-null) :: integer-width"],"Files":["fix/fix.go"],"Dead":1,"Wide":0}`,
		// status, index and the boundary check on results share files under ingest/: one item.
		`{"Contracts":["client.Batch.results","client.Error.status","client.Result.index"],"Files":["ingest/classify.go","ingest/client.go"],"Dead":2,"Wide":2}`,
		// id, code and the boundary checks on created_ids share svc/client.go and types.go: one item.
		`{"Contracts":["client.Account.code","client.Account.id","client.Bulk.created_ids"],"Files":["prov/ports.go","svc/client.go","svc/types.go"],"Dead":3,"Wide":3}`,
	}
	got := summary(p)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("items:\n got %v\nwant %v", got, want)
	}
}

func TestIDsAreStableAndDistinct(t *testing.T) {
	deads, wides := fixture()
	a := Build("m", deads, wides)
	// Reverse the input order: the same items, the same ids.
	rd := make([]scan.DeadGuard, len(deads))
	for i, d := range deads {
		rd[len(deads)-1-i] = d
	}
	rw := make([]scan.WideningFinding, len(wides))
	for i, w := range wides {
		rw[len(wides)-1-i] = w
	}
	b := Build("m", rd, rw)
	if !reflect.DeepEqual(a, b) {
		t.Fatalf("plan depends on input order:\n%+v\n%+v", summary(a), summary(b))
	}
	seen := map[string]bool{}
	for _, it := range a.Items {
		if len(it.ID) != 10 {
			t.Fatalf("id %q", it.ID)
		}
		if seen[it.ID] {
			t.Fatalf("duplicate id %s", it.ID)
		}
		seen[it.ID] = true
	}
	// A fixed line moves the finding; the id does not follow.
	moved := append([]scan.DeadGuard{}, deads...)
	moved[0].Line = 999
	c := Build("m", moved, wides)
	if c.Items[3].ID != a.Items[3].ID {
		t.Fatalf("id changed with a line: %s vs %s", c.Items[3].ID, a.Items[3].ID)
	}
	// Two guards on one contract field in different files are one item.
	d := Build("m", []scan.DeadGuard{
		dead("a.go", 1, "x == nil", "client.X.y", false),
		dead("b.go", 1, "x == nil", "client.X.y", true),
	}, nil)
	if len(d.Items) != 1 || len(d.Items[0].Files) != 2 {
		t.Fatalf("one contract field is one item: %+v", summary(d))
	}
}

func TestEmptyFindingsMarshalAsArrays(t *testing.T) {
	p := Build("m", nil, []scan.WideningFinding{wide("a.go", 1, "A.b", "client.A.b")})
	raw, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	if want := `"dead":[]`; !strings.Contains(string(raw), want) {
		t.Fatalf("no %s in %s", want, raw)
	}
	empty := Build("m", nil, nil)
	if empty.Items == nil || len(empty.Items) != 0 {
		t.Fatalf("empty plan: %+v", empty)
	}
}
