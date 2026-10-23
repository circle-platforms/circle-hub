import { GENERATED } from './pieces.ts';
import { Refusal, need, record, secureUrl, type LocalStore } from './local.ts';
export interface Piece { id: string; reference: string; kind: string; text: string; sha256: string; bytes: number }
export class Hub {
  url: URL; token: string; guard: (v: unknown) => void; id = 0; initialized = false; lastText: string[] = [];
  constructor(url: string, token: string, guard: (v: unknown) => void) { this.url = secureUrl(url); this.token = token; this.guard = guard; }
  async rpc(method: string, params: unknown): Promise<any> {
    const id = ++this.id; const mutation=method==='tools/call'&&['upload_file','start_run','submit_result'].includes((params as any)?.name);let response:Response;try{response = await fetch(this.url, { method: 'POST', headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), redirect: 'manual', signal: AbortSignal.timeout(60_000) });}catch(error){const timeout=error instanceof Error&&(error.name==='TimeoutError'||error.name==='AbortError');const tag=(error as any)?.cause?.code??(error as any)?.code??(error instanceof Error?error.name:'Unknown');throw new Refusal(timeout?'Hub 60 秒内没有回答；本地超时不证明 Hub 没受理，用同一命令重跑取回原回执':`连不上 Hub（${tag}）；核对连接，用同一命令重跑取回原回执`,mutation?3:1);}
    if(response.status!==200){if(mutation&&response.status>=500)throw new Refusal(`Hub 返回 HTTP ${response.status}；本地看不到 Hub 是否已受理，用同一命令重跑取回原回执`,3);throw new Refusal(`Hub HTTP ${response.status}；${response.status===401||response.status===403?'Hub 令牌被拒；所有者用 /secrets HUB_TOKEN 更新':'核对 Hub 端点和服务状态后重跑'}`);}
    need(response.headers.get('content-type')?.split(';')[0] === 'application/json','Hub 应答不是 JSON；核对 Hub 端点后重跑');
    let raw:string;try{raw=await response.text();}catch{throw new Refusal('Hub 应答中断；本地中断不证明 Hub 没受理，用同一命令重跑取回原回执',mutation?3:1);} need(Buffer.byteLength(raw) <= 16 * 1024 * 1024, 'Hub 回答过大；缩小读取路径后重跑'); this.guard(raw); let reply:any;try{reply=JSON.parse(raw);}catch{throw new Refusal('Hub JSON 应答格式不对；核对服务，用同一命令重跑取回原回执',mutation?3:1);}this.guard(reply);
    if(record(reply.error))throw new Refusal(`Hub JSON-RPC ${reply.error.code}：${reply.error.message}；修正 RPC 参数后重跑`);
    need(reply.id === id && reply.jsonrpc === '2.0' && record(reply.result), 'Hub RPC 未成功；核对参数和权限后重跑'); return reply.result;
  }
  async call(name: string, args: unknown): Promise<any> {
    if (!this.initialized) { await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'jev-skill', version: GENERATED.version } }); this.initialized = true; }
    const result = await this.rpc('tools/call', { name, arguments: args }); this.lastText=(result.content??[]).filter((v:any)=>v.type==='text'&&typeof v.text==='string').map((v:any)=>v.text); const value = result.structuredContent;
    need(record(value), 'Hub 缺少结构化应答；更新客户端连接后重跑'); if(value.call_result==='error'&&name!=='submit_result')throw new Refusal(`${name}：${JSON.stringify(value.errors)}`); return value;
  }
  async nodes(root: string, paths: string[], depth = 1): Promise<any[]> {
    const all: any[] = []; let cursor: string | undefined; const seen = new Set<string>();
    do { const page = await this.call('get_nodes', { root, paths, depth, ...(cursor ? { cursor } : {}) }); need(page.call_result === 'ok' && Array.isArray(page.nodes) && page.root === root, '树节点读取不完整；核对根和路径后重新读取'); all.push(...page.nodes); cursor = page.next ?? undefined; if (cursor) { need(!seen.has(cursor), 'Hub 分页游标没有前进；重新读取完整节点'); seen.add(cursor); } } while (cursor);
    const nodes = new Map<string, any>(); for (const node of all) { const previous = nodes.get(node.path); if (previous) { previous.entries.push(...node.entries); previous.children.push(...node.children.filter((c: any) => !previous.children.some((p: any) => p.path === c.path))); } else nodes.set(node.path, structuredClone(node)); } return [...nodes.values()];
  }
}
