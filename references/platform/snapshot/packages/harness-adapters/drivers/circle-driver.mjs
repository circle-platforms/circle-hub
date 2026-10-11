// Generic Circle MCP driver: connects Circle's OWN McpManager
// (built from the pinned circle checkout) to the platform stub and
// invokes the requested tools in order, printing every response
// envelope as one `ENV <json>` line.
//
// Usage:
//   node circle-driver.mjs <circleDistDir> <callsJsonFile>
// Environment: STUB_STATE_FILE, STUB_NEGOTIATION_LOG, STUB_AUDIT_LOG,
// STUB_PRINCIPAL, STUB_ENTRY (absolute path of the stub's MCP entry).
// Note: Circle's interactive approval card lives in its fullscreen
// UI layer; this driver exercises the same loader/client machinery
// the UI drives (see docs/p3-4-harness-record.md).
import { readFileSync } from "node:fs";
import { join } from "node:path";

const [circleDist, callsFile] = process.argv.slice(2);
const { McpManager } = await import(join(circleDist, "mcp_loader.js"));

const manager = new McpManager(process.cwd());
await manager.load([
  {
    name: "infosec",
    command: "node",
    args: [process.env.STUB_ENTRY],
    env: {
      STUB_STATE_FILE: process.env.STUB_STATE_FILE,
      STUB_NEGOTIATION_LOG: process.env.STUB_NEGOTIATION_LOG,
      STUB_AUDIT_LOG: process.env.STUB_AUDIT_LOG,
      STUB_PRINCIPAL: process.env.STUB_PRINCIPAL ?? "circle-actor-1",
    },
  },
]);

const failed = manager.status.find((s) => s.error);
if (failed) throw new Error(`circle MCP load failed: ${failed.error}`);

const calls = JSON.parse(readFileSync(callsFile, "utf8"));
for (const call of calls) {
  const tool = manager.tools.find((t) => t.name === `infosec_${call.tool}`);
  if (!tool) throw new Error(`tool not registered: ${call.tool}`);
  const result = await tool.run(
    { envelope: call.envelope },
    { signal: AbortSignal.timeout(30_000) },
  );
  const text = typeof result === "string" ? result : JSON.stringify(result);
  const envelopeText = text.startsWith("{") ? text : text.slice(text.indexOf("{"));
  console.log(`ENV ${envelopeText}`);
}
process.exit(0);
