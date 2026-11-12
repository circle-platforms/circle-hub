# Bind flat absence checks to deterministic expected values

Source: the ninth local brief. This work uses an isolated branch from the local 3.18.4 integration commit.

Allowed paths are case-compile's functions/slots.ts, functions/checks.ts, functions/expected-nodes.ts, functions/command-obligations.ts, functions/flat-expected.ts, slots.schema.json, the flat-schema portion of testing/gen-block-schema.ts if needed, its tables/block-plan.schema.json output, functions/model-expectations.test.ts and this page.

Add the optional flat expectation op not_found. Its quote remains bound to the original case's frozen expectation node. Its text is either an exact original fragment or a complete text/name parameter configured in this case and removed by a declared inverse before the observed step, with no intervening recreation. Derived values use the existing TEXT_PARAMETER_TYPES and raw command tokens. A bidirectional or enum inverse does not establish a configuration direction and remains unknown. This verifies the plan's declared reversal, not a result on a device. Reuse the command parser and declared inverse logic; no keyword or method-name inference, criterion review or new judgment rule is introduced. Block expectations and the original found/model-judgment paths retain their behavior.

Only functions/model-expectations.test.ts was run, as scheduled: the first run had 27 tests, 26 passed and one failed because the new fixture shared its plan quote object with its frozen expected node. Separating those fixture objects preserved the refusal assertion; the second run passed all 27 with no skips. The original logs are retained. Configuration-source indexes are disclosed even when the caller also declares model_judgment.

The existing block-schema generator ran and introduced no other file differences. No type check, other test file or publication sample generator ran. This is an intermediate development commit; the integrator owns the final 3.19.0 version and manifest before any publication.
