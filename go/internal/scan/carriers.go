package scan

import (
	"go/ast"
	"go/token"
	"go/types"
	"os"
	"strconv"
	"sync"

	"golang.org/x/tools/go/packages"

	"github.com/ufs-lab/contract-fidelity/go/internal/constraint"
)

// carrierKind names where a value can be held between a contract read and
// a guard.
type carrierKind string

const (
	carrierField  carrierKind = "field"
	carrierParam  carrierKind = "param"
	carrierLocal  carrierKind = "local"
	carrierResult carrierKind = "result"
)

// carrier is one declaration a guarantee can flow into: a struct field, a
// parameter, a local variable or a result slot. Its writes are the census;
// its resolved guarantee is the join over them, or nothing when any write
// is unaccounted for.
type carrier struct {
	key      string
	kind     carrierKind
	name     string
	declType types.Type
	pkg      *packages.Package
	pos      token.Position
	exported bool
	// obj is the declaring object for fields, params and locals.
	obj *types.Var

	writes       []write
	disqualified string

	resolved     []constraint.Guarantee
	resolvedOK   bool
	fromContract bool
	origins      []origin
}

// write is one value that reaches a carrier.
type write struct {
	expr ast.Expr
	pkg  *packages.Package
	// zero marks an omitted field or an uninitialised declaration: the
	// value written is the type's zero value.
	zero bool
	// result marks a tuple-call write: the value is result slot i of fn.
	result *funcInfo
	slot   int
	// elem marks a whole-map write: every element of the source map
	// reaches the target's elements.
	elem *carrier
	test bool
	pos  token.Position
	text string
}

// origin is a direct contract read a value traces back to.
type origin struct {
	file  string
	line  int
	text  string
	field string
}

func (p *Program) carrierFor(v *types.Var, kind carrierKind, name string, pkg *packages.Package, exported bool) *carrier {
	key := string(kind) + ":" + p.posKey(v.Pos())
	if c, ok := p.carriers[key]; ok {
		return c
	}
	c := &carrier{
		key:      key,
		kind:     kind,
		name:     name,
		declType: v.Type(),
		pkg:      pkg,
		pos:      p.position(v.Pos()),
		exported: exported,
		obj:      v,
	}
	p.carriers[key] = c
	return c
}

func (p *Program) resultCarrier(fi *funcInfo, i int, t types.Type) *carrier {
	key := string(carrierResult) + ":" + p.posKey(fi.decl.Pos()) + "#" + itoa(i)
	if c, ok := p.carriers[key]; ok {
		return c
	}
	c := &carrier{
		key:      key,
		kind:     carrierResult,
		name:     funcDisplay(fi.obj) + " result " + itoa(i),
		declType: t,
		pkg:      fi.pkg,
		pos:      p.position(fi.decl.Pos()),
		exported: fi.obj.Exported(),
	}
	p.carriers[key] = c
	return c
}

func itoa(i int) string { return strconv.Itoa(i) }

func funcDisplay(f *types.Func) string {
	if sig, ok := f.Type().(*types.Signature); ok && sig.Recv() != nil {
		recv := sig.Recv().Type()
		if ptr, ok := recv.(*types.Pointer); ok {
			recv = ptr.Elem()
		}
		if named, ok := recv.(*types.Named); ok {
			return named.Obj().Name() + "." + f.Name()
		}
	}
	return f.Name()
}

func (c *carrier) disqualify(reason string) {
	if c.disqualified == "" {
		c.disqualified = reason
	}
}

func (c *carrier) addWrite(w write) {
	c.writes = append(c.writes, w)
}

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

// collectCarriers registers every carrier in the scanned packages and then
// walks every function body for the writes that reach them.
func (p *Program) collectCarriers() {
	for _, pkg := range p.pkgs {
		for _, file := range pkg.Syntax {
			for _, decl := range file.Decls {
				switch d := decl.(type) {
				case *ast.GenDecl:
					p.declareTypes(pkg, d)
				case *ast.FuncDecl:
					p.declareFunc(pkg, d)
				}
			}
		}
	}
	for _, pkg := range p.pkgs {
		for _, file := range pkg.Syntax {
			test := isTestFile(p.fset.File(file.Pos()).Name())
			p.censusFile(pkg, file, test)
		}
	}
}

