// Package constraint is the owner of what "narrow" means and of every
// always-true / always-false decision the analyzer makes. It is pure: no
// go/types, no filesystem, so the decision table is unit-testable alone.
package constraint

import (
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Kind names the guarantee a contract field carries.
type Kind string

const (
	KindPositive        Kind = "positive"
	KindNonNegative     Kind = "non-negative"
	KindRange           Kind = "range"
	KindIntegerWidth    Kind = "integer-width"
	KindNonEmptyArray   Kind = "non-empty-array"
	KindEnumMember      Kind = "enum-member"
	KindRequiredNonNull Kind = "required-non-null"
)

// Verdict is the outcome of deciding a guard against a guarantee.
type Verdict string

const (
	AlwaysTrue  Verdict = "always-true"
	AlwaysFalse Verdict = "always-false"
	Undecided   Verdict = "undecided"
)

// Interval is a closed-or-open range over the reals. Lo: 0, LoExclusive:
// true is "must be > 0".
type Interval struct {
	Lo, Hi                   float64
	LoExclusive, HiExclusive bool
}

// Unbounded holds every real.
var Unbounded = Interval{Lo: math.Inf(-1), Hi: math.Inf(1)}

// Closed builds the closed interval [lo, hi].
func Closed(lo, hi float64) Interval { return Interval{Lo: lo, Hi: hi} }

// Point builds the single-value interval [k, k].
func Point(k float64) Interval { return Closed(k, k) }

// Positive is (0, +inf).
func Positive() Interval { return Interval{Lo: 0, Hi: math.Inf(1), LoExclusive: true} }

// NonNegative is [0, +inf).
func NonNegative() Interval { return Interval{Lo: 0, Hi: math.Inf(1)} }

// IsUnbounded reports whether iv constrains nothing.
func (iv Interval) IsUnbounded() bool {
	return math.IsInf(iv.Lo, -1) && math.IsInf(iv.Hi, 1)
}

// Hull is the smallest interval holding both a and b: the join used when a
// carrier has several writers.
func Hull(a, b Interval) Interval {
	out := a
	switch {
	case b.Lo < a.Lo:
		out.Lo, out.LoExclusive = b.Lo, b.LoExclusive
	case b.Lo == a.Lo:
		out.LoExclusive = a.LoExclusive && b.LoExclusive
	}
	switch {
	case b.Hi > a.Hi:
		out.Hi, out.HiExclusive = b.Hi, b.HiExclusive
	case b.Hi == a.Hi:
		out.HiExclusive = a.HiExclusive && b.HiExclusive
	}
	return out
}

// Within reports whether every value of inner is a value of outer.
func Within(inner, outer Interval) bool {
	if inner.Lo < outer.Lo || (inner.Lo == outer.Lo && outer.LoExclusive && !inner.LoExclusive) {
		return false
	}
	if inner.Hi > outer.Hi || (inner.Hi == outer.Hi && outer.HiExclusive && !inner.HiExclusive) {
		return false
	}
	return true
}

func (iv Interval) String() string {
	lo := "("
	if !iv.LoExclusive {
		lo = "["
	}
	hi := ")"
	if !iv.HiExclusive {
		hi = "]"
	}
	return lo + num(iv.Lo) + ", " + num(iv.Hi) + hi
}

func num(f float64) string {
	switch {
	case math.IsInf(f, 1):
		return "+inf"
	case math.IsInf(f, -1):
		return "-inf"
	}
	return strconv.FormatFloat(f, 'f', -1, 64)
}

func alwaysGt(iv Interval, k float64) bool { return iv.Lo > k || (iv.Lo == k && iv.LoExclusive) }
func alwaysLe(iv Interval, k float64) bool { return iv.Hi <= k }
func alwaysLt(iv Interval, k float64) bool { return iv.Hi < k || (iv.Hi == k && iv.HiExclusive) }
func alwaysGe(iv Interval, k float64) bool { return iv.Lo >= k }

func canEqual(iv Interval, k float64) bool {
	if k < iv.Lo || k > iv.Hi {
		return false
	}
	if k == iv.Lo && iv.LoExclusive {
		return false
	}
	if k == iv.Hi && iv.HiExclusive {
		return false
	}
	return true
}

// DecideComparison decides `value OP k` where value ranges over iv. The
// operator is the Go token text: ">", ">=", "<", "<=", "==", "!=".
func DecideComparison(iv Interval, op string, k float64) Verdict {
	if math.IsNaN(k) || math.IsInf(k, 0) {
		return Undecided
	}
	switch op {
	case ">":
		if alwaysGt(iv, k) {
			return AlwaysTrue
		}
		if alwaysLe(iv, k) {
			return AlwaysFalse
		}
	case ">=":
		if alwaysGe(iv, k) {
			return AlwaysTrue
		}
		if alwaysLt(iv, k) {
			return AlwaysFalse
		}
	case "<":
		if alwaysLt(iv, k) {
			return AlwaysTrue
		}
		if alwaysGe(iv, k) {
			return AlwaysFalse
		}
	case "<=":
		if alwaysLe(iv, k) {
			return AlwaysTrue
		}
		if alwaysGt(iv, k) {
			return AlwaysFalse
		}
	case "==":
		if !canEqual(iv, k) {
			return AlwaysFalse
		}
		if iv.Lo == iv.Hi && iv.Lo == k {
			return AlwaysTrue
		}
	case "!=":
		if !canEqual(iv, k) {
			return AlwaysTrue
		}
		if iv.Lo == iv.Hi && iv.Lo == k {
			return AlwaysFalse
		}
	}
	return Undecided
}

// FlipOperator mirrors a comparison written constant-first (`0 < amount`)
// so the caller can normalise to value-first.
func FlipOperator(op string) string {
	switch op {
	case ">":
		return "<"
	case ">=":
		return "<="
	case "<":
		return ">"
	case "<=":
		return ">="
	}
	return op
}

// Guarantee is one fact a contract states about a value, or that the
// analyzer derived by following the value.
type Guarantee struct {
	Kind Kind
	// Interval is set for the numeric kinds and for non-empty-array (over
	// the length).
	Interval Interval
	// Members is the closed set of legal string values for enum-member.
	Members []string
	// EnumType is the Go type that carries Members, when it names one
	// (`pkg.Status`). A widening report suggests it.
	EnumType string
	// IntType is the Go basic type an integer-width guarantee derives from
	// (`int32`). A widening report suggests it.
	IntType string
	// Why is the reason printed under a finding.
	Why string
	// Evidence is the doc sentence, schema keyword or type the guarantee
	// was read from.
	Evidence string
	// Origin is OriginContract for a guarantee read off a generated
	// client, OriginInferred for one the census derived from the program's
	// own types and writes, and empty for a literal or a zero value.
	Origin string
}

// The two sources of a guarantee. A finding names which one it came from,
// and never says "the contract" about a guarantee the census supplied.
const (
	OriginContract = "contract"
	OriginInferred = "inferred"
)

// StrongerOrigin picks the origin a join reports: a contract beats an
// inference, and either beats a literal.
func StrongerOrigin(a, b string) string {
	switch {
	case a == OriginContract || b == OriginContract:
		return OriginContract
	case a == OriginInferred || b == OriginInferred:
		return OriginInferred
	}
	return ""
}

// IsNumeric reports whether the guarantee bounds a number.
func (g Guarantee) IsNumeric() bool {
	switch g.Kind {
	case KindPositive, KindNonNegative, KindRange, KindIntegerWidth:
		return true
	}
	return false
}

// MemberSet renders Members as a lookup.
func (g Guarantee) MemberSet() map[string]bool {
	out := make(map[string]bool, len(g.Members))
	for _, m := range g.Members {
		out[m] = true
	}
	return out
}

// Join folds two guarantee sets for one carrier with two writers: a kind
// survives only when both writers carry it, and its bounds widen to hold
// both. An empty result means the carrier is unconstrained.
func Join(a, b []Guarantee) []Guarantee {
	var out []Guarantee
	for _, ga := range a {
		for _, gb := range b {
			if joined, ok := joinOne(ga, gb); ok {
				out = append(out, joined)
			}
		}
	}
	return Dedupe(out)
}

func joinOne(a, b Guarantee) (Guarantee, bool) {
	switch {
	case a.IsNumeric() && b.IsNumeric():
		// A write inside the other's bounds changes nothing about the
		// carrier: a literal 0 into an int32-typed flow keeps the int32.
		origin := StrongerOrigin(a.Origin, b.Origin)
		if Within(b.Interval, a.Interval) {
			a.Origin = origin
			return a, true
		}
		if Within(a.Interval, b.Interval) {
			b.Origin = origin
			return b, true
		}
		out := a
		out.Interval = Hull(a.Interval, b.Interval)
		if out.Interval.IsUnbounded() {
			return Guarantee{}, false
		}
		out.Kind = KindRange
		out.IntType = ""
		out.Why = "every value that reaches it is bounded"
		out.Evidence = ""
		out.Origin = origin
		return out, true
	case a.Kind == KindEnumMember && b.Kind == KindEnumMember:
		out := a
		set := a.MemberSet()
		for _, m := range b.Members {
			if !set[m] {
				out.Members = append(out.Members, m)
			}
		}
		sort.Strings(out.Members)
		if a.EnumType != b.EnumType {
			out.EnumType = ""
		}
		out.Origin = StrongerOrigin(a.Origin, b.Origin)
		return out, true
	case a.Kind == b.Kind && (a.Kind == KindNonEmptyArray || a.Kind == KindRequiredNonNull):
		out := a
		out.Origin = StrongerOrigin(a.Origin, b.Origin)
		return out, true
	}
	return Guarantee{}, false
}

// Dedupe collapses guarantees with the same kind, bounds and members.
func Dedupe(gs []Guarantee) []Guarantee {
	seen := map[string]bool{}
	var out []Guarantee
	for _, g := range gs {
		key := fmt.Sprintf("%s|%s|%s|%s|%s|%s", g.Kind, g.Interval, strings.Join(g.Members, ","), g.EnumType, g.IntType, g.Origin)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, g)
	}
	return out
}

