package scan

import (
	"go/ast"
	"go/constant"
	"go/token"
	"go/types"

	"golang.org/x/tools/go/packages"

	"github.com/ufs-lab/contract-fidelity/go/internal/constraint"
)

// DeadGuards reports every guard in a non-test file that a guarantee
// decides. A guard on a value the contract leaves open is never reported:
// only always-true and always-false survive.
func (p *Program) DeadGuards() []DeadGuard {
	var out []DeadGuard
	seen := map[string]bool{}
	for _, pkg := range p.pkgs {
		for _, file := range pkg.Syntax {
			filename := p.fset.File(file.Pos()).Name()
			if isTestFile(filename) {
				continue
			}
			ast.Inspect(file, func(n ast.Node) bool {
				var f DeadGuard
				var ok bool
				switch n := n.(type) {
				case *ast.BinaryExpr:
					f, ok = p.comparisonGuard(pkg, n)
				case *ast.SwitchStmt:
					f, ok = p.switchGuard(pkg, n)
				}
				if !ok {
					return true
				}
				key := f.File + ":" + itoa(f.Line) + ":" + f.Fingerprint()
				if seen[key] {
					return true
				}
				seen[key] = true
				out = append(out, f)
				return true
			})
		}
	}
	sortDeadGuards(out)
	return out
}

var comparisonOps = map[token.Token]string{
	token.GTR: ">", token.GEQ: ">=", token.LSS: "<", token.LEQ: "<=", token.EQL: "==", token.NEQ: "!=",
}

// comparisonGuard decides `value OP constant` (either order) against the
// numeric guarantee on value.
func (p *Program) comparisonGuard(pkg *packages.Package, be *ast.BinaryExpr) (DeadGuard, bool) {
	op, ok := comparisonOps[be.Op]
	if !ok {
		return DeadGuard{}, false
	}
	info := pkg.TypesInfo
	if isNil(info, be.X) != isNil(info, be.Y) && (be.Op == token.EQL || be.Op == token.NEQ) {
		return p.nilGuard(pkg, be)
	}
	lhsConst, lhsOK := numericConst(info, be.X)
	rhsConst, rhsOK := numericConst(info, be.Y)
	var (
		valueExpr ast.Expr
		k         float64
	)
	switch {
	case lhsOK && rhsOK, !lhsOK && !rhsOK:
		return DeadGuard{}, false
	case rhsOK:
		valueExpr, k = be.X, rhsConst
	default:
		valueExpr, k, op = be.Y, lhsConst, constraint.FlipOperator(op)
	}
	v := p.valueOf(pkg, valueExpr, 0)
	if !p.reportable(v) {
		return DeadGuard{}, false
	}
	for _, g := range v.gs {
		if !g.IsNumeric() && g.Kind != constraint.KindNonEmptyArray {
			continue
		}
		verdict := constraint.DecideComparison(g.Interval, op, k)
		if verdict == constraint.Undecided {
			continue
		}
		return p.deadGuard(pkg, be, be, verdict, v, g), true
	}
	return DeadGuard{}, false
}

// reportable says whether a value can carry a finding: known, fed by a
// contract or (when enabled) an inference, and not a direct contract read
// the config asked to leave alone.
func (p *Program) reportable(v value) bool {
	if !v.ok || v.origin == "" {
		return false
	}
	if v.direct && !p.opts.TrustContract {
		return false
	}
	return true
}

func (p *Program) deadGuard(pkg *packages.Package, at ast.Node, guard ast.Node, verdict constraint.Verdict, v value, g constraint.Guarantee) DeadGuard {
	pos := p.position(at.Pos())
	text := p.nodeText(pkg, guard)
	if _, isSwitch := guard.(*ast.SwitchStmt); isSwitch {
		text = "switch " + p.nodeText(pkg, guard.(*ast.SwitchStmt).Tag) + " { default: }"
	}
	return DeadGuard{
		File:     p.relPath(pos.Filename),
		Line:     pos.Line,
		Guard:    text,
		Verdict:  verdict,
		Contract: contractOf(v.origins, g),
		Kind:     g.Kind,
		Why:      g.Why,
		Evidence: g.Evidence,
		Origins:  toOrigins(v.origins),
		Widening: p.wideningOf(v),
		Boundary: v.direct,
		Origin:   g.Origin,
	}
}

func isNil(info *types.Info, e ast.Expr) bool {
	tv, ok := info.Types[e]
	return ok && tv.IsNil()
}

// nilGuard decides `x == nil` and `x != nil` against a non-null guarantee.
func (p *Program) nilGuard(pkg *packages.Package, be *ast.BinaryExpr) (DeadGuard, bool) {
	valueExpr := be.X
	if isNil(pkg.TypesInfo, be.X) {
		valueExpr = be.Y
	}
	v := p.valueOf(pkg, valueExpr, 0)
	if !p.reportable(v) {
		return DeadGuard{}, false
	}
	g, ok := constraint.Has(v.gs, constraint.KindRequiredNonNull)
	if !ok || g.Origin == "" {
		return DeadGuard{}, false
	}
	verdict := constraint.AlwaysFalse
	if be.Op == token.NEQ {
		verdict = constraint.AlwaysTrue
	}
	return p.deadGuard(pkg, be, be, verdict, v, g), true
}

func numericConst(info *types.Info, e ast.Expr) (float64, bool) {
	tv, ok := info.Types[e]
	if !ok || tv.Value == nil {
		return 0, false
	}
	switch tv.Value.Kind() {
	case constant.Int, constant.Float:
		f, _ := constant.Float64Val(tv.Value)
		return f, true
	}
	return 0, false
}

// switchGuard reports a `default:` that follows a case for every member
// of an enum the tag is guaranteed to hold.
func (p *Program) switchGuard(pkg *packages.Package, sw *ast.SwitchStmt) (DeadGuard, bool) {
	if sw.Tag == nil {
		return DeadGuard{}, false
	}
	v := p.valueOf(pkg, sw.Tag, 0)
	if !p.reportable(v) {
		return DeadGuard{}, false
	}
	enum, ok := constraint.Enum(v.gs)
	if !ok || enum.Origin == "" {
		return DeadGuard{}, false
	}
	cased := map[string]bool{}
	var def *ast.CaseClause
	for _, stmt := range sw.Body.List {
		cc := stmt.(*ast.CaseClause)
		if cc.List == nil {
			def = cc
			continue
		}
		for _, e := range cc.List {
			tv, ok := pkg.TypesInfo.Types[e]
			if !ok || tv.Value == nil || tv.Value.Kind() != constant.String {
				return DeadGuard{}, false
			}
			cased[constant.StringVal(tv.Value)] = true
		}
	}
	if def == nil {
		return DeadGuard{}, false
	}
	for _, m := range enum.Members {
		if !cased[m] {
			return DeadGuard{}, false
		}
	}
	return p.deadGuard(pkg, def, sw, constraint.AlwaysFalse, v, enum), true
}

// wideningOf names the nearest carrier that holds the value in a wider
// declaration than the guarantee needs.
func (p *Program) wideningOf(v value) *Widening {
	for _, c := range v.via {
		if w, ok := p.carrierWidening(c); ok {
			return &Widening{Declared: w.Declared, Type: w.Type, Suggested: w.Suggested}
		}
	}
	return nil
}
