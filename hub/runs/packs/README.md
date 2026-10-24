# runs-packs: the pack registry

Publish, validate, assign, activate, withdraw and load task packs. Model elements: T01 (task pack), T02 (publish record and
publish check), W02 (requirement templates), W03 (workflow and product binding), W05 (slots), C05 (rules with samples), C07
(catalogs a workflow requires), B04 (authorizations), A03 (source roles of checks). This is the first half of the runs
package; the run engine (`hub/runs/engine`) consumes it only through `hub/ports.ts`. Other packages import from
`hub/runs/api.ts`.

## What is here

| File | Content |
| --- | --- |
| `directory.ts` | `readPackDirectory(dir, { limits })`: every file with its SHA-256, checked against `pack.json` exactly; `manifestDigest` |
| `validate.ts` | `validatePack(pack, { policy })`: the declaration files of the pack's kind with their contract shapes, then the rules across files; `closedSetsOf`, `effectiveTier`, `isKnownCode`, `versionProblems` |
| `imports.ts` | `scanFunctions`: the static scan of the modules declared functions reach (imports, exports, module format, syntax Node cannot strip); `SANDBOX_IMPORT_POLICY` |
| `samples.ts` | `runPublishCheck`, `refusalsOf`, `sampleDifferences`: the publish check (T02) |
| `marks.ts` | `sampleMarks` (the author-only rule) and `publishCheckMarks(loadedWorkflow)`: each check's marks (T02 R[1]) for a run, from the version's samples; contracts only |
| `registry.ts` | `createPackRegistry({ records, extractDir, now, sandbox, limits, policy, onError, onTamper })` |
| `extract.ts`, `tree.ts` | read-only extraction under `<extractDir>/<digest>`, verification, quarantine, staging for the publish check |
| `load.ts` | declarations of published versions from verified bytes; `readJson` of a loaded pack; `PackFileError` |
| `ports.ts` | `createPacksPort`, `createWorkflowStore`, `createPackCatalog` (the ports of `hub/ports.ts`), `boundProducts`, `packSummary` |
| `versions.ts` | `compareVersions` (semantic version order), `isCanonicalVersion`, `parsePackRef`, `MAX_PACK_REF_LENGTH` |
| `problems.ts`, `types.ts` | problems for pack authors (Chinese, with file, field and fix) and the shared types |
| `testing/builder.ts` | pack builder for tests: `writePack`, `signPack`, `corruptByte`, `workflowPack`, `productPack`, `systemPack`, `editJson`, `withFiles` |
| `testing/setup.ts` | `openPackTestbed({ postgres })`: records kit, admin, users with and without a publish right, a registry |

## Publishing

`registry.publish(owner, directory)` returns `{ ok: true, created, version, report }` or `{ ok: false, problems, report }`;
nothing is half published. In order:

1. The account is re-read (absent or disabled: `publish.account`) and must hold an active publish right (`publish.no_right`).
2. The directory is read (`readPackDirectory`). The pack digest is the SHA-256 of the RFC 8785 canonical JSON of the manifest,
   so the formatting of `pack.json` does not matter and any changed byte of a file changes the digest through its SHA-256.
3. The owner of a pack id is the subject of its first publication; anyone else is refused (`publish.not_owner`). A version
   number is used once: the same content again is the same publication (`created: false`), other content is
   `publish.version_reused`, a withdrawn version is `publish.version_withdrawn`, any earlier decision about `id@x.y.z` refuses
   it too. The kind of a pack id never changes (`publish.kind_changed`).
4. `validatePack`, then the publish check. Function samples run in the sandbox against a read-only tree staged under the
   extraction directory, promoted to `<extractDir>/<digest>` once the version is published. A version no reference can name
   (`id@x.y.z` longer than 100 characters) is refused here at the latest, before anything is written.
