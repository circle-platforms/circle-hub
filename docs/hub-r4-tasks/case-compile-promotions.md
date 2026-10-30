# case-compile 3.9.2: promoted certification candidates (decision 104)

The fifth case of the goal mindmap re-creates a list virtual service as HTTPS and loads a certificate onto its SSL host.
InfoTest and CES do that with importRootCA, importKey and importCert and the certified material of `SSL_CERT_LOAD`; the runner
contract marks those methods as certification candidates (device certified through a device receipt set, release replay
still required), and case-compile never enabled a candidate.

Change: `packs/workflow/case-compile/functions/runtime-contract.ts` reads an optional runtime-contract@2 addition `promotions`;
a candidate is enabled only when a promotion names it with the very `status_authority` the original entry records and the
entry carries typed authority; anything else refuses the contract. `promotions` is stripped with the other additions, so
the original identity is unchanged. Test: `functions/promotions.test.ts`. Version 3.9.1 → 3.9.2 (generator identity and the
typed samples follow).

Data outside Git that goes with it (integrator): runner-contract revision 7 promotes APV_0.importKey, importCert and
importRootCA with their recorded device receipt sets and types their parameters (an SSL host name with a declared text shape,
the certified files as enums, index 1).

Allowed paths: `packs/workflow/case-compile/**`, this page.

Verification: `npx tsc --noEmit`; all case-compile tests; `affected-tests.py --run`.
