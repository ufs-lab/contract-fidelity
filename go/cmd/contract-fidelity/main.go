// Command contract-fidelity finds defensive Go code that guards a value the
// generated OpenAPI client already decided, and the type widening that made
// the guard look necessary.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/ufs-lab/contract-fidelity/go/internal/config"
	"github.com/ufs-lab/contract-fidelity/go/internal/plan"
	"github.com/ufs-lab/contract-fidelity/go/internal/ratchet"
	"github.com/ufs-lab/contract-fidelity/go/internal/scan"
)

const usage = `usage: contract-fidelity <command> [flags]

commands:
  dead-code      a guarantee was dropped, and code downstream guards a value that cannot arrive
  widening       a declaration is wider than every value that reaches it
  contracts      every guarantee the tool read off the generated client
  plan           the findings grouped into work items: one per contract field, merged by shared file
  explain NAME   the census of every carrier whose name contains NAME

flags:
  -dir DIR               consumer module root (default: current directory)
  -config FILE           config file (default: DIR/contract-fidelity.config.json)
  -list                  print every finding with context
  -json                  machine-readable output
  -exclude-boundary-checks
                         drop guards that read the contract directly (dead-code)
  -update-baseline       ratchet the baseline down
  -force                 allow -update-baseline to add findings (re-seed)
  -census-tests=false    ignore writes made in test files (override the config)
`

