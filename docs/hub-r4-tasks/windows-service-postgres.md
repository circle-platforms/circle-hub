# Windows service and PostgreSQL selection (local preparation)

Scope: a local branch from main with the synthetic Windows stack (baseline, vault and Job branches) replayed on top. Allowed
paths are this task page, `hub/platform/windows-service.ts`, `windows-scm.ts`, `windows-task.ts`,
`windows-service-host.ts`, `postgres-hybrid.ts` and their tests, `hub/platform/postgres.ts`, `sql.ts`, `process.ts` and
`postgres-loopback.test.ts`, the Windows section of `hub/platform/README.md`, `bin/circle-hub`,
`.github/workflows/platform-matrix.yml`, `.github/checks/platform-workflow.test.ts` and `.github/dependabot.yml`. Nothing
here is pushed, deployed or released; the workflow change waits for the owner's approval of a written change note.

The owner's decisions of 2026-10-30 applied here: Windows ARM64 runs the x64 PostgreSQL build under Windows' x64 emulation
("hybrid"; if runner CI disproves it, Windows ships x64 only); the service host calls the Service Control Manager through
koffi, the one dependency exception, pinned to the Circle client's 3.3.3 and loaded only by the Windows adapters, with a
Task Scheduler at-startup task behind the same interface as the fallback; the sandbox policy is not relaxed (pack functions
get no network, file writes or child processes, and Windows pack execution stays `SANDBOX_UNAVAILABLE`); public workflow
changes need the owner's go after a written note; no release or tag without separate authorization.

## What the branch holds

- The stack, replayed commit by commit: one conflict in `hub/rules/sandbox/isolation.ts` (main's Linux isolation kept, only
  the Windows import and its two fail-closed guards added), the lockfile regenerated with `npm install --package-lock-only`
  (only koffi 3.3.3 and its 20 platform packages added, integrity values equal to the stack's), the stack's lockfile repair
  commit dropped as empty. Dependabot ignores koffi and `@koromix/koffi-*`.
- PostgreSQL selection (`postgresBuild`): Windows x64 and ARM64 use `@embedded-postgres/windows-x64` and its `.exe` files
  (main built `@embedded-postgres/win32-x64` and looked for extensionless names, so no Windows host could find them); ARM64
  is marked emulated. Darwin and Linux are unchanged. `postgres-hybrid.ts` installs the lockfile's x64 build on ARM64,
  where npm ci leaves it out because of its cpu field: exact version, SHA-512 equal to the lockfile, no install script
  (its `pg-symlinks.json` is an empty list), x64 PE images only, a record of the architectures beside it.
- Loopback SCRAM transport for hosts without peer authentication: TCP on 127.0.0.1 only, no Unix socket, the superuser role
  everywhere and the application role on the Hub database only, each with its own SCRAM password from the key store,
  everything else rejected; initdb reads the superuser password from a private file; the application role is created from a
  verifier computed client-side; the superuser session checks the data directory before trusting the port.
- The Windows service (`windowsServiceAgent`) with the LaunchAgent and systemd lifecycle contract, its host
  (`runServiceHost`), the koffi binding (`windows-scm.ts`) and the Task Scheduler fallback (`windowsTaskAgent`).
  `bin/circle-hub` turns the host's stop message into the SIGTERM `serve` already waits for, on Windows only.

## Verified and not verified

Verified on macOS ARM64 only: the selection and rendering logic, the SCM state machine and binding against scripted koffi,
the Task Scheduler fallback against scripted tools, a real cluster in the loopback SCRAM transport on the darwin build
(including the server's own SCRAM verifier and every refusal), and the hybrid install with a synthetic package. koffi's
cross-thread callbacks (a native thread and an async worker calling a registered callback while JS keeps its event loop)
were observed in a scratch experiment on macOS ARM64, outside the repository.

Not verified: anything on Windows. The real SCM service, the virtual account, the Task Scheduler task, koffi callbacks on
a Windows thread, the windows-x64 build natively and under emulation, and the loopback transport on Windows are runner
checks in the synthetic platform matrix, skipped elsewhere with their reason. The Windows release readiness verdict stays
"not supported".

## Not wired yet, and needs from other packages

- `agentFor`, `keychainFor`, `hubKeyProvider` and `createPostgres` do not select the Windows adapters; `layout.ts` refuses
  backslashes, so no Windows data root can be created; `serviceEnvironment` gives a POSIX PATH (the host replaces it);
  backup, restore and deploy remain socket-only and the Windows package has no `pg_dump` or `pg_restore`; the database
  passwords need two key-store items; the data root, release and definition need explicit ACLs for the service SID
  (`serviceSid`); the `current` symlink of deploy needs a Windows equivalent.
- hub/testing (`postgres.ts`): it imports `@embedded-postgres/${platform()}-${arch()}`, which is `win32-x64` on Windows;
  acceptance on Windows needs the same mapping.
- hub/server: on Windows `serve` must take the application role's password from the key store into
  `config.database.password` and use `CIRCLE_HUB_DATABASE_HOST=127.0.0.1`; `platformManaged` recognises only the socket.
- PostgreSQL is not stopped cleanly at Windows shutdown (it recovers from its WAL at the next start); the host could stop
  it on PRESHUTDOWN.
