# Keep the connection of a long tool call alive

Measured on the production Hub: tool calls that need more than five minutes (quality-board runs, large tree reads) fail on the client with `fetch failed`, although the server finishes them. An experiment with the Node runtime that Circle ships showed why: `fetch` gives up with `UND_ERR_HEADERS_TIMEOUT` after 301 s when response headers have not been received, and a head that is written but not flushed does not count; a flushed head followed by a byte every 30 s kept the request alive for the whole 330 s.

Change: in the JSON-mode MCP handler a `tools/call` that is still working after `headersAfterMs` (default 20 s) gets its response head sent and flushed (HTTP 200, `application/json`, no content-length), then one space every `keepaliveMs` (default 30 s) as insignificant whitespace before the JSON body. Answers that finish earlier keep the one-piece answer with a content-length. The timing is an option (`AppOptions.keepalive`) so tests can shorten it.

Allowed paths: `hub/server/mcp.ts`, `hub/server/app.ts`, `hub/server/api.ts`, `hub/server/testing.ts`, `hub/server/long-call-keepalive.test.ts`, this page.

Verification: the new test file (raw HTTP timing and the SDK client), and `affected-tests.py --run` against hub-redesign (decision 80).
