# hub/rules

Generic interpreters over versioned tables, the catalog view they match against, `runCheck` for declared checks, and the
sandbox that runs pure pack functions. Model elements: C03 C04 C05 C06 C07 C08, T03 (checks), T04, V01, A04. Other packages
import only `hub/rules/api.ts`.

## What is here

| Path | Content |
| --- | --- |
| `contracts/src/tables.ts` | zod shapes registered in `schemas`: `structure@1`, `catalog@1`, `membership@1`, `pattern@1`, `range@1`, `coverage@1`, `quote@1`, plus `catalog-entry@1` (one member of a closed catalog) and `check-outcome@1` (what a check returns, also the output contract of pack check functions) |
| `api.ts` | the public surface |
| `interpreters/` | one interpreter per table kind, each with `*.samples.json` (positive and negative samples), and the registry |
| `catalog/` | `CatalogView` (in-memory implementation `createCatalogView`, test builder `buildCatalog`), typed parameters, tokenizer, overload matching |
| `pattern/regex.ts` | the linear-time matcher behind `pattern@1` |
| `check.ts` | `runCheck(declaration, bindings)` |
| `samples.ts` | `runSamples()`: the conformance suite of the interpreters (tests run it; the Hub may run it at start) |
| `quote-vectors.json` | test vectors for verbatim quotation shared with `hub/refs` |
| `sandbox/` | `callPackFunction`: parent (`sandbox.ts`), child entry (`bootstrap.ts`), command line, OS profile and probe (`isolation.ts`), import policy (`policy.ts`), errors (`errors.ts`), slots and waiting line (`slots.ts`), memory poller (`resident.ts`), leftover children (`orphans.ts`) |

## Decisions

### Tables (C04, C05)

- Every table is a closed object (`additionalProperties: false`) with `schema: "<kind>@1"` and a required `origin`: the source
  file (a reference) or the decision that produced it (C04 R[0]: without it a table is code). Optional on every kind: `tier`,
  `basis` (the contract clause a blocking check relies on), `description`, and the pointers `item` and `location` that put
  the item identity and its reference into outcomes.
- Tier (C05 R[1]): a blocking check must name its contract clause. A table that says `tier: "blocking"` without a non-empty
  `basis` is not admitted (issue at `/tier`; for `catalog@1` also at `/negative/tier`); without a `tier` the tier is
  `blocking` when the table has a `basis` and `advisory` otherwise.
- Tables select values with RFC 9535 JSONPath restricted to member names, indexes and wildcards, and outcomes locate values
  with RFC 6901 JSON Pointer. Arrays selected by a path are flattened one level (`$.tags` and `$.tags[*]` select the same).
- Text is normalized by the representation the table declares before comparison (C04 R[2]): Unicode form (`nfc` default,
  `nfkc`, `none`), case, white space (`trim` default, `collapse`, `exact`).
- Missing is not empty (C04 R[4]). A location is *missing* when the member its path names up to the first wildcard does not
  exist (`$.cases[*].parameter` is missing without `cases`; an empty `cases`, or cases without `parameter`, are present and
  select nothing). `structure@1` reports a missing required field as `core.structure.required_empty` with `data.missing`.
  `membership@1`, `pattern@1`, `range@1` and `catalog@1` (its `commands`) take `required`: when true a missing location is
  unknown (missing input); otherwise it is nothing to check and the vacuous support lists it in `data.missing`. An existing
  empty list is nothing to check either way (a threshold counts zero). `coverage@1` has no switch: required members selected
  from a missing location, or covered locations that are all missing, are unknown. Statements (`claims`), quotations and
  declared skips are optional by nature: a missing location means there are none. `structure@1`: missing `nodes` is
  unknown, an empty node list is nothing to check.
- The only embedded expression is the pattern of `pattern@1`: declared language `regexp`, at most 256 characters, samples
  mandatory (at most 64 rules, 32 samples per list, 1,000 characters per sample) and matched when the table is validated
  within a work budget (10,000,000 code points times automaton states); a table whose samples need more is not admitted.
- A table is validated once per content: interpreters cache the result by the SHA-256 of a canonical text of the table (an
  undefined member, a null member and an absent member stay different; values that are not plain JSON are not cached), so
  admission pays for the samples and later runs do not. The cached parsed table is frozen.
- Seven of the eight table semantics of C04 R[1] are implemented; mapping is not needed in milestone 1.

### Interpreters (V01)

- Deterministic and total: an invalid table, an odd subject or an internal error gives an `unknown` outcome with a reason from
  the vocabulary (`check_error`, `missing_input`, `integrity_unproven`, `budget_exhausted`); `run` never throws and always
  returns at least one outcome. Checks never abstain: `check-outcome@1` allows support, refute and unknown only (V01). When
  there is nothing in scope to check, the answer is one `support` with `data.checked = 0` (an empty selection is vacuously
  satisfied; missing locations the table does not require are listed in `data.missing`); out-of-scope phrases are not
  verdicts (V01 R[0]). `CheckRequest.tier` (set by runCheck from the declaration) replaces the table's tier; negative-case
  outcomes keep the negative tier.
- Refutation codes are taken from `CORE_VIOLATION_CODES` by interpreter name; `quote@1` refutes with the protocol code
  `QUOTE_MISMATCH` (T03 R[3]: the caller turns it into "not accepted"). Statements are Chinese and start with the registered
  description of the code; `data` carries the machine-readable parts.
