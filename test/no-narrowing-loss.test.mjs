import test from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  constraintFromDoc,
  decideNumericComparison,
  interval,
} from "../src/constraints.mjs";
import { analyzeProgram } from "../src/no-narrowing-loss.mjs";
import { constraintForClientProperty } from "../src/contract.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "__fixtures__");

// ---------------------------------------------------------------------------
// The decision table
// ---------------------------------------------------------------------------

test("a positive guarantee decides comparisons against zero", () => {
  const positive = interval(0, Infinity, { loExclusive: true });
  assert.equal(decideNumericComparison(positive, ">", 0), "always-true");
  assert.equal(decideNumericComparison(positive, "<=", 0), "always-false");
  assert.equal(decideNumericComparison(positive, "===", 0), "always-false");
});

test("a non-negative count leaves `> 0` undecided", () => {
  // The distinguishing case for this whole tool: zero is a legal value, so
  // `count > 0` is a real presence test and must never be reported. Only
  // `>= 0` / `< 0` are decided.
  const nonNegative = interval(0, Infinity);
  assert.equal(decideNumericComparison(nonNegative, ">", 0), "undecided");
  assert.equal(decideNumericComparison(nonNegative, ">=", 0), "always-true");
  assert.equal(decideNumericComparison(nonNegative, "<", 0), "always-false");
});

test("a closed range decides only comparisons outside it", () => {
  const range = interval(1, 31);
  assert.equal(decideNumericComparison(range, ">", 0), "always-true");
  assert.equal(decideNumericComparison(range, ">", 31), "always-false");
  assert.equal(decideNumericComparison(range, ">", 10), "undecided");
});

// ---------------------------------------------------------------------------
// Reading guarantees out of prose
// ---------------------------------------------------------------------------

test("doc guarantees are read from the generated comment", () => {
  assert.equal(
    constraintFromDoc("Amount in minor units (must be > 0). Full int64 width.")
      ?.kind,
    "positive",
  );
  assert.equal(
    constraintFromDoc("Counts are non-negative.")?.kind,
    "non-negative",
  );
  assert.equal(
    constraintFromDoc("Site identifier (1-31, per REQ-004)")?.kind,
    "range",
  );
  assert.equal(
    constraintFromDoc("Legs of the movement; at least one is required.", {
      isArray: true,
    })?.kind,
    "non-empty-array",
  );
});

test("a hedged guarantee is not a guarantee", () => {
  // The real `ExpectedTransfer.amount` doc in the arm-engine client.
  assert.equal(
    constraintFromDoc(
      "Must be greater than zero unless the `zero_amount` directive is present, in which case it must be exactly zero.",
    ),
    null,
  );
});

test("`Non-empty means ...` defines an implication, not a guarantee", () => {
  // Regression: a bare /non-empty/ match read this as a promise and called a
  // correct `.length > 0` check dead. See UnmatchedEvent.missing_exports.
  assert.equal(
    constraintFromDoc(
      "Canonical exports this event lacks. Non-empty means the event is excluded from matching until re-emitted.",
      { isArray: true },
    ),
    null,
  );
});

// ---------------------------------------------------------------------------
// End to end, over a fixture program
// ---------------------------------------------------------------------------

function analyzeFixtures() {
  const files = [
    join(FIXTURES, "src", "cases.ts"),
    join(FIXTURES, "src", "mixedCallers.ts"),
    join(FIXTURES, "src", "viewModels.ts"),
  ];
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  });
  return analyzeProgram(program, program.getTypeChecker(), {
    rootDir: FIXTURES,
  });
}

const findings = analyzeFixtures();
const guards = findings.map((f) => f.guard);

test("fixture program yields no TypeScript errors", () => {
  // A fixture that does not compile would silence the checker and make every
  // assertion below vacuous.
  const program = ts.createProgram(
    [
      join(FIXTURES, "src", "cases.ts"),
      join(FIXTURES, "src", "mixedCallers.ts"),
      join(FIXTURES, "src", "viewModels.ts"),
    ],
    {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
    },
  );
  const errors = ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.category === ts.DiagnosticCategory.Error);
  assert.equal(
    errors.length,
    0,
    errors
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "))
      .join("\n"),
  );
});

test("flags a positive amount widened to `number` then re-checked", () => {
  const hit = findings.find((f) => f.guard === "amount > 0");
  assert.ok(hit, `expected "amount > 0", saw: ${guards.join(", ")}`);
  assert.equal(hit.verdict, "always-true");
  assert.equal(hit.constraintKind, "positive");
  assert.match(hit.widening.text, /formatAmount\(amount: number\)/);
});

test("flags a non-negative count compared against a bound it cannot cross", () => {
  assert.ok(findings.some((f) => f.guard === "staged >= 0"));
});

test("flags an unreachable `default:` on a widened enum", () => {
  const hit = findings.find((f) => f.shape === "unreachable-default");
  assert.ok(hit);
  assert.equal(hit.constraintKind, "enum-member");
  assert.match(hit.widening.text, /scopeLabel\(scope: string\)/);
});

test("flags a nullish fallback on a contract-required field", () => {
  assert.ok(
    findings.some(
      (f) => f.shape === "nullish-fallback" && f.guard.includes("tags"),
    ),
  );
});

