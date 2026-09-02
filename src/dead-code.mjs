#!/usr/bin/env node

// dead-code: no defensive code against a guarantee the contract
// already gives.
//
// A value arrives from a generated client carrying a
// guarantee its TypeScript type cannot state: `Amount in minor units (must
// be > 0)`, `Counts are non-negative`, `Site identifier (1-31)`, an enum
// union, a required non-null field, a documented non-empty array. It is then
// passed through a signature that drops the guarantee (`amount: number`,
// `scope: string`, `x: T | null`) and defended downstream against a value it
// can never hold - `if (amount > 0)`, an unreachable `default:`, `?? "…"`.
//
// The dead branch is untestable, hides the real contract, and reads as if
// the boundary were untrusted when it is not.
//
// This file is the OWNER of the policy. Update README.md alongside any
// change here. See the README.

import ts from "typescript";
import { join, relative } from "node:path";

import {
  createProgram,
  getConfig,
  contractPathRe,
  REPO_ROOT,
  isScannedFile,
  isScannedPath,
} from "./program.mjs";
import { createRatchet } from "./ratchet.mjs";

import {
  constraintForClientProperty,
  contractPathFor,
  countContractGuarantees,
} from "./contract.mjs";
import {
  buildCallCensus,
  constraintOfExpression,
  verdictAcrossCallSites,
} from "./census.mjs";
import {
  buildFieldWriteIndex,
  constrainedFields,
  typesProducedOutsideLiterals,
  verdictAcrossWrites,
} from "./fields.mjs";
import {
  classifyGuard,
  referencesTo,
  enclosingFunction,
  widensAwayFrom,
  lineOf,
  textOf,
} from "./analyze.mjs";

// The backlog belongs to the project being analysed, so it lives in that
// project's tree and is committed alongside the code it describes.
const baselineFile = () =>
  join(REPO_ROOT, getConfig().baselineDir, "dead-code-baseline.json");

