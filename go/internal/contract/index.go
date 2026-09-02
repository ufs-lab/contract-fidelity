// Package contract reads guarantees off a generated Go client, one struct
// field at a time. The generated types carry most of them: a required
// field is a plain value, an optional one a pointer with `omitempty`, an
// enum a named type with constants and a strict UnmarshalJSON, an integer
// its width. The bundled api/openapi.yaml adds `minimum`, `maximum` and
// `minItems`; the doc comment adds the prose patterns.
package contract

import (
	"fmt"
	"go/ast"
	"go/constant"
	"go/token"
	"go/types"
	"math"
	"reflect"
	"sort"
	"strings"

	"golang.org/x/tools/go/packages"

	"github.com/ufs-lab/contract-fidelity/go/internal/constraint"
	"github.com/ufs-lab/contract-fidelity/go/internal/openapi"
)

// FieldKey identifies a contract struct field by import path, type and Go
// field name. Keys are strings rather than *types.Var so a consumer scan
// loaded separately from the contract can still look a field up.
type FieldKey struct {
	Pkg, Type, Field string
}

func (k FieldKey) String() string { return k.Pkg + "." + k.Type + "." + k.Field }

// Field is one indexed contract field and everything the contract says
// about it.
type Field struct {
	Key      FieldKey
	PkgName  string
	JSONName string
	// GoType is the field's declared type, printed.
	GoType string
	// Required is true when the JSON key must be present; Optional when the
	// generator modelled it as a pointer with omitempty.
	Required   bool
	Optional   bool
	Guarantees []constraint.Guarantee
	Pos        token.Position
}

// Display is the name a finding prints: package.Type.jsonName.
func (f *Field) Display() string {
	name := f.JSONName
	if name == "" {
		name = f.Key.Field
	}
	return f.PkgName + "." + f.Key.Type + "." + name
}

// Enum is a named contract type whose decode admits a closed set of values.
type Enum struct {
	Pkg, Type string
	PkgName   string
	Members   []string
}

// Index is every guarantee read off the contract packages.
type Index struct {
	Fields   map[FieldKey]*Field
	Enums    map[string]*Enum // "pkgPath.Type"
	Packages []string
	// Specs records which packages had a bundled openapi.yaml, for the audit.
	Specs map[string]bool
}

// Lookup resolves a struct field selection to its indexed field.
func (ix *Index) Lookup(pkgPath, typeName, field string) (*Field, bool) {
	f, ok := ix.Fields[FieldKey{Pkg: pkgPath, Type: typeName, Field: field}]
	return f, ok
}

// LookupEnum resolves a named type to its enum, if it is one.
func (ix *Index) LookupEnum(pkgPath, typeName string) (*Enum, bool) {
	e, ok := ix.Enums[pkgPath+"."+typeName]
	return e, ok
}

// IsContractPackage reports whether the import path was indexed.
func (ix *Index) IsContractPackage(pkgPath string) bool {
	for _, p := range ix.Packages {
		if p == pkgPath {
			return true
		}
	}
	return false
}

// Build indexes every loaded package. Each must carry syntax and types.
func Build(pkgs []*packages.Package, extra []constraint.DocPattern) (*Index, error) {
	ix := &Index{Fields: map[FieldKey]*Field{}, Enums: map[string]*Enum{}, Specs: map[string]bool{}}
	for _, pkg := range pkgs {
		if len(pkg.Errors) > 0 {
			return nil, fmt.Errorf("contract-fidelity: load %s: %v", pkg.PkgPath, pkg.Errors[0])
		}
		if pkg.Types == nil || pkg.TypesInfo == nil || len(pkg.Syntax) == 0 {
			return nil, fmt.Errorf("contract-fidelity: %s was loaded without syntax and types", pkg.PkgPath)
		}
		ix.Packages = append(ix.Packages, pkg.PkgPath)
		indexEnums(ix, pkg)
	}
	for _, pkg := range pkgs {
		var spec *openapi.Spec
		if pkg.Module != nil && pkg.Module.Dir != "" {
			s, found, err := openapi.Load(pkg.Module.Dir)
			if err != nil {
				return nil, fmt.Errorf("contract-fidelity: read openapi.yaml for %s: %w", pkg.PkgPath, err)
			}
			spec = s
			ix.Specs[pkg.PkgPath] = found
		}
		if err := indexFields(ix, pkg, spec, extra); err != nil {
			return nil, err
		}
	}
	sort.Strings(ix.Packages)
	return ix, nil
}

