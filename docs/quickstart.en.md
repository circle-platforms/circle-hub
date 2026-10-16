# Deploy and connect Circle

Chinese text is in [quickstart.md](quickstart.md). Field-level shapes stay in [client-api-handoff.md](client-api-handoff.md). This page is the short path: start a hub on one Linux or macOS machine, sign in from Circle, stop, and start again.

`npm run dev:stack` uses a temporary PostgreSQL, development sign-in and synthetic sources. It is the first connection between Circle and a hub. It is not a production deployment. See [SECURITY.md](../SECURITY.md) for that boundary.

## 1. Install Node.js 24

`package.json` `engines` requires Node.js 24 or newer. `.npmrc` sets `engine-strict`, so `npm ci` fails on an older Node. The server, supervisor, worker, `circle-hub` CLI and `dev:stack` check again before they read configuration. An older process exits with `HubEnvironmentError`, names the running version, and points at <https://nodejs.org/en/download>.

```sh
node -v          # v24 or newer
npm ci
```

## 2. Dependency install scripts

`npm ci` installs the `embedded-postgres` dev dependency. The packages that actually have an install script are its eight platform packages (`@embedded-postgres/linux-x64` and the other CPU/OS builds), pinned at `18.4.0-beta.17`. The script only recreates relative symlinks from `native/pg-symlinks.json` already shipped in the tarball. It does not download PostgreSQL and it does not start a database. `package.json` `allowScripts` allows those eight `name@version` entries on purpose. Without the symlinks, the development PostgreSQL can fail to start. Review the script again before changing the pinned version, then update `allowScripts`. The parent `embedded-postgres` package has no install script.

## 3. Start the development stack

```sh
npm run dev:stack
```

Defaults:

- The HTTP port is chosen by the operating system (`CIRCLE_HUB_PORT=0`). An unset supervisor listens on `127.0.0.1:8080`. The development stack does not reuse 8080, so it does not collide with a hub that is already running.
- Developer, approver, service and worker passwords are new random values on every start. They are printed in this terminal and are not stored in Git.
- stdout begins with one JSON line, `type` `dev-stack-ready`, carrying `url`, `login`, `approverLogin`, `scopeId` and `samplePath`. The following lines say what to do next.
- A foreground terminal (stdin and stdout are both TTYs) says to press Ctrl+C. A background or piped process says to send SIGTERM to the printed pid. Either path stops the worker, server and PostgreSQL in order and deletes this temporary database and its artifacts.

For a stable address and passwords, set these before start. Each password must be 12 to 200 characters. A value outside that range refuses to start and the error does not echo the value:

```sh
export CIRCLE_HUB_PORT=8080
export CIRCLE_HUB_DEV_PASSWORD='synthetic-dev-password'
export CIRCLE_HUB_DEV_APPROVER_PASSWORD='synthetic-approver-password'
export CIRCLE_HUB_DEV_SERVICE_PASSWORD='synthetic-service-password'
export CIRCLE_HUB_DEV_WORKER_PASSWORD='synthetic-worker-password'
npm run dev:stack
```

The next-step lines name the Circle commands, for example:

```text
Next, in Circle: /extensions enable hub
Then: /hub login http://127.0.0.1:8080 developer
```

The developer username is `developer`, the approver username is `approver`, and the scope is `scp_lab`. `login.password` in the JSON line is the same developer password.

## 4. Connect from Circle

Circle 1.7.4 has to enable the hub extension before `/hub` exists. The extension's own version is 0.1.0, the hub package version is 0.2.0, and the HTTP API version is 1.0.0. Those three numbers are different. See [compatibility.en.md](compatibility.en.md).

In Circle:

```text
/extensions enable hub
/hub login http://127.0.0.1:8080 developer
```

Use the URL printed by the stack. When Circle asks for a password, use the developer password. For an independent approval, `/hub login` to the same URL as `approver`.

`/hub refresh` counts `GET /v1/tasks?kind=work&limit=20`: work tasks this identity can read in scope, at most 20. That is a different list from `/hub tasks`, which shows the tasks this window stored in `followed()`. `seen to N` is the last event sequence this window consumed, not a task count. Task `phase` stays the protocol value. `admitted` means accepted and not started; `phaseLabel` says `accepted, not started`.

After approval, the protocol field `status` remains `registered`. That word is the registration state. The same view also returns `lifecycle` (the asset lifecycle: `approved` after approval, `running` after it is enabled), `registration` (the same value as `status`) and `statusLabel` (for example `approved`, or `waiting for approval` for a candidate). Circle 1.7.4 prints only `status`, so the current client still shows registered until it prints `lifecycle` or `statusLabel`.

## 5. Stop and start again

- Foreground: Ctrl+C.
- Background: `kill <pid from dev-stack-ready>` (SIGTERM).

The development database lives in a temporary directory. Running `npm run dev:stack` again creates a new database, a new port unless `CIRCLE_HUB_PORT` is set, and new random passwords unless the password variables above are set. A token already stored in Circle does not apply to the new process.