- `structure@1`: required fields, JSON types, numeric ranges and string lengths (as `core.structure.type_mismatch` with
  `data.constraint` `range` or `length`, because the registry has no structure range code), array and child counts
  (`core.structure.cardinality`), uniqueness among all nodes, siblings or groups (`core.structure.duplicate_key`, reported on
  every holder, at most 20 others listed), rules per node kind. Works on one node, a list (`nodes: "$[*]"`) or a tree
  (`children` pointer, depth at most 64, at most 100,000 nodes). A walk the limits cut short adds one unknown
  (`budget_exhausted`) at the pointer where it stopped, with `data.not_examined` (subtrees not entered) and `data.examined`,
  so the requirement can never pass on a partly examined subject; uniqueness is then compared among examined nodes only.
- `catalog@1`: command phrases are tokenized (shell-like quotes), the head is found by longest match, arguments are matched
  against every overload by dynamic programming (an optional parameter may be skipped; an out-of-range value costs less than
  a value of the wrong type; ties go to the overload declared first). No assignment at all is `core.catalog.arity_mismatch`.
  Enum and keyword mismatches are type mismatches; a string longer than `maxLength` is out of range. `scope`: `resolved`
  (default, the brief's "only phrases whose head resolves are checked"), `first_word` (a phrase whose first word starts an
  entry must resolve, else `core.catalog.not_member`), `all`. The head decides the scope also for text the tokenizer refuses
  (an unmatched quote, a trailing backslash): it is split at white space only to find the head, so out-of-scope prose with an
  apostrophe is skipped and only an in-scope phrase becomes unknown (`check_error`). Membership statements (`claims`) give
  `core.catalog.membership_contradicted`. A command exists when its words are a head, a menu (a proper prefix of heads), or a
  head followed by arguments that fit one of its signatures; words after a head that fit none (wrong count, type or range)
  make the command absent, `data.head` names the head and the statement says why. Absence is a fact only for a view declared
  `complete` (C07 R[0], R[1]); otherwise it is unknown (`integrity_unproven`), whichever way the statement goes. Negative
  cases: refutations stay refutations, get the negative tier (default `advisory`, kept whatever tier the declaration sets)
  and `data.negative_case = true`, `data.expected` (the code is one the table expects); the caller applies the expectation
  (V03 R[2], V04 R[1]).
- `pattern@1` runs on its own Thompson-automaton matcher, linear in the input: ECMAScript syntax in Unicode mode without
  backreferences, lookaround or named groups, bounds at most 100, at most 1,000 states; character tests delegate to
  single-code-point ECMAScript expressions, so classes and case folding mean what they mean in JavaScript (the tests compare
  against `RegExp` on a corpus and 400 random patterns). Values longer than 20,000 code points are unknown; total matching
  work per run is capped at 50,000,000 (then `budget_exhausted`); samples have their own budget at validation (above).
- `range@1`: ranges and prefixes per value (prefixes optionally by whole segments, `separator`), thresholds on an aggregate
  (`count`, `sum`, `min`, `max`). Numbers are JSON numbers, taken by their shortest decimal text (so 0.1 + 0.2 sums to 0.3),
  or decimal strings, taken digit by digit; both are compared and summed exactly with BigInt (`interpreters/decimal.ts`), so
  values beyond 2^53 or with hundreds of digits are not rounded. A decimal text longer than 1,000 characters is unknown
  (`check_error`); a value that is not a number is refuted. A threshold's `data.value` is a JSON number when one represents
  the result exactly, else its decimal text.
- `coverage@1`: required members by value, by reference, by pack set name or selected from the subject; a declared skip
  counts only with a non-empty reason.
- `membership@1` and `coverage@1` sets by reference: the bound fragment's text must be a JSON array of scalars.
- `quote@1` independently implements exact contiguous substring matching in `text.ts`. Case, punctuation, character
  width, Unicode normalization form and every whitespace character remain significant; no trimming, folding or
  normalization is applied. Empty and whitespace-only quotations never match. The 36 shared vectors cross-check rules
  and refs independently and test direct checks and the interpreter. Ordinary table match representations retain their
  original whitespace normalization; this change affects quotation checking only.

### Catalog view (C07)

`CatalogView` gives `lookup(words)` (longest head), `get(words)`, `hasPrefix(words)`, `heads(prefix?, {limit})`, `entries()`,
`size`, `reference` (the catalog as a whole, ground of an absence), `complete` and `caseSensitive` (default false: words are
compared after NFC and lower-casing; a case-sensitive view compares NFC forms, and stores entry words in NFC). Each
`CatalogEntry` carries its tree `reference`; overloads given as separate entries of one head are merged. Parameter types: `string` (`minLength`/`maxLength` in code points), `int` (`minimum`/`maximum`), `enum`
(`values`), `ipv4` (dotted quad, no leading zeros), `ipv6` (RFC 4291 text forms, no zone), `mask` (contiguous dotted IPv4
mask), `port` (0-65535, narrowed by `minimum`/`maximum`), `keyword` (the literal `keyword`, default the name); `optional` and
`default` on any parameter.

### runCheck

`runCheck({ id?, interpreter? | function?: { module, export? }, tier?, basis?, catalogEntries?, limits? }, { table?, subject,
catalog?, sources?, context, packDir?, sourceTexts?, sandbox?, onError? })`. Exactly one of `interpreter` and `function`.

- No check is not a verdict (V01 R[1], R[5]): an interpreter that is not installed gives an empty list, never an outcome; the
  caller records the static terminal unchecked (`no_check`). Otherwise the list is never empty. `getInterpreter(id)` tells the
  same in advance.
