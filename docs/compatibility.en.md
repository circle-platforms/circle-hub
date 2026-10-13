# Compatibility matrix

This page translates the [Chinese original](compatibility.md); where the two differ, the Chinese text is authoritative.

The three repositories are versioned separately: circle (harness), circle-hub (the platform), and circle-packs (packs). Who depends on whom, and what is authoritative, is written here. Changing any row is a deliberate upgrade, not something done in passing.

## Current state (2026-10-13)

| Component | Version / commit | Authoritative source | Notes |
|---|---|---|---|
| circle-hub `main` | The design documents are authoritative; code is merged from the `server-s2` branch after review | `docs/design` | The 7420 verification stack runs the reviewed commit from `server-s2` (currently 8e212a6, database migration 28), not the code on `main` |
| `foundation/circle` | Circle **1.0.4** source baseline, frozen | the source record in `references/README.md` | Source reference only: it is not installed, and its installer is not run; it is not a runtime dependency of hub |
| Circle runtime used for acceptance | Circle main-line commit **8b2ceb6** (confirmed by the user) | `CIRCLE_BIN` / `CIRCLE_COMMIT`, a strict Git gate | **This is the real test dependency**: acceptance RPC cases accept only this commit; changing the commit requires the user's confirmation and an update of the gate |
| circle main line | 1.2.1 (`v1.2.1`) | the tag in the circle repository | the target version of hub's Circle-side extension |
| circle's hub extension | branch `server-tools` (4076953, not pushed), built on a Circle 1.1.1 checkout | hub's `docs/client-api-handoff.md` | the identifier is still `circle-server`; it is renamed together with hub |
| circle-packs `main` | see its CHANGELOG | hub's pack loader and schemas | tests need hub's dependency set (CI clones hub `main` for `node_modules`) |
| execution gateway cexg | 0.3.0 (static secret) | the compile-excel-server repository | hub's worker needs the §7 static-secret credential mode in order to call it |

## Schemas and contracts

| Schema | Defined by | Used by |
|---|---|---|
| `circle-packs/modules/1` (modules.json) | circle-packs `tools/modules.ts` | hub's installer |
| `product-line/1` | hub design `docs/design/product-line-pack.md` | a pack's `product-line.json`; hub's loader |
| `hub-hook/1`, `hub-skill/1`, `hub-tool/1`, `hub-provider/1`, `hub-instruction/1`, `hub-agent/1`, `hub-command/1`, `hub-permission/1` | hub design `docs/design/harness-primitives.md`, `permission-export.md` | a pack's hooks, skill registration, and `packages/harness-adapters` |
| dependency set of a pack's Tool implementations | hub's `package.json`: exceljs 4.4.0, read-excel-file 9.3.12, fflate 0.8.3, zod 4.6.5, saxes 5.0.1, parse5 8.0.1 | a pack's `tools[].imports`; checked at load; an import outside the declaration is reported as `IMPORT_NOT_DECLARED`; Node built-in modules are not allowed either |
| hub client API | `docs/client-api-handoff.md` | circle's hub extension |
| `/mcp` endpoint | `docs/design/harness-primitives.md` | any MCP client |

## Release order

1. hub first: when a schema or the client API changes, raise that schema's version, tag the release, and update this page.
2. circle's hub extension next: merge against hub's tag, and declare the hub version range it supports.
3. packs last: update `product-line.json` and hooks to hub's schema version; each pack carries its own version.

Upgrading the Circle commit used for acceptance, replacing the `foundation/circle` baseline, and the rename (the `circle-server` → `circle-hub` identifier, synchronized across the three repositories) are each a separate decision, and each leaves one record in History on this page.

## History

- 2026-10-13: this page was created. The rename has not started; the acceptance Circle commit is 8b2ceb6; foundation/circle is 1.0.4; circle's main line is 1.1.1.
- Evening of 2026-10-13: 7420 upgraded in place to server-s2 8e212a6 (§5, migration 28); circle mainline 1.2.1; circle-hub and circle-packs relicensed under Apache-2.0 with signed-off commits; circle-packs acceptance pinned at 316760a (products/apv 1.2.0).
