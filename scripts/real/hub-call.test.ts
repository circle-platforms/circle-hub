// Tests for scripts/real/hub-call.ts:
//   - --structured <file> appends one JSON line per call in order
//   - errored calls are written with error clearly marked
//   - screen output format remains unchanged
//   - successive calls append to existing file content
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { callTools, formatStructured, main } from './hub-call.ts';

describe('hub-call structured output', () => {
  let tempDir: string;
  let server: Server;
  let serverUrl: string;
  const token = 'test-secret-token';
  let tokenFile: string;

  before(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'hub-call-test-'));
    tokenFile = join(tempDir, 'token.txt');
    writeFileSync(tokenFile, token, 'utf8');

    server = createServer(async (req, res) => {
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${token}`) {
        res.writeHead(401, { 'content-type': 'text/plain' });
        res.end('Unauthorized');
        return;
      }

      const mcp = new McpServer({ name: 'fake-hub-server', version: '1.0.0' }, { capabilities: { tools: {} } });
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          { name: 'inspect_node', description: 'inspect node', inputSchema: { type: 'object' } },
          { name: 'failing_tool', description: 'fails', inputSchema: { type: 'object' } },
          { name: 'plain_error_tool', description: 'plain error', inputSchema: { type: 'object' } },
        ],
      }));

      mcp.setRequestHandler(CallToolRequestSchema, async (message) => {
        const name = message.params.name;
        const args = (message.params.arguments ?? {}) as Record<string, unknown>;

        if (name === 'slow_tool') {
          await new Promise(resolve => setTimeout(resolve, 120));
          return { content: [{ type: 'text', text: '合成工具结束' }], structuredContent: { call_result: 'ok' } };
        }
        if (name === 'inspect_node') {
          return {
            content: [{ type: 'text', text: `Node inspected: ${args.path}` }],
            structuredContent: {
              call_result: 'ok',
              path: args.path,
              node_count: 5,
            },
          };
        }
        if (name === 'failing_tool') {
          return {
            isError: true,
            content: [{ type: 'text', text: `Operation refused: ${args.reason ?? 'unknown'}` }],
            structuredContent: {
              call_result: 'error',
              errors: [{ code: 'OP_REFUSED', message: args.reason ?? 'failed' }],
            },
          };
        }
        if (name === 'plain_error_tool') {
          return {
            isError: true,
            content: [{ type: 'text', text: 'Internal failure without structured payload' }],
          };
        }
        throw new Error(`Unknown tool ${name}`);
      });

      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    });

    await new Promise<void>((resolvePromise) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
        serverUrl = `http://127.0.0.1:${port}/mcp`;
        resolvePromise();
      });
    });
  });

  after(() => {
    server?.close();
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup error
      }
    }
  });

  test('per-call timeout refuses a slow tool only when the timeout is shorter than its delay', async () => {
    const options = { url: serverUrl, token, session: 'synthetic-timeout' };
    assert.equal((await callTools({ ...options, timeoutMs: 20 }, [{ tool: 'slow_tool', args: {} }]))[0].isError, true);
    assert.equal((await callTools({ ...options, timeoutMs: 1000 }, [{ tool: 'slow_tool', args: {} }]))[0].isError, false);
  });

  test('formatStructured marks errors clearly and preserves ok structuredContent', () => {
    // Ok with structured object
    assert.deepEqual(formatStructured({ isError: false, structured: { call_result: 'ok', data: 123 } }), {
      call_result: 'ok',
      data: 123,
    });

    // Ok without structured content defaults to empty object
    assert.deepEqual(formatStructured({ isError: false, structured: undefined }), {});

    // Error with call_result: 'error' preserved
    assert.deepEqual(
      formatStructured({
        isError: true,
        structured: { call_result: 'error', errors: [{ code: 'X' }] },
      }),
      { call_result: 'error', errors: [{ code: 'X' }] },
    );

    // Error with structured content missing error marker gets isError: true
    assert.deepEqual(formatStructured({ isError: true, structured: { partial: true } }), {
      isError: true,
      partial: true,
    });

    // Error without structured content produces error record
    assert.deepEqual(formatStructured({ isError: true, structured: undefined, text: 'Network down' }), {
      isError: true,
      error: 'Network down',
    });
  });

  test('callTools appends structured results line by line in call order', async () => {
    const structuredFile = join(tempDir, 'calls.jsonl');
    const results = await callTools(
      { url: serverUrl, token, session: 'sess-1', structuredFile },
      [
        { tool: 'inspect_node', args: { path: '/commands/test' } },
        { tool: 'failing_tool', args: { reason: 'quota exceeded' } },
        { tool: 'plain_error_tool', args: {} },
      ],
    );

    assert.equal(results.length, 3);
    assert.equal(results[0].isError, false);
    assert.equal(results[1].isError, true);
    assert.equal(results[2].isError, true);

    const raw = readFileSync(structuredFile, 'utf8').trim().split('\n');
    assert.equal(raw.length, 3);

    const line0 = JSON.parse(raw[0]);
    assert.equal(line0.call_result, 'ok');
    assert.equal(line0.path, '/commands/test');
    assert.equal(line0.node_count, 5);

    const line1 = JSON.parse(raw[1]);
    assert.equal(line1.call_result, 'error');
    assert.equal(line1.errors[0].code, 'OP_REFUSED');

    const line2 = JSON.parse(raw[2]);
    assert.equal(line2.isError, true);
    assert.match(line2.error, /Internal failure/);

    // Calling again appends without overwriting
    await callTools(
      { url: serverUrl, token, session: 'sess-2', structuredFile },
      [{ tool: 'inspect_node', args: { path: '/commands/another' } }],
    );

    const rawAppended = readFileSync(structuredFile, 'utf8').trim().split('\n');
    assert.equal(rawAppended.length, 4);
    const line3 = JSON.parse(rawAppended[3]);
    assert.equal(line3.path, '/commands/another');
  });

  test('main CLI supports --structured and preserves stdout', async () => {
    const structuredFile = join(tempDir, 'cli-structured.jsonl');
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    };

    try {
      const exitCode = await main([
        '--token-file',
        tokenFile,
        '--url',
        serverUrl,
        '--structured',
        structuredFile,
        'inspect_node',
        JSON.stringify({ path: '/commands/cli' }),
      ]);

      assert.equal(exitCode, 0);
      assert.ok(logs.some((l) => l.includes('== inspect_node')));
      assert.ok(logs.some((l) => l.includes('Node inspected: /commands/cli')));

      const content = readFileSync(structuredFile, 'utf8').trim().split('\n');
      assert.equal(content.length, 1);
      const parsed = JSON.parse(content[0]);
      assert.equal(parsed.path, '/commands/cli');
    } finally {
      console.log = originalLog;
    }
  });
});
