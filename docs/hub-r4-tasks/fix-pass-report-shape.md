# Interpret pass reports without optional failure sessions

Owner scope: Hub dispatch result-field interpretation/diagnostics, executor result pointer descriptions and generated schema, Hub dispatch readback, synthetic loopback tests and dispatch documentation. No production endpoint/data/config access, arbitrary map inference, submission retry or deployment.

Only the declared complete/list/item/outcome pointers and exact result.map can produce report. Missing sessions is not a predicate. A no_verdict whose only missing fact is report already proves the other integrity predicates; the unresolved condition is the outcome pointer/value/map. Surface that precise condition instead of a generic integrity note. Pointer descriptions explicitly distinguish response-root fields from per-item relative fields. Unknown fields and non-pass/fail map values remain unknown; no core fallback assumes a string means PASS.

The loopback test mirrors complete=true, channel=ready, rc=0, owned staging directory, matching xlsx_sha256, submitted_at and cases with case_id/result=pass/log_stale=false/log closing marker, without sessions. It reaches a qualified PASS under the explicit pointer/map declaration. Separate faults reproduce exactly missing_facts=[report], assert the actual missing pointer or undeclared mapping in result/admin explanation, and repair only the read definition followed by resume, with one total submit and no new lease calls.

The actual deployed result definition was requested because its pointers/map are not present in this repository; the supplied response shape alone cannot establish which deployment declaration differs. New report_check diagnostics name that field using the actual frozen/repaired definition, with value digests and no log text.
