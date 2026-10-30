# hub/platform

Persistent single-machine deployment of the Hub on macOS: the data root, a socket-only PostgreSQL from the pinned
embedded-postgres binaries, the deployment's keychain items (the vault master key and the operator token), backups and
restores with SHA-256 manifests, the user LaunchAgent for `circle-hub serve`, deploy with automatic recovery, rollback,
and a backup rehearsal. The Hub runs as the
invoking user and listens on loopback by default; an internal listener requires explicit settings. Model: the deployment decisions in `docs/hub-r4-architecture.md` (section 1
item 4) and D01 R[6] (a deployment instance carries an environment class; endpoints and credential references live only
in the deployment instance).

Also owned here: `scripts/verify-postgres.ts` (CI check; its logic is `verify.ts`) and `bin/circle-hub` (the command entry).

## Explicit internal listener

The default listener stays `127.0.0.1`. To create a shared deployment on a specific internal IP, set
`CIRCLE_HUB_HOST` and `CIRCLE_HUB_ALLOWED_HOSTS` before `init`. The latter is a comma-separated list of exact lower-case
DNS names or IP literals, without ports, schemes, credentials, paths, wildcards or empty entries. The platform stores
both declarations in `config/platform.json`, pins them against environment drift, supplies them to the service and
shows them in `status`. Older settings without either field keep the loopback default. Non-loopback listeners require
an explicit allowed list; wildcard listeners and public IPs are refused. Address examples in tests use documentation
subnets. This is not TLS: a token sent over internal HTTP can be observed by an intervening network observer.

Host and Origin must use a declared host and the configured listener port. Console form POSTs additionally require the
Origin authority to equal the request Host; an absent Origin remains usable by non-browser clients. A TLS-terminating
reverse proxy requires the explicit `CIRCLE_HUB_PROXY_ORIGIN` HTTPS origin, whose host appears in the allowed-host list
and whose authority differs from every direct HTTP authority, and `CIRCLE_HUB_PROXY_PEER`, the proxy's exact source IP.
The proxy preserves that authority as Host; the Hub checks the connection's peer address and never trusts forwarded
headers. Restrict this address so only the trusted proxy can connect from it. Direct HTTP and proxy HTTPS origins remain
separate, including their scheme. This is IP-level trust, not process authentication: choosing `127.0.0.1` trusts every
local process able to connect. Local tool
installation can use an internal address only when this data root's existing deployment settings lock the exact IP and
port and all supplied environment values agree. A client without that trusted lock still accepts loopback only.
Configure the target and firewall before exposing the service; this setting does not itself configure network access.

## Built-in HTTPS

Owner decision 74 (2026-10-31): the Hub can serve HTTPS itself, so the web console and Circle reach it on an internal
address without a separate TLS proxy. `init --https-port <p> [--https-host <ip>]` (or `CIRCLE_HUB_HTTPS_PORT` and
`CIRCLE_HUB_HTTPS_HOST` at init) pins `https_port` and `https_host` in the deployment settings; a non-loopback HTTPS
address needs the allowed-host list, the port may not be the HTTP port, and a TLS proxy and the built-in HTTPS are
exclusive. The service environment carries both values to `serve`, which opens a second listener beside the HTTP one
(the HTTP listener keeps its own address, loopback by default). A variable that disagrees with the settings, or that
would switch HTTPS on behind them, is refused like every other pinned value.

`tls init` creates a private certificate authority for this data root (EC P-256, ten years, path length 0) and a
server certificate it signs (EC P-256, 397 days, serverAuth) for the HTTPS listen address, every allowed host,
`localhost`, `127.0.0.1` and `::1`; `tls issue` signs a new server certificate with the same authority (after the
allowed hosts change, or before the old one ends); `tls init --renew-authority` replaces the authority, after which
every client must trust the new one; `tls status` prints the authority's SHA-256 fingerprint, the names and the days
left, and says when the certificate no longer covers the settings. The certificates are encoded and signed with
node:crypto (`tls.ts`), not openssl, whose LibreSSL and OpenSSL flags differ between macOS and Linux. The files live in
`tls/` (0700): `ca.crt`, `ca.key` and `server.key` owner-only, `server.crt`; every read refuses a symlink, a file of
another account or a key readable by others. `tls/` is not backed up (backups copy objects, vault and config): a
restored deployment runs `tls init` and its clients trust the new authority. `serve` refuses to start with HTTPS
configured and no valid pair, and warns in the operator's log when the certificate ends within 30 days; `status`
shows the HTTPS address and the days left. Browsers import `ca.crt` (system keychain or browser settings); Circle
names it in `trust_cert_files`. Check the fingerprint before trusting it.

## Data root

`~/Library/Application Support/circle-hub`, or `CIRCLE_HUB_DATA_DIR` (the name hub/config reads too; there is no second
name). Every directory is 0700.

| Path | Content |
| --- | --- |
| `db/` | PostgreSQL data directory |
| `run/` | the unix socket (0700) and `platform.lock` |
| `objects/`, `vault/` | written by the records package (objects 0400, vault entries 0600) |
| `packs/` | read-only pack trees the server's pack registry extracts from the objects (`<pack digest>/`, `.quarantine/`, `.tmp-*`; directories 0500, files 0400): derived data, never backed up, left as it is by restores and set-asides (`layout.packs`, decisions 5, 6) |
| `logs/` | `deploy.log` (JSON lines), `postgres/postgresql-<weekday>.log`, `postgres-start.log`, `hub.out.log`, `hub.err.log` |
| `backups/<time>[-label]/` | `database.dump`, `objects/`, `vault/`, `config/`, `manifest.json` (`circle-hub-backup@3`) |
| `releases/<id>/` | one deployed copy per commit with its own `node_modules` and `release.json`; `releases/deployments.jsonl` |
| `releases/operation.json` | progress of a deploy or rollback that has not finished (`circle-hub-operation@1`) |
| `current` | relative symlink to `releases/<id>` |
| `config/platform.json` | the deployment instance (`circle-hub-platform@2`): environment class, HTTP port, database name, role and socket port, keychain service and account, backups kept, optional node path |
| `tls/` | the built-in HTTPS: the private certificate authority and the server certificate it signed (`tls init`); never backed up |
| `set-aside/<time>-<reason>/` | data moved out of the way by a failed deploy, a rollback or a failed restore; never deleted automatically |

## Commands

`circle-hub init --environment <test|shared|production> [--port <p>]`, `db start|stop|status`, `key init [--set-aside-vault]|status|export --confirm|import`,
`service install|uninstall|start|stop|status`, `backup [--keep N]`, `restore <dir>`,
`deploy [--source <dir>] [--commit <rev>] [--copy]`, `rollback`, `rehearse [--keep]`, `status`. Exit codes: 0 ok,
1 failure, 2 usage, 3 "not running / not present" for status commands. All output is Chinese; the environment classes
and their labels come from `ENVIRONMENT` and `labelOf('environment', …)`. A `CIRCLE_HUB_*` name that neither hub/config
nor the platform knows (a typo such as `CIRCLE_HUB_DATADIR`) stops every command before it runs, as hub/config does.
`backup`, `restore`, `deploy` and `rollback` print the data root they act on first.

