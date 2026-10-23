// executor@1 is local until the shared contracts owner adopts the shape.
import { z } from 'zod';
import { isIP } from 'node:net';
import { X509Certificate } from 'node:crypto';
import { ActionResultSchema, AcceptanceSchema, EffectOutcomeSchema, DynamicTerminalSchema, RetrySafetySchema } from '../../contracts/generated/vocabulary.ts';
const valueRef = z.strictObject({ $value: z.string().min(1).max(100) });
const pointer = z.string().max(500).refine(p => p === '' || /^\/(?:[^~]|~[01])*$/.test(p));
const call = z.strictObject({ tool: z.string().min(1).max(128), arguments: z.record(z.string(), z.unknown()), timeout_ms: z.number().int().min(1).max(600000).default(30000) });
const certificate = z.strictObject({ version: z.string().min(1).max(200), evidence: z.array(z.string().regex(/^src:[a-f0-9]{64}$/)).min(1).max(20) });
const acceptance = z.record(z.string(), AcceptanceSchema);
const requestIdentity = z.strictObject({epoch:pointer,since:pointer,subject:pointer});
const state = z.strictObject({ action_result: ActionResultSchema.optional(), acceptance: AcceptanceSchema.optional(), effect_outcome: EffectOutcomeSchema.optional(), dynamic_terminal: DynamicTerminalSchema.optional() }).refine(s => Object.keys(s).length > 0);
const conditions = z.array(z.strictObject({ pointer, equals: z.unknown().optional(), at_least: z.union([z.number(), valueRef]).optional(), sha256: z.union([z.string().regex(/^[a-f0-9]{64}$/), valueRef]).optional() }).refine(c => Number(Object.hasOwn(c, 'equals')) + Number(c.at_least !== undefined) + Number(c.sha256 !== undefined) === 1)).max(100).default([]);
function compiled(pattern: string): boolean { try { new RegExp(pattern); return true; } catch { return false; } }
function oneNamedGroup(pattern: string): boolean {
  if (!compiled(pattern)) return false;
  let groups = 0, bracket = false;
  for (let i=0;i<pattern.length;i++) {
    if (pattern[i] === '\\') { i++; continue; }
    if (pattern[i] === '[') bracket=true; else if (pattern[i] === ']') bracket=false;
    if (!bracket && pattern.slice(i,i+3) === '(?<' && !['=','!'].includes(pattern[i+3])) groups++;
  }
  return groups === 1;
}
const extraction = z.strictObject({command:z.string().min(1).max(10000),pattern:z.string().min(1).max(2000).refine(oneNamedGroup)});
const probes = z.strictObject({devices:pointer.optional(),command_pattern:z.string().min(1).max(2000).refine(p=>p.startsWith('^') && p.endsWith('$') && compiled(p)),call,output:pointer,seats:z.array(z.strictObject({seat:z.string().min(1).max(200),index:z.number().int().min(0),manifest:z.strictObject({device:pointer,addresses:pointer,address:pointer}),version:extraction,interfaces:extraction})).min(1).max(100)}).superRefine((p,ctx)=>{
  const match = new RegExp(p.command_pattern);
  if (new Set(p.seats.map(s=>s.seat)).size !== p.seats.length || new Set(p.seats.map(s=>s.index)).size !== p.seats.length) ctx.addIssue({code:'custom',message:'探测座位名称和序号不得重复'});
  for (const seat of p.seats) for (const step of [seat.version,seat.interfaces]) if (!match.test(step.command)) ctx.addIssue({code:'custom',message:'探测命令不符合声明的命令形状'});
});
export const ExecutorDefinition = z.strictObject({
  schema: z.literal('executor@1'), id: z.string().regex(/^exe_[0-9a-hjkmnp-tv-z]{26}$/).optional(), enabled: z.boolean().default(true),
  retry_safety: RetrySafetySchema.refine(v=>v==='unsafe' || v==='dedup_window').default('unsafe'),
  target: z.string().min(1).max(200), manifest_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null), endpoint: z.string().url().max(2048), ca: z.string().max(65536),
  premises: z.strictObject({ request_journal: certificate.optional(), result_ownership: certificate.optional() }).default({}),
  actor: z.strictObject({ header: z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,127}$/).refine(h => !h.toLowerCase().startsWith('mcp-') && !['authorization', 'cookie', 'host', 'content-length', 'content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version'].includes(h.toLowerCase())), pattern: z.string().min(1).max(500).refine(p => { try { new RegExp(p); return p.startsWith('^') && p.endsWith('$'); } catch { return false; } }), max_length: z.number().int().min(1).max(512) }).optional(),
  limitations: z.array(z.string().min(1).max(1000)).max(50).default([]),
  precheck_context: z.record(z.string(), z.unknown()).default({}),
  resources: z.array(z.string().regex(/^[a-z0-9][a-z0-9:._/-]{0,199}$/)).max(100).default([]),
  max_run_ms: z.number().int().min(1).max(86400000), max_bytes: z.number().int().min(256).max(8388608).default(4194304),
  clock_skew_ms:z.number().int().min(0).max(600000).default(0),
  poll_ms: z.number().int().min(1).max(60000).default(2000), submit_timeout_ms: z.number().int().min(1).max(600000).default(300000),
  refused_tools: z.array(z.string().min(1).max(128)).max(100).default([]),
  allowed_tools: z.array(z.string().min(1).max(128)).min(1).max(100),
  payload_argument: pointer.refine(p => p !== ''),
  calls: z.strictObject({ acquire: call, heartbeat: call, release: call, precheck: call, submit: call, status: call, result: call, query: call.optional() }),
  lease: z.strictObject({ id: pointer, token: pointer, ttl_ms: pointer, ttl_scale_ms: z.number().positive().default(1), acceptance: pointer, map: acceptance }),
  receipt: z.strictObject({ identity:requestIdentity.optional(), stage: pointer.optional(), reached_device: pointer.optional(), stages: z.record(z.string(), EffectOutcomeSchema).default({}), request_id: pointer.optional(), acceptance: pointer, map: acceptance, id: pointer, sha256: pointer, items: pointer }),
  conformance: z.strictObject({ expiry_margin_ms:z.number().int().min(1).max(600000).default(5000), expected_stage:z.string().min(1).max(200), payloads: z.array(z.string().min(1).max(4096).regex(/^[A-Za-z0-9+/]*={0,2}$/)).length(2).refine(p => p[0] !== p[1] && p.every(s=>Buffer.from(s,'base64').length>0 && Buffer.from(s,'base64').toString('base64')===s)) }).optional(),
  reconciliation: z.strictObject({ identity:requestIdentity.optional(), protocol_versions:z.array(z.string().min(1).max(200)).max(100).default([]), pending_states:z.array(z.string().min(1).max(200)).max(100).default([]), found: pointer, state: pointer, request_id: pointer, sha256: pointer, id: pointer, stage: pointer, reached_device: pointer, gateway_time: pointer, gc_before: pointer, time_scale_ms: z.number().positive().optional(), map: z.record(z.string(),EffectOutcomeSchema) }).optional(),
  status: z.strictObject({ pointer, exit_code: pointer.optional(), map: z.record(z.string(), state) }),
  result: z.strictObject({ ownership:z.strictObject({pointer,value:z.string().min(1).max(200),reason:pointer}).optional(), request_id:pointer.optional(), log_stale:pointer.optional(), closing_marker:z.string().min(1).max(2000).optional(), log:pointer.optional(), sessions:pointer.optional(), id: pointer, sha256: pointer, submitted_at: pointer, submitted_at_scale_ms: z.number().positive().optional(), items: pointer, item_id: pointer, item_outcome: pointer, complete: pointer, map: z.record(z.string(), DynamicTerminalSchema) }),
  probes: probes.optional(),
  side_effects: z.array(z.strictObject({message:z.string().min(1).max(2000),marker:z.string().min(1).max(2000).optional()})).max(100).default([]),
  read_retry_when: conditions,
  conditions,
  capture_pointers: z.array(pointer).max(100).default([]),
  precheck_reads: z.array(call.extend({ conditions, capture_pointers: z.array(pointer).max(100).default([]) })).max(20).default([]),
  proof: z.strictObject({ package: z.string().regex(/^[a-z][a-z0-9-]{0,99}$/), manifest_sha256: pointer, requirement: z.string().min(1), warrant_id: z.string().min(1).max(300).nullable().default(null), slot: z.string().min(1).max(100), plan_run: pointer, sha256: pointer, items: pointer, target: pointer, build: pointer, generator: pointer }),
}).superRefine((d, ctx) => {
  const u = new URL(d.endpoint); const host = u.hostname.replace(/^\[|\]$/g, '');
  const loopback = host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));
  if (u.username || u.password || u.search || u.hash || (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback))) ctx.addIssue({ code: 'custom', message: '端点必须固定为 HTTPS，明文只允许回环，地址不带凭据、查询或片段' });
  if (u.protocol === 'https:') try { new X509Certificate(d.ca); } catch { ctx.addIssue({ code: 'custom', message: 'HTTPS 需要固定 CA 证书' }); }
  if (new Set(d.resources).size !== d.resources.length || new Set(d.allowed_tools).size !== d.allowed_tools.length) ctx.addIssue({ code: 'custom', message: '资源键和允许工具不得重复' });
  for (const c of [...Object.values(d.calls), ...d.precheck_reads, ...(d.probes ? [d.probes.call] : [])]) if (!d.allowed_tools.includes(c.tool)) ctx.addIssue({ code: 'custom', message: '生命周期调用不在允许工具清单内' });
  if (d.refused_tools.some(name=>d.allowed_tools.includes(name))) ctx.addIssue({code:'custom',message:'同一工具不能既被允许又被拒绝'});
  if (d.receipt.request_id || d.reconciliation) {
    if (countBindings(d.calls.submit.arguments,'request_id') !== 1 || countBindings(d.calls.submit.arguments,'not_after') !== 1) ctx.addIssue({code:'custom',message:'请求协议必须各绑定一次请求身份和截止时间'});
  }
  if (d.reconciliation && (!d.calls.query || !d.receipt.request_id || countBindings(d.calls.query.arguments,'request_id') !== 1)) ctx.addIssue({code:'custom',message:'查账必须绑定原请求身份并登记回执身份指针'});
  if (d.probes && ['command','seat_index','lease_id'].some(key=>countBindings(d.probes!.call.arguments,key)!==1))ctx.addIssue({code:'custom',message:'座位探测必须各绑定一次命令、座位序号和本次租约身份'});
  if(Object.entries(d.calls).some(([role,c])=>role!=='submit' && c?.tool===d.calls.submit.tool) || d.precheck_reads.some(c=>c.tool===d.calls.submit.tool) || d.probes?.call.tool===d.calls.submit.tool)ctx.addIssue({code:'custom',message:'提交工具不能同时作为租约、读取或探测工具'});
  const payload = at(d.calls.submit.arguments, d.payload_argument);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length !== 1 || (payload as Record<string, unknown>).$value !== 'payload_base64' || countPayloadBindings(d.calls.submit.arguments) !== 1) ctx.addIssue({ code: 'custom', message: '提交内容参数必须且只能绑定一次已核验字节' });
  for (const [role, c] of Object.entries(d.calls)) if (role !== 'submit' && countPayloadBindings(c.arguments)) ctx.addIssue({ code: 'custom', message: '非提交角色不能携带工作内容字节' });
  if ([...d.precheck_reads,...(d.probes ? [d.probes.call] : [])].some(c => countPayloadBindings(c.arguments))) ctx.addIssue({ code: 'custom', message: '只读核对不能携带工作内容字节' });
});
export type ExecutorDefinition = z.infer<typeof ExecutorDefinition>;
export type CallRole = keyof ExecutorDefinition['calls'];
export function at(value: unknown, pointer: string): unknown {
  if (pointer === '') return value;
  let current = value;
  for (const segment of pointer.slice(1).split('/').map(s => s.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
/** Interpret only the declared time representation; never guess a date from a numeric-looking string. */
export function readDeclaredTime(value:unknown,scale?:number):number {
  if(scale!==undefined) {
    const ms=typeof value==='number'?value*scale:NaN;
    return Number.isFinite(ms) && Number.isFinite(new Date(ms).getTime()) ? ms : NaN;
  }
  if(typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|\+00:00)$/.test(value))return NaN;
  const ms=Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0,19)===value.slice(0,19) ? ms : NaN;
}
export function bind(value: unknown, context: Readonly<Record<string, unknown>>): unknown {
  if (Array.isArray(value)) return value.map(v => bind(v, context));
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (Object.keys(o).length === 1 && typeof o.$value === 'string') {
      if (!Object.hasOwn(context, o.$value) || context[o.$value] === undefined) throw new Error('缺少调用参数的绑定事实');
      return context[o.$value];
    }
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, bind(v, context)]));
  }
  return value;
}

