# hub/jev: judgment shapes for knowledge placement

Model element **K04**: the Hub calls no model (owner decision 2026-10-22, `docs/hub-r4-tasks/no-judgment-in-hub.md`).
The typed-judgment service (the vendor client, the vault entry `jev.api-key`, `circle-hub secret set jev api-key`,
`CIRCLE_HUB_JEV_MODEL`, the smoke script) is removed: the judgment capability lives bot-side as a skill; the bot
proposes placements and the Hub will verify them with deterministic rules (the path exists, quotes are verbatim from
the original, nothing beyond what the producer declared). That verification flow is not implemented yet.

What remains in this package is what the verification needs and what the knowledge package's placement logic is
tested against: the question/answer **types** (`JevQuestion`, `JevRequest`, `JevAnswer`, `JevResponse`, `JevClient`;
only yes/no (`noul`), single choice and score questions exist, R[0]), the **scripted judge** for tests and
development (R[4]), the shared **validation**, **batching**, the **judgment record** (exact model, question,
candidates, input digest, probabilities; an unchanged input reuses the earlier judgment, R[2]) and the **placement
decisions** (abstention or a probability below the chain's calibrated threshold stops at the parent, R[1]). Other
packages import only from `hub/jev/api.ts`. The knowledge package owns placement, calibration, storage and display.
Two structural insurance tests live here: `no-judgment-egress.test.ts` scans every non-test source under `hub/`,
`scripts/` and `bin/` for the removed client, the service's domain or vendor name and the removed vault entry.

| File | Content |
| --- | --- |
| `api.ts` | types (`JevQuestion`, `JevRequest`, `JevAnswer`, `JevResponse`, `JevClient`) and every export |
| `errors.ts` | `JevError` with `code`, `status`, `requestId`, `attempts`, `reasons`, `questionId` |
| `validate.ts` | request and response validation shared by every client; model id rules |
| `scripted.ts` | `ScriptedJev`: deterministic judge for tests and development |
| `tokens.ts` | conservative token estimate for mixed Chinese and English |
| `batch.ts` | `planBatches`, `batchRequest`, `askAll` |
| `record.ts` | `judgmentRecord`, `inputDigest`, `reuseKey`, `candidatesOf` |
| `decide.ts` | `topChoice`, `shouldDescend`, `NONE_OPTION` |
| `no-judgment-egress.test.ts` | the structural insurance: no source names the removed client, the service or its vault entry |

```ts
const jev = new ScriptedJev((question, state, id) => ({ choice: NONE_OPTION, p: 0.9 }));
const plan = planBatches(spans.map((span) => ({
  id: span.id,                       // stable for an unchanged input, e.g. derived from its digest
  piece: span.text,                  // sent as state[span.id]
  question: { type: 'choice', instructions: `Which chapter holds \`${span.id}\`?`, criteria: { ...children, none: '都不合适' } },
})));
// A batch whose every reuse key is stored need not be asked again (the key rests on the whole state of the request).
const stale = (batch) => {
  const request = batchRequest(jev.pinnedModel, plan, batch.items);
  const stateDigest = inputDigest(request.state);
  return batch.items.some((item) => !stored.has(reuseKey({ model: jev.pinnedModel, question: request.questions[item.id], stateDigest })));
};
const { answered, failed } = await askAll(jev, { ...plan, batches: plan.batches.filter(stale) });
for (const span of spans) {
  const a = answered.get(span.id);
  if (!a) continue;                  // failed.get(span.id) says why (attempts 0: never sent); the span stays where it is
  const rec = judgmentRecord({ request: a.request, response: a.response, questionId: span.id, input: span.text, at: now });
  const descend = shouldDescend(a.answer, threshold /* null when uncalibrated */);
}
```

## Decisions

1. **Pinned model.** A client is pinned to one model and every request must name it (`JEV_BAD_REQUEST` otherwise). A model
   id is versioned when it reads `name-MAJOR.MINOR.PATCH` (`jev-1.13.0`); anything else, `jev-latest` and `jev-preview`
   included, is refused at construction unless `allowAlias` is set. A pinned versioned model must come back unchanged,
   otherwise the response is `JEV_BAD_RESPONSE`: thresholds are calibrated per exact version and must not be applied to
   another one. With `allowAlias` any well-formed returned name is accepted; the record then has `exact_model: null`
   when the name is not versioned, and `reuse_key: null` always.
2. **ScriptedJev** runs the same request and response validation. Specs: `{noul}`, `{choice, p}` and `{level, p}` (the
   rest spread evenly), `{probabilities}` (missing options 0), `{fail: code}` (the whole request fails, as the service
   failed whole requests), `{raw}` (an answer object as given, to exercise validation), `delayMs` on any of them. It
   records each request that passed validation as a deep-frozen copy; request ids are `scripted-1`, `scripted-2`, ...;
   `returnedModel` simulates a service that answers with another model. A spec that does not fit the question is a
   `TypeError` (a test bug), never a simulated service failure. The default model is `jev-scripted-1.0.0`; `model` and
   `returnedModel` must carry a `scripted` segment (`jev-scripted-1.13.0`, `jev-scripted-latest`), otherwise
   `JEV_BAD_REQUEST`: the model is the judge a record names (A01 R[4]), so a scripted judgment never passes for a
   service one and never shares its reuse key.
3. **Batching.** Item `{id, piece, question}`: the piece is sent as `state[id]` beside the optional `shared` context, so
   instructions refer to it as `` `id` ``. Estimate: one token per CJK or other non-ASCII character (two outside the
   BMP), one per ASCII punctuation mark, one per three ASCII letters, digits or spaces, plus 256 per request and 32 per
   question. Each question is judged against the whole state, so the per-question limit applies to the state plus that
   question and usually binds first for long passages. Defaults are 10 questions, 48,000 estimated tokens per request
   and 24,000 per question (a quarter of 64k and 32k in reserve; the limits are read as 64,000 and 32,000). Items are
   packed in input order (deterministic); an item that does not fit alone is reported in `oversized` and never sent.
4. **askAll.** At most `concurrency` (default 2) requests in flight. askAll only decides between splitting and stopping:
   - a failure the batch's content can cause splits a batch of two or more items once into two halves, sent one after
     the other so the bound holds; halves are not split again: `JEV_TOO_LARGE`, a `JEV_BAD_RESPONSE` that names a
     question, a refused body (`JEV_BAD_REQUEST` from a 400, a 422 or local validation), and `JEV_UNAVAILABLE`
     (an outage and one request the service cannot finish look alike);
   - a plan-wide failure stops the plan: no split and no batch started after it. These are `JEV_UNAUTHORIZED`,
     `JEV_RATE_LIMITED` (halves would go out right after the service asked for a pause), a `JEV_BAD_RESPONSE` naming
     no question (another model, the key echoed, a malformed body: every request would fail, each one billed), another
     4xx (404, 415: the endpoint or the account), a redirect (3xx, never followed: the endpoint), and
     `UNAVAILABLE_STREAK_LIMIT` (3) requests in a row ending `JEV_UNAVAILABLE`: a batch and both its halves, or three
     single-question batches.
   Items never sent fail with the stop's code, `attempts: 0` and no status or request id; oversized items fail as
   `JEV_TOO_LARGE` with `attempts: 0`. An error that is not a `JevError` (a bug) rejects `askAll` once the batches in
   flight are done. Results are assembled in plan order.
5. **Judgment record** (plain snake_case JSON for the knowledge package to store): `requested_model`, `returned_model`,
   `exact_model`, `request_id`, `question_id`, `question_type`, `instructions`, `candidates` (ordered `{name,
   description}`; `true`/`false` for yes/no, `0`..`n-1` for scores), `input_digest` (SHA-256 of the RFC 8785 canonical
   JSON of the input the caller names, the piece, via `hub/records` `canonicalize`), `state_digest` (the same over the
   whole state of the request, which is what the model saw: every question is judged against all pieces and the shared
   context), `probabilities` per candidate (for yes/no `false` is `1 - noul`, derived), `answer` as validated, `usage`
   of the whole request, `judged_at` (supplied by the caller, ISO 8601 UTC), `reuse_key`.
6. **Reuse key** = SHA-256 of the canonical JSON of `{format: "jev-reuse@2", model, type, instructions, candidates as
   ordered [name, description] pairs, state_digest}`: a judgment is reused only while what the model saw is unchanged
   (K04 R[2], C08 R[4]). `planBatches` is deterministic, so an unchanged item list regenerates the same states and
   every key matches; a changed piece gives every question of its batch a new key, and an item added or removed shifts
   the batches after it. Plan one question per request when per-piece reuse matters more than the request count. A key
   can be computed before asking, from `batchRequest`'s state. It leaves out the question id (never shown to the model)
   but includes the instructions, which name the piece's state key, so ids must stay stable for an unchanged input.
   Option order is part of the key because the model favours earlier options. A missing description counts as null.
   The format is pinned by a golden test cross-checked with `shasum -a 256`.
7. **Placement helpers.** `topChoice` gives the top candidate, its p, the margin to the runner-up (0 on a tie) and
   whether it is the none option (`none` by default; for yes/no, `false`). `shouldDescend(answer, threshold)` is true
   only when the top is not the none option, not tied, finite and not below the threshold; a `null` threshold (an
   uncalibrated chain) or one outside [0, 1] never descends.
8. **Dependencies.** Node built-ins and `hub/records/api.ts` (`canonicalize`, `sha256Hex`) only, so digests match the
   rest of the Hub. The architecture's dependency rule does not list jev; knowledge → jev → records(api) has no cycle.
   The question types were the vendor's API discriminators, not a vocabulary axis.

## Limits

- The token estimate is a heuristic: the service's tokenizer was never published.
- `ask()` and `askAll()` take no cancellation signal or deadline.
- With the client removed there is no live validation of the shapes against a real service; the scripted judge and
  the loopback-tested past of the removed client are the only evidence. The removed client (revision before the
  removal) had been tested only against a loopback stub written from the vendor's OpenAPI spec, never a live call.

## How to test

```
node --test "hub/jev/**/*.test.ts"
```

The tests use the scripted judge and synthetic requests only; no test makes a network call.

## Needs from other packages

- **contracts**: the `JEV_*` codes are internal to knowledge placement and are not in `contracts/codes.json` or the
  protocol codes. If a knowledge sync report is to surface them, register them (or name the existing code they should
  map to).
- **knowledge**: add the none option to every choice question (it counts toward 255); name options by something other
  than a bare number (a node id `12` becomes `n12`); keep item ids stable for an unchanged input; store `judgmentRecord`
  bodies and reuse by `reuse_key`, which rests on the whole state of the request (null means ask again); skip a batch
  only when every key of it is stored; pass the calibrated threshold, or null, to `shouldDescend`; calibrate and test
  thresholds against a scripted judge under a scripted model name, never a vendor one; the K04 R[5] display text is
  yours. When `askAll` stops a plan, the items it did not send fail with `attempts: 0`: ask them again later. The client
  contract is `ask(request) -> response`: one request holds one state and its questions; many pieces of one state go
  through `planBatches`, `batchRequest` and `askAll`.
