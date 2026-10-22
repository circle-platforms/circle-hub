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
