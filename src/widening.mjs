#!/usr/bin/env node

// widened-fields - no view-model or props field wider than the contract that
// feeds it.
//
// The sibling of `dead-code.mjs`, and deliberately a weaker claim.
// That scanner reports DEAD CODE: a guarantee was dropped and something
// downstream defends against a value that can never arrive, so the branch
// provably cannot execute. This one reports the widening ALONE:
//
//   interface AccountListItemVM {
//     entityName: string | undefined;   // <- entity.name, required non-null
//   }
//
// Nothing is broken today. But the field is now the reason the next person
// writes `entityName ?? "-"`, and that check will look necessary to every
// reviewer and to the type checker alike. Fixing it here is how the dead code
// never gets written; `dead-code` is what catches it once it has been.
//
// Because it is hygiene rather than a bug, this check ships with a seeded
// baseline and ratchets down, where `dead-code` sits at zero.
//
// Not covered by `tools/type-widening`: that scanner matches client
// interfaces by exact field name and explicitly excludes camelCase view
// models as "a mapping, not a mirror", which is precisely where these live.
//
// This file is the OWNER of the policy. Update README.md alongside any
// change here. See the README.

import ts from "typescript";
import { join, relative } from "node:path";

import {
  createProgram,
  getConfig,
  REPO_ROOT,
  isTestFile,
  isScannedPath,
  isScannedFile,
} from "./program.mjs";
import { createRatchet } from "./ratchet.mjs";
import { countContractGuarantees } from "./contract.mjs";
import { buildGraph, constrainedFields } from "./graph.mjs";
import {
  isApplicableSuggestion,
  alignSuggestion,
  narrowedDeclaration,
} from "./inferred.mjs";
import { lineOf } from "./analyze.mjs";
import {
  findWidenedDeclarations,
  findWidenedParameters,
} from "./carriers.mjs";

// The backlog belongs to the project being analysed, so it lives in that
// project's tree and is committed alongside the code it describes.
const baselineFile = () =>
  join(REPO_ROOT, getConfig().baselineDir, "widening-baseline.json");

// Name the thing a reader can search for. A field on an inline type literal
// has no interface name of its own, so climb to whatever names the shape.
function ownerLabel(decl) {
  for (let node = decl.parent; node; node = node.parent) {
    if (ts.isInterfaceDeclaration(node)) return node.name.text;
    if (ts.isTypeAliasDeclaration(node)) return node.name.text;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      return `${node.name.text} (inline)`;
    }
    if (
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
      node.name
    ) {
      return `${node.name.getText()}() (inline)`;
    }
  }
  return "(anonymous)";
}

function declaredText(target, decl) {
  const optional = decl.questionToken ? "?" : "";
  const type = decl.type
    ? decl.type.getText().replace(/\s+/g, " ")
    : "(inferred)";
  return `${target.getName()}${optional}: ${type}`;
}

// Never say "the contract" about a guarantee the checker supplied. A reader
// who goes looking for a contract that does not exist stops trusting the
// tool, and rightly.
function whyWider(constraint) {
  const source =
    constraint.origin === "inferred" ? "every value written here" : null;
  switch (constraint.kind) {
    case "required-non-null":
      return source
        ? `${source} is present and non-null`
        : "the contract declares the source field required and non-null";
    case "enum-member": {
      // Some of these unions run to seventy-odd members; naming three is
      // enough to show what was thrown away.
      const shown = constraint.members.slice(0, 3).join(" | ");
      const rest = constraint.members.length - 3;
      const members = `${shown}${rest > 0 ? ` (+${rest} more)` : ""}`;
      return source
        ? `${source} is ${members}`
        : `the contract pins the source to ${members}`;
    }
    default:
      return constraint.why;
  }
}

// What to put in place of the declaration.
//
// A contract finding names the contract's own type, which is the point of it.
// An inferred finding is about the nullish part alone, so it proposes the
// author's own type without it, and falls back to the source type when the
// declaration cannot be read that way (an enum flattened to `string` has no
// nullish part to remove).
// `isField` because only a field's `declared` has the `name: type` shape this
// can read. A carrier prints its own thing - `parameter: f(x: T) - 2 call
// site(s)` - and reading a type out of that produced a suggestion so mangled
// it was thrown away, silently taking every parameter and cast finding with
// it. For those the source type IS the answer: it is what every caller passes.
function suggestionFor(constraint, declared, isField, wrap = null) {
  const suggested = (() => {
    if (constraint.origin !== "inferred") return constraint.sourceType ?? null;
    if (isField && constraint.kind === "required-non-null") {
      const kept = narrowedDeclaration(declared);
      if (kept) return kept;
    }
    return alignSuggestion(constraint.sourceType ?? null, declared);
  })();
  return suggested && wrap ? wrap(suggested) : suggested;
}

// A contract finding names a contract field, so a reader can go and look it
// up even when the type itself is awkward to write. An INFERRED finding has
// only its suggestion, so a suggestion nobody can apply leaves nothing worth
// reporting.
function keepFinding(finding) {
  if (finding.origin !== "inferred") return true;
  return isApplicableSuggestion(finding.suggestedType, finding.declared);
}