func (p *Program) declareTypes(pkg *packages.Package, d *ast.GenDecl) {
	if d.Tok != token.TYPE {
		return
	}
	for _, s := range d.Specs {
		ts := s.(*ast.TypeSpec)
		st, ok := ts.Type.(*ast.StructType)
		if !ok {
			continue
		}
		tn, ok := pkg.TypesInfo.Defs[ts.Name].(*types.TypeName)
		if !ok {
			continue
		}
		for _, f := range st.Fields.List {
			for _, name := range f.Names {
				v, ok := pkg.TypesInfo.Defs[name].(*types.Var)
				if !ok {
					continue
				}
				exported := tn.Exported() && v.Exported()
				p.carrierFor(v, carrierField, tn.Name()+"."+v.Name(), pkg, exported)
			}
		}
	}
}

func (p *Program) declareFunc(pkg *packages.Package, d *ast.FuncDecl) {
	obj, ok := pkg.TypesInfo.Defs[d.Name].(*types.Func)
	if !ok {
		return
	}
	fi := &funcInfo{decl: d, pkg: pkg, obj: obj}
	sig := obj.Type().(*types.Signature)
	display := funcDisplay(obj)
	if recv := sig.Recv(); recv != nil {
		c := p.carrierFor(recv, carrierParam, display+" receiver", pkg, obj.Exported())
		if recv.Name() == "" || recv.Name() == "_" {
			c.disqualify("unnamed receiver")
		}
		if p.interfaceMethods[obj.Name()] {
			c.disqualify("method may be called through an interface")
		}
		fi.recv = c
	}
	for i := 0; i < sig.Params().Len(); i++ {
		v := sig.Params().At(i)
		c := p.carrierFor(v, carrierParam, display+"("+v.Name()+")", pkg, obj.Exported())
		if sig.Variadic() && i == sig.Params().Len()-1 {
			c.disqualify("variadic parameter")
		}
		if v.Name() == "" || v.Name() == "_" {
			c.disqualify("unnamed parameter")
		}
		if sig.Recv() != nil && p.interfaceMethods[obj.Name()] {
			c.disqualify("method may be called through an interface")
		}
		fi.params = append(fi.params, c)
	}
	for i := 0; i < sig.Results().Len(); i++ {
		fi.results = append(fi.results, p.resultCarrier(fi, i, sig.Results().At(i).Type()))
	}
	p.funcs[p.posKey(obj.Pos())] = fi
}

func (p *Program) funcInfoFor(obj *types.Func) (*funcInfo, bool) {
	if obj == nil {
		return nil, false
	}
	fi, ok := p.funcs[p.posKey(obj.Pos())]
	return fi, ok
}

// ---------------------------------------------------------------------------
// Census
// ---------------------------------------------------------------------------

// walkCtx is the state a census visit needs beyond the node: which
// function encloses it, and what its parent node is.
type walkCtx struct {
	pkg     *packages.Package
	test    bool
	fnName  string
	parents map[ast.Node]ast.Node
}

