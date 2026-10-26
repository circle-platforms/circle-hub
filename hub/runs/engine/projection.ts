import type { LeaseRequest } from './start.ts';
// Items (W01) and expected sources. The workflow's projection function runs in the sandbox over the parsed inputs; its
// output is validated; a refusal refuses the whole start_run with the pack's fix (W01 R[3]: only a source whose own
// structure yields no items, or ambiguous production input ids, is refused wholesale — a projection that succeeds with an
// empty item set is a legal answer and the run starts with zero items). The Hub forms each item's location reference from
// its fragment and the bound source, verifies that it resolves and fingerprints the item.
// The expected_sources function names external objects to bind; each is read best effort as the caller: a failed read is
// recorded as unavailable and never fails the run.
import {Sha256} from '../../../contracts/src/common.ts';
import type { SourceRole } from '../../../contracts/generated/vocabulary.ts';
import {
  ExpectedSourcesInput,
  ExpectedSourcesOutput,
  ProjectionInput,
  ProjectionOutput,
  type PackWarning,
  type ProjectedItem,
  type RunContext,
} from '../../../contracts/src/pack.ts';
import type { ItemProjection, SourceBinding } from '../../../contracts/src/run.ts';
import { digestOf, type Principal, type VariableSnapshot } from '../../records/api.ts';
import { EXTERNAL_ARTIFACT, type LoadedWorkflow, type ExternalReadContext } from '../../ports.ts';
import { ReferenceSyntaxError, resolveReference, srcFragment } from '../../refs/api.ts';
import { callPackFunction } from '../../rules/api.ts';
import type { EngineContext } from './deps.ts';
import { Refusal, describe, protocolError } from './errors.ts';
import { withRevision, type BoundSource } from './inputs.ts';
import { identityOf, sourceReader } from './readers.ts';
import { isObject } from './util.ts';

export interface Projection {
  items: ItemProjection[];
  /** The items as the function returned them, for the expected-sources function. */
  projected: ProjectedItem[];
  /** Structure of the judged source that is not an item, frozen with the run (RunRecord.groups, RunContext.groups). */
  groups: Record<string, unknown>[];
  warnings: PackWarning[];
  /** The lease operations the run asks the Hub to perform before it is stored (absent when the function asked for none). */
  leaseRequests: LeaseRequest[];
}

function refusal(path: string, message: string, fix: string, note: string | null = null): Refusal {
  return new Refusal([protocolError('SUBMISSION_SCHEMA_VIOLATION', message, { path, fix })], note);
}

