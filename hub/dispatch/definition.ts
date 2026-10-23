// executor@1 is local until the shared contracts owner adopts the shape.
import { z } from 'zod';
import { isIP } from 'node:net';
import { X509Certificate } from 'node:crypto';
import { ActionResultSchema, AcceptanceSchema, EffectOutcomeSchema, DynamicTerminalSchema } from '../../contracts/generated/vocabulary.ts';
const valueRef = z.strictObject({ $value: z.string().min(1).max(100) });
const pointer = z.string().max(500).refine(p => p === '' || /^\/(?:[^~]|~[01])*$/.test(p));
const call = z.strictObject({ tool: z.string().min(1).max(128), arguments: z.record(z.string(), z.unknown()), timeout_ms: z.number().int().min(1).max(600000).default(30000) });
const acceptance = z.record(z.string(), AcceptanceSchema);
const state = z.strictObject({ action_result: ActionResultSchema.optional(), acceptance: AcceptanceSchema.optional(), effect_outcome: EffectOutcomeSchema.optional(), dynamic_terminal: DynamicTerminalSchema.optional() }).refine(s => Object.keys(s).length > 0);
const conditions = z.array(z.strictObject({ pointer, equals: z.unknown().optional(), at_least: z.union([z.number(), valueRef]).optional(), sha256: z.union([z.string().regex(/^[a-f0-9]{64}$/), valueRef]).optional() }).refine(c => Number(Object.hasOwn(c, 'equals')) + Number(c.at_least !== undefined) + Number(c.sha256 !== undefined) === 1)).max(100).default([]);
export const ExecutorDefinition = z.strictObject({
  schema: z.literal('executor@1'), id: z.string().regex(/^exe_[0-9a-hjkmnp-tv-z]{26}$/).optional(), enabled: z.boolean().default(true),
  target: z.string().min(1).max(200), manifest_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null), endpoint: z.string().url().max(2048), ca: z.string().max(65536),
  limitations: z.array(z.string().min(1).max(1000)).max(50).default([]),
  precheck_context: z.record(z.string(), z.unknown()).default({}),
  resources: z.array(z.string().regex(/^[a-z0-9][a-z0-9:._/-]{0,199}$/)).max(100).default([]),
  max_run_ms: z.number().int().min(1).max(86400000), max_bytes: z.number().int().min(256).max(8388608).default(4194304),
  poll_ms: z.number().int().min(1).max(60000).default(2000), submit_timeout_ms: z.number().int().min(1).max(600000).default(300000),
  allowed_tools: z.array(z.string().min(1).max(128)).min(1).max(100),
  payload_argument: pointer.refine(p => p !== ''),
  calls: z.strictObject({ acquire: call, heartbeat: call, release: call, precheck: call, submit: call, status: call, result: call }),
  lease: z.strictObject({ id: pointer, token: pointer, ttl_ms: pointer, ttl_scale_ms: z.number().positive().default(1), acceptance: pointer, map: acceptance }),
  receipt: z.strictObject({ acceptance: pointer, map: acceptance, id: pointer, sha256: pointer, items: pointer }),
  status: z.strictObject({ pointer, exit_code: pointer.optional(), map: z.record(z.string(), state) }),
  result: z.strictObject({ id: pointer, sha256: pointer, submitted_at: pointer, submitted_at_scale_ms: z.number().positive().optional(), items: pointer, item_id: pointer, item_outcome: pointer, complete: pointer, map: z.record(z.string(), DynamicTerminalSchema) }),
  conditions,
  capture_pointers: z.array(pointer).max(100).default([]),
  precheck_reads: z.array(call.extend({ conditions, capture_pointers: z.array(pointer).max(100).default([]) })).max(20).default([]),
  proof: z.strictObject({ package: z.string().regex(/^[a-z][a-z0-9-]{0,99}$/), manifest_sha256: pointer, requirement: z.string().min(1), warrant_id: z.string().min(1).max(300), slot: z.string().min(1).max(100), plan_run: pointer, sha256: pointer, items: pointer, target: pointer, build: pointer, generator: pointer }),
}).superRefine((d, ctx) => {
  const u = new URL(d.endpoint); const host = u.hostname.replace(/^\[|\]$/g, '');
  const loopback = host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));
  if (u.username || u.password || u.search || u.hash || (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback))) ctx.addIssue({ code: 'custom', message: '端点必须固定为 HTTPS，明文只允许回环，地址不带凭据、查询或片段' });
  if (u.protocol === 'https:') try { new X509Certificate(d.ca); } catch { ctx.addIssue({ code: 'custom', message: 'HTTPS 需要固定 CA 证书' }); }
  if (new Set(d.resources).size !== d.resources.length || new Set(d.allowed_tools).size !== d.allowed_tools.length) ctx.addIssue({ code: 'custom', message: '资源键和允许工具不得重复' });
  for (const c of [...Object.values(d.calls), ...d.precheck_reads]) if (!d.allowed_tools.includes(c.tool)) ctx.addIssue({ code: 'custom', message: '生命周期调用不在允许工具清单内' });
  const payload = at(d.calls.submit.arguments, d.payload_argument);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length !== 1 || (payload as Record<string, unknown>).$value !== 'payload_base64' || countPayloadBindings(d.calls.submit.arguments) !== 1) ctx.addIssue({ code: 'custom', message: '提交内容参数必须且只能绑定一次已核验字节' });
  for (const [role, c] of Object.entries(d.calls)) if (role !== 'submit' && countPayloadBindings(c.arguments)) ctx.addIssue({ code: 'custom', message: '非提交角色不能携带工作内容字节' });
  if (d.precheck_reads.some(c => countPayloadBindings(c.arguments))) ctx.addIssue({ code: 'custom', message: '只读核对不能携带工作内容字节' });
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
  if (!d.manifest_sha256) missing.push('manifest_sha256');
  if (!d.resources.length) missing.push('resources');
  if (!d.conditions.length) missing.push('conditions');
  for (const [index, step] of d.precheck_reads.entries()) if (!step.conditions.length) missing.push(`precheck_reads/${index}/conditions`);
  return missing;
}
