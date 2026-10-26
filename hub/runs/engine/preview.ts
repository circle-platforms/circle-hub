// resolve_reference (T04, D06): a preview of how an exact value resolves against what is bound to a run: a reference given
// as text, a command through the locked catalogs, a quotation verbatim in the bound sources the reader may read. It returns
// the resolution state, the candidates citable as grounds with their text and the diagnostics; it is never evidence and
// writes nothing. Absent and forbidden runs give the same SOURCE_UNAVAILABLE and the same empty shape.
import type { z } from 'zod';
import type { Resolution, SourceRole } from '../../../contracts/generated/vocabulary.ts';
import { Ground } from '../../../contracts/src/reference.ts';
import { ResolveReferenceInput, type ResolveReferenceOutput } from '../../../contracts/src/tools.ts';
import type { Principal } from '../../records/api.ts';
import type { CallContext, Untraced } from '../../ports.ts';
import { findQuote, normalizeReference } from '../../refs/api.ts';
import type { EngineContext } from './deps.ts';
import { unavailableError } from './errors.ts';
import { buildScope, createResolver, resolveCommand } from './exact.ts';
import { canViewRun } from './readers.ts';
import { issuesOf } from './slots.ts';
import { runById } from './store.ts';

export type ResolveAnswer = Untraced<z.infer<typeof ResolveReferenceOutput>>;

const PREVIEW = '这是预览，不是证据：提交时 Hub 会在边界上重新解析';
const EXCERPT = 400;

const excerpt = (text: string | null): string => (text === null ? '' : [...text].length > EXCERPT ? `${[...text].slice(0, EXCERPT).join('')}…` : text);

type Expect = 'reference' | 'command' | 'quotation' | null;

function expectOf(value: string | undefined): Expect {
  if (value === undefined) return null;
  const v = value.trim().toLowerCase();
  if (v === 'command' || v === '命令') return 'command';
  if (v === 'quotation' || v === 'quote' || v === '引文' || v === '原文') return 'quotation';
  if (v === 'reference' || v === '引用') return 'reference';
  return null;
}

export async function previewReference(ctx: EngineContext, user: Principal, raw: unknown, call: CallContext): Promise<ResolveAnswer> {
  const parsed = ResolveReferenceInput.safeParse(raw);
  if (!parsed.success) return { call_result: 'error', errors: issuesOf(parsed.error, ''), references: [], diagnostics: [] };
  const input = parsed.data;
  const stored = await runById(ctx.deps.records.store, input.run);
  if (stored === null || !await canViewRun(user, stored.body, ctx.deps.records.store)) {
    ctx.log({ traceId: call.traceId, run: input.run, what: 'resolve_reference', detail: `run ${input.run} is unknown or not visible to ${user.id}` });
    return { call_result: 'error', errors: [unavailableError('/run')], references: [], diagnostics: [] };
  }
  const workflow = await ctx.deps.workflows.byDigest(stored.body.pack_digest);
  if (workflow === null) {
    ctx.log({ traceId: call.traceId, run: input.run, what: 'resolve_reference', detail: `pack version ${stored.body.pack} is no longer loadable` });
    return { call_result: 'error', errors: [unavailableError('/run')], references: [], diagnostics: [] };
  }
  // What the model will be shown: text the model may read (consumer model).
  const artifacts = ctx.deps.records.artifacts;
  const scopedArtifacts = new Proxy(artifacts, { get(target, property) {
    if (property === 'source') return async (principal: Principal, sha: string, options: Parameters<typeof artifacts.source>[2]) =>
      await artifacts.source(principal,sha,options) ?? await artifacts.sourceForRun(principal,sha,stored.body.run,options);
    const value = Reflect.get(target,property,target);
    return typeof value === 'function' ? value.bind(target) : value;
  }});
  const readContext = {...ctx,deps:{...ctx.deps,records:{...ctx.deps.records,artifacts:scopedArtifacts}}};
  let scope = await buildScope(readContext, stored.body, workflow, user, 'model');
  if (stored.body.product !== undefined && !(await ctx.deps.packs.readableProducts(user)).has(stored.body.product)) scope = {...scope,catalogs:[]};
  const resolver = createResolver(readContext, scope, 'model');
  const expect = expectOf(input.expect);
  const diagnostics: string[] = [PREVIEW];
  const references: { reference: string; text: string; role?: SourceRole }[] = [];
  const answer = (resolution: Resolution): ResolveAnswer => ({ call_result: 'ok', errors: [], resolution, references, diagnostics });

  let asReference: string | null = null;
  if (expect === 'reference' || expect === null) {
    try {
      asReference = normalizeReference(input.text);
    } catch {
      asReference = null;
    }
  }
  if (asReference !== null) {
    const r = await resolver.resolve(asReference);
    if (!r.ok) {
      diagnostics.push(r.message);
      return answer('unresolved');
    }
    if (Ground.safeParse(r.value.reference).success) references.push({ reference: r.value.reference, text: excerpt(r.value.text), ...(r.value.role !== null ? { role: r.value.role } : {}) });
    else diagnostics.push('这个引用解析得出，但不能单独作根据（知识条目请按知识树地址引用）');
    if (r.value.text === null) diagnostics.push('原文对你不可读（只许函数读取或含凭据）');
    return answer('resolved');
  }

  if (expect === 'command' || expect === null) {
    // Without an expectation only the catalog is asked here; a verbatim occurrence is found by the quotation search below.
    const found = await resolveCommand(scope, input.text, [], { search: expect === 'command' });
    if (found.resolution !== 'unresolved' || expect === 'command') {
      for (const reference of found.references) {
        if (!Ground.safeParse(reference).success) continue;
        const read = await resolver.resolve(reference);
        references.push({ reference, text: read.ok ? excerpt(read.value.text) : '', role: read.ok && read.value.role !== null ? read.value.role : 'expected' });
      }
      if (found.resolution === 'ambiguous') diagnostics.push(`可能指 ${found.options.length} 个命令：${found.options.slice(0, 10).join('；')}`);
      if (found.resolution === 'unresolved') diagnostics.push('锁定的目录里没有这个命令，已绑定的原文里也找不到');
      if (found.resolution !== 'unresolved' && expect === null) diagnostics.push('按命令解析');
      return answer(found.resolution);
    }
  }

  const search = findQuote(await scope.candidates(), input.text, { limit: 10 });
  for (const m of search.matches) references.push({ reference: m.ranged, text: excerpt(m.text), ...(m.role !== null ? { role: m.role } : {}) });
  diagnostics.push(...search.diagnostics);
  if (search.total > search.matches.length) diagnostics.push(`共 ${search.total} 处，只列出前 ${search.matches.length} 处`);
  return answer(search.resolution);
}