// indexEnums records every named type with an underlying string whose
// package declares constants of it AND a strict UnmarshalJSON. Constants
// alone prove nothing about what a decode admits; the generator's
// UnmarshalJSON is what rejects a value outside the set.
func indexEnums(ix *Index, pkg *packages.Package) {
	scope := pkg.Types.Scope()
	members := map[string][]string{}
	for _, name := range scope.Names() {
		c, ok := scope.Lookup(name).(*types.Const)
		if !ok {
			continue
		}
		named, ok := c.Type().(*types.Named)
		if !ok || named.Obj().Pkg() != pkg.Types {
			continue
		}
		basic, ok := named.Underlying().(*types.Basic)
		if !ok || basic.Info()&types.IsString == 0 {
			continue
		}
		members[named.Obj().Name()] = append(members[named.Obj().Name()], constant.StringVal(c.Val()))
	}
	for typeName, vals := range members {
		tn, ok := scope.Lookup(typeName).(*types.TypeName)
		if !ok || !hasStrictDecode(tn) {
			continue
		}
		sort.Strings(vals)
		ix.Enums[pkg.PkgPath+"."+typeName] = &Enum{Pkg: pkg.PkgPath, Type: typeName, PkgName: pkg.Name, Members: vals}
	}
}

func hasStrictDecode(tn *types.TypeName) bool {
	ptr := types.NewPointer(tn.Type())
	mset := types.NewMethodSet(ptr)
	for i := 0; i < mset.Len(); i++ {
		if mset.At(i).Obj().Name() == "UnmarshalJSON" {
			return true
		}
	}
	return false
}

func indexFields(ix *Index, pkg *packages.Package, spec *openapi.Spec, extra []constraint.DocPattern) error {
	for _, file := range pkg.Syntax {
		for _, decl := range file.Decls {
			gen, ok := decl.(*ast.GenDecl)
			if !ok || gen.Tok != token.TYPE {
				continue
			}
			for _, s := range gen.Specs {
				ts := s.(*ast.TypeSpec)
				st, ok := ts.Type.(*ast.StructType)
				if !ok {
					continue
				}
				tn, ok := pkg.TypesInfo.Defs[ts.Name].(*types.TypeName)
				if !ok {
					continue
				}
				// The generator's NullableX wrappers are decode plumbing, not
				// contract shapes.
				if strings.HasPrefix(tn.Name(), "Nullable") {
					continue
				}
				for _, af := range st.Fields.List {
					for _, name := range af.Names {
						v, ok := pkg.TypesInfo.Defs[name].(*types.Var)
						if !ok || !v.Exported() {
							continue
						}
						tag := ""
						if af.Tag != nil {
							tag = strings.Trim(af.Tag.Value, "`")
						}
						f := buildField(pkg, tn, v, tag, docText(af), spec, ix, extra)
						ix.Fields[f.Key] = f
					}
				}
			}
		}
	}
	return nil
}

func docText(f *ast.Field) string {
	var parts []string
	if f.Doc != nil {
		parts = append(parts, f.Doc.Text())
	}
	if f.Comment != nil {
		parts = append(parts, f.Comment.Text())
	}
	return strings.TrimSpace(strings.Join(parts, " "))
}

