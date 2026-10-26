# Preserve test meaning across CI platforms

Owner authorization requires successful exact-head CI before merging the public consolidation. Allowed paths are the
synthetic runs/knowledge/pack test fixtures, temporary PostgreSQL test helper, unit runner, CI workflow and their tests.
No production sandbox default or professional rule is relaxed.

Functional fixtures follow the existing synthetic knowledge-world policy: require OS isolation where available, and
explicitly report its absence when exercising trusted synthetic functions without it. Production callers still require
isolation by default, and the direct default-refusal tests remain. The change adds no skip.

A terminating signal now waits for each temporary postmaster's bounded shutdown before removing its data directory.
The original exit-hook fallback remains. This removes the Linux filesystem cleanup race; the existing SIGTERM test
retains its signal, directory-removal and closed-port assertions.

Parser wall-time bounds run in their own single-worker CI partition, without another test worker competing on the same
runner. Their 2-second and 5-second assertions remain unchanged. A file-set test proves the two unit partitions are
disjoint and cover every original tracked unit test; each partition keeps its count/skip summary, and the stable Unit
tests status fails unless every partition succeeds. No test is excluded through a skip pattern or continue-on-error.
