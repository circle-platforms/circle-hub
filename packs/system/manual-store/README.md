# packs/system/manual-store

The system pack of the anonymous document store (WebDAV, plain HTTP, brief section 8): manuals, specs, product and qa
documents; reads only.

| Read | Gives |
| --- | --- |
| `manual:file:<path>` | one file by its path below the base |
| `manual:cli:<line>`, `manual:app:<line>` | the CLI or application manual of a version line: the subfolder of `settings.cli_folder` (default `cli`) or `settings.app_folder` (`app`) whose name ends in the line's numbers (`rel_x_10_7_1` is line 10.7.1), file `settings.cli_file` (`cli_cn/cli_cn.md`) or `settings.app_file`; content `text/markdown` without NUL bytes (the original keeps them), meta `{title, line, folder, nul_removed}` |
| `manual:spec-search:<terms joined by +>` | `settings.spec_folders` (default `["spec"]`) listed once each with PROPFIND Depth 1; every file name scored by the number of terms it contains (case-insensitive, an ASCII acronym counts like any term where no ASCII letter touches it), ties to the file whose terms are rarer in the folder, the best five with at least one term read; the derived content (Markdown) lists the files read and holds their texts; nothing found is an empty listing, not an error |
| `manual:qa-search:<terms joined by +>` | the same over the test strategy documents (`settings.qa_folder`, default `qa`); the workflows bind it with role hint (evidence group d) |

**Links of a listing are never followed.** A member is read by its name below the listed folder (`params.path`, route
space), not by the link the listing gives: a link on another origin than the collection's own, a member that is not directly
below the collection, and a name no path segment can hold (`/`, `\`, `;`, controls, `.`, `..`, over 255 characters) are
skipped, named in a warning of the read and, for a search, in the content (`列表里有、但没有读`); a skipped file whose name
holds a search term makes the search incomplete. One odd entry therefore never fails the whole read (the connectors refuse
an off-origin link with `ORIGIN_REFUSED`, which ends a read).

Profile: role `manual-store`, auth `none`, routes `list` (`PROPFIND /{dir*}/` with `Depth: 1`, xml@1) and `file`
(`GET /{path*}`, text up to 32 MiB); no write route. No product name is written in the pack: folder and file names come
from the resource settings. The synthetic store in `tests/fixtures/manual-store` holds an invented feature whose two spec
files the search must rank first among distractors that share some of its terms.

Functions: `functions/webdav.ts`, shared with the openkm pack (identical copy, a test keeps them equal). Not published:
`api.ts`, this README, `webdav.test.ts`.

Test: `node --test packs/system/manual-store/webdav.test.ts` (the pure functions against the read-plan and projection shapes
of the contracts, and reads through the real connectors: the manuals of both name families, the spec and the qa search, an
empty search, a store whose listing links another host, a folder outside the listed one and a name with `;`). The
end-to-end test binds the spec and the qa search and syncs the Lumen API product through `manual:file`.

Needs: none.

缺席观察：读取声明的 `absent_codes` 包含 `manual.not_found`。仅在原始应答已保存、根据全部可读且无其他读取故障时，Hub 将该码转为带系统、对象、读取时刻和应答键的 SOURCE_ABSENT；原件照存，检查读取独立的规范 JSON 观察。401/403、未读完或凭据保留不作缺席。

## Declared specification folders

`manual:spec-list:configured` lists the direct file members of `settings.spec_folders` (up to 32 directories) as JSON `folders`, `files` (`name`, resource-relative `path`), `unread` and `complete`. It never follows member links or descends into child directories. Unsafe member names are skipped and named in warnings; an unread directory makes the listing incomplete and names the permission/path repair. An explicit empty list reads nothing. No product or QA folders are added. Deployment may bind the setting to `${var:MANUAL_SPEC_FOLDERS}`.

Legacy `spec_folder` joins the same list, once per normalized path; reads warn “旧设置 spec_folder 已并入 spec_folders，下一步资源管理员改用 spec_folders”. Specification searches use that same list and select at most five files across all directories.
