// executor@1 is local until the shared contracts owner adopts the shape.
import { z } from 'zod';
import { isIP } from 'node:net';
import { X509Certificate } from 'node:crypto';
import { ActionResultSchema, AcceptanceSchema, EffectOutcomeSchema, DynamicTerminalSchema } from '../../contracts/generated/vocabulary.ts';
const pointer = z.string().max(500).refine(p => p === '' || /^\/(?:[^~]|~[01])*$/.test(p));
const call = z.strictObject({ tool: z.string().min(1).max(128), arguments: z.record(z.string(), z.unknown()), timeout_ms: z.number().int().min(1).max(600000).default(30000) });
const acceptance = z.record(z.string(), AcceptanceSchema);
const state = z.strictObject({ action_result: ActionResultSchema.optional(), acceptance: AcceptanceSchema.optional(), effect_outcome: EffectOutcomeSchema.optional(), dynamic_terminal: DynamicTerminalSchema.optional() }).refine(s => Object.keys(s).length > 0);
export const ExecutorDefinition = z.strictObject({
  schema: z.literal('executor@1'), id: z.string().regex(/^exe_[0-9a-hjkmnp-tv-z]{26}$/).optional(), enabled: z.boolean().default(true),
  target: z.string().min(1).max(200), manifest_sha256: z.string().regex(/^[a-f0-9]{64}$/), endpoint: z.string().url().max(2048), ca: z.string().max(65536),
  precheck_context: z.record(z.string(), z.unknown()).default({}),
  resources: z.array(z.string().regex(/^[a-z0-9][a-z0-9:._/-]{0,199}$/)).min(1).max(100),
  max_run_ms: z.number().int().min(1).max(86400000), max_bytes: z.number().int().min(256).max(8388608).default(4194304),
  poll_ms: z.number().int().min(1).max(60000).default(2000), submit_timeout_ms: z.number().int().min(1).max(600000).default(300000),
  allowed_tools: z.array(z.string().min(1).max(128)).min(1).max(100),
  calls: z.strictObject({ acquire: call, heartbeat: call, release: call, precheck: call, submit: call, status: call, result: call }),
  lease: z.strictObject({ id: pointer, token: pointer, ttl_ms: pointer, ttl_scale_ms: z.number().positive().default(1), acceptance: pointer, map: acceptance }),
  receipt: z.strictObject({ acceptance: pointer, map: acceptance, id: pointer, sha256: pointer, items: pointer }),
  status: z.strictObject({ pointer, exit_code: pointer.optional(), map: z.record(z.string(), state) }),
  result: z.strictObject({ id: pointer, sha256: pointer, submitted_at: pointer, submitted_at_scale_ms: z.number().positive().optional(), items: pointer, item_id: pointer, item_outcome: pointer, complete: pointer, map: z.record(z.string(), DynamicTerminalSchema) }),
  conditions: z.array(z.strictObject({ pointer, equals: z.unknown().optional(), at_least: z.number().optional(), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).refine(c => Number(Object.hasOwn(c, 'equals')) + Number(c.at_least !== undefined) + Number(c.sha256 !== undefined) === 1)).min(1).max(100),
  proof: z.strictObject({ package: z.string().regex(/^[a-z][a-z0-9-]{0,99}$/), manifest_sha256: pointer, requirement: z.string().min(1), plan_run: pointer, sha256: pointer, items: pointer, target: pointer, build: pointer, generator: pointer }),
}).superRefine((d, ctx) => {
  const u = new URL(d.endpoint); const host = u.hostname.replace(/^\[|\]$/g, '');
  const loopback = host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));
  if (u.username || u.password || u.search || u.hash || (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback))) ctx.addIssue({ code: 'custom', message: '端点必须固定为 HTTPS，明文只允许回环，地址不带凭据、查询或片段' });
  if (u.protocol === 'https:') try { new X509Certificate(d.ca); } catch { ctx.addIssue({ code: 'custom', message: 'HTTPS 需要固定 CA 证书' }); }
  if (new Set(d.resources).size !== d.resources.length || new Set(d.allowed_tools).size !== d.allowed_tools.length) ctx.addIssue({ code: 'custom', message: '资源键和允许工具不得重复' });
  for (const c of Object.values(d.calls)) if (!d.allowed_tools.includes(c.tool)) ctx.addIssue({ code: 'custom', message: '生命周期调用不在允许工具清单内' });
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
      if (!Object.hasOwn(context, o.$value)) throw new Error('缺少调用参数的绑定事实');
      return context[o.$value];
    }
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, bind(v, context)]));
  }
  return value;
}