**Operator commands need no exported variables on the machine that hosts a deployment.** `bin/circle-hub` fills every `CIRCLE_HUB_*` name the shell has not set from the deployment settings (`operator-env.ts`: the data root `CIRCLE_HUB_DATA_DIR` names or the default one; the same values `serviceEnvironment` gives the service). An explicit variable wins; with no settings file (a development checkout) nothing is added and the command reports the missing configuration itself.

The server CLI delegates with `isPlatformCommand(argv[0])` and `runPlatformCommand(argv, io)`; `io.allowVariables` names
the `CIRCLE_HUB_*` variables the server CLI reads itself. `bin/circle-hub` runs `hub/config/guard.ts` first, then
`hub/server/cli.ts` when present, otherwise `hub/platform/cli.ts`; both export `main(argv): Promise<number>`. A CLI module
without `main`, or a `main` that returns no integer, ends with exit 1 and a message naming the module.

## Decisions

1. **PostgreSQL**: initdb, pg_ctl and postgres from `node_modules/@embedded-postgres/<platform>-<arch>` of the release that
   runs (deploys switch binaries with the release). `initdb` only when `PG_VERSION` is missing, and never into a non-empty
   directory. A managed `circle-hub.conf` (included from `postgresql.conf`) and `pg_hba.conf`/`pg_ident.conf` are
   rewritten at every start: `listen_addresses = ''` (no TCP at all), one socket in `run/` with
   `unix_socket_permissions = 0700`, logging collector with weekday rotation, UTC. `start` refuses a data directory whose
   major version differs from the binaries and prints the export and import steps (backup with the old release, restore
   into a new empty data root with the new one). The Hub database and its role are created only by `init` and `restore`
   (`ensureDatabaseRunning(control, { create: true })`); every other caller, `serve` included, refuses a missing database,
   so a mistyped name can never produce an empty database that looks healthy.
2. **Authentication and roles** (documented in `postgres.ts` and `roles.ts`): no password exists. The socket directory and
   socket are owner-only, and `pg_hba.conf` has two peer lines through the ident map `owner`: the superuser role may
   connect to every database, the application role only to the Hub database (PUBLIC may connect to `postgres` and
   `template1` and create temporary tables there). The ident map lets only the
   owning operating-system account in, as one of two roles. Its own superuser role owns the Hub database and every object
   in it and runs initdb, the migrations, pg_dump and pg_restore. The application role `circle_hub`, which the running
   server uses, is not a superuser and owns nothing: the owner of a database owns its `public` schema
   (`pg_database_owner`), and a schema owner may drop the tables in it whatever their grants say, so `ensureDatabase`
   creates the database without `OWNER`, revokes everything from `PUBLIC` and grants the application role `CONNECT`
   only; the migrations, run as the superuser role, grant it the rest (records decision 16: SELECT and INSERT on the
   history tables, a few column UPDATEs). So the running server can neither `DELETE`, `TRUNCATE`, `DROP`, `ALTER` nor
   `DISABLE TRIGGER` on the append-only tables (all 42501) nor run superuser-only statements such as
   `COPY … TO PROGRAM`. An application role named like the superuser role is refused. Other local users, other roles and
   TCP are refused. The platform's own sessions set every connection field explicitly (`sql.ts` `sessionConfig`):
   node-postgres would otherwise take `PGOPTIONS`, `PGSSLNEGOTIATION`, `PGREPLICATION` and `PGCLIENTENCODING` from the
   operator's shell (checked: a read-only `PGOPTIONS` broke `CREATE ROLE`, `PGSSLNEGOTIATION=direct` and
   `PGREPLICATION=database` broke every connection). PostgreSQL tools get a minimal environment without `PG*`.
3. **Deployment instance** (D01 R[6]): `config/platform.json` is written once by `init` and is the only source of the HTTP
   port, the database name, role and socket port, and the keychain service and account. `init` takes them from its flags
   and from the `CIRCLE_HUB_*` variables set at that moment, then pins them. Afterwards a variable may repeat a value but
   never change it: one that disagrees is refused with its name and both values. An `@1` file (without database names) is
   read with the names it implied (`circle_hub`, `circle_hub`, 5432) and never rewritten. The application role of a new
   deployment must match `^[a-z_][a-z0-9_]{0,62}$`, the only names the records migration grants (`grantRuntime`);
   hub/config accepts more, so `init` refuses the rest before anything is written. A file pinned earlier with another name
   is still read (status, backup, `db`), but `deploy` refuses it before anything runs and prints the `ALTER ROLE … RENAME`
   that fixes it.
4. **Keychain**: a deployment has two generic password items under one keychain service, each holding 32 bytes as 64
   hexadecimal characters: the vault master key (service `circle-hub`, account `vault-master-key`, both pinned per
   deployment) and the operator token of the server's administrator commands (the same service, account
   `operator-token`, `OPERATOR_TOKEN_ACCOUNT`). That account is reserved, because the two would be one item: `init`
   refuses it for the vault master key (`CIRCLE_HUB_KEYCHAIN_ACCOUNT=operator-token`). Settings that name it anyway
   (edited by hand, or written by an earlier version) are refused before any `security` call by `key init|status`,
   `hubKeyProvider` and `deploymentKeychainNames` (`status` shows the reason in its key line), and before anything stops
   or launchctl runs by `deploy`, `rollback` and `service install|start` (`keychainNamesFor` in `context.ts`): `serve`
   refuses that key, so a deploy would fail only after the service stopped, a rollback after the data moved, and an
   installed service would be restarted by launchd every 10 s. `service stop`, `uninstall` and `status` still work.
   `keychainKeyProvider` refuses the account whatever its `item` says (it always reads the vault master key), and
   `keychainStore` refuses it together with `VAULT_KEY_ITEM`. **Names**: one rule, `settingsKeychainNames`, gives both
   items (`{ vaultKey, operatorToken }`, each `{ service, account, item }`, ready to spread into `keychainStore`) from a
   data root's settings, for the platform's commands (`keychainFor`; data root `CIRCLE_HUB_DATA_DIR`, else the default
   root) and for `deploymentKeychainNames(env)`, the resolver of a process whose data root `CIRCLE_HUB_DATA_DIR` names
   (the server; `hubKeyProvider(env)` resolves through it, so the vault key and the operator token cannot diverge): that
   root's settings when it has them (a disagreeing `CIRCLE_HUB_KEYCHAIN_SERVICE` or `_ACCOUNT` is refused, as
   everywhere); a root without settings (a development root) takes the variables (checked against the keychain name
   rule, refused by name), else the defaults. Without `CIRCLE_HUB_DATA_DIR` (or with it empty) it refuses instead of
   reading the default root, as `ensureHubDatabase` refuses: so for a data root with settings the two paths name the
   same items, and otherwise one of them refuses. It reads the settings file only and never asks the keychain.
   **Writing**: `keychainStore().write(value)` copies the bytes the view really holds (`new Uint8Array(value)`: a
   subclass that misreports `byteLength` or `length` changes nothing), takes exactly 32 of them (anything else is
   refused before any call), refuses an existing item (and runs `add-generic-password` without `-U`, so an item that
   appeared meanwhile makes `security` fail with 45 instead of being replaced; the integration test checks this on the
   real tool), sends the value only through stdin of `security -i`, never a command line, then reads it back and
   compares in constant time. The caller's bytes are left as they are; the store's own copies (the copy it writes, the
   decoded read-back and the array the read-back returns) are zeroed. The hexadecimal input line and the tool's output
   are strings and cannot be zeroed. `init()` is `write` of 32 random bytes. Reading never creates an item; any error is
   fatal; tool output is scrubbed of anything key-shaped. **Messages** name the item (`item`; the constants are in
   `keychain-items.ts`): `VAULT_KEY_ITEM` "密钥库主密钥" (密钥库 is the design standard's term for the vault,
   `docs/design/object-standard.md`) with its hints, `key init` when missing and why it is never replaced;
   `OPERATOR_TOKEN_ITEM` "操作令牌" without hints, the server decides its advice. Without `item` a store names the
   operator token for its reserved account and otherwise a neutral "钥匙串项" without advice; `keychainKeyProvider`
   always names the vault master key. Every platform message that names either item, the CLI's included, takes the
   label from these constants. Every `security` call has a 60 s limit: a locked keychain waits for
   its unlock dialog, and a server stuck there would never be restarted by launchd; a timeout says to unlock the keychain.
   `keychainKeyProvider` (and `hubKeyProvider(env)`) implement the records package's `KeyProvider` and cache the key per
   process. Neither item is in backups.
   **Boundary**: `add-generic-password` without `-T` trusts the program that created the item, `/usr/bin/security`, so
   any process running as the deployment user can read either item without a prompt
   (`security find-generic-password -s circle-hub -a vault-master-key -w`; the keychain integration test reads it back
   exactly so). The keychain keeps the values out of backups, out of files and away from other accounts; it does not keep
   them away from code running as the same user, for example a dependency's install script during `deploy`. The
   security CLI offers no narrower access list for an unattended service; a dedicated keychain with its own password and auto-lock
   would need an unlock step after every login.