test("flags an emptiness test on a documented non-empty array", () => {
  assert.ok(findings.some((f) => f.guard === "legs.length > 0"));
});

test("stays silent on `> 0` for a non-negative count", () => {
  assert.ok(!guards.includes("staged > 0"));
});

test("stays silent when the signature keeps the contract type", () => {
  // scopeLabelTyped has a `default:` too, but nothing was widened.
  const inTyped = findings.filter((f) =>
    f.widening?.text.includes("scopeLabelTyped"),
  );
  assert.equal(inTyped.length, 0);
});

test("stays silent on `!label` for a required non-null string", () => {
  // "" is falsy and legal, so the branch is reachable.
  assert.ok(!findings.some((f) => f.guard.includes("!label")));
});

test("stays silent when any caller can pass an unconstrained value", () => {
  // render() is called once with a contract field and once with a nullable
  // local; the `?? "-"` branch is live.
  assert.equal(
    findings.filter((f) => f.file.endsWith("mixedCallers.ts")).length,
    0,
  );
});

// ---------------------------------------------------------------------------
// Guarantees dropped into a field rather than a parameter
// ---------------------------------------------------------------------------

test("flags a nullish fallback on a view-model field fed only by a required contract field", () => {
  const hit = findings.find((f) => f.guard === 'row.label ?? "-"');
  assert.ok(hit, `expected a finding on row.label, saw: ${guards.join(", ")}`);
  assert.match(hit.widening.text, /RowVM\.label: string \| undefined/);
});

test("flags an impossible comparison on a view-model field that flattened an enum", () => {
  const hit = findings.find((f) => f.guard === 'row.scope !== ""');
  assert.ok(hit);
  assert.equal(hit.verdict, "always-true");
  assert.match(hit.widening.text, /RowVM\.scope: string/);
});

test("stays silent on a field with one unaccounted writer", () => {
  // LooseVM.label is also written from an arbitrary `string | undefined`,
  // so the fallback is reachable.
  const inLoose = findings.filter((f) =>
    f.widening?.text.includes("LooseVM.label"),
  );
  assert.equal(
    inLoose.length,
    0,
    "a field with an unconstrained writer must not be reported",
  );
});

test("counts a cast-built object literal as a write", () => {
  // `{ label: value } as CastVM` must register, or the index would miss
  // writers and report live branches as dead.
  const inCast = findings.filter((f) =>
    f.widening?.text.includes("CastVM.label"),
  );
  assert.equal(
    inCast.length,
    0,
    "a cast-built writer must still disqualify the field",
  );
});

test("a type predicate is a validator, not a widening", () => {
  const inPredicate = findings.filter((f) =>
    f.widening?.text.includes("isText"),
  );
  assert.equal(inPredicate.length, 0);
});

test("an assertion helper taking `unknown` is a validator, not a widening", () => {
  const inAssertion = findings.filter((f) =>
    f.widening?.text.includes("requireText"),
  );
  assert.equal(inAssertion.length, 0);
});

test("a widening that returns a default is still a widening", () => {
  // `unknown[] | undefined` is not a bare `unknown`, and returning 0 asserts
  // nothing — this must stay in scope.
  const hit = findings.find((f) => f.widening?.text.includes("textOrEmpty"));
  assert.ok(
    hit,
    `expected a finding in textOrEmpty, saw: ${guards.join(", ")}`,
  );
});

test("a guard directly on a contract read is a finding, not an exemption", () => {
  // The contract is trusted, so re-deriving `typeof staged === "number"` at
  // runtime forks on a branch that cannot execute. Reported by default;
  // `--exclude-boundary-checks` only separates them for reading a diff.
  const hit = findings.find(
    (f) => f.shape === "typeof-test" && f.widening === null,
  );
  assert.ok(
    hit,
    `expected an in-place typeof finding, saw: ${guards.join(", ")}`,
  );
  assert.equal(hit.verdict, "always-true");
});

// ---------------------------------------------------------------------------
// Portability, found by running against three unrelated public SDKs
// ---------------------------------------------------------------------------

test("guarantees are read from the class-based generator template too", () => {
  // openapi-generator's typescript-node template emits models as classes.
  // Reading only interfaces made the scan report "clean" on Lob's and
  // Klaviyo's SDKs while having read nothing at all.
  const program = ts.createProgram([join(FIXTURES, "src", "cases.ts")], {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  });
  const checker = program.getTypeChecker();
  const client = program
    .getSourceFiles()
    .find((f) => f.fileName.includes("fake-client"));
  assert.ok(client, "fixture client not in program");

  const found = new Map();
  const visit = (node) => {
    if (ts.isClassDeclaration(node)) {
      for (const member of node.members) {
        if (!member.name) continue;
        const symbol = checker.getSymbolAtLocation(member.name);
        if (!symbol) continue;
        const c = constraintForClientProperty(symbol, checker, member.name);
        if (c) found.set(symbol.getName(), c);
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(client, visit);

  assert.equal(found.get("classAmount")?.kind, "positive");
  // A range in prose describing an EXAMPLE, on a field the contract types as
  // an enum, is not a numeric guarantee — Klaviyo's `operator` reads
  // `e.g. "between 10 and 20 days ago"`.
  assert.equal(found.get("classOperator")?.kind, "enum-member");
  // A method is not a data field.
  assert.ok(!found.has("describe"));
});
