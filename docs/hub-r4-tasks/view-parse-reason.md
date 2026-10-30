# Name the grammar mistake of a knowledge view id instead of answering "unavailable"

In the real template-gap run of 2026-10-30 (T1-3) the model bound a case index with an empty `only=`. The Hub answered
`SOURCE_UNAVAILABLE` "对你不可用" six times; the real reason, only in the administrator log, was "only 要列 1 到 1000 个取值". Since
fail-fast-view-ids, `bindInputs` names only a missing required parameter at once; other grammar problems are left to the reader,
because pack tests drive the engine with stub readers that know ids the grammar does not. The real reader refuses such an id and
the refusal reached the caller as the same-shape answer kept for what the caller may not see, although its reason comes from the
caller's own id alone.

Change: when `completeKnowledgeView` (hub/knowledge/complete-view.ts) gets a refusal for an id that `parseViewId` also refuses,
and the refusal carries no input error or retry of its own, it returns the refusal with an input error: "知识视图标识写错了：<the
grammar reason>" and the way to write a view id. The engine already answers an input error as `SUBMISSION_SCHEMA_VIOLATION`
at the input's path. A well-formed id that the reader refuses keeps the plain refusal; an id a stub reader answers is bound as
before.

Tests: `hub/knowledge/complete-view-grammar.test.ts` (empty only named; well-formed refusal unchanged; stub-known id still read);
an acceptance case in `tests/acceptance/34-r5-t1t3-platform-facts.test.ts` (traceability with `only=`), which fails on the trunk
with exactly the production answer and passes with the change.

Allowed paths: `hub/knowledge/complete-view.ts`, `hub/knowledge/complete-view-grammar.test.ts`, `hub/knowledge/README.md`,
`tests/acceptance/34-r5-t1t3-platform-facts.test.ts`, this page.

Verification: `npx tsc --noEmit`; the two test files; `affected-tests.py --run`; the full check before the next deployment.
