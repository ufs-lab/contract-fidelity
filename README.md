# contract-fidelity

Find defensive code that guards a value your API contract already decided.
Find the type widening that made the guard look necessary.

```ts
// contract: Movement.amount - "Amount in minor units (must be > 0)"
function formatAmount(amount: number): string {   // the guarantee stops here
  if (amount > 0) return `${amount}`;             // the guard defends here
  return "-";                                     // this branch is dead
}
```

The tool reads a generated OpenAPI TypeScript client.
It then reads the code that consumes the client.
It reports where the two disagree.

| Command | What it reports |
| --- | --- |
| `contract-fidelity dead-code` | A guarantee was dropped, and code downstream guards a value that cannot arrive. |
| `contract-fidelity widening` | The widening alone. A declaration is wider than every value that reaches it. |
| `contract-fidelity contracts` | An audit. Every guarantee the tool believes it read. |
| `contract-fidelity optional-fields` | A ranked list of the schema work. Not a gate. |

## Install

```bash
npm install --save-dev contract-fidelity
```

`typescript` is a peer dependency.
The supported range is `>=5.0 <7`.
TypeScript 7 is the Go port.
Its export map points `.` at `lib/version.cjs`, and it moves the compiler API
behind `./unstable/*`.
The analysis calls `ts.createProgram` and the type checker, so it does not run
on TypeScript 7 yet.

## Configure

Put the configuration in `contract-fidelity.config.json` at the project root.
You can also put it in the `contractFidelity` key of `package.json`.
Do not use both files.

```json
{
  "contractPackages": ["@acme"],
  "tsconfig": "tsconfig.json",
  "scanRoots": ["src"],
  "trustContract": true,
  "inferConstraints": true,
  "closedWorld": true,
  "baselineDir": ".contract-fidelity",
  "docPatterns": []
}
```

| Key | Default | What it does |
| --- | --- | --- |
| `contractPackages` | none | Which declarations carry contracts. Required. |
| `tsconfig` | `tsconfig.json` | The project the tool analyses. |
| `scanRoots` | `["src"]` | The directories the tool scans for violations. |
| `trustContract` | `true` | Whether a guard on a direct contract read is a violation. |
| `inferConstraints` | `true` | Whether the checker's own types count as guarantees. |
| `closedWorld` | `true` | Whether the callers in this program are all the callers. |
| `baselineDir` | `.contract-fidelity` | Where the tool writes the baselines. |
| `docPatterns` | `[]` | Extra prose patterns for your own generator. |

`CONTRACT_FIDELITY_CONFIG` names a config file elsewhere than the project
root, for a run that must not touch the shared file.

`contractPackages` has no default, and the tool fails without it.
A scan that matches no contract reports "clean" while it checks nothing.
A value matches `node_modules/@acme/...` and pnpm's
`node_modules/.pnpm/@acme+...`.
A bare directory name matches a generated client inside the repository.

Set `scanRoots` to the directories that hold your own code.
A project that keeps its code in `app/` or `lib/` must say so.

Both checks keep a down-only baseline in `baselineDir`.
You can adopt an existing backlog without a block on every commit.
Anything new fails.

### Custom doc patterns

The built-in prose patterns match what `openapi-generator` writes.
Another generator words its guarantees differently.
Add your own with `docPatterns`.

```json
{
  "docPatterns": [
    { "source": "\\bstrictly positive\\b", "flags": "i", "kind": "positive" },
    { "source": "\\bbounds (\\d+)\\.\\.(\\d+)\\b", "kind": "range" }
  ]
}
```

`kind` is one of `positive`, `non-negative` or `range`.
A `range` pattern must capture two numbers, because the bounds come from them.
The tool rejects an invalid pattern when it loads the configuration.
It does not accept a pattern and then contribute nothing.

## Status, honestly

