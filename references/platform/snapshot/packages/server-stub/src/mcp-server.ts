import { existsSync, readFileSync, renameSync, writeFileSync, appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { LongTaskService } from "./service.js";

/**
 * MCP transport for the stub (stdio, official TypeScript SDK).
 * Six tools mirror the six long-task calls; each takes { envelope } and
 * returns the response envelope as a JSON text content block. The tool
 * result is a success at the MCP layer whenever the service produced an
 * envelope — business failure lives in the envelope, per the contracts.
 *
 * P3-4 additions (all opt-in via environment; defaults unchanged, so
 * the P1-3 pairing behaviour is untouched):
 * - STUB_STATE_FILE: persist service state like the CLI transport, so
 *   sequential MCP clients (different harnesses) share one task state
 *   that outlives any client process (R01/R06).
 * - STUB_NEGOTIATION_LOG: append the raw initialize request (client
 *   identity, proposed protocol version, capabilities) and the
 *   initialize result (negotiated protocol version) as JSON lines —
 *   the server-side evidence for capability-negotiation records.
 * - STUB_AUDIT_LOG + STUB_PRINCIPAL: append one line per tool call
 *   naming the principal this server instance acts for (R05/R06).
 */

const CALLS = ["submit", "status", "result", "input", "cancel", "reconcile"] as const;
type Call = (typeof CALLS)[number];

const stateFile = process.env.STUB_STATE_FILE;
const negotiationLog = process.env.STUB_NEGOTIATION_LOG;
const auditLog = process.env.STUB_AUDIT_LOG;
const principal = process.env.STUB_PRINCIPAL ?? "unknown";

const service =
  stateFile && existsSync(stateFile)
    ? LongTaskService.restore(JSON.parse(readFileSync(stateFile, "utf8")))
    : new LongTaskService();

function persist(): void {
  if (!stateFile) return;
  const tmp = `${stateFile}.tmp`;
  writeFileSync(tmp, JSON.stringify(service.snapshot()));
  renameSync(tmp, stateFile);
}

function logLine(path: string | undefined, entry: Record<string, unknown>): void {
  if (path) appendFileSync(path, `${JSON.stringify(entry)}\n`);
}

const server = new Server(
  { name: "infosec-stub", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: CALLS.map((call) => ({
    name: `task_${call}`,
    description: `Long-task ${call} call of the infosec stub (P1-3 pairing)`,
    inputSchema: {
      type: "object" as const,
      properties: {
        envelope: {
          type: "object" as const,
          description: "RequestEnvelope per @infosec/contracts FZ-04",
        },
      },
      required: ["envelope"],
    },
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const call = name.replace(/^task_/, "") as Call;
  if (!(CALLS as readonly string[]).includes(call)) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: `unknown tool: ${name}` }],
    };
  }
  const args = (request.params.arguments ?? {}) as { envelope?: unknown };
  const response = service[call](args.envelope);
  persist();
  logLine(auditLog, {
    event: "tool-call",
    principal,
    tool: name,
    requestId: (args.envelope as { requestId?: string } | undefined)?.requestId,
    responseStatus: response.status,
    operationId: (response.result as { operationId?: string } | undefined)?.operationId,
  });
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(response) },
    ],
  };
});

const transport = new StdioServerTransport();

if (negotiationLog) {
  // Sniff the initialize exchange at the transport boundary without
  // disturbing negotiation: wrap the onmessage setter for requests
  // and send() for the result.
  let innerOnMessage: ((message: unknown) => void) | undefined;
  Object.defineProperty(transport, "onmessage", {
    configurable: true,
    get() {
      return innerOnMessage;
    },
    set(fn: (message: unknown) => void) {
      innerOnMessage = (message: unknown) => {
        const msg = message as {
          method?: string;
          params?: {
            protocolVersion?: string;
            clientInfo?: unknown;
            capabilities?: unknown;
          };
        };
        if (msg.method === "initialize" && msg.params) {
          logLine(negotiationLog, {
            event: "initialize-request",
            principal,
            protocolVersion: msg.params.protocolVersion,
            clientInfo: msg.params.clientInfo,
            capabilities: msg.params.capabilities,
          });
        }
        fn(message);
      };
    },
  });
  const originalSend = transport.send.bind(transport);
  transport.send = async (message: unknown) => {
    const msg = message as { result?: { protocolVersion?: string } };
    if (msg.result?.protocolVersion) {
      logLine(negotiationLog, {
        event: "initialize-result",
        principal,
        protocolVersion: msg.result.protocolVersion,
      });
    }
    return originalSend(message as never);
  };
}

await server.connect(transport);