func (p *Program) censusFile(pkg *packages.Package, file *ast.File, test bool) {
	parents := map[ast.Node]ast.Node{}
	var stack []ast.Node
	ast.Inspect(file, func(n ast.Node) bool {
		if n == nil {
			stack = stack[:len(stack)-1]
			return true
		}
		if len(stack) > 0 {
			parents[n] = stack[len(stack)-1]
		}
		stack = append(stack, n)
		return true
	})
	ctx := &walkCtx{pkg: pkg, test: test, fnName: "(package scope)", parents: parents}
	for _, decl := range file.Decls {
		if fd, ok := decl.(*ast.FuncDecl); ok {
			if obj, ok := pkg.TypesInfo.Defs[fd.Name].(*types.Func); ok {
				ctx.fnName = funcDisplay(obj)
			} else {
				ctx.fnName = fd.Name.Name
			}
			p.censusReturns(pkg, fd, test)
		} else {
			ctx.fnName = "(package scope)"
		}
		ast.Inspect(decl, func(n ast.Node) bool {
			switch n := n.(type) {
			case *ast.CompositeLit:
				p.censusCompositeLit(pkg, n, test)
			case *ast.AssignStmt:
				p.censusAssign(ctx, n)
			case *ast.IncDecStmt:
				p.disqualifyTarget(ctx, n.X, "incremented in place")
			case *ast.ValueSpec:
				p.censusValueSpec(ctx, n)
			case *ast.RangeStmt:
				p.censusRange(ctx, n)
			case *ast.CallExpr:
				p.censusCall(pkg, n, test)
			case *ast.UnaryExpr:
				if n.Op == token.AND {
					p.censusAddressOf(ctx, n)
				}
			case *ast.Ident:
				p.censusFuncValue(ctx, n)
			}
			return true
		})
	}
}

// fieldCarrier resolves a struct field object to its carrier when the
// struct belongs to a scanned package.
func (p *Program) fieldCarrier(v *types.Var) (*carrier, bool) {
	if v == nil || !v.IsField() || !p.isScannedPackage(v.Pkg()) {
		return nil, false
	}
	c, ok := p.carriers[string(carrierField)+":"+p.posKey(v.Pos())]
	return c, ok
}

func (p *Program) varCarrier(v *types.Var) (*carrier, bool) {
	if v == nil || v.IsField() {
		return nil, false
	}
	for _, kind := range []carrierKind{carrierLocal, carrierParam} {
		if c, ok := p.carriers[string(kind)+":"+p.posKey(v.Pos())]; ok {
			return c, true
		}
	}
	return nil, false
}

func (p *Program) localCarrier(pkg *packages.Package, v *types.Var, fnName string) *carrier {
	if v == nil || v.IsField() {
		return nil
	}
	if c, ok := p.carriers[string(carrierParam)+":"+p.posKey(v.Pos())]; ok {
		return c
	}
	return p.carrierFor(v, carrierLocal, fnName+": "+v.Name(), pkg, false)
}

func (p *Program) writeOf(pkg *packages.Package, e ast.Expr, test bool) write {
	return write{expr: e, pkg: pkg, test: test, pos: p.position(e.Pos()), text: p.nodeText(pkg, e)}
}

func (p *Program) zeroWrite(pkg *packages.Package, at ast.Node, test bool) write {
	return write{zero: true, pkg: pkg, test: test, pos: p.position(at.Pos()), text: "(zero value)"}
}

// structOf returns the struct type behind t, through pointers, when it is
// a named struct of a scanned package.
func (p *Program) structOf(t types.Type) (*types.Named, *types.Struct, bool) {
	if ptr, ok := t.(*types.Pointer); ok {
		t = ptr.Elem()
	}
	named, ok := t.(*types.Named)
	if !ok || !p.isScannedPackage(named.Obj().Pkg()) {
		return nil, nil, false
	}
	st, ok := named.Underlying().(*types.Struct)
	if !ok {
		return nil, nil, false
	}
	return named, st, true
}

// zeroFields records a zero write to every field of a scanned struct, and
// recursively of nested value-struct fields. `var x T`, `T{}`, `new(T)`,
// `make([]T, n)` and an omitted literal field all write the zero value.
func (p *Program) zeroFields(pkg *packages.Package, t types.Type, at ast.Node, test bool, depth int) {
	if depth > 4 {
		return
	}
	switch u := t.Underlying().(type) {
	case *types.Slice:
		p.zeroFields(pkg, u.Elem(), at, test, depth+1)
		return
	case *types.Array:
		p.zeroFields(pkg, u.Elem(), at, test, depth+1)
		return
	case *types.Map:
		p.zeroFields(pkg, u.Elem(), at, test, depth+1)
		return
	}
	_, st, ok := p.structOf(t)
	if !ok {
		return
	}
	for i := 0; i < st.NumFields(); i++ {
		f := st.Field(i)
		if c, ok := p.fieldCarrier(f); ok {
			c.addWrite(p.zeroWrite(pkg, at, test))
		}
		if _, _, nested := p.structOf(f.Type()); nested {
			if _, isPtr := f.Type().(*types.Pointer); !isPtr {
				p.zeroFields(pkg, f.Type(), at, test, depth+1)
			}
		}
	}
}