Precision is validated.
The tool ran against three unrelated public SDKs from `openapi-generator`: Lob,
Conekta and Klaviyo.
Those SDKs hold approximately 4,850 contract guarantees.
The tool reported zero false positives.
That exercise found four portability bugs, and each one now has a regression
test.

Recall is not validated outside the codebase where the tool was written.
Those three SDKs are thin wrappers with no view models, so the tool found no
true positives in them either.
Run it on an application that consumes a generated client, and the result is
genuinely interesting.
Please open an issue with what you find.

The prose heuristics are tuned to `openapi-generator` descriptions.
The required-non-null detection and the enum detection do not depend on the
generator, and they carry most of the value in practice.

## Two sources of a guarantee

A contract is not the only thing that can state what a value is.
The checker states it too, and the loss is the same either way.

```ts
function label(name: string | undefined) { ... }   // every caller passes string
const scope = row.scope as string;                 // row.scope is a named union
```

Neither example has a contract in it.
Both replaced a type that carried information with one that carries less.
The defensive code written downstream then looks necessary to the reviewer and
to the compiler alike.

So the tool reads guarantees from two places:

| Source | What it can state |
| --- | --- |
| A generated contract | Everything below, plus prose the type cannot hold |
| The checker's own type | `required-non-null` and `enum-member` only |

A contract wins when there is one, because it names a field a reader can look
up.
The `origin` on each finding says which source it came from, and a finding
never says "the contract" about a guarantee the checker supplied.

Set `inferConstraints` to `false` to use contracts alone.

### The limits on an inferred guarantee

An inferred guarantee is weaker than a contract, so the tool asks more of it.

A contract that says "required" contradicts any nullish declaration.
The checker says only that the values seen so far were present, so a report
needs the one shape with a mechanical fix: the declared type is the source
type with nullish added, and nothing else.

Three more cuts, each measured against a real application:

- A literal type is not a narrowing target.
  One caller passing `"What this page is"` does not mean the prop should be
  typed `"What this page is"`.
- An anonymous union is not a narrowing target.
  `ColorTheme` is a decision the codebase already made, and narrowing to it is
  a one-word edit.
  Two prose sentences joined by a bar is an implementation detail.
- A suggestion must name a type.
  A whole function signature, an object type spelled out, `any[]`, or the
  declared type repeated back are all diagnostics nobody can apply.

Without these, the rule produced 1,224 findings on a real codebase and about
half were nonsense.
With them it produces 515, and each one names an edit.

Two soundness bugs surfaced in the same exercise, and both are fixed.
A property declaration's own initialiser was not counted as a write, so
`private rafId: number | null = null` looked always-present and the tool
proposed narrowing away the very case the field exists for.
A function that throws on an absent value is a validator whatever it spells
its parameter, so `assertRequired(value: T | undefined)` is no longer reported
across its 21 call sites.

## The closed world

`closedWorld` says whether the callers in this program are all the callers
there are.

For an application, they are.
An exported function called only from inside the repository is fully censused,
so a unanimous verdict across those calls is a proof.

For a library, they are not.
Its exports are called by code this program will never see, and a census of
the calls it can see proves nothing about the calls it cannot.
Set `closedWorld` to `false`, and only module-local functions stay provable.

## The contract is trusted

The generated client is the source of truth.
Re-derivation of a contract guarantee at runtime is a bug, not prudence.
It forks the code on a branch that cannot execute.
It also hides which value is authoritative.

```ts
if (typeof currency.scale !== "number") {         // scale: number, required
  throw new Error("CRITICAL: mandatory for financial calculations");
}
if (!Array.isArray(response.data.items)) { ... }  // items: T[], required
```

A guard on a direct contract read is a finding like any other.
There is no trust-boundary exemption.
Use `--exclude-boundary-checks` to separate those findings when you read a
diff.
That flag does not suppress them.

Set `trustContract` to `false` if your team decides to validate at its
boundary.
The tool then reports only the widened cases.

