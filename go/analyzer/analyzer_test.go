package analyzer_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// TestGoVet builds the vet tool and runs it over the fixture consumer the
// way a CI step would: every finding the CLI reports for a file must come
// out of `go vet` as a diagnostic on that file.
func TestGoVet(t *testing.T) {
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("no go toolchain")
	}
	tmp := t.TempDir()
	bin := filepath.Join(tmp, "contract-fidelity-vet")
	build := exec.Command("go", "build", "-o", bin, "../cmd/contract-fidelity-vet")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}
	consumer, err := filepath.Abs(filepath.Join("..", "testdata", "consumer"))
	if err != nil {
		t.Fatal(err)
	}
	run := func(extra ...string) string {
		args := append([]string{"vet", "-vettool=" + bin}, extra...)
		args = append(args, "./...")
		cmd := exec.Command("go", args...)
		cmd.Dir = consumer
		cmd.Env = append(os.Environ(), "XDG_CACHE_HOME="+tmp)
		out, _ := cmd.CombinedOutput()
		return string(out)
	}
	out := run("-cache-dir=" + filepath.Join(tmp, "cache"))
	want := []string{
		"app/app.go:", "`idx < 0` is always false",
		"`status >= 400` is always true",
		"`r.Items == nil` is always false",
		"`switch r.Outcome { default: }` is always false (inferred: app.outcome",
		"`report.Outcome: string` could be `app.outcome` (inferred: app.outcome)",
	}
	for _, w := range want {
		if !strings.Contains(out, w) {
			t.Errorf("go vet output lacks %q:\n%s", w, out)
		}
	}
	if strings.Contains(out, "app_test.go") {
		t.Errorf("a test file is never a violation site:\n%s", out)
	}
	// The second run hits the cache and reports the same findings.
	again := run("-cache-dir=" + filepath.Join(tmp, "cache"))
	if again != out {
		t.Errorf("cached run differs:\n--- first\n%s\n--- second\n%s", out, again)
	}
	// Checks can be switched off one at a time.
	noWide := run("-widening=false", "-cache-dir="+filepath.Join(tmp, "cache"))
	if strings.Contains(noWide, "` could be `") || !strings.Contains(noWide, "is always") {
		t.Errorf("-widening=false: %s", noWide)
	}
}