5. **Backups** (`circle-hub-backup@3`): one `REPEATABLE READ` transaction refuses an application role that owns anything,
   large objects and default privileges included, or holds more than its grants (decision 12; objects it owned would
   belong to the restoring superuser role after a restore, without the privileges their owner had, and its default
   privileges would come back with the dump and fail the restore's own check, so such a backup could never be restored as
   taken), exports a
   snapshot, computes per-table row counts and digests and the application role's privileges (`rolePrivileges`), and
   `pg_dump -Fc --snapshot` dumps that exact snapshot; then `objects/`, `vault/` and `config/` are
   copied (after the dump, so every object a dumped record names is present), keeping file modes. `packs/` is not
   (`FILE_AREAS`): its trees are derived from the objects, and the server's registry builds them again from the restored
   objects at their first use; a manifest that lists a `packs/` path is refused as an unsafe path. Table digest
   (`TABLE_DIGEST` in `sql.ts`): h = SHA-256 of `ROW(t.*)::text` under pinned rendering settings (immune to a column
   named like the alias); rows go into 4096 buckets by the first three hex digits of h; a bucket's digest is SHA-256 of
   its sorted h; the table's digest is SHA-256 of the lines `<bucket> <rows> <bucket digest>` in bucket order. Each
   aggregate holds one bucket only, so PostgreSQL's 1 GB string limit is reached only past about 68 billion rows (checked:
   17,000,000 rows summarise in 39 s; the earlier single aggregate failed there). A backup may run while the Hub writes
   (cron): dot-files and `*.tmp` are never copied (the object store's `.<sha>.<random>.tmp`, the vault's
   `<entry>.sealed.<random>.tmp`, Finder's `.DS_Store`), and a file listed but gone before its copy is skipped and
   reported. Objects unchanged since the previous complete backup (of any manifest version) are hard links to its copy
   after their SHA-256 is checked again; a copy that no longer hashes to its name is replaced by a fresh copy from the
   data root. A database without tables is not backed up when the previous backup had tables (a wrong database).
   `manifest.json` lists every file with size and SHA-256, the table summaries and `database.application_role` (its name
   and privilege entries); the directory is built as `.partial-*` and renamed when complete.
   `pg_dump`/`pg_restore` come from Homebrew libpq by absolute path (`CIRCLE_HUB_LIBPQ_BIN`, default
   `/opt/homebrew/opt/libpq/bin`) and must match the server's major. `backup` prunes to the newest N (settings, default
   14) and never removes the backups the last two deployments or an unfinished operation name. Backups are ordered by
   their manifest's `created_at`, not by name (within one second `<time>` sorts before an earlier `<time>-<label>`); a
   manifest that cannot be read is placed by the time its name starts with. Deployments record
   backups by name, resolved in the data root at use, so the root can move.
6. **Restore**: the manifest is verified first (same file set, sizes, SHA-256; safe paths only; Finder `.DS_Store` and
   AppleDouble `._*` files the manifest does not list are ignored; `@1` and `@2` manifests are refused with the hint to
   restore them with the release that made them: `@2` was written while the database belonged to the application role
   and holds no privileges). Only an empty data root is accepted (no `db/` content, no files in `objects/` or
   `vault/`; extracted pack trees in `packs/` are not data and do not count, so the root of a failed deploy or a rollback,
   whose data was set aside, is empty); nothing is overwritten (exclusive creates); a differing `config/platform.json`
   already in the root is kept and reported. Neither a restore nor `setAside` touches `packs/`: the registry checks a
   tree against its pack digest at every use and builds it again from the objects when it does not match, and trees of
   pack versions the restored data does not have are never used. The database names are those of the settings that
   will apply: the root's own, else the backup's; a
   backup whose application role has another name is refused before anything is created (the dump grants to that
   name). The command refuses while the LaunchAgent is loaded or the Hub port answers (a running server would race the
   restore for the database) and while a deploy or rollback is unfinished. `ensureDatabase` creates the database
   (belonging to the superuser role) and the application role, then `pg_restore --single-transaction --exit-on-error
   --no-owner` runs as the superuser role, without `--role`: every restored object belongs to that role, whoever owned it
   where the dump was taken. The dump's GRANTs are kept: they are what the migration of the release that wrote the data
   gave the application role. The platform does not re-grant through the records package: it may not import it, so it
   cannot know its table list, and the restoring release's `RUNTIME_GRANTS` could name tables the restored schema does
   not have yet (the ownership test shows that a re-grant by `migrateRecords` afterwards changes nothing). The restored
   tables must reproduce the manifest's counts and digests, and the application role must hold exactly the manifest's
   privileges and own nothing. A restore that fails half way stops the cluster and moves its partial state to
   `set-aside/`, so the root is empty again for a retry.