A check on something the contract leaves open is not a finding.
`!currency` after a cache lookup that can miss is legitimate.
So is `accounts.length === 0` on an array that can be empty.
So is `!name` where `""` is a legal value.

## Where a guarantee gets dropped

Six carriers ask the same question.
Is this declaration wider than every value that flows into it?

The `widening` check needs no dead guard.
A widening is falsifiable on its own, and to wait for somebody to write the
dead check first is to report the disease only after it has made a symptom.

| Carrier | Example |
| --- | --- |
| Field on a view model or a props type | `interface RowVM { status: string }` fed by a contract enum |
| Parameter | `durationOrDash(ms: number \| null)` called only with required fields |
| Local annotation | `const name: string \| undefined = account.entity.name` |
| Return type | `function f(a): string \| undefined { return a.entity.name }` |
| Cast | `account.entity.name as string \| undefined` |
| Collection element | `const names: (string \| null)[] = [account.entity.name]` |

A guarantee survives a copy, so the tool resolves every declaration together,
to a fixed point over the whole program.
Every parameter, owned field, `const` local, destructured binding and return
slot is a node.
Every value flow into one of them is an edge: a call argument, a field write,
a return expression, an initialiser, a destructuring read.
A node holds the join of what reaches it, from a lattice of height two:
unproven, a guarantee, or nothing observed.
Two different guarantees join to unproven.

That is what makes the chain visible in one run.
A dispatcher `execute(args: Record<string, unknown> | null)` called only with
present arguments is a widening.
Each handler it passes `args` on to is the same widening, one hop further.
A one-hop census reads `args` at the dispatch site through its declared type
and stops; the graph carries the dispatcher's proof into every handler.

One rule keeps that sound.
A node's value is a fact about its declaration, and the checker's type at a
reference can differ from it: `o?.f` is wider, `x` after a guard is narrower,
and `x` in an exhausted `switch` is `never`.
An edge through a reference uses the declaration's proof only when the
checker's type at the reference is mutually assignable with the declared type.
Any other reference contributes what its own type states, or nothing.
A `never` reference is unreachable and contributes nothing at all.

A shape excluded as produced-outside-literals proves nothing.
Its census is incomplete.
To let it seed the fixed point would launder a guarantee it never had into
every field downstream.
A parameter nobody calls, a slot no `return` fills, and a value passed on
from either prove nothing for the same reason.

## What counts as a guarantee

The tool reads these off the generated client, one field at a time.

| Kind | Where it comes from | Example evidence |
| --- | --- | --- |
| `positive` | A doc comment | `Amount in minor units (must be > 0)` |
| `non-negative` | A doc comment | `Counts are non-negative.` |
| `range` | A doc comment | `Site identifier (1-31, per REQ-004)` |
| `non-empty-array` | A doc comment on an array field | `at least one is required` |
| `enum-member` | The field type is a union of string literals | `EntityScope` = `HOUSE \| CLIENT \| GROUP` |
| `required-non-null` | The field is neither optional nor nullable | `'created_ids': Array<string>` |

Run `contract-fidelity contracts` to print the whole index.
The doc patterns are prose heuristics.
An audit in one pass is what keeps them honest.

The tool reads interfaces and classes.
`openapi-generator` emits models as interfaces with the `typescript-axios`
template, and as classes with the `typescript-node` template.

## What counts as a dead guard

The tool reports only a check that the guarantee makes statically decidable.
The check must be always true or always false.
This line decides whether the rule is worth having.

| Guarantee | Guard | Verdict |
| --- | --- | --- |
| `must be > 0` | `amount > 0` | Always true. Reported. |
| `must be > 0` | `amount === 0` | Always false. Reported. |
| `non-negative` | `count >= 0` | Always true. Reported. |
| `non-negative` | `count > 0` | Undecided. Never reported. Zero is legal, so this is a real presence test. |
| `1-31` | `siteId > 31` | Always false. Reported. |
| `1-31` | `siteId > 10` | Undecided. |
| A required field | `x ?? fallback`, `x?.y`, `x === null` | Always decided. Reported. |
| A required field | `!x` on a string or a number | Not reported. `""` and `0` are falsy and legal. |
| An enum union | `default:` after every member is cased | Unreachable. Reported. |
| `non-empty` | `rows.length > 0`, `!rows.length` | Always decided. Reported. |

