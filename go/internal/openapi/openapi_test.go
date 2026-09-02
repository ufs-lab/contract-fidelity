package openapi

import (
	"path/filepath"
	"testing"
)

func TestGoTypeName(t *testing.T) {
	cases := map[string]string{
		"CursorOffsetResponse[AccountResponse]": "CursorOffsetResponseAccountResponse",
		"BatchEventError":                       "BatchEventError",
		"account_error_schema":                  "AccountErrorSchema",
		"KYCStatus":                             "KYCStatus",
	}
	for in, want := range cases {
		if got := GoTypeName(in); got != want {
			t.Errorf("%s: got %s, want %s", in, got, want)
		}
	}
}

func TestLoadFixture(t *testing.T) {
	spec, found, err := Load(filepath.Join("..", "..", "testdata", "client"))
	if err != nil || !found {
		t.Fatalf("load: found=%v err=%v", found, err)
	}
	p, ok := spec.Property("BatchError", "status")
	if !ok || p.Minimum == nil || *p.Minimum != 400 || p.Maximum == nil || *p.Maximum != 599 {
		t.Fatalf("BatchError.status bounds: %+v", p)
	}
	items, ok := spec.Property("BatchResult", "items")
	if !ok || items.MinItems == nil || *items.MinItems != 1 {
		t.Fatalf("BatchResult.items minItems: %+v", items)
	}
	if _, found, err := Load(t.TempDir()); err != nil || found {
		t.Fatal("a directory without a spec is not an error")
	}
}