7. **launchd**: `~/Library/LaunchAgents/io.github.circle-platforms.circle-hub.plist`, domain `gui/<uid>` (the login
   session, where the login keychain is unlocked), RunAtLoad, KeepAlive, ThrottleInterval 10, ExitTimeOut 30, Umask 077,
   logs in `logs/`. `ProgramArguments` = node, `current/bin/circle-hub`, `serve`; the node path is the settings' `node`, or
   Homebrew's stable symlink when it is this Node, or this Node; it must be Node 24+. The environment holds only names
   hub/config reads, all explicit and taken from the deployment settings: `CIRCLE_HUB_DATA_DIR`, `_PORT`,
   `_DATABASE_SOCKET_DIR`, `_DATABASE_PORT`, `_DATABASE_NAME`, `_DATABASE_USER`, `_KEYCHAIN_SERVICE`,
   `_KEYCHAIN_ACCOUNT`, plus `PATH`, `HOME`, `USER`. `_DATABASE_USER` is the application role: `serve` (no `--migrate`)
   connects as it and only verifies the migrations. `service install` and `start` refuse settings that give the vault
   master key the operator token's account (decision 4) before launchctl runs. `service stop` is `bootout` (it starts
   again at the next login or `service start`). Failure paths that must keep the service stopped unload it and remove the plist, so the next login
   does not start it; the message says so. The cluster is started by pg_ctl in its own session, so it survives server
   restarts; deploy stops it explicitly.
8. **Deploy** (`deploy.ts`): refuse an application role name the migration cannot grant (decision 3) and a vault
   master key on the operator token's account (decision 4), before the lock is taken, then build
   `releases/<id>` (`git archive` of the commit without `foundation/` and `references/`,
   or `--copy` of a directory that is not a git work tree; then `npm ci --include=dev`, because the PostgreSQL binaries
   are a dev dependency) and check that the release's PostgreSQL major equals the data's and, when the cluster runs, that
   the application role owns nothing (decision 12), all while the Hub keeps running → stop service → port free →
   database running → backup `pre-deploy` → stop database → switch `current` (atomic rename) → start database on the
   release's binaries → migrate with `node <release>/bin/circle-hub serve --migrate-only` and the service environment
   (`MIGRATE_ARGUMENTS`). The roles are
   fixed: the child runs as this operating-system account; hub/server connects as that account's role, the superuser
   that owns the Hub database (hub/config has no variable for it), applies the migrations as that owner and grants
   `CIRCLE_HUB_DATABASE_USER`, the application role, through `migrateRecords(..., { runtimeRole })`; `logs/deploy.log`
   names both roles, and afterwards the deploy checks that the application role still owns nothing (a migration that
   hands it an object is undone like a failed one) → install and start the service (`serve` as the application role,
   without migrating) → `GET /healthz` on loopback until 200 (a body naming another `release` does not count) → record in
   `releases/deployments.jsonl`. Deploying the release that is already current is refused before anything stops. On
   failure: stop the service; only when that succeeded, and if the migration had started, stop the database, set the data
   aside and restore the pre-deploy backup on the previous binaries; point `current` back (or remove it on a first
   deploy); start the previous release when the service was loaded before and `current` is back. If the service cannot
   be stopped, nothing else moves (launchd could keep restarting the failed release against the data being restored).
   If the restore fails the service is unloaded and the message names the backup. From the first change on,
   `releases/operation.json` records the step, the backup and what has been touched; it is removed when the root is
   consistent again. If it remains (the process was killed, or the recovery could not finish), the next `deploy` or
   `rollback` first finishes that recovery and stops; `backup` and `restore` refuse meanwhile and `status` shows it.
   SIGINT, SIGTERM and SIGHUP (Ctrl-C, a closed terminal) do not end a deploy or rollback: the running step finishes
   (its children run in their own process group, so a terminal Ctrl-C does not kill them), then the operation stops and
   recovers like a failure. Every step, failure and recovery action is a JSON line in `logs/deploy.log`. A release id is
   the first 12 hex of the commit (or of the copied tree's digest); a complete release is reused. `--copy` leaves out, at
   any depth, `.env`, `.env.*`, `.npmrc`, `.circle/`, `*.log`, `.git`, `.DS_Store` and `._*`, never reading them, and keeps
   owner-only files owner-only.
9. **Rollback**: allowed only when the last recorded deployment produced `current` and had a previous release that is
   another release; settings whose vault master key account is reserved are refused before anything (decision 4: the
   release rolled back to reads the key when it starts). Verifies that deployment's backup first, then: stop service → backup `pre-rollback` → stop database →
   set aside → restore the pre-deploy backup on the previous binaries → switch `current` → start service → health → record
   (`rollback: true`). A failure before the data moved restarts the current release; after it, the service is stopped and
   unloaded (or the message says it may still run), the progress stays, and the next `rollback` continues: it sets the
   partial state aside and restores again.
10. **Rehearsal**: a throwaway root `chr-*` in the temporary directory with a marker file: init, synthetic records set up
   as the Hub's are (two tables with an identity column and an append-only trigger, created by the superuser role, which
   grants the application role SELECT and INSERT; the rows, with text, JSON, numeric, float, timestamp and bytea values,
   written as the application role), content-addressed objects and vault files, and synthetic extracted pack trees in
   `packs/` shaped as the registry leaves them (a verified tree with directories 0500 and files 0400, one moved to
   `.quarantine/`, one still being built under `.tmp-`); backup, destroy (`db/`, `objects/` and `vault/`, as a failed
   deploy sets them aside; `packs/` stays), restore, compare table summaries, file digests and the application role's
   privileges, check that the manifest lists nothing under `packs/` and that every pack entry (kind, mode, SHA-256) is
   unchanged, and check that the role owns nothing and is still refused
   (42501) DELETE, TRUNCATE, DROP, ALTER and DISABLE TRIGGER on both tables and CREATE TABLE; the root is removed unless
   `--keep` (its read-only directories are made writable first, `removeTree` in `files.ts`).
   **Key loss**: when `security` is available, creates a temporary keychain file under the throwaway root,
   with a one-off service and two random 32-byte items (vault key and operator token). Every security invocation explicitly
   targets that file, including cleanup. Scans every backup file for either value as raw bytes and lowercase/uppercase
   hex; any occurrence rejects the rehearsal without displaying the value. Deletes both items before restore, checks
   that neither is restored, moves the restored vault to `set-aside/<time>-key-loss/vault` and creates a fresh master key.
   The report lists item count, backup hits, remaining items and moved vault file count. If security is absent, key loss
   is explicitly skipped, not passed; the other comparisons still run. The temporary keychain is deleted even with
   `--keep` and on failure. This does not exercise a real deployment or the login keychain.
11. **One lock** (`run/platform.lock`) serialises deploy, rollback, backup and restore. It holds `<pid> <token>`, is
   created complete (written beside it, then hard-linked), and a lock of a dead process is taken over only by the one
   taker that holds `platform.lock.break`, and only while it still holds exactly the dead content. A lock that cannot be
   read (for example empty) is refused with the hint to check and delete it. Release removes only our own lock. Checked
   with eight processes taking over one dead lock at the same moment: the earlier lock let two hold it in 8 of 20 rounds,
   this one in none. Child processes never use a shell.