func (p *Program) censusCompositeLit(pkg *packages.Package, lit *ast.CompositeLit, test bool) {
	tv, ok := pkg.TypesInfo.Types[lit]
	if !ok {
		return
	}
	_, st, ok := p.structOf(tv.Type)
	if !ok {
		return
	}
	written := map[string]bool{}
	for i, elt := range lit.Elts {
		if kv, ok := elt.(*ast.KeyValueExpr); ok {
			key, ok := kv.Key.(*ast.Ident)
			if !ok {
				continue
			}
			fv, ok := pkg.TypesInfo.Uses[key].(*types.Var)
			if !ok {
				continue
			}
			written[fv.Name()] = true
			if c, ok := p.fieldCarrier(fv); ok {
				c.addWrite(p.writeOf(pkg, kv.Value, test))
				p.mapFlow(pkg, fv, kv.Value, test)
			}
			continue
		}
		if i < st.NumFields() {
			fv := st.Field(i)
			written[fv.Name()] = true
			if c, ok := p.fieldCarrier(fv); ok {
				c.addWrite(p.writeOf(pkg, elt, test))
				p.mapFlow(pkg, fv, elt, test)
			}
		}
	}
	for i := 0; i < st.NumFields(); i++ {
		f := st.Field(i)
		if written[f.Name()] {
			continue
		}
		if c, ok := p.fieldCarrier(f); ok {
			c.addWrite(p.zeroWrite(pkg, lit, test))
		}
		if _, isPtr := f.Type().(*types.Pointer); !isPtr {
			p.zeroFields(pkg, f.Type(), lit, test, 1)
		}
	}
}

func (p *Program) censusAssign(ctx *walkCtx, as *ast.AssignStmt) {
	pkg, test := ctx.pkg, ctx.test
	if as.Tok != token.ASSIGN && as.Tok != token.DEFINE {
		for _, lhs := range as.Lhs {
			p.disqualifyTarget(ctx, lhs, "compound assignment")
		}
		return
	}
	fnName := ctx.fnName
	switch {
	case len(as.Lhs) == len(as.Rhs):
		for i, lhs := range as.Lhs {
			p.recordWrite(pkg, lhs, p.writeOf(pkg, as.Rhs[i], test), fnName)
		}
	case len(as.Rhs) == 1:
		// A tuple assignment: `a, b := f()` or a comma-ok form.
		call, isCall := as.Rhs[0].(*ast.CallExpr)
		var fi *funcInfo
		if isCall {
			fi, _ = p.calleeInfo(pkg, call)
		}
		for i, lhs := range as.Lhs {
			if fi != nil && i < len(fi.results) {
				w := write{result: fi, slot: i, pkg: pkg, test: test, pos: p.position(as.Rhs[0].Pos()), text: p.nodeText(pkg, as.Rhs[0])}
				p.recordWrite(pkg, lhs, w, fnName)
				continue
			}
			p.disqualifyTarget(ctx, lhs, "written by a tuple the census cannot read")
		}
	}
}

