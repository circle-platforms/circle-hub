import {completeKnowledgeView} from '../../knowledge/api.ts';
import {defectIndexKeys,mergeIndexBindings,narrowIndexId} from './index-default.ts';
// Binding the start_run inputs to the workflow's input slots (W02 F[8], P02, A03): a reference the caller may read (an
// upload_file result, or a Hub record reference, B03 R[4]) or an external object read through its system pack as the
// caller. Each source is parsed with the core parser for its media type; required slots must be given and the media type or
// external type must be one the slot accepts. A record bound as input is a source whose provenance is the record: its
// canonical JSON is stored as a generated artifact so that fragments of it can be cited.
import type { SourceRole } from '../../../contracts/generated/vocabulary.ts';
import {Sha256} from '../../../contracts/src/common.ts';
import type { ProtocolError } from '../../../contracts/src/common.ts';
import type { BoundInput, WorkflowInput } from '../../../contracts/src/pack.ts';
import { ExternalObjectId } from '../../../contracts/src/reference.ts';
import type { InputBinding, SourceBinding } from '../../../contracts/src/run.ts';
import type { Principal, VariableSnapshot } from '../../records/api.ts';
import { EXTERNAL_ARTIFACT, type LoadedWorkflow, type ExternalReadContext } from '../../ports.ts';
import { ReferenceSyntaxError, parseReference, parserKey, recognize, type Reference } from '../../refs/api.ts';
import type { EngineContext } from './deps.ts';
import { Refusal, protocolError, unavailableError } from './errors.ts';
import { recordBytes } from './exact.ts';
import { identityOf, recordReader, runOfRecord } from './readers.ts';
import { essence, isObject } from './util.ts';

export interface BoundSource {
  slot: string;
  role: SourceRole;
  binding: SourceBinding;
  input: BoundInput;
  sha256: string;
  /** The Hub record the source was bound by, and the run that record belongs to (a handover when it is the predecessor). */
  record: { digest: string; run: string | null } | null;
  sourceRecord?:string;metaSource?:string;metaRecord?:string;readManifest?:string;requested?:string;
}

interface Read {
  bytes: Uint8Array;
  mediaType: string;
  sha256: string;
  binding: Omit<SourceBinding, 'role' | 'slot'>;
  external: string | null;
  meta: Record<string, unknown> | null;
  record: { digest: string; run: string | null } | null;
  sourceRecord?:string;metaSource?:string;metaRecord?:string;readManifest?:string;requested?:string;
}

const mediaAccepted = (slot: WorkflowInput, mediaType: string): boolean => slot.accepts.filter((a) => a.includes('/')).some((a) => a.toLowerCase() === essence(mediaType));
const externalType = (id: string): string => id.split(':').slice(0, 2).join(':');

/** A trailing revision of an external object id: a root or a root pair (the knowledge views), the shape views.ts splitRevision cuts. */
const TRAILING_REVISION = /@([0-9a-f]{64}(?:\.\.[0-9a-f]{64})?)$/;

/** The external identity with the revision the Hub read, when it can carry one (SourceBinding.external). */
export function withRevision(id: string, revision: string | null): string {
  // Already pinned: a trailing root or root pair, or exactly the revision that was read — never pinned twice.
  if (revision === null || TRAILING_REVISION.test(id) || id.endsWith(`@${revision}`)) return id;
  // A literal @ inside the id (the catalog name of a knowledge view) is percent-escaped, so the identity with its
  // revision still fits system:type:id[@revision]; the view parser percent-decodes the value back to the same catalog.
  const full = `${id.replaceAll('@', '%40')}@${revision}`;
  return ExternalObjectId.safeParse(full).success ? full : id;
}