5. Every file is stored as a content-addressed object, and so are the canonical manifest bytes (their object name is the
   pack digest). A `pack_version@1` record holds `{ pack, version, kind, digest, title, description, manifest, publisher,
   report }` (index keys `pack.id`, `pack.version`, `pack.digest`, `pack.kind`), and then `Authorizations.grant` records the
   publication bound to the pack digest. The record comes first and the publication last: a version is visible exactly when
   its publication commits; a record without a publication (a refused grant) is never shown and is reused by a retry.
6. A version of an active product pack must claim no product line id and no name that another active product pack claims
   in any version that is not withdrawn (decision 6); it is checked before step 5 and again after it.

## Validation rules

Problems carry `rule` (an identifier of this validator, for tests and tools; not a protocol code), `file`, `field` (an RFC
6901 pointer into a JSON file) or `line` (code files), a Chinese `message` and a Chinese `fix`. Contract shapes are applied
first (`*.shape` rules; the detail of a zod issue is the contract's English message inside a Chinese frame).

| Rule | What it checks |
| --- | --- |
| `directory.*`, `manifest.*` | no links (symbolic, or a file with more than one hard link: `directory.hardlink`) or special files (also a link where a listed file should be), directories only where packs keep files, legal paths (`packPathProblem`), no two paths that differ only in case at some level (`manifest.case_collision`: one name on a case-insensitive volume), every listed file present once with its size and SHA-256, nothing unlisted, size caps (over the total or the count cap nothing is read), a canonical version spelling and `id@x.y.z` at most 100 characters (`manifest.version`), declaration files of the pack's own kind only |
| `file.json` (`manifest.json` for pack.json) | UTF-8 JSON that canonical JSON (RFC 8785, I-JSON) can hold: no lone surrogate in a string or member name, no number outside the double range, at most 256 levels of nesting |
| `file.credential` | no file and no manifest title or description in which the records credential scanner finds a credential; the problem names the file and the line, never the text |
| `requirements.unknown_check`, `requirements.duplicate_check` | every check a requirement lists exists in checks.json, once |
| `checks.table_place`, `checks.table_missing`, `file.json`, `checks.table_admission`, `checks.interpreter_missing` | a check's table is under `tables/` or `policies/`, exists, is JSON and is admitted by the interpreter (`validateTable` of hub/rules); the interpreter is installed |
| `checks.catalog_undeclared`, `checks.catalog_missing` | a check consults only a catalog the workflow requires (`workflow.product.catalogs` or `knowledge.json`); an interpreter whose table names a catalog (catalog@1) has `catalog` in checks.json, since a run binds a catalog only to such a check |
| `checks.set_unknown` | a `{ name }` closed set of a table (membership@1 `set`, coverage@1 `required`) is one slots.schema.json declares (`closedSetsOf`) |
| `checks.blocking_without_basis` | a blocking check names its contract clause (C05 R[1]) |
| `functions.*` | every PackFunctionRef (workflow `projection` and `expected_sources`; check `function` and `subject`; product `sync.plan`, `select_build`, producer functions; system `reads[].plan` and `reads[].project`) names a module of the pack whose reachable imports the sandbox admits and which exports the named function; every reachable `.ts`/`.js` module is an ES module as Node detects it (`functions.module_format`); `getBuiltinModule` only as a direct call with a literal name; code too deeply nested to parse is refused (`functions.syntax`) |
| `slots.missing_entry`, `slots.wrong_target`, `slots.independent_entry`, `slots.fact_entry`, `slots.unknown_requirement` | a judgment requirement has a slot entry under `item` or `run` by its target (an independent judgment too), a fact requirement has none, every entry belongs to a requirement |
| `slots.code_overlap` | the codes of a run-level requirement identify it alone: disjoint from the other run-level requirements and from the item-level codes |
| `workflow.shape` (subject), `workflow.duplicate_catalog`, `knowledge.duplicate_catalog`, `workflow.product_id` | the subject slot exists; required catalogs are versioned ids, listed once; `product.id` is a product line id |
| `samples.*` | samples sit in `samples/positive/` or `samples/negative/` as `pack-sample@1` JSON with unique ids, exercise a declared check, expect at least one outcome, never abstain; a positive sample expects support only, a negative one at least one refutation; a sample carries a catalog only for a check that declares one (`samples.catalog_unused`); only workflow packs have samples |
| `publish.sample_failed`, `publish.unsampled` | (the publish check) every sample gives what it expects; every check, blocking or advisory, has a positive and a negative sample (C05 R[0], T02 R[0]) |
| `requirements.unknown_code` | error handling rows and expected-outcome codes are `*`, a core violation code, a protocol code or a pack code `<pack id>.<code>` |
| `skill.empty`, `skill.encoding` | SKILL.md is non-empty UTF-8 |
| `product.name_space`, `system.shape`, `product.shape` | product names without surrounding white space; system.json and product.json follow `system@1` and `product@1` |
| `product.id_collision`, `product.name_collision`, `publish.withdrawn` | (publication of a version of an active product pack) decision 6 |

Warnings (never refusals): `checks.unused` (a check no requirement lists), `requirements.code_unused` (a core code no check of
the requirement can give), `requirements.reject_scope` (a `reject` row on a requirement without a blocking check on the
artifact under verification, W02 F[7]), `publish.author_samples_only`.

## Decisions

1. **The static import scan mirrors the sandbox.** `SANDBOX_IMPORT_POLICY` is a copy of the sandbox's pure builtins and
   declared packages (`hub/rules/sandbox/policy.ts`, not exported by `hub/rules/api.ts`). `imports.test.ts` runs every Node
   builtin and a set of packages through `callPackFunction` and fails when the copy and the sandbox disagree. The scan follows
   only modules reachable from the declared functions (test files next to them are never loaded, so their imports do not
   matter), uses the TypeScript parser (a declared dependency, loaded on first use), and treats as type-only exactly what
   Node's type stripping erases (`import type`, `export type`; an import whose specifiers are all inline `type` ones is still
   loaded), which `imports.test.ts` pins against `module.stripTypeScriptTypes`. It refuses computed dynamic imports, URLs,
   absolute and `#` specifiers, imports that leave the pack or name a file not in the manifest (with a hint for a missing
   extension), JSON imports without `with { type: 'json' }` (static, or dynamic with the options written as literals), any
   use of `getBuiltinModule` but a direct call with a literal name (property or element access; a computed name, a kept
   reference or destructuring is refused like a computed import), `process.getBuiltinModule` of an impure builtin, and the
   syntax Node cannot strip (enum, namespaces with values, constructor parameter properties, `import =`, `export =`,
   `import defer`). The sandbox admits ES modules only, and Node detects the format of a `.ts` or `.js` file from its code
   after type stripping: a reachable module with no import or export declaration, exported value, `import.meta`, top-level
   await or top-level lexical declaration of a CommonJS wrapper name is loaded as CommonJS, so the scan refuses it with the
   fix `export {};` (`.mts`, `.mjs` are always ES modules). `imports.test.ts` pins 23 module shapes and 7 JSON imports
   against the sandbox. Syntax errors come from TypeScript's parse diagnostics (read defensively; not part of its public
   typings); its parser recurses per nesting level (about 1000 nested parentheses overflow the stack), and a module it
   cannot parse is refused as `functions.syntax`, never thrown.
