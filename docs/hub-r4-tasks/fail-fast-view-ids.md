# Refuse a malformed knowledge view id before building any view

A real quality-board run took 21 minutes and then failed: one input named a facets view without its required parameter, and the Hub built the other input's large view first. The caller saw only a bare "unavailable" answer with no way to correct the id.

Change: `bindInputs` checks every knowledge view id with `parseViewId` before reading anything and answers an id that lacks a required parameter (which `parseViewId` now reports as structure, `missing`) with a `SUBMISSION_SCHEMA_VIOLATION` that names the parameter and how to write the id; once an input is known to be wrong it skips building a further knowledge view. Other grammar problems (an unknown or malformed parameter) are still left to the reader, because pack tests drive the engine with stub readers and ids that only the stub knows. Valid runs and other input types behave as before. (A first version rejected every `parseViewId` failure; the full check caught it in the traceability and template-gap pack tests.)

Allowed paths (second change): `hub/knowledge/views.ts`, `hub/knowledge/views.test.ts`, `hub/runs/engine/inputs.ts`, this page.

Allowed paths: `hub/runs/engine/inputs.ts`, `tests/acceptance/34-r5-t1t3-platform-facts.test.ts`, this page.

Verification: the acceptance file above, and `affected-tests.py --run` against hub-redesign (decision 80).