The tool decides a runtime type test the same way.
People re-establish at runtime what the contract already fixed, and they do it
most often with a value that was widened to `unknown`.

| Guarantee | Guard | Verdict |
| --- | --- | --- |
| `scale: number` | `typeof scale === "number"` | Always true. Reported. |
| `scale: number` | `typeof scale === "string"` | Always false. Reported. |
| `tags: string[]` | `Array.isArray(tags)` | Always true. Reported. |

The tool also reports `Math.max(0, x)` and `Math.abs(x)` on a value that is
already non-negative.
That clamp can never clamp.

## Validators stay out of scope

A parameter that asks for anything is not a guarantee that went missing.

```ts
function isObject(value: unknown): value is Record<string, unknown>;
function requireStringIdentifier(value: unknown, field: string): string;
```

Widening is the accidental loss of a specific type.
A declared `unknown` is deliberate.
The author takes responsibility for the check, and the checks inside are the
point of the function.
A type-predicate return type marks a validator.
So does a bare `unknown` or `any` parameter on a function that throws.

This exemption stays narrow on purpose.
`accounts: unknown[] | undefined` is not a bare `unknown`.
A function that returns a default asserts nothing.
Both stay in scope.

## Soundness: every writer, not only the one we followed

A guard inside a helper is dead only when every call site hands it a guaranteed
value.
Consider `textOrDash(value: string | null | undefined)`.
Eleven callers pass a contract-required field, and one caller passes a
genuinely nullable local.
The `value == null` branch is live.

The scanner re-derives the verdict at every known call site before it reports
anything on the callee side.
It drops the finding unless every call site agrees.
These cases mean "unproven", and unproven is silent:

- A parameter with no known caller.
- A caller that passes an unconstrained value.
- A spread argument.
- A call that omits the argument.
- A function that is handed to somebody else as a value. `list.forEach(addRow)`
  calls `addRow` with arguments no call expression names.
- A census made only of test-file callers.

Fields work the same way.
A guard on `vm.entityType` is dead only when every write into that field
supplies a guaranteed value.
An unaccounted writer could supply anything.
The census reads these writes:

- A property in an object literal, against the literal's contextual type.
- A JSX attribute, against the component's props type.
- `obj.field = expr`, `obj["field"] = expr`, and a property initialiser.
- The omission of an optional field, which is a write of "absent".

These writes disqualify the field, because the census cannot read the value:

- `delete obj.field`, `obj.field ??= expr`, `obj.field++`.
- `obj[key] = expr` with a computed key, and `Object.assign(obj, x)`. Both
  disqualify every field of the type.
- A spread. `{ ...src }` and `<Row {...src} />` write the fields of the
  TARGET, so a target field whose source field is optional, nullable or absent
  is disqualified. A field the same literal supplies after the spread keeps
  its own write.
- A whole object of one type flowing into a slot of another, by the same rule.
- Every field of every parameter type of a function that is handed around as a
  value. A component passed as `component={Cell}` is rendered with a props
  object the caller builds.

Both censuses include test files on purpose.
The tool never scans a test file for origins.
A test that passes `null` proves the branch is reachable.
A census made only of test-file writers proves nothing about production.

## Out of scope

- Test files as violation sites. A test constructs an out-of-contract value on
  purpose, so a guard there is not dead.
- Hedged prose. `Must be greater than zero unless the zero_amount directive is
  present` guarantees nothing. Neither does `Non-empty means the event is
  excluded from matching`, which states an implication. The tool reads both as
  "no constraint".