2. **Publish check.** Each sample runs through `runCheck` with the declared check (interpreter or function, tier, basis), its
   table, `sample.subject`, `sample.sources` (as `sourcesFrom` and as `sourceTexts`), `sample.catalog` built with `buildCatalog`
   (the CatalogSpec of hub/rules) only when the check declares `catalog` (as a run binds one, `hub/runs/engine/evaluate.ts`)
   and the context a run gives the check: `pack` = the pack id, `requirement` = the first
   requirement that lists the check, `sets` = `closedSetsOf(slots)`, named `<requirement>.codes` and `<requirement>.ranks`
   (the run engine uses the same names in `hub/runs/engine/evaluate.ts`). The outcomes are compared in order with every field the expectation
   names. A check is marked `author_samples_only` when no sample comes from outside its author (none at all included,
   `sampleMarks`). Every check without a positive or a negative sample refuses the publication, whatever its tier (C05 R[0]:
   every rule carries positive and negative samples, run at admission; T02 R[0]): an advisory check that is never exercised
   would stay unknown in every run if it is misconfigured.
3. **Publication state** of every version comes from the owner's publish decisions in one query (the rule of
   `Authorizations.isPublished`: the owner's latest decision for `id@x.y.z`, not revoked, not expired, bound to the content);
   the version selected for use (`resolve`, behind `forUser` and `PacksPort.pack`) is confirmed with `isPublished` itself.
   Withdrawn versions stay readable by digest (`byDigest`, `open`) so that existing runs can be read and finished.
