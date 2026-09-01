#!/usr/bin/env node

// widened-fields — no view-model or props field wider than the contract that
// feeds it.
//
// The sibling of `no-narrowing-loss.mjs`, and deliberately a weaker claim.
// That scanner reports DEAD CODE: a guarantee was dropped and something
// downstream defends against a value that can never arrive, so the branch
// provably cannot execute. This one reports the widening ALONE:
//
//   interface AccountListItemVM {
//     entityName: string | undefined;   // <- entity.name, required non-null
//   }
//
// Nothing is broken today. But the field is now the reason the next person
// writes `entityName ?? "—"`, and that check will look necessary to every
// reviewer and to the type checker alike. Fixing it here is how the dead code
// never gets written; `no-narrowing-loss` is what catches it once it has been.
//
// Because it is hygiene rather than a bug, this check ships with a seeded
// baseline and ratchets down, where `no-narrowing-loss` sits at zero.
//
// Not covered by `tools/type-widening`: that scanner matches client
// interfaces by exact field name and explicitly excludes camelCase view
// models as "a mapping, not a mirror", which is precisely where these live.
//
// This file is the OWNER of the policy. Update README.md alongside any
// change here. See tools/narrowing-loss/README.md.

import ts from "typescript";
import { join, relative } from "node:path";

import {
  createProgram,
  getConfig,
  REPO_ROOT,
  isTestFile,
  inSrc,
} from "./program.mjs";
import { createRatchet } from "./ratchet.mjs";
import {
  buildFieldWriteIndex,
  constrainedFields,
  typesProducedOutsideLiterals,
} from "./fields.mjs";
import { countContractGuarantees } from "./contract.mjs";
import { lineOf } from "./analyze.mjs";
import { findWidenedDeclarations } from "./carriers.mjs";

// The backlog belongs to the project being analysed, so it lives in that
// project's tree and is committed alongside the code it describes.
const baselineFile = () =>
  join(REPO_ROOT, getConfig().baselineDir, "widened-fields-baseline.json");

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

function whyWider(constraint) {
  switch (constraint.kind) {
    case "required-non-null":
      return "the contract declares the source field required and non-null";
    case "enum-member": {
      // Some of these unions run to seventy-odd members; naming three is
      // enough to show what was thrown away.
      const shown = constraint.members.slice(0, 3).join(" | ");
      const rest = constraint.members.length - 3;
      return `the contract pins the source to ${shown}${rest > 0 ? ` (+${rest} more)` : ""}`;
    }
    default:
      return constraint.why;
  }
}

export function collectViolations() {
  const program = createProgram();
  const checker = program.getTypeChecker();

  // Refuse to report "clean" while checking nothing. Contract files can exist
  // and still yield no guarantees — a generator template whose every property
  // is optional gives this rule nothing to enforce, and a silent pass would
  // read as a verified one.
  if (countContractGuarantees(program, checker) === 0) {
    throw new Error(
      "contract files were found but state no guarantees this rule can use — " +
        "every property is optional, or the generator template is not recognised. " +
        "A pass here would be vacuous, so it is an error instead.",
    );
  }

  const index = buildFieldWriteIndex(
    program,
    checker,
    (sf) => inSrc(sf.fileName),
    REPO_ROOT,
  );
  const producedElsewhere = typesProducedOutsideLiterals(
    program,
    checker,
    (sf) => inSrc(sf.fileName),
  );
  const fields = constrainedFields(
    index,
    checker,
    REPO_ROOT,
    producedElsewhere,
  );

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
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(finding);
  }

  // Locals, return types and casts: the same loss, declared somewhere other
  // than a field.
  const isScanned = (sf) =>
    !sf.isDeclarationFile && inSrc(sf.fileName) && !isTestFile(sf.fileName);
  for (const d of findWidenedDeclarations(program, checker, isScanned)) {
    const sf = d.node.getSourceFile();
    const file = relative(REPO_ROOT, sf.fileName);
    const srcFile = d.source.getSourceFile();
    const finding = {
      file,
      line: lineOf(d.node),
      field: d.text,
      declared: `${d.carrier} — ${d.text}`,
      contractField: d.constraint.field,
      constraintKind: d.constraint.kind,
      why: whyWider(d.constraint),
      writes: [
        {
          file: relative(REPO_ROOT, srcFile.fileName),
          line: lineOf(d.source),
          text: d.source.getText().replace(/\s+/g, " ").slice(0, 60),
        },
      ],
    };
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(finding);
  }

  for (const list of byFile.values()) list.sort((a, b) => a.line - b.line);
  return byFile;
}

function printViolations(byFile, files) {
  for (const file of files) {
    process.stderr.write(`  ${file}\n`);
    for (const f of byFile.get(file) ?? []) {
      process.stderr.write(`    ${f.line}: ${f.declared}\n`);
      process.stderr.write(`      wider than ${f.contractField} — ${f.why}\n`);
      for (const w of f.writes.slice(0, 3)) {
        process.stderr.write(
          `      written from: ${w.file}:${w.line} \`${w.text}\`\n`,
        );
      }
    }
    process.stderr.write("\n");
  }
}

const ratchet = createRatchet({
  id: "widened-fields",
  repoRoot: REPO_ROOT,
  baselineFile,
  collect: collectViolations,
  print: printViolations,
  failureHeadline: "declared wider than the contract that feeds them",
  fixHint:
    "Narrow the field to the contract type — that is what stops the defensive check being written.",
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
