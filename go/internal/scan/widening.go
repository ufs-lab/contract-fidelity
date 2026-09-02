package scan

import (
	"go/types"

	"github.com/ufs-lab/contract-fidelity/go/internal/constraint"
)

// Widenings reports every carrier declared wider than every value that
// reaches it, where the narrower declaration is a type the finding can
// name: the contract's enum type for a string, or the contract's integer
// width for a wider integer.
func (p *Program) Widenings() []WideningFinding {
	var out []WideningFinding
	seen := map[string]bool{}
	for _, c := range p.carriers {
		if isTestFile(c.pos.Filename) {
			continue
		}
		f, ok := p.carrierWidening(c)
		if !ok {
			continue
		}
		key := f.File + ":" + itoa(f.Line) + ":" + f.Fingerprint()
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, f)
	}
	sortWidenings(out)
	return out
}

func (p *Program) carrierWidening(c *carrier) (WideningFinding, bool) {
	if c.disqualified != "" || !c.resolvedOK || !c.fromContract || len(c.resolved) == 0 {
		return WideningFinding{}, false
	}
	basic, ok := c.declType.Underlying().(*types.Basic)
	if !ok {
		return WideningFinding{}, false
	}
	declared := typeString(c.declType)
	base := WideningFinding{
		File:     p.relPath(c.pos.Filename),
		Line:     c.pos.Line,
		Declared: c.name,
		Type:     declared,
		Contract: contractOf(c.origins),
		Origins:  toOrigins(c.origins),
	}
	if basic.Info()&types.IsString != 0 {
		enum, ok := constraint.Enum(c.resolved)
		if !ok || enum.EnumType == "" || declared == enum.EnumType {
			return WideningFinding{}, false
		}
		base.Suggested = enum.EnumType
		base.Kind = constraint.KindEnumMember
		base.Why = "every value that reaches it is a " + enum.EnumType
		return base, true
	}
	if basic.Info()&types.IsInteger != 0 {
		g, ok := constraint.Has(c.resolved, constraint.KindIntegerWidth)
		if !ok || g.IntType == "" || basic.Name() == g.IntType {
			return WideningFinding{}, false
		}
		declaredWidth, ok := constraint.IntegerWidth(basic.Name())
		if !ok || !constraint.Within(g.Interval, declaredWidth) || declaredWidth == g.Interval {
			return WideningFinding{}, false
		}
		base.Suggested = g.IntType
		base.Kind = constraint.KindIntegerWidth
		base.Why = "every value that reaches it is an " + g.IntType
		return base, true
	}
	return WideningFinding{}, false
}