4. **Versions** follow semantic version order (segments compared as integers of any length); a version with a leading zero
   is refused so that each number has one spelling, and `id@x.y.z` may have at most 100 characters (`MAX_PACK_REF_LENGTH`,
   what `parsePackRef` names; records terms take 300, index values 1000 bytes), so every published version can be found
   (`manifest.version`, `versionProblems`).
5. **Assignment** is an admin decision on a pack id, for workflow packs only: a system pack is refused (T01 R[3]), a product
   pack is refused with the fix to activate it, an unknown pack id is refused. Assigning to `WHOLE_HUB` is activation.
   **Withdrawal** (`retire`) is an admin decision too (R01 R[1], T02 R[4]: the owner publishes, the admin assigns and
   withdraws); the right is checked first, so to anyone else an absent version and a forbidden one give the same AccessError.
6. **Activation** of a product pack is an assignment to `WHOLE_HUB` (B04). Only product packs with a usable version. No two
   active product packs claim one product line id or one name (NFC, lower case, as ProductDeclaration compares them), and
   since withdrawing the version in use falls back to the next version that is not withdrawn, every such version counts:
   activation compares every version of the pack that is not withdrawn with every such version of the other active product
   packs, and so does the publication of a version of an active product pack (whatever its number). A message names the
   colliding versions (`id@x.y.z`, an old one marked as such) and the fix. Withdrawing the version in use of an active product
   pack is refused when the version taking its place collides with what another active product pack uses (possible only in
   a state reached around the registry); the fix is to deactivate one of them first. The lookups by name and by line id
   (`productNamed`, `productWithId`, behind `PacksPort.productByName` and `productById`) answer null when several active
   packs match, and report it to `onError` (context `packs.product_ambiguous`), never picking one. In one process activation
   and product publication are serialized by a lock; across processes (a console or CLI beside the server) the check runs
   again after the decision, which is undone on a collision: an activation is revoked, a publication withdrawn (its version
   number stays used, `publish.withdrawn`). Of two racing colliding decisions at least one sees the other, so they never
   both stay; both may be undone.
7. **Extraction**: `<extractDir>/<digest>`, directories 0500 and files 0400, `pack.json` written as the canonical manifest
   (its SHA-256 is the digest). A tree is written under `.tmp-<digest>-<random>` and renamed into place; a rename onto an
   existing tree (ENOTEMPTY, EEXIST, or EACCES on macOS for a read-only directory) means another writer won, and that tree is
   verified instead. Every use verifies every file (size, SHA-256, mode, one link, nothing extra, no links); a tree that does
   not match is moved to `.quarantine/` (kept for inspection), reported to `onTamper` and rebuilt from the verified objects.
   One build per digest at a time in a process.
8. **Ports.** Every call re-reads the account (absent or disabled: null or empty; the role stored now, not the one in the
   Principal). `WorkflowStore.forUser` needs the pack assigned to the caller, admins included; absent, unassigned, withdrawn,
   unknown, malformed and other kinds give the same `null`. `summaries` lists the newest usable version of every assigned
   workflow pack; `products` are the names of the bound lines, `repair_rounds` the most rounds any repair row allows.
   `PacksPort` shows workflow and system packs by reference and product packs only while active; `readableProducts` is the
   lines bound by the assigned workflow packs (`product.id`, else every active product pack offering every required catalog),
   and every active line for admins. `PackCatalogPort` lists for a user the newest usable version of each assigned workflow
   pack, for an admin every published version with owner, digest, withdrawal, samples by source, assignments (workflow
   packs) and `active` (true for the version in use of an active product pack).
