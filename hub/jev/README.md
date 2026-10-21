# hub/jev: typed-judgment model client

Model element **K04** (classification by the typed judgment model): only yes/no (`noul`), single choice and score
questions (R[0]); abstention or a probability below the chain's calibrated threshold stops at the parent (R[1]); every
judgment records the exact model version, the question, the candidates, the input digest and the probabilities, and an
unchanged input (the whole state the model saw) reuses the earlier judgment (R[2]); development uses a scripted judge
under a scripted model name (R[4]). Other packages import only
from `hub/jev/api.ts`. The knowledge package owns placement, calibration, storage and display; this package owns the
vendor call and the pure helpers around it.

| File | Content |
| --- | --- |
| `api.ts` | types (`JevQuestion`, `JevRequest`, `JevAnswer`, `JevResponse`, `JevClient`) and every export |
| `errors.ts` | `JevError` with `code`, `status`, `requestId`, `attempts`, `reasons`, `questionId` |
| `validate.ts` | request and response validation shared by both clients; model id rules |
| `http.ts` | `HttpJev`: `POST /v1/systemone`, retries, timeouts, error mapping |
| `scripted.ts` | `ScriptedJev`: deterministic judge for tests and development |
| `tokens.ts` | conservative token estimate for mixed Chinese and English |
| `batch.ts` | `planBatches`, `batchRequest`, `askAll` |
| `record.ts` | `judgmentRecord`, `inputDigest`, `reuseKey`, `candidatesOf` |
| `decide.ts` | `topChoice`, `shouldDescend`, `NONE_OPTION` |
| `test-support.ts` | loopback stub of the vendor API, loopback-only fetch, synthetic requests |

```ts
// The caller supplies the key source; an absent entry gives '' and every call fails as JEV_UNAUTHORIZED.
const jev = new HttpJev({ apiKey: async () => (await kit.vault.getText('<entry name>')) ?? '', model: 'jev-1.13.0' });
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
2. **The API key.** `apiKey()` is called once per attempt, inside that attempt's timeout; the value must be an RFC 6750
   Bearer token (letters, digits, `- . _ ~ + /`, then optional `=`; at most 4096 characters), so it can never inject a
   header, appear in a fetch error about a header value, or be escaped in JSON text. It goes only into
   `Authorization: Bearer` and lives only in the scope of one attempt: the client keeps the function, in a private field
   (a test counts the calls, since inspection never shows private fields). A key source that fails, returns a malformed
   key or does not answer within the timeout becomes `JEV_UNAUTHORIZED` without its message or cause; nothing is sent
   and the attempt is not counted. When that happens on a retry, the error keeps the code, status and request id of the
   request before it and says the retry was not sent. Anything the service sends back that holds the key, a run of 12
   of its characters, or a piece of it of 8 or more characters (an echoing proxy, a misconfigured endpoint) is refused:
   a 200 body whole as `JEV_BAD_RESPONSE`, literally or escaped; a request id or error reason is dropped. Nothing in
   the package logs.
3. **Transport.** Default base URL `https://api.typesafe.ai`; a path prefix is kept; credentials, query and fragment are
   refused; plain `http` is accepted only for loopback hosts, so a key never crosses a network in clear. Redirects are
   not followed. Headers: `Authorization`, `Content-Type: application/json`, `Accept`; `x-typesafe-request-id` is read
   and kept when it is 1-128 letters, digits, `. _ : -`. No compression, no long-context header, no images.