export async function projectItems(
  ctx: EngineContext,
  user: Principal,
  workflow: LoadedWorkflow,
  bound: readonly BoundSource[],
  parameters: Record<string, unknown>,
  context: RunContext,
  traceId: string,
): Promise<Projection> {
  const subject = workflow.workflow.subject;
  const path = `/inputs/${subject}`;
  const fn = workflow.workflow.projection;
  const input = ProjectionInput.parse({ inputs: bound.map((b) => b.input), parameters, context });
  let output: unknown;
  try {
    output = (await callPackFunction({ packDir: workflow.pack.directory, module: fn.module, export: fn.export }, input, ctx.deps.sandboxLimits, ctx.deps.sandbox)).output;
  } catch (error) {
    throw refusal(path, '任务包的投影函数没有给出条目（函数出错，详情在管理员日志里）', '请联系任务包作者', `projection ${fn.module}: ${describe(error)}`);
  }
  const parsed = ProjectionOutput.safeParse(output);
  if (!parsed.success) {
    throw refusal(path, '任务包的投影函数给出的结果不符合 projection-output@1', '请联系任务包作者', `projection output: ${parsed.error.message.slice(0, 1000)}`);
  }
  if ('error' in parsed.data) {
    const e = parsed.data.error;
    const namespaced = e.code.startsWith(`${workflow.pack.id}.`) && e.code.length > workflow.pack.id.length + 1;
    const documents = e.documents && e.documents.length > 0 ? `（${e.documents.join('、')}）` : '';
    throw new Refusal([
      namespaced
        ? { code: e.code, message: `${e.message}${documents}`, fix: e.fix, path }
        : protocolError('SUBMISSION_SCHEMA_VIOLATION', `${e.code}：${e.message}${documents}`, { path, fix: e.fix }),
    ]);
  }
  const { items: projected, warnings } = parsed.data;
  const leaseRequests = parsed.data.lease_requests ?? [];
  const groups = parsed.data.groups ?? [];
  const seen = new Set<string>();
  for (const item of projected) {
    if (seen.has(item.id)) throw refusal(path, `投影给出的条目编号 ${item.id} 重复`, '请联系任务包作者：条目编号在一次运行里要唯一', `duplicate item id ${item.id}`);
    seen.add(item.id);
  }
  const resolveCtx = {
    reader: identityOf(user),
    parsers: ctx.parsers,
    sources: sourceReader(ctx.deps.records.artifacts, 'function'),
    consumer: 'function' as const,
    documents: ctx.documents,
  };
  const items: ItemProjection[] = [];
  for (const item of projected) {
    const slot = item.location.slot ?? subject;
    const candidates = bound.filter((b) => b.slot === slot);
    if (candidates.length === 0) throw refusal(path, `条目 ${item.id} 的位置所在的输入槽 ${slot} 没有绑定源文件`, '请联系任务包作者');
    // A fragment that names its source (FragmentRef.source, the digest of the bound bytes) is resolved in that source only.
    let tried = candidates;
    if (item.location.source !== undefined) {
      tried = candidates.filter((b) => b.sha256 === item.location.source);
      if (tried.length === 0) throw refusal(path, `条目 ${item.id} 的位置指向的源没有绑定在输入槽 ${slot} 里（${item.location.source.slice(0, 16)}…）`, '请联系任务包作者');
    }
    const located: string[] = [];
    for (const candidate of tried) {
      let reference: string;
      try {
        reference = srcFragment(candidate.sha256, item.location.parser, item.location.selector, item.location.range);
      } catch (error) {
        if (!(error instanceof ReferenceSyntaxError)) throw error;
        throw refusal(path, `条目 ${item.id} 的片段定位写法不对：${error.message}`, '请联系任务包作者');
      }
      const resolved = await resolveReference(reference, resolveCtx);
      if (resolved.resolved) located.push(resolved.reference);
    }
    if (located.length !== 1) {
      throw refusal(
        path,
        located.length === 0 ? `条目 ${item.id} 的位置在绑定的源文件里找不到` : `条目 ${item.id} 的位置在输入槽 ${slot} 的 ${located.length} 份源文件里都能找到，无法确定是哪一份`,
        '请联系任务包作者',
      );
    }
    let digest: string;
    try {
      digest = digestOf({ id: item.id, label: item.label, fields: item.fields });
    } catch {
      throw refusal(path, `条目 ${item.id} 的字段不是规范 JSON，不能计算指纹`, '请联系任务包作者');
    }
    items.push({ id: item.id, label: item.label, ...(item.summary !== undefined ? { summary: item.summary } : {}), location: located[0], fields: item.fields, digest });
  }
  if (warnings.length > 0) ctx.log({ traceId, run: null, what: 'projection warnings', detail: JSON.stringify(warnings).slice(0, 2000) });
  return { items, projected, groups, warnings, leaseRequests };
}

/** An expected source that could not be bound; the real reason goes to the admin log only. */
export interface UnavailableSource {
  external: string;
  role: SourceRole;
  reason: string;
}

export interface ExpectedBinding {
  sources: SourceBinding[];
  unavailable: UnavailableSource[];
  warnings: PackWarning[];
}

