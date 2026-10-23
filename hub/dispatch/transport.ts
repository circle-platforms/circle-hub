// One HTTP POST per JSON-RPC call: no redirect, reconnect, cancellation notification or automatic retry.
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import type { ExecutorDefinition, CallRole } from './definition.ts';
import { bind } from './definition.ts';
export type SaveResponse = (bytes: Uint8Array, status: number, operation: string, complete?: boolean) => Promise<string>;
export type Exchange = { value: Record<string, unknown>; source: string; received_at: string };
export const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
export class RpcClient {
  readonly definition: ExecutorDefinition;
  readonly #secret: string;
  readonly #job: string;
  readonly #save: SaveResponse;
  #id = 0;
  #session: string | undefined;
  #protocol = LATEST_PROTOCOL_VERSION;
  constructor(definition: ExecutorDefinition, secret: string, job: string, save: SaveResponse) {
    this.definition = definition; this.#secret = secret; this.#job = job; this.#save = save;
    if (!secret || /[\r\n]/.test(secret)) throw new Error('执行器密钥缺失或无效');
  }
  redact(text: string): string {
    let safe = text;
    for (const spelling of [this.#secret, JSON.stringify(this.#secret).slice(1, -1), encodeURIComponent(this.#secret)]) safe = safe.split(spelling).join('[已隐藏]');
    return safe;
  }
  async connect(): Promise<void> {
    const init = await this.rpc('initialize', { protocolVersion: this.#protocol, capabilities: {}, clientInfo: { name: 'circle-hub', version: '1.0.0' } });
    if (typeof init.value.protocolVersion !== 'string' || !SUPPORTED_PROTOCOL_VERSIONS.includes(init.value.protocolVersion)) throw new Error('目标协议版本不可用');
    this.#protocol = init.value.protocolVersion;
    await this.rpc('notifications/initialized', {}, true);
    const seen = new Set<string>(); let cursor: string | undefined;
    const visited = new Set<string>();
    do {
      const page = await this.rpc('tools/list', cursor ? { cursor } : {});
      if (!Array.isArray(page.value.tools)) throw new Error('目标工具清单无效');
      for (const tool of page.value.tools) if (object(tool) && typeof tool.name === 'string') seen.add(tool.name);
      const next = page.value.nextCursor;
      if (next !== undefined && (typeof next !== 'string' || visited.has(next) || visited.size >= 100)) throw new Error('目标工具清单分页无效');
      cursor = typeof next === 'string' ? next : undefined; if (cursor) visited.add(cursor);
    } while (cursor);
    if (this.definition.allowed_tools.some(name => !seen.has(name))) throw new Error('目标缺少允许清单中的工具；未提交');
  }
  async call(role: CallRole, context: Readonly<Record<string, unknown>>): Promise<Exchange> {
    const declaration = this.definition.calls[role];
    if (!this.definition.allowed_tools.includes(declaration.tool)) throw new Error('调用不在允许工具清单内');
    const response = await this.rpc('tools/call', { name: declaration.tool, arguments: bind(declaration.arguments, context) }, false,
      role === 'submit' ? this.definition.submit_timeout_ms : declaration.timeout_ms, role);
    const result = response.value;
    if (result.isError === true) throw new Error('目标工具报告错误；回答已保存');
    if (object(result.structuredContent)) return { ...response, value: result.structuredContent };
    const text = Array.isArray(result.content) ? result.content.filter(object).filter(c => c.type === 'text').map(c => c.text).join('\n') : '';
    try { const value: unknown = JSON.parse(text); if (object(value)) return { ...response, value }; } catch { /* Stored verbatim before semantic parsing. */ }
    throw new Error('目标工具回答不是 JSON 对象；回答已保存');
  }
  private async rpc(method: string, params: unknown, notification = false, timeout = 30000, operation: string = method): Promise<Exchange> {
    const id = ++this.#id;
    const body = JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, params });
    if (Buffer.byteLength(body) > this.definition.max_bytes * 2) throw new Error('请求超过字节上限');
    const u = new URL(this.definition.endpoint);
    const received = await new Promise<{ bytes: Buffer; status: number; session?: string; complete: boolean }>(resolve => {
      const chunks: Buffer[] = []; let length = 0; let status = 0; let session: string | undefined; let finished = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (complete: boolean) => {
        if (finished) return; finished = true; clearTimeout(timer);
        resolve({ bytes: Buffer.concat(chunks), status, session, complete });
      };
      const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(u, {
        method: 'POST', agent: false, ...(u.protocol === 'https:' ? { ca: this.definition.ca, rejectUnauthorized: true } : {}),
        headers: { authorization: `Bearer ${this.#secret}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-circle-hub-operator': this.#job,
          'mcp-protocol-version': this.#protocol, ...(this.#session ? { 'mcp-session-id': this.#session } : {}) },
      }, res => {
        status = res.statusCode ?? 0;
        session = typeof res.headers['mcp-session-id'] === 'string' ? res.headers['mcp-session-id'] : undefined;
        res.on('data', (data: Buffer) => {
          const remaining = this.definition.max_bytes - length;
          if (remaining > 0) chunks.push(data.subarray(0, remaining)); length += data.length;
          if (length > this.definition.max_bytes) { finish(false); res.destroy(); req.destroy(); }
        });
        res.on('error', () => finish(false)); res.on('aborted', () => finish(false)); res.on('end', () => finish(true));
      });
      timer = setTimeout(() => { finish(false); req.destroy(); }, timeout);
      req.on('error', () => finish(false));
      req.end(body);
    });
    const bytes = new TextEncoder().encode(this.redact(received.bytes.toString('utf8')));
    const source = await this.#save(bytes, received.status, operation, received.complete);
    const received_at = new Date().toISOString();
    if (!received.complete) throw new Error('目标回答不完整、超时或超限；已有字节先保存，不重试');
    if (received.status < 200 || received.status >= 300) throw new Error('目标 HTTP 回答不成功；原文已保存，不跟随重定向');
    if (received.session) { if (/[\r\n]/.test(received.session) || received.session.length > 512) throw new Error('目标会话标识无效'); this.#session = received.session; }
    if (notification) return { value: {}, source, received_at };
    const text = new TextDecoder().decode(bytes);
    let value: unknown;
    try { value = JSON.parse(text); } catch {
      // An SSE response may contain notifications before the one JSON-RPC reply.
      const frames = text.split(/\r?\n\r?\n/).map(frame => frame.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n'));
      for (const frame of frames) try { const candidate: unknown = JSON.parse(frame); if (object(candidate) && candidate.id === id) { value = candidate; break; } } catch { /* Ignore non-response SSE frames. */ }
    }
    if (!object(value) || value.jsonrpc !== '2.0' || value.id !== id || value.error !== undefined || !object(value.result)) throw new Error('目标 JSON-RPC 回答无效；原文已保存');
    return { value: value.result, source, received_at };
  }
}
