package scan

import (
	"go/ast"
	"go/constant"
	"go/types"
	"strings"

	"golang.org/x/tools/go/packages"

	"github.com/ufs-lab/contract-fidelity/go/internal/constraint"
	"github.com/ufs-lab/contract-fidelity/go/internal/contract"
)

// value is what the analyzer knows about an expression: the guarantees it
// carries, whether that knowledge is complete, and where it came from.
type value struct {
	gs []constraint.Guarantee
	// ok is false when the value is unknown: an unaccounted writer, a call
	// the census cannot follow, an operation the analyzer does not model.
	ok bool
	// fromContract is true when at least one contract read feeds the value.
	fromContract bool
	// direct is true when the expression IS a contract read, with no
	// carrier between the two.
	direct  bool
	origins []origin
	// via is the carrier chain the value passed through, nearest first.
	via []*carrier
}

var unknown = value{}

func known(gs []constraint.Guarantee) value { return value{gs: gs, ok: true} }

const maxDepth = 12

// valueOf evaluates an expression against the current carrier state.
func (p *Program) valueOf(pkg *packages.Package, e ast.Expr, depth int) value {
	if depth > maxDepth {
		return unknown
	}
	info := pkg.TypesInfo
	if tv, ok := info.Types[e]; ok && tv.Value != nil {
		return constantValue(tv, p.nodeText(pkg, e))
	}
	switch e := e.(type) {
	case *ast.ParenExpr:
		return p.valueOf(pkg, e.X, depth+1)
	case *ast.Ident:
		return p.identValue(pkg, e)
	case *ast.SelectorExpr:
		return p.selectorValue(pkg, e)
	case *ast.CallExpr:
		return p.callValue(pkg, e, depth)
	case *ast.IndexExpr:
		return p.indexValue(pkg, e)
	}
	return unknown
}

func constantValue(tv types.TypeAndValue, text string) value {
	switch tv.Value.Kind() {
	case constant.Int, constant.Float:
		f, _ := constant.Float64Val(tv.Value)
		return known([]constraint.Guarantee{{
			Kind:     constraint.KindRange,
			Interval: constraint.Point(f),
			Why:      "a literal",
			Evidence: text,
		}})
	case constant.String:
		return known([]constraint.Guarantee{{
			Kind:     constraint.KindEnumMember,
			Members:  []string{constant.StringVal(tv.Value)},
			Why:      "a literal",
			Evidence: text,
		}})
	}
	return unknown
}

func (p *Program) zeroValue(t types.Type) value {
	switch u := t.Underlying().(type) {
	case *types.Basic:
		switch {
		case u.Info()&types.IsNumeric != 0:
			return known([]constraint.Guarantee{{Kind: constraint.KindRange, Interval: constraint.Point(0), Why: "the zero value", Evidence: "0"}})
		case u.Info()&types.IsString != 0:
			return known([]constraint.Guarantee{{Kind: constraint.KindEnumMember, Members: []string{""}, Why: "the zero value", Evidence: `""`}})
		}
	}
	return unknown
}

func (p *Program) identValue(pkg *packages.Package, id *ast.Ident) value {
	obj := pkg.TypesInfo.Uses[id]
	v, ok := obj.(*types.Var)
	if !ok {
		return unknown
	}
	if c, ok := p.varCarrier(v); ok {
		return p.carrierValue(c)
	}
	return unknown
}

func (p *Program) carrierValue(c *carrier) value {
	if c.disqualified != "" || !c.resolvedOK {
		return unknown
	}
	return value{
		gs:           c.resolved,
		ok:           true,
		fromContract: c.fromContract,
		origins:      c.origins,
		via:          []*carrier{c},
	}
}

