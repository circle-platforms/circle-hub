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
import { buildRootScope, buildScope, createResolver, resolveCommand, type RunScope } from './exact.ts';
import { canViewRun } from './readers.ts';
import { issuesOf } from './slots.ts';
import { runById } from './store.ts';
import { HubReadFailure } from './retry-read.ts';

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

  if (input.run !== undefined) {
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
    if (ctx.parsers.forRun) {
      try { ctx = { ...ctx, parsers: await ctx.parsers.forRun(stored.body.run) }; }
      catch { return { call_result: 'error', errors: [{ code: 'SOURCE_UNAVAILABLE', message: '缺少本运行锁定的解析技能包摘要', fix: '管理员恢复原技能包；历史运行缺锁时用 circle-hub skill bind-legacy <解析器 id@版本> <技能包 id@版本> 追加迁移声明后重读' }], references: [], diagnostics: [] }; }
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
    return resolveAgainstScope(readContext, scope, input, user, false);
  }

  // ---------------------------------------------------- root mode
  if (input.root === undefined) {
    return { call_result: 'error', errors: [{ code: 'SUBMISSION_SCHEMA_VIOLATION', message: 'provide exactly one of run or root', fix: '给出 run 或 root 参数之一', path: '/root' }], references: [], diagnostics: [] };
  }

  const treeReader = ctx.deps.knowledge.treeReader();
  const hasRoot = treeReader.hasRoot !== undefined
    ? await treeReader.hasRoot(input.root, { user: user.id, role: user.role })
    : (await ctx.deps.knowledge.rootInfo(input.root)).length > 0;
  if (!hasRoot) {
    ctx.log({ traceId: call.traceId, run: null, what: 'resolve_reference', detail: `root ${input.root} is absent or not readable by ${user.id}` });
    return { call_result: 'error', errors: [unavailableError()], references: [], diagnostics: [] };
  }

  if (input.text.trim().startsWith('rec:')) {
    return {
      call_result: 'error',
      errors: [{
        code: 'REFERENCE_UNRESOLVED',
        message: 'rec: 引用和回注层条目需要运行锁定的喂入层序列',
        fix: '改用 start_run 启动运行（如 start_run { pack: "<任务包名>" }）并在 resolve_reference 中传入 run 参数',
        path: '/text',
      }],
      references: [],
      diagnostics: [],
    };
  }

  const scope = await buildRootScope(ctx, input.root, user, 'model');
  return resolveAgainstScope(ctx, scope, input, user, true);
}

async function resolveAgainstScope(
  ctx: EngineContext,
  scope: RunScope,
  input: { text: string; expect?: string },
  user: Principal,
  isRootMode: boolean,
): Promise<ResolveAnswer> {
  const resolver = createResolver(ctx, scope, 'model');
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
    if (isRootMode && asReference.startsWith('rec:')) {
      return {
        call_result: 'error',
        errors: [{
          code: 'REFERENCE_UNRESOLVED',
          message: 'rec: 引用和回注层条目需要运行锁定的喂入层序列',
          fix: '改用 start_run 启动运行（如 start_run { pack: "<任务包名>" }）并在 resolve_reference 中传入 run 参数',
          path: '/text',
        }],
        references: [],
        diagnostics: [],
      };
    }

    const r = await resolver.resolve(asReference);
    if (!r.ok) {
      if (r.retryable) {
        return { call_result: 'error', errors: [{ code: r.code ?? 'SOURCE_UNAVAILABLE', message: r.message, fix: r.fix ?? '管理员恢复来源核对能力后重新解析', path: '/text' }], references: [], diagnostics: [] };
      }
      if (isRootMode && r.code === 'SOURCE_UNAVAILABLE') {
        return { call_result: 'error', errors: [unavailableError()], references: [], diagnostics: [] };
      }
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
      try { await resolver.prefetch(found.references); }
      catch (error) {
        if (!(error instanceof HubReadFailure)) throw error;
        return {call_result:'error',errors:[{code:'SOURCE_RETRYABLE',message:error.message,fix:error.fix,path:'/text'}],references:[],diagnostics:[]};
      }
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
