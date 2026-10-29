# Refuse a malformed knowledge view id before building any view

A real quality-board run took 21 minutes and then failed: one input named a facets view without its required parameter, and the Hub built the other input's large view first. The caller saw only a bare "unavailable" answer with no way to correct the id.

Change: `bindInputs` checks every knowledge view id with `parseViewId` before reading anything, answers a malformed one with a `SUBMISSION_SCHEMA_VIOLATION` that names the problem and how to write the id, and skips building a further knowledge view once an input is already known to be wrong. Valid runs and other input types behave as before.

Allowed paths: `hub/runs/engine/inputs.ts`, `tests/acceptance/34-r5-t1t3-platform-facts.test.ts`, this page.

Verification: the acceptance file above, and `affected-tests.py --run` against hub-redesign (decision 80).
