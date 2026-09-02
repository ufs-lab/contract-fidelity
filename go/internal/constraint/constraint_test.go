package constraint

import (
	"math"
	"testing"
)

func TestDecideComparison(t *testing.T) {
	positive := Positive()
	nonNeg := NonNegative()
	site := Closed(1, 31)
	cases := []struct {
		name string
		iv   Interval
		op   string
		k    float64
		want Verdict
	}{
		{"positive > 0", positive, ">", 0, AlwaysTrue},
		{"positive == 0", positive, "==", 0, AlwaysFalse},
		{"positive >= 1", positive, ">=", 1, Undecided},
		{"non-negative >= 0", nonNeg, ">=", 0, AlwaysTrue},
		{"non-negative > 0 is a real presence test", nonNeg, ">", 0, Undecided},
		{"non-negative < 0", nonNeg, "<", 0, AlwaysFalse},
		{"range > 31", site, ">", 31, AlwaysFalse},
		{"range > 10", site, ">", 10, Undecided},
		{"range <= 31", site, "<=", 31, AlwaysTrue},
		{"range != 40", site, "!=", 40, AlwaysTrue},
		{"point == k", Point(7), "==", 7, AlwaysTrue},
		{"infinite k", site, ">", math.Inf(1), Undecided},
	}
	for _, c := range cases {
		if got := DecideComparison(c.iv, c.op, c.k); got != c.want {
			t.Errorf("%s: got %s, want %s", c.name, got, c.want)
		}
	}
}

func TestFlipOperator(t *testing.T) {
	// `0 < amount` is `amount > 0`.
	if FlipOperator("<") != ">" || FlipOperator(">=") != "<=" || FlipOperator("==") != "==" {
		t.Fatal("flip is not the mirror")
	}
}

func TestHullAndWithin(t *testing.T) {
	h := Hull(Closed(400, 599), Point(0))
	if h.Lo != 0 || h.Hi != 599 {
		t.Fatalf("hull = %s", h)
	}
	if !Within(Point(0), Closed(-5, 5)) || Within(Point(6), Closed(-5, 5)) {
		t.Fatal("within is wrong")
	}
	if Within(Point(0), Positive()) {
		t.Fatal("0 is not within (0, +inf)")
	}
}

func TestJoinKeepsTheWiderTypedWrite(t *testing.T) {
	width, _ := IntegerWidth("int32")
	int32G := Guarantee{Kind: KindIntegerWidth, Interval: width, IntType: "int32"}
	zero := Guarantee{Kind: KindRange, Interval: Point(0)}
	joined := Join([]Guarantee{int32G}, []Guarantee{zero})
	if len(joined) != 1 || joined[0].Kind != KindIntegerWidth || joined[0].IntType != "int32" {
		t.Fatalf("a literal inside the int32 range must keep the int32: %+v", joined)
	}
	outside := Guarantee{Kind: KindRange, Interval: Point(1 << 40)}
	joined = Join([]Guarantee{int32G}, []Guarantee{outside})
	if len(joined) != 1 || joined[0].Kind != KindRange || joined[0].IntType != "" {
		t.Fatalf("a literal outside the range widens to a plain range: %+v", joined)
	}
}

func TestJoinEnums(t *testing.T) {
	a := Guarantee{Kind: KindEnumMember, Members: []string{"COMMITTED", "ERROR"}, EnumType: "client.Status"}
	b := Guarantee{Kind: KindEnumMember, Members: []string{"PARTIAL"}}
	joined := Join([]Guarantee{a}, []Guarantee{b})
	if len(joined) != 1 || len(joined[0].Members) != 3 || joined[0].EnumType != "" {
		t.Fatalf("a literal outside the enum drops the type: %+v", joined)
	}
	mixed := Join([]Guarantee{a}, []Guarantee{{Kind: KindRange, Interval: Point(1)}})
	if len(mixed) != 0 {
		t.Fatalf("enum joined with a number is unconstrained: %+v", mixed)
	}
}

func TestFromDoc(t *testing.T) {
	cases := []struct {
		doc     string
		isArray bool
		kind    Kind
		ok      bool
	}{
		{"Amount in minor units (must be > 0).", false, KindPositive, true},
		{"Must be greater than zero unless the `zero_amount` directive is present.", false, "", false},
		{"Counts are non-negative.", false, KindNonNegative, true},
		{"Non-negative rows are ignored.", false, "", false},
		{"Site identifier (1-31, per REQ-004)", false, KindRange, true},
		{"between 1 and 31", false, KindRange, true},
		{"The array is non-empty.", true, KindNonEmptyArray, true},
		{"Non-empty means the event is excluded from matching.", true, "", false},
		{"at least one is required", true, KindNonEmptyArray, true},
		{"Optional. Must be > 0 when present.", false, "", false},
		{"", false, "", false},
	}
	for _, c := range cases {
		g, ok := FromDoc(c.doc, c.isArray, nil)
		if ok != c.ok || (ok && g.Kind != c.kind) {
			t.Errorf("%q: got (%s, %v), want (%s, %v)", c.doc, g.Kind, ok, c.kind, c.ok)
		}
	}
	g, ok := FromDoc("Site identifier (1-31, per REQ-004)", false, nil)
	if !ok || g.Interval.Lo != 1 || g.Interval.Hi != 31 {
		t.Fatalf("range bounds: %+v", g)
	}
}

func TestCompileDocPatterns(t *testing.T) {
	if _, err := CompileDocPatterns([]DocPatternSpec{{Source: `\bbounds (\d+)\.\.(\d+)\b`, Kind: "range"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := CompileDocPatterns([]DocPatternSpec{{Source: `\bbounds\b`, Kind: "range"}}); err == nil {
		t.Fatal("a range pattern without two captures must be rejected")
	}
	if _, err := CompileDocPatterns([]DocPatternSpec{{Source: `x`, Kind: "weird"}}); err == nil {
		t.Fatal("an unknown kind must be rejected")
	}
	if _, err := CompileDocPatterns([]DocPatternSpec{{Source: `(`, Kind: "positive"}}); err == nil {
		t.Fatal("an invalid regex must be rejected")
	}
	extra, _ := CompileDocPatterns([]DocPatternSpec{{Source: `\bstrictly positive\b`, Flags: "i", Kind: "positive"}})
	if g, ok := FromDoc("This value is Strictly Positive.", false, extra); !ok || g.Kind != KindPositive {
		t.Fatal("a project pattern must win")
	}
}
