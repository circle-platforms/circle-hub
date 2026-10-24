# Human requests

B07 storage is shared by trusted Hub components through `api.ts`. `createRequestService(records, now, {canReadRun})`
provides validated append-only writes, scoped listing and record-backed answers. `inspect` and `all` are trusted internal
reads, never client entry points. Without a run-visibility callback, nonadministrators cannot list run-bound requests;
pack-only requests are visible only to their named audience. This service grants no permission or effect authority.

Every request names a concrete missing fact, existing next action, named account and absolute due date. It binds a run,
a published pack digest, or both. Optional source references and job identity preserve the exact recovery target. Repeating
the same problem does not extend its original deadline. Answers reference an actual stored record and leave both request
and old result unchanged; callers verify the answering actor and the performed step before calling `answer`.

Run policy stays in the engine. A package owner outside the run's visible scope receives no automatic share: an
administrator gets a separate clarification request to review and provide an authorized minimal reproduction.
`circle-hub pack publish <directory> --answer-request <request-digest>` (repeatable) explicitly answers package repair
requests with the actual pack-version record. A new version without this flag answers nothing. Publication validates
package binding and named author before writing; a committed publication whose answer write fails reports that precise
state and accepts an identical retry. No command or service here sends a notification, publishes or changes effects by itself.

The generic module owns storage and the `requests@1` answer component. Run visibility is injected as a callback;
request storage imports no run engine or product implementation. Callers retain their own routing and checks.

`source` is an explicitly bound context digest used for request identity (received submission-body digest, frozen run
record, or published-pack context); it is not automatically a `rec:` reference. `answered_by` in the read view is the
actual answer-source **record digest**, not a user id. `answer` verifies that record exists; publication passes the
`pack_version` record digest, never the manifest digest. Recipients are separately named by `audience`.
