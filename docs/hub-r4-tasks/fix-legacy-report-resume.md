# Recognize legacy report-only unknown archives

Owner scope: Hub dispatch resume recognition, synthetic legacy archive regression and dispatch documentation. No acquire, submit, real-data access, deployment or package change.

The previous legacy recognizer required both the Hub projection's missing report fact and a raw gateway readiness predicate. That predicate rejects complete=true with a nonempty unreported/unmapped value, even though the Hub projection has no_verdict, integrity_unproven and missing_facts=[report]. Earlier tests only covered complete=false and therefore missed the production-shaped cache branch.

Recognize native projected report/complete gaps by exact structured fields and original job/artifact/request/terminal bindings. A manual resume is a new authorized read; the legacy raw readiness flag is not a prerequisite and archived raw response availability is not required. Latest status/results must still pass the original identity, digest, request, ownership and execution-integrity checks. Freeze only recorded execution facts and never synthesize continuity after normal lease release. Keep management dispositions and unrelated completed judgments out of this path. Log the structural recognition condition when an incomplete archive cannot be selected.

The regression writes the pre-fix projection and terminal shape without new pending/integrity markers, with complete=true, nonempty unreported raw data, a no_verdict row and exactly the report gap. The test is red on 8cb0de91 because no gateway calls occur. Green requires status/results calls, a new result and appended history, PASS, no lease RPCs and exactly the original one submit.
