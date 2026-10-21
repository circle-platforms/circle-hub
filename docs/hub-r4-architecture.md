---
title: Hub r4 architecture
---

# Hub r4 architecture (milestone 1)

This is the shared brief for everyone building the redesigned Hub. The design authority is the generic model in `contracts/model.json` (73 elements, 50 vocabulary axes, version 5). Read an element with `node tools/show-element.ts B01 A03` (prints definition, fields and rules). When this brief and the model disagree, the model wins; report the disagreement in your package README.

## 1. What milestone 1 delivers

A person in Circle (a terminal coding agent, unmodified apart from generic MCP-client improvements) connects the Hub as an ordinary MCP server and has a model review a real test mind map:

1. The model lists task packs, starts a run on an agile-platform mind map (an external object id, read-only), reads the expected sources (command catalog of one build, manual sections, linked story and bug text), judges each case, and submits.
2. The Hub never generates content. It parses, resolves exact values to references, re-runs the pack's checks in a sandbox, computes the terminal state of every (item, requirement, layer), partitions the items, and returns a receipt. Unknown stays unknown.
3. A console (read-only HTML) shows runs, the knowledge tree, task packs and admin data. Every call is logged.
4. The Hub runs persistently on one Mac, listening on loopback only, with backups.

Out of scope for milestone 1 (kept in the contracts, not implemented): effects and leases, dispositions and requests, dynamic layer checks, triggers and standing obligations, hypothesis sets, writing candidates, browser/device executors, xlsx and zip parsing.

## 2. Hard rules

- Use scripted models and synthetic fixtures in every test and in Git. Real systems are reached only by the scripts under `scripts/real/` and by the deployed Hub, never by tests. Fixtures mirror the structure of the real systems (section 8), never their content. Addresses in fixtures use 192.0.2.0/24.
- Never commit credentials, internal host names or addresses, real business data, or local absolute paths. Never read the owner's environment file; secrets enter the Hub only through the vault commands.
- Product knowledge lives in packs, never in the core. The core code must not contain a product name, a command name or a customer name. APV and NSAE are one product with two names (section 8).
- No coined terms. Labels come from `labelOf(axis, code)` in `contracts/generated/vocabulary.ts`; enumerations are never written by hand anywhere; use the generated types and zod enums. User-facing text is Chinese (labels, error messages, fixes); tool and schema descriptions for models are English; code comments are English and short.
- Code is TypeScript run directly by Node 24 (type stripping): erasable syntax only (no `enum`, no parameter properties, no namespaces), imports end in `.ts`, ESM. Dependencies are exactly those in `package.json`; do not add any. If you need one, write the request in your package README and work around it.
- Read-only toward business systems: only GET and the explicitly allow-listed read POST routes; never a login retry after a failure; no write routes.
- Append-only history: records are never updated or deleted; derived state is recomputed from records. Applied database migrations never change; add a new migration instead.
- Do not commit. The integrator commits per package after review. Do not run `git add`, `git commit`, `git stash` or `git checkout`. Do not touch files outside your package (section 4). Do not run `npm install`.
- Tests: `node --test` with files next to the code (`*.test.ts`); a temporary PostgreSQL through `hub/testing/postgres.ts` (provided by the records package) for anything that needs a database. Never weaken or delete a failing test; fix the code or explain why the test is wrong. Say exactly which commands you ran.

## 3. Shape of the system

```
Circle (MCP client) ──streamable HTTP, Bearer token──▶ hub/server
                                                          │ six tools, console, CLI
        ┌───────────────┬─────────────┬───────────────────┼──────────────┐
     hub/runs      hub/knowledge   hub/connectors      hub/records    hub/platform
  packs, runs,     tree, roots,    resources, route   records, objects,  keychain, launchd,
  validation,      producers,      allow-list, login,  vault, users,      pg lifecycle,
  partitions       Jev adapter     read plugins        tokens, call log   backup/restore
        │               │               │                    ▲
        └──── hub/rules (interpreters, sandbox) ─── hub/refs (references, parsers)
                                   contracts/ (model, vocabulary, zod shapes)
```