export async function bindInputs(
  ctx: EngineContext,
  user: Principal,
  workflow: LoadedWorkflow,
  inputs: Record<string, InputBinding | InputBinding[]>,
  runId: string,
  traceId: string,
  composition?: string | null,
  build?:string,
  variables?:VariableSnapshot,
  unversioned?: ExternalReadContext['unversioned'],
  feeding?:import('../../knowledge/feeding.ts').FeedingScope&{feeding_offset?:ExternalReadContext['feeding_offset']},
): Promise<BoundSource[]> {
  const { artifacts, store } = ctx.deps.records;
  const errors: ProtocolError[] = [];
  const notes: string[] = [];
  const out: BoundSource[] = [];
  const slots = new Map(workflow.workflow.inputs.map((s) => [s.slot, s]));
  const schemaError = (path: string, message: string, fix?: string): void => {
    errors.push(protocolError('SUBMISSION_SCHEMA_VIOLATION', message, { path, ...(fix ? { fix } : {}) }));
  };
  const gone = (path: string, note: string): void => {
    errors.push(unavailableError(path));
    notes.push(`${path}: ${note}`);
  };
  for (const name of Object.keys(inputs)) {
    if (!slots.has(name)) schemaError(`/inputs/${name}`, `任务包没有输入槽 ${name}（有：${[...slots.keys()].join('、')}）`);
  }

  const readReference = async (slot: WorkflowInput, path: string, text: string): Promise<Read | null> => {
    let ref: Reference;
    try {
      ref = parseReference(text);
    } catch (error) {
      if (!(error instanceof ReferenceSyntaxError)) throw error;
      schemaError(path, `引用格式不对：${error.message}`);
      return null;
    }
    if (ref.scheme === 'src') {
      if (ref.selector !== undefined) {
        schemaError(path, '输入要引用整份源文件（src:<sha256>），不是其中的片段');
        return null;
      }
      const source = await artifacts.source(user, ref.sha256, { consumer: 'function' });
      if (source === null || source.bytes === null) {
        gone(path, source === null ? 'source absent or not readable by the caller' : `bytes withheld (${source.readTier})`);
        return null;
      }
      if (!mediaAccepted(slot, source.mediaType)) {
        schemaError(path, `输入槽 ${slot.slot} 不接受媒体类型 ${source.mediaType}（接受：${slot.accepts.join('、')}）`);
        return null;
      }
      return {
        bytes: source.bytes,
        mediaType: source.mediaType,
        sha256: ref.sha256,
        sourceRecord:source.artifact.digest,
        binding: { reference: `src:${ref.sha256}`,artifact:source.artifact.digest,media_type: source.mediaType, ...(source.artifact.body.name ? { label: source.artifact.body.name } : {}) },
        external: null,
        meta: null,
        record: null,
      };
    }
    if (ref.scheme === 'rec') {
      const record = await recordReader(store, ctx.deps.knowledge.layers?.contributions).read(ref.record, identityOf(user));
      if (record === null) {
        gone(path, 'record absent or not visible to the caller');
        return null;
      }
      const bytes = recordBytes(record, ref.pointer);
      if (bytes === null) {
        schemaError(path, 'JSON Pointer 在这条记录里指不到任何值');
        return null;
      }
      if (!mediaAccepted(slot, 'application/json')) {
        schemaError(path, `输入槽 ${slot.slot} 不接受 Hub 记录（application/json）`);
        return null;
      }
      const reference = text;
      const artifact = await artifacts.ingest({
        bytes,
        mediaType: 'application/json',
        origin: { generated: { generator: 'runs.record@1', inputs: [reference] } },
        author: { user: user.id },
        provenanceType: record.provenance,
        visibility: { readers: [user.id], admins: true, packs: [], shareable: false },
        name: `${record.kind}-${ref.record.slice(0, 12)}.json`,
        run: runId,
      });
      const run = runOfRecord(record);
      return {
        bytes,
        mediaType: 'application/json',
        sha256: artifact.body.sha256,
        binding: { reference, media_type: 'application/json', label: `${record.kind} ${ref.record.slice(0, 12)}` },
        external: null,
        meta: { record: ref.record, kind: record.kind, schema: record.schema, created_at: record.created_at, ...(ref.pointer !== undefined ? { pointer: ref.pointer } : {}), source: artifact.body.sha256 },
        record: { digest: ref.record, run },
      };
    }
    schemaError(path, '输入只能是上传得到的 src: 引用、Hub 记录引用 rec: 或外部对象');
    return null;
  };

  const readExternal = async (slot: WorkflowInput, path: string, id: string): Promise<Read | null> => {
    if (!slot.accepts.includes(externalType(id))) {
      schemaError(path, `输入槽 ${slot.slot} 不接受 ${externalType(id)} 类型的外部对象（接受：${slot.accepts.join('、')}）`);
      return null;
    }
    if (!(await ctx.deps.external.accepts(id,{principal:user,run:runId,purpose:`运行输入 ${slot.slot}`,adminNote:reason=>notes.push(`${path}: ${reason}`)}))) {
      gone(path, `no enabled resource reads ${externalType(id)}`);
      return null;
    }
    const readContext={ feeding_offset:feeding?.feeding_offset,principal: user, run: runId, variables, purpose: `运行输入 ${slot.slot}`,adminNote:(reason:string)=>notes.push(`${path}: ${reason}`), ...(composition !== undefined ? {composition} : {}),...(build!==undefined?{build}:{}),...(unversioned!==undefined?{unversioned}:{}) };
    const records = {artifacts,store};
    let requestId = id;
    let merged: Awaited<ReturnType<typeof mergeIndexBindings>> | null = null;
    if(id.startsWith('knowledge:') && slot.index_default !== undefined){
      const scoped = await narrowIndexId(slot,id,inputs,defectId => defectIndexKeys(defectId,readContext,ctx.deps.external,records));
      if(!scoped.ok){schemaError(path,scoped.message,scoped.fix);return null;}
      if(scoped.ids.length === 1)requestId = scoped.ids[0];
      else merged = await mergeIndexBindings(scoped.ids,scoped.label,readContext,ctx.deps.external,records);
    }
    const read = merged ?? (requestId.startsWith('knowledge:') ? await completeKnowledgeView(requestId,readContext,ctx.deps.external,records) : await ctx.deps.external.read(requestId,readContext));
    if (!read.ok) {
      if (read.inputError !== undefined) {
        if(read.inputError.code)errors.push(protocolError(read.inputError.code,read.inputError.message,{path,fix:read.inputError.fix}));
        else schemaError(path, read.inputError.message, read.inputError.fix);
        notes.push(`${path}: ${read.reason}`);
        return null;
      }
      if(read.retry) {
        errors.push(protocolError('SOURCE_RETRYABLE',`缺少输入 ${id} 的读取结果；下一次重读时间 ${read.retry.at}，按原输入重读`,{path}));
        notes.push(`${path}: ${read.reason}`);
        return null;
      }
      gone(path, read.reason);
      return null;
    }
    if(read.absent) {
      const observation=read.absent;
      errors.push(protocolError('SOURCE_ABSENT',`输入 ${observation.object} 不在 ${observation.system} 里（读于 ${observation.observed_at}）`,{path}));
      return null;
    }
    const chosen = read.artifacts.find((a) => a.name === EXTERNAL_ARTIFACT.content) ?? read.artifacts.find((a) => a.name === EXTERNAL_ARTIFACT.original);
    if (chosen === undefined) {
      gone(path, 'the read gave no original or content artifact');
      return null;
    }
    const source = await artifacts.source(user, chosen.artifact.body.sha256, { consumer: 'function',record:chosen.artifact.digest });
    if (source === null || source.bytes === null) {
      gone(path, source === null ? 'read artifact not readable by the caller' : `bytes withheld (${source.readTier})`);
      return null;
    }
    let meta: Record<string, unknown> | null = null;
    const metaArtifact = read.artifacts.find((a) => a.name === EXTERNAL_ARTIFACT.meta);
    if (metaArtifact !== undefined) {
      const metaSource = await artifacts.source(user, metaArtifact.artifact.body.sha256, { consumer: 'function',record:metaArtifact.artifact.digest });
      if (metaSource?.bytes) {
        try {
          const value: unknown = JSON.parse(new TextDecoder().decode(metaSource.bytes));
          if (isObject(value)) meta = value;
        } catch {
          notes.push(`${path}: meta artifact is not JSON`);
        }
      }
    }
    const external = withRevision(read.id, read.revision);
    const title = meta !== null && typeof meta.title === 'string' && meta.title !== '' ? meta.title : null;
    return {
      bytes: source.bytes,
      mediaType: source.mediaType,
      sha256: source.sha256,
      binding: { reference: `src:${source.sha256}`, artifact:chosen.artifact.digest,...(Sha256.safeParse(read.manifest).success?{read_manifest:read.manifest}:{}),...(metaArtifact?{meta_artifact:metaArtifact.artifact.digest}:{}),external, media_type: source.mediaType,...(read.coverage?{coverage:read.coverage}:{}), ...(title !== null ? { label: title } : {}) },
      external,
      meta,
      sourceRecord:chosen.artifact.digest,metaSource:metaArtifact?.artifact.body.sha256,metaRecord:metaArtifact?.artifact.digest,readManifest:read.manifest,requested:id,
      record: null,
    };
  };

  for (const slot of workflow.workflow.inputs) {
    const given = inputs[slot.slot];
    const list = given === undefined ? [] : Array.isArray(given) ? given : [given];
    if (list.length === 0) {
      if (slot.required) schemaError(`/inputs/${slot.slot}`, `缺少必需的输入 ${slot.slot}：${slot.description}`, slot.from_runs?`在 inputs.${slot.slot} 给出 ${slot.from_runs.pack} 的运行编号，或给出 predecessor 由其血缘缺省；也可以直接给出已受理结果的 rec:`:slot.default_from_predecessor?.slot!==undefined?`在 predecessor 中给出 ${slot.default_from_predecessor.pack} 的运行编号，或在 inputs.${slot.slot} 给出与前驱冻结输入相同的对象`:slot.default_from_predecessor?`在 predecessor 中给出 ${slot.default_from_predecessor.pack} 的运行编号，或在 inputs.${slot.slot} 显式给出有权读取的完整 rec: 结果引用`:`在 inputs.${slot.slot} 里给出 upload_file 的引用或外部对象`);
      continue;
    }
    if (!slot.many && list.length > 1) {
      schemaError(`/inputs/${slot.slot}`, `输入槽 ${slot.slot} 只接受一个源文件，给了 ${list.length} 个`);
      continue;
    }
    for (const [k, binding] of list.entries()) {
      const path = Array.isArray(given) ? `/inputs/${slot.slot}/${k}` : `/inputs/${slot.slot}`;
      let read: Read | null;
      if ('reference' in binding) read = await readReference(slot, path, binding.reference);
      else if ('external' in binding) read = await readExternal(slot, path, binding.external);
      else { schemaError(path, '输入只能是上传得到的 src: 引用、Hub 记录引用 rec: 或外部对象'); continue; }
      if (read === null) continue;
      let refusal: ProtocolError | null = null;
      const parsed = recognize(ctx.parsers, read.bytes, read.mediaType, {}, (error) => {
        refusal = protocolError('SOURCE_UNPARSEABLE', `${error.parser}：${error.message}`, { path, fix: error.fix });
      });
      if (parsed === null) {
        errors.push(refusal ?? protocolError('SOURCE_UNPARSEABLE', `媒体类型 ${read.mediaType} 没有可用的核心解析器`, { path }));
        continue;
      }
      if(ctx.deps.knowledge.feeding)await ctx.deps.knowledge.feeding.observeSourceBounded(user,read.sha256,{...feeding,sourceRecord:read.sourceRecord,metaSource:read.metaSource,metaRecord:read.metaRecord,readManifest:read.readManifest,requested:read.requested});
      out.push({
        slot: slot.slot,
        role: slot.role,
        binding: { ...read.binding, role: slot.role, slot: slot.slot },
        input: {
          slot: slot.slot,
          external: read.external,
          sha256: read.sha256,
          media_type: read.mediaType,
          parser: parserKey(parsed.parser),
          model: parsed.document.model,
          meta: read.meta,
        },
        sha256: read.sha256,
        record: read.record,
      });
    }
  }
  if (errors.length > 0) throw new Refusal(errors, notes.length > 0 ? notes.join('; ') : null);
  return out;
}
