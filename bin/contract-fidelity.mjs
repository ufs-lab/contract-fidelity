#!/usr/bin/env node
// contract-fidelity - one entry point for both checks.
//
//   contract-fidelity dead-code        [--list] [--json] [--update-baseline]
//   contract-fidelity widening         [--list] [--json] [--update-baseline]
//   contract-fidelity contracts        (audit what guarantees were read)
//   contract-fidelity optional-fields  (rank the schema work by payoff)

const [command, ...rest] = process.argv.slice(2);

const COMMANDS = {
  "dead-code": () => import("../src/dead-code.mjs"),
  widening: () => import("../src/widening.mjs"),
  "optional-fields": () => import("../src/optional-fields.mjs"),
};

async function run() {
  if (command === "contracts") {
    const mod = await COMMANDS["dead-code"]();
    return mod.main(["--contracts"]);
  }
  const load = COMMANDS[command];
  if (!load) {
    process.stderr.write(
      `contract-fidelity: unknown command ${command ?? "(none)"}\n\n` +
        "  contract-fidelity dead-code        guards the contract already decides\n" +
        "  contract-fidelity widening         declarations wider than their source\n" +
        "  contract-fidelity contracts        audit the guarantees that were read\n" +
        "  contract-fidelity optional-fields  rank the schema work by payoff\n\n" +
        "dead-code and widening accept --list, --json and --update-baseline.\n",
    );
    return 2;
  }
  const mod = await load();
  return mod.main(rest);
}

run()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(
      `contract-fidelity: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