9. **LoadedWorkflow** gets its own copies of the declarations (parsed once per digest from verified objects); `readJson`
   reads only a file the manifest lists (or `pack.json`), as a regular file of the extracted tree, and checks its SHA-256 on
   every read: not in the pack or not JSON is `PackFileError`, a changed file `IntegrityError`.
10. **Records written**: `pack_version@1` (provenance `declared`), objects for every file, publications and activations
    through `Authorizations`. Nothing is updated or deleted.
11. **Reading a pack directory** trusts nothing between the walk and the read: every open is `O_NOFOLLOW | O_NONBLOCK` (a
    pipe swapped in never blocks a thread), the handle must be the regular file the walk saw (device, inode, one link), and
    after the read its path must still be its own real path (a directory on the way swapped for a link is refused). Over
    the total or the count cap nothing is read. Messages state what the manifest declares, never the SHA-256 or size of
    what was found, so a mismatch reveals nothing about a file the publisher could not read.
12. **Credentials** never enter through a pack (brief, section 2: secrets enter only through the vault): `validatePack`
    runs the records scanner (`scanForCredentials`) over every file and over the manifest's title and description, and
    refuses any finding by file and line (at most five per file are listed).
13. **Marks for runs** (T02 R[1], R[6]). The publish report keeps each check's marks (`report.checks[].marks`) and the
    registry each version's withdrawal (`byDigest(digest).withdrawn`, `withdrawn_at`); `LoadedWorkflow` carries neither (see
    Needs). `publishCheckMarks(loadedWorkflow)` gives a run the marks from the version's own sample files through `readJson`,
    equal to the stored report's; a withdrawal shows through the ports as `WorkflowStore.byDigest(d)` answering while
    `PacksPort.pack('id@x.y.z')` is null.

## Limits

- Locks are per process. Across processes colliding product decisions are caught by the check after the decision and
  undone (decision 6), so two racing ones may both be undone (measured with two registries on one database: in 19 of 20
  rounds both activations were revoked); a database lock would let one win (Needs).
- A pack directory is read through paths, not through directory handles (Node has no `openat`): the checks of decision 11
  narrow the window between the walk and the read but cannot close every interleaving of swaps. What remains is bounded by
  the manifest: a file is published only under the SHA-256 the manifest lists, and no message tells the publisher the
  digest or size of a file they could not read themselves.
- Crashed extractions leave `.tmp-*` directories, and quarantined trees stay in `.quarantine/`; neither is swept.
- Duplicate keys inside a JSON file are not detected (the last one wins, as in JSON.parse).
- Determinism of pack functions is the pack's contract (C08 R[2]); it is not checked here.
- The parsed records and declarations are cached per registry without bound (content-addressed, so never stale); the number
  of pack versions is expected to be small.

## How to test

```sh
node --test "hub/runs/packs/**/*.test.ts"
npx tsc --noEmit
```

The tests build their own synthetic packs in temporary directories (`testing/builder.ts`), start one temporary PostgreSQL per
test file (`hub/testing/postgres.ts`) for the registry and port tests, and run pack functions in the real sandbox (with
`requireOsIsolation: false`, so they also run where `sandbox-exec` is missing; on macOS it is used).

## Deviations

- Rules beyond the brief's list, all refusals a pack author can fix: a canonical version spelling and a version short enough
  to be named, sample folder semantics (positive expects support only, negative at least one refutation), declaration files
  of another kind, product names with surrounding white space, a check consulting an undeclared catalog, a catalog@1 check
  without `catalog`, a sample catalog for a check without one, a table naming an undeclared closed set, a blocking check
  without a basis, product packs not assignable to single users, hard links, paths differing only in case, JSON canonical
  JSON cannot hold (with a nesting cap of 256), helper modules Node would load as CommonJS. The W02 F[7] rule for `reject`
  rows is only a warning.
