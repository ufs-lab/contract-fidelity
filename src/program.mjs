// contract-fidelity: the shared TypeScript program and file-scope rules.
//
// Both scanners need the same two things: a real type checker with the
// generated clients resolved, and one answer to "is this file in scope".
// The scope rule lives here because two copies of it can disagree, and a
// scanner that disagrees the wrong way reports nothing and looks clean.

import ts from "typescript";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, contractPathMatcher } from "./config.mjs";

// The project under analysis is wherever the CLI was invoked - NOT wherever
// this package happens to be installed. Deriving it from the tool's own path
// worked only while the tool was vendored inside the repo it analysed.
// `CONTRACT_FIDELITY_ROOT` exists so tests can point at a fixture tree.
export const REPO_ROOT = process.env.CONTRACT_FIDELITY_ROOT ?? process.cwd();

// Loaded on FIRST USE, not on import. A library that throws merely because it
// was imported cannot be embedded, and its own tests - which build their own
// programs over fixtures - need no project config at all.
let cachedConfig = null;
let cachedPathRe = null;

export function getConfig() {
  cachedConfig ??= loadConfig(REPO_ROOT);
  return cachedConfig;
}

export function contractPathRe() {
  cachedPathRe ??= contractPathMatcher(getConfig().contractPackages);
  return cachedPathRe;
}

// Tests deliberately construct out-of-contract values, so they are never a
// violation site. Both scanners still READ them when censusing writers - a
// test that supplies an unconstrained value proves a branch is reachable.
export const TEST_FILE_RE = /(?:^|[/.])[^/]+\.(?:test|spec)\.[cm]?[tj]sx?$/;

export function isTestFile(fileName) {
  if (TEST_FILE_RE.test(fileName)) return true;
  // A `test` directory inside a scan root, for helpers that carry no
  // `.test.` in the name. Derived from the configured roots: hardcoding
  // `src` here made the rule silently wrong for every other layout.
  return getConfig().scanRoots.some((root) =>
    fileName.includes(`/${root}/test/`),
  );
}

// Is this file one the project asked us to scan?
//
// `scanRoots` defaults to ["src"], and every scanner MUST ask this rather
// than test for `src` itself. A scanner that hardcodes the directory finds
// nothing in a project laid out differently, and reports that emptiness as
// a pass. That is the exact vacuous success the design exists to prevent.
//
// `rootDir` is the project root. It is passed rather than read from
// REPO_ROOT so tests can analyse a fixture tree.
export function isScannedPath(fileName, rootDir = REPO_ROOT) {
  return getConfig().scanRoots.some((root) =>
    fileName.includes(`${rootDir}/${root}/`),
  );
}

// A source file in scope: scanned root, real source, not a test.
export function isScannedFile(sourceFile, rootDir = REPO_ROOT) {
  if (sourceFile.isDeclarationFile) return false;
  const name = sourceFile.fileName;
  return isScannedPath(name, rootDir) && !isTestFile(name);
}

export function createProgram() {
  const raw = ts.readConfigFile(join(REPO_ROOT, getConfig().tsconfig), ts.sys.readFile);
  if (raw.error) {
    throw new Error(
      ts.flattenDiagnosticMessageText(raw.error.messageText, "\n"),
    );
  }
  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, REPO_ROOT);
  const program = ts.createProgram(parsed.fileNames, parsed.options);

  const clientFiles = program
    .getSourceFiles()
    .filter((f) => contractPathRe().test(f.fileName));
  if (clientFiles.length === 0) {
    // Passing vacuously would be worse than failing: the whole policy is
    // defined by the client contracts.
    throw new Error(
      `no contract declarations for ${getConfig().contractPackages.join(", ")} in the program - ` +
        "check `contractPackages`, and that dependencies are installed",
    );
  }
  return program;
}
