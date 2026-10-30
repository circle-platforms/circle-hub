# Use a variable value that no printed time can contain

The full check of hub-redesign b43baf1f failed once in `hub/server/variables.test.ts` ("variable commands preserve explicit
text and hide values until show --value") and passed six reruns in a row. The test stores the value `10.6` and asserts that
`list` and `show` never print it. Both print the decision time as an ISO timestamp, and a time whose seconds are 10 and whose
milliseconds start with 6 contains `10.6` (about one run in three hundred).

Change: the test value is `MEADOW_LINE_10.6`, which no timestamp, hexadecimal digest or identifier can contain; the assertions
are otherwise the same (hidden from `list` and `show`, printed by `show --value`).

Allowed paths: `hub/server/variables.test.ts`, this page.

Verification: `node --test hub/server/variables.test.ts`; the full check before the next deployment.
