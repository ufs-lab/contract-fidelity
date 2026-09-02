// Package analyzer exposes contract-fidelity as a go/analysis Analyzer, so
// the checks run under `go vet -vettool` and as a golangci-lint module
// plugin.
//
// The analysis is whole-program: a guard is dead only when every writer in
// the program agrees, and go/analysis visits one package at a time. So the
// analyzer loads the whole program once per configuration root and reports,
// for each package it visits, the findings that fall in that package's
// files. Under `go vet` every package is a fresh process, so the findings
// are cached on disk keyed by the module's Go sources; a run over N packages
// loads the program once, not N times.
package analyzer

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"golang.org/x/tools/go/analysis"

	"github.com/ufs-lab/contract-fidelity/go/internal/config"
	"github.com/ufs-lab/contract-fidelity/go/internal/scan"
)

// Analyzer is the go/analysis entry point.
var Analyzer = &analysis.Analyzer{
	Name: "contractfidelity",
	Doc:  "reports defensive code that guards a value the generated OpenAPI client already decided, and the widening that made the guard look necessary",
	Run:  run,
}

var (
	configPath   string
	reportDead   = true
	reportWide   = true
	useCache     = true
	censusTests  string
	cacheDirFlag string
)

func init() {
	Analyzer.Flags.StringVar(&configPath, "config", "", "config file (default: contract-fidelity.config.json found upward from the package)")
	Analyzer.Flags.BoolVar(&reportDead, "dead-code", true, "report dead guards")
	Analyzer.Flags.BoolVar(&reportWide, "widening", true, "report widened declarations")
	Analyzer.Flags.BoolVar(&useCache, "cache", true, "cache findings on disk keyed by the module's Go sources")
	Analyzer.Flags.StringVar(&censusTests, "census-tests", "", "true or false: override censusTests from the config")
	Analyzer.Flags.StringVar(&cacheDirFlag, "cache-dir", "", "cache directory (default: the user cache dir)")
}

// Findings is what one program load produces, in the shape the cache
// stores.
type Findings struct {
	Dead []scan.DeadGuard       `json:"dead"`
	Wide []scan.WideningFinding `json:"widening"`
}

var (
	loadMu   sync.Mutex
	loaded   = map[string]*Findings{}
	loadErrs = map[string]error{}
)

func run(pass *analysis.Pass) (any, error) {
	if len(pass.Files) == 0 {
		return nil, nil
	}
	first := pass.Fset.File(pass.Files[0].Pos())
	if first == nil {
		return nil, nil
	}
	root, cfgPath, err := findRoot(filepath.Dir(first.Name()))
	if err != nil {
		// A package outside any configured root has no contract to check.
		return nil, nil
	}
	findings, err := findingsFor(root, cfgPath)
	if err != nil {
		return nil, err
	}
	byFile := map[string]*token.File{}
	for _, f := range pass.Files {
		tf := pass.Fset.File(f.Pos())
		if tf == nil {
			continue
		}
		rel, err := filepath.Rel(root, tf.Name())
		if err != nil {
			continue
		}
		byFile[filepath.ToSlash(rel)] = tf
	}
	if reportDead {
		for _, d := range findings.Dead {
			tf, ok := byFile[d.File]
			if !ok {
				continue
			}
			pass.Report(analysis.Diagnostic{
				Pos:      linePos(tf, d.Line),
				Category: "dead-code",
				Message:  deadMessage(d),
			})
		}
	}
	if reportWide {
		for _, w := range findings.Wide {
			tf, ok := byFile[w.File]
			if !ok {
				continue
			}
			pass.Report(analysis.Diagnostic{
				Pos:      linePos(tf, w.Line),
				Category: "widening",
				Message:  fmt.Sprintf("`%s: %s` could be `%s` (%s: %s)", w.Declared, w.Type, w.Suggested, w.Origin, w.Contract),
			})
		}
	}
	return nil, nil
}

func deadMessage(d scan.DeadGuard) string {
	verdict := "always false"
	if d.Verdict == "always-true" {
		verdict = "always true"
	}
	msg := fmt.Sprintf("`%s` is %s (%s: %s - %s)", d.Guard, verdict, d.Origin, d.Contract, d.Why)
	if d.Widening != nil && d.Widening.Suggested != "" {
		msg += fmt.Sprintf("; widened at %s: %s, could be %s", d.Widening.Declared, d.Widening.Type, d.Widening.Suggested)
	}
	return msg
}

