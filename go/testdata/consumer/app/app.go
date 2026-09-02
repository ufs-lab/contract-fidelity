// Package app consumes the fixture client the way a real service does.
package app

import (
	"example.com/client"
)

// view is the projection a classifier reads: it widens the enum to a
// string and the int32 status to an int.
type view struct {
	Index  int
	Status string
	Err    *viewErr
}

type viewErr struct {
	Status int
	Type   string
}

func project(r client.BatchResult) view {
	v := view{Index: int(r.Index), Status: string(r.Status)}
	if r.Error != nil {
		v.Err = &viewErr{Status: int(r.Error.Status), Type: r.Error.Type}
	}
	return v
}

// classify has a default the enum makes unreachable, and a status range
// check the contract decides.
func classify(v view) string {
	switch v.Status {
	case "COMMITTED":
		return "ok"
	case "ERROR":
		if v.Err != nil && isDeclared(v.Err.Status) {
			return "declared"
		}
		return "err"
	default:
		return "unknown"
	}
}

func isDeclared(status int) bool {
	return status >= 400 && status <= 599
}

// index guards a value the schema pins to [0, 65535]; the upper bound is a
// real check against the request size.
func index(r client.BatchResult, n int) int {
	idx := int(r.Index)
	if idx < 0 || idx >= n {
		return -1
	}
	return idx
}

// items reads a non-empty collection.
func items(r client.BatchResult) bool {
	return len(r.Items) == 0
}

// amount reads prose: "must be > 0".
func amount(m client.Movement) bool {
	return m.Amount > 0
}

// count: "non-negative" leaves `> 0` a real presence test.
func count(m client.Movement) bool {
	return m.Count > 0
}

// liveParam is called from a test with a value outside the contract, so
// its guard stays live when the census counts tests.
func liveParam(site int) bool {
	return site > 100
}

// Site is called only with the contract's int32 site id.
func site(m client.Movement) bool {
	return liveParam(int(m.SiteId))
}

// codes widens an int32 PK to int64 through a map, then narrows it again.
type code struct {
	ID int64
}

func codes(ms []client.Movement) map[string]code {
	out := map[string]code{}
	for _, m := range ms {
		out["x"] = code{ID: int64(m.SiteId)}
	}
	return out
}

func narrow(c code) bool {
	return c.ID > 2147483647
}

var _ = project
var _ = classify
var _ = index
var _ = items
var _ = amount
var _ = count
var _ = site
var _ = codes
var _ = narrow

// registry holds the map on a field, as a real provisioner does.
type registry struct {
	byName map[string]code
}

func newRegistry(ms []client.Movement) registry {
	local := map[string]code{}
	for _, m := range ms {
		local["x"] = code{ID: int64(m.SiteId)}
	}
	return registry{byName: local}
}

func (r registry) lookup(name string) bool {
	c := r.byName[name]
	return c.ID > 2147483647
}

var _ = newRegistry
var _ = registry.lookup

// itemsNil guards a required, non-nullable array the spec makes non-null.
func itemsNil(r client.BatchResult) bool {
	return r.Items == nil
}

// outcome is the program's own closed vocabulary: no contract, but every
// write into report.Outcome is one of its constants.
type outcome string

const (
	outcomeOK   outcome = "ok"
	outcomeFail outcome = "fail"
)

type report struct {
	Outcome string
}

func mkReport(good bool) report {
	if good {
		return report{Outcome: string(outcomeOK)}
	}
	return report{Outcome: string(outcomeFail)}
}

func render(r report) string {
	switch r.Outcome {
	case "ok":
		return "+"
	case "fail":
		return "-"
	default:
		return "?"
	}
}

// describe is called with an address from production and with nil from a
// test, so its nil guard is live only while the census counts tests.
func describe(e *viewErr) string {
	if e == nil {
		return ""
	}
	return e.Type
}

func callDescribe(v viewErr) string {
	return describe(&v)
}

var _ = itemsNil
var _ = mkReport
var _ = render
var _ = callDescribe