/** Only explicitly configured scalar words can map to Hub vocabulary; prototype properties are never words. */
export function mapped<T>(map: Readonly<Record<string, T>>, value: unknown): T | undefined {
  if (value === null || value === undefined || (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') || (typeof value === 'string' && !value.trim())) return undefined;
  const key = String(value); return Object.hasOwn(map, key) ? map[key] : undefined;
}

function countBindings(value:unknown,key:string):number {
  if(Array.isArray(value))return value.reduce((n,v)=>n+countBindings(v,key),0);
  if(value && typeof value==='object') {
    const o=value as Record<string,unknown>;
    if(Object.keys(o).length===1 && o.$value===key)return 1;
    return Object.values(o).reduce<number>((n,v)=>n+countBindings(v,key),0);
  }
  return 0;
}
function countPayloadBindings(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((n, v) => n + countPayloadBindings(v), 0);
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (Object.keys(o).length === 1 && o.$value === 'payload_base64') return 1;
    return Object.values(o).reduce<number>((n, v) => n + countPayloadBindings(v), 0);
  }
  return 0;
}

export function registrationMissing(d: ExecutorDefinition): string[] {
  const missing: string[] = [];
  if (!d.proof.warrant_id) missing.push('proof.warrant_id');
  if (!d.manifest_sha256) missing.push('manifest_sha256');
  if (!d.resources.length) missing.push('resources');
  if(d.resources.length && !d.probes)missing.push('probes');
  if(d.probes && d.probes.devices===undefined)missing.push('probes.devices');
  if(!d.refused_tools.length)missing.push('refused_tools');
  if (!d.conditions.length) missing.push('conditions');
  for (const [index, step] of d.precheck_reads.entries()) if (!step.conditions.length) missing.push(`precheck_reads/${index}/conditions`);
  return missing;
}