type flags struct {
	dir, configPath               string
	list, asJSON, excludeBoundary bool
	updateBaseline, force         bool
	censusTests                   string
}

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	if len(args) == 0 || args[0] == "-h" || args[0] == "--help" {
		fmt.Fprint(os.Stderr, usage)
		return 2
	}
	command := args[0]
	fs := flag.NewFlagSet(command, flag.ContinueOnError)
	var f flags
	fs.StringVar(&f.dir, "dir", ".", "")
	fs.StringVar(&f.configPath, "config", "", "")
	fs.BoolVar(&f.list, "list", false, "")
	fs.BoolVar(&f.asJSON, "json", false, "")
	fs.BoolVar(&f.excludeBoundary, "exclude-boundary-checks", false, "")
	fs.BoolVar(&f.updateBaseline, "update-baseline", false, "")
	fs.BoolVar(&f.force, "force", false, "")
	fs.StringVar(&f.censusTests, "census-tests", "", "")
	fs.Usage = func() { fmt.Fprint(os.Stderr, usage) }
	flagArgs, positional := splitArgs(normalizeFlags(args[1:]))
	if err := fs.Parse(flagArgs); err != nil {
		return 2
	}
	dir, err := filepath.Abs(f.dir)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	cfg, err := config.Load(dir, f.configPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	censusTests := cfg.Tests()
	if f.censusTests != "" {
		censusTests = f.censusTests == "true"
	}
	prog, err := scan.Load(scan.Options{
		Dir:              dir,
		Patterns:         cfg.Patterns,
		ContractPackages: cfg.ContractPackages,
		DocPatterns:      cfg.CompiledDocPatterns,
		TrustContract:    cfg.Trust(),
		ClosedWorld:      cfg.Closed(),
		CensusTests:      censusTests,
		InferConstraints: cfg.Infer(),
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	switch command {
	case "dead-code":
		return runDeadCode(prog, cfg, dir, f)
	case "widening":
		return runWidening(prog, cfg, dir, f)
	case "contracts":
		return runContracts(prog, f)
	case "plan":
		return runPlan(prog, f)
	case "explain":
		return runExplain(prog, positional, f)
	default:
		fmt.Fprintf(os.Stderr, "contract-fidelity: unknown command %q\n%s", command, usage)
		return 2
	}
}

// stringFlags take a value in the next argument when written without `=`.
var stringFlags = map[string]bool{"-dir": true, "-config": true, "-census-tests": true}

// splitArgs separates flags from positional arguments so a command can take
// its NAME before or after the flags; Go's flag package stops at the first
// positional otherwise.
func splitArgs(args []string) (flagArgs, positional []string) {
	for i := 0; i < len(args); i++ {
		a := args[i]
		if !strings.HasPrefix(a, "-") {
			positional = append(positional, a)
			continue
		}
		flagArgs = append(flagArgs, a)
		if stringFlags[a] && i+1 < len(args) {
			i++
			flagArgs = append(flagArgs, args[i])
		}
	}
	return flagArgs, positional
}

// normalizeFlags lets the GNU-style spellings the TypeScript tool uses
// (`--list`) reach Go's flag package.
func normalizeFlags(args []string) []string {
	out := make([]string, 0, len(args))
	for _, a := range args {
		if strings.HasPrefix(a, "--") {
			a = a[1:]
		}
		out = append(out, a)
	}
	return out
}

// ---------------------------------------------------------------------------
// dead-code
// ---------------------------------------------------------------------------

func runDeadCode(prog *scan.Program, cfg *config.Config, dir string, f flags) int {
	findings := prog.DeadGuards()
	if f.excludeBoundary {
		kept := findings[:0]
		for _, fd := range findings {
			if !fd.Boundary {
				kept = append(kept, fd)
			}
		}
		findings = kept
	}
	if f.asJSON {
		return printJSON(findings)
	}
	entries := make([]ratchet.Entry, 0, len(findings))
	for _, fd := range findings {
		entries = append(entries, ratchet.Entry{File: fd.File, Fingerprint: fd.Fingerprint()})
	}
	byFile := map[string][]scan.DeadGuard{}
	for _, fd := range findings {
		byFile[fd.File] = append(byFile[fd.File], fd)
	}
	print := func(files []string) {
		for _, file := range files {
			fmt.Fprintf(os.Stderr, "  %s\n", file)
			for _, fd := range byFile[file] {
				verdict := "always false"
				if fd.Verdict == "always-true" {
					verdict = "always true"
				}
				fmt.Fprintf(os.Stderr, "    %d: `%s` is %s\n", fd.Line, fd.Guard, verdict)
				fmt.Fprintf(os.Stderr, "      %s: %s - %s", fd.Origin, fd.Contract, fd.Why)
				if fd.Evidence != "" {
					fmt.Fprintf(os.Stderr, "\n      evidence: %q", fd.Evidence)
				}
				fmt.Fprintln(os.Stderr)
				for _, o := range fd.Origins {
					fmt.Fprintf(os.Stderr, "      value from: %s:%d `%s`\n", o.File, o.Line, o.Text)
				}
				if fd.Widening != nil {
					fmt.Fprintf(os.Stderr, "      widened at: %s: %s", fd.Widening.Declared, fd.Widening.Type)
					if fd.Widening.Suggested != "" {
						fmt.Fprintf(os.Stderr, " (could be %s)", fd.Widening.Suggested)
					}
					fmt.Fprintln(os.Stderr)
				}
			}
		}
	}
	return runRatchet(ratchetArgs{
		id:        "dead-code",
		baseline:  filepath.Join(dir, cfg.BaselineDir, "dead-code-baseline.json"),
		entries:   entries,
		print:     print,
		headline:  "guard(s) the contract makes dead",
		fixHint:   "Delete the guard, or narrow the declaration it defends. Do NOT add to the baseline: it only ever ratchets down.",
		list:      f.list,
		update:    f.updateBaseline,
		force:     f.force,
		fileCount: len(byFile),
	})
}

// ---------------------------------------------------------------------------
// widening
// ---------------------------------------------------------------------------

func runWidening(prog *scan.Program, cfg *config.Config, dir string, f flags) int {
	findings := prog.Widenings()
	if f.asJSON {
		return printJSON(findings)
	}
	entries := make([]ratchet.Entry, 0, len(findings))
	for _, fd := range findings {
		entries = append(entries, ratchet.Entry{File: fd.File, Fingerprint: fd.Fingerprint()})
	}
	byFile := map[string][]scan.WideningFinding{}
	for _, fd := range findings {
		byFile[fd.File] = append(byFile[fd.File], fd)
	}
	print := func(files []string) {
		for _, file := range files {
			fmt.Fprintf(os.Stderr, "  %s\n", file)
			for _, fd := range byFile[file] {
				fmt.Fprintf(os.Stderr, "    %d: `%s: %s` could be `%s`\n", fd.Line, fd.Declared, fd.Type, fd.Suggested)
				fmt.Fprintf(os.Stderr, "      %s: %s - %s\n", fd.Origin, fd.Contract, fd.Why)
				for _, o := range fd.Origins {
					fmt.Fprintf(os.Stderr, "      value from: %s:%d `%s`\n", o.File, o.Line, o.Text)
				}
			}
		}
	}
	return runRatchet(ratchetArgs{
		id:        "widening",
		baseline:  filepath.Join(dir, cfg.BaselineDir, "widening-baseline.json"),
		entries:   entries,
		print:     print,
		headline:  "declaration(s) wider than every value that reaches them",
		fixHint:   "Narrow the declaration to the type named on each finding. That is what stops the defensive check being written.",
		list:      f.list,
		update:    f.updateBaseline,
		force:     f.force,
		fileCount: len(byFile),
	})
}

// ---------------------------------------------------------------------------
// contracts
// ---------------------------------------------------------------------------

func runContracts(prog *scan.Program, f flags) int {
	ix := prog.Index()
	type row struct {
		Kind     string `json:"kind"`
		Where    string `json:"where"`
		Evidence string `json:"evidence,omitempty"`
	}
	var rows []row
	for _, field := range ix.Sorted() {
		for _, g := range field.Guarantees {
			rows = append(rows, row{Kind: string(g.Kind), Where: field.Display(), Evidence: g.Evidence})
		}
	}
	if f.asJSON {
		return printJSON(rows)
	}
	for _, r := range rows {
		fmt.Printf("%-18s %s\n", r.Kind, r.Where)
		if r.Evidence != "" && f.list {
			fmt.Printf("%19s%q\n", "", r.Evidence)
		}
	}
	fmt.Printf("\n%d guarantee(s) across %d package(s)", len(rows), len(ix.Packages))
	var noSpec []string
	for _, pkg := range ix.Packages {
		if !ix.Specs[pkg] {
			noSpec = append(noSpec, pkg)
		}
	}
	if len(noSpec) > 0 {
		fmt.Printf("; no api/openapi.yaml beside: %s", strings.Join(noSpec, ", "))
	}
	fmt.Println()
	return 0
}

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

func runPlan(prog *scan.Program, f flags) int {
	p := plan.Build(prog.ModulePath(), prog.DeadGuards(), prog.Widenings())
	if f.asJSON {
		return printJSON(p)
	}
	fmt.Printf("plan: %d work item(s) in %s\n", len(p.Items), p.Module)
	for _, it := range p.Items {
		fmt.Printf("\n%s  %s\n", it.ID, strings.Join(it.Contracts, ", "))
		fmt.Printf("    %d dead guard(s), %d widening(s)\n", len(it.Dead), len(it.Widening))
		for _, d := range it.Dead {
			fmt.Printf("    %s:%d `%s` is %s\n", d.File, d.Line, d.Guard, strings.ReplaceAll(string(d.Verdict), "-", " "))
		}
		for _, w := range it.Widening {
			fmt.Printf("    %s:%d `%s: %s` could be `%s`\n", w.File, w.Line, w.Declared, w.Type, w.Suggested)
		}
	}
	return 0
}

// ---------------------------------------------------------------------------
// explain
// ---------------------------------------------------------------------------

func runExplain(prog *scan.Program, args []string, f flags) int {
	if len(args) != 1 {
		fmt.Fprintln(os.Stderr, "contract-fidelity: explain takes one NAME to match")
		return 2
	}
	reports := prog.Explain(args[0])
	if f.asJSON {
		return printJSON(reports)
	}
	for _, r := range reports {
		fmt.Printf("%s (%s) %s\n  at %s:%d\n", r.Name, r.Kind, r.Type, r.File, r.Line)
		switch {
		case r.Disqualified != "":
			fmt.Printf("  disqualified: %s\n", r.Disqualified)
		case r.Resolved:
			fmt.Printf("  resolved: %s (origin: %s)\n", strings.Join(r.Guarantees, ", "), r.Origin)
		default:
			fmt.Println("  unresolved: a write is unknown")
		}
		for _, w := range r.Writes {
			fmt.Printf("  write: %s\n", w)
		}
	}
	fmt.Printf("\n%d carrier(s)\n", len(reports))
	return 0
}

// ---------------------------------------------------------------------------
// ratchet driver
// ---------------------------------------------------------------------------

type ratchetArgs struct {
	id, baseline      string
	entries           []ratchet.Entry
	print             func(files []string)
	headline, fixHint string
	list, update      bool
	force             bool
	fileCount         int
}

func runRatchet(a ratchetArgs) int {
	current := ratchet.Entries(a.entries)
	if a.list {
		files := sortedKeys(current)
		if len(files) == 0 {
			fmt.Fprintf(os.Stderr, "%s: no findings\n", a.id)
			return 0
		}
		fmt.Fprintf(os.Stderr, "%s: %d %s in %d file(s)\n\n", a.id, ratchet.Total(current), a.headline, len(files))
		a.print(files)
		return 0
	}
	base, err := ratchet.Read(a.baseline)
	if err != nil && !(a.update && a.force) {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	if err != nil {
		base = map[string][]string{}
	}
	added, fixed := ratchet.Diff(current, base)
	if a.update {
		if ratchet.Total(added) > 0 && !a.force {
			fmt.Fprintf(os.Stderr, "%s: refusing to add %d finding(s) to the baseline (down-only ratchet)\n\n", a.id, ratchet.Total(added))
			a.print(sortedKeys(added))
			fmt.Fprintf(os.Stderr, "\n%s\n", a.fixHint)
			return 1
		}
		if err := ratchet.Write(a.baseline, current); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 2
		}
		fmt.Fprintf(os.Stderr, "%s: baseline written with %d finding(s) (%d fixed since the last baseline)\n", a.id, ratchet.Total(current), ratchet.Total(fixed))
		return 0
	}
	if ratchet.Total(added) > 0 {
		fmt.Fprintf(os.Stderr, "%s: %d new %s\n\n", a.id, ratchet.Total(added), a.headline)
		a.print(sortedKeys(added))
		fmt.Fprintf(os.Stderr, "\n%s\n", a.fixHint)
		return 1
	}
	remaining := ratchet.Total(current)
	switch {
	case ratchet.Total(fixed) > 0:
		fmt.Fprintf(os.Stderr, "%s: clean (%d baselined finding(s) remain; %d fixed - run `contract-fidelity %s --update-baseline` to ratchet down)\n", a.id, remaining, ratchet.Total(fixed), a.id)
	case remaining > 0:
		fmt.Fprintf(os.Stderr, "%s: clean (%d baselined finding(s) remain)\n", a.id, remaining)
	default:
		fmt.Fprintf(os.Stderr, "%s: clean\n", a.id)
	}
	return 0
}

func sortedKeys(m map[string][]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func printJSON(v any) int {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	return 0
}