func buildField(pkg *packages.Package, owner *types.TypeName, v *types.Var, tag, doc string, spec *openapi.Spec, ix *Index, extra []constraint.DocPattern) *Field {
	jsonName, omitempty := jsonTag(tag, v.Name())
	f := &Field{
		Key:      FieldKey{Pkg: pkg.PkgPath, Type: owner.Name(), Field: v.Name()},
		PkgName:  pkg.Name,
		JSONName: jsonName,
		GoType:   types.TypeString(v.Type(), qualifier(pkg.Types)),
		Pos:      pkg.Fset.Position(v.Pos()),
	}
	t := v.Type()
	_, isPtr := t.(*types.Pointer)
	isNullable := false
	if named, ok := t.(*types.Named); ok && strings.HasPrefix(named.Obj().Name(), "Nullable") {
		isNullable = true
	}
	var prop *openapi.Property
	if spec != nil {
		if p, ok := spec.Property(owner.Name(), jsonName); ok {
			prop = &p
		}
	}

	switch t.Underlying().(type) {
	case *types.Slice, *types.Map:
		// The generated decode admits null for a required array or map, so
		// the Go shape alone proves nothing; the spec does. A required
		// property that is not nullable is non-null.
		if !omitempty && prop != nil && !prop.Nullable {
			f.Required = true
			f.Guarantees = append(f.Guarantees, constraint.Guarantee{
				Kind:     constraint.KindRequiredNonNull,
				Why:      "the contract requires the field and does not allow null",
				Evidence: "required, not nullable",
			})
		}
	case *types.Pointer, *types.Interface, *types.Signature, *types.Chan:
		// nil is a legal decode of all of these, so none is non-null.
	default:
		if !isPtr && !isNullable && !omitempty {
			f.Required = true
			f.Guarantees = append(f.Guarantees, constraint.Guarantee{
				Kind:     constraint.KindRequiredNonNull,
				Why:      "the contract requires the field and does not allow null",
				Evidence: "required, not nullable",
			})
		}
	}
	f.Optional = isPtr && omitempty

	elem := t
	if p, ok := t.(*types.Pointer); ok {
		elem = p.Elem()
	}
	switch u := elem.Underlying().(type) {
	case *types.Basic:
		if u.Info()&types.IsInteger != 0 {
			if iv, ok := constraint.IntegerWidth(u.Name()); ok {
				f.Guarantees = append(f.Guarantees, constraint.Guarantee{
					Kind:     constraint.KindIntegerWidth,
					Interval: iv,
					IntType:  u.Name(),
					Why:      "the contract types the field as " + u.Name(),
					Evidence: u.Name(),
				})
			}
		}
		if u.Info()&types.IsNumeric != 0 {
			if g, ok := numericFromSpec(prop); ok {
				f.Guarantees = append(f.Guarantees, g)
			}
			if g, ok := constraint.FromDoc(doc, false, extra); ok {
				f.Guarantees = append(f.Guarantees, g)
			}
		}
		if named, ok := elem.(*types.Named); ok && u.Info()&types.IsString != 0 {
			if e, ok := ix.LookupEnum(named.Obj().Pkg().Path(), named.Obj().Name()); ok {
				f.Guarantees = append(f.Guarantees, enumGuarantee(e))
			}
		}
	case *types.Slice:
		if prop != nil && prop.MinItems != nil && *prop.MinItems >= 1 {
			f.Guarantees = append(f.Guarantees, constraint.Guarantee{
				Kind:     constraint.KindNonEmptyArray,
				Interval: constraint.Closed(float64(*prop.MinItems), math.Inf(1)),
				Why:      "the contract guarantees a non-empty collection",
				Evidence: fmt.Sprintf("minItems: %d", *prop.MinItems),
			})
		} else if g, ok := constraint.FromDoc(doc, true, extra); ok {
			f.Guarantees = append(f.Guarantees, g)
		}
	}
	for i := range f.Guarantees {
		f.Guarantees[i].Origin = constraint.OriginContract
	}
	f.Guarantees = constraint.Dedupe(f.Guarantees)
	return f
}