func (p *Program) selectorValue(pkg *packages.Package, sel *ast.SelectorExpr) value {
	s, ok := pkg.TypesInfo.Selections[sel]
	if !ok || s.Kind() != types.FieldVal {
		return unknown
	}
	fv := s.Obj().(*types.Var)
	if f, ok := p.contractField(s.Recv(), fv); ok {
		pos := p.position(sel.Pos())
		return value{
			gs:           append([]constraint.Guarantee(nil), f.Guarantees...),
			ok:           true,
			fromContract: true,
			direct:       true,
			origins: []origin{{
				file:  p.relPath(pos.Filename),
				line:  pos.Line,
				text:  p.nodeText(pkg, sel),
				field: f.Display(),
			}},
		}
	}
	if c, ok := p.fieldCarrier(fv); ok {
		return p.carrierValue(c)
	}
	return unknown
}

// contractField resolves a field selection on a contract type.
func (p *Program) contractField(recv types.Type, fv *types.Var) (*contract.Field, bool) {
	if fv.Pkg() == nil || !p.index.IsContractPackage(fv.Pkg().Path()) {
		return nil, false
	}
	if ptr, ok := recv.(*types.Pointer); ok {
		recv = ptr.Elem()
	}
	named, ok := recv.(*types.Named)
	if !ok {
		return nil, false
	}
	return p.index.Lookup(fv.Pkg().Path(), named.Obj().Name(), fv.Name())
}

func (p *Program) callValue(pkg *packages.Package, call *ast.CallExpr, depth int) value {
	info := pkg.TypesInfo
	if tv, ok := info.Types[call.Fun]; ok && tv.IsType() && len(call.Args) == 1 {
		return convert(p.valueOf(pkg, call.Args[0], depth+1), tv.Type)
	}
	if id, ok := ast.Unparen(call.Fun).(*ast.Ident); ok {
		if b, isBuiltin := info.Uses[id].(*types.Builtin); isBuiltin {
			if b.Name() == "len" && len(call.Args) == 1 {
				return lengthOf(p.valueOf(pkg, call.Args[0], depth+1))
			}
			return unknown
		}
	}
	if sel, ok := ast.Unparen(call.Fun).(*ast.SelectorExpr); ok && len(call.Args) == 0 {
		if v, ok := p.getterValue(pkg, sel); ok {
			return v
		}
	}
	fi, ok := p.calleeInfo(pkg, call)
	if !ok || len(fi.results) != 1 {
		return unknown
	}
	return p.carrierValue(fi.results[0])
}

// getterValue reads `x.GetField()` on a contract type as the field itself.
// The generator's getter returns the zero value for an unset optional, so
// only a required field's getter is the field.
func (p *Program) getterValue(pkg *packages.Package, sel *ast.SelectorExpr) (value, bool) {
	s, ok := pkg.TypesInfo.Selections[sel]
	if !ok || s.Kind() != types.MethodVal || !strings.HasPrefix(sel.Sel.Name, "Get") {
		return unknown, false
	}
	fn := s.Obj().(*types.Func)
	if fn.Pkg() == nil || !p.index.IsContractPackage(fn.Pkg().Path()) {
		return unknown, false
	}
	recv := s.Recv()
	if ptr, ok := recv.(*types.Pointer); ok {
		recv = ptr.Elem()
	}
	named, ok := recv.(*types.Named)
	if !ok {
		return unknown, false
	}
	f, ok := p.index.Lookup(fn.Pkg().Path(), named.Obj().Name(), strings.TrimPrefix(sel.Sel.Name, "Get"))
	if !ok || !f.Required {
		return unknown, false
	}
	pos := p.position(sel.Pos())
	return value{
		gs:           append([]constraint.Guarantee(nil), f.Guarantees...),
		ok:           true,
		fromContract: true,
		direct:       true,
		origins:      []origin{{file: p.relPath(pos.Filename), line: pos.Line, text: p.nodeText(pkg, sel) + "()", field: f.Display()}},
	}, true
}

func (p *Program) indexValue(pkg *packages.Package, ix *ast.IndexExpr) value {
	tv, ok := pkg.TypesInfo.Types[ix.X]
	if !ok {
		return unknown
	}
	if _, isMap := tv.Type.Underlying().(*types.Map); !isMap {
		return unknown
	}
	c, ok := p.mapCarrierOf(pkg, ix.X)
	if !ok {
		return unknown
	}
	return p.carrierValue(c)
}

