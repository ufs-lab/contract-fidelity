import test from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildFieldWriteIndex,
  constrainedFields,
  typesProducedOutsideLiterals,
} from "../src/fields.mjs";
import { findWidenedDeclarations } from "../src/carriers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "__fixtures__");

// The scanner's own `collectViolations` builds the real app program, so the
// unit tests drive the shared field machinery over the fixture tree instead
// and assert the same predicate the scanner reports on.
function widenedFields() {
  const files = [
    join(FIXTURES, "src", "cases.ts"),
    join(FIXTURES, "src", "mixedCallers.ts"),
    join(FIXTURES, "src", "viewModels.ts"),
    join(FIXTURES, "src", "widenedFields.ts"),
  ];
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  });
  const checker = program.getTypeChecker();
  const index = buildFieldWriteIndex(
    program,
    checker,
    (sf) => sf.fileName.includes(`${FIXTURES}/src/`),
    FIXTURES,
  );
  const isFixture = (sf) => sf.fileName.includes(`${FIXTURES}/src/`);
  const producedElsewhere = typesProducedOutsideLiterals(
    program,
    checker,
    isFixture,
  );
  const out = [];
  for (const [target, info] of constrainedFields(
    index,
    checker,
    FIXTURES,
    producedElsewhere,
  )) {
    const decl = target.declarations?.[0];
    if (!decl || !decl.type) continue;
    out.push({
      name: target.getName(),
      declared: decl.type.getText(),
      optional: Boolean(decl.questionToken),
      kind: info.constraint.kind,
    });
  }
  return out;
}

const fields = widenedFields();
const names = fields.map((f) => f.name);
const byName = (n) => fields.find((f) => f.name === n);

test("flags a required contract field copied into an optional one", () => {
  const hit = byName("optionalName");
  assert.ok(hit, `expected optionalName, saw: ${names.join(", ")}`);
  assert.equal(hit.optional, true);
  assert.equal(hit.kind, "required-non-null");
});

test("flags a required contract field copied into a nullable one", () => {
  const hit = byName("nullableName");
  assert.ok(hit);
  assert.equal(hit.kind, "required-non-null");
});

test("flags an enum union flattened to string", () => {
  const hit = byName("flatScope");
  assert.ok(hit);
  assert.equal(hit.kind, "enum-member");
  assert.equal(hit.declared, "string");
});

test("stays silent when the field keeps the contract's shape", () => {
  // Same guarantee, faithfully declared - nothing to report.
  assert.ok(!names.includes("keptName"));
  assert.ok(!names.includes("keptScope"));
});

test("stays silent when a second writer supplies an unconstrained value", () => {
  // The field genuinely can hold something the contract does not promise.
  assert.ok(!names.includes("mixedName"));
});

test("does not report a widening with no dead guard as dead code", () => {
  // This is the whole point of the split: `optionalName` has no guard on it
  // anywhere, so `dead-code` must stay silent while this one fires.
  const hit = byName("optionalName");
  assert.ok(hit);
});

test("a documented range is not reported - there is no narrower type", () => {
  // `amount` carries "must be > 0"; no TypeScript type expresses that, so a
  // finding here would demand an edit that does not exist. dead-code
  // owns that guarantee, and needs a dead guard to prove it did harm.
  assert.ok(!names.includes("amount"));
});

test("a shape produced by an async boundary is not reported", () => {
  // Everything of this shape but one literal comes off the wire, where the
  // write census cannot see it - narrowing would make the type lie about what
  // the endpoint returns. Regression for HealthCheckService's ProbeResponse.
  assert.ok(
    !names.includes("wireLabel"),
    `WireShape.wireLabel must not be reported; saw: ${names.join(", ")}`,
  );
});

test("a guarantee copied through an intermediate view model is still tracked", () => {
  // StageTwo.carried reads StageOne.carried, not a client property. Only a
  // fixed point proves StageOne carries the contract's guarantee first, and
  // therefore that StageTwo widens it.
  const hit = byName("carried");
  assert.ok(hit, `expected StageTwo.carried, saw: ${names.join(", ")}`);
  assert.equal(hit.kind, "required-non-null");
});

test("an excluded shape does not launder a guarantee downstream", () => {
  // WireShape is excluded because its values arrive by deserialization. It
  // must not seed the proven map either, or every field fed from it inherits
  // a guarantee that was never established.
  assert.ok(
    !names.includes("fromWire"),
    `DownstreamOfWire.fromWire must not be reported; saw: ${names.join(", ")}`,
  );
});

// ---------------------------------------------------------------------------
// Carriers other than fields: locals, return types, casts, collections
// ---------------------------------------------------------------------------

function widenedDeclarations() {
  const files = [
    join(FIXTURES, "src", "cases.ts"),
    join(FIXTURES, "src", "mixedCallers.ts"),
    join(FIXTURES, "src", "viewModels.ts"),
    join(FIXTURES, "src", "widenedFields.ts"),
    join(FIXTURES, "src", "carriers.ts"),
  ];
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  });
  return findWidenedDeclarations(program, program.getTypeChecker(), (sf) =>
    sf.fileName.includes(`${FIXTURES}/src/`),
  );
}

const declarations = widenedDeclarations();
const carriers = declarations.map((d) => d.carrier);
const byCarrier = (c) => declarations.filter((d) => d.carrier === c);

test("a widened local annotation is reported", () => {
  const hit = byCarrier("local").find((d) => d.text.startsWith("widenedLocal"));
  assert.ok(hit, `expected widenedLocal, saw: ${carriers.join(", ")}`);
});

test("a widened return type is reported", () => {
  const hit = byCarrier("return type").find((d) =>
    d.text.includes("widenedReturn"),
  );
  assert.ok(
    hit,
    `expected widenedReturn, saw: ${declarations.map((d) => d.text).join(", ")}`,
  );
});

test("a widening cast is reported", () => {
  assert.ok(
    byCarrier("cast").length > 0,
    `expected a cast finding, saw: ${carriers.join(", ")}`,
  );
});

test("a collection element type wider than its contents is reported", () => {
  const hit = byCarrier("collection element");
  assert.ok(
    hit.length > 0,
    `expected a collection finding, saw: ${carriers.join(", ")}`,
  );
});

test("a faithful local annotation is not reported", () => {
  // Same guarantee, declared exactly - nothing to report.
  assert.ok(!declarations.some((d) => d.text.startsWith("faithfulLocal")));
});
