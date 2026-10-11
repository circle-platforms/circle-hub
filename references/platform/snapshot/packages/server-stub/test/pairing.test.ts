import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CLI_EXIT_CODES,
  type ResponseEnvelope,
  ResponseEnvelopeSchema,
} from "@infosec/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { LongTaskService } from "../src/service.js";
import { createStubHttpServer } from "../src/http-server.js";

const execFileAsync = promisify(execFile);
const distDir = fileURLToPath(new URL("../dist", import.meta.url));

interface Step {
  call: string;
  payload: Record<string, unknown>;
  idem?: string;
  scope?: string;
  schemaVersion?: string;
  inputRevision?: "current" | "stale";
  expectStatus: string;
  expectError?: string;
  expectOpStatus?: string;
  expectExecutorRuns?: number;
  expectDuplicate?: boolean;
  expectReconciled?: boolean;
  expectPending?: boolean;
}

interface Scenario {
  name: string;
  steps: Step[];
}

const vectors = JSON.parse(
  readFileSync(new URL("../fixtures/vectors.json", import.meta.url), "utf8"),
) as { scenarios: Scenario[] };

type CallFn = (call: string, envelope: unknown) => Promise<ResponseEnvelope>;

/* ------------------------- transport adapters ---------------------- */

async function httpTransport(): Promise<{ call: CallFn; close: () => Promise<void> }> {
  const service = new LongTaskService();
  const server = createStubHttpServer(service);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  return {
    call: async (call, envelope) => {
      const res = await fetch(`http://127.0.0.1:${addr.port}/v1/task/${call}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(envelope),
      });
      if (res.status !== 200) throw new Error(`http transport status ${res.status}`);
      return ResponseEnvelopeSchema.parse(await res.json());
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function cliTransport(): { call: CallFn; close: () => Promise<void> } {
  const dir = mkdtempSync(join(tmpdir(), "stub-cli-"));
  const stateFile = join(dir, "state.json");
  return {
    call: async (call, envelope) => {
      const envFile = join(dir, "envelope.json");
      writeFileSync(envFile, JSON.stringify(envelope));
      let stdout = "";
      let exitCode = 0;
      try {
        const out = await execFileAsync(
          process.execPath,
          [join(distDir, "cli.js"), call, envFile],
          { env: { ...process.env, STUB_STATE_FILE: stateFile } },
        );
        stdout = out.stdout;
      } catch (e) {
        const err = e as { stdout?: string; code?: number };
        stdout = err.stdout ?? "";
        exitCode = typeof err.code === "number" ? err.code : 1;
        if (!stdout) throw e;
      }
      const parsed = ResponseEnvelopeSchema.parse(JSON.parse(stdout));
      expect(CLI_EXIT_CODES[parsed.status], "CLI exit code must match FZ-01 mapping").toBe(
        exitCode,
      );
      return parsed;
    },
    close: async () => {},
  };
}

async function mcpTransport(): Promise<{ call: CallFn; close: () => Promise<void> }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(distDir, "mcp-server.js")],
  });
  const client = new Client({ name: "pairing-test", version: "0.1.0" });
  await client.connect(transport);
  return {
    call: async (call, envelope) => {
      const result = await client.callTool({
        name: `task_${call}`,
        arguments: { envelope: envelope as Record<string, unknown> },
      });
      const content = result.content as { type: string; text?: string }[];
      const text = content.find((c) => c.type === "text")?.text;
      if (!text) throw new Error("mcp tool returned no text content");
      return ResponseEnvelopeSchema.parse(JSON.parse(text));
    },
    close: async () => {
      await client.close();
    },
  };
}

/* ------------------------- scenario runner ------------------------- */

interface StepActual {
  status: string;
  errorCode: string | null;
  opStatus: string | null;
  executorRuns: number | null;
  duplicate: boolean;
  reconciled: boolean;
  pendingCount: number;
}

async function runScenario(
  scenario: Scenario,
  transport: { call: CallFn },
): Promise<{ actual: StepActual[]; envelopes: ResponseEnvelope[] }> {
  const ctx = { opId: "", inrev: "" };
  const actual: StepActual[] = [];
  const envelopes: ResponseEnvelope[] = [];

  for (let i = 0; i < scenario.steps.length; i++) {
    const step = scenario.steps[i]!;
    const payload: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(step.payload)) {
      payload[k] = v === "$op" ? ctx.opId : v;
    }
    const envelope: Record<string, unknown> = {
      schemaVersion: step.schemaVersion ?? "1.2.0",
      requestId: `req_${scenario.name}_${i}`,
      idempotencyKey: step.idem ?? `idem-${scenario.name}-${i}`,
      principalId: "prn_tester",
      tenantId: "tnt_test",
      scopeId: step.scope ?? "scp_test",
      payload,
    };
    if (step.inputRevision === "current") envelope.inputRevisionId = ctx.inrev;
    if (step.inputRevision === "stale") envelope.inputRevisionId = "inrev_stale";

    const response = await transport.call(step.call, envelope);
    envelopes.push(response);

    const result = (response.result ?? {}) as Record<string, unknown>;
    if (typeof result.operationId === "string") ctx.opId = result.operationId;
    if (response.pendingInputs.length > 0) {
      ctx.inrev = response.pendingInputs[0]!.inputRevisionId;
    }

    actual.push({
      status: response.status,
      errorCode: response.error?.code ?? null,
      opStatus: (result.operationStatus as string) ?? null,
      executorRuns:
        typeof result.executorRuns === "number" ? result.executorRuns : null,
      duplicate: result.duplicate === true,
      reconciled: result.reconciled === true,
      pendingCount: response.pendingInputs.length,
    });
  }
  return { actual, envelopes };
}

function assertExpectations(scenario: Scenario, actual: StepActual[]): void {
  scenario.steps.forEach((step, i) => {
    const a = actual[i]!;
    const label = `${scenario.name}[${i}] ${step.call}`;
    expect(a.status, label).toBe(step.expectStatus);
    if (step.expectError !== undefined) expect(a.errorCode, label).toBe(step.expectError);
    if (step.expectOpStatus !== undefined) expect(a.opStatus, label).toBe(step.expectOpStatus);
    if (step.expectExecutorRuns !== undefined)
      expect(a.executorRuns, label).toBe(step.expectExecutorRuns);
    if (step.expectDuplicate !== undefined)
      expect(a.duplicate, label).toBe(step.expectDuplicate);
    if (step.expectReconciled !== undefined)
      expect(a.reconciled, label).toBe(step.expectReconciled);
    if (step.expectPending !== undefined)
      expect(a.pendingCount > 0, label).toBe(step.expectPending);
  });
}

/* ------------------------- the pairing suite ----------------------- */

const closers: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const close of closers) await close();
});

describe("P1-3 three-transport pairing (MCP / CLI / HTTP)", () => {
  for (const scenario of vectors.scenarios) {
    it(`scenario ${scenario.name}: identical envelopes on all three transports`, async () => {
      const http = await httpTransport();
      const cli = cliTransport();
      const mcp = await mcpTransport();
      closers.push(http.close, cli.close, mcp.close);
      try {
        const viaHttp = await runScenario(scenario, http);
        const viaCli = await runScenario(scenario, cli);
        const viaMcp = await runScenario(scenario, mcp);

        assertExpectations(scenario, viaHttp.actual);
        // Full-envelope equality across transports is the pairing claim:
        // same inputs, same business states, errors and receipts.
        expect(viaCli.envelopes).toEqual(viaHttp.envelopes);
        expect(viaMcp.envelopes).toEqual(viaHttp.envelopes);
      } finally {
        await http.close();
        await cli.close();
        await mcp.close();
      }
    }, 60000);
  }
});