Dependency rule (arrows point to what may be imported): `server → runs, knowledge, connectors, records, platform, refs, rules`; `runs → knowledge(api), rules, refs, records`; `knowledge → rules(sandbox), refs, records`; `connectors → rules(sandbox), refs, records`; `rules → refs(types)`; `refs → contracts`; `records → contracts`; everything → `contracts`. No cycles. Cross-package calls go through the package's `api.ts` only, never through its internals.

### Data that exists

- **Records** (append-only table `records`: id, kind, schema, digest, provenance, created_at, body, plus a small index table for lookups) and **objects** (content-addressed bytes on disk). Record kinds: `claim, source_artifact, authorization, action, effect, request, call_log, run, submission, validation_result, pack_version, tree_node, tree_root, root_pointer`. Milestone 1 writes all of these except effect and request.
- **Mutable state** is limited to: users, tokens (hashed), the current-root pointers (compare-and-swap), and vault entries. Everything else is derived from records.
- **Digest of a record** = SHA-256 of the RFC 8785 canonical JSON of `{kind, schema, provenance, created_at, body}`.

### The six tools (`contracts/src/tools.ts`)

`list_task_packs`, `upload_file`, `start_run`, `get_nodes`, `resolve_reference`, `submit_result`. Annotations are derived by `annotationsFor`. `isError` is true only for protocol errors and for a submission, upload or effect write that is not accepted. Unknown is never an error. A caller who may not read something, or asks for something that does not exist, gets the same neutral `SOURCE_UNAVAILABLE` ("对你不可用") and the same empty shape.

## 4. Work packages and ownership

Each package owns exactly the paths listed. It publishes `api.ts` (types and the functions other packages may call) and `README.md` (decisions, limits, how to test). The model elements to implement are listed with each package.

| Package | Owns | Model elements | Depends on |
| --- | --- | --- | --- |
| contracts | `contracts/**`, `tools/gen-contracts*`, `tools/show-element.ts` | all (vocabulary, shapes) | none |
| records | `hub/records/**`, `hub/testing/**`, `hub/config/**` | B01 B02 B04 B05 B08, R01, R02 (visibility) | contracts |
| refs | `hub/refs/**` | B03, T04 (parsers, quote check) | contracts |
| rules | `hub/rules/**`, `contracts/src/tables.ts` | C03 C04 C05 C06 C07 C08, T03 (checks), sandbox | contracts, refs |
| platform | `hub/platform/**`, `scripts/**` (not `scripts/real/`), `bin/**` | deployment, D01 R[6] | contracts |
| knowledge | `hub/knowledge/**`, `contracts/src/knowledge.ts` | K01 K02 K03 K04 K05 | records, refs, rules |
| runs | `hub/runs/**`, `contracts/src/pack.ts` | W01 W02 W03 W05 W06 W07 W08, V01 V03 V04 V05 V06 V07, T01 T02 T03, A01 A02 A03 | records, refs, rules, knowledge(api) |
| connectors | `hub/connectors/**`, `contracts/src/resources.ts` | D01 D02 D03 (read part) D07 (resources only) | records, refs, rules |
| server | `hub/server/**` | D05 D06 B08 R01 R02 R03 (bot out of scope) | all |
| packs | `packs/**`, `tests/fixtures/**` | T01 T02 | contracts, runs(api) |
| acceptance | `tests/acceptance/**` | all scenarios in section 9 | all |
| docs | `docs/**` (except this file), root `*.md`, `.github/**` | n/a | none |

If you need something from a package you do not own, do not edit it: use its `api.ts`; if it is missing, write a precise request in your README under "Needs from other packages" and use a local fake in your tests.

## 5. Conventions

