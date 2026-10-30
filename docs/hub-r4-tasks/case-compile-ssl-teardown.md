# case-compile 3.8.11 and apv 1.7.40: declared confirmations, net-effect cleanup, declared text shapes (decision 104)

The owner decided on 2026-10-30 (decision 104) to compile a whole mindmap in one run, and first to add the capabilities the
remaining cases of the goal mindmap "slb virtual httplist等list命令支持no和clear" need. Its fifth case deletes and re-creates
a list virtual service several times and finally re-creates it as an HTTPS service with an SSL host whose key and
certificate are loaded from the runner. InfoTest compiles that with its `SSL_CERT_LOAD` block (compile_ref
`blocks_schema.json`): load after the virtual object exists, tear down after the last business assertion with
`clear ssl host "<vhost>",prompt=abort:` followed by `YES`; CES emits the same pair (emit_xlsx_tool
`ssl_certificate_load_blocks`). Three generic rules were missing in case-compile:

1. **Declared confirmations.** `contracts/src/product.ts` command-policy@1 gains optional `confirmations`
   (`command_prefix`, `prompt`, `answer`). case-compile (`functions/command-policy.ts`, `functions/plan-commands.ts`
   `confirmationSteps`) requires a declared command to pass the declared prompt as its runner prompt and the next step on
   the same object, method and section to carry exactly the answer; that answer step is dialogue (no catalog parse, no
   catalog entry, no cleanup obligation: `functions/subject.ts`, `functions/typed-authority.ts`). A declared command
   without the pair, a runner prompt on another command, and a stray answer are refused.
2. **Net-effect cleanup.** `functions/command-obligations.ts`: an execution step that is exactly the declared inverse of a
   still-live earlier one on the same device undoes it; only what stays live needs cleanup, in reverse order, as before.
3. **Declared text shapes.** `functions/typed-contract.ts`: a `string` type may declare an anchored `pattern`.

apv 1.7.40 (`product.json`): inverse rules `ssl host virtual` → `clear ssl host` (leading 1) and `ssl start` → `ssl stop`
(leading 1), and the confirmation of `clear ssl host` (`abort:`, `YES`), as InfoTest and CES tear an SSL host down. The
paths were checked against the build-585 command tree (`ssl host virtual <host> [service]`, `clear ssl host <host>`,
`ssl start|stop <host>`). The policy is frozen into a root, so the 10.5 line is re-seeded after publishing.

Versions: case-compile 3.8.10 → 3.8.11 (generator identity and the four typed samples follow, recomputed with the pack's own
generator: only the identity row changes); apv 1.7.39 → 1.7.40. The recompose stage packs are unchanged (none of their
copied modules changed).

Allowed paths: `contracts/src/product.ts`, the regenerated `contracts/generated/schemas/*`, `packs/workflow/case-compile/**`,
`packs/product/apv/**`, `docs/hub-r4-progress.md` (decisions 104 and 105), this page.

Data outside Git that goes with it (integrator, production): runner-contract revision with typed SSL import methods
(`importKey`, `importCert`, `importRootCA`: host name with a declared shape, the certified material of InfoTest's
`SSL_CERT_LOAD` as enums, index), the SSL command scope; the runtime profile opening the prompt on `cmd_config`, the
import methods (reviewed) and `test_env.routerb`; the executor warrant to 3.8.11.

Verification: `npx tsc --noEmit`; all case-compile tests (517 passed); apv tests; `npm run verify:contracts`; the full
check before deploying (contracts change).