12. **Application role checks** (`roles.ts`). `inspectRole` (and `roleProblems`, its problem list) names everything that
   lets the application role do more than connect and use its grants: a role attribute (superuser, create database,
   create role, replication, bypass RLS), a role membership, CREATE or TEMPORARY on the Hub database (`ensureDatabase`
   revokes both from `PUBLIC`; a restore recreates the database that way, so a backup that had them could not match),
   CREATE on any schema, and every object it owns in any database of the cluster (`pg_shdepend`; an object in another
   database is named with that database). With the problems it returns the statements that remove them, per database,
   other databases first: `ALTER ROLE … NO…`, `REVOKE <role> FROM … GRANTED BY …`, `REASSIGN OWNED BY circle_hub TO
   <account>` (objects in the Hub database and shared ones), one `ALTER DEFAULT PRIVILEGES FOR ROLE circle_hub …` set per
   default-privilege entry that puts it back to PostgreSQL's built-in default (REASSIGN OWNED leaves these entries, and
   DROP OWNED would also revoke CONNECT and every table grant), `REASSIGN OWNED` then `DROP OWNED` in another database
   (followed by `GRANT CONNECT` on the Hub database, which DROP OWNED revokes), `REVOKE CREATE ON SCHEMA …` and the Hub
   database's `REVOKE ALL … FROM PUBLIC; GRANT CONNECT …`. The hint prints exactly these statements, says when the
   service must be stopped first, and, when the role owned tables (a data root an earlier platform version made),
   that only the migration of the next deploy grants them again; the tests run the printed statements and find no
   problem and unchanged privileges. The checks run, as the superuser role, when `serve` and `serve --migrate-only` start
   (`ensureHubDatabase`), before a deploy changes anything (while the Hub runs) and after its migration, before every
   backup and after every restore; `status` shows the result and `verify-postgres` checks a new cluster. One exception,
   at `serve` only: large objects and default privileges are objects any role may create without a privilege
   (`lo_create`, `ALTER DEFAULT PRIVILEGES` for its own future objects; nothing can be revoked to prevent them) and give
   the application role no power over other objects, so when they are all there is, `serve` starts and writes a warning
   with the fix to stderr (`hub.err.log`) instead of refusing. Backups and deploys still refuse them, because a restore
   could not reproduce them as they were. `rolePrivileges` lists every privilege the application role holds in the Hub
   database, directly, through `PUBLIC` or through a membership: `database CONNECT`, `schema public USAGE`, `table public.records INSERT`,
   `column public.users.role UPDATE` (only where the table privilege is missing), sequences and functions; sorted, with
   no database name, so backups record them and restores compare them.

## Limits

- PostgreSQL major upgrades are not automatic (refused with instructions). Releases are never pruned. Backups are not
  scheduled (no second LaunchAgent); run `circle-hub backup` from cron/launchd if wanted. Stale `backups/.partial-*` and
  `releases/.partial-*` from a killed backup or build stay until removed by hand.
- A backup taken while the Hub runs copies `vault/` after the database snapshot: a vault entry removed in between is
  not in the backup (reported as skipped), and one replaced in between is in its newer form.
- Hard-linked objects share one copy between backups. If that copy is damaged on disk, every backup sharing it fails
  verification; the next backup notices it (the SHA-256 no longer matches) and makes a fresh copy, but older backups keep
  the damaged one.
- Rollback discards data written after the deploy it undoes (it is in `set-aside/` and in the `pre-rollback` backup).
- Table digests depend on row text; columns of OID-like types would differ after a restore (the Hub schema has none).
- Signals are guarded only during deploy and rollback. A backup or restore ended with Ctrl-C leaves `.partial-*` or a
  partial data root (move it aside before retrying). SIGKILL or a power loss during deploy or rollback is what
  `releases/operation.json` covers. If its automatic recovery cannot succeed (for example the previous release was
  removed by hand), handle the data root by hand and then delete that file; until then backup and restore refuse.
- The data root path may not contain double quotes, dollar signs, backquotes, backslashes, commas, single quotes or
  newlines (pg_ctl runs its command through `/bin/sh`), and the socket path must fit in 103 bytes.
- The operator token is not moved. The vault master key moves only through `circle-hub key export --confirm | ssh <destination> circle-hub key import`: 32 raw bytes on a pipe or socket, never a terminal, a regular file, an argument or an environment value. Import uses the destination's key store and refuses to replace a key. On macOS that store is the keychain; on Linux it is the file store (`<data root>/keys/<sha256 of the service and account>.key`, mode 0600, directory 0700) from the platform key-file branch, which implements the same `KeychainStore.write`. After import, `records verify --vault` explicitly authenticates every sealed entry and prints counts only; an empty vault is unknown. It never creates a key-check file.
- A restore and `setAside` leave `packs/` as it is, so trees of pack versions the restored data does not have stay there
  unused (each is named by its digest and checked at every use). To reclaim the space, remove `packs/` by hand while the
  Hub is stopped (`chmod -R u+w` first: its directories are 0500); the registry builds what it needs again.
- `rehearse --keep` keeps the throwaway root with its read-only pack trees: `chmod -R u+w <root>` before `rm -rf`.
- The service runs in `gui/<uid>`: it starts at login, not at boot.
- A data root whose database an earlier platform version created (`OWNER` the application role) is not converted
  automatically: `serve`, `deploy` and `backup` refuse it with the statements that fix it (decision 12). Neither is any
  other role problem fixed automatically: the platform prints the statements and an operator runs them (`psql` from
  libpq). Backups in `circle-hub-backup@2` or older are not restored by this version; restore them with the release
  that made them, fix the ownership, then back up again.
- Code that runs SQL as the application role (a flaw in the server) can still make large objects and default privileges;
  the Hub keeps serving, but backups and deploys refuse until the printed statements have been run. It can also set its
  own session defaults (`ALTER ROLE circle_hub SET search_path = …`, checked), which the checks do not look at;
  superuser-only parameters such as `session_replication_role` are refused to it (42501).
- The privilege comparison covers database, schema, table, column, sequence and function privileges of the application
  role in the Hub database. Type, large-object, language, foreign-data and parameter privileges and default privileges
  (`ALTER DEFAULT PRIVILEGES`) are not compared; the Hub schema grants none, and default privileges or large objects
  the application role owns are refused as owned objects (decision 12).
- Backups are ordered by reading every manifest (`listBackups`), which grows with the number of files they list.
- The role checks prove what the application role may do, not which role a release's `serve --migrate-only` connected
  as. A release that migrates as the application role fails (it cannot create tables); one that hands it an object is
  undone by the deploy. A restored database's `CONNECT` grant is the platform's (`ensureDatabase`), not the backup's:
  pg_dump without `--create` carries no database-level privileges.
- Restoring under another application role name is refused, because the dump's grants name the old one; there is no
  renaming of the role.

## How to test

```
node --test "hub/platform/**/*.test.ts"
node scripts/verify-postgres.ts
```