func (p *Program) recordWrite(pkg *packages.Package, lhs ast.Expr, w write, fnName string) {
	switch l := lhs.(type) {
	case *ast.Ident:
		if l.Name == "_" {
			return
		}
		var v *types.Var
		if def, ok := pkg.TypesInfo.Defs[l].(*types.Var); ok {
			v = def
		} else if use, ok := pkg.TypesInfo.Uses[l].(*types.Var); ok {
			v = use
		}
		if v == nil {
			return
		}
		if v.IsField() {
			return
		}
		if v.Parent() == pkg.Types.Scope() {
			// A package-level variable: written from anywhere, including
			// init order the census does not model.
			return
		}
		p.localCarrier(pkg, v, fnName).addWrite(w)
		p.mapFlow(pkg, v, w.expr, w.test)
	case *ast.SelectorExpr:
		sel, ok := pkg.TypesInfo.Selections[l]
		if !ok || sel.Kind() != types.FieldVal {
			return
		}
		if c, ok := p.fieldCarrier(sel.Obj().(*types.Var)); ok {
			c.addWrite(w)
			p.mapFlow(pkg, sel.Obj().(*types.Var), w.expr, w.test)
		}
	case *ast.ParenExpr:
		p.recordWrite(pkg, l.X, w, fnName)
	case *ast.StarExpr:
		// `*p = T{...}` is a whole-struct write; the literal census covers
		// it. Any other pointee write is opaque.
		if _, isLit := w.expr.(*ast.CompositeLit); !isLit {
			if tv, ok := pkg.TypesInfo.Types[l.X]; ok {
				p.disqualifyStruct(tv.Type, "written through a pointer")
			}
		}
	case *ast.IndexExpr:
		// `m[k] = v` stores a map value; a slice element is a struct
		// literal or opaque, and the literal census covers the former.
		if tv, ok := pkg.TypesInfo.Types[l.X]; ok {
			if _, isMap := tv.Type.Underlying().(*types.Map); isMap {
				p.censusMapWrite(&walkCtx{pkg: pkg, test: w.test, fnName: fnName}, l, w)
			}
		}
	}
}

func (p *Program) disqualifyTarget(ctx *walkCtx, lhs ast.Expr, reason string) {
	pkg := ctx.pkg
	switch l := lhs.(type) {
	case *ast.Ident:
		var v *types.Var
		if def, ok := pkg.TypesInfo.Defs[l].(*types.Var); ok {
			v = def
		} else if use, ok := pkg.TypesInfo.Uses[l].(*types.Var); ok {
			v = use
		}
		if v == nil || v.IsField() || v.Parent() == pkg.Types.Scope() {
			return
		}
		p.localCarrier(pkg, v, ctx.fnName).disqualify(reason)
	case *ast.SelectorExpr:
		if sel, ok := pkg.TypesInfo.Selections[l]; ok && sel.Kind() == types.FieldVal {
			if c, ok := p.fieldCarrier(sel.Obj().(*types.Var)); ok {
				c.disqualify(reason)
			}
		}
	case *ast.ParenExpr:
		p.disqualifyTarget(ctx, l.X, reason)
	case *ast.StarExpr:
		if tv, ok := pkg.TypesInfo.Types[l.X]; ok {
			p.disqualifyStruct(tv.Type, reason)
		}
	}
}

func (p *Program) disqualifyStruct(t types.Type, reason string) {
	_, st, ok := p.structOf(t)
	if !ok {
		return
	}
	for i := 0; i < st.NumFields(); i++ {
		if c, ok := p.fieldCarrier(st.Field(i)); ok {
			c.disqualify(reason)
		}
	}
}

func (p *Program) censusValueSpec(ctx *walkCtx, vs *ast.ValueSpec) {
	pkg, test, fnName := ctx.pkg, ctx.test, ctx.fnName
	for i, name := range vs.Names {
		v, ok := pkg.TypesInfo.Defs[name].(*types.Var)
		if !ok || v.Parent() == pkg.Types.Scope() {
			continue
		}
		c := p.localCarrier(pkg, v, fnName)
		switch {
		case len(vs.Values) == len(vs.Names):
			c.addWrite(p.writeOf(pkg, vs.Values[i], test))
			p.mapFlow(pkg, v, vs.Values[i], test)
		case len(vs.Values) == 0:
			c.addWrite(p.zeroWrite(pkg, vs, test))
			p.zeroFields(pkg, v.Type(), vs, test, 0)
		default:
			c.disqualify("written by a tuple the census cannot read")
		}
	}
}