- Tier: `declaration.tier` replaces the table's tier (for interpreters it is passed in as `CheckRequest.tier`); outcomes
  marked `data.negative_case` keep their own tier. A blocking declaration needs a `basis`, its own or (for an interpreter)
  the table's, else the check is unknown (`check_error`). Without a declared tier, an interpreter uses the table's tier and
  a pack function's outcomes get `blocking` when the declaration has a basis and `advisory` otherwise (a pack function does
  not choose its tier, except for negative-case outcomes, which still never block without a basis).
- A pack function receives `{ check, table, subject, context, sources, catalog? }` (it cannot call back, so fragment texts
  come as `sourceTexts` and catalog entries only when `catalogEntries` is set; one entry list per view is shared by queued
  calls) and must return a non-empty array of `check-outcome@1`. It fails closed: without `context.pack` it is not run
  (unknown, `missing_input`); every code must be under `<pack>.` with something after the dot; `core.*` and protocol codes
  are refused from any pack; a code only on a refutation, a reason only on an unknown, and only the reasons a check gives
  (`check_error`, `timeout`, `missing_input`, `integrity_unproven`, `budget_exhausted`). Otherwise the whole result is
  unknown (`check_error`).
- Sandbox failures become unknown: `SANDBOX_TIMEOUT` as `timeout`, a full waiting line (`SANDBOX_UNAVAILABLE`, reason
  `queue_full`) as `budget_exhausted`, everything else as `check_error`. Outcome data keeps only a stable, path-free part:
  `data.sandbox` (the code), `data.module` (pack-relative) and `reason`, `limit`, `stream`, `phase` when present. Messages,
  stacks, timings, specifiers and captured output reach only `onError(error, check)`, for the admin log; an error that is
  neither a SandboxError nor an invalid call (TypeError, RangeError) is reported without its message.

### Sandbox (C03 R[0])

Layers, outermost first:

1. Pre-flight scan of the pack: no symbolic links, no hard links (files with more than one link), no special files, at most
   20,000 entries and 32 levels. The permission model follows symbolic links out of granted paths (verified), so this is required.
2. `/bin/sh -c 'ulimit -t N; exec …'`: a CPU-time limit (twice the wall limit, plus one second) that also ends a CPU-bound
   child if the Hub itself dies.
3. On macOS, `sandbox-exec` with `(deny network*)`, `(deny process-fork)`, exec only of the Node binary, signals and process
   inspection only of itself, and no file writes except `/dev/null`. Node 24's permission model does not restrict the network
   (verified with a really listening loopback server), so this layer is required by default: without it `callPackFunction`
   throws `SANDBOX_UNAVAILABLE` unless the caller passes `{ requireOsIsolation: false }`.
   On Linux this layer uses bubblewrap with private user, PID, network, IPC and UTS namespaces and read-only bindings for the
   Node runtime, its dynamic loader and libraries, the trusted bootstrap, the pack and declared dependencies. AppArmor adds a
   mandatory deny-exec worker profile that also denies Internet-family sockets: a trusted shell sets a stack-on-exec transition before Node starts,
   so every Node thread inherits the restriction. The bootstrap verifies the enforced label before loading a pack. The
   worker permits Unix sockets for Node's inherited stdio; the private network namespace isolates abstract Unix sockets, and
   the file-write denial blocks pathname socket connections even through a mounted directory. Runtime exposes private proc and
   device pseudo-filesystems for the transition and runtime, not host directories; Node's
   permission model still denies pack reads outside its explicit grants. Missing bubblewrap, AppArmor tools, profile, user
   namespaces, loader dependencies or a verified label leaves isolation unavailable; there is no production fallback.

   An administrator installs the generated policy for the exact service Node binary, for example by piping the output of
   `node hub/rules/sandbox/linux.ts` to `apparmor_parser -r`. Reinstall it after changing that binary or shell. The host must
   allow the launcher profile to create user namespaces. Linux systems without a usable AppArmor policy need an equivalent
   independently verified kernel backend before Hub can run pack functions. This does not alter CI configuration.

   Each Linux child also tests the loaded enforcement before importing any pack: real execution of Node, synchronous and
   asynchronous writes to an isolated writable synthetic directory, and a pathname Unix socket connection must all fail with
   the expected kernel denial. The trusted bootstrap temporarily receives child-process and synthetic-directory write grants;
   it drops both using `process.permission.drop`, confirms they are gone, and refuses the call if that API is unavailable.
   The synthetic listener and directory are removed on completion. Policy names include a digest of the canonical worker rules;
   this is a version identifier, not proof that the administrator loaded those exact rules. An administrator or root able to
   replace an active kernel policy and the Node executable are within the deployment trust boundary. Reloading an active
   same-named profile can change confinement between checks: stop the Hub and drain its children before installing or replacing
   policy, and do not treat a successful synthetic path test as proof of every possible pathname. The dedicated-VM-only A/B
   command is `CIRCLE_HUB_SYNTHETIC_APPARMOR_TEST=1 node --test hub/rules/sandbox/testing/linux-policy-ab.ts`; it refuses to
   replace an already installed Hub sandbox policy and intentionally tests same-name weak policies and a cached probe.
4. Node's permission model: read access only to the bootstrap, `policy.ts`, the pack directory and the declared dependencies'
   package directories (resolved recursively); no writes, child processes, workers, addons, WASI or inspector;
   `--disallow-code-generation-from-strings`, `--no-addons`, `--no-experimental-websocket`, an empty environment (only `TZ=UTC`).
