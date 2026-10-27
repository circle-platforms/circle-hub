# hub/server assembly

The assembly plugs the real packages into the server core: `hub/server/assemble.ts` (the `AssemblyModule` that `serve`
and the CLI load), the administrator commands `hub/server/cli-admin.ts`, the in-process real Hub for acceptance tests
`hub/server/testing-real.ts`, and the modules and tests under `hub/server/assemble/`. Brief sections 3, 4, 5, 6 and 9;
model elements D01 R[6] (resources), B04 (decisions), R01 (roles), T01/T02 (publication). The Hub calls no model
(owner decision 2026-10-22): the assembly builds no judgment client and `secret set jev api-key` no longer exists.

| File | Content |
| --- | --- |
| `../assemble.ts` | the AssemblyModule: `assemble` (= `createAssembly()`, for `serve`), `assembleCommand` (= `createCommandAssembly()`, what the server core's `ctx.deps()` uses for one CLI command such as `run show`), `registerCommands` (the six administrator commands); re-exports `assembleHub`, `createAssembly`, `createCommandAssembly`, `adminCommands`, `operatorAdmin` |
| `hub.ts` | `assembleHub(config, records, options)` → `AssembledHub` (ServerDeps plus every service, `runsExternal` the engine's reader); `createAssembly(options)` → the `AssembleFunction` of `serve`; `createCommandAssembly(options)` → the `CommandAssembleFunction` (api.ts): no vault key, no sandbox probe, no notices, log lines to the CLI's stderr |
| `vault.ts` | `requireVaultKey` (reads the master key through records' `checkVaultKey`, never creates it; the advice depends on whether the vault holds entries), `vaultKeyProblem` |
| `notes.ts` | `CallNotes`: the connectors' and the registry's messages to the current call's admin note (AsyncLocalStorage around every engine call) and the operator's log; the engine's to the operator's log only (it notes the call itself); `withCallNotes`, `MAX_CONNECTOR_NOTES` |
| `operator-token.ts` | the operator token: `CIRCLE_HUB_TOKEN` (`takeEnvironmentToken`), the keychain item (`keychainOperatorTokens`, `OperatorTokenError`; named by the platform's `OPERATOR_TOKEN_ITEM`), its keychain service (`deploymentKeychainService`), `memoryOperatorTokens` |
| `secret-input.ts` | `readSecret`: a value from stdin only (a terminal reads without echo, special keys dropped; one trailing line break removed from a pipe) |
| `terminal.ts` | `terminalSafe`: every C0 and C1 control character but tab, the line separators and the bidirectional controls as visible escapes; `jsonSafe`: the same characters that JSON.stringify leaves raw as `\u` escapes inside JSON text |
| `errors.ts`, `files.ts` | `AssemblyError` (message plus the operator's next step); `removeTree` for directories holding read-only extracted packs |
| `../cli-admin.ts` | `adminCommands(options)`: `pack`, `resource`, `secret`, `source`, `knowledge`, `init-admin`, `operator-token`; for the server core's built-ins too: `operatorAdmin(ctx, options)` and `operatorAct` (state-changing; `operatorAct` also says when the command cut off its own token) and `operatorViewer` (read-only) |
| `../testing-real.ts` | `createTestHub(options)`, `findPackDirectories`, `stagePack` |
| `test-packs.ts`, `test-cli.ts` | test support: tiny synthetic packs written to temporary directories; a socket-only PostgreSQL and in-process CLI runs |

## Start-up (`circle-hub serve`)

`main.ts` (server core) runs, in this order: the retired-name guard (`CIRCLE_SERVER_*` refuses before anything else),
the configuration (`CIRCLE_HUB_*`), the platform's cluster when the database is the data root's socket, the records as the
runtime role without migrating (an unmigrated database refuses here, before the assembly), call-log repair, the sandbox
orphan sweep, then `assemble(config, records)`, then `listen()`. `assemble` = `createAssembly()`:

1. **Vault master key**: `requireVaultKey` reads it through the key provider the records were opened with
   (`hubKeyProvider` of hub/platform in a deployment) and checks it against the vault. A missing key, a locked keychain or a
   key that does not open the vault stops the process with `AssemblyError` and the next step. When the vault already holds
   entries (listing names needs no key), prefer restoring the original keychain item: a new key cannot open old entries.
   If that item cannot be recovered, follow the **Irrecoverable key loss** procedure in Secrets below using
   `circle-hub key init --set-aside-vault`; plain `key init` is only for an empty vault. Startup never creates a key.
2. sandbox-exec is probed; where it is missing a notice says pack functions cannot run (pack functions always run with
   `requireOsIsolation: true` in the deployed Hub).
3. The pack registry (`createPackRegistry`, extraction under `<data dir>/packs`,
   `onError` and `onTamper` to the operator's log) and its ports (`createPacksPort`, `createWorkflowStore`,
   `createPackCatalog`), plus `createSkillParserRegistry` loading explicitly installed parser capabilities in the package sandbox. KityMinder is independently installed; remaining built-ins migrate in R5 B5.
4. Connectors (`createConnectors`: resources, logins, read plugins) with `createExternalReader` and `createResourceCatalog`.
5. Knowledge (`createKnowledge` with the PacksPort, the connectors' ExternalReaderPort alone, since the views are not a
   source of the tree, and no placer: the Hub calls no model, so spans the code cannot place stay unplaced at the root),
   the named documents (`createDocs`, C4), the run engine (`createRunsService`, whose ExternalReaderPort is
   `routeDocs(docs.reader, routeKnowledgeViews(createKnowledgeReader(knowledge), connectors' reader))`:
   `knowledge:impact|facets|index:…` inputs and expected sources are the knowledge views, `doc:doc:…` the named
   documents, every other id the connectors), and `ServerDeps` (`products` = the PacksPort,
   for the console's knowledge page; `runsDetail` = the engine, for the texts of start_run and submit_result).

A CLI command that needs the server's dependencies (`run show`) gets them from `assembleCommand(config, records, io)`
(`createCommandAssembly`, the server core's `ctx.deps()`): the same packages without the key check (a run is read without
the vault), without the probe and without start-up notices, its log lines on the CLI's stderr made safe for a terminal.
`serve`'s `assemble` is never used for a command.

## Administrator commands

```
circle-hub init-admin <name>                         # first admin; its token goes into the keychain item, never printed
circle-hub operator-token set                        # a lost item: an enabled admin's token from stdin into the item
circle-hub operator-token reissue [--as <admin>]     # a lost or dead item and no admin token in hand: a new one, never printed
circle-hub pack publish <dir> [--stage] | grant-publish <user> | revoke-publish <user> | assign <user> <pack> | unassign <user> <pack>
circle-hub pack retire <pack@version> | activate <product pack> | deactivate <product pack> | list [--as <account>]
circle-hub resource add <system pack> --name <n> --environment test|shared|production --origin <role>=<url> ...
                    [--allow-plaintext <role>] ... [--setting <key>=<JSON or text>] ...
circle-hub resource update <res> [--system-pack <pack>] [--name <n>] [--environment <env>]
                    [--origin <role>=<url> ...] [--allow-plaintext <role> ... | --clear-plaintext]
                    [--credential <item>=<secret>] [--setting <k>=<v>] [--unset-setting <k>]
circle-hub resource list [--as] | disable <res> | enable <res> | reset-login <res>
circle-hub secret set --name <NAME> --reason <note>   # one line per name, stdin only
circle-hub secret list                              # administrator metadata only
circle-hub doc put <name> <file> | list | show <name> # named documents (C4): put is admin-only; non-admins get the missing answer
circle-hub knowledge sync --product <name or id> [--line <line>] [--dry-run] [--recheck] [--include-unreleased]
circle-hub knowledge seed --product <product> --line <line> [--build <build>] --basis <one line> [--dry-run]
circle-hub knowledge roots <product> [--as] | diff <rootA> <rootB> [--as]
```

- **Operator token.** Every command that changes state (all of the above except the listings, `roots` and `diff`; a
  `knowledge sync` or `knowledge seed`, dry runs included, because their reads store source artifacts) acts as the account of the operator
  token. The normal path is the keychain item `init-admin` writes: account `operator-token` under the deployment's keychain
  service, which is resolved as hub/platform resolves the vault master key's (`deploymentKeychainService`: the deployment
  settings of `CIRCLE_HUB_DATA_DIR` when that data root has them, a disagreeing `CIRCLE_HUB_KEYCHAIN_SERVICE` refused as the
  platform refuses it; otherwise the variable, else `circle-hub`), so the item always sits beside the vault key of the same
  deployment. `CIRCLE_HUB_TOKEN` gives a token for one invocation only: `read -rs T` then `CIRCLE_HUB_TOKEN="$T" circle-hub
  pack …` (the token stays out of the shell history). It must not be exported: `serve` refuses to start while it is set,
  and a token left in a shell reaches everything that shell starts. The server core's built-in state-changing commands
  (`user create|disable|enable`, `token issue|revoke`) follow the same rule through `operatorAdmin` and `operatorAct`;
  platform commands accept the name and get an environment without it. The commands remove it from the environment object
  when they read it, so it never reaches a child process. No token, an unknown or revoked one, or one of a non-admin is
  refused (exit 1) before anything is read or written, and the fix named works without that token (`operator-token
  reissue` for a lost or dead item, never `token issue`, which needs it); `secret set` never asks for a value then.
- **Read-only commands** (`pack list`, `resource list`, `knowledge roots|diff`, and the server core's
  `logs export` and `run show` through `operatorViewer`) act as the account of the operator token when there is one (a
  user's `pack list` shows the user's packs); `--as` is then allowed only when it names that same account. Without a token
  they act as `--as` or the only enabled admin.
  A keychain item that cannot be read (a locked keychain: over SSH `security` fails at once, in a GUI session it waits for
  the unlock dialog up to the platform's 60 s) costs a notice on stderr, and the command reads as if there were no token. These
  rules choose a view, they are not an access boundary: anyone who can run the CLI against the database can act as the only
  admin.
- **init-admin** refuses once any admin exists (naming `operator-token reissue` for a lost token) and when the keychain
  item exists already; it creates the admin with `Principals.bootstrapAdmin` and writes its token into the item. When the
  write fails the admin exists and the never-shown token is revoked, and the fix is `operator-token reissue --as <admin>`
  once the keychain works (after deleting an item a failed read-back may have left); when the revocation fails or is not
  confirmed the message says so and the fix adds `circle-hub token revoke <tok_…>` after the reissue (the revocation
  needs the operator token the reissue gives).
- **operator-token set** replaces a lost item (another Mac, a reset keychain) with an admin token in hand: it refuses
  while the item exists (an item that no longer works is deleted in Keychain Access first), reads a token from stdin only
  (never argv or the environment; a terminal reads without echo), checks that it is a well-formed Hub token of an enabled
  admin (`Principals.authenticate`) and only then writes it into the item (stdin of `security -i`, read back); the output
  names the admin and never the token. Without a token in hand its refusal names the reissue.
- **operator-token reissue [--as <admin>]** is the break-glass path: the item is lost (init-admin never showed its token),
  or its token was revoked or its account disabled, and no admin token is at hand. It refuses while the item exists (an
  item that no longer works is deleted in Keychain Access first), issues a new token for `--as` or the only enabled admin
  (records keep at least one; label `操作令牌（重新签发）`, issued by that admin) and writes it straight into the item,
  never printing it; a token it cannot store is revoked, as for init-admin. The output names the admin and the token id and
  says how to revoke the old token should it still be valid somewhere. It needs no token: the CLI is no access boundary
  against whoever can run it against the database (that account can change the database directly), and what it gives
  exists only in the deployment's keychain item, which takes the owner's unlocked login keychain to write and to read.
- **Cutting off one's own token.** `token revoke` of the operator token's own token and `user disable` of its own account
  are carried out (revocation must stay possible for a leak); afterwards the command says on stderr that the operator token
  no longer works and how to get a new one (`operator-token reissue`, after deleting the dead item).
- **Named deployment values**: only the current operator administrator may use `var` or `secret`, including read-only listings. `var set <NAME> [--file <file>] [--text] [--not-secret] --reason <note>` reads bounded UTF-8 JSON, or an explicit text value; it never guesses the type. Lists hide values; `var show <NAME> --value` first warns that the value remains in terminal history. A credential-like name belongs to `secret`; a credential-like ordinary value needs explicit `--not-secret`, recorded in its reason. Immutable history cannot be erased: rotate at the issuer if a secret was mistakenly persisted as ordinary data.

- **Secrets**: `secret set --name <NAME>… --reason <note>` first lists the registered consumers, then reads each value without echo. A pipe supplies exactly one line per name. A name has one kind permanently; each secret setting creates a new vault entry and an atomic configuration decision. Short values require `--short <NAME>` and an explicit warning. Digest storage is explicit with `--digest <NAME>=sha512_base64`; a consumer that needs the raw value prevents digest-only storage. Never pass a value in argv or in the reason. `secret list` and `secret show --name <NAME> [--history]` show only names, versions, lengths, digest rules and consumers, never values or their hashes.
  `secret import --env-file <file> --key <KEY>=<NAME>… [--basic <USER_KEY>:<PASSWORD_KEY>=<NAME>] [--digest <NAME>=sha512_base64] [--short <NAME>] --reason <note> [--dry-run]` checks the administrator, consumers and digest compatibility before opening the file; a real import also checks the vault key first. The reader retains only named active keys from a plain UTF-8 file up to 64 KiB. Missing/empty keys prevent the batch. Basic is accepted only when every consumer's bound profile declares a raw, plain Authorization header. Current and historical ordinary values and deployment definitions are checked for raw or reversible exposures, including Basic password components and declared digest credentials; an exposed value must be rotated at its issuer. The whole batch writes all vault entries before committing all decisions together; dry run writes nothing. Output contains only requested key names, found/absent status, lengths and version metadata. Old resource/credential positional syntax refuses with the migration command. Every successful setting or withdrawal reminds the operator to revoke the old value at its issuer: removing Hub's entry does not remove it from backups.

- **Irrecoverable key loss**: stop the service, then run `circle-hub key init --set-aside-vault`.
  It takes the platform lock, refuses a loaded service, a busy configured port or a present key, moves only `vault/`
  to a unique `set-aside/<timestamp>-key-loss/vault`, recreates the empty vault with mode 0700 and initializes the key.
  The database and objects stay in place. Run `circle-hub operator-token reissue` only if that item was lost too,
  then inspect `secret list` (registered versions whose entries were lost), use the named `secret import` form to reimport, then start the service. Before starting after a backup restore, inspect each current secret setting time; values rotated or revoked at the issuer since the restore point must be set or withdrawn again. A new key cannot open old entries.
  Plain `key init` refuses a nonempty vault before touching the keychain. `resource list` remains available without
  the master key; commands needing secrets refuse before opening the environment file. Synthetic tests use temporary
  file keys and explicitly targeted temporary keychain files; they verify logins before loss and after reimport.
- **Login state.** Named secret decisions participate in the session binding. `secret set --name <NAME>` changes the binding, so the next read logs in with the new version without a restart. `resource reset-login <res>` changes the shared credential-version stop epoch and removes that resource's session; all consumers of those versions can make another attempt. In-flight operations finish using the versions they captured.
- **Changing a resource:** `--credential <item>=<NAME>` sets an explicit reference, migrating a legacy entry atomically with the new definition. A destination change requires a new enrollment through `secret set`. Settings update by key: `--setting k=text` always stores text, `--setting-json k=JSON` parses JSON, `--setting-var k=NAME` creates a whole-value reference, and `--unset-setting k` removes a key. `resource show <res>` is metadata only; `--values` explicitly prints literal settings. Origins and plaintext declarations still replace their complete maps/lists. Pack versions take effect only through an update.
- **Read-only connector smoke**: `resource read <resource> <read-name> <key>` needs the operator's admin token and
  vault key because the read saves originals and its manifest. It calls `executeRead` with purpose `管理员冒烟读取`.
  Output contains only the bound system pack/read name, completion or failure code, each artifact's declared name,
  digest and size, and the manifest digest. The default suppresses the assembly's free-text event sink. `--events` explicitly sends its redacted connector
  events to stderr for the smoke checker to capture; the checker always requests that channel and never echoes it. Read details remain in the manifest and administrator records.
- **Integrator smoke script**: `node scripts/real/smoke-connectors.ts --logs <logs> --read <resource>:<read-name>:<key> [--read …]`.
  Per integrator answer 9 on the plan-evidence task, this checks command output (including any command events) and only
  the newly appended bytes of `hub.out.log`/`hub.err.log`; it does not treat CLI reads as MCP calls or export a call log.
  Each response artifact is exported to a temporary 0700 directory and checked against its reported SHA-256 and size,
  then removed. JSON string values or markup attributes/text fragments of at least eight characters are searched raw and JSON-escaped
  in both outputs, excluding standalone digests and text already in the request key. Only counts and hit locations are
  printed. Completion, intact exports and zero hits are all required; missing, rotated, truncated or unreadable logs,
  non-UTF8 text artifacts without encoding-independent ASCII canaries and export failures cannot pass. A log increment over 64 MiB also refuses the check.
  Reads are sequential, never retried; actual connector smoke runs belong to the integrator, not these synthetic tests.
- **Held-back sources** (B02 R[4]): a read whose bytes the credential scan flags is stored `retain_only`: no function gets its text. `source held` lists scan-hit sources (sha256, size, the external object, detectors), with current effective tier and direct/derived/no acceptance, `source findings <sha256>` shows each finding as a position and the shape of the line around it (letters as x, digits as 9), never the value, `source accept <sha256> --note <why>` records an administrator's acceptance bound to that exact scan (the note may not copy the matched text), and `source withdraw <sha256>` takes it back. An acceptance lifts only bytes the Hub read or made, never an upload, and never a truncated scan; stored tiers remain historical: current acceptance lifts a scan-imposed hold, while an explicit requested retain-only policy stays in force. Derived coverage is established once at admission; ordinary reads validate stored scan facts and live dependency decisions without re-scanning source bytes (records decisions 19–20).
- **Publication** needs a publish right (B04): `pack grant-publish <user>` is an admin decision; `pack publish` without it
  `pack publish <dir> --stage` publishes a copy of exactly the files `pack.json` lists (a listed path must be a plain file inside `<dir>`; the publish check still verifies every digest), so a pack's source directory may keep its tests and README beside it. Without `--stage` an extra file is a publish problem (`manifest.unlisted_file`).
  is refused with that fix. A refusal lists every problem (rule, file, field or line, message, fix) on stderr.
- **knowledge sync** uses hub/knowledge's parser, sync and report text and exits 1 when the sync or any build failed.
  **knowledge seed** reads the three sources the product pack declares, calls `produceSeedling`, and exits 1 when a source or the seedling failed. A missing source names itself and the next command.
  `roots` lists the builds of a line (both name families, aliases with their base,
  a build that is its own base as `自身为基础构建`) with their roots and each line's current root; `diff` prints the added,
  removed and modified paths of two roots. A non-admin reads only lines a pack assigned to them binds (absent and forbidden
  alike).
- **Output** is Chinese; exit codes 0 ok, 1 refused or failed, 2 usage. Every line the commands print, their errors and the
  log lines of their assemblies (connector and registry events, on the command's stderr) is made safe for a terminal first
  (`terminalSafe`): a pack title, a resource name, a build name or a remote reason cannot clear lines or fake output. The
  operator's log of every assembly, serve's included, is escaped in one place, `CallNotes.log`: the engine's reasons
  quote callers' arguments (a start_run `pack` may be any string), which then cannot fake a log line or steer the terminal
  of an operator reading the log.
  Nothing prints a token or a secret: the tests scan every printed line, the assemblies' log lines included, for every
  token, password, digest and key they handled.

## createTestHub (acceptance tests)

```ts
import { createTestHub, AGILE_DOCUMENT } from '../../hub/server/testing-real.ts';
const hub = await createTestHub({ postgres, repositoryPacks: [WORKFLOW_PACK, SYSTEM_PACK], packs: [extraPackDir] });
const stubs = hub.stubs!;
const res = await hub.addResource({ system_pack: SYSTEM_PACK, name: '合成敏捷平台', environment: 'test',
  origins: { 'agile-oauth': stubs.agile.origin, 'agile-api': stubs.agile.origin }, allow_plaintext: [stubs.agile.origin],
  settings: { roots: ['7714'] } });                       // the root of the stub's fixture tree
await hub.setCredential(res.id, 'username', stubs.agileAccount.username);
await hub.setCredential(res.id, 'password', stubs.agileAccount.password);
const alice = await hub.createUser('甲');
await hub.assignPack(alice.principal, WORKFLOW_PACK);
const client = await hub.client(alice.token, { sessionId: 's-1' });
await client.call('start_run', { pack: WORKFLOW_PACK, inputs: { map: { external: `agile:mindmap:${AGILE_DOCUMENT}` } } });
await hub.close();
```

The real assembly in-process on a temporary PostgreSQL (`hub/testing`), listening on a loopback port: the pack registry,
run engine, knowledge and connectors are the real ones. External systems are the connectors' stubs (agile with its
fixture, PLM sharing its tokens, build site, WebDAV), started unless `stubs: false`. Packs: the ones under `packs/` that have a
`pack.json` (`repositoryPacks`: true by default, false, or a list of pack ids; `repositoryRoot` points the search at
another tree, as this package's own test does), then `packs` (directories), each staged (copied with exactly the files its
manifest lists, so test files beside the functions do not count) and published by the admin through the real registry,
product packs activated. Helpers: `createUser`, `issueToken`, `assignPack`, `publishPack` (a product pack is activated
unless `{ activate: false }`), `activate`, `addResource`, `setCredential`, `knowledgeSync`, `client` (the official SDK
client over streamable HTTP with the Bearer token, `Circle-Session-Id` and `traceparent`), `close`. `hub.hub` exposes every
service, `hub.logs` the operator's log lines.

## Decisions

1. **One assembly, three uses.** `assembleHub` builds everything. `serve` (`createAssembly`) requires the vault key and
   probes sandbox-exec. A command-time assembly (`createCommandAssembly`, for the server core's `run show`) needs neither.
   The assembly's own commands require the key only where they read or write a secret value (`secret set`,
   `knowledge sync`), refused then with `这个命令要用密钥库，没有执行` rather than serve's `Hub 不启动`; `resource
   reset-login` only removes a vault entry and needs no key; `resource list` reads the key once for its login column. So
   `pack list`, `secret list`, `knowledge roots|diff` and `resource list` work without the key; with a keychain item that
   cannot be read they cost one `security` call and a notice (decision 6).
2. **Admin notes by call, not by trace.** The engine writes its reasons to the admin note of the call it serves itself
   (`CallContext.adminNote`) and to the process-wide `adminLog`, which goes to the operator's log only (with the trace and
   run). The connectors and the pack registry report through process-wide callbacks without a call context, so every
   RunsService call that carries a `CallContext` still runs inside an AsyncLocalStorage holding it: a connector or
   registry message raised while serving a call becomes that call's note, even when two calls share a trace id. The bridge
   stays for them alone (ExternalReaderPort and WorkflowStore of hub/ports.ts carry no call context). The server joins a
   call's notes and keeps 2000 characters, so a note takes the engine's reasons and registry problems, and of the
   connectors' events only failures (read, login, credential, stored manifest or session), at most `MAX_CONNECTOR_NOTES`
   (3) of at most 240 characters each and one line saying more are in the operator's log: logins and reads that succeeded
   would push the reason out. Everything also goes to the operator's log, except the per-request `http` event (the read
   manifest has every request).
3. **start_run's text gets the engine's detail.** `ServerDeps.runsDetail` is the engine: the server calls
   `startRunDetailed` (the answer carries `result: {reference, counts}` for a production run, the engine's own; the
   former merge in this package is gone) and `getResult`, so the texts name the run record and the stored result.
4. **No judgment client** (owner decision 2026-10-22): the Hub calls no model, so the assembly builds no typed-judgment
   client and knowledge runs without a placer (spans the code cannot place stay unplaced at the root, marked 未归位).
   `secret set jev api-key` is gone; a `jev.api-key` entry left in the vault from before the removal is never read
   (the insurance test in `no-judgment.test.ts` proves it, with zero outbound calls to the judgment service in a sync).
5. **Named documents** (C4 of the device-pack core): `hub/server/docs.ts` serves `doc put/list/show` and the
   `doc:doc:<name>` / `doc:doc:<name>@<sha256>` external ids through the Hub's own reader (never an external system);
   the assembly wires it beside the knowledge views (`routeDocs(routeKnowledgeViews(reader, connectors))`), and a run
   of a pack declaring `accepts: ["doc:doc"]` on an input slot freezes the current digest into its sources at start
   (withRevision). The pointer is the records package's compare-and-set one (`doc:<name>`), `Pointers.list` was added
   for `doc list`; a non-admin, on the CLI and through a run, gets the same answer as for a doc that does not exist.
5. **Operator token item.** The keychain item holds the token's 32 random bytes as 64 hexadecimal characters, the one form
   hub/platform `keychainStore().read()` reads; the token is base64url of those bytes (records' token form, checked before
   storing). It is read through `keychainStore` made with the platform's `OPERATOR_TOKEN_ITEM`, so the platform's own
   messages name the operator token on every account and carry no vault key advice (nothing is reworded here; the tests
   follow the platform's exported labels, not a spelling of them). It is written by this package through stdin of
   `security -i` and read back to confirm (see Needs: the platform's `keychainStore.write` can replace it). Its service is
   the deployment's, resolved as the vault key's (Administrator commands).
6. **Read-only commands follow the token.** With a token they act as its account and `--as` must name that account; without
   one they act as `--as` or the only enabled admin; a keychain item that cannot be read falls back to that rule with a
   notice. An invalid token (the variable's or the item's) is refused, with how to remove a stale item.
7. **createTestHub stages packs** before publishing and extracts them outside the records' data directory (extracted trees
   are read-only and `hub/testing` removes the data directory without unlocking them).
8. **Terminal-safe output.** Session `out`/`err`, the errors of the commands and the log lines of their assemblies pass
   through `terminalSafe` (the assemblies' in `CallNotes.log`, whatever the sink); the configuration's own errors
   (hub/config) are printed by the server core as they are.
9. **A break-glass reissue instead of a recovery token.** A lost or dead operator token item is replaced by `operator-token
   reissue`, which needs no token, rather than by a recovery token init-admin would have to show (it shows none) or by
   hand-edited SQL; it never overwrites an item and never prints the token.

## Limits

- `CIRCLE_HUB_TOKEN` exported in a shell makes `serve` refuse to start (by design, server README); the commands accept it
  and the messages show it only as a prefix of one command.
- A CLI command and the running server are separate processes. A running server ends a stop at its next read that needs
  the credential after `secret set` or `resource reset-login` (hub/connectors re-reads the session entry), not at once; a
  usable token it holds stays in use until its next login. The server's connector profile cache keeps a withdrawn system
  pack for up to 5 s, and a knowledge sync from the CLI is not serialised with one from another process (knowledge
  README).
- A read-only command reads the keychain item when `CIRCLE_HUB_TOKEN` is not set; in a GUI session with a locked keychain
  that read waits for the unlock dialog (at most 60 s, hub/platform) before the command falls back.
- The keychain write is tested with a fake `security` tool everywhere and with the real one only against a throwaway
  keychain file on macOS (every call is refused unless it names that file); the owner's keychain is never touched.
- Each CLI invocation assembles the whole Hub (no network, no sandbox call until a command needs one).

## Tests

```
node --test "hub/server/assemble/**/*.test.ts"
npx tsc --noEmit
```

Five files, 60 tests, about 15 s on the development Mac (the named documents add `hub/server/docs.test.ts` (7) beside
them: put/replace/idempotent, name and size rules, concurrent puts on the compare-and-set, current and pinned reads,
held-back credentials, a run freezing the digest with only the declaring pack's user reading). `assemble.test.ts` (15): start-up order (a retired variable
refuses serve and the admin commands before the assembly loads or the key provider is asked; an unmigrated database
refuses serve and the commands before the assembly runs); no key file stops serve before listening and creates none; the
platform's keychain provider with a fake `security` tool and no item stops serve and only reads, advising `key init` for
an empty vault and the original item, never `key init`, for a vault that holds an entry (the item matched by the
platform's exported `VAULT_KEY_ITEM.label`, not a spelling of it); a key that does not open the
vault stops the assembly; a real start serves the six tools to a token, `list_task_packs` over the real registry, a
neutral `start_run` whose engine reason is the call's admin note, and no judgment-service notice at start-up (the Hub
calls no model); records' `checkVaultKey` with the right, another and a missing key, adding no entry; the command-time
assembly without a key (a run read,
nothing printed) beside serve's refusal and a command's own wording, and `run show` through the CLI with the real module
(no key needed, serve's `assemble` never called; a module without `assembleCommand` refused); call notes for two
concurrent calls of one trace (connector and registry messages to their own call, the engine's to the operator's log
only), success events kept out of a note and failures capped so that the engine's own note survives the server's
clipping, said once; the operator's log one escaped line for an engine reason quoting a start_run `pack` with line
breaks and control sequences, and for connector, registry and tamper events; the wiring: `runsDetail` is the engine, the
engine's reader takes knowledge views and the knowledge service's does not, and an assembled engine notes a neutral
answer's reason on the call once. `no-judgment.test.ts` (1): the assembly insurance of the owner decision of
2026-10-22: a `jev.api-key` entry left in the vault is never read, the assembled Hub has no placer, a knowledge sync of
a product whose producer declared its path-less entries placeable makes no outbound call to the judgment service (every
recorded call goes to a loopback stub), the entries stay at the root marked 未归位 and the production records
`placement.spans` 0. `cli-admin.test.ts` (30): every command through the server CLI's `main` on a
socket-only PostgreSQL (the built-in commands with the same in-memory token store): init-admin, its output (the keychain
item as the normal path) and refusals (naming the reissue), a token it could not store revoked with the reissue as the
fix, or said to be possibly live when the revocation was not confirmed or failed (a fake context), the fix never a
command that needs the lost token; `operator-token set` refusing an existing item (nothing read), a user's, an invalid
and a malformed token (naming the reissue), then storing the admin's from stdin, after which changing commands work
again; the lockout of a lost item recovered by `operator-token reissue` (every refusal on the way names it, a new token
in the item and never printed, labelled and issued by its admin, changing commands working again, a second reissue
refused), revoking the operator token's own token (done and said, the dead item refused with the reissue as the fix, a
reissue after deleting it; revoking another token silent; a one-command token's own revocation said for it), disabling
the operator token's own account (said, a reissue for the other admin), the reissue's `--as` among several admins (a
user refused, a usage error) and a token it cannot store revoked; every state-changing command refused without a token,
with a non-admin token and with an invalid one, nothing written then and no secret read; `CIRCLE_HUB_TOKEN` taken out of
the environment; read-only commands as the token's account with `--as` checked against it; a locked keychain item (a
fake `security` tool, the deployment's keychain service) costing listings a notice and refusing a changing command with
messages that name the operator token by the platform's `OPERATOR_TOKEN_ITEM.label` and never its `VAULT_KEY_ITEM.label`;
the pack lifecycle with the publish right, a refused publication, assignments, activation, withdrawal and
the user's view; control sequences in a pack title, a resource name and an argument shown as escapes; resources with
usage errors, origins, plaintext and settings, credentials from stdin with the password stored as Base64(SHA-512) and a
real login and read through the stub with it, names-only listings, disable, enable and reset; a wrong
password stopping a separately assembled "running Hub", `secret set` and `reset-login` clearing the vault's state and
saying no restart is needed, the running assembly logging in once with the new value at its next read and keeping its
token after a reset, a new assembly logging in again; listings, a reset and the refusals of `secret set` and `knowledge
sync` on a deployment without a vault key; knowledge sync over the synthetic build site with produced, skipped and
failed builds and exit codes, a second sync that skips the produced build and writes no `tree_root` or `tree_node`,
`--line`, `--dry-run`, `--include-unreleased`, roots of both name families and a diff that shows the added command;
named documents put, listed, shown, replaced, idempotent, oversize and bad names refused, non-admins answered as for a
missing doc, nothing stored then; and
a scan of every printed line, the assemblies' log lines included, for every secret.
`operator-token.test.ts` (9): the keychain item written only through stdin of `security -i` and read back through
keychainStore, never overwritten, scrubbed errors, a locked keychain, errors naming the operator token on any account
(the platform's `OPERATOR_TOKEN_ITEM`), the
deployment's keychain service from the settings (a disagreeing variable refused) or the configuration, the token form, the
environment variable, with a fake tool; the same with the real `security` tool against a throwaway keychain file on macOS,
skipped elsewhere, which is not a pass; secrets from a pipe and from a terminal without echo: arrows, function keys and
bracketed paste dropped, a character split across reads, invalid UTF-8, Ctrl-U, cancellation, a terminal that closes.
`testing-real.test.ts` (5): the smoke test (list packs, start a run on the agile stub's synthetic mind map through a real
resource, the text naming the run record and its slot schema read by that reference, submit, accepted, the receipt
naming its stored result, with its call-log lines); a production run of a fact-only synthetic pack through the real
engine (the text's counts, per-requirement counts, problems before the items and the whole result read by reference); the
neutral answer with the reason in the admin note only; the default publication of a synthetic repository tree with the
product pack activated, `publishPack` with and without activation, and `knowledgeSync` producing, then skipping; pack
discovery and staging. Pack functions run in the real sandbox (sandbox-exec where available; elsewhere
`requireOsIsolation: false`, which synthetic tests may use).

## Deviations from the brief

- **Extra commands**: `pack grant-publish|revoke-publish` (publishing needs a publish right and nothing else grants it),
  `resource enable` and `resource reset-login` (the connectors ask for `resetLogin` to be exposed), `resource add --setting`
  (resources need deployment settings such as the root ids of the agile tree), `knowledge sync --recheck
  --include-unreleased` (the knowledge package's parser), `knowledge roots --as` and `diff --as`, `operator-token set`
  (the owner's open question of the last round, asked for by the integrator), `operator-token reissue` (the break-glass
  path two reviewers asked for: without it a lost item or a revoked operator token left only SQL).
- **The keychain item is written by this package** with `security -i` over stdin, not yet by hub/platform's
  `keychainStore.write`, which the platform offers now (Needs); it is read through `keychainStore`.
- **The keychain service** of the operator token is the deployment's, resolved like the vault master key's (the data
  root's settings, else `CIRCLE_HUB_KEYCHAIN_SERVICE`, else `circle-hub` as the brief says), so a second deployment on the
  same Mac keeps its own operator token whether or not the shell sets the variable.
- **hub/knowledge's `knowledgeCliCommand` is not registered**: it acts as `--as` without the operator token. The `knowledge`
  command here uses the knowledge package's `parseKnowledgeSyncArgs`, `knowledgeSync` and `formatSyncReport` and adds the
  token rule, `roots` and `diff`.
- **`resource list` and `secret list` are admin-only**: the connectors' `listResources` gives other accounts rows without
  addresses, the console's ResourceCatalogPort gives them nothing; the CLI follows the port.

## Needs from other packages

The server core's requests of the last round (placeholder tests, the command-time assembly, `CIRCLE_HUB_TOKEN`, `token
issue --raw`, the operator token for built-ins), the engine's (`CallContext.adminNote`), the connectors' (re-reading the
session entry, `ResourceAdmin.describe`, now used by `secret set`) and records' (`checkVaultKey`)
are done. Open:

- **platform (`hub/platform`)**, still uncommitted in the shared worktree: the item labels are adopted (the store is made
  with `OPERATOR_TOKEN_ITEM`, `aboutToken` no longer rewords anything, the tests follow `VAULT_KEY_ITEM.label` and
  `OPERATOR_TOKEN_ITEM.label`), so hub/server is to be committed with or after hub/platform. Offered by the platform's
  README and not adopted in this review round (not review findings; to switch once hub/platform is committed): (1)
  `deploymentKeychainNames(env).operatorToken` in place of `deploymentKeychainService` (it refuses an unset
  `CIRCLE_HUB_DATA_DIR`, which the configuration requires anyway); (2) `keychainStore(...).write(tokenBytes(token))` in
  place of the `security -i` write of `keychainOperatorTokens`, with the platform's `runCommand` for the throwaway keychain
  test; (3) its `OPERATOR_TOKEN_ACCOUNT` in place of this package's copy. Still open: `<data dir>/packs` (extracted packs,
  read-only trees) is derived data: leave it out of backups and restores and do not treat it as unknown.
- **knowledge**: `knowledgeCliCommand` should take the acting admin from the caller (the operator token) rather than
  `actingAdmin(--as)`, or be left to the assembly as now.
- **connectors**: `listResources` and the catalog port disagree for non-admins (Deviations).

## Open questions

- Should `serve` refuse to start where sandbox-exec is missing (now a notice: the console and listings still work)?
- Should a dry-run `knowledge sync` need the operator token? It does now, because its reads store source artifacts.
- Should `init-admin` also grant the first admin the publish right (now an explicit `pack grant-publish`)?

Smoke reports a candidate count. With no checkable text the result fails and asks for a text-bearing read.
Attribute-only XML/HTML responses are checked by the same rule.

Smoke validates every --read and both regular log files before any CLI read. Failures report fixed causes and next
actions (log rotation/size, exports, identity mismatch, decoding, or the missing CLI read line with its exit code).
The protocol-code field contains only registered connector/core codes; local checker failures are separate prose.
Raw CLI errors, response text and paths are never copied into the report line.

Smoke decodes strict UTF-8 first. If that fails, it keeps only wholly ASCII canaries, whose text is invariant under the supported ASCII-compatible encodings; it does not guess a charset.
NUL-bearing originals or non-UTF8 originals without an ASCII canary fail with a fixed encoding-limit reason and a request for a UTF-8 read. The read outcome stays separate. A non-UTF8 check covers only these ASCII canaries, not the text in other encodings.

## Needs from connectors

Export a reusable credential-value check from hub/connectors/api.ts so CLI dry-run and writes share exactly one rule.
Until that API exists, import temporarily mirrors the current 1–4096 character rule and rejects C0/DEL controls,
including raw Basic components and the composed header. Tests compare rejected boundaries with ResourceAdmin itself.
All resources are validated before any write, in dry-run too; I/O failures after validation remain independent writes
and completed resources are disclosed immediately. No connector implementation is changed by this task.

Import reports empty values separately from missing keys. Either refuses the entire import, explicitly says no
credentials were written, and points to correcting the named keys and repeating --dry-run. Target errors reuse the
resource-list and credential-name hints of secret set.

产品包的变量归属核对由装配注入 `productVariableNameAvailable`，在发布事务已持有名字锁时检查密钥历史和部署定义引用，冲突只回“名字不可用”。`var set` 通过包登记公开接口核对所属包所有版本的固定模式和引用处输入上限，其他尚未设置的变量仅用合成默认值辅助大小检查，不设置它们，不让真实同步使用默认值。并发发布或其他引用变量改变时拒绝本次写入并要求重跑。`var list` 包含未设置和不合声明的行，设置了无人使用的名字只作说明。