// Numeric returns the tightest numeric interval the set implies.
func Numeric(gs []Guarantee) (Interval, bool) {
	found := false
	iv := Unbounded
	for _, g := range gs {
		if !g.IsNumeric() {
			continue
		}
		if !found {
			iv, found = g.Interval, true
			continue
		}
		iv = intersect(iv, g.Interval)
	}
	return iv, found
}

func intersect(a, b Interval) Interval {
	out := a
	if b.Lo > a.Lo || (b.Lo == a.Lo && b.LoExclusive) {
		out.Lo, out.LoExclusive = b.Lo, b.LoExclusive
	}
	if b.Hi < a.Hi || (b.Hi == a.Hi && b.HiExclusive) {
		out.Hi, out.HiExclusive = b.Hi, b.HiExclusive
	}
	return out
}

// Enum returns the enum guarantee in the set, if any.
func Enum(gs []Guarantee) (Guarantee, bool) {
	for _, g := range gs {
		if g.Kind == KindEnumMember {
			return g, true
		}
	}
	return Guarantee{}, false
}

// Has reports whether the set carries kind.
func Has(gs []Guarantee, kind Kind) (Guarantee, bool) {
	for _, g := range gs {
		if g.Kind == kind {
			return g, true
		}
	}
	return Guarantee{}, false
}