// convert applies a Go conversion to a value. A numeric target keeps the
// bounds it can hold; a string target keeps an enum's members and drops
// the numbers.
func convert(v value, target types.Type) value {
	if !v.ok {
		return unknown
	}
	basic, ok := target.Underlying().(*types.Basic)
	if !ok {
		return unknown
	}
	out := value{ok: true, fromContract: v.fromContract, origins: v.origins, via: v.via}
	switch {
	case basic.Info()&types.IsInteger != 0:
		width, _ := constraint.IntegerWidth(basic.Name())
		for _, g := range v.gs {
			if g.IsNumeric() && constraint.Within(g.Interval, width) {
				out.gs = append(out.gs, g)
			}
		}
	case basic.Info()&types.IsFloat != 0:
		for _, g := range v.gs {
			if g.IsNumeric() {
				out.gs = append(out.gs, g)
			}
		}
	case basic.Info()&types.IsString != 0:
		for _, g := range v.gs {
			if g.Kind == constraint.KindEnumMember {
				out.gs = append(out.gs, g)
			}
		}
	default:
		return unknown
	}
	return out
}

func lengthOf(v value) value {
	if !v.ok {
		return unknown
	}
	out := value{ok: true, fromContract: v.fromContract, direct: v.direct, origins: v.origins, via: v.via}
	if g, ok := constraint.Has(v.gs, constraint.KindNonEmptyArray); ok {
		out.gs = []constraint.Guarantee{{
			Kind:     constraint.KindNonEmptyArray,
			Interval: g.Interval,
			Why:      g.Why,
			Evidence: g.Evidence,
		}}
	}
	return out
}

// ---------------------------------------------------------------------------
// Fixed point
// ---------------------------------------------------------------------------

const maxRounds = 25

// resolveCarriers joins every carrier's writes until nothing changes. A
// carrier resolves once every write is known; its value never changes
// afterwards, so the iteration is monotone and terminates.
func (p *Program) resolveCarriers() {
	for _, c := range p.carriers {
		if c.exported && !p.opts.ClosedWorld {
			c.disqualify("exported: callers outside the program")
		}
	}
	for round := 0; round < maxRounds; round++ {
		changed := false
		for _, c := range p.carriers {
			if c.disqualified != "" || c.resolvedOK {
				continue
			}
			if p.resolveOne(c) {
				changed = true
			}
		}
		if !changed {
			return
		}
	}
}

func (p *Program) resolveOne(c *carrier) bool {
	var (
		joined       []constraint.Guarantee
		first        = true
		fromContract bool
		origins      []origin
		production   int
	)
	for _, w := range c.writes {
		if w.test && !p.opts.CensusTests {
			continue
		}
		if !w.test {
			production++
		}
		v := p.writeValue(c, w)
		if !v.ok {
			return false
		}
		if v.fromContract {
			fromContract = true
		}
		origins = appendOrigins(origins, v.origins)
		if first {
			joined, first = v.gs, false
			continue
		}
		joined = constraint.Join(joined, v.gs)
	}
	if first || production == 0 {
		// No writer at all, or only test writers: proven nothing.
		return false
	}
	c.resolved = joined
	c.resolvedOK = true
	c.fromContract = fromContract
	c.origins = origins
	return true
}

func (p *Program) writeValue(c *carrier, w write) value {
	switch {
	case w.zero:
		return p.zeroValue(c.declType)
	case w.result != nil:
		if w.slot >= len(w.result.results) {
			return unknown
		}
		return p.carrierValue(w.result.results[w.slot])
	case w.elem != nil:
		return p.carrierValue(w.elem)
	}
	return p.valueOf(w.pkg, w.expr, 0)
}

const maxOrigins = 5

func appendOrigins(dst, src []origin) []origin {
	for _, o := range src {
		dup := false
		for _, d := range dst {
			if d.file == o.file && d.line == o.line && d.text == o.text {
				dup = true
				break
			}
		}
		if !dup && len(dst) < maxOrigins {
			dst = append(dst, o)
		}
	}
	return dst
}