- A body that can fall off its end, or a `return` with no value. The slot
  then holds `undefined` on a path no edge names, and the tool does not prove
  it.
- Library parameters. A widened signature in `node_modules` is not yours to
  fix.

## Commands

```bash
contract-fidelity dead-code                              # ratchet check
contract-fidelity dead-code --list                       # every violation, with context
contract-fidelity dead-code --list --exclude-boundary-checks
contract-fidelity dead-code --json                       # machine-readable
contract-fidelity dead-code --update-baseline            # ratchet down

contract-fidelity widening                               # ratchet check
contract-fidelity widening --list
contract-fidelity widening --update-baseline

contract-fidelity contracts                              # audit the index
contract-fidelity optional-fields                        # rank the schema work
contract-fidelity optional-fields --list --json
```

The scan builds a real TypeScript program from the configured `tsconfig`.
It takes a few seconds.
The tool needs the checker to follow a value across a call, and no regex is an
honest substitute.

The baselines live in `baselineDir`, one file per check.
A baseline records the SET of findings, not a count per file.

A count passes the one trade this tool exists to catch.
Fix a finding, add another in the same file, and the count does not move.
That is the edit a model makes when it is told to clear a lint.
A set makes "new finding" exact.

Each finding is identified by the file, the text at fault, the contract it
disagrees with, and the kind of guarantee.
The line number is deliberately absent, because line numbers churn on every
edit above them.
`--update-baseline` refuses to ADD a finding without `--force`.

A version 1 baseline, which held a count per file, is refused rather than read
as empty.
Re-seed it with `--update-baseline --force`, then read the diff.

The tool fails loudly when the program holds no contract declarations, for
example before an install.
It does not pass vacuously.
The contracts define the whole policy.

## The schema work queue

`contract-fidelity optional-fields` is not a gate.
It is a ranked list of work for whoever owns the OpenAPI documents.

A guard on a field the schema declares optional cannot be called dead.
The schema says the field may be absent, so the check is correct, and no
analysis of the consuming code can say otherwise.
But most such fields are optional only because nobody wrote `required`.
The service returns them every time.

```text
580 guard(s) on 309 optional contract field(s), ranked by how much code
each one costs.

    24  AccountResponse.account_id       ?. x24
    18  Template.examples                ?? x11, ?. x6, !x x1
    11  Programme.executing_revision     === / !== null | undefined x8, ?? x2, ?. x1
```

Mark the field required upstream, regenerate the client, and every guard
counted here becomes a `dead-code` finding.
That scanner then deletes them.

This is the only honest way to reach the defensive code that is legal.
The two gates report what is provably wrong; this command measures what is
merely unnecessary, and hands it to the people who can fix it at source.

## Fix a finding

Take one of two options.
Prefer the first.

1. Delete the dead branch.
   This is usually right when the widened signature is a local helper with one
   or two callers.
2. Keep the contract type on the signature.
   Write `scope: EntityScope` rather than `scope: string`.
   Write `tags: string[]` rather than `string[] | null`.

The guard then becomes visibly redundant, and
`@typescript-eslint/no-unnecessary-condition` takes over.

To raise the baseline is not an option.

## The widening check

The `widening` check uses the same inputs and the same write census.
It removes one rule: it does not need a dead guard.
It reports a field when both statements are true:

- Every write into the field comes from a contract field that carries a
  guarantee.
- The declared type of the field has dropped that guarantee.

Two more exclusions apply on top of the shared rules.
A shape declared inside a test file is out of scope, because a fixture is not a
view model the application ships.
A field with no type annotation is out of scope, because nothing was widened.
The inferred type is the source type.

The fix always has the same shape.
Narrow the field to what the contract already promises.

```diff
-  entityName: string | undefined;   // <- entity.name, required non-null
+  entityName: string;
-  valuationRole: string;            // <- valuation_role, an enum union
+  valuationRole: ValuationRole;
```