5. The bootstrap's lockdown, before pack code loads: process control, native bindings, signals, `process.report`,
   `process.env`, `fetch`, `WebSocket`, `EventSource` and the shared HTTP dispatcher are replaced; standard streams are capped
   in-memory captures (no native handle reachable); module hooks admit only pure builtins (`policy.ts`), the declared packages
   (resolved from the Hub, never from the pack) and ECMAScript modules or JSON inside the pack; `process.getBuiltinModule`
   follows the same list. Every attempt is recorded, so catching the error does not hide it. The bootstrap captures the
   intrinsics it uses afterwards, so replacing `String.prototype` methods, `JSON.stringify` or `Object.prototype.toJSON` from
   pack code neither opens the hooks nor forges the result frame (tested).
6. The parent: wall-clock timeout, resident memory (killed above `memoryMb + 192` MB) measured by one shared poller every
   100 ms for all running children (on macOS one `/bin/ps` per round: a 2 s call starts 20, and so do eight concurrent 2 s
   calls, measured), caps on the result frame and on stderr, a per-call random nonce on the single result frame, kill of the
   whole process group, between 2 and 8 children at once (the number of cores, bounded) and a waiting line of at most 10,000
   calls (a call beyond it fails at once: `SANDBOX_UNAVAILABLE`, reason `queue_full`). A waiting call holds no copy of its
   input: it is serialized, and the pack scanned, only when the call gets its slot (64 calls with a 4 MB input grew the parent
   heap by 37 MB, measured). A violation recorded while the result is serialized, or while a thrown value's `code`,
   `message`, `name` or `stack` is read (pack getters and `toJSON`), is still reported as the violation.
7. Lifecycle: the parent tracks its running children; `stopAll()` (exported) ends them and refuses the waiting calls
   (`SANDBOX_UNAVAILABLE`, reason `stopping`); it also runs from an `exit` listener, so an orderly exit or `process.exit` ends
   every child. The rules package installs no signal handler (that would change how the Hub exits): the server calls
   `stopAll()` on SIGTERM and SIGINT. `sweepOrphans()` (exported) ends children an earlier Hub process left behind: processes
   whose parent is pid 1 and whose command line grants read access to this installation's bootstrap (macOS through
   `/bin/ps -axww`, Linux through `/proc`). The OS-isolation probe keeps a success and a lasting absence (another platform, no
   `sandbox-exec`); a failed probe run is retried after 5 s, and `osIsolationFailure()` says why it failed.

Errors (`SandboxError.code`): `SANDBOX_TIMEOUT` (`detail.limit` `time` or `cpu`), `SANDBOX_OUTPUT_TOO_LARGE`,
`SANDBOX_VIOLATION` (`detail.what`, or `detail.limit = memory`, or `detail.reason` for the scan), `SANDBOX_UNAVAILABLE`
(`detail.reason` `os_isolation`, `cpu_limit`, `spawn_failed`, `queue_full`, `stopping`), `FUNCTION_THREW` (`detail.reason`
`output_not_json`, `never_settled`, `process_exit`, or the error's name, message, stack), `FUNCTION_NOT_FOUND` (also `pack_unreadable`
when the pack directory cannot be read during the scan), `IMPORT_NOT_DECLARED`. Invalid calls (input not JSON, input too
large, bad limits) throw `TypeError` or `RangeError`. Defaults: 10 s, 256 MB, 8 MiB output, 64 KiB kept per log stream, 32 MiB
input; maxima 120 s, 4 GB, 64 MiB, 1 MiB, 128 MiB.

Memory is enforced on the resident size rather than by V8's heap limit, because V8 aborts on heap exhaustion and macOS then
writes a crash report (observed); the heap limit is set far above as a backstop.

## Limits

- Linux has no operating-system network layer here. By default the sandbox refuses to run there; with
  `requireOsIsolation: false` (synthetic tests only) network denial rests on the JavaScript lockdown alone. The OS probe test is
  skipped on Linux; the tests were run on macOS only.
- `sandbox-exec` is deprecated by Apple. If a macOS release removes it, the default becomes `SANDBOX_UNAVAILABLE`.
- Resident size is polled: a burst can overshoot by what fits in about 100 ms, and memory the OS has compressed is not
  resident.
- If the Hub is killed (SIGKILL, a crash) no exit listener runs: a child that sleeps without using CPU (for example in
  `Atomics.wait`) outlives it until the next Hub start calls `sweepOrphans()`; CPU-bound children end at the CPU limit. On a
  machine where orphans are not reparented to pid 1 (Linux with a subreaper) the sweep finds nothing.
- The waiting line is bounded by count, not bytes: waiting calls hold only references to the caller's objects; the bytes in
  flight are at most 8 children times the input limit.
- The pack directory is scanned before each call; it must not be writable by anyone else while a function runs.
- Determinism of pack functions (clock, randomness) is the pack's contract (C08 R[2]); the sandbox does not enforce it.
- The JavaScript lockdown is defence in depth; confinement rests on the permission model and `sandbox-exec`.
- CommonJS pack modules are refused: pack functions are ECMAScript modules.

## How to test

```
node --test "hub/rules/**/*.test.ts"
npx tsc --noEmit
```

The sandbox tests start real child processes (about 8 s in total), a loopback TCP server on 127.0.0.1 with an ephemeral port,
and, on macOS, two short-lived orphan `node` processes for the sweep test (killed at the end); nothing else is reached.

## Deviations