// ---------------------------------------------------------------------------
// Map elements
// ---------------------------------------------------------------------------

// mapCarrierOf returns the element carrier for a map held in a field,
// local or parameter. A map read yields any value ever stored under any
// key, or the zero value for a key that is absent.
func (p *Program) mapCarrierOf(pkg *packages.Package, m ast.Expr) (*carrier, bool) {
	var v *types.Var
	switch x := ast.Unparen(m).(type) {
	case *ast.Ident:
		v, _ = pkg.TypesInfo.Uses[x].(*types.Var)
	case *ast.SelectorExpr:
		if s, ok := pkg.TypesInfo.Selections[x]; ok && s.Kind() == types.FieldVal {
			v = s.Obj().(*types.Var)
		}
	}
	return p.mapCarrierForVar(pkg, v)
}

// mapCarrierForVar returns the element carrier of a map-typed variable.
func (p *Program) mapCarrierForVar(pkg *packages.Package, v *types.Var) (*carrier, bool) {
	if v == nil {
		return nil, false
	}
	if _, isMap := v.Type().Underlying().(*types.Map); !isMap {
		return nil, false
	}
	if v.IsField() && !p.isScannedPackage(v.Pkg()) {
		return nil, false
	}
	if !v.IsField() && v.Parent() == pkg.Types.Scope() {
		return nil, false
	}
	key := "mapelem:" + p.posKey(v.Pos())
	if c, ok := p.carriers[key]; ok {
		return c, true
	}
	c := &carrier{
		key:      key,
		kind:     carrierField,
		name:     "elements of " + v.Name(),
		declType: v.Type().Underlying().(*types.Map).Elem(),
		pkg:      pkg,
		pos:      p.position(v.Pos()),
		exported: v.IsField() && v.Exported(),
		obj:      v,
	}
	// A lookup of an absent key is a read of the zero value.
	c.addWrite(write{zero: true, pkg: pkg, pos: c.pos, text: "(absent key)"})
	p.carriers[key] = c
	return c, true
}

// mapFlow records what a whole-map write means for the target's elements:
// a literal's values, another map's elements, or nothing the census can
// read (a call result), which disqualifies them. `make` and nil add no
// element.
func (p *Program) mapFlow(pkg *packages.Package, target *types.Var, rhs ast.Expr, test bool) {
	dst, ok := p.mapCarrierForVar(pkg, target)
	if !ok || rhs == nil {
		return
	}
	switch r := ast.Unparen(rhs).(type) {
	case *ast.CompositeLit:
		for _, elt := range r.Elts {
			if kv, ok := elt.(*ast.KeyValueExpr); ok {
				dst.addWrite(p.writeOf(pkg, kv.Value, test))
			}
		}
	case *ast.Ident, *ast.SelectorExpr:
		if tv, ok := pkg.TypesInfo.Types[r]; ok && tv.IsNil() {
			return
		}
		if src, ok := p.mapCarrierOf(pkg, r); ok {
			if src != dst {
				dst.addWrite(write{elem: src, pkg: pkg, test: test, pos: p.position(r.Pos()), text: p.nodeText(pkg, r)})
			}
			return
		}
		dst.disqualify("map from a source the census cannot read")
	case *ast.CallExpr:
		if id, ok := ast.Unparen(r.Fun).(*ast.Ident); ok {
			if b, isBuiltin := pkg.TypesInfo.Uses[id].(*types.Builtin); isBuiltin && b.Name() == "make" {
				return
			}
		}
		dst.disqualify("map from a call result")
	default:
		dst.disqualify("map from a source the census cannot read")
	}
}

func (p *Program) censusMapWrite(ctx *walkCtx, ix *ast.IndexExpr, w write) {
	c, ok := p.mapCarrierOf(ctx.pkg, ix.X)
	if !ok {
		return
	}
	c.addWrite(w)
}
