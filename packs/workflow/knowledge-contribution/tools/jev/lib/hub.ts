import { need, record, secureUrl, type LocalStore } from './local.ts';
export interface Piece { id: string; reference: string; kind: string; text: string; sha256: string; bytes: number }
export class Hub {
  url: URL; token: string; guard: (v: unknown) => void; id = 0; initialized = false;
  constructor(url: string, token: string, guard: (v: unknown) => void) { this.url = secureUrl(url); this.token = token; this.guard = guard; }
  async rpc(method: string, params: unknown): Promise<any> {
    const id = ++this.id; const response = await fetch(this.url, { method: 'POST', headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), redirect: 'manual', signal: AbortSignal.timeout(60_000) });
    need(response.status === 200 && response.headers.get('content-type')?.split(';')[0] === 'application/json', 'Hub 未返回 JSON 成功应答；核对 Hub 地址、令牌和权限后重跑');
    const raw = await response.text(); need(Buffer.byteLength(raw) <= 16 * 1024 * 1024, 'Hub 回答过大；缩小读取路径后重跑'); this.guard(raw); const reply = JSON.parse(raw); this.guard(reply);
    need(reply.id === id && reply.jsonrpc === '2.0' && record(reply.result) && !reply.error, 'Hub RPC 未成功；核对参数和权限后重跑'); return reply.result;
  }
  async call(name: string, args: unknown): Promise<any> {
    if (!this.initialized) { await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'jev-skill', version: '1.1.0' } }); this.initialized = true; }
    const result = await this.rpc('tools/call', { name, arguments: args }); const value = result.structuredContent;
    need(record(value), 'Hub 缺少结构化应答；更新客户端连接后重跑'); return value;
  }
  async nodes(root: string, paths: string[], depth = 1): Promise<any[]> {
    const all: any[] = []; let cursor: string | undefined; const seen = new Set<string>();
    do { const page = await this.call('get_nodes', { root, paths, depth, ...(cursor ? { cursor } : {}) }); need(page.call_result === 'ok' && Array.isArray(page.nodes) && page.root === root, '树节点读取不完整；核对根和路径后重新读取'); all.push(...page.nodes); cursor = page.next ?? undefined; if (cursor) { need(!seen.has(cursor), 'Hub 分页游标没有前进；重新读取完整节点'); seen.add(cursor); } } while (cursor);
    const nodes = new Map<string, any>(); for (const node of all) { const previous = nodes.get(node.path); if (previous) { previous.entries.push(...node.entries); previous.children.push(...node.children.filter((c: any) => !previous.children.some((p: any) => p.path === c.path))); } else nodes.set(node.path, structuredClone(node)); } return [...nodes.values()];
  }
}