- The option names of the table language (`unicode`, `case`, `whitespace`, JSON value types, `within`, `scope`, catalog
  parameter types, `flags`, `mode`) are closed sets written in `tables.ts`, and their Chinese names (`TYPE_TEXT` in
  `structure.ts`, `PARAM_TYPE_TEXT` in `catalog/params.ts`) bypass `labelOf` (`measure` comes from the model vocabulary).
  None of the remaining options is an axis of the model, so section 10's check (no hand-written enumeration of a vocabulary
  axis) holds, but the brief's general rule does not: they wait for the axes requested below. The reasons a check may give
  (`CHECK_REASONS` in `check.ts`) are a typed subset of the `reason` axis, chosen by V01 R[2] and C07 R[1].
- The sandbox's internal codes (`SANDBOX_*`, `FUNCTION_*`, `IMPORT_NOT_DECLARED`) are not in the registry; runCheck turns them
  into unknown outcomes with vocabulary reasons and they never reach a model. New conditions (`queue_full`, `stopping`,
  `os_isolation`, `pack_unreadable`) were added as `detail.reason` values of existing codes rather than as new codes.

## Needs from other packages

- **contracts**: any change to `contracts/src/tables.ts` needs `npm run gen:contracts` by the contracts owner
  (`contracts/generated` is not this package's). This round's change (`basis` non-empty and the tier rule, `catalog@1`
  `required`, pattern sample limits, `check-outcome@1` without `abstain`, descriptions of missing locations) has been
  regenerated: `node tools/gen-contracts.ts --check` reports a match (42 files).
- **contracts**: axes for the table language, so the closed sets above come from the generated vocabulary and their labels
  from `labelOf` (each value with the Chinese name now used): JSON value type (`string` 字符串, `integer` 整数, `number` 数值,
  `boolean` 布尔值, `array` 数组, `object` 对象, `null`), catalog parameter type (`string` 字符串, `int` 整数, `enum` 枚举值,
  `ipv4` IPv4 地址, `ipv6` IPv6 地址, `mask` IPv4 掩码, `port` 端口号, `keyword` 关键字), aggregate (`count` 个数, `sum` 总和,
  `min` 最小值, `max` 最大值), and without labels so far: Unicode form (`none`, `nfc`, `nfkc`), case (`sensitive`,
  `insensitive`), white space (`exact`, `trim`, `collapse`), uniqueness scope (`all`, `siblings`, `group`), catalog scope
  (`resolved`, `first_word`, `all`), pattern flags (`''`, `i`), pattern mode (`full`, `search`). Until then, please record this
  as an accepted deviation in the contracts README. An axis for the eight table semantics is welcome too. Register the
  sandbox codes if they should reach callers. Consider a `core.structure.out_of_range` code; numeric ranges currently report
  `core.structure.type_mismatch`. `catalog-entry@1` fits the catalog signatures the contracts README plans for node entry
  `data` (D06 R[3]).
- **refs**: run `hub/rules/quote-vectors.json` in the refs tests (by reading the file), so both quotation checks stay equal.
- **knowledge**: build the view with `createCatalogView(entries, { reference, complete, caseSensitive })` from tree nodes, or
  implement `CatalogView` (a view must not change after it is built: runCheck shares one entry list per view); `complete` must
  come from the knowledge declaration's completeness scope (C07 R[0]).
- **runs**: compose the subject the tables select from; call `runCheck`; an empty result means no check is installed: record
  the static terminal unchecked (`no_check`) and no verdict claim (V01 R[1], R[5]); map verdicts to terminals (V01 R[6]);
  apply negative-case expectations from `data.negative_case` and `data.expected`; turn `QUOTE_MISMATCH` into "not accepted";
  pass `context.pack` (required for pack functions), the extracted `packDir`, `sandbox.requireOsIsolation` from
  configuration, the declaration's `tier` and `basis` from `checks.json`, and an `onError` that writes the admin log.
  Outcomes are Hub boundary re-runs: record them as a new independent ground (A04 R[2]) with producer `function` and the
  interpreter or function id.
- **packs**: `tables/catalog.json` reads `$.commands`, which `functions/subject.ts` always sets: add `"required": true` so a
  subject without it is unknown instead of nothing to check. Every blocking table already names its basis.
- **platform/server**: call `stopAll()` from the SIGTERM and SIGINT handlers before exiting, and `sweepOrphans()` once at
  start; decide where `requireOsIsolation: false` may be configured (test harnesses only); optionally run `runSamples()` at
  start and refuse to serve when a sample fails (C05 R[0]).
- **CI**: the Linux runners lack `sandbox-exec`; sandbox-dependent acceptance either runs on macOS or explicitly opts out.

## quote@1: which sources the check reads

The interpreter asks the run's source view for the fragment a reference resolves to. The engine resolves, in order:

1. The references the boundary already parsed (top-level `quotes`, grounds, item locations) — resolved once at submit.
2. Any other reference the table reaches inside the judged slot data (for example `data.expected_quote`): the engine
   parses it with the boundary's own parser (hub/refs: parser@version, selector, character range) over a source bound
   to the run — the same code path, never a second parser. One reference is parsed once per evaluation; the declared
   reads' size cap applies to a whole-source fragment, and a retain-only source gives no text (含凭据，原文不可读).
   `src:` must name a run source; `tree:` must name the run's locked root. `rec:` must be bound to the run (including predecessor results) and resolve to a groundable result or Hub action/effect (B01 R[4]). Standalone `entry:` references cannot be grounds (B01 R[5]). Out-of-scope references refute with QUOTE_MISMATCH; decision 36 defines separate correction grades for non-groundable records and standalone entries. Resolutions are
   graded by `Unresolved.code`, never by message wording: REFERENCE_UNRESOLVED on a bound reference means
   no_fragment; SOURCE_UNAVAILABLE means unavailable. A resolved retain-only object stays retain_only; an otherwise
   readable object with no text has no_fragment.

### Graded outcomes

- 引用不在本运行范围内：驳回 QUOTE_MISMATCH，改引本运行绑定的输入。不能作根据、条目未写树地址及格式错误按决定 36 分别说明修正办法。
- 源文件绑定了但选择器解析不出片段（片段不存在）：驳回。
- 引文不逐字：驳回 QUOTE_MISMATCH。
- 不能作根据、缺树地址、引用写法不对、片段不存在或超过大小上限：分别按决定 36 的状态驳回，并给出修正办法。
- 只保留：未知，缺管理员接受来源的事实，请请求管理员接受，接受后自动重评。真正暂时取不回：未知，请重读再评。

### Why packs no longer need to copy a quote into the top-level quotes array

A quote that sits only in slot data is checked against the bound source anyway. Copying it into the top-level `quotes`
array remains useful: the boundary resolves those at submit and refuses a wrong reference earlier (a whole-submission
refusal with the exact position), before any check runs.

### The refutation code (settled)

「引用的源文件不是这次运行的输入」和「片段不存在」refute with QUOTE_MISMATCH — the message names the reason and
`data.why` distinguishes them. Settled: no new vocabulary codes. Every pack's repair rows already ride QUOTE_MISMATCH
and the model's fix has the same shape either way.


A pack-owned generation/read-back failure may return `unknown` with reason `output_failed` from a check. It is a valid
check outcome, not `check_error`: the requirement's static layer is incomplete and the item enters the incomplete
partition. Other model/submission-only reasons remain invalid as check outcomes.

## Bounded transient function retries

callPackFunction retries startup SANDBOX_UNAVAILABLE with queue_full, stopping or spawn_failed; engine callers alone
opt in to one wall-clock SANDBOX_TIMEOUT retry. CPU-limit timeouts are never retried.
There are at most three attempts, with 50 and 100 ms backoff. Every attempt keeps the caller's resolved timeout and
resource caps; no global limit is raised. Function defects, output limits, violations and missing OS isolation do not
retry. The parent-only onAttempt observer receives fixed codes, durations and backoff, never arguments or output.
A throwing observer cannot change execution. Retrying is centralized here: checks and subject builders do not multiply it.
stopAll invalidates outstanding calls by generation, so backoff cannot resurrect a cancelled child; independent later
calls can still start. Exhausted errors retain their existing conversion by runCheck; exit fields await hub-unknown-model.


Evaluation-scoped callPackFunctionBatch lifts a declared pure function over independent JSON inputs in one fresh isolated
child. The module is imported once, captures are kept per item, outputs/errors are ordered, and boundary violations remain
fatal to the physical batch even when caught. Per-item and aggregate JSON budgets are enforced without raising limits.
The engine falls back to original individual calls for aggregate failure and never falls back after stopping. The trusted
functionRunner binding only replaces parent execution; every runCheck output still receives the same schema/namespace/tier
validation. Neither callback nor batch mode is supplied by pack JSON or an MCP client. No module process survives an eval.

Timeout retry scope: only engine checks and subject builders opt in, only wall-clock timeouts and at most once.
CPU-limit failures and other callers (knowledge, connectors and projections) keep a single timeout attempt; their own
split/timeout policies apply. Startup failures keep the bounded backoff. Declared maximum-limit escalation awaits the model.

SourceView.unread optionally preserves a typed fragment read failure alongside the legacy why grade. Retain-only quotes
wait for administrator acceptance (awaiting_step), storing generated credential_unreadable as the source-specific reason
inside unread_sources, with missing_fact/next_action. The public CheckOutcome.reason stays within its generated axis.

Synchronous spawn throws and asynchronous startup error events preserve errno and the original message in private
SandboxError.detail. The public SandboxError.message remains fixed, onAttempt keeps only bounded control metadata,
and check outcomes retain only the existing public-detail allowlist; free-text startup causes reach administrator logs only.

### Fragment read vocabulary

`SourceView.why`, the engine's fragment cache and its warmed grades use the generated `FragmentRead` type from the
model's T04 `fragment_read` axis. Resolution state, unknown reason and read tier keep their own meanings; none is used
as a substitute for the fragment read state. Authority and the refined grades are recorded in [progress decision 36](../../docs/hub-r4-progress.md).

The boundary applies B01 R[4] to quotation references and grounds, including cross-item grounds. Record targets and locations remain resolvable without being promoted to grounds. Its cache separates those uses.

片段读取 integrity_unproven 沿用原因轴同码标签“完整性未证明”（决定 36 的模型负责人补充）。
这类未知须由管理员从可信备份恢复记录或原始字节后重新核验；unavailable 只表示暂时读取故障。

Scope note: the owner authorized the rules implementation/tests and this README beyond the original vectors-only task list. Architecture permits only refs type imports; the first runtime delegation was a defect, corrected by a local implementation.

QuoteTable in contracts/src/tables.ts and the regenerated quote.v1.schema.json describe the same exact contiguous
substring contract as the independent rules and refs implementations.

### Independent Linux isolation review

Antigravity independently reviewed the fixed implementation at `ab2ec6c6` and found the two earlier blockers addressed:
all-thread descendant accounting and per-child kernel isolation attestation. This was a source review, not production
proof. The policy administrator remains trusted; stop the Hub and drain children before replacing an AppArmor policy.

### Windows：复用 Circle 的进程清理设计，隔离缺口保持关闭

来源：决定 79；Circle `src/sandbox.ts`、`src/windows_stranded.ts`、`src/process_group.ts` 及对应测试，
查阅源码版本 `25863be04d2b169b5d776d7ec21a76ccbd330738`。Circle 的代码为 Apache-2.0，
Copyright (c) 2026 qingshanfeihu and the Circle contributors，源项目 https://github.com/circle-platforms/circle。
本次适配保留来源与许可证声明，没有导入或修改 Circle 或冻结归档。

Circle 的路径/命令审批、凭据名过滤和环境过滤属于客户端策略；Windows `taskkill /T /F` 及 Job/进程树
扫描用于清理。它们没有给 Hub 提供内核禁网、禁写。Circle 的 Job 分配失败可退回进程表扫描；
Hub 适配不作这种降级：Job 创建、清理策略、分配、状态读取或终止失败均向调用方报错。
`windows.ts` 延迟加载并严格核对 koffi 3.3.3，通过 Windows KnownDLL `kernel32.dll` 加载内核接口，
不读取 SystemRoot 或从环境拼接 DLL 路径，版本不匹配在 DLL 加载前拒绝；使用 kernel32 Job，结束整个 Job 后等待活动计数为零，
并保留同一次终止 Promise；关闭句柄时的 kill-on-close 是额外清理措施。该模块目前是待集成原语，
没有用它运行 pack。进程启动后才分配 Job 可能漏掉启动阶段已创建的子进程，因此调用方只能附加
仍在等待可信握手的 bootstrap；未来需要在不运行 pack 的前提下完成分配和验证。

Windows 探测明确返回 `windows_kernel_network_write_isolation_unimplemented`，pack 调用始终返回
`SANDBOX_UNAVAILABLE`，即使传 `requireOsIsolation: false` 也拒绝。命令构造同样拒绝 Windows，
不会错误调用 `/bin/sh` 或以 JavaScript 限制冒充完整隔离。仍缺少内核网络/写入隔离后端与逐子进程验证、
CPU 限制、Job 内存边界/测量及生产生命周期接线。没有宣称 Windows 与 macOS/Linux 安全等同。

合成验收位于 `windows.test.ts`：Job 分配拒绝、并发终止等待、状态不可读、Windows opt-out
仍拒绝、原生 Node 子孙进程实际退出，以及 KnownDLL 加载和错误 koffi 版本的拒绝。
集成者于 2026-10-28 提供 GitHub 原生运行回执：公开固定提交 `bac907e`，运行 `40637922550`，
Windows x64 和 ARM64 的该文件分别 7/7、0 跳过。这是集成者提供的固定运行结果，本分支代理没有访问
GitHub 或独立重跑；回执没有给出本次类型检查结果，不能据此宣称类型检查通过。
它仅证明这组合成 Job 清理及拒绝用例，不证明内核禁网、禁写、CPU/内存边界，也不证明 Windows pack
可执行或与其他平台安全等同。本机测试与类型检查仍未运行。

下一阶段的候选设计是 AppContainer/受限令牌启动与 Job 配合，尚未实现或批准为等效隔离。
先完成以下验证再决定接线，不能用 Job 成员身份代替其中任一证据：

1. 启动边界：使用原生挂起创建进程，在恢复主线程前验证受限令牌、绑定 Job 和所有限制；
   继承句柄仅限协议管道，pack 在每次启动验证前不可加载。失败则终止并等待退出，再关闭所有句柄。
2. 网络/写入边界：无网络能力的令牌与逐调用文件访问设计必须以实际内核拒绝验证；
   AppContainer 私有存储、临时目录、用户已授权目录、重解析点和命名管道都是必须查清的边界，
   不能因为没有授予普通目录写权限就宣称“全局禁写”。Node permission 和 JS lockdown 继续作为额外防线。
3. 资源与生命周期：Job CPU 总时间、整个 Job 的内存上限与测量、禁止 breakaway、父进程退出清理，
   必须分别有超限/异常反例；查询失败不得按零资源消耗处理。
4. 原生攻击合成：以真正监听的 TCP/UDP 与本地 IPC、父进程可写但 pack 不可写的临时目录，
   验证连接和同步/异步写入被拒绝；覆盖启动前后派生进程、中间父进程退出、父 Hub 异常退出、
   任意限制设置失败。x64 和 ARM64 分别记录结果、架构与跳过。所有资源均为临时合成资源。

若候选设计不能满足全局禁写或禁网，探测必须继续返回不可用；不能静默放宽 Hub 的隔离契约。

#### Windows 原生后端的分层实施

所有者后续明确要求保留 pack 禁网、禁写、禁止启动其他程序；Circle 审批和 Job 均不能替代这些边界。
设计顺序为：无网络能力的 LPAC、仅限制写访问的受限令牌、STARTUPINFOEX 子进程禁止策略与继承句柄
白名单、挂起创建进程、Job 绑定/限制及令牌核验、恢复线程、逐调用内核反例验证、最后加载 pack。
受限 SID 的选择、LPAC 与受限令牌组合、Node 启动所需只读权限仍待原生验证，不能把此设计当实现结果。
Microsoft 说明受限 SID 引入第二次访问检查，且子进程禁止策略依赖隔离应用不泄漏高权限进程句柄：
[Restricted Tokens](https://learn.microsoft.com/en-us/windows/win32/secauthz/restricted-tokens)、
[UpdateProcThreadAttribute](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)。

已增加可独立验收的 Job 资源设置原语（尚未接 pack）：整个 Job 的用户态 CPU 时间与整个 Job 的
已提交虚拟内存上限，设置失败关闭句柄并拒绝；无 breakaway 标志。两者分别不是总 CPU 时间和 RSS，
不能冒充 Hub 现有计量语义。[Job 基本限制](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information)
与[扩展限制](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information)
给出其范围。新增 CPU 忙循环和虚拟内存提交前后对照的原生合成用例，尚未执行。

远端验证顺序（x64、ARM64 各自执行、逐层记录结果）：加载器/版本及失败注入；Job CPU/提交内存；
受限令牌/LPAC 自省；挂起启动前的策略与句柄核验；真实监听 TCP/UDP/本地 IPC 拒绝、文件写删重命名
拒绝和 Node/cmd 启动拒绝；父进程退出与子孙清理；最后再测成功和恶意 pack。
当前仅前两层有待测代码；后续层未实现，pack 入口继续拒绝。

集成者提供的后续原生回执（2026-10-28）：公开固定 `ce7ba265`，GitHub 运行 `40638643465`，
Windows x64 与 ARM64 的 Job 限额文件分别 12/12、0 跳过。该回执覆盖用户态 CPU 和 committed memory
用例，不能证明总 CPU/RSS 或禁网、禁写、防启动。整体 job 仍因 Windows readiness 门失败，
不得将测试文件通过写作整个 CI 通过。本分支代理没有访问该运行或本机重跑。

受限令牌原语已补入 `windows.ts`，仍未接 pack 或创建子进程：只读取当前进程的 Windows token，
使用 `DISABLE_MAX_PRIVILEGE | WRITE_RESTRICTED` 与单个 NULL SID，随后检查派生 token 真实限制 SID
恰为该 SID；不能以 `TokenHasRestrictions` 或一次 API 成功替代核验。仅使用 KnownDLL 与固定 koffi，
失败路径释放句柄/SID；不登录、不提权、不模拟线程、不读取凭据库。
参考 [CreateRestrictedToken](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-createrestrictedtoken)
和 [GetTokenInformation](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-gettokeninformation)。
新增合成故障注入与原生 SID 自省用例尚未运行；NULL SID 在目标 Windows 的写拒绝效果、派生后的
令牌组合、LPAC、启动与网络限制仍须后续原生行为验证。此原语本身不构成完整禁写或防逃逸保证。

集成者提供的令牌+Job 原生回执（2026-10-28）：公开固定 `f066e779`、运行 `40639445472`，
x64 与 ARM64 文件各 16/16、0 跳过；整体仍因 Windows 未支持门禁失败。本回执仅证明已有 Job 与
令牌自省，不证明实际禁网/禁写/防启动，也不覆盖后续 LPAC 启动代码。本分支代理未独立读取该运行。

LPAC 挂起启动候选已作为独立可信探针实现，仍未接 pack：从内核返回的 System32 绝对路径加载
userenv（不假定 userenv 是 KnownDLL，不读 SystemRoot），派生 AppContainer SID；配置零 capabilities、
ALL_APPLICATION_PACKAGES opt-out、禁止子进程与 Win32k 禁用属性；使用现有 write-restricted token，
无 shell、无继承句柄、空环境，以 CREATE_SUSPENDED 创建当前 Node。在恢复前核对 LPAC、AppContainer
SID、空 capabilities、child-process 标志、派生写限制 SID，绑定限额 Job，恢复后观察退出，失败终止并
确认退出。探针不修改系统 ACL、不创建登录会话；使用唯一临时 AppContainer profile，并在子进程退出后删除本次创建的身份。
依据 [Microsoft LPAC 启动示例](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)
与 [DeriveAppContainerSidFromAppContainerName](https://learn.microsoft.com/en-us/windows/win32/api/userenv/nf-userenv-deriveappcontainersidfromappcontainername)。

新增原生用例要求：Node 正常退出；真正监听的本地 TCP 与绑定的 UDP 无连接/收包；临时文件创建、
覆盖、删除、重命名、建目录均返回权限拒绝，原文件保持；无 Node permission flags 时也不能启动另一个
Node。另有 argv 引号/末尾反斜杠/NUL 用例。新增 6 例未运行，旧 16/16 不覆盖。此候选可能因 Node
所在目录缺少 LPAC 只读执行授权，或令牌组合不支持而拒绝启动；遇到这些情况必须保持拒绝并记录原生
错误，不能退回普通进程。尚缺：只读资源授权、协议管道、每调用验证、更多 IPC/异步写反例与 pack 接线。
因此新代码仍不是 Windows 生产可用证据，readiness 与 pack 入口继续失败关闭。


LPAC 第一轮原生运行 `df7e1cc` / `40640246103`（集成者回执及本机保存的 runner 日志）：双架构
各 17 通过、5 失败、0 跳过；5 例均在挂起创建报 Win32 2，未到安全断言。静态复核发现只派生 SID、
未创建 profile，遗漏 Microsoft 启动流程中的创建步骤；这与失败一致，但尚不能定为唯一运行根因。
修复改为每次唯一临时 profile，已有同名明确失败，不复用、不删除；创建成功才允许清理该身份。
参数仍为显式 UTF-16/NUL、STARTUPINFOEXW112、挂起/扩展/Unicode/无窗口标志，未去掉任何 OS 属性。
增加父侧路径存在/可识别二进制/工作目录存在的布尔预检，失败日志只列固定阶段、数字错误码和这些布尔，
不含路径、账户、SID、令牌、源代码或环境。profile 删除或其他回滚失败均拒绝并披露清理未知，且保留
启动阶段错误。原 5 项安全断言完整保留，尚待双架构复测；当前没有 LPAC 成功证据。