Expect the fix to surface redundancy the type checker could not see before.
Once the field is narrow, `@typescript-eslint/no-unnecessary-condition` starts
to flag the `??` and the `!== undefined` that were built on it.
That handoff is the point.

## Layout

| File | What it owns |
| --- | --- |
| `src/constraints.mjs` | What "narrow" means. Every always-true and always-false decision. Pure. |
| `src/contract.mjs` | Reads a guarantee off a client symbol. |
| `src/census.mjs` | The call-site census, and the guarantee readers. |
| `src/fields.mjs` | The write census behind a view-model finding and a props finding. |
| `src/graph.mjs` | The whole-program value graph, its lattice, and the fixed point. |
| `src/analyze.mjs` | Guard shapes, and the flow between them. |
| `src/carriers.mjs` | Parameters, locals, return types, casts and collection elements. |
| `src/program.mjs` | The shared TypeScript program, and the file-scope rules. |
| `src/config.mjs` | Configuration load and validation. |
| `src/ratchet.mjs` | The down-only baseline. |
| `src/dead-code.mjs` | The `dead-code` command. |
| `src/widening.mjs` | The `widening` command. |

## Development

```bash
npm test
```

The suite covers the decision table, both scanners against a fixture tree, and
the CLI end to end.
The end-to-end project in `test/__project__` keeps its code in `app/`, not in
`src/`.
That layout guards the scan-scope rules: a scanner that hardcodes `src` finds
nothing there and reports a clean run.

## License

MIT.

## Go

