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

The default listener remains loopback. An explicit non-loopback internal IP requires `CIRCLE_HUB_ALLOWED_HOSTS`, an exact
comma-separated list of lower-case hostnames or IP literals without a port or wildcard. The listener port applies to
each entry. Wildcard and public-IP listeners are refused; callers must separately restrict network access.
An optional `CIRCLE_HUB_PROXY_ORIGIN` names the exact HTTPS origin served by a TLS proxy; its host must be declared and
its authority must differ from the directly listened HTTP authority. It requires `CIRCLE_HUB_PROXY_PEER`, the proxy's
exact source IP. Only connections from that peer can use the proxy authority; forwarded headers do not change the check.

The built-in HTTPS is on when `CIRCLE_HUB_HTTPS_PORT` is set (`HubConfig.https`): a second listener on
`CIRCLE_HUB_HTTPS_HOST` (default `127.0.0.1`) serving the same routes with the certificate and key of `<data dir>/tls`
(`circle-hub tls init`). A non-loopback HTTPS address needs `CIRCLE_HUB_ALLOWED_HOSTS` like the HTTP listener; the
HTTPS port may not equal the HTTP port; a TLS proxy (`CIRCLE_HUB_PROXY_ORIGIN`) and the built-in HTTPS are exclusive.
`CIRCLE_HUB_HTTPS_HOST` without the port is refused.

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
