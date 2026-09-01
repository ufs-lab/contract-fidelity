// The inferred constraint source, and the limits on it.
//
// Every limit here came from running the rule over a real application and
// reading what it said. The first version produced 1,224 findings, and about
// half of them were nonsense: narrow this title to the one title I have seen,
// narrow this object field to `true`, narrow `unknown[]` to `any[]`, narrow
// `unknown[]` to `unknown[]`. Each test below pins one of the cuts that
// followed. They are the difference between a rule people keep and one they
// switch off.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  isApplicableSuggestion,
  narrowedDeclaration,
  alignSuggestion,
} from "../src/inferred.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "..", "bin", "contract-fidelity.mjs");
const PROJECT = join(HERE, "__project__");

const CONFIG = join(PROJECT, "contract-fidelity.config.json");

function run(args) {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    cwd: PROJECT,
    encoding: "utf8",
  });
  if (res.error) throw res.error;
  return `${res.stdout}${res.stderr}`;
}

// Run with one config key overridden, then put the file back.
function runWithConfig(overrides, args) {
  const original = readFileSync(CONFIG, "utf8");
  try {
    const merged = { ...JSON.parse(original), ...overrides };
    writeFileSync(CONFIG, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
    return run(args);
  } finally {
    writeFileSync(CONFIG, original, "utf8");
  }
}

// ---------------------------------------------------------------------------
// What counts as a suggestion worth printing
// ---------------------------------------------------------------------------

test("a suggestion must name a type", () => {
  assert.equal(isApplicableSuggestion("ColorTheme", "(): string"), true);
  assert.equal(isApplicableSuggestion("string", "title?: string"), true);
  assert.equal(isApplicableSuggestion("string[]", "x?: string[]"), true);
  assert.equal(
    isApplicableSuggestion("readonly string[]", "x?: readonly string[]"),
    true,
  );
});

test("a structural type is not a suggestion", () => {
  // Proposing a whole function signature, or an object type spelled out, is a
  // diagnostic nobody can apply.
  assert.equal(
    isApplicableSuggestion("(value: unknown) => Element", "render?: X"),
    false,
  );
  assert.equal(
    isApplicableSuggestion("{ inputPer1KTokens: number; }", "PRICING: X"),
    false,
  );
  assert.equal(
    isApplicableSuggestion("[[number, number], [number, number]]", "R: X"),
    false,
  );
});

test("any, unknown and never are never narrowings", () => {
  assert.equal(isApplicableSuggestion("any[]", "x as unknown[]"), false);
  assert.equal(isApplicableSuggestion("unknown[]", "(): unknown[]"), false);
  assert.equal(isApplicableSuggestion("never", "x: string"), false);
});

test("a generic ARGUMENT may mention any", () => {
  // `Record<string, unknown>` is a real narrowing of
  // `Record<string, unknown> | null`, and ag-Grid puts `any` inside its own
  // default type argument. What disqualifies a suggestion is being any or
  // unknown itself.
  assert.equal(
    isApplicableSuggestion("Record<string, unknown>", "args as R | null"),
    true,
  );
  assert.equal(
    isApplicableSuggestion("ColDef<TData, any>[]", "columnDefs?: ColDef[]"),
    true,
  );
});

// ---------------------------------------------------------------------------
// What the suggestion should say
// ---------------------------------------------------------------------------

test("the suggestion keeps the author's own type name", () => {
  // Deriving it from the source type proposed swapping one structurally
  // identical name for another. The finding is about the nullish part, so
  // that is all it proposes removing.
  assert.equal(
    narrowedDeclaration("template: TemplateWithExamples | null | undefined"),
    "TemplateWithExamples",
  );
  assert.equal(narrowedDeclaration("percentage_change?: number | null"), "number");
  assert.equal(narrowedDeclaration("scale: number"), "number");
});

test("a suggestion never quietly drops readonly", () => {
  assert.equal(
    alignSuggestion("string[]", "options?: readonly string[]"),
    "readonly string[]",
  );
  assert.equal(alignSuggestion("string", "name?: string"), "string");
});

// ---------------------------------------------------------------------------
// End to end, on a project with no contract in sight
// ---------------------------------------------------------------------------

test("a widening with no contract anywhere is reported", () => {
  const out = run(["widening", "--list"]);
  assert.match(out, /id: string \| undefined/);
  assert.match(out, /every value written here is present and non-null/);
});

test("an inferred finding never claims a contract said so", () => {
  // A reader who goes looking for a contract that does not exist stops
  // trusting the tool, and rightly.
  const rows = JSON.parse(run(["widening", "--json"]));
  for (const row of rows) {
    if (row.origin === "inferred") {
      assert.doesNotMatch(row.why, /contract/);
    }
  }
});

test("a double cast is reported once, not twice", () => {
  const rows = JSON.parse(run(["widening", "--json"]));
  const doubles = rows.filter((r) => r.declared.includes("as unknown as"));
  assert.equal(doubles.length, 1);
  // And it names the real source, not the `as unknown` hop.
  assert.equal(doubles[0].writes[0].text, "row.status");
});

test("a let whose wider type is doing real work is not reported", () => {
  // `let held: string | undefined = row.id; held = undefined;` needs the
  // wider type. Only a const proves the declared type is the whole story.
  const rows = JSON.parse(run(["widening", "--json"]));
  assert.equal(
    rows.some((r) => r.declared.includes("held")),
    false,
  );
});

test("a parameter one caller feeds an absent value is not reported", () => {
  // The soundness rule that makes the census worth having: unanimity or
  // silence.
  const rows = JSON.parse(run(["widening", "--json"]));
  assert.equal(
    rows.some((r) => r.declared.includes("describeMaybe")),
    false,
  );
  assert.equal(
    rows.some((r) => r.declared.includes("describeId")),
    true,
  );
});

test("closedWorld false stops proving anything about an export", () => {
  const withClosed = JSON.parse(run(["widening", "--json"]));
  assert.equal(
    withClosed.some((r) => r.declared.includes("describePublic")),
    true,
    "an export is provable when the program holds all its callers",
  );

  // The library setting: an export is called by code this program will never
  // see, so its census proves nothing.
  const openWorld = JSON.parse(
    runWithConfig({ closedWorld: false }, ["widening", "--json"]),
  );
  assert.equal(
    openWorld.some((r) => r.declared.includes("describePublic")),
    false,
  );
  assert.equal(
    openWorld.some((r) => r.declared.includes("describeId")),
    true,
    "a module-local function is provable either way",
  );
});

test("inferConstraints false leaves only the contract-anchored findings", () => {
  const rows = JSON.parse(
    runWithConfig({ inferConstraints: false }, ["widening", "--json"]),
  );
  assert.ok(rows.length > 0);
  for (const row of rows) assert.equal(row.origin, "contract");
});

test("an inferred constraint carries a base KIND, not a printed type", () => {
  // Setting `baseKind` to `checker.typeToString(...)` made every typeof and
  // Array.isArray verdict garbage: `Array.isArray` on a mapped array was
  // decided "always-false", because the string "unknown[]" is not the word
  // "array". Anything that reaches classifyGuard must be a kind.
  const rows = JSON.parse(run(["widening", "--json"]));
  assert.ok(rows.length > 0);

  const dead = JSON.parse(run(["dead-code", "--json"]));
  for (const row of dead) {
    if (row.shape === "is-array-test" || row.shape === "typeof-test") {
      assert.ok(
        ["array", "object", "string", "number", "boolean"].includes(
          row.baseKind ?? "array",
        ),
        `unexpected baseKind on ${row.guard}`,
      );
    }
  }
});

test("omitting an optional field counts as a write of absent", () => {
  // Without this the census sees only the literals that supply the field and
  // never the ones that leave it out, so a field written in three places and
  // omitted in thirty reads as always-present. On a real codebase that was
  // about three quarters of every finding.
  const rows = JSON.parse(run(["widening", "--json"]));
  assert.equal(
    rows.some((r) => r.declared.includes("omittedSometimes")),
    false,
  );
  // The control: a field nothing omits is still reported.
  assert.equal(
    rows.some((r) => r.declared.includes("label")),
    true,
  );
});

test("a field written only by a test is not proven", () => {
  // A test supplies whatever the test needs. It proves a branch is reachable,
  // which is why the census reads tests at all, and it proves nothing about
  // what production always supplies.
  const rows = JSON.parse(run(["widening", "--json"]));
  assert.equal(
    rows.some((r) => r.declared.includes("seededByTestOnly")),
    false,
  );
});

// The write census, exercised on the gaps a real codebase exposed. Each of
// these was a finding against correct code until the census learned it.
test("the census is keyed by declaration, not by symbol instance", () => {
  // Box<Row> written with and without `label` through two instantiations;
  // Opts.mode omitted through Partial<Opts>. Under per-instance keying each
  // instantiation kept its own census and the omission never reached the
  // declared field.
  // Scoped to census.ts: orders.ts carries a contract-anchored `label?:`
  // that is a real finding and must stay.
  const rows = JSON.parse(run(["widening", "--json"])).filter(
    (r) => r.file === "app/census.ts",
  );
  assert.equal(rows.some((r) => r.declared.includes("label?: string")), false);
  assert.equal(rows.some((r) => r.declared.includes("mode?: string")), false);
});

test("a null literal written into a field disqualifies it", () => {
  const rows = JSON.parse(run(["widening", "--json"]));
  assert.equal(rows.some((r) => r.declared.includes("held: Row | null")), false);
});

test("a discriminated union arm is never narrowed", () => {
  const rows = JSON.parse(run(["widening", "--json"]));
  assert.equal(rows.some((r) => r.declared.includes("error: Error")), false);
});

test("a shape that is cast into holds values the census never saw", () => {
  // `JSON.parse(raw) as Stored`: the one write the census sees is not the
  // only source of values, so nothing about Stored is provable.
  const rows = JSON.parse(run(["widening", "--json"]));
  assert.equal(rows.some((r) => r.declared.includes("name?: string")), false);
  // And the same exclusion reaches dead-code, which used to skip it.
  const dead = JSON.parse(run(["dead-code", "--json"]));
  assert.equal(dead.some((r) => r.guard.includes("s.name")), false);
  // Including a cast onto an inline shape with no name to exclude.
  assert.equal(
    dead.some((r) => r.guard.includes("shaped.examples")),
    false,
  );
});

test("a whole object of another type flowing into a slot is a write", () => {
  // `useSlot(x)` where x: Src and Src.v is optional. The per-field census
  // sees only the one literal that supplies Slot.v; the whole-object flow is
  // what can make it absent. TrendArrow.trendPercentage was reported for
  // this, and narrowing it produced six compile errors.
  const rows = JSON.parse(run(["widening", "--json"])).filter(
    (r) => r.file === "app/census.ts",
  );
  assert.equal(rows.some((r) => r.declared.includes("v?: number")), false);
  const dead = JSON.parse(run(["dead-code", "--json"]));
  assert.equal(dead.some((r) => r.guard.includes("s.v")), false);
});