- No two active product packs claim one name or line id in any version that is not withdrawn: stricter than "in the
  versions in use", because a withdrawal (an admin's safety action, T02 R[5]) would otherwise be able to create the
  collision without any check.
- The undo of a product publication that collided with a racing decision in another process (decision 6) is a
  withdrawal decided by the publishing owner inside their own publish call (records allows the owner to revoke their
  publication); every other withdrawal is the admin's.
- "A run-level judgment requirement's codes are disjoint from the others" is read as: from the other run-level requirements
  (also guaranteed by `slots@1`) and from every item-level code.
- System packs are validated with `system@1` (contracts/src/resources.ts) and their read functions are scanned like the
  others.

## Needs from other packages

- **rules**: export the sandbox import policy (`PURE_BUILTINS`, `DECLARED_DEPENDENCIES` of `sandbox/policy.ts`) from
  `hub/rules/api.ts`, so `SANDBOX_IMPORT_POLICY` can be the sandbox's own list instead of a copy pinned by a test.
- **contracts**: register a zod schema for `pack_version@1` in `SCHEMA_REGISTRY` (the shape is `PackVersionBody` in
  `types.ts`); and a convention for the names of `CheckContext.sets` (this package uses `<requirement>.codes` and
  `<requirement>.ranks`, `closedSetsOf`).
- **runs-engine**: keep building `CheckContext` as it does now (`pack`, the first requirement listing the check, `sets`
  named `<key>.codes` / `<key>.ranks`, as `closedSetsOf` does) and binding a catalog only to a check that declares
  `catalog`, so that samples judge exactly as runs do; tell runs-packs if that changes. Read frozen runs with
  `WorkflowStore.byDigest`. T02 R[1]: mark what rests on a check with only author samples with `author_samples_only`
  (`publishCheckMarks(workflow)` gives check id -> marks; `hub/runs/packs/marks.ts` imports only contracts, so the engine
  can import it directly instead of through `hub/runs/api.ts`, which re-exports the engine). T02 R[6]:
  conclusions of a withdrawn version show `rule_withdrawn` (validity_status); withdrawn is `WorkflowStore.byDigest(d)`
  answering while `PacksPort.pack('<id>@<version>')` is null.
- **ports owner (integrator), for runs-engine**: `LoadedWorkflow` (hub/ports.ts) cannot carry what T02 R[1] and R[6] need
  on conclusions. Request: `LoadedWorkflow.marks: Readonly<Record<string, QualifierMark[]>>` (check id -> the marks of the
  stored publish report) and `LoadedWorkflow.withdrawn_at: string | null` (null while the version is published), or
  `WorkflowStore.status(digest): Promise<{ withdrawn_at: string | null; marks: Record<string, QualifierMark[]> } | null>`.
  runs-packs provides either at once (`PackVersionInfo.report.checks[].marks`, `withdrawn_at`); until then the derivation
  above holds.
- **records**: (1) a transaction-scoped named lock (`pg_advisory_xact_lock`) that a caller can hold around a read and a
  decision, for example `RecordStore.withLock(name, fn)` plus a `tx` parameter on `Authorizations.grant` and `revoke`, so
  that activation and product publication are serialized across Hub processes and one of two racing decisions wins instead
  of both being undone. (2) The comment of `hub/records/authorizations.ts` cites R01 R[1] for "the owner or an admin"
  withdraws; R01 R[1] names the admin only. Please keep the owner's revoke of their own publication until (1) exists: the
  registry undoes a colliding product publication with it (Deviations).
  `hub/runs/api.ts` (owned by runs-packs) re-exports `hub/runs/engine/api.ts` whole (`export *`), so a name the engine adds
  there is public at once; a name that collides with one of this package's explicit exports would be shadowed, so please
  keep the names apart.
- **server**: create one registry, `createPackRegistry({ records: kit, extractDir: <data dir>/packs, sandbox: { requireOsIsolation:
  true }, onError, onTamper })`, and the three ports from it; log `onError` (including `packs.product_ambiguous`) and
  `onTamper` to the admin log; offer publish (owner), assign, unassign, activate, deactivate and retire (admin) on the
  console or CLI.
