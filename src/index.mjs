// Programmatic entry point, for embedding the analysis in another tool.
export { analyzeProgram, collectViolations as collectDeadCode } from "./dead-code.mjs";
export { collectViolations as collectWidening } from "./widening.mjs";
export { constraintFromDoc, decideNumericComparison } from "./constraints.mjs";
export { loadConfig } from "./config.mjs";