func enumGuarantee(e *Enum) constraint.Guarantee {
	return constraint.Guarantee{
		Kind:     constraint.KindEnumMember,
		Members:  append([]string(nil), e.Members...),
		EnumType: e.PkgName + "." + e.Type,
		Why:      "the contract decodes only " + strings.Join(e.Members, " | "),
		Evidence: e.PkgName + "." + e.Type,
		Origin:   constraint.OriginContract,
	}
}

// EnumGuarantee renders an indexed enum as a guarantee on a value of that
// type.
func (ix *Index) EnumGuarantee(pkgPath, typeName string) (constraint.Guarantee, bool) {
	e, ok := ix.LookupEnum(pkgPath, typeName)
	if !ok {
		return constraint.Guarantee{}, false
	}
	return enumGuarantee(e), true
}

func numericFromSpec(p *openapi.Property) (constraint.Guarantee, bool) {
	if p == nil {
		return constraint.Guarantee{}, false
	}
	iv := constraint.Unbounded
	var evidence []string
	switch {
	case p.ExclusiveMinimum != nil:
		iv.Lo, iv.LoExclusive = *p.ExclusiveMinimum, true
		evidence = append(evidence, fmt.Sprintf("exclusiveMinimum: %v", *p.ExclusiveMinimum))
	case p.Minimum != nil:
		iv.Lo = *p.Minimum
		evidence = append(evidence, fmt.Sprintf("minimum: %v", *p.Minimum))
	}
	switch {
	case p.ExclusiveMaximum != nil:
		iv.Hi, iv.HiExclusive = *p.ExclusiveMaximum, true
		evidence = append(evidence, fmt.Sprintf("exclusiveMaximum: %v", *p.ExclusiveMaximum))
	case p.Maximum != nil:
		iv.Hi = *p.Maximum
		evidence = append(evidence, fmt.Sprintf("maximum: %v", *p.Maximum))
	}
	if iv.IsUnbounded() {
		return constraint.Guarantee{}, false
	}
	g := constraint.Guarantee{Interval: iv, Evidence: strings.Join(evidence, ", ")}
	switch {
	case iv.Lo == 0 && iv.LoExclusive && iv.Hi == constraint.Unbounded.Hi:
		g.Kind, g.Why = constraint.KindPositive, "the contract guarantees a strictly positive value"
	case iv.Lo == 0 && !iv.LoExclusive && iv.Hi == constraint.Unbounded.Hi:
		g.Kind, g.Why = constraint.KindNonNegative, "the contract guarantees a non-negative value"
	default:
		g.Kind, g.Why = constraint.KindRange, "the contract pins the value to "+iv.String()
	}
	return g, true
}

func jsonTag(tag, fieldName string) (name string, omitempty bool) {
	value, ok := reflect.StructTag(tag).Lookup("json")
	if !ok {
		return fieldName, false
	}
	parts := strings.Split(value, ",")
	name = parts[0]
	if name == "" || name == "-" {
		name = fieldName
	}
	for _, opt := range parts[1:] {
		if opt == "omitempty" {
			omitempty = true
		}
	}
	return name, omitempty
}

func qualifier(self *types.Package) types.Qualifier {
	return func(p *types.Package) string {
		if p == self {
			return ""
		}
		return p.Name()
	}
}

// Sorted returns the fields in a stable order for the audit listing.
func (ix *Index) Sorted() []*Field {
	out := make([]*Field, 0, len(ix.Fields))
	for _, f := range ix.Fields {
		out = append(out, f)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Key.Pkg != out[j].Key.Pkg {
			return out[i].Key.Pkg < out[j].Key.Pkg
		}
		if out[i].Key.Type != out[j].Key.Type {
			return out[i].Key.Type < out[j].Key.Type
		}
		return out[i].Key.Field < out[j].Key.Field
	})
	return out
}
