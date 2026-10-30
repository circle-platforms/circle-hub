# Bind the union expansions of one signature positionally in the command grammar

The real compile of 2026-10-30 (case "slb virtual httplist等list命令支持no和clear", owner's goal) stopped at the cleanup
`no slb virtual addrlists <name> <address>`: "完整签名缺类型、原始声明或唯一身份". The locked tree declares
`no slb virtual addrlists <STRING> [<IPADDR>] [<IPADDR>]`; the product's command-tree producer publishes IPADDR as two catalog
signatures per position (IPv4 and IPv6) under the same declared reference. `commandIdentity` (contracts/src/command-grammar.ts)
binds each expansion separately and skips an optional parameter whose expanded type rejects the argument, so in the expansion
with an IPv6 start the IPv4 address bound to the end position. The line had two identities and none was chosen. The add form
(start required) and integer lists were not affected, which matched the production result.

Change: identities of the same path and declared signature reference keep only those whose bound positions come first, as the
declared signature binds them (an optional parameter is skipped only when no expansion takes the argument there); then
uniqueness is decided as before. Identities of different references are never merged, so two declared signatures that both
take a line still leave it ambiguous.

Generated copies: `contracts/generated/command-grammar.ts` and the pack copies in apv and case-compile
(`npm run gen:contracts`), so apv 1.7.38 → 1.7.39 and case-compile 3.8.8 → 3.8.9 (generator identity follows the pack
version; the four typed samples are recomputed with the pack's own generator as in case-compile-export-prefix).

Test: `contracts/src/command-grammar-union.test.ts` (the omitted optional union argument, the full and the required forms, and two
declared signatures still ambiguous); without the change its first test fails with exactly the production answer.

Allowed paths: `contracts/src/command-grammar.ts`, `contracts/src/command-grammar-union.test.ts`, the regenerated
`contracts/generated/command-grammar.ts`, `packs/product/apv/**`, `packs/workflow/case-compile/**`, this page.

Verification: `npx tsc --noEmit`; `node tools/gen-contracts.ts --check`; the full check (contracts change).