Unit tests inject runners (fake `security`, `launchctl`, `npm`, `git`, PostgreSQL tools). Integration tests start real
clusters from the pinned binaries in temporary roots (`lifecycle`, `sql`, `service`, `cli`, `verify`, `rehearse`,
`roles`, `ownership`, `backup-live`, `deploy-system`); the backup and restore cases skip with a message only when
`pg_dump`/`pg_restore` are absent. Every synthetic table is created by the superuser role, which grants the application
role SELECT and INSERT (`ownerTables` in `test-support.ts`), and its rows are written as the application role.
`roles` creates each problem (attributes, a membership, CREATE grants, owned tables and databases, large objects and
default privileges made by the application role itself, objects in another database, a database of the earlier model),
runs the statements the hint prints and checks that no problem is left and the privileges are unchanged.
`ownership` runs the real records schema: `migrateRecords` as the owner with the application role as `runtimeRole`, the
kit as the application role with `migrate: false`, then every DELETE, UPDATE, TRUNCATE, DROP, ALTER and DISABLE TRIGGER
on each table refused with 42501, before and after a backup, destroy and restore (it imports hub/records and hub/config,
test only). `deploy-system` deploys a synthetic release whose `serve --migrate-only` migrates as hub/server does, and one
that hands a table to the application role. `backup-live` runs backups while synthetic writers use the records stores'
exact file patterns, and backs up a root holding synthetic extracted pack trees (`writeSyntheticPacks` in `rehearse.ts`),
then restores it into a new empty root (no `packs/` appears) and, after `setAside`, into the same root (the trees are
unchanged); `rehearse` also has a case where a file appears in `packs/` during the restore and the rehearsal reports
exactly that; `restore` checks the same with fake tools; `files` runs eight processes against one dead lock and removes
read-only trees without following links; `bin` runs a copy of `bin/circle-hub` against stub CLI modules. `keychain`
checks `write` (stdin only, the order status, add, read-back; an existing item, a racing duplicate, a wrong size, a
view that misreports its size, a read-back that differs or is missing, every copy zeroed, the read-back's included),
the item-named messages (the neutral default included), the reserved account in `keychainStore` and
`keychainKeyProvider`, and `deploymentKeychainNames` (settings, variables, defaults, no data root, a disagreeing or
malformed variable, the reserved account, the same item as `hubKeyProvider`) with a fake `security`. Keychain
integration uses a temporary keychain file made with `security create-keychain` (not on the search list, deleted
afterwards), for `init`, for `write` of an operator token beside the vault master key, and for a write that lost a race
(the check answers "not found" once, then the real `add-generic-password` without `-U` fails with 45 and the first
value stays); a guard
in `test-support.ts` fails any `security` call that does not name it and any real `launchctl` call. `deploy` and
`rollback` refuse reserved settings before their host does anything, and `service install|start` before launchctl runs
(`cli.test.ts`, without a cluster). No test touches the
login keychain, `~/Library`, the user's launchd domain or the network (only loopback servers the tests start).
`environment.test.ts` reads hub/config's public `HUB_ENVIRONMENT` (test only) to keep the platform's copy of the names
equal, and checks that its descriptions of the keychain names say what the platform does (both items under one service,
the account the vault master key may not use).

## Deviations from the brief

- **Deploy order**: the release is built and checked while the Hub runs; the service is stopped *before* the pre-deploy
  backup (brief: backup, then stop). Otherwise records written between the dump and the stop (every MCP call writes a
  call log) would be lost when a failed deploy restores.
- **Restore on deploy failure** happens only when the migration had started; before that no data can have changed (the
  service is stopped), so the release and `current` are put back without a restore.
- **Database roles**: two roles instead of one (see decision 2), and `config/` is included in backups.
- **Extra files and directories**: `set-aside/`, so nothing is ever deleted or overwritten by deploy, rollback or a failed
  restore; `releases/operation.json`, so an interrupted deploy or rollback can be finished.

## Needs from other packages

- **server core** (`hub/server/cli.ts`, `main.ts`, `app.ts`): nothing open. As far as reading the code shows (not
  checked by running the server's tests): `main(argv)` is exported and delegates `isPlatformCommand` to
  `runPlatformCommand`, with `allowVariables: [CIRCLE_HUB_TOKEN]` and the token removed from the platform's environment
  (`platformEnvironment`); `serve --migrate-only` migrates as the operating-system account's role and grants
  `CIRCLE_HUB_DATABASE_USER`; `serve` calls `ensureHubDatabase` and builds the vault with `hubKeyProvider`; `GET /healthz`
  answers `{"status":"ok","release":…}`.
- **server assembly** (`hub/server/assemble/operator-token.ts`, `cli-admin.ts` and their tests): what its README asked of
  this package is here; adopting it is the assembly's change. (1) `deploymentKeychainNames(env)` replaces
  `deploymentKeychainService(env, fallback)`: `.operatorToken` is `{ service, account: 'operator-token', item }`, from the
  same settings, variables and defaults as the vault master key (the fallback argument goes away). Unlike
  `deploymentKeychainService`, it refuses an unset or empty `CIRCLE_HUB_DATA_DIR` (decision 4); every assembly caller
  loads the configuration first, which requires it. (2) `keychainStore({ ...operatorToken }).write(tokenBytes(token))`
  replaces the `security -i` write in `keychainOperatorTokens` (the input line is the same,
  `add-generic-password -s … -a … -w <hex>[ "<keychain>"]`), and with it `runTool` and `securityEnvironment`; a test that
  manages a throwaway keychain can use the exported `runCommand`. (3) Without `item`, a store names "操作令牌" only on
  the account `operator-token`; on any other account (`keychainOperatorTokens` takes an `account` option) it says the
  neutral "钥匙串项" without advice, never the vault master key or `key init`. `aboutToken` replaces 保险库主密钥, which
  no platform message says any more, so it changes nothing; it can go together with passing `item: OPERATOR_TOKEN_ITEM`
  (or spreading `deploymentKeychainNames(env).operatorToken`), which names the operator token on every account. (4)
  `OPERATOR_TOKEN_ACCOUNT` is exported; `operator-token.ts` repeats the value. `toolEnvironment` is not exported: once
  `runTool` goes, nothing in the assembly sets a child's environment (`runCommand` defaults to it). (5) The vault master
  key is now "密钥库主密钥" in every platform message, so `assemble.test.ts:133` and `:156` (`/没有保险库主密钥/`) fail
  and should match `没有密钥库主密钥`; `cli-admin.test.ts:460` and `:466` (`doesNotMatch(/保险库主密钥/)`) now pass
  whatever happens and should say `/密钥库主密钥/` to keep guarding; the comment at `operator-token.test.ts:105` (the
  platform's message and `key init` advice "are the vault key's") no longer holds.
- **records (hub/config, hub/records)**: (1) and (2) of the earlier list are done (the keychain default is
  `vault-master-key` on both sides; `CIRCLE_HUB_LIBPQ_BIN` is tolerated). (3) The retired-name guard and
  the list of names exist twice (`hub/config/{retired,names}.ts` and `hub/platform/environment.ts`, which may import only
  contracts); moving both into contracts would leave one of each. (4) Backups rely on the stores' temporary names:
  every in-flight file is a dot-file or ends in `.tmp` (true today: `objects/<xx>/.<sha>.<random>.tmp`,
  `vault/<entry>.sealed.<random>.tmp`); please keep that rule. (5) `vault/key-check` is created with an exclusive open and
  then written, so a backup at the very moment of the first vault use could copy it empty and the restored vault would
  refuse its key; writing it beside and then linking it, as objects are, would close that window. (6) Ownership (done
  2026-10-22, decision 2): the Hub database and every table belong to the cluster's superuser role, which applies the
  migrations through `migrateRecords(..., { runtimeRole })`; the server runs as the application role, which owns
  nothing, so append-only holds against the server process itself (the `ownership` test proves it on the real schema).
  Unlike the suggestion in the records README (restore with `--role=<owner>`, then `migrateRecords` again), a restore
  keeps the dump's grants and proves them against the manifest (decision 6); a re-grant afterwards changes nothing. If
  grants should ever come from the running release after a restore instead, the server would need a grant-only command
  the platform can run (the platform may not import records). (7) `migrateRecords` checks the `runtimeRole` name only in
  `grantRuntime`, after `migrate()` has committed, so a name it refuses leaves the schema migrated without grants;
  checking the name first would leave nothing half done. The platform now refuses such names at `init` and `deploy`
  (decision 3), and the `ownership` test keeps its rule equal to `grantRuntime`'s. (8) The server's database pool
  (`hub/records/db.ts`, `createPool`) sets `options` and `client_encoding` but not `sslnegotiation` or `replication`, so
  a hand-run `serve` still takes `PGSSLNEGOTIATION` and `PGREPLICATION` from the shell (both broke every connection
  here; see `sessionConfig` in `sql.ts`). (9) hub/config accepts keychain names of 1 to 100 characters
  (`KEYCHAIN_NAME` in `index.ts`), the platform 1 to 64 (`KeychainName`, also the settings schema), so a
  `CIRCLE_HUB_KEYCHAIN_SERVICE` of 65 to 100 characters passes `loadConfig` and is then refused by
  `deploymentKeychainNames`; one rule would refuse it at start. (10) `loadConfig` (`index.ts`, not this package's: it
  owns `hub/config` names only) accepts `CIRCLE_HUB_KEYCHAIN_ACCOUNT=operator-token`, which `hubKeyProvider` then refuses
  at the first key use; refusing it there would stop `serve` at configuration. The descriptions in `names.ts` now say that
  the service holds both items and that this account is reserved. The wording is aligned: the platform says
  密钥库主密钥 too (the assembly's tests, see above).
- **integrator**: add `"verify:postgres": "node scripts/verify-postgres.ts"` to `package.json` (CI's acceptance job calls
  it).
- **acceptance**: check that every key of `serviceEnvironment(...)` is accepted by hub/config's `loadConfig`.

### Recovering after irreversible key loss

Stop the service. Prefer restoring the original keychain items: a new key cannot decrypt the existing vault.
If the original master key cannot be recovered, run `circle-hub key init --set-aside-vault` after stopping the service. It takes the platform lock, refuses a loaded service, an occupied configured port or an existing key, moves only `vault/` to a unique `set-aside/<timestamp>-key-loss/vault`, recreates an empty 0700 vault and initializes the key. The database and objects stay in place and old sealed files remain in the archive. Then run
`circle-hub operator-token reissue` (only when the operator token item is also missing), then
`circle-hub secret import --env-file <file> --key <KEY>=<NAME>… --reason <note>` to reimport the named credentials,
and start the service. Without `--set-aside-vault`, `key init` refuses a nonempty vault before any keychain operation. Resource definitions remain
in the database and `resource list` still works without the vault key. The platform rehearsal covers keys and backup;
the server assembly's synthetic file-key and temporary-keychain tests cover reimport and a fresh login.

Before starting after a backup restore, inspect `secret list` and the latest setting time of every named secret. If its issuer rotated or revoked it after that restore point, run `secret set --name <NAME> --reason <note>` or `secret unset --name <NAME> --reason <note>` before starting. Replacing the vault key does not restore encrypted entries; a registered version with no entry remains unavailable until a new named import.

### Restricted synthetic deployment evidence

The deployment evidence tests use temporary data roots and private PostgreSQL sockets. The new distinct-root restore
case in `backup-live.test.ts` compares complete table digests and object, vault and config bytes/modes, then appends to
the destination to prove the source is independent. `deploy-system.test.ts` already injects a failing HTTP health check;
the pre-deploy database snapshot and the previous `current` release are restored, including removal of the failed
migration's mark. Its launchctl and npm boundaries are simulated.

The `synthetic keychain loss` case in `../server/assemble/cli-admin.test.ts` uses an in-memory security protocol and a
real temporary platform-managed database. It loses both items, runs service stop, `key init --set-aside-vault`,
`operator-token reissue` and `secret import`, verifies a fresh connector login, and starts the actual Hub on a temporary
loopback port with health 200. This recreates named credentials under a new key; it does not decrypt the archived vault
or recover the lost original key. `rehearse.test.ts` also exercises the rehearsal with a synthetic security executable
and in-memory items. No installed security tool is executed by either new case.

For a run that must not reach host state, preload `testing/synthetic-only.ts`. It rejects host security/launchctl calls,
port 7420 and common filesystem access to the default persistent data root, host keychains and LaunchAgents. It also
suppresses user libpq password/service configuration for platform subprocesses. This is a test tripwire, not an OS
sandbox; the isolated fixtures and the explicit omission of real-keychain cases remain necessary. Keep the existing
real temporary-keychain integration tests, but do not count them as passed when they are omitted under this policy.

The launchd plist tests prove RunAtLoad/KeepAlive declarations and simulated service commands, not a machine reboot.
Actual reboot recovery requires an operator observation. This branch records no new observation of a persistent service.

## Linux portability

On Linux, the `circle-hub` service account defaults to `lib/circle-hub` under `/var`; other accounts use
`$XDG_DATA_HOME/circle-hub`, or `~/.local/share/circle-hub` when XDG_DATA_HOME is absent. An explicitly configured
`CIRCLE_HUB_DATA_DIR` still wins. The service runs as the same account as its PostgreSQL cluster. Its systemd user unit
uses `Restart=always`; an administrator must enable lingering and provide the user's systemd and D-Bus session. The
operator must check this manager before an installation, restore or rollback. The macOS LaunchAgent remains unchanged.

Linux keeps the vault master key and operator token as separate 32-byte files under the private `keys/` directory of the
data root; the service account must own the root, the 0700 directory and each 0600 single-link regular file. Symlinks,
wrong owners, wrong permissions, malformed files and replacements are refused. No key bytes enter the backup: `keys/` is
outside its object, vault and config areas. This protects the key against other local accounts, not against the service
account or a privileged administrator. The key-transfer operation and verification of existing encrypted vault entries
are a separate migration step; `records verify` by itself is not evidence that those entries decrypt.

On Linux, an explicit absolute `CIRCLE_HUB_LIBPQ_BIN` is authoritative; otherwise executable `pg_dump` and `pg_restore`
are located through PATH and the command's required tool must match the PostgreSQL server major. Restore into a new empty
data root directly from a verified backup, without `init` first: restore initializes PostgreSQL, copies the saved config
and checks the restored data and grants. A restored deployment with existing administrators does not call `init-admin`;
its owner separately reissues an operator token for an existing enabled administrator. These steps need a synthetic
end-to-end Linux rehearsal and independent review before production migration.

A restored platform setting can name a Node binary that exists only on the source machine. `deploy --node <absolute-path>`,
`rollback --node <absolute-path>`, and `service install --node <absolute-path>` explicitly select the target's Node 24;
the setting from the backup is preserved rather than silently changed. Each override is checked before the service is
stopped or changed. Repeat the option for later operations until an authorized administrator updates the deployment
setting. A failed or missing configured Node on Linux is reported with that recovery action. The service account's home
comes from the effective operating-system account, not an inherited `HOME`; the home and every parent of its systemd
user-unit directory must be controlled by that account or a trusted administrator. Use a correctly configured user manager
and linger. For a durable migration freeze use `service uninstall`, which stops and disables the unit; `service stop`
alone does not disable autostart on the next login or reboot.

### Independent platform review

Antigravity independently reviewed commits `f6640e08` and `385d37d3` by static inspection and reported PASS, with two
follow-up findings. Linux service recovery and restore messages now name systemd while macOS retains launchd; concurrent
key deletion now treats an already removed file as absent and still reports other filesystem errors. Synthetic regression
tests cover both paths. The review did not execute tests; the follow-up tests must be run separately before integration.

### Conservative Linux recovery

Linux operator recovery uses `circle-hub operator-token remove --confirm-only-operator-token` to remove only the
local operator-token file. It refuses without confirmation and never touches the vault master key. Stop the Hub service
before recovery and account for any concurrent readers. Removing the file does not revoke its database token: after
`operator-token reissue --as <管理员>`, use `token list` and `token revoke` to reconcile and revoke old tokens. An existing
item is never overwritten, even when revoked. File permission or integrity failures remain refusals requiring an
administrator to inspect the private directory. FIFO substitutions are rejected without blocking.

systemd lifecycle mutations refuse ambiguous state, missing expected files for loaded units, and loaded units whose
FragmentPath differs from the deployment file. Inherited HOME/USER are replaced by the effective account identity.
Restore guidance requires `service stop` plus `service uninstall` to disable autostart persistently, followed by
`service install` after restore. These changes use synthetic fixtures and do not establish any target-server result.

Recovery follow-up validation on macOS: `npx tsc --noEmit` exited 0;
`node --test --test-concurrency=2 'hub/platform/**/*.test.ts' hub/server/assemble/cli-admin.test.ts hub/server/assemble/operator-token.test.ts`
ran 310 tests: 306 passed, 0 failed, 4 skipped (Linux deployment with a real user manager, Linux empty-root restore, Linux file-key rehearsal,
and the real Linux user-unit lifecycle). This is synthetic macOS evidence, including injected Linux backends; Linux execution remains pending.

Antigravity independently reviewed the fixed commit `7f5c5702599c71c9711a344500bad1c0fd700204` against baseline
`385d37d3c5f8e7e2bb28f68de63dc90b4a992819` on 2026-10-28 and reported PASS for the inspected platform changes.
The review was read-only static inspection of source, diffs and existing synthetic evidence; the reviewer ran no tests
and accessed no real systems, credentials or environment configuration. It covered sandbox alignment, FIFO rejection,
effective-account binding, systemd ownership and contradictory-state refusals, operator-token-only removal, and Node
and restore recovery guidance. This is independent static review evidence for that fixed change set; it does not prove
a complete real Hub migration, production safety, or target-server behavior. This documentation update ran no tests.

Independent integration review: Antigravity reviewed merge `1b845383` against the prior platform review and found no
static conflict with the Linux permission-revocation readiness probe. This review did not run tests or verify a real Hub
migration; the synthetic Linux and integration checks remain separate evidence.


### Final key-transfer synthesis (2026-10-28)

The final branch starts at Cursor change c0b88a6a and merges current hub-redesign, retaining Linux file-key and service fixes.
There is one KeyPipe implementation: bounded binary reads require exactly 32 bytes and EOF within 30 seconds; exports await
write callbacks and fail closed by destroying the output on a 30-second timeout. Errors are fixed diagnostics. Import refuses
existing keys before reading. The explicit `records verify --vault` path uses read-only per-entry AEAD verification adapted from
d0146bc6; no alternate automatic vault verification path remains. Writers must be stopped during verification.

Tests were edited but deliberately NOT RUN because the integrator's full macOS acceptance occupies the machine. No typecheck,
unit, acceptance, Linux, real-key or migration validation is claimed for this synthesis. Added/retained synthetic cases include
32+1-byte overflow, short/oversized input, delayed and absent output callbacks, broken pipes, input timeout, raw binary child
pipes, argv/environment/temp-file disclosure checks, empty/missing/corrupt vaults and read-only verification.

Linux keychainFor now selects the merged fileKeyStore. End-to-end Linux server assembly must still be verified against that
same store (including the actual service user and data root); a successful key import alone does not establish runtime vault
wiring. Real migration decryption requires the explicit vault verification on the restored ciphertext with the imported key.
No real keys, environment files, credential stores or business systems were accessed. Independent review and all execution
validation remain pending; this branch is not merged or pushed.

Source-side timeout or broken-pipe failure cannot prove that the destination did not import: bytes may already have arrived.
The fixed error marks destination import state unknown and directs operators to target `key status`, then
`records verify --vault`, before any retry. A controlled synthetic pipe test covers destination store.write completing before
source timeout/EPIPE and verifies that a repeated import cannot overwrite that key. This new test has not been run.


Final targeted verification (2026-10-28): after merging latest hub-redesign, `npm run typecheck` exited 0. The command
`node --test --test-concurrency=2 --test-name-pattern='stdin shorter|export and import move|real inherited pipe|output callback|export keeps|destination can import' hub/platform/key-transfer.test.ts`
passed 6 tests, failed 0, skipped 0. These cover split 32+1 overflow, destination-key decryption, binary child pipes, delayed
and missing callbacks, EPIPE and unknown destination state. No full suite, acceptance, VM rehearsal or real-key transfer ran.
Earlier targeted evidence: the 7 file-key tests and 12 vault tests passed; the initial 6-file run totaled 67 passed and 1 failed
because the old assertion did not account for the new existing-key preflight. That assertion was corrected to compare the
call count immediately before/after refused transport; its test now passes in the final 6-test command above.
Static wiring is aligned: Linux keychainFor selects fileKeyStore and hubKeyProvider selects fileKeyProvider using the same
resolved deployment root and vault key names. Actual service-user production execution remains unverified. The owner canceled
backup/rehearsal work; the integrator performs the final authorized real pipe. No agent accessed real keys or target systems.
