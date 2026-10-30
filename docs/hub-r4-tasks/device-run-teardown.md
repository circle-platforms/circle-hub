# Scenario 28 closes its Hub when its setup fails

Found by the full check of 987c58e14: a stray link inside the shared `node_modules` made every sandboxed import fail, so
scenario 28's `before()` stopped at the knowledge sync (`assert.ok(root)`) after it had created the test Hub but before it
filled `bed`. `after()` closed the Hub only through `bed?.hub`, so the Hub's listeners and the synthetic stubs stayed open
and the file never exited: the acceptance part waited an hour instead of reporting a failed setup. Every other test that
creates a Hub registers its close right after creating it.

Change: scenario 28 keeps the Hub it created in `opened` at once and `after()` closes `opened`.

Test: scenario 28 passes; a setup failure ends the file with the failure instead of a hang (checked by hand by making
`before()` fail after the Hub exists).

Allowed paths: `tests/acceptance/28-device-run.test.ts`, this page.

Verification: `npx tsc --noEmit`; scenario 28; the full check before deploying.