export async function bindExpected(
  ctx: EngineContext,
  user: Principal,
  workflow: LoadedWorkflow,
  bound: readonly BoundSource[],
  projected: readonly ProjectedItem[],
  parameters: Record<string, unknown>,
  context: RunContext,
  runId: string,
  traceId: string,
  composition?: string | null,
  build?:string,
  variables?:VariableSnapshot,
  unversioned?: ExternalReadContext['unversioned'],
): Promise<ExpectedBinding> {
  const fn = workflow.workflow.expected_sources;
  const empty: ExpectedBinding = { sources: [], unavailable: [], warnings: [] };
  if (fn === undefined) return empty;
  let output: unknown;
  try {
    const input = ExpectedSourcesInput.parse({ inputs: bound.map((b) => b.input), parameters, context, items: projected });
    output = (await callPackFunction({ packDir: workflow.pack.directory, module: fn.module, export: fn.export }, input, ctx.deps.sandboxLimits, ctx.deps.sandbox)).output;
  } catch (error) {
    ctx.log({ traceId, run: runId, what: 'expected_sources', detail: describe(error) });
    return { ...empty, warnings: [{ code: 'runs.expected_sources_failed', message: '期望来源函数没有给出结果，本次运行没有绑定期望来源' }] };
  }
  const parsed = ExpectedSourcesOutput.safeParse(output);
  if (!parsed.success) {
    ctx.log({ traceId, run: runId, what: 'expected_sources', detail: `output is not expected-sources-output@1: ${parsed.error.message.slice(0, 1000)}` });
    return { ...empty, warnings: [{ code: 'runs.expected_sources_failed', message: '期望来源函数的结果不符合 expected-sources-output@1' }] };
  }
  if ('error' in parsed.data) {
    ctx.log({ traceId, run: runId, what: 'expected_sources', detail: `${parsed.data.error.code}: ${parsed.data.error.message}` });
    return { ...empty, warnings: [...parsed.data.warnings, { code: parsed.data.error.code, message: parsed.data.error.message }] };
  }
  const out: ExpectedBinding = { sources: [], unavailable: [], warnings: parsed.data.warnings };
  const seen = new Set<string>();
  for (const wanted of parsed.data.sources) {
    if (seen.has(wanted.external)) continue;
    seen.add(wanted.external);
    const miss = (reason: string, publicReason = '对你不可用'): void => {
      out.unavailable.push({ external: wanted.external, role: wanted.role, reason: publicReason });
      ctx.log({ traceId, run: runId, what: `expected source ${wanted.external}`, detail: reason });
    };
    try {
      if (!(await ctx.deps.external.accepts(wanted.external))) {
        miss('no enabled resource reads this external object type');
        continue;
      }
      const read = await ctx.deps.external.read(wanted.external, { principal: user, run: runId, variables, purpose: '期望来源',feeding_offset:context.feeding_offset,adminNote:detail=>ctx.log({traceId,run:runId,what:`expected source ${wanted.external}`,detail}), ...(composition !== undefined ? {composition} : {}),...(build!==undefined?{build}:{}),...(unversioned!==undefined?{unversioned}:{}) });
      if (!read.ok) {
        if(read.inputError?.code==='SOURCE_READ_FAILED'){out.warnings.push({code:'SOURCE_READ_FAILED',message:`${wanted.external}：${read.inputError.message}；${read.inputError.fix}`});miss(read.reason,read.inputError.message);continue;}
        if(read.inputError?.code==='SOURCE_READ_LIMIT'){out.warnings.push({code:'SOURCE_READ_LIMIT',message:`${wanted.external}：${read.inputError.message}；${read.inputError.fix}`});miss(read.reason,read.inputError.message);continue;}
        if(read.redirect && read.inputError) {out.warnings.push({code:'SOURCE_REDIRECT_REFUSED',message:`${wanted.external}：${read.inputError.message}；${read.inputError.fix}`});miss(read.reason,read.inputError.message);continue;}
        if(read.retry) {
          const message=`缺少期望来源 ${wanted.external} 的读取结果；下一次时间 ${read.retry.at}，按原对象重读后重新开始运行`;
          out.warnings.push({code:'SOURCE_RETRYABLE',message});
          miss(read.reason,message);
          continue;
        }
        miss(read.reason);
        continue;
      }
      const chosen = read.artifacts.find((a) => a.name === EXTERNAL_ARTIFACT.content) ?? read.artifacts.find((a) => a.name === EXTERNAL_ARTIFACT.original);
      if (chosen === undefined || (await ctx.deps.records.artifacts.readable(user, chosen.artifact.body.sha256)) === null) {
        miss('the read gave no artifact the caller may read');
        continue;
      }
      let title: string | null = null;
      const meta = read.artifacts.find((a) => a.name === EXTERNAL_ARTIFACT.meta);
      if (meta !== undefined) {
        const source = await ctx.deps.records.artifacts.source(user, meta.artifact.body.sha256, { consumer: 'function',record:meta.artifact.digest });
        try {
          const value: unknown = source?.bytes ? JSON.parse(new TextDecoder().decode(source.bytes)) : null;
          if (isObject(value) && typeof value.title === 'string' && value.title !== '') title = value.title;
        } catch {
          // A meta artifact that is not JSON gives no label.
        }
      }
      await ctx.deps.knowledge.feeding?.observeSourceBounded(user,chosen.artifact.body.sha256,{composition,product:context.product,root:context.root,run:runId,line:context.line,sourceRecord:chosen.artifact.digest,metaSource:meta?.artifact.body.sha256,metaRecord:meta?.artifact.digest,readManifest:read.manifest,requested:wanted.external});
      const reference = `src:${chosen.artifact.body.sha256}`;
      if (out.sources.some((s) => s.reference === reference&&s.artifact===chosen.artifact.digest)) continue;
      out.sources.push({ reference,artifact:chosen.artifact.digest,...(Sha256.safeParse(read.manifest).success?{read_manifest:read.manifest}:{}),...(meta?{meta_artifact:meta.artifact.digest}:{}),role: wanted.role, external: withRevision(read.id, read.revision), media_type: chosen.artifact.body.media_type,...(read.coverage?{coverage:read.coverage}:{}), label: read.absent ? `系统 ${read.absent.system} 里没有 ${read.absent.object}（读于 ${read.absent.observed_at}）` : title ?? wanted.reason });
    } catch (error) {
      miss(describe(error));
    }
  }
  return out;
}
