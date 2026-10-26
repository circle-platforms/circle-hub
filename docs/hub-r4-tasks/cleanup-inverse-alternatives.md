# Preserve declared inverse enum alternatives during consolidation

Owner authorization: consolidate all valuable pending Hub work through the safe public branch, without modifying
the deployment checkout or importing its local commit history.

Allowed paths: `contracts/src/product.ts` and generated outputs; `packs/product/famx/{product.json,README.md,pack.json}`;
`packs/workflow/case-compile/functions/{command-policy.ts,command-obligations.ts,inverse-alternatives.test.ts}`;
its synthetic fixture, package identity/tests, workbook format and regenerated samples.

The original feature is retained as a closed product declaration. New regression cases require the current signature
and parameter position, reject conflicting pairs and ambiguous targets, preserve other parsed values, and accept
valid quoted enum values. Four regressions failed against the initial port before those boundary fixes. No command
word or prose is classified through a keyword table. Native parameter parsing remains the authority.

The public packages increment to famx 1.7.30 and case-compile 3.4.5 and are re-signed with their own tools.