4. **Error mapping.** Messages are Chinese and never contain a key, a request body or anything the service sent (a 422
   body echoes request content; the returned model is not quoted either). An error body is read up to 64 KiB only to
   find `max_tokens_exceeded` and machine-readable cause codes, then discarded. Both are taken only where a body names
   its cause: `type` or `code` (kept in `reasons`, safe alphabet only) and `message` or `msg` (searched for the marker)
   at the top level, in `error` and `detail` objects and in the items of a `detail` array, plus `detail` or `error`
   given as a string. A copy of the request elsewhere (`input` members, a gateway's echo) is never read. A body cut at
   64 KiB is no longer JSON: only its text before the first `"input"` is searched for the marker, and it gives no
   reasons; a plain-text body is searched whole.

   | Code | When | Retried |
   | --- | --- | --- |
   | `JEV_UNAUTHORIZED` | 401, 403, missing or malformed key, a key source that fails or does not answer in time | no |
   | `JEV_RATE_LIMITED` | 429, 529 | yes, unless the service asks for more than 60 s |
   | `JEV_BAD_REQUEST` | local validation; 400, 404, 415, 422 and other 4xx; at construction: an alias, a scripted judge named like the service, plain http to a non-loopback host, credentials in the base URL | no |
   | `JEV_TOO_LARGE` | local body limit; 413; 400 or 422 marked `max_tokens_exceeded` | no |
   | `JEV_UNAVAILABLE` | 408, 5xx, network errors, timeouts (each attempt, key and body included); 3xx (not retried) | yes, unless the service asks for more than 60 s |
   | `JEV_BAD_RESPONSE` | a 200 that fails validation or carries the key back; a body over `maxResponseBytes`; a status other than 200 below 300 | no |

5. **Retries.** `retries` (default 2, so 3 requests at most); `attempts` counts the requests sent. The wait is
   `retry-after-ms`, else `Retry-After`: delay seconds or an RFC 9110 HTTP-date (IMF-fixdate, or the obsolete rfc850
   and asctime forms, all read as GMT and checked field by field, because `Date.parse` reads `-1` or `5, 10` as dates
   in 2001). When the service asks for more than `MAX_RETRY_AFTER_MS` (60 s) the call fails at once with the status's
   code, saying how long the service asked to wait, instead of retrying before the service said it would answer.
   Without a readable wait: 0.5 s doubling to 5 s, minus up to 25 % jitter from the injectable `random`. `sleep` and
   `now` are injectable too.
6. **Request validation** (before anything is sent, `attempts: 0`): request fields `model`, `state`, `questions` only;
   `state` a string, object or array; at least one question; question ids 1-128 of `[A-Za-z0-9_-]`, not `__proto__`;
   question fields `type`, `instructions`, `criteria` only; `instructions` a non-empty string; noul criteria only `true`
   and `false` with string or null; choice 1-255 non-empty option names with string or null descriptions, and no
   option name that is an array index (`0`, `12`, ... up to 2^32 - 2): a JavaScript object lists such keys first, in
   numeric order, so the order sent (which the model's first-option lean makes part of the question) would not be the
   order written and could not be rotated; give such names a prefix (`n12`); score 2-10
   non-empty level strings (the vendor accepts 1; one level is no scale); plain JSON data only: finite numbers, strings
   without lone surrogates (not encodable as UTF-8), plain objects, arrays without holes; nesting at most 64 levels
   counting the body object as level 1; `undefined` object members are dropped, as JSON and canonical JSON drop them;
   serialized UTF-8 at most `maxRequestBytes` (default 16 MiB, at most the service's 32 MiB), else `JEV_TOO_LARGE`.
7. **Response validation:** valid UTF-8 JSON object with no repeated member name anywhere (JSON.parse would hide a
   question answered twice); `model` well-formed (and pinned, see 1); every question answered exactly once and nothing
   else; answer type equals question type; noul in [0, 1]; choice among the options and a most probable one (1e-9),
   probabilities over exactly the options; score probabilities and legend keyed exactly `0`..`n-1`, legend values
   strings, objects or arrays, score in [0, n-1] and equal to sum(level * p) within 0.01 per level; every probability
   and confidence finite in [0, 1]; probabilities sum to 1 within 1e-3; usage counts non-negative integers. Confidence
   formulas are not recomputed (the score formula is not published) and legend text is not compared with the criteria.
   Unknown extra fields are ignored and not copied (the vendor may add fields).
8. **ScriptedJev** runs the same request and response validation. Specs: `{noul}`, `{choice, p}` and `{level, p}` (the
   rest spread evenly), `{probabilities}` (missing options 0), `{fail: code}` (the whole request fails, as the service
   fails whole requests), `{raw}` (an answer object as given, to exercise validation), `delayMs` on any of them. It
   records each request that passed validation as a deep-frozen copy; request ids are `scripted-1`, `scripted-2`, ...;
   `returnedModel` simulates a service that answers with another model. A spec that does not fit the question is a
   `TypeError` (a test bug), never a simulated service failure. The default model is `jev-scripted-1.0.0`; `model` and
   `returnedModel` must carry a `scripted` segment (`jev-scripted-1.13.0`, `jev-scripted-latest`), otherwise
   `JEV_BAD_REQUEST`: the model is the judge a record names (A01 R[4]), so a scripted judgment never passes for a
   service one and never shares its reuse key.
9. **Batching.** Item `{id, piece, question}`: the piece is sent as `state[id]` beside the optional `shared` context, so
   instructions refer to it as `` `id` ``. Estimate: one token per CJK or other non-ASCII character (two outside the
   BMP), one per ASCII punctuation mark, one per three ASCII letters, digits or spaces, plus 256 per request and 32 per
   question. Each question is judged against the whole state, so the per-question limit applies to the state plus that
   question and usually binds first for long passages. Defaults are 10 questions, 48,000 estimated tokens per request
   and 24,000 per question (a quarter of 64k and 32k in reserve; the limits are read as 64,000 and 32,000). Items are
   packed in input order (deterministic); an item that does not fit alone is reported in `oversized` and never sent.
10. **askAll.** At most `concurrency` (default 2) requests in flight. The client has already retried what retrying can
    fix, so `askAll` only decides between splitting and stopping:
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
    Measured on the pilot shape (90 items, 9 batches of 10, default retries): a persistent 429 or 529 costs 6 HTTP
    requests (81 before), model drift 2 billed answers (27), a persistent 503 or a hang at most 12 requests (81), and
    one piece the service cannot finish fails its half only. Items never sent fail with the stop's code, `attempts: 0`
    and no status or request id; oversized items fail as `JEV_TOO_LARGE` with `attempts: 0`. An error that is not a
    `JevError` (a bug) rejects `askAll` once the batches in flight are done. Results are assembled in plan order.
11. **Judgment record** (plain snake_case JSON for the knowledge package to store): `requested_model`, `returned_model`,
    `exact_model`, `request_id`, `question_id`, `question_type`, `instructions`, `candidates` (ordered `{name,
    description}`; `true`/`false` for yes/no, `0`..`n-1` for scores), `input_digest` (SHA-256 of the RFC 8785 canonical
    JSON of the input the caller names, the piece, via `hub/records` `canonicalize`), `state_digest` (the same over the
    whole state of the request, which is what the model saw: every question is judged against all pieces and the shared
    context), `probabilities` per candidate (for yes/no `false` is `1 - noul`, derived), `answer` as validated, `usage`
    of the whole request, `judged_at` (supplied by the caller, ISO 8601 UTC), `reuse_key`.
12. **Reuse key** = SHA-256 of the canonical JSON of `{format: "jev-reuse@2", model, type, instructions, candidates as
    ordered [name, description] pairs, state_digest}`: a judgment is reused only while what the model saw is unchanged
    (K04 R[2], C08 R[4]; the vendor: all questions see the same state, and accuracy falls as unrelated content grows).
    `planBatches` is deterministic, so an unchanged item list regenerates the same states and every key matches; a
    changed piece gives every question of its batch a new key, and an item added or removed shifts the batches after
    it. Plan one question per request when per-piece reuse matters more than the request count. A key can be computed
    before asking, from `batchRequest`'s state. It leaves out the question id (never shown to the model) but includes
    the instructions, which name the piece's state key, so ids must stay stable for an unchanged input. Option order is
    part of the key because the current model favours earlier options. A missing description counts as null. The format
    is pinned by a golden test cross-checked with `shasum -a 256`.
13. **Placement helpers.** `topChoice` gives the top candidate, its p, the margin to the runner-up (0 on a tie) and
    whether it is the none option (`none` by default; for yes/no, `false`). `shouldDescend(answer, threshold)` is true
    only when the top is not the none option, not tied, finite and not below the threshold; a `null` threshold (an
    uncalibrated chain) or one outside [0, 1] never descends.
14. **Dependencies.** Node built-ins and `hub/records/api.ts` (`canonicalize`, `sha256Hex`) only, so digests match the
    rest of the Hub. The architecture's dependency rule does not list jev; knowledge → jev → records(api) has no cycle.
    The question types are the vendor's API discriminators, not a vocabulary axis.

## Limits

- The token estimate is a heuristic: the service's tokenizer is not published. A real `max_tokens_exceeded` becomes
  `JEV_TOO_LARGE`, and `askAll` splits that batch once.
- The 400 body of `max_tokens_exceeded` is not in the OpenAPI spec; detection reads the places listed in decision 4. A
  marker the vendor puts anywhere else is missed: the request then fails as `JEV_BAD_REQUEST` (a 400), which `askAll`
  still splits once.
- The vendor's request id format is not published; one outside `[A-Za-z0-9._:-]{1,128}` is dropped.
- The 255-option limit includes the none option: at most 254 real candidates per question.
- `ask()` and `askAll()` take no cancellation signal or deadline. One call can wait up to 60 s per retry when the
  service asks for it. A failing plan is bounded by the stop rules of decision 10, not by time: under an outage or a
  hanging service the plan stops at the third failed call, so at most `concurrency + 2` calls are made (12 HTTP
  requests at the defaults), each request up to `timeoutMs`. A timed-out request may still be processed, and billed,
  by the service.
- Tested only against a loopback stub written from the OpenAPI spec (version 0.2.0). No test makes a live call; the
  pilot facts (pinned id returned unchanged, 28 options with 10 questions per request, per-option probabilities, no
  abstain answer) come from the owner's run, not from this package.

## How to test

```
node --test "hub/jev/**/*.test.ts"
```

The tests start a stub on 127.0.0.1 with a free port and use a fetch that refuses every other host. Keys are random
`test-only-key-...` strings generated per run.

## Needs from other packages

- **contracts**: the `JEV_*` codes are internal to knowledge placement and are not in `contracts/codes.json` or the
  protocol codes. If the server or a knowledge sync report is to surface them, register them (or name the existing code
  they should map to).
- **knowledge**: add the none option to every choice question (it counts toward 255); name options by something other
  than a bare number (a node id `12` becomes `n12`); keep item ids stable for an unchanged input; store `judgmentRecord`
  bodies and reuse by `reuse_key`, which rests on the whole state of the request (null means ask again); skip a batch
  only when every key of it is stored; pass the calibrated threshold, or null, to `shouldDescend`; calibrate and test
  thresholds against a scripted judge under a scripted model name, never a vendor one; the K04 R[5] display text is
  yours. When `askAll` stops a plan, the items it did not send fail with `attempts: 0`: ask them again later. The client
  contract is `ask(request) -> response`: one request holds one state and its questions; many pieces of one state go
  through `planBatches`, `batchRequest` and `askAll`.
- **platform / server**: supply `apiKey` from the vault (never from the environment) and a versioned model id from the
  deployment configuration.