// IntegerWidth is the interval a Go integer type can hold.
func IntegerWidth(basic string) (Interval, bool) {
	switch basic {
	case "int8":
		return Closed(math.MinInt8, math.MaxInt8), true
	case "int16":
		return Closed(math.MinInt16, math.MaxInt16), true
	case "int32":
		return Closed(math.MinInt32, math.MaxInt32), true
	case "int64", "int":
		return Closed(math.MinInt64, math.MaxInt64), true
	case "uint8", "byte":
		return Closed(0, math.MaxUint8), true
	case "uint16":
		return Closed(0, math.MaxUint16), true
	case "uint32":
		return Closed(0, math.MaxUint32), true
	case "uint64", "uint", "uintptr":
		return Closed(0, math.MaxUint64), true
	}
	return Interval{}, false
}

// ---------------------------------------------------------------------------
// Reading constraints out of generated-client doc comments
// ---------------------------------------------------------------------------

// DocPattern is a prose pattern that states a numeric guarantee. Each
// built-in pattern was taken from an actual generated client doc string.
type DocPattern struct {
	ID       string
	Kind     Kind
	Re       *regexp.Regexp
	Interval func(m []string) Interval
	Why      string
}

var numericDocPatterns = []DocPattern{
	{
		ID:   "positive",
		Kind: KindPositive,
		// "Amount in minor units (must be > 0)."
		Re:       regexp.MustCompile(`(?i)\b(?:must be|is)\s*(?:>|greater than)\s*(?:0\b|zero\b)`),
		Interval: func([]string) Interval { return Positive() },
		Why:      "the contract guarantees a strictly positive value",
	},
	{
		ID:   "non-negative",
		Kind: KindNonNegative,
		// "Counts are non-negative." A copula is required so prose that only
		// mentions non-negativity cannot pass as a guarantee.
		Re:       regexp.MustCompile(`(?i)\b(?:is|are|will be)\s+(?:always\s+)?non-?negative\b|\bnon-?negative\s+(?:integer|count|number|value)\b`),
		Interval: func([]string) Interval { return NonNegative() },
		Why:      "the contract guarantees a non-negative value",
	},
	{
		ID:   "range",
		Kind: KindRange,
		// "Site identifier (1-31, per REQ-004)"
		Re:       regexp.MustCompile(`\((\d+)\s*-\s*(\d+)\s*(?:,|\))`),
		Interval: rangeInterval,
		Why:      "the contract pins the value to a closed range",
	},
	{
		ID:   "range-between",
		Kind: KindRange,
		// "between 1 and 31"
		Re:       regexp.MustCompile(`(?i)\bbetween\s+(\d+)\s+and\s+(\d+)\b`),
		Interval: rangeInterval,
		Why:      "the contract pins the value to a closed range",
	},
}