export function collectViolations() {
  const program = createProgram();
  const checker = program.getTypeChecker();

  // Refuse to report "clean" while checking nothing. Contract files can exist
  // and still yield no guarantees - a generator template whose every property
  // is optional gives this rule nothing to enforce, and a silent pass would
  // read as a verified one.
  if (countContractGuarantees(program, checker) === 0) {
    throw new Error(
      "contract files were found but state no guarantees this rule can use - " +
        "every property is optional, or the generator template is not recognised. " +
        "A pass here would be vacuous, so it is an error instead.",
    );
  }

  // The graph spans test files too - see census.mjs. A test that writes null
  // proves a branch is reachable; a test is never a violation site.
  const graph = buildGraph(program, checker, {
    rootDir: REPO_ROOT,
    isCandidateFile: (sf) => isScannedPath(sf.fileName),
  });
  const fields = constrainedFields(graph);

  const byFile = new Map();
  for (const [target, { constraint, writes }] of fields) {
    const decl = target.declarations?.[0];
    if (!decl) continue;

    const declFile = decl.getSourceFile().fileName;
    // A shape declared inside a test is that test's own fixture, not a view
    // model the app ships.
    if (isTestFile(declFile)) continue;
    // No annotation means nothing was widened: the inferred type IS the
    // source type, so there is no gap between them to close.
    if (!decl.type) continue;

    const file = relative(REPO_ROOT, declFile);
    const finding = {
      file,
      line: lineOf(decl),
      field: `${ownerLabel(decl)}.${target.getName()}`,
      declared: declaredText(target, decl),
      contractField: constraint.field,
      constraintKind: constraint.kind,
      origin: constraint.origin ?? "contract",
      // The edit, not just the complaint. A model can apply a type; it has to
      // interpret a diagnostic. Absent for the doc-stated kinds, where no
      // narrower TypeScript type exists to move to.
      suggestedType: suggestionFor(
        constraint,
        declaredText(target, decl),
        true,
      ),
      why: whyWider(constraint),
      writes: writes.map((w) => {
        const sf = w.getSourceFile();
        return {
          file: relative(REPO_ROOT, sf.fileName),
          line: lineOf(w),
          text: w.getText().replace(/\s+/g, " ").slice(0, 60),
        };
      }),
    };
    if (keepFinding(finding)) {
      if (!byFile.has(file)) byFile.set(file, []);
      byFile.get(file).push(finding);
    }
  }

  // Locals, return types, casts and parameters: the same loss, declared
  // somewhere other than a field.
  const isScanned = (sf) => isScannedFile(sf);
  const carriers = [
    ...findWidenedDeclarations(graph, isScanned),
    ...findWidenedParameters(graph, isScanned),
  ];
  for (const d of carriers) {
    const sf = d.node.getSourceFile();
    const file = relative(REPO_ROOT, sf.fileName);
    const srcFile = d.source.getSourceFile();
    const finding = {
      file,
      line: lineOf(d.node),
      field: d.text,
      declared: `${d.carrier}: ${d.text}`,
      contractField: d.constraint.field,
      constraintKind: d.constraint.kind,
      origin: d.constraint.origin ?? "contract",
      suggestedType: suggestionFor(
        d.constraint,
        d.text,
        false,
        d.wrapSuggestion ?? null,
      ),
      why: whyWider(d.constraint),
      writes: [
        {
          file: relative(REPO_ROOT, srcFile.fileName),
          line: lineOf(d.source),
          text: d.source.getText().replace(/\s+/g, " ").slice(0, 60),
        },
      ],
    };
    if (keepFinding(finding)) {
      if (!byFile.has(file)) byFile.set(file, []);
      byFile.get(file).push(finding);
    }
  }

  for (const list of byFile.values()) list.sort((a, b) => a.line - b.line);
  return byFile;
}

function printViolations(byFile, files) {
  for (const file of files) {
    process.stderr.write(`  ${file}\n`);
    for (const f of byFile.get(file) ?? []) {
      process.stderr.write(`    ${f.line}: ${f.declared}\n`);
      process.stderr.write(`      wider than ${f.contractField} - ${f.why}\n`);
      if (f.suggestedType) {
        process.stderr.write(`      narrow to: ${f.suggestedType}\n`);
      }
      for (const w of f.writes.slice(0, 3)) {
        process.stderr.write(
          `      written from: ${w.file}:${w.line} \`${w.text}\`\n`,
        );
      }
    }
    process.stderr.write("\n");
  }
}

// The declaration at fault, the contract field feeding it, and the kind of
// guarantee dropped. Not the line.
function fingerprintOf(finding) {
  return `${finding.field ?? finding.declared} :: ${finding.declared} :: ${finding.contractField} :: ${finding.constraintKind}`;
}

const ratchet = createRatchet({
  id: "widening",
  command: "widening",
  fingerprintOf,
  repoRoot: REPO_ROOT,
  baselineFile,
  collect: collectViolations,
  print: printViolations,
  failureHeadline: "declared wider than every value that reaches them",
  fixHint:
    "Narrow the declaration to the type named on each finding. That is what stops the defensive check being written.",
});

async function main(argv) {
  if (argv.includes("--list")) return ratchet.list();
  if (argv.includes("--json")) return ratchet.json();
  if (argv.includes("--update-baseline")) {
    return ratchet.updateBaseline(argv.includes("--force"));
  }
  return ratchet.check();
}


export { main, collectViolations as collect };