- **packs**: every check needs a positive and a negative sample, advisory ones too; a catalog@1 check needs `catalog` in
  checks.json; `{ name }` sets must be declared in slots.schema.json; a helper module needs ES module syntax (`export {};`);
  no credential-like text in any file.
- **platform**: the extraction directory is derived data (rebuilt from the objects); it can stay out of backups.

## Open questions

- Should admins use workflow packs without being assigned them? Here they need an assignment like everyone else.
- Should the W02 F[7] `reject` rule refuse instead of warn?
- A withdrawal that would put a colliding version in use is refused with the fix to deactivate first. Should it instead
  deactivate the pack itself as part of the admin's decision?

## 本地工具的发布与下发

发布时从 tools/ 的每个代码文件出发，复用模块扫描器核对它及其相对导入的模块：ES 模块、Node 可擦除的 TypeScript 语法、仅清单内文件及 Node 内置模块。代码文件是 `.ts`、`.mts`、`.js`、`.mjs`。`.cjs` 和 `.cts` 直接拒绝。第三方包、包外路径、CommonJS、`createRequire`、`getBuiltinModule('module')` 和无法静态核对的动态导入被拒，问题用 tools.*，带文件、行和修正动作；脚本无需导出函数。此政策允许全部 Node 内置模块，区别于 SANDBOX_IMPORT_POLICY 的纯计算限制：本地工具会在客户端读写文件，不在 Hub 沙箱中运行。`import { builtinModules } from 'node:module'` 这种具名导入仍然可以，只要不是 `createRequire`。

下发保留作者发布的原字节，不改写文件、不重新打包。它不是 MCP 工具，Circle 中没有专用界面；客户端工具的结果只作“客户端预览”，算数的是 Hub 在沙箱中的重新核验。没有 tools/ 的包继续使用原有发布规则。

产品包可在 `product@1.variables` 声明普通变量。默认值必须合模式，只用于合成发布样例与试运行；发布时不读取部署值。引用只能占满 `sync.options` 或生产器 `params` 中的一个值，其他文件与其他包种类不接受引用。模式复用运行参数的 `packSchema`，不能执行的模式拒绝。默认值是否属于合成业务数据由发布者负责，Hub 的凭据扫描照常执行，不能机械证明数据的业务来源。

变量名字归首个已提交发布决定的包永久所有，撤回也不释放；同包各版模式规范 JSON 必须相同，默认值可变。跨进程产品发布在数据库事务内串行，依次锁定排序后的名字，在同一事务核对历史发布、密钥和部署引用并写发布决定。`variableNameAvailable(name, tx)` 是装配注入的只读端口，缺失时声明变量的发布拒绝；冲突不披露类型，统一“名字不可用”。

集成验收补了反向占名保护：产品包已经声明的普通变量名字，后续 `secret set/import` 在读值前和写决定的名字锁内都拒绝，不能等设置变量时才发现它被改成密钥。未接入部署名字端口属于装配缺口，明确要求修正装配后重发，不把它伪报为名字冲突。

已有变量声明来自本包时，部署定义随后引用这个名字不妨碍本包发布新版；仍核对历版模式一致。部署名字可用性只核对首次声明，其他包的既有归属始终拒绝。归属查询和核对仍在发布事务的名字锁内完成。

集成者于 2026-10-24 授权一项仅限静态审读的例外：包内相对路径 `functions/adoc/vendor/core.mjs`，完整 SHA-256 为 `5a8785bf8dc39a216170b836bb274957f079f77e5f40b33453c988f85de9203d` 的上游浏览器文件，可含未执行的字面动态导入 `node:fs`、`node:fs/promises`、`node:async_hooks`。只放过这三个指定导入；路径或任一字节改变即失效，静态导入、getBuiltinModule 和其他模块不在例外内。全局内置模块表、运行时导入守卫与 OS 权限均不改变；同路径实际执行这些导入仍被拒绝，回归测试逐项核对。
