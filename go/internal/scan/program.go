// Package scan follows a contract guarantee from the generated client into
// the code that consumes it, and reports where the two disagree: a guard
// the guarantee decides, or a declaration wider than every value that
// reaches it.
package scan

import (
	"fmt"
	"go/ast"
	"go/token"
	"go/types"
	"path/filepath"
	"sort"
	"strings"

	"golang.org/x/tools/go/packages"

	"github.com/ufs-lab/contract-fidelity/go/internal/constraint"
	"github.com/ufs-lab/contract-fidelity/go/internal/contract"
)

// Options configure one scan.
type Options struct {
	// Dir is the consumer module root; file paths in findings are relative
	// to it.
	Dir string
	// Patterns are the go/packages patterns to scan (`./...`).
	Patterns []string
	// ContractPackages are import-path prefixes whose types carry contracts.
	ContractPackages []string
	// DocPatterns are project-supplied prose patterns.
	DocPatterns []constraint.DocPattern
	// TrustContract reports a guard on a direct contract read.
	TrustContract bool
	// ClosedWorld treats every caller and writer in the program as all
	// there are, exported declarations included.
	ClosedWorld bool
	// CensusTests counts writes made in test files. The upstream tool does:
	// a test that writes an out-of-contract value proves the branch is
	// reachable.
	CensusTests bool
	// InferConstraints lets the program's own types and writes supply a
	// guarantee: a typed constant of a named string type is an enum member,
	// a value that cannot be nil is non-null.
	InferConstraints bool
}

// Program is a loaded consumer module plus its contract index.
type Program struct {
	opts  Options
	fset  *token.FileSet
	pkgs  []*packages.Package
	index *contract.Index

	carriers map[string]*carrier
	// interfaceMethods holds every method name declared on an interface in
	// the program or its imports; a method of that name may be called
	// through the interface, so its parameters have callers the census
	// cannot see.
	interfaceMethods map[string]bool
	// funcs maps a function object's declaration position to its info.
	funcs map[string]*funcInfo
}

type funcInfo struct {
	decl    *ast.FuncDecl
	pkg     *packages.Package
	obj     *types.Func
	recv    *carrier
	params  []*carrier
	results []*carrier
}

// Load loads the consumer packages and indexes the contract packages they
// import.
func Load(opts Options) (*Program, error) {
	if len(opts.ContractPackages) == 0 {
		return nil, fmt.Errorf("contract-fidelity: `contractPackages` is required; a scan that matches no contract would report clean while it checks nothing")
	}
	if len(opts.Patterns) == 0 {
		opts.Patterns = []string{"./..."}
	}
	fset := token.NewFileSet()
	cfg := &packages.Config{
		Mode: packages.NeedName | packages.NeedFiles | packages.NeedCompiledGoFiles |
			packages.NeedImports | packages.NeedTypes | packages.NeedTypesInfo |
			packages.NeedSyntax | packages.NeedModule,
		Dir:   opts.Dir,
		Fset:  fset,
		Tests: true,
	}
	loaded, err := packages.Load(cfg, opts.Patterns...)
	if err != nil {
		return nil, fmt.Errorf("contract-fidelity: load %v: %w", opts.Patterns, err)
	}
	if err := loadErrors(loaded); err != nil {
		return nil, err
	}
	scanPkgs := preferTestVariants(loaded)

	contractPaths := contractImports(scanPkgs, opts.ContractPackages)
	if len(contractPaths) == 0 {
		return nil, fmt.Errorf("contract-fidelity: no scanned package imports a package under contractPackages %v", opts.ContractPackages)
	}
	ccfg := &packages.Config{
		Mode: packages.NeedName | packages.NeedFiles | packages.NeedTypes |
			packages.NeedTypesInfo | packages.NeedSyntax | packages.NeedModule,
		Dir:  opts.Dir,
		Fset: fset,
	}
	contractPkgs, err := packages.Load(ccfg, contractPaths...)
	if err != nil {
		return nil, fmt.Errorf("contract-fidelity: load contract packages %v: %w", contractPaths, err)
	}
	if err := loadErrors(contractPkgs); err != nil {
		return nil, err
	}
	index, err := contract.Build(contractPkgs, opts.DocPatterns)
	if err != nil {
		return nil, err
	}

	p := &Program{
		opts:             opts,
		fset:             fset,
		pkgs:             scanPkgs,
		index:            index,
		carriers:         map[string]*carrier{},
		interfaceMethods: map[string]bool{},
		funcs:            map[string]*funcInfo{},
	}
	p.collectInterfaceMethods()
	p.collectCarriers()
	p.resolveCarriers()
	return p, nil
}

func loadErrors(pkgs []*packages.Package) error {
	var errs []string
	for _, pkg := range pkgs {
		for _, e := range pkg.Errors {
			errs = append(errs, e.Error())
		}
	}
	if len(errs) == 0 {
		return nil
	}
	return fmt.Errorf("contract-fidelity: the program does not type-check:\n  %s", strings.Join(errs, "\n  "))
}

