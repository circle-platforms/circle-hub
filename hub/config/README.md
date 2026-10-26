# config

Part of the records package; decisions and tests are in [../records/README.md](../records/README.md) (decision 12).

- `guard.ts`: side-effect module. Import it first in every Hub entry point: a process that sees any `CIRCLE_SERVER_*`
  variable refuses to start (`HubEnvironmentError`, names only, never values).
- `index.ts`: `loadConfig(env, { allowUnknown })` returns a validated `HubConfig` or throws `HubConfigError` listing every
  problem in Chinese. It reads only the object it is given, never a file.
- `names.ts`: `HUB_ENVIRONMENT`, the only list of `CIRCLE_HUB_*` names the Hub reads, each with its Chinese description,
  and `PLATFORM_ONLY_ENVIRONMENT`, the names only platform commands read (tolerated, never read). To add a variable, ask
  the records owner; an unknown `CIRCLE_HUB_*` name refuses to start.

Required: `CIRCLE_HUB_DATA_DIR`, `CIRCLE_HUB_PORT`, and one of `CIRCLE_HUB_DATABASE_SOCKET_DIR` or `CIRCLE_HUB_DATABASE_HOST`.
Secrets never come from the environment; they enter through the vault. `CIRCLE_HUB_MAX_UPLOAD_BYTES` is at most 256 MiB
(the credential scan decodes an upload into strings, which V8 caps near 512 Mi characters) and
`CIRCLE_HUB_MAX_REQUEST_BYTES` at most 512 MiB.

| Variable | Default | `HubConfig` |
| --- | --- | --- |
| `CIRCLE_HUB_KEYCHAIN_SERVICE` | `circle-hub` | `keychain.service` |
| `CIRCLE_HUB_KEYCHAIN_ACCOUNT` | `vault-master-key` (the platform's and the brief's name) | `keychain.account` |

Platform-only names: `CIRCLE_HUB_LIBPQ_BIN` (directory of `pg_dump` and `pg_restore`, read by the platform's backup,
restore and deploy commands). The source of this list is hub/platform `PLATFORM_VARIABLES`: its values that hub/config does
not read. `CIRCLE_HUB_HOME` is not among them (the platform reads the data root from `CIRCLE_HUB_DATA_DIR` and refuses
`CIRCLE_HUB_HOME`), so it still refuses to start.

`drift.test.ts` reads exports of hub/platform (tests only; the production code imports it not) and fails when
the retired-name guard, the platform-only names or the keychain defaults stop agreeing.
