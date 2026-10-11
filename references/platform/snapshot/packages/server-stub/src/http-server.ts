import { createServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";
import { LongTaskService } from "./service.js";

/**
 * HTTP transport for the stub: POST /v1/task/<call> with a request
 * envelope as JSON body; the response envelope is the JSON body of a
 * 200 response. Business status lives in the envelope, not the HTTP
 * status line, so all three transports carry identical semantics.
 * Only an unparseable body is a transport-level 400.
 */

const CALLS = ["submit", "status", "result", "input", "cancel", "reconcile"] as const;
type Call = (typeof CALLS)[number];

export function createStubHttpServer(service: LongTaskService): Server {
  return createServer((req, res) => {
    const match = /^\/v1\/task\/(submit|status|result|input|cancel|reconcile)$/.exec(
      req.url ?? "",
    );
    if (req.method !== "POST" || !match) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    const call = match[1] as Call;
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let envelope: unknown;
      try {
        envelope = JSON.parse(body);
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "request body is not valid JSON" }));
        return;
      }
      const response = service[call](envelope);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(response));
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.STUB_PORT ?? 8730);
  const server = createStubHttpServer(new LongTaskService());
  server.listen(port, () => {
    console.error(`stub http server listening on ${port}`);
  });
}