- **Ids**: `idOf(prefix)` in `contracts/src/common.ts` (`run_`, `usr_`, `tok_`, `rcd_` + 26-char lowercase base-32 ULID). Time is ISO 8601 UTC with `Z`. Hashes are lowercase hex SHA-256.
- **Canonical JSON**: RFC 8785 (`canonicalize` in `hub/records`), used for every digest.
- **Errors**: protocol codes from `PROTOCOL_CODES`, core violation codes from `CORE_VIOLATION_CODES`, pack codes under the pack name (`case-review.<code>`). Code that can fail for a caller throws a typed error carrying a registered code; the server maps it to the `errors` array. Never invent a code outside the registry; add it to `contracts/model.json` or `contracts/codes.json` by asking the contracts owner (README request).
- **Visibility**: a user sees their own runs and uploads; admins see all runs; packs, knowledge trees and their entries are visible to users with the pack assigned; system packs are never assigned to users. Absent and forbidden look the same.
- **Logging**: one JSON line per MCP call (`call_log` record and `$DATA/logs/calls-YYYY-MM-DD.jsonl`), W3C trace id, client session id from the `Circle-Session-Id` header, argument digest and size only (never case text), no secrets.
- **Configuration**: environment variables are `CIRCLE_HUB_*` only (data dir, port, database socket, keychain service). A process that sees any retired `CIRCLE_SERVER_*` variable refuses to start (reuse the earlier guard).
- **Pack functions** are pure TypeScript modules (`export default function (input: unknown): unknown`) run in a sandboxed child process (Node permission model: no network, no file writes, no child processes, read access only to the extracted pack), with a time and memory limit and size-capped JSON in and out. The same function code is the only implementation of a parser, projection, producer or renderer.
- **Reuse** of the earlier implementation: read it with `git show ca66002:<path>`; copy and adapt, do not import. Useful: `packages/storage/src/index.ts` (forward-only migrator), `packages/knowledge/src/objects.ts` (content-addressed objects), `packages/assets/src/vault.ts` (AES-256-GCM vault), `packages/tasks/src/auth.ts` (hashed tokens), `packages/contracts/src/hub-environment.ts` (retired-name guard), `packages/contracts/src/index.ts` (canonical JSON), `tests/acceptance/harness.ts` and `scripts/postgres-process.ts` (temporary PostgreSQL), `packages/connectors/src/{readonly-sdk,query-mirror,build-site,documents,structure,source-cache,private-http}.ts`, `packages/methods/src/command-tree.ts`, `packages/knowledge/src/zip.ts`, `packages/mcp/src/index.ts`, `packs/apv/methods/mindmap.ts`.

## 6. The case-review scenario (what the packs and the engine must make work)

Pack kinds: a **product pack** (names, version lines, build families, catalog producers), a **workflow pack** (`case-review`: requirement templates, checks, slots, procedure), **system packs** (agile platform, PLM, build site, manual store: resource declarations, route lists, request templates, projections). The administrator instantiates system packs as resources in the deployment database; users are assigned workflow packs.

**Input**: a KityMinder mind map. External id `agile:mindmap:<documentId>` (read by the agile system pack) or an uploaded export (`application/json`).

**Items**: the pack's projection function turns the parsed mind map into items. A case is a node with a non-empty `resource` tag array and a `priority`; its children are the expected results; a tag `negative` (any case) marks a negative case. Item id = `<documentId>:<data.id>` (node ids are unique inside a document and stable). Item fields: ancestor path (texts), title, priority, tags, expected texts, optional `autoid`, `negative`. Group nodes (priority, no resource) are not items. A document with no case node is a projection failure: the whole start_run is refused with a fix.

