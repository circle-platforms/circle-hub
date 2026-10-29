import { randomBytes } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { GENERATED, EGRESS } from './constants.ts';
import { isRecord, need, normalizeHubUrl, OperationError, sha256 } from './common.ts';

export async function validateTokenFile(path: string): Promise<string> {
  const stat = await lstat(path).catch(() => null);
  need(stat, 'invalid_token_file', '令牌文件不存在');
  need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, 'invalid_token_file', '令牌文件必须是普通单链接文件');
  need((stat.mode & 0o777) === 0o600, 'invalid_token_permissions', '令牌文件权限必须是 0600');
  need(stat.size > 0 && stat.size <= 4097, 'invalid_token_file', '令牌文件大小不符合约定');
  const raw = await readFile(path);
  const value = raw.toString('utf8').replace(/\r?\n$/, '');
  need(/^[A-Za-z0-9._~+/-]+=*$/.test(value) && value.length <= 4096, 'invalid_token_file', '令牌文件不是一行有效令牌');
  raw.fill(0);
  return value;
}

/** Whether text holds the token, or any 12-character run of it (a shorter token whole). */
export function holdsToken(value: string, token: string): boolean {
  const runs = token.length < 12 ? [token] : Array.from({ length: token.length - 11 }, (_, index) => token.slice(index, index + 12));
  return runs.some(run => value.includes(run));
}

export class HubClient {
  private url: URL;
  private tokenFile: string;
  private session: string;
  private initialized = false;
  private sequence = 0;
  lastText: string[] = [];

  constructor(url: string, tokenFile: string, session: string) {
    this.url = normalizeHubUrl(url);
    this.tokenFile = tokenFile;
    this.session = session;
  }

  private guard(value: string, token: string): void {
    need(!holdsToken(value, token), 'token_echo', 'Hub 应答含令牌形状，整份丢弃');
  }

  // A token a caller has checked is passed down to the request that carries it, never kept on the client: concurrent calls
  // on one client each send the token they checked (round-five review, item 4).
  private async rpc(method: string, params: unknown, checked?: string): Promise<Record<string, unknown>> {
    const token = checked ?? await validateTokenFile(this.tokenFile);
    const id = ++this.sequence;
    const mutation = method === 'tools/call' && ['upload_file', 'start_run', 'submit_result'].includes((params as { name?: string })?.name ?? '');
    let response: Response;
    try {
      response = await fetch(this.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'circle-session-id': this.session,
          traceparent: `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        redirect: 'manual',
        signal: AbortSignal.timeout(EGRESS.http_timeout_ms),
      });
    } catch {
      throw new OperationError(mutation ? 'upload_outcome_unknown' : 'hub_unavailable', mutation ? 'Hub 结果未知；重试以取回幂等结果' : '连不上 Hub；核对地址后重试');
    }
    need(response.status === 200, mutation ? 'upload_outcome_unknown' : 'hub_refused', `Hub 返回 HTTP ${response.status}`);
    need(response.headers.get('content-type')?.split(';')[0] === 'application/json', 'invalid_hub_response', 'Hub 应答不是 JSON');
    const raw = await response.text();
    need(Buffer.byteLength(raw) <= 16 * 1024 * 1024, 'invalid_hub_response', 'Hub 应答过大');
    this.guard(raw, token);
    let reply: unknown;
    try { reply = JSON.parse(raw); } catch { throw new OperationError('invalid_hub_response', 'Hub JSON 应答格式不对'); }
    need(isRecord(reply) && reply.jsonrpc === '2.0' && reply.id === id, 'invalid_hub_response', 'Hub RPC 应答身份不符');
    need(!reply.error, 'hub_refused', 'Hub RPC 拒绝请求');
    need(isRecord(reply.result), 'invalid_hub_response', 'Hub 缺少结构化结果');
    return reply.result;
  }

  private async initialize(checked?: string): Promise<void> {
    if (this.initialized) return;
    await this.rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'operation-capture', version: GENERATED.version },
    }, checked);
    this.initialized = true;
  }

  async call(name: string, args: unknown, checked?: string): Promise<Record<string, unknown>> {
    await this.initialize(checked);
    const result = await this.rpc('tools/call', { name, arguments: args }, checked);
    this.lastText = Array.isArray(result.content) ? result.content.flatMap(block => isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []) : [];
    const value = result.structuredContent;
    need(isRecord(value), 'invalid_hub_response', 'Hub 工具缺少结构化应答');
    if (value.call_result === 'error' && name !== 'submit_result') throw new OperationError('hub_tool_refused', `${name} 未被 Hub 受理`);
    return value;
  }

  /**
   * One read of the token for both the check and the request: `check` sees exactly the token the request will carry, so a
   * rotation between the two cannot send a field that holds the token it authenticates with (round-four review, item 4).
   */
  async callChecked(name: string, args: unknown, check: (token: string) => void): Promise<Record<string, unknown>> {
    const token = await validateTokenFile(this.tokenFile);
    check(token);
    // Nothing a checked call sends may hold the token it authenticates with, in any field: model-written statements and
    // quotes included, not only the target names `check` looks at (round-six review).
    need(!holdsToken(JSON.stringify(args), token), 'credential_in_request', '请求含当前 Hub 令牌；清理提案里含令牌的文字后重交');
    return this.call(name, args, token);
  }

  async upload(bytes: Uint8Array, sequence: number, capturedAt?: string): Promise<{reference:string;artifact:string}> {
    if (capturedAt !== undefined) need(new Date(capturedAt).toISOString() === capturedAt, 'invalid_capture_time', '采集时刻格式不对');
    const args = {
      file_path: Buffer.from(bytes).toString('base64'),
      media_type: 'text/plain',
      name: `circle-operation-${sequence}.txt`,
      provenance_type: GENERATED.provenance_type,
      ...(capturedAt ? { captured_at: capturedAt } : {}),
    };
    const check = (token: string) => need(!Buffer.from(bytes).toString('utf8').includes(token), 'credential_redaction_failed', '原件含当前 Hub 令牌，停止上传');
    const initial = await validateTokenFile(this.tokenFile);
    check(initial);
    await this.initialize(initial);
    const current = await validateTokenFile(this.tokenFile);
    check(current);
    const value = await this.call('upload_file', args, current);
    const digest = sha256(bytes);
    need(value.call_result === 'ok' && value.acceptance === 'accepted' && value.reference === `src:${digest}` && value.sha256 === digest && value.size === bytes.byteLength, 'invalid_upload_receipt', 'Hub 上传回执与原件不符');
    need(typeof value.artifact === 'string' && /^[0-9a-f]{64}$/.test(value.artifact), 'invalid_upload_receipt', 'Hub 上传回执缺具体原件记录；使用支持 artifact 的 Hub，不按字节猜采集身份');
    return { reference: value.reference as string, artifact: value.artifact };
  }

  async uploadDocument(value: unknown, name: string): Promise<string> {
    const bytes = Buffer.from(JSON.stringify(value), 'utf8');
    const digest = sha256(bytes);
    const answer = await this.call('upload_file', { file_path: bytes.toString('base64'), media_type: 'application/json', name });
    need(answer.call_result === 'ok' && answer.acceptance === 'accepted' && answer.reference === `src:${digest}`, 'invalid_upload_receipt', '工作清单上传回执不符');
    return answer.reference as string;
  }
}
