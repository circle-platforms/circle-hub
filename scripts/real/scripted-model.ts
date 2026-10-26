// A scripted model on loopback that speaks the Anthropic Messages API (streaming and not), so that the real Circle client can be
// driven end to end against the Hub without any real model: the client is real, the Hub is real, the answers are scripted. Every
// request Circle sends is recorded (the system prompt, the tools it offered and the last tool results as the model sees them),
// which is also how to check what a model would be shown. Nothing leaves the machine.
//   node scripts/real/scripted-model.ts --scenario <module> [--port 7440] [--log <file.jsonl>]
// A scenario module exports default `respond(turn): Reply`.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export type Block = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown } | { type: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean } | { type: string; [key: string]: unknown };
export interface Message {
  role: 'user' | 'assistant';
  content: string | Block[];
}
export interface Turn {
  /** How many assistant replies were given before this request, in this conversation. */
  index: number;
  system: unknown;
  messages: Message[];
  tools: { name: string; description?: string; input_schema?: unknown }[];
  /** Text of the tool results of the last user message, in order. */
  toolResults: { id: string; text: string; isError: boolean }[];
}
export type ReplyBlock = { text: string } | { tool: string; input: unknown };
export type Reply = ReplyBlock[];
export type Respond = (turn: Turn) => Reply | Promise<Reply>;

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : '')).join('\n');
  return '';
};

export function turnOf(body: { system?: unknown; messages?: Message[]; tools?: Turn['tools'] }): Turn {
  const messages = body.messages ?? [];
  const last = messages.at(-1);
  const toolResults =
    last && last.role === 'user' && Array.isArray(last.content)
      ? last.content
          .filter((b): b is Extract<Block, { type: 'tool_result' }> => b.type === 'tool_result')
          .map((b) => ({ id: b.tool_use_id, text: textOf(b.content), isError: b.is_error === true }))
      : [];
  return { index: messages.filter((m) => m.role === 'assistant').length, system: body.system, messages, tools: body.tools ?? [], toolResults };
}

let counter = 0;
const nextId = (prefix: string): string => `${prefix}_${(++counter).toString(36).padStart(8, '0')}`;

/** The reply as Anthropic content blocks; tool uses get fresh ids. */
export function blocksOf(reply: Reply): Block[] {
  return reply.map((r) => ('text' in r ? { type: 'text', text: r.text } : { type: 'tool_use', id: nextId('toolu'), name: r.tool, input: r.input }));
}

const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** The server-sent events of a streamed reply, in the order the API sends them. */
export function streamOf(blocks: Block[], model: string): string {
  let out = sse('message_start', { type: 'message_start', message: { id: nextId('msg'), type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
  blocks.forEach((b, index) => {
    if (b.type === 'text') {
      out += sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      out += sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } });
    } else if (b.type === 'tool_use') {
      out += sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      out += sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    }
    out += sse('content_block_stop', { type: 'content_block_stop', index });
  });
  const stop = blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
  out += sse('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } });
  out += sse('message_stop', { type: 'message_stop' });
  return out;
}

export interface ScriptedModelOptions {
  respond: Respond;
  model?: string;
  /** JSON lines of what every request carried; the system prompt and tool schemas are kept whole. */
  logFile?: string;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export function createScriptedModel(options: ScriptedModelOptions): Server {
  const model = options.model ?? 'scripted-model';
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: model, type: 'model', display_name: model }], has_more: false, first_id: model, last_id: model }));
      return;
    }
    if (req.method !== 'POST' || !url.pathname.endsWith('/messages')) {
      res.writeHead(404).end();
      return;
    }
    let body: { stream?: boolean; system?: unknown; messages?: Message[]; tools?: Turn['tools'] };
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'not JSON' } }));
      return;
    }
    const turn = turnOf(body);
    if (options.logFile) {
      appendFileSync(options.logFile, `${JSON.stringify({ at: new Date().toISOString(), index: turn.index, system: turn.system, tools: turn.tools, toolResults: turn.toolResults, lastUser: turn.messages.filter((m) => m.role === 'user').at(-1) })}\n`);
    }
    let blocks: Block[];
    try {
      blocks = blocksOf(await options.respond(turn));
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: String((error as Error).message).slice(0, 200) } }));
      return;
    }
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }).end(streamOf(blocks, model));
    } else {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({ id: nextId('msg'), type: 'message', role: 'assistant', model, content: blocks, stop_reason: blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 20 } }),
      );
    }
  });
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

if (import.meta.main) {
  const scenario = arg('scenario');
  if (!scenario) {
    console.log('用法：--scenario <模块> [--port 7440] [--log <文件>]');
    process.exitCode = 2;
  } else {
    const respond = ((await import(pathToFileURL(scenario).href)) as { default: Respond }).default;
    const port = Number(arg('port', '7440'));
    createScriptedModel({ respond, logFile: arg('log') }).listen(port, '127.0.0.1', () => console.log(`脚本化模型在 127.0.0.1:${port}`));
  }
}