**Requirements** (static layer only; the dynamic layer is "not applicable"):
1. `structure` (accepted producer: fact; core `structure@1` + the pack table): exactly one non-empty expected result, non-empty title, priority 1-3, at least one tag, no duplicate case titles among siblings. Violations are deliverable findings about the author's input (attribution `author_input`), not rejections.
2. `catalog` (fact; core `catalog@1` against the locked build's command catalog): commands that appear in a case resolve to a catalog entry; parameters respect declared type and range; for a negative case the expected outcome is refutation (`core.catalog.param_out_of_range`), shown at advisory tier. Extracting command phrases from free text is the product pack's function; only phrases whose head resolves are checked.
3. `findings` (independent judgment): the model's review findings per item, each with a code from the pack's closed set, a rank, a statement, and verbatim quotations grounded in the subject and in an expected source. The Hub checks that quotations are verbatim in what the references resolve to (whitespace differences ignored), that finding codes and ranks are in the closed set, and that exact values (commands) resolve; a statement that contradicts the catalog goes through the pack's error table into repair.

**Expected sources** bound to a run: the command catalog and manual sections of the locked build (knowledge tree), and, for ids found in the document title, the linked story or bug text read through the PLM system pack (stored as source artifacts with provenance `plm:story:<id>@<revision>`, role `expected`).

**Version and build**: the document's tree location yields a release line (for example `10.4.6`) and a release train (`10.4.6-R2-2026/7`). Builds of the product come from both name families (section 8). Without `build`, the product pack's rule picks the latest released build of the line across families on the main platform; the choice and its basis are recorded in the run; `version`/`build` given by the caller win.

## 7. Phases of the build

1. contracts completion, records, refs, rules, platform, docs (parallel)
2. knowledge, runs, connectors (parallel; code against the real phase 1 packages)
3. server, packs (parallel)
4. acceptance and integration; independent review of the whole against the model
5. persistent deployment and the real-system scripts (done by the integrator)

Each phase ends with independent review (against the model and this brief) and a fix round before the next phase starts.

## 8. Real systems (structure only; verified by read-only sampling on 2026-10-21)

**APV and NSAE are one product with two names.** Product line `apv` has names [APV, NSAE]. Versions and builds exist under both names. Everything below must treat the two as one line.

- **Agile test platform** (roles `agile-oauth`, `agile-api`). Login `POST /oauth/login/` with `{username, password}` where password is Base64(SHA-512(plaintext)); envelope `{code, msg, data}`, code 1000 is success, HTTP status is always 200; a wrong password answers code 1005 and repeated failures may lock the account, so a failed login is never retried. `data.token` (about 30 days, `data.expire` is epoch seconds) goes in the `Authorization` header without a prefix. `POST /agile/get_root_node/ {page}` returns 10 roots per page and `total`; pages past the end repeat page 1. `POST /agile/get_child_node_task/ {id}` returns the whole subtree of a root `[{label, id, cases:[ids], children}]`; a leaf id is a mind-map document id. `POST /agile/get_case_data/ {id}` returns `{code, msg, data:"<JSON string>"}`, double-encoded KityMinder: `{root:{data:{id, created, text, priority?, degree?, resource?[], autoid?, auto?, note?}, children}, template, theme, version}`. Two roots belong to the product: id 5510 "APV" (12 nodes, no versions) and id 1571 "NSAE" (about 3,700 nodes; the real versioned maps). Tree convention under 1571: `030：APV/NSAE测试项目` → version line `NNN：10.4.6` → release train `NNN: 10.4.6-R2-2026/7` → module (HA, SLB, SSL, WebUI, 系统, 网络, 认证, ...) → document; document titles carry ZenTao ids (`bug to case 90908 ...`, `19466-...`). Root ids and hosts are deployment data, never committed.
- **PLM query service** (role `plm-api`; the same login token works). Envelope `{code, msg, data}`, code 1000 ok, HTTP always 200, header `Authorization: <token>`. Reads include `GET /plmquery/product/all/`, `GET /plmquery/build/?product=` (a plain array, not paginated), `POST /plmquery/bug/detail/ {bug_ids}`, `POST /plmquery/story/detail/ {story_ids}`. Product 28 "NSAE/APV/NSAE/APV/NetOpti" has about 1,100 builds named in both families (`Rel_NSAE_10_4_6_17`, `Rel_APV-HG-K_10_4_6_8_4_129`, `Beta_APV_10_5_1_101`). Ids are numbers in some answers and strings in others, dates have three spellings, steps and specs are HTML. A write route (`/plmquery/testtask/edit/`) shares the prefix with the reads and reads also use POST: the transport must allow-list routes one by one (method and path template), never by prefix or method.
- **Build site** (role `build-site`, anonymous, plain HTTP, ISO-8859-1). An index page links listing pages for both families (`rel_apv_*`, `rel_nsae_*`, others). A listing page has entries like `Rel_APV_10_4_0_179 (build on  2024-06-26 12:06:23 ): Released on 2024-06-27` (released ones in a red font element) followed by links with unquoted attributes: the image (with size and SHA-256 in the text), the MIB text, `command_tree-<build>.xml`, `Bugs_Fixed_with_<build>.html`. The command tree is about 1.4 MB XML: `commands > scope > menu[name] > item[name] > arguments > arg[name, type, length, limit, optional, default_value]`, with stray attributes in some help strings; the full command is the menu path plus the item name; one path can have several argument lists (overloads).
- **Manual store** (role `manual-store`, WebDAV, anonymous read, plain HTTP). `PROPFIND` depth 1; the collection URL needs a trailing slash. `/spec/` (about 1,000 Markdown files converted from Word), `/product/`, `/qa/`, `/cli/rel_apv_<line>/cli_cn/cli_cn.md` (about 2.7 MB, contains NUL bytes that PostgreSQL text rejects: strip them from stored text, keep the original bytes as the object), `/app/rel_apv_<line>/app_cn/app_cn.md`.

## 9. Acceptance scenarios (synthetic, in `tests/acceptance`)

1. A normal review: all items delivered; per-requirement terminal states and satisfaction counts correct; the dynamic layer shows "not applicable".
2. A quotation that does not match: the whole submission is not accepted, stored verbatim, the receipt carries the fix and the rounds left; a corrected resubmission is accepted and the first cause stays visible.
3. A statement that a command does not exist while the catalog has it: that finding is a violation routed through the error table into repair, not a whole-submission rejection.
4. A negative case with an out-of-range parameter: the catalog check refutes as expected, shown at advisory tier.
5. A cross-item fact plus a judgment that rests on it: listed separately, not counted in partitions.
6. A user without the pack gets "对你不可用" and the same empty shape; the real reason is only in the admin log.
7. Call log: one line per call with trace id and session id; argument digest and size only.
8. A second, non-APV synthetic product pack reviews with the same workflow pack and the core code does not change.
9. Connectors: a route outside the allow-list is refused; an expired token logs in once and a second failure stops; originals are stored by SHA-256.
10. Changing one case re-judges one case (items unchanged by content digest are reused).
11. A scripted Jev: no calibrated threshold or a low probability leaves the fragment at the parent node, marked uncalibrated.
12. Console and API: a wrong Host or Origin is refused; a request without a token is refused.
13. Idempotence: repeating `submit_result` for the same (run, submission digest) returns the stored result without re-running anything; repeating `start_run` with the same client key inside its window returns the same run; an expired key starts a new run.

## 10. Definition of done for any package

- `api.ts` and `README.md` exist; the README lists decisions, limits, how to run the tests and "Needs from other packages".
- `npx tsc --noEmit` reports no error in your files (errors in other packages mid-edit are not yours).
- Your tests pass: say the exact command. Positive and negative cases for every rule you implement; adversarial inputs for parsers and the sandbox.
- No hand-written enumeration of a vocabulary axis; no product name in core code; no secrets, hosts or absolute paths in files.
- A final report: what you built, commands run with results, deviations from this brief with the reason, open questions.