func (p *Program) censusRange(ctx *walkCtx, rs *ast.RangeStmt) {
	for _, e := range []ast.Expr{rs.Key, rs.Value} {
		if e == nil {
			continue
		}
		p.disqualifyTargetNamed(ctx, e, "bound by range")
	}
}

func (p *Program) disqualifyTargetNamed(ctx *walkCtx, e ast.Expr, reason string) {
	pkg, fnName := ctx.pkg, ctx.fnName
	id, ok := e.(*ast.Ident)
	if !ok {
		p.disqualifyTarget(ctx, e, reason)
		return
	}
	var v *types.Var
	if def, ok := pkg.TypesInfo.Defs[id].(*types.Var); ok {
		v = def
	} else if use, ok := pkg.TypesInfo.Uses[id].(*types.Var); ok {
		v = use
	}
	if v == nil || v.IsField() || v.Parent() == pkg.Types.Scope() {
		return
	}
	p.localCarrier(pkg, v, fnName).disqualify(reason)
}

// calleeInfo resolves a call to a function declared in the scanned
// packages. A call through a function value or an interface resolves to
// nothing, and the census treats it as an unknown caller.
func (p *Program) calleeInfo(pkg *packages.Package, call *ast.CallExpr) (*funcInfo, bool) {
	var obj types.Object
	switch fun := ast.Unparen(call.Fun).(type) {
	case *ast.Ident:
		obj = pkg.TypesInfo.Uses[fun]
	case *ast.SelectorExpr:
		if sel, ok := pkg.TypesInfo.Selections[fun]; ok {
			if sel.Kind() != types.MethodVal {
				return nil, false
			}
			obj = sel.Obj()
		} else {
			obj = pkg.TypesInfo.Uses[fun.Sel]
		}
	default:
		return nil, false
	}
	fn, ok := obj.(*types.Func)
	if !ok {
		return nil, false
	}
	return p.funcInfoFor(fn)
}

func (p *Program) censusCall(pkg *packages.Package, call *ast.CallExpr, test bool) {
	if tv, ok := pkg.TypesInfo.Types[call.Fun]; ok && tv.IsType() {
		return
	}
	if id, ok := ast.Unparen(call.Fun).(*ast.Ident); ok {
		if b, isBuiltin := pkg.TypesInfo.Uses[id].(*types.Builtin); isBuiltin {
			switch b.Name() {
			case "new", "make":
				if len(call.Args) > 0 {
					if tv, ok := pkg.TypesInfo.Types[call.Args[0]]; ok {
						p.zeroFields(pkg, tv.Type, call, test, 0)
					}
				}
			}
			return
		}
	}
	fi, ok := p.calleeInfo(pkg, call)
	if !ok {
		return
	}
	if fi.recv != nil {
		if sel, ok := ast.Unparen(call.Fun).(*ast.SelectorExpr); ok {
			fi.recv.addWrite(p.writeOf(pkg, sel.X, test))
		} else {
			fi.recv.disqualify("called as a method expression")
		}
	}
	if call.Ellipsis.IsValid() {
		for _, c := range fi.params {
			c.disqualify("called with a spread argument")
		}
		return
	}
	if len(call.Args) == 1 && len(fi.params) > 1 {
		// f(g()) forwarding a tuple.
		for _, c := range fi.params {
			c.disqualify("called with a forwarded tuple")
		}
		return
	}
	for i, arg := range call.Args {
		if i >= len(fi.params) {
			break
		}
		fi.params[i].addWrite(p.writeOf(pkg, arg, test))
	}
}

