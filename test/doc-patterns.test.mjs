// `docPatterns` lets a project describe the prose its own generator writes.
// It was declared in the defaults and read by nothing, which is worse than
// absent: a team configures it, sees no change, and cannot tell whether the
// pattern is wrong or the option is dead.

import test from "node:test";
import assert from "node:assert/strict";

import { compileDocPatterns, constraintFromDoc } from "../src/constraints.mjs";

test("a project pattern yields a constraint the built-ins miss", () => {
  const doc = "Quantity is always strictly positive per RFC-12.";
  assert.equal(constraintFromDoc(doc), null);

  const extraPatterns = compileDocPatterns([
    { source: "\\bstrictly positive\\b", flags: "i", kind: "positive" },
  ]);
  const c = constraintFromDoc(doc, { extraPatterns });
  assert.equal(c.kind, "positive");
  assert.equal(c.numeric, true);
  assert.equal(c.interval.lo, 0);
  assert.equal(c.interval.loExclusive, true);
});

test("a project pattern still loses to a hedge", () => {
  // A conditional guarantee is not a guarantee, whoever wrote the pattern.
  const extraPatterns = compileDocPatterns([
    { source: "\\bstrictly positive\\b", flags: "i", kind: "positive" },
  ]);
  const c = constraintFromDoc("Strictly positive unless the field is unset.", {
    extraPatterns,
  });
  assert.equal(c, null);
});

test("a range pattern that captures no bounds is rejected at load", () => {
  // Accepting it would build an interval from undefined and decide real
  // comparisons against NaN.
  assert.throws(
    () => compileDocPatterns([{ source: "in range", kind: "range" }]),
    /captures 0 group\(s\); 2 are required/,
  );
});

test("an unknown kind is rejected at load", () => {
  assert.throws(
    () => compileDocPatterns([{ source: "x", kind: "enormous" }]),
    /unknown kind "enormous"/,
  );
});

test("an invalid regex is rejected at load", () => {
  assert.throws(
    () => compileDocPatterns([{ source: "(", kind: "positive" }]),
    /not a valid regex/,
  );
});

test("a custom id does not escape the numeric type gate", () => {
  // The gate used to test a hardcoded set of kind ids. A pattern free to name
  // its own id would have slipped a numeric guarantee onto a string field.
  const [pattern] = compileDocPatterns([
    { id: "money-positive", source: "\\bpositive\\b", kind: "positive" },
  ]);
  const c = constraintFromDoc("A positive value.", {
    extraPatterns: [pattern],
  });
  assert.equal(c.kind, "money-positive");
  assert.equal(c.numeric, true);
});

// A doc comment describes ONE field, so a condition stated in any clause is a
// condition on that field's value. Read clause by clause, the guarantee below
// is taken from the first half while the second half says plainly that zero is
// legal. The documented fix for a dead guard is to delete it, so that reading
// deletes a correct check on a value the contract does not constrain.
test("a hedge in a later clause voids the guarantee in an earlier one", () => {
  assert.equal(
    constraintFromDoc("Must be greater than zero for debits; credits may be zero."),
    null,
  );
});

test("a hedge after a full stop voids the guarantee too", () => {
  assert.equal(
    constraintFromDoc("Amount in minor units (must be > 0). It may be absent for reversals."),
    null,
  );
});

test("an unhedged description still yields its guarantee", () => {
  const c = constraintFromDoc("Amount in minor units (must be > 0).");
  assert.equal(c.kind, "positive");
});

// Evidence read by regular expression out of prose is weaker than a declared
// type or a schema keyword, and a caller may decline it. The finding has to
// say which it was.
test("a prose guarantee records that prose is where it came from", () => {
  assert.equal(constraintFromDoc("Counts are non-negative.").derivation, "prose");
  assert.equal(
    constraintFromDoc("The list is non-empty.", { isArray: true }).derivation,
    "prose",
  );
});