// Index exposes the contract index for the audit command.
func (p *Program) Index() *contract.Index { return p.index }

// preferTestVariants keeps, for each import path, the variant that
// includes the test files (`pkg [pkg.test]`) over the plain build, plus the
// external test packages. Both censuses count test writers, so the test
// variant is the complete view of a package.
func preferTestVariants(loaded []*packages.Package) []*packages.Package {
	byPath := map[string]*packages.Package{}
	var externals []*packages.Package
	for _, pkg := range loaded {
		if strings.HasSuffix(pkg.PkgPath, "_test") && strings.Contains(pkg.ID, ".test]") {
			externals = append(externals, pkg)
			continue
		}
		if strings.HasSuffix(pkg.ID, ".test") {
			// The synthesized test main.
			continue
		}
		cur, ok := byPath[pkg.PkgPath]
		if !ok || (strings.Contains(pkg.ID, ".test]") && !strings.Contains(cur.ID, ".test]")) {
			byPath[pkg.PkgPath] = pkg
		}
	}
	out := make([]*packages.Package, 0, len(byPath)+len(externals))
	for _, pkg := range byPath {
		out = append(out, pkg)
	}
	out = append(out, externals...)
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// contractImports lists the directly imported packages under the
// configured prefixes. A contract read is a selector on an imported type,
// so a contract package is always a direct import of some scanned package.
func contractImports(pkgs []*packages.Package, prefixes []string) []string {
	seen := map[string]bool{}
	own := map[string]bool{}
	for _, pkg := range pkgs {
		if pkg.Module != nil {
			own[pkg.Module.Path] = true
		}
	}
	var out []string
	for _, pkg := range pkgs {
		for path, imp := range pkg.Imports {
			if seen[path] || !underPrefix(path, prefixes) {
				continue
			}
			// A contract lives outside the module that consumes it; a
			// prefix loose enough to match the program's own packages must
			// not turn them into contracts.
			if imp.Module != nil && own[imp.Module.Path] {
				continue
			}
			seen[path] = true
			out = append(out, path)
		}
	}
	sort.Strings(out)
	return out
}

func underPrefix(path string, prefixes []string) bool {
	for _, prefix := range prefixes {
		prefix = strings.TrimSuffix(prefix, "/")
		if path == prefix || strings.HasPrefix(path, prefix+"/") {
			return true
		}
	}
	return false
}

func (p *Program) collectInterfaceMethods() {
	visit := func(tp *types.Package) {
		scope := tp.Scope()
		for _, name := range scope.Names() {
			tn, ok := scope.Lookup(name).(*types.TypeName)
			if !ok {
				continue
			}
			iface, ok := tn.Type().Underlying().(*types.Interface)
			if !ok {
				continue
			}
			for i := 0; i < iface.NumMethods(); i++ {
				p.interfaceMethods[iface.Method(i).Name()] = true
			}
		}
	}
	seen := map[string]bool{}
	for _, pkg := range p.pkgs {
		visit(pkg.Types)
		for _, imp := range pkg.Types.Imports() {
			if seen[imp.Path()] {
				continue
			}
			seen[imp.Path()] = true
			visit(imp)
		}
	}
}

// isTestFile reports whether a file is out of scope as a violation site.
func isTestFile(filename string) bool {
	return strings.HasSuffix(filename, "_test.go")
}

func (p *Program) relPath(filename string) string {
	rel, err := filepath.Rel(p.opts.Dir, filename)
	if err != nil {
		return filename
	}
	return filepath.ToSlash(rel)
}

func (p *Program) position(pos token.Pos) token.Position {
	return p.fset.Position(pos)
}

func (p *Program) posKey(pos token.Pos) string {
	return p.position(pos).String()
}

// isScannedPackage reports whether a package is one the scan owns, so its
// declarations are carriers rather than library types.
func (p *Program) isScannedPackage(pkg *types.Package) bool {
	if pkg == nil {
		return false
	}
	for _, sp := range p.pkgs {
		if sp.Types.Path() == pkg.Path() {
			return true
		}
	}
	return false
}

// nodeText renders an expression for a finding, whitespace-collapsed and
// capped like the upstream tool's 60 characters.
func (p *Program) nodeText(pkg *packages.Package, n ast.Node) string {
	var b strings.Builder
	file := p.fset.File(n.Pos())
	if file == nil {
		return ""
	}
	src, ok := fileSource(pkg, file.Name())
	if !ok {
		return ""
	}
	start, end := file.Offset(n.Pos()), file.Offset(n.End())
	if start < 0 || end > len(src) || start > end {
		return ""
	}
	b.WriteString(strings.Join(strings.Fields(string(src[start:end])), " "))
	text := b.String()
	if len(text) > 60 {
		text = text[:60]
	}
	return text
}
