# config

Part of the records package; decisions and tests are in [../records/README.md](../records/README.md).

- `guard.ts`: side-effect module. Import it first in every Hub entry point: a process that sees any `CIRCLE_SERVER_*`
  variable refuses to start (`HubEnvironmentError`, names only, never values).
- `index.ts`: `loadConfig(env, { allowUnknown })` returns a validated `HubConfig` or throws `HubConfigError` listing every
  problem in Chinese. It reads only the object it is given, never a file.
- `names.ts`: `HUB_ENVIRONMENT`, the only list of `CIRCLE_HUB_*` names, each with its Chinese description. To add a variable,
  ask the records owner; an unknown `CIRCLE_HUB_*` name refuses to start.

Required: `CIRCLE_HUB_DATA_DIR`, `CIRCLE_HUB_PORT`, and one of `CIRCLE_HUB_DATABASE_SOCKET_DIR` or `CIRCLE_HUB_DATABASE_HOST`.
Secrets never come from the environment; they enter through the vault. `CIRCLE_HUB_MAX_UPLOAD_BYTES` is at most 256 MiB
(the credential scan decodes an upload into strings, which V8 caps near 512 Mi characters) and
`CIRCLE_HUB_MAX_REQUEST_BYTES` at most 512 MiB.