To restart only the HTTP process against the same data, run the supervisor against a PostgreSQL you keep, with `CIRCLE_HUB_DATABASE_CONFIG`. `CIRCLE_HUB_DEV_AUTH=1` is still only for a local synthetic environment.

## 6. What a runtime profile is

A skill run needs a Circle runtime profile. `CIRCLE_RUNTIME_CONFIG` points at a JSON file outside the repository:

| Field | Meaning |
|---|---|
| `circleBin` | Circle executable or CLI entry |
| `circleCommit` | 40 hexadecimal Git characters |
| `circleVersion` | Circle version string |
| `model.kind` | `scripted` or `remote` |
| `model.base_url` | Model endpoint; non-loopback URLs must be HTTPS |
| `model.model` | Model name |
| `model.protocol` | Always `openai` |
| `model.api_key` | Runtime secret. Do not commit it |

After setting the variable and restarting, an identity with `admin.manage` calls `GET /v1/runtime-profiles`, registers what it sees as a `runtime-profile` asset, and a different person approves it. With no profile, a skill run returns `RUNTIME_NOT_CONFIGURED` (409) and the message names the variable and these steps. Registering and approving a skill does not need the profile.

Linux has no process isolation. Skill runs and product-pack Tool/Hook subprocesses need macOS seatbelt. The hub does not fall back to an ordinary process. The code is `SANDBOX_UNAVAILABLE`; the message names the platform and points here. Built-in synthetic dispatch does not enter those subprocesses.

## 7. Name the capability pack before upload

`GET /v1/packs` lists installed capability packs. A source upload may send `x-capability-pack-id`. The hub checks that name before it reads or stores the body.

- Retired ids `lbx-healthcheck` and `apv-case-execute` still return `UNSUPPORTED_VERSION`.
- Any other missing id returns `TARGET_NOT_FOUND`. The message names the id and says to check `GET /v1/packs` first. Without the header, upload behaves as before.
- Task submit rejects an unknown capability pack with `TARGET_NOT_FOUND` before it creates a task.

Circle 1.7.4 uploads and then submits, and it does not send the header. Failing before the upload requires the client to check the pack list, or to send `x-capability-pack-id` on `POST /v1/sources`.

`POST /v1/skillpacks/<name>/runs` accepts a manifest name (the `id` in `skillpack.json`) as well as a `skp_` id. One approved pack resolves to its id. Several approved packs with that name are listed and not guessed. If only candidates exist, the response is `APPROVAL_REQUIRED` and lists those submissions. A token that starts with `skp_` but does not match the id shape is explained; it is not a raw schema regular expression.

A trial with 0 tool calls is still accepted (201). `warnings` on the response says that this submission recorded no calls. A newer submission of the same manifest id with fewer calls warns that the earlier calls are not kept. An identical resubmit (same digest) does not warn again.

## Environment variables

| Variable | Role |
|---|---|
| `CIRCLE_HUB_PORT` | Integer 0–65535. `0` lets the OS choose. Unset means `0` for `dev:stack` and `8080` for the supervisor |
| `CIRCLE_HUB_DEV_PASSWORD` | Stable password for `developer`; empty means a new random password |
| `CIRCLE_HUB_DEV_APPROVER_PASSWORD` | User `approver` |
| `CIRCLE_HUB_DEV_SERVICE_PASSWORD` | Service account `defect-bot` |
| `CIRCLE_HUB_DEV_WORKER_PASSWORD` | Both synthetic workers |
| `CIRCLE_HUB_DEV_AUTH` | Set to `1` to enable development sign-in |
| `CIRCLE_HUB_DEV_IDENTITIES` | Development identity JSON file |
| `CIRCLE_HUB_DATABASE_CONFIG` | PostgreSQL connection JSON |
| `CIRCLE_HUB_DATA_DIR` | Object-storage directory |
| `CIRCLE_HUB_PG_DIR` | Embedded PostgreSQL data directory |
| `CIRCLE_HUB_TLS_CONFIG` | Optional loopback TLS |
| `CIRCLE_HUB_URL` | Hub address used by a worker |
| `CIRCLE_HUB_TOKEN` / `CIRCLE_HUB_TOKEN_FILE` | Caller token. Do not commit it |
| `CIRCLE_HUB_SCOPE` | Caller scope |
| `CIRCLE_HUB_CONNECTOR_PROFILES` | Synthetic or read-only connector config |
| `CIRCLE_HUB_EXECUTION_GATEWAYS` | Execution gateway config |
| `CIRCLE_HUB_OAUTH_PROFILES` | OAuth config |
| `CIRCLE_HUB_PRODUCT_LINES` | Product-line directory |
| `CIRCLE_RUNTIME_CONFIG` | Circle runtime JSON from the previous section. This name is outside the `CIRCLE_HUB_*` prefix |

A process that still has a pre-rename `CIRCLE_SERVER_*` variable set refuses to start. Rename the prefix to `CIRCLE_HUB_` and start again.