// censusAddressOf disqualifies the fields of a struct whose address
// escapes into a call the census cannot follow (`json.Unmarshal(b, &x)`).
func (p *Program) censusAddressOf(ctx *walkCtx, u *ast.UnaryExpr) {
	pkg := ctx.pkg
	tv, ok := pkg.TypesInfo.Types[u.X]
	if !ok {
		return
	}
	if _, _, isStruct := p.structOf(tv.Type); !isStruct {
		return
	}
	if _, isLit := u.X.(*ast.CompositeLit); isLit {
		return
	}
	// Only an address that leaves the program's own functions is opaque; a
	// scanned callee's writes through the pointer are in the census.
	parent, ok := ctx.parents[u].(*ast.CallExpr)
	if !ok {
		return
	}
	if _, scanned := p.calleeInfo(pkg, parent); scanned {
		return
	}
	p.disqualifyStruct(tv.Type, "address passed to a call outside the program")
}

// censusFuncValue disqualifies the parameters of a function that is
// referenced as a value rather than called: `list.forEach(addRow)` calls
// it with arguments no call expression names.
func (p *Program) censusFuncValue(ctx *walkCtx, id *ast.Ident) {
	pkg := ctx.pkg
	fn, ok := pkg.TypesInfo.Uses[id].(*types.Func)
	if !ok {
		return
	}
	fi, ok := p.funcInfoFor(fn)
	if !ok {
		return
	}
	if isCallee(ctx.parents, id) {
		return
	}
	for _, c := range fi.params {
		c.disqualify("used as a function value")
	}
	if fi.recv != nil {
		fi.recv.disqualify("used as a method value")
	}
}

func (p *Program) censusReturns(pkg *packages.Package, d *ast.FuncDecl, test bool) {
	obj, ok := pkg.TypesInfo.Defs[d.Name].(*types.Func)
	if !ok || d.Body == nil {
		return
	}
	fi, ok := p.funcInfoFor(obj)
	if !ok {
		return
	}
	ast.Inspect(d.Body, func(n ast.Node) bool {
		if _, isLit := n.(*ast.FuncLit); isLit {
			return false
		}
		ret, ok := n.(*ast.ReturnStmt)
		if !ok {
			return true
		}
		switch {
		case len(ret.Results) == len(fi.results):
			for i, r := range ret.Results {
				fi.results[i].addWrite(p.writeOf(pkg, r, test))
			}
		case len(ret.Results) == 0 && len(fi.results) > 0:
			// A bare return of named results: their locals hold the value.
			for _, c := range fi.results {
				c.disqualify("bare return of named results")
			}
		case len(ret.Results) == 1:
			if call, ok := ret.Results[0].(*ast.CallExpr); ok {
				if callee, ok := p.calleeInfo(pkg, call); ok {
					for i, c := range fi.results {
						if i < len(callee.results) {
							c.addWrite(write{result: callee, slot: i, pkg: pkg, test: test, pos: p.position(call.Pos()), text: p.nodeText(pkg, call)})
						}
					}
					return true
				}
			}
			for _, c := range fi.results {
				c.disqualify("returns a tuple the census cannot read")
			}
		}
		return true
	})
}

// ---------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------

// isCallee reports whether an identifier is the function of a call
// expression (directly, or as the selector of a method call), rather than a
// value passed around.
func isCallee(parents map[ast.Node]ast.Node, id *ast.Ident) bool {
	parent := parents[id]
	if sel, ok := parent.(*ast.SelectorExpr); ok && sel.Sel == id {
		parent = parents[sel]
	}
	for {
		paren, ok := parent.(*ast.ParenExpr)
		if !ok {
			break
		}
		parent = parents[paren]
	}
	call, ok := parent.(*ast.CallExpr)
	if !ok {
		return false
	}
	switch fun := ast.Unparen(call.Fun).(type) {
	case *ast.Ident:
		return fun == id
	case *ast.SelectorExpr:
		return fun.Sel == id
	}
	return false
}

var (
	sourceMu    sync.Mutex
	sourceCache = map[string][]byte{}
)

func fileSource(_ *packages.Package, filename string) ([]byte, bool) {
	sourceMu.Lock()
	defer sourceMu.Unlock()
	if src, ok := sourceCache[filename]; ok {
		return src, true
	}
	src, err := os.ReadFile(filename)
	if err != nil {
		return nil, false
	}
	sourceCache[filename] = src
	return src, true
}
