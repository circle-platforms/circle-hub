# apv 1.7.38: declare the cleanup of the virtual list commands by their leading identity parameters

The real compile of the case "slb virtual httplist等list命令支持no和clear" (2026-10-30, owner's goal) stopped at an unknown that
named the product pack author: the configuration commands `/commands/slb/virtual/addrlists` and `/commands/slb/virtual/portlists`
had no unique inverse identity. The locked command tree gives `no slb virtual addrlists <name> [<start>] [<end>]` (portlists the
same with ports), and the policy had only the generic `/commands ↔ /commands/no` rule, so case-compile found three possible
cleanup identities and, rightly, did not choose one.

Change (apv 1.7.37 → 1.7.38): the command policy declares, for these two paths only, the inverse under `/commands/no` with
`leading_parameters: 2`, the list name and the start value. That is the cleanup earlier compiled and executed cases of the same
mindmap used on the automation bed (`no slb virtual addrlists "addlist1" <address>`, `no slb virtual portlists port1 80` in the
owner's InfoTest workspace, read as a behavioural reference only). Longer prefixes take precedence over the generic rule, so
every other path keeps the identity its locked inverse signature determines. The policy is frozen into a root at seeding, so the
build's root is re-seeded after the pack is published and activated.

Test: `packs/product/apv/command-policy.test.ts`.

Allowed paths: `packs/product/apv/product.json`, `packs/product/apv/pack.json`, `packs/product/apv/README.md`,
`packs/product/apv/command-policy.test.ts`, this page.

Verification: `npx tsc --noEmit`; `node packs/product/apv/api.ts check`; the apv tests through
`node tools/run-unit-tests.ts files …` (662 passed) and the new test; `affected-tests.py --run`.