The `go/` directory holds the same tool for a Go program that consumes a
generated Go client (`openapi-generator`'s `go` template).
It is a separate implementation on `go/packages` and `go/types`, not a port:
the analysis is the same, the compiler API is Go's.
It reads the same `contract-fidelity.config.json` and writes the same
version-2 baseline, so one gate serves both languages.

```bash
go install github.com/ufs-lab/contract-fidelity/go/cmd/contract-fidelity@latest

contract-fidelity contracts                    # audit the index
contract-fidelity dead-code --list             # every dead guard, with context
contract-fidelity widening --list
contract-fidelity dead-code --update-baseline  # ratchet down
contract-fidelity explain Status               # the census of every carrier named Status
contract-fidelity plan                         # the findings grouped into work items
```

`contractPackages` holds import-path prefixes
(`github.com/acme/ledger-service/clients/go`); `scanRoots` holds
directories under the module root (`internal`, `cmd`), scanned as
`./internal/...`.
`tsconfig` is accepted and ignored.
One extra key, `censusTests` (default `true`), says whether writes in
`_test.go` files count in the census; `--census-tests=false` overrides it
for one run.

### What the Go index reads

| Kind | Where it comes from |
| --- | --- |
| `required-non-null` | A plain value field without `omitempty` and not a `Nullable*` wrapper |
| `enum-member` | A named string type with constants AND a strict `UnmarshalJSON` |
| `integer-width` | The field's integer type (`int32`) |
| `positive`, `non-negative`, `range` | `minimum` / `maximum` in the client's bundled `api/openapi.yaml`, or the doc-comment prose patterns above |
| `non-empty-array` | `minItems` in the spec, or the prose patterns |

The spec beside the client is the better source: `openapi-generator` ships
it, and `minimum: 400` needs no heuristic.

### What the Go scan follows

A value flows from a contract read through conversions (`int(x)`,
`string(x)`), locals, struct fields, parameters, method receivers, result
slots, and map elements.
The census reads every write into each: literal fields (an omitted field is
a write of the zero value), assignments, call arguments, returns, `var`
declarations, and whole-map copies.
These leave a carrier unproven, and unproven is silent: a compound
assignment, a range binding, a spread call, a tuple the census cannot read,
a function or method used as a value, a method named on any interface in
the program, an address passed to a call outside the program, and a map
built by a call.

A guard is dead when a numeric comparison against a constant is decided,
when a `switch` has a `default:` after a case for every enum member, when
`len(x)` is compared against a non-empty guarantee, or when `x == nil` /
`x != nil` tests a value that carries `required-non-null`.
A required scalar is a plain value in Go and the compiler refuses `== nil`
on it, so the nil guards that matter are on arrays and maps: the generated
decode admits `null` for those, and the spec's `required` without
`nullable` is what makes the check dead.

### Two sources of a guarantee, in Go

`inferConstraints` (default `true`) lets the program's own types and writes
supply a guarantee, as in the TypeScript tool:

| Inferred kind | What the census saw |
| --- | --- |
| `enum-member` | Every write is a constant of one named string type declared in the program (`outcomeOK`, `outcomeFail`); a `string` fed only by them could be that type |
| `required-non-null` | Every write is an address (`&x`), a literal, a `make` or a `new`; `p == nil` on it is dead |

Each finding prints its origin, `contract:` or `inferred:`, and an inferred
finding names the program's type, never a contract field.
`explain NAME` prints each guarantee with its origin in angle brackets.

### plan: the findings as work items

`plan` groups every finding into the unit one person, or one agent, fixes
in one change.
Findings that disagree with the same contract field are one item: the
dead guard, and every widened declaration on the way to it.
Items that touch the same file are merged, so two changes never edit one
file.
A guard on a direct contract read (`body.CreatedIds == nil` on a required
array) is a `ruling` item, kept apart from the `fix` items: the code keeps
it on purpose against a server that breaks its own contract, or it is
dead, and a person decides which.

```bash
contract-fidelity plan          # a report
contract-fidelity plan --json   # {"module": ..., "items": [{id, kind, contracts, files, dead, widening}]}
```

Each item's `id` is a hash of its kind and contract keys, not of lines or
files, so it survives edits above a finding and a move between files.
A caller that files one ticket per item can key the ticket on
`<module>/<id>` and find it again on the next run.

### go vet and golangci-lint

`go/analyzer` is a `go/analysis` Analyzer.
The analysis is whole-program, so the analyzer loads the program once per
configuration root (the directory that holds `contract-fidelity.config.json`,
found upward from each package) and reports the findings that fall in the
package it is visiting.
`go vet` starts one process per package; the findings are cached on disk,
keyed by the module's Go sources and the config, so a run over N packages
loads the program once.

```bash
go install github.com/ufs-lab/contract-fidelity/go/cmd/contract-fidelity-vet@latest
go vet -vettool=$(command -v contract-fidelity-vet) ./...
go vet -vettool=$(command -v contract-fidelity-vet) -widening=false ./...   # dead guards only
```

Flags: `-config FILE`, `-dead-code=false`, `-widening=false`,
`-census-tests=false`, `-cache=false`, `-cache-dir DIR`.

As a golangci-lint module plugin, `.custom-gcl.yml`:

```yaml
version: v2.3.0
plugins:
  - module: github.com/ufs-lab/contract-fidelity/go
    import: github.com/ufs-lab/contract-fidelity/go/plugin
    version: latest
```

and `.golangci.yml`:

```yaml
version: "2"
linters:
  enable:
    - contractfidelity
  settings:
    custom:
      contractfidelity:
        type: module
        settings:
          widening: false
```

Under a `go/analysis` driver there is no down-only baseline; use
golangci-lint's `issues.new-from-rev` to ratchet, or the CLI for the
baseline file.

### Validation

The first run was on a production service with two generated clients,
1,503 indexed guarantees.
`dead-code` reported the four cases a by-hand review had found, plus one it
had missed (`len(results) == 0` on a `minItems: 1` field), with no false
positives.
`widening` reported 15 declarations, each an `int` or `int64` fed only by
an `int32`, or a `string` fed only by an enum.
With nil guards and inference on, the same service added four
`created_ids == nil` boundary checks on a required, non-nullable array and
two inferred non-null checks, each confirmed against the census.