func linePos(tf *token.File, line int) token.Pos {
	if line < 1 || line > tf.LineCount() {
		return tf.Pos(0)
	}
	return tf.LineStart(line)
}

// findRoot walks up from dir to the directory holding the config file.
// The -config flag names it directly, and its directory is the root.
func findRoot(dir string) (root, cfgPath string, err error) {
	if configPath != "" {
		abs, err := filepath.Abs(configPath)
		if err != nil {
			return "", "", err
		}
		return filepath.Dir(abs), abs, nil
	}
	for {
		candidate := filepath.Join(dir, config.FileName)
		if _, err := os.Stat(candidate); err == nil {
			return dir, candidate, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", "", fmt.Errorf("contract-fidelity: no %s above %s", config.FileName, dir)
		}
		dir = parent
	}
}

// findingsFor loads the program once per root in this process and once
// per source fingerprint on disk.
func findingsFor(root, cfgPath string) (*Findings, error) {
	loadMu.Lock()
	defer loadMu.Unlock()
	if f, ok := loaded[root]; ok {
		return f, nil
	}
	if err, ok := loadErrs[root]; ok {
		return nil, err
	}
	f, err := loadOrCache(root, cfgPath)
	if err != nil {
		loadErrs[root] = err
		return nil, err
	}
	loaded[root] = f
	return f, nil
}

func loadOrCache(root, cfgPath string) (*Findings, error) {
	cfg, err := config.Load(root, cfgPath)
	if err != nil {
		return nil, err
	}
	tests := cfg.Tests()
	if censusTests != "" {
		tests = censusTests == "true"
	}
	var cacheFile string
	if useCache {
		key, err := fingerprint(root, cfgPath, tests)
		if err == nil {
			cacheFile = filepath.Join(cacheDir(), key+".json")
			if raw, err := os.ReadFile(cacheFile); err == nil {
				var f Findings
				if json.Unmarshal(raw, &f) == nil {
					return &f, nil
				}
			}
		}
	}
	prog, err := scan.Load(scan.Options{
		Dir:              root,
		Patterns:         cfg.Patterns,
		ContractPackages: cfg.ContractPackages,
		DocPatterns:      cfg.CompiledDocPatterns,
		TrustContract:    cfg.Trust(),
		ClosedWorld:      cfg.Closed(),
		CensusTests:      tests,
		InferConstraints: cfg.Infer(),
	})
	if err != nil {
		return nil, err
	}
	f := &Findings{Dead: prog.DeadGuards(), Wide: prog.Widenings()}
	if f.Dead == nil {
		f.Dead = []scan.DeadGuard{}
	}
	if f.Wide == nil {
		f.Wide = []scan.WideningFinding{}
	}
	if cacheFile != "" {
		if raw, err := json.Marshal(f); err == nil {
			_ = os.MkdirAll(filepath.Dir(cacheFile), 0o755)
			_ = os.WriteFile(cacheFile, raw, 0o644)
		}
	}
	return f, nil
}

func cacheDir() string {
	if cacheDirFlag != "" {
		return cacheDirFlag
	}
	base, err := os.UserCacheDir()
	if err != nil {
		base = os.TempDir()
	}
	return filepath.Join(base, "contract-fidelity")
}

// fingerprint hashes every Go source, go.mod and go.sum under root (path,
// size, mtime), the config file's content, and the census setting. A
// change to any of them is a different program.
func fingerprint(root, cfgPath string, tests bool) (string, error) {
	h := sha256.New()
	fmt.Fprintf(h, "root=%s tests=%v\n", root, tests)
	cfgRaw, err := os.ReadFile(cfgPath)
	if err != nil {
		return "", err
	}
	h.Write(cfgRaw)
	var entries []string
	err = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		name := d.Name()
		if d.IsDir() {
			if name != root && (strings.HasPrefix(name, ".") || name == "node_modules" || name == "vendor") {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(name, ".go") && name != "go.mod" && name != "go.sum" {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		entries = append(entries, fmt.Sprintf("%s %d %d", path, info.Size(), info.ModTime().UnixNano()))
		return nil
	})
	if err != nil {
		return "", err
	}
	sort.Strings(entries)
	for _, e := range entries {
		h.Write([]byte(e))
		h.Write([]byte{'\n'})
	}
	return hex.EncodeToString(h.Sum(nil))[:32], nil
}
