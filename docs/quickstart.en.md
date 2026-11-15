---
nav_order: 2
---

# Quickstart (about ten minutes)

This guide follows the current `circle-hub` commands: install and create the first administrator → `apply` one deployment definition → connect Circle → complete the first run.

> Commands here were checked against the current implementation on a temporary synthetic data root. The minimal definition below is **the same bytes** as [`docs/examples/quickstart-deployment.json`](examples/quickstart-deployment.json) (enforced by tests).
>
> - Platforms: **macOS and Linux (arm64 / x64)**, Node 24; Windows is not supported.
> - Synthetic data only, loopback `127.0.0.1`, and documentation addresses in `192.0.2.0/24`. Never put real credentials, tokens, or production hosts in docs, tests, or CLI arguments.
> - Retired predecessor environment variables must not remain in the process environment, or `circle-hub` refuses to start.

---

## Step 1: Data root, master key, and administrator

For a production single-machine install, use [install.sh](https://github.com/circle-platforms/circle-hub/blob/main/install.sh) at the repository root. In a worktree for a scratch instance:

```bash
export CIRCLE_HUB_DATA_DIR=/tmp/ch-quickstart/d
mkdir -p "$CIRCLE_HUB_DATA_DIR"

./bin/circle-hub init --environment test --port 7420
./bin/circle-hub key init
./bin/circle-hub serve --migrate-only
./bin/circle-hub init-admin
```

- `init` writes `<data root>/config/platform.json` and starts embedded PostgreSQL.
- `key init` stores the vault master key under `<data root>/keys` (no OS keychain).
- `serve --migrate-only` applies migrations.
- `init-admin` creates administrator `admin`, writes the operator token under `keys/`, and prints the console password once.

Unset `CIRCLE_HUB_TOKEN` before `./bin/circle-hub serve`, or the server refuses to start.

---

## Step 2: Write a deployment definition and `apply`

After the service can run and the first administrator exists, one definition replaces separate `pack grant-publish` / `pack publish` / `pack assign` / `doc put`:

```bash
./bin/circle-hub apply docs/examples/quickstart-deployment.json
```

Run from the repository root so the path to this definition file resolves; inside the file, `directory` is relative to the definition file's own directory (not the current working directory) and points at `packs/workflow/test-bed`. Schema must be `deployment@2` (`contracts/src/deployment.ts`). Identical rows are skipped; differences are listed without overwrite. If the administrator has no publish right yet, apply grants it before publishing. `knowledgeSync: []` means no sync targets on purpose.

Full file (must match `docs/examples/quickstart-deployment.json` byte-for-byte):

```json
{
  "schema": "deployment@2",
  "packs": [
    {
      "ref": "test-bed@1.3.3",
      "directory": "../../packs/workflow/test-bed"
    }
  ],
  "workflowAssignments": [
    {
      "pack": "test-bed",
      "user": "admin"
    }
  ],
  "documents": [
    {
      "name": "bed-topology",
      "sha256": "65b61e85e8f94afd36035cead54ef6cd29c579089aee3056ad387192af8cc45a",
      "size": 1228,
      "bytesBase64": "ewogICJzY2hlbWEiOiAidGVzdC1iZWQtbWFuaWZlc3RAMSIsCiAgImJlZHMiOiBbCiAgICB7CiAgICAgICJuYW1lIjogImJlZC1hIiwKICAgICAgImRldmljZXMiOiBbCiAgICAgICAgeyAibmFtZSI6ICJhZmFteDAiLCAidHlwZSI6ICJsb2FkLWJhbGFuY2VyIiwgInByb2R1Y3QiOiAiZmFteCIsICJpcHY0IjogWyIxOTIuMC4yLjEwLzI2IiwgIjE5Mi4wLjIuNzQvMjYiXSwgImlwdjYiOiBbIjIwMDE6ZGI4OjE6OjEwLzY0Il0sICJpbnN0YWxsZWQiOiB7ICJidWlsZCI6ICJSZWxfRkFNWF8xMF82XzFfOCIgfSB9LAogICAgICAgIHsgIm5hbWUiOiAicm91dGVyMCIsICJ0eXBlIjogInJvdXRlciIsICJpcHY0IjogWyIxOTIuMC4yLjEvMjYiXSwgImlwdjYiOiBbXSB9LAogICAgICAgIHsgIm5hbWUiOiAiY2xpZW50MCIsICJ0eXBlIjogImNsaWVudCIsICJpcHY0IjogWyIxOTIuMC4yLjgwLzI2Il0sICJpcHY2IjogW10gfSwKICAgICAgICB7ICJuYW1lIjogInNlcnZlcjAiLCAidHlwZSI6ICJzZXJ2ZXIiLCAiaXB2NCI6IFsiMTkyLjAuMi45MC8yNiJdLCAiaXB2NiI6IFtdIH0sCiAgICAgICAgeyAibmFtZSI6ICJjb25zb2xlMCIsICJ0eXBlIjogImNvbnNvbGUiLCAiaXB2NCI6IFsiMTkyLjAuMi4xNDAvMjYiXSwgImlwdjYiOiBbXSB9CiAgICAgIF0sCiAgICAgICJzZXJ2aWNlcyI6IFt7ICJob3N0IjogInNlcnZlcjAiLCAiaXAiOiAiMTkyLjAuMi45MCIsICJwcm90byI6ICJ0Y3AiLCAicG9ydCI6IDgwIH1dLAogICAgICAicmVzZXJ2ZWQiOiBbIjE5Mi4wLjIuMS0xOTIuMC4yLjkiLCAiMTkyLjAuMi42NS0xOTIuMC4yLjY5Il0KICAgIH0sCiAgICB7CiAgICAgICJuYW1lIjogImJlZC1iIiwKICAgICAgImRldmljZXMiOiBbCiAgICAgICAgeyAibmFtZSI6ICJhZmFteDEiLCAidHlwZSI6ICJsb2FkLWJhbGFuY2VyIiwgInByb2R1Y3QiOiAiZmFteSIsICJpcHY0IjogWyIxOTIuMC4yLjEzMC8yNiIsICIxOTIuMC4yLjE5NC8yNiJdLCAiaXB2NiI6IFtdLCAiaW5zdGFsbGVkIjogeyAiYnVpbGQiOiAiUmVsX0ZBTVlfMTBfNl8xXzgiLCAiYmFzZSI6ICJSZWxfRkFNWF8xMF82XzFfOCIgfSB9LAogICAgICAgIHsgIm5hbWUiOiAiY2xpZW50MSIsICJ0eXBlIjogImNsaWVudCIsICJpcHY0IjogWyIxOTIuMC4yLjE1MC8yNiJdLCAiaXB2NiI6IFtdIH0KICAgICAgXSwKICAgICAgInNlcnZpY2VzIjogW10sCiAgICAgICJyZXNlcnZlZCI6IFtdCiAgICB9CiAgXQp9Cg==",
      "mediaType": "application/json",
      "fileName": "bed-topology.json"
    }
  ],
  "knowledgeSync": []
}
```

To move an existing Hub: `circle-hub export` on the source (no secrets or tokens; packs usually lack `directory`), `init-admin` on the new machine, add `directory` for packs to publish, then `apply`. After a wipe: `reset --scope all` → `init-admin` → `apply` (see [reset](reset.md); Chinese page is authoritative where they differ).

---

## Step 3: Serve and connect Circle

```bash
unset CIRCLE_HUB_TOKEN
./bin/circle-hub serve
curl -sS http://127.0.0.1:7420/healthz
```

Console: `http://127.0.0.1:7420/console/`. Prefer ordinary MCP authorization (no hand-issued Bearer token): desktop Hub extension with account/password, or a `settings.json` MCP entry **without** an `Authorization` header, then `/mcp` / `/mcp reload` and sign in. Optional: `user invite` for members; `token issue … --raw` only for scripts.

---

## Step 4: First run

Tools: `list_task_packs`, `upload_file`, `start_run`, `get_nodes`, `resolve_reference`, `submit_result`. For the account assigned in the minimal definition (`admin`):

1. `list_task_packs` with `{}`.
2. `start_run`:

```json
{
  "pack": "test-bed",
  "inputs": { "inventory": { "external": "doc:doc:bed-topology" } },
  "parameters": { "action": "facts" }
}
```

3. `get_nodes` / `resolve_reference` on the result reference.

---

## Appendix: step-by-step without `apply`

Use only if you need to see each CLI call. The main path remains `apply` above.

```bash
./bin/circle-hub pack grant-publish admin
./bin/circle-hub pack publish packs/workflow/test-bed --stage
./bin/circle-hub pack assign admin test-bed
./bin/circle-hub doc put bed-topology packs/workflow/test-bed/examples/bed-topology.json
```

Team/user setup, other pack kinds, and resource/secret examples stay in the [Chinese quickstart](quickstart.md#附节逐条做不经-apply) appendix. This English page is an abridged companion; where the two differ, the [Chinese quickstart](quickstart.md) is authoritative.

---

## Next reading

- [Reset and rebuild](reset.md) (Chinese)
- [Editing a workflow or skill](edit-pack.md) (Chinese)
- [Admin guide](admin-guide.md) · [Member guide](member-guide.md) (Chinese)
