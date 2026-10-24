# packs/system/openkm

The system pack of the document library the manual mirror is produced from (WebDAV with Basic authentication, brief
section 8): the same reads as the manual store (`openkm:file:<path>`, `openkm:cli:<line>`, `openkm:app:<line>`,
`openkm:spec-search:<terms>`, `openkm:qa-search:<terms>`), read-only, with the same planner and projection functions
(`functions/webdav.ts`, an identical copy of the manual store's: members are read by their name below the listed folder,
never by the listing's links; see the manual store's README).

Profile: role `openkm`; auth `static_header`: the header `Authorization` with the vault's credential `authorization`, the
full Basic header value (credentials come from the vault, never from the pack); every route's parameters carry patterns;
no write route. The configured account answered 401 when first tried on the real system, so milestone 1 reads the
anonymous mirror (the manual-store pack) until the owner supplies a working account.

Not published: `api.ts`, this README, `webdav.test.ts`. Test: `node --test packs/system/openkm/webdav.test.ts` (a guarded
WebDAV stub below a base path that answers 401 without the exact header; the copy equals the manual store's).

Needs: none.

## Declared specification folders

`openkm:spec-list:configured` lists the direct members of `settings.spec_folders` (up to 32 directories) as JSON `folders`, `files` (`name`, resource-relative `path`, optional WebDAV `displayname` as `title`), `directories` (`name`, `path`), `unread` and `complete`. It never follows member links or descends into child directories. Unsafe member names are skipped and named in warnings; an unread directory makes the listing incomplete and names the permission/path repair. At least one directory must be declared, so the read has an inventory original; a configured directory with no files is a complete zero selection. No product or QA folders are added. Deployment may bind the setting to `${var:MANUAL_SPEC_FOLDERS}`.

Legacy `spec_folder` joins the same list, once per normalized path; reads warn “旧设置 spec_folder 已并入 spec_folders，下一步资源管理员改用 spec_folders”. Specification searches use that same list and list the members of every directory in it; they select no file (keyword retrieval is retired, owner ruling U19/U20, 2026-10-24).

Specification inventory reads require an explicit `spec_folders` list or the legacy `spec_folder` setting; an undeclared list refuses with the resource-administrator configuration action. An empty directory list refuses before requests, with the action to configure at least one readable directory (which may itself be empty). Only the existing search keeps its legacy `spec` fallback.
