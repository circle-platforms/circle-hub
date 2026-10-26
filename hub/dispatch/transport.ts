// One HTTP POST per JSON-RPC call: no redirect, reconnect, cancellation notification or automatic retry.
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import { sha256Hex } from '../records/api.ts';
import type {Redactor} from '../connectors/api.ts';
import type { ExecutorDefinition, CallRole } from './definition.ts';
import { rpcResponse, toolContent, containsRpcReply } from './observations.ts';
import { bind } from './definition.ts';
export interface ResponseMetadata { received_sha256: string; redacted: boolean; started_at: string; ended_at: string; stream_cut_at_response?: boolean; request_bytes_written?: number; }
export type SaveResponse = (bytes: Uint8Array, status: number, operation: string, complete?: boolean, metadata?: ResponseMetadata) => Promise<string>;
export type Exchange<T = unknown> = { value: T; source: string; received_at: string; started_at: string; tool_error?: boolean };
export const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
export class SubmissionNotSentError extends Error {readonly source:string;constructor(source:string){super('提交连接未写出请求字节；原件与计数已保存');this.source=source;}}
export class InvocationDefinitionError extends Error {constructor(){super('调用参数名、必需字段或字节预算不符合目标公开声明；请修正执行器调用模板，尚未调用工具');}}
export class ToolReplyError extends Error {
  readonly value:unknown;readonly source:string;
  constructor(value:unknown,source:string){super('目标明确拒绝只读调用；原件已保存，先核对权限、凭据或参数');this.value=value;this.source=source;}
}
export class HttpReplyError extends Error {
  readonly status:number;
  constructor(status:number){super('目标 HTTP 回答不成功；原文已保存，不跟随重定向');this.status=status;}
}
export class ResponseStorageError extends Error {constructor(){super('目标原件未能保存；先修复本地存储后重读');}}
export class RpcReplyError extends Error {constructor(){super('目标的完整回答不符合 RPC 协议；修正接口后重读原作业');}}
export class CapabilityPolicyError extends Error { constructor(){super('密钥权限超出运行权限；换成仅运行权限的密钥后重跑，未调用任何工具');} }
export class RpcClient {
  readonly definition: ExecutorDefinition;
  readonly #redactor:Redactor|undefined;
  readonly #secret: string;
  readonly #job: string;
  readonly #save: SaveResponse;
  readonly #now: () => Date;
  serverVersion: string | null = null;
  #schemas = new Map<string,Record<string,unknown>>();
  #id = 0;
  #session: string | undefined;
  #protocol = LATEST_PROTOCOL_VERSION;
  constructor(definition: ExecutorDefinition, secret: string, job: string, save: SaveResponse, now: () => Date = () => new Date(),redactor?:Redactor) {
    this.#redactor=redactor;
    this.definition = definition; this.#secret = secret; this.#job = job; this.#save = save; this.#now = now;
    if (definition.actor && (job.length > definition.actor.max_length || /[\r\n]/.test(job) || !new RegExp(definition.actor.pattern).test(job))) throw new Error('代表身份不符合执行器声明；修正代表身份约束后再连接，尚未发请求');
    if (!secret || /[\r\n]/.test(secret)) throw new Error('执行器密钥缺失或无效');
  }
  redact(text: string): string {
    const spellings = [...new Set([this.#secret, JSON.stringify(this.#secret).slice(1, -1), encodeURIComponent(this.#secret)])];
    const direct = (value: string) => spellings.reduce((v, spelling) => v.split(spelling).join('[已隐藏]'), value);
    const scrub = (value: string, depth: number): string => {
      const first = direct(value);
      if (depth >= 8) return first;
      return first.replace(/"(?:[^"\\]|\\.)*"/g, token => {
        try {
          const decoded: unknown = JSON.parse(token);
          if (typeof decoded !== 'string') return token;
          const cleaned = scrub(decoded, depth + 1);
          return cleaned === decoded ? token : JSON.stringify(cleaned);
        } catch { return token; }
      });
    };
    const own=scrub(text,0);return this.#redactor?.maskText(own)??own;
  }
  async connect(): Promise<void> {
    const init = await this.rpc('initialize', { protocolVersion: this.#protocol, capabilities: {}, clientInfo: { name: 'circle-hub', version: '1.0.0' } });
    if (typeof init.value.protocolVersion !== 'string' || !SUPPORTED_PROTOCOL_VERSIONS.includes(init.value.protocolVersion)) throw new Error('目标协议版本不可用');
    this.serverVersion = object(init.value.serverInfo) && typeof init.value.serverInfo.version === 'string' ? init.value.serverInfo.version : null;
    this.#protocol = init.value.protocolVersion;
    await this.rpc('notifications/initialized', {}, true);
    const seen = new Set<string>(); let cursor: string | undefined;
    const visited = new Set<string>();
    do {
      const page = await this.rpc('tools/list', cursor ? { cursor } : {});
      if (!Array.isArray(page.value.tools)) throw new Error('目标工具清单无效');
      for (const tool of page.value.tools) if (object(tool) && typeof tool.name === 'string') {
        if (this.definition.refused_tools.includes(tool.name)) throw new CapabilityPolicyError();
        if(!object(tool.inputSchema))throw new Error('目标工具的参数声明无效；尚未调用工具');
        this.#schemas.set(tool.name,tool.inputSchema);
        seen.add(tool.name);
      }
      const next = page.value.nextCursor;
      if (next !== undefined && (typeof next !== 'string' || visited.has(next) || visited.size >= 100)) throw new Error('目标工具清单分页无效');
      cursor = typeof next === 'string' ? next : undefined; if (cursor) visited.add(cursor);
    } while (cursor);
    if (this.definition.allowed_tools.some(name => !seen.has(name))) throw new Error('目标缺少允许清单中的工具；未提交');
  }
  prepareSubmit(context:Readonly<Record<string,unknown>>):Record<string,unknown> {
    return this.argumentsFor(this.definition.calls.submit,context);
  }
  private argumentsFor(declaration:ExecutorDefinition['calls']['submit'],context:Readonly<Record<string,unknown>>):Record<string,unknown> {
    let args:unknown;
    try{args=bind(declaration.arguments,context);}catch{throw new InvocationDefinitionError();}
    if(!object(args))throw new InvocationDefinitionError();
    const schema=this.#schemas.get(declaration.tool);
    if(!schema)throw new InvocationDefinitionError();
    const props=object(schema.properties)?schema.properties:{};
    if(schema.required!==undefined && (!Array.isArray(schema.required) || schema.required.some(key=>typeof key!=='string' || !Object.hasOwn(args,key))))throw new InvocationDefinitionError();
    if(schema.additionalProperties===false) {
      const patterns=object(schema.patternProperties)?Object.keys(schema.patternProperties):[];
      try{if(Object.keys(args).some(key=>!Object.hasOwn(props,key) && !patterns.some(pattern=>new RegExp(pattern).test(key))))throw new InvocationDefinitionError();}
      catch{throw new InvocationDefinitionError();}
    }
    try{if(Buffer.byteLength(JSON.stringify({jsonrpc:'2.0',id:Number.MAX_SAFE_INTEGER,method:'tools/call',params:{name:declaration.tool,arguments:args}}))>this.definition.max_bytes*2)throw new InvocationDefinitionError();}
    catch{throw new InvocationDefinitionError();}
    return args;
  }
  async call(role: CallRole, context: Readonly<Record<string, unknown>>, timeoutMs?:number): Promise<Exchange> {
    const declaration = this.definition.calls[role];
    if (!declaration) throw new Error('该生命周期调用未登记；请补齐定义');
    return this.invoke(declaration, context, role, timeoutMs ?? (role === 'submit' ? this.definition.submit_timeout_ms : declaration.timeout_ms));
  }
  async precheckRead(index: number, context: Readonly<Record<string, unknown>>): Promise<Exchange> {
    const declaration = this.definition.precheck_reads[index];
    if (!declaration) throw new Error('只读核对没有登记');
    return this.invoke(declaration, context, `precheck.${index + 1}`, declaration.timeout_ms);
  }
  async declaredRead(declaration: NonNullable<ExecutorDefinition['probes']>['call'], context: Readonly<Record<string,unknown>>, operation: string): Promise<Exchange> {
    return this.invoke(declaration,context,operation,declaration.timeout_ms);
  }
  private async invoke(declaration: ExecutorDefinition['calls']['precheck'], context: Readonly<Record<string, unknown>>, operation: string, timeout: number): Promise<Exchange> {
    if (!this.definition.allowed_tools.includes(declaration.tool)) throw new Error('调用不在允许工具清单内');
    const response = await this.rpc('tools/call', { name: declaration.tool, arguments: this.argumentsFor(declaration,context) }, false, timeout, operation);
    if(response.value.isError===true && operation!=='submit') {
      let value:unknown;try{value=toolContent(response.value,true);}catch{}
      throw new ToolReplyError(value,response.source);
    }
    return { ...response,tool_error:response.value.isError===true, value: toolContent(response.value, operation === 'submit') };
  }
  private async rpc(method: string, params: unknown, notification = false, timeout = 30000, operation: string = method): Promise<Exchange<Record<string, unknown>>> {
    const id = ++this.#id;
    const started_at = this.#now().toISOString();
    const body = JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, params });
    if (Buffer.byteLength(body) > this.definition.max_bytes * 2) throw new Error('请求超过字节上限');
    const u = new URL(this.definition.endpoint);
    const received = await new Promise<{ bytes: Buffer; status: number; session?: string; complete: boolean; stream_cut_at_response: boolean; request_bytes_written:number }>(resolve => {
      const chunks: Buffer[] = []; let length = 0; let status = 0; let session: string | undefined; let finished = false; let streamCut = false;let socket:{bytesWritten:number}|undefined;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (complete: boolean) => {
        if (finished) return; finished = true; clearTimeout(timer);
        resolve({ bytes: Buffer.concat(chunks), status, session, complete, stream_cut_at_response: streamCut,request_bytes_written:socket?.bytesWritten ?? 0 });
      };
      const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(u, {
        method: 'POST', agent: false, ...(u.protocol === 'https:' ? { ca: this.definition.ca, rejectUnauthorized: true } : {}),
        headers: { authorization: `Bearer ${this.#secret}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(this.definition.actor ? { [this.definition.actor.header]: this.#job } : {}),
          'mcp-protocol-version': this.#protocol, ...(this.#session ? { 'mcp-session-id': this.#session } : {}) },
      }, res => {
        status = res.statusCode ?? 0;
        const eventStream = String(res.headers['content-type'] ?? '').toLowerCase().startsWith('text/event-stream');
        session = typeof res.headers['mcp-session-id'] === 'string' ? res.headers['mcp-session-id'] : undefined;
        res.on('data', (data: Buffer) => {
          const remaining = this.definition.max_bytes - length;
          if (remaining > 0) chunks.push(data.subarray(0, remaining)); length += data.length;
          if (length > this.definition.max_bytes) { finish(false); res.destroy(); req.destroy(); }
          else if (!notification && eventStream && containsRpcReply(Buffer.concat(chunks).toString('utf8'), id)) { streamCut = true; finish(true); res.destroy(); req.destroy(); }
        });
        res.on('error', () => finish(false)); res.on('aborted', () => finish(false)); res.on('end', () => finish(true));
      });
      timer = setTimeout(() => { finish(false); req.destroy(); }, timeout);
      req.on('socket',value=>{socket=value;});
      req.on('error', () => finish(false));
      req.end(body);
    });
    let textInput: string; let validEncoding = true;
    try { textInput = new TextDecoder('utf-8', { fatal: true }).decode(received.bytes); } catch { textInput = received.bytes.toString('utf8'); validEncoding = false; }
    const safe = this.redact(textInput);
    const bytes = new TextEncoder().encode(safe);
    const received_at = this.#now().toISOString();
    let source:string;
    try {source = await this.#save(bytes, received.status, operation, received.complete && validEncoding, { received_sha256: sha256Hex(received.bytes), redacted: safe !== received.bytes.toString('utf8'), started_at, ended_at: received_at, stream_cut_at_response: received.stream_cut_at_response,request_bytes_written:received.request_bytes_written });}
    catch {throw new ResponseStorageError();}
    if(operation==='submit' && !received.complete && received.status===0 && received.request_bytes_written===0)throw new SubmissionNotSentError(source);
    if (!received.complete || !validEncoding) throw new Error('目标回答不完整、超时或超限；已有字节先保存，不重试');
    if (received.status < 200 || received.status >= 300) throw new HttpReplyError(received.status);
    if (received.session) { if (/[\r\n]/.test(received.session) || received.session.length > 512) throw new Error('目标会话标识无效'); this.#session = received.session; }
    if (notification) return { value: {}, source, received_at, started_at };
    try{return { value: rpcResponse(new TextDecoder().decode(bytes), id), source, received_at, started_at };}
    catch{throw new RpcReplyError();}
  }
}