// Every property read in `sf` that resolves to a constrained client field.
function findOrigins(sf, checker) {
  const origins = [];
  const visit = (node) => {
    if (ts.isPropertyAccessExpression(node) || ts.isBindingElement(node)) {
      const nameNode = ts.isBindingElement(node)
        ? (node.propertyName ?? node.name)
        : node.name;
      const symbol = checker.getSymbolAtLocation(nameNode);
      if (symbol) {
        const constraint = constraintForClientProperty(
          symbol,
          checker,
          nameNode,
        );
        if (constraint) {
          origins.push({ node, nameNode, symbol, constraint });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return origins;
}

// Where a value came to rest, and what the signature dropped on the way.
function widenNote(paramDecl, rootDir) {
  const fn = paramDecl.parent;
  const fnName =
    fn.name?.getText() ??
    (fn.parent && ts.isVariableDeclaration(fn.parent)
      ? fn.parent.name.getText()
      : "(anonymous)");
  const declaredType = paramDecl.type ? paramDecl.type.getText() : "(inferred)";
  return {
    file: relative(rootDir, paramDecl.getSourceFile().fileName),
    line: lineOf(paramDecl),
    text: `${fnName}(${paramDecl.name.getText()}: ${declaredType})`,
  };
}

function originNote(node, rootDir) {
  return {
    file: relative(rootDir, node.getSourceFile().fileName),
    line: lineOf(node),
    text: textOf(node, 60),
  };
}

function makeFinding({
  node,
  constraint,
  contract,
  origins,
  widening,
  guard,
  rootDir,
}) {
  return {
    file: relative(rootDir, node.getSourceFile().fileName),
    line: lineOf(node),
    contract,
    constraintKind: constraint.kind,
    why: constraint.why,
    evidence: constraint.source ?? "",
    origins,
    widening,
    guard: guard.guard,
    verdict: guard.verdict,
    shape: guard.shape,
  };
}

// --- Same-scope findings: the value is checked where it is read. -----------

function collectInScope(sf, checker, rootDir, findings) {
  for (const origin of findOrigins(sf, checker)) {
    const { constraint, symbol } = origin;
    const contract = contractPathFor(symbol);
    const origins = [originNote(origin.node, rootDir)];

    const report = (guard) => {
      if (!guard) return;
      findings.push(
        makeFinding({
          node: guard.guardNode,
          constraint,
          contract,
          origins,
          widening: null,
          guard,
          rootDir,
        }),
      );
    };

    // Checked in place: `if (config.window_ms > 0)`.
    if (ts.isPropertyAccessExpression(origin.node)) {
      report(classifyGuard(origin.node, constraint, checker));
    }

    // Bound to a local in the same function, then checked.
    const carrier = ts.isBindingElement(origin.node)
      ? origin.node
      : origin.node.parent && ts.isVariableDeclaration(origin.node.parent)
        ? origin.node.parent
        : null;
    if (!carrier || !ts.isIdentifier(carrier.name)) continue;
    const localSymbol = checker.getSymbolAtLocation(carrier.name);
    if (!localSymbol) continue;
    for (const ref of referencesTo(
      localSymbol,
      enclosingFunction(carrier),
      checker,
    )) {
      if (ref === carrier.name) continue;
      report(classifyGuard(ref, constraint, checker));
    }
  }
}

// --- Cross-call findings: the guarantee is dropped at a signature. ---------

// Every parameter that ever receives a contract-constrained argument, with
// the argument expressions that reach it.
function candidateParameters(program, checker, isScanned) {
  const candidates = new Map();
  for (const sf of program.getSourceFiles()) {
    if (!isScanned(sf)) continue;
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const sig = checker.getResolvedSignature(node);
        node.arguments.forEach((arg, i) => {
          const constraint = constraintOfExpression(arg, checker);
          if (!constraint) return;
          const paramSymbol = sig?.parameters?.[i];
          const paramDecl = paramSymbol?.valueDeclaration;
          if (!paramDecl || !ts.isParameter(paramDecl)) return;
          if (paramDecl.getSourceFile().isDeclarationFile) return;
          if (!paramDecl.parent.body) return;
          if (!widensAwayFrom(paramDecl, constraint, checker)) return;
          if (!candidates.has(paramDecl)) {
            candidates.set(paramDecl, { paramSymbol, constraint, origins: [] });
          }
          candidates.get(paramDecl).origins.push(arg);
        });
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
  }
  return candidates;
}

function collectAcrossCalls(
  program,
  checker,
  census,
  isScanned,
  rootDir,
  findings,
) {
  for (const [paramDecl, info] of candidateParameters(
    program,
    checker,
    isScanned,
  )) {
    const { paramSymbol, constraint, origins } = info;
    const body = paramDecl.parent.body;
    const widening = widenNote(paramDecl, rootDir);

    for (const ref of referencesTo(paramSymbol, body, checker)) {
      const guard = classifyGuard(ref, constraint, checker);
      if (!guard) continue;

      // Prove it against every caller, not just the one that led us here.
      const shared = verdictAcrossCallSites(paramDecl, census, checker, (c) => {
        const g = classifyGuard(ref, c, checker);
        return g ? g.verdict : null;
      });
      if (shared === null || shared !== guard.verdict) continue;

      findings.push(
        makeFinding({
          node: guard.guardNode,
          constraint,
          contract: contractPathFor(
            checker.getSymbolAtLocation(
              ts.isPropertyAccessExpression(origins[0])
                ? origins[0].name
                : origins[0],
            ) ?? paramSymbol,
          ),
          origins: origins.slice(0, 3).map((o) => originNote(o, rootDir)),
          widening,
          guard,
          rootDir,
        }),
      );
    }
  }
}

function dedupe(findings) {
  const seen = new Map();
  for (const f of findings) {
    const key = `${f.file}:${f.line}:${f.guard}:${f.contract}`;
    if (!seen.has(key)) seen.set(key, f);
  }
  return [...seen.values()];
}

// --- Field findings: the guarantee is dropped into a view model or a prop.

function fieldWidenNote(target, checker, rootDir) {
  const decl = target.declarations?.[0];
  const owner = decl?.parent;
  const ownerName =
    owner && (ts.isInterfaceDeclaration(owner) || ts.isTypeLiteralNode(owner))
      ? ts.isInterfaceDeclaration(owner)
        ? owner.name.text
        : "(type literal)"
      : "(unknown)";
  const declaredType = decl?.type ? decl.type.getText() : "(inferred)";
  return {
    file: relative(rootDir, decl.getSourceFile().fileName),
    line: lineOf(decl),
    text: `${ownerName}.${target.getName()}: ${declaredType}`,
  };
}

function collectAcrossFields(
  program,
  checker,
  census,
  isScanned,
  rootDir,
  findings,
) {
  const index = buildFieldWriteIndex(
    program,
    checker,
    (sf) => isScannedPath(sf.fileName, rootDir),
    rootDir,
    census.valueReferenced,
  );
  // The same exclusion `widening` applies: a shape that is cast, parsed or
  // awaited holds values this census never saw, so it proves nothing. This
  // scanner was calling constrainedFields WITHOUT it, which is how a guard on
  // a localStorage settings field - `parsed.enabledIndicators ?? []`, whose
  // whole job is legacy records - came to be reported as always-true.
  const producedElsewhere = typesProducedOutsideLiterals(
    program,
    checker,
    (sf) => isScannedPath(sf.fileName, rootDir),
  );
  const fields = constrainedFields(index, checker, rootDir, producedElsewhere);
  if (fields.size === 0) return;

  for (const sf of program.getSourceFiles()) {
    if (!isScanned(sf)) continue;

    const visit = (node) => {
      if (ts.isPropertyAccessExpression(node)) {
        const target = checker.getSymbolAtLocation(node.name);
        const info = target ? fields.get(target) : undefined;
        if (info) {
          const guard = classifyGuard(node, info.constraint, checker);
          if (guard) {
            const shared = verdictAcrossWrites(info.writes, checker, (c) => {
              const g = classifyGuard(node, c, checker);
              return g ? g.verdict : null;
            });
            if (shared === guard.verdict) {
              findings.push(
                makeFinding({
                  node: guard.guardNode,
                  constraint: info.constraint,
                  contract: `${info.constraint.field ?? target.getName()} (via ${target.getName()})`,
                  origins: info.writes
                    .slice(0, 3)
                    .map((w) => originNote(w, rootDir)),
                  widening: fieldWidenNote(target, checker, rootDir),
                  guard,
                  rootDir,
                }),
              );
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
  }
}

// A guard sitting directly on a contract read, with nothing widened in
// between:
//
//   if (typeof currency.scale !== "number") { ... }
//
// These were once out of scope on the argument that the TypeScript type is a
// compile-time fiction over an HTTP response, so verifying it at the edge is
// defensible. That is NOT this codebase's policy: the contract is trusted,
// and re-deriving at runtime what it already states is a bug - it forks the
// code on a branch that cannot execute, and hides which value is really
// authoritative. So they are reported like any other finding.
//
// `--exclude-boundary-checks` still separates them out, for reading a diff
// rather than for suppressing anything.
function isBoundaryCheck(finding) {
  return finding.widening === null;
}

// The analysis proper, with the program injected so tests can drive it over
// a fixture tree instead of the whole app.
export function analyzeProgram(
  program,
  checker,
  { rootDir, excludeBoundaryChecks = false },
) {
  const isScanned = (sourceFile) => isScannedFile(sourceFile, rootDir);
  const findings = [];

  // The census spans test files too - see census.mjs.
  const census = buildCallCensus(program, checker, (sf) =>
    isScannedPath(sf.fileName, rootDir),
  );

  for (const sf of program.getSourceFiles()) {
    if (!isScanned(sf)) continue;
    collectInScope(sf, checker, rootDir, findings);
  }
  collectAcrossCalls(program, checker, census, isScanned, rootDir, findings);
  collectAcrossFields(program, checker, census, isScanned, rootDir, findings);

  const all = dedupe(findings);
  return excludeBoundaryChecks ? all.filter((f) => !isBoundaryCheck(f)) : all;
}

export function collectViolations({ excludeBoundaryChecks = false } = {}) {
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

  const byFile = new Map();
  for (const f of analyzeProgram(program, checker, {
    rootDir: REPO_ROOT,
    excludeBoundaryChecks,
  })) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file).push(f);
  }
  for (const list of byFile.values()) list.sort((a, b) => a.line - b.line);
  return byFile;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function printViolations(byFile, files) {
  for (const file of files) {
    const list = byFile.get(file) ?? [];
    process.stderr.write(`  ${file}\n`);
    for (const f of list) {
      const verdict =
        f.verdict === "always-true" ? "always true" : "always false";
      process.stderr.write(`    ${f.line}: \`${f.guard}\` is ${verdict}\n`);
      process.stderr.write(
        `      contract: ${f.contract} - ${f.why}${f.evidence ? `\n      doc: "${f.evidence}"` : ""}\n`,
      );
      for (const o of f.origins) {
        process.stderr.write(
          `      value from: ${o.file}:${o.line} \`${o.text}\`\n`,
        );
      }
      if (f.widening) {
        process.stderr.write(
          `      guarantee dropped at: ${f.widening.file}:${f.widening.line} \`${f.widening.text}\`\n`,
        );
      }
    }
    process.stderr.write("\n");
  }
}

// Dump every doc-stated and enum constraint the linter believes it has found
// in the clients. The doc patterns are prose heuristics, so being able to
// audit the whole index in one pass is what keeps them honest - a loose
// pattern shows up here as a field whose "guarantee" reads like a
// conditional.
function contracts() {
  const program = createProgram();
  const checker = program.getTypeChecker();
  const rows = [];
  for (const sf of program.getSourceFiles()) {
    if (!contractPathRe().test(sf.fileName)) continue;
    ts.forEachChild(sf, (node) => {
      // Interfaces (typescript-axios) and classes (typescript-node). Auditing
      // only interfaces made this command blind to exactly the generators the
      // analysis goes out of its way to support, and an empty audit reads as
      // "no guarantees here" rather than "this command cannot see them".
      const isModel =
        ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node);
      if (!isModel || !node.name) return;
      for (const member of node.members) {
        const isProperty =
          ts.isPropertySignature(member) || ts.isPropertyDeclaration(member);
        if (!isProperty || !member.name) continue;
        const symbol = checker.getSymbolAtLocation(member.name);
        if (!symbol) continue;
        const c = constraintForClientProperty(symbol, checker, member.name);
        // required-non-null holds for most fields and says nothing about
        // the prose heuristics, so it is left out of the audit view.
        if (!c || c.kind === "required-non-null") continue;
        rows.push({
          where: `${node.name.text}.${symbol.getName()}`,
          kind: c.kind,
          source: c.source,
        });
      }
    });
  }
  rows.sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.where.localeCompare(b.where),
  );
  const seen = new Set();
  for (const r of rows) {
    const key = `${r.where}|${r.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    process.stdout.write(`${r.kind.padEnd(16)} ${r.where}\n`);
    if (r.source) process.stdout.write(`${" ".repeat(17)}"${r.source}"\n`);
  }
  process.stdout.write(`\n${seen.size} constrained field(s)\n`);
  return 0;
}

// What identifies this finding across edits: the guard text, the contract it
// disagrees with, and the kind of guarantee. Not the line, which moves.
function fingerprintOf(finding) {
  return `${finding.guard} :: ${finding.contract} :: ${finding.constraintKind}`;
}

const ratchet = createRatchet({
  id: "dead-code",
  command: "dead-code",
  fingerprintOf,
  repoRoot: REPO_ROOT,
  baselineFile,
  collect: collectViolations,
  print: printViolations,
  failureHeadline: "the contract already guarantees this",
  fixHint:
    "Delete the dead branch, or keep the contract type on the signature that dropped it.",
});

async function main(argv) {
  if (argv.includes("--contracts")) return contracts();
  const options = {
    // `trustContract: false` says the team validates at its boundary on
    // purpose, so only widened cases are reported.
    excludeBoundaryChecks:
      argv.includes("--exclude-boundary-checks") || !getConfig().trustContract,
  };
  if (argv.includes("--list")) return ratchet.list(options);
  if (argv.includes("--json")) return ratchet.json(options);
  if (argv.includes("--update-baseline")) {
    return ratchet.updateBaseline(argv.includes("--force"), options);
  }
  return ratchet.check(options);
}


export { main, collectViolations as collect, findOrigins };