func rangeInterval(m []string) Interval {
	lo, _ := strconv.ParseFloat(m[1], 64)
	hi, _ := strconv.ParseFloat(m[2], 64)
	return Closed(lo, hi)
}

// DocPatternSpec is a project-supplied pattern from the config.
type DocPatternSpec struct {
	ID     string `json:"id"`
	Source string `json:"source"`
	Flags  string `json:"flags"`
	Kind   string `json:"kind"`
}

// CompileDocPatterns validates project patterns at load time: a broken
// pattern must fail loud rather than decide comparisons against garbage.
func CompileDocPatterns(specs []DocPatternSpec) ([]DocPattern, error) {
	var out []DocPattern
	for i, spec := range specs {
		at := fmt.Sprintf("docPatterns[%d]", i)
		if spec.Source == "" {
			return nil, fmt.Errorf("contract-fidelity: %s needs a string `source`", at)
		}
		var (
			iv       func([]string) Interval
			why      string
			captures int
		)
		switch spec.Kind {
		case "positive":
			iv, why = func([]string) Interval { return Positive() }, "the contract guarantees a strictly positive value"
		case "non-negative":
			iv, why = func([]string) Interval { return NonNegative() }, "the contract guarantees a non-negative value"
		case "range":
			iv, why, captures = rangeInterval, "the contract pins the value to a closed range", 2
		default:
			return nil, fmt.Errorf("contract-fidelity: %s has unknown kind %q: use one of positive, non-negative, range", at, spec.Kind)
		}
		src := spec.Source
		if strings.Contains(spec.Flags, "i") {
			src = "(?i)" + src
		}
		re, err := regexp.Compile(src)
		if err != nil {
			return nil, fmt.Errorf("contract-fidelity: %s is not a valid regex: %w", at, err)
		}
		if re.NumSubexp() < captures {
			return nil, fmt.Errorf("contract-fidelity: %s declares kind %s but captures %d group(s); %d are required for its bounds", at, spec.Kind, re.NumSubexp(), captures)
		}
		id := spec.ID
		if id == "" {
			id = spec.Kind
		}
		out = append(out, DocPattern{ID: id, Kind: Kind(spec.Kind), Re: re, Interval: iv, Why: why})
	}
	return out, nil
}

// A conditional guarantee is not a guarantee.
var hedgeRe = regexp.MustCompile(`(?i)\b(?:unless|except|may be|might be|can be|otherwise|if\s+the\b|when\s+the\b|when\s+present\b|if\s+present\b|omitted|absent|optional)\b`)

var nonEmptyGuarantees = []*regexp.Regexp{
	regexp.MustCompile(`(?i)\b(?:is|are)\s+(?:always\s+)?non-?empty\b`),
	regexp.MustCompile(`(?i)\bnever\s+empty\b`),
	regexp.MustCompile(`(?i)\bat least one\s+is required\b`),
	regexp.MustCompile(`(?i)\(at least one\)`),
	regexp.MustCompile(`(?i)\bcontains? at least one\b`),
}

// "Non-empty means …" defines the phrase; it claims nothing about the value.
var nonEmptyDefinitionRe = regexp.MustCompile(`(?i)\bnon-?empty\b[^.;]{0,20}\b(?:means|implies|indicates|signals)\b`)

var sentenceSplitRe = regexp.MustCompile(`([.;])\s+`)

func sentences(doc string) []string {
	parts := sentenceSplitRe.Split(doc, -1)
	// The split drops the terminator; the hedge and pattern tests do not
	// depend on it.
	for i := range parts {
		parts[i] = strings.TrimSpace(parts[i])
	}
	return parts
}

// FromDoc extracts the guarantee a doc comment states about the field it
// documents. ok is false when the doc says nothing decidable. The kind is
// read per sentence, so a hedge in one clause cannot void a guarantee in
// another.
func FromDoc(doc string, isArray bool, extra []DocPattern) (Guarantee, bool) {
	if doc == "" {
		return Guarantee{}, false
	}
	for _, s := range sentences(doc) {
		if hedgeRe.MatchString(s) {
			continue
		}
		if isArray {
			if nonEmptyDefinitionRe.MatchString(s) {
				continue
			}
			for _, re := range nonEmptyGuarantees {
				if re.MatchString(s) {
					return Guarantee{
						Kind:     KindNonEmptyArray,
						Interval: Closed(1, math.Inf(1)),
						Why:      "the contract guarantees a non-empty collection",
						Evidence: s,
					}, true
				}
			}
			continue
		}
		for _, p := range append(append([]DocPattern{}, extra...), numericDocPatterns...) {
			if m := p.Re.FindStringSubmatch(s); m != nil {
				return Guarantee{
					Kind:     p.Kind,
					Interval: p.Interval(m),
					Why:      p.Why,
					Evidence: s,
				}, true
			}
		}
	}
	return Guarantee{}, false
}
