# packs/system/manual-store

The system pack of the anonymous document store (WebDAV, plain HTTP, brief section 8): manuals, specs, product and qa
documents; reads only.

| Read | Gives |
| --- | --- |
| `manual:file:<path>` | one file by its path below the base |
| `manual:cli:<line>`, `manual:app:<line>` | the CLI or application manual of a version line: the subfolder of `settings.cli_folder` (default `cli`) or `settings.app_folder` (`app`) whose name ends in the line's numbers (`rel_x_10_7_1` is line 10.7.1), file `settings.cli_file` (`cli_cn/cli_cn.md`) or `settings.app_file`; content `text/markdown` without NUL bytes (the original keeps them), meta `{title, line, folder, nul_removed}` |
| `manual:spec-search:<terms joined by +>` | `settings.spec_folders` (default `["spec"]`) listed once each with PROPFIND Depth 1, and the members listed in name order: keyword retrieval is retired (owner ruling U19/U20, 2026-10-24), so no file name is scored, no file is chosen by a term and none is read here; the terms are disclosed as unused (`meta.terms`, `meta.terms_used: false`, `meta.selection: "retired"`). The derived content (Markdown) names the members, the missing fact (which source this run is about) and the next step (`manual:file:<path>` declared by the author, or a candidate a model proposes with a verbatim quote the Hub verifies). A folder whose listing did not arrive makes the read incomplete |
| `manual:qa-search:<terms joined by +>` | the same listing over the test strategy documents (`settings.qa_folder`, default `qa`); the workflows bind it with role hint (evidence group d) |

**Links of a listing are never followed.** A member is read by its name below the listed folder (`params.path`, route
space), not by the link the listing gives: a link on another origin than the collection's own, a member that is not directly
below the collection, and a name no path segment can hold (`/`, `\`, `;`, controls, `.`, `..`, over 255 characters) are
skipped, named in a warning of the read and, for a search, in the content (`列表里没有读的项`) and in `meta.skipped`. One odd
entry therefore never fails the whole read (the connectors refuse
an off-origin link with `ORIGIN_REFUSED`, which ends a read).

Profile: role `manual-store`, auth `none`, routes `list` (`PROPFIND /{dir*}/` with `Depth: 1`, xml@1) and `file`
(`GET /{path*}`, text up to 32 MiB); no write route. No product name is written in the pack: folder and file names come
from the resource settings. The synthetic store in `tests/fixtures/manual-store` holds an invented feature whose two spec
files the fixtures name (`SPEC_SEARCH_FILES`) so a test can assert that a listing holds them and the distractors that share
some of their terms alike: the terms decide nothing.

Functions: `functions/webdav.ts`, shared with the openkm pack (identical copy, a test keeps them equal). Not published:
`api.ts`, this README, `webdav.test.ts`.

Test: `node --test packs/system/manual-store/webdav.test.ts` (the pure functions against the read-plan and projection shapes
of the contracts, and reads through the real connectors: the manuals of both name families, the spec and the qa search
listings, a key whose terms match nothing, a store whose listing links another host, a folder outside the listed one and a
name with `;`). The end-to-end test binds the spec and the qa search and syncs the Lumen API product through `manual:file`.

Needs: none.

缺席观察：读取声明的 `absent_codes` 包含 `manual.not_found`。仅在原始应答已保存、根据全部可读且无其他读取故障时，Hub 将该码转为带系统、对象、读取时刻和应答键的 SOURCE_ABSENT；原件照存，检查读取独立的规范 JSON 观察。401/403、未读完或凭据保留不作缺席。

## Declared specification folders

`manual:spec-list:configured` lists the direct members of `settings.spec_folders` (up to 32 directories) as JSON `folders`, `files` (`name`, resource-relative `path`, optional WebDAV `displayname` as `title`), `directories` (`name`, `path`), `unread` and `complete`. It never follows member links or descends into child directories. Unsafe member names are skipped and named in warnings; an unread directory makes the listing incomplete and names the permission/path repair. At least one directory must be declared, so the read has an inventory original; a configured directory with no files is a complete zero selection. No product or QA folders are added. Deployment may bind the setting to `${var:MANUAL_SPEC_FOLDERS}`.

Legacy `spec_folder` joins the same list, once per normalized path; reads warn “旧设置 spec_folder 已并入 spec_folders，下一步资源管理员改用 spec_folders”. Specification searches use that same list and list the members of every directory in it; they select no file.

Specification inventory reads require an explicit `spec_folders` list or the legacy `spec_folder` setting; an undeclared list refuses with the resource-administrator configuration action. An empty directory list refuses before requests, with the action to configure at least one readable directory (which may itself be empty). Only the existing search keeps its legacy `spec` fallback.
