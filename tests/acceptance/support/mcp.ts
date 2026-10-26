// The MCP side of the acceptance tests: the official SDK client over streamable HTTP (createTestHub's client(), which lists
// the tools first so the SDK validates every structuredContent against the published output schema), plus the checks every
// answer must pass whatever the scenario: it parses with the tool's zod output schema of the contracts, isError equals
// `call_result === 'error'` (D05 R[1]), and the content is exactly one plain-text block (D05 R[0]).
import assert from 'node:assert/strict';
import type { z } from 'zod';
import { TOOLS } from '../../../contracts/src/tools.ts';
import type { GetNodesOutput, ListTaskPacksOutput, ResolveReferenceOutput, StartRunOutput, SubmitResultOutput, UploadFileOutput } from '../../../contracts/src/tools.ts';
import type { TestHub, ToolCallResult } from '../../../hub/server/testing-real.ts';

export interface Outputs {
  list_task_packs: z.infer<typeof ListTaskPacksOutput>;
  upload_file: z.infer<typeof UploadFileOutput>;
  start_run: z.infer<typeof StartRunOutput>;
  get_nodes: z.infer<typeof GetNodesOutput>;
  resolve_reference: z.infer<typeof ResolveReferenceOutput>;
  submit_result: z.infer<typeof SubmitResultOutput>;
}
export type ToolName = keyof Outputs;

export interface Answer<T> {
  isError: boolean;
  out: T;
  text: string;
  raw: ToolCallResult;
}

export interface McpClient {
  call<N extends ToolName>(name: N, args: Record<string, unknown>): Promise<Answer<Outputs[N]>>;
  /** Uploads bytes and returns the src: reference (asserting the upload was accepted). */
  upload(bytes: Uint8Array, name: string, mediaType?: string): Promise<string>;
  close(): Promise<void>;
}

const outputSchema = (name: string): z.ZodType => {
  const tool = TOOLS.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`no tool ${name}`);
  return tool.output;
};

/** The checks every answer passes; returns the parsed answer. */
export function checkAnswer<N extends ToolName>(name: N, raw: ToolCallResult): Answer<Outputs[N]> {
  const parsed = outputSchema(name).safeParse(raw.structuredContent);
  assert.ok(parsed.success, `${name}: the answer does not parse with its output schema: ${parsed.success ? '' : JSON.stringify(parsed.error.issues).slice(0, 1500)}`);
  const out = parsed.data as Outputs[N];
  const envelope = out as { call_result: string };
  assert.equal(raw.isError, envelope.call_result === 'error', `${name}: isError agrees with call_result (D05 R[1])`);
  assert.equal(raw.content.length, 1, `${name}: one content block`);
  assert.equal(raw.content[0].type, 'text', `${name}: the content block is plain text`);
  return { isError: raw.isError, out, text: raw.content[0].text ?? '', raw };
}

export type ConnectOptions = string | { sessionId?: string; traceparent?: string };

export async function connect(hub: TestHub, token: string, session?: ConnectOptions): Promise<McpClient> {
  const clientOptions = typeof session === 'string' ? { sessionId: session } : (session ?? {});
  const client = await hub.client(token, clientOptions);
  const wrapper: McpClient = {
    async call(name, args) {
      const raw = await client.call(name, args);
      return checkAnswer(name, raw);
    },
    async upload(bytes, name, mediaType = 'application/json') {
      const answer = await wrapper.call('upload_file', { file_path: Buffer.from(bytes).toString('base64'), name, media_type: mediaType });
      assert.equal(answer.isError, false, answer.text);
      assert.equal(answer.out.acceptance, 'accepted');
      assert.ok(answer.out.reference);
      return answer.out.reference;
    },
    close: () => client.close(),
  };
  return wrapper;
}
