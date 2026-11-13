import type { ContributionLayer } from '../../knowledge/api.ts';
// Visibility (R02) and the readers hub/refs resolves references with. Owners see their runs; admins see team runs;
// a run the Hub executes itself is shown to admins only (W06 R[3]). Records reach a reader only through the run they belong
// to; absent and forbidden give the same null.
import type { ProducerKind } from '../../../contracts/generated/vocabulary.ts';
import {parseReference} from '../../refs/api.ts';
import type {SourceBinding} from '../../../contracts/src/run.ts';
import type { RunRecord } from '../../../contracts/src/run.ts';
import { disclosedExistence, recordExistence, requestRead, runIsSharedWith, canSeeRun, mayReadRecord } from '../../records/api.ts';
import type { Artifacts, Principal, RecordStore, RecordsKit, Principals } from '../../records/api.ts';
import type { ReaderIdentity, RecordReader, SourceReader } from '../../refs/api.ts';
import { step } from '../../telemetry/api.ts';
import { runById, actionOfSubmission } from './store.ts';

export {canSeeRun,runOfRecord} from '../../records/api.ts';

/** Read-only sharing never changes canSeeRun, the submission and lineage guard. */
export async function canViewRun(user: Principal, run: RunRecord, store: RecordStore): Promise<boolean> {
  return canSeeRun(user, run) || await runIsSharedWith(store, user.id, run, new Date(),user.role);
}

export function identityOf(user: Principal, run?: string): ReaderIdentity {
  return run === undefined ? { user: user.id, role: user.role } : { user: user.id, role: user.role, run };
}

export function principalOf(reader: ReaderIdentity): Principal {
  return { id: reader.user, name: reader.user, role: reader.role };
}

/** Preserve retained metadata and unexpected function-read failures; model-only byte withholding stays neutral. */
export function sourceReader(artifacts: Artifacts, consumer: ProducerKind,bindings?:readonly SourceBinding[]): SourceReader {
  return {
    async read(sha256, reader) {
      const pins=[...new Set((bindings??[]).flatMap(binding=>{const ref=parseReference(binding.reference);return ref.scheme==='src'&&ref.sha256===sha256&&binding.artifact?[binding.artifact]:[];}))];
      return requestRead(reader.user,JSON.stringify([consumer,sha256,reader.role,reader.run??null,pins[0]??null]),()=>step('read-source',async()=>{
        const source = pins.length?await artifacts.source(principalOf(reader),sha256,{consumer,record:pins[0]})??(reader.run?await artifacts.sourceForRun(principalOf(reader),sha256,reader.run,{consumer,record:pins[0]}):null):await artifacts.source(principalOf(reader), sha256, { consumer }) ?? (reader.run ? await artifacts.sourceForRun(principalOf(reader),sha256,reader.run,{consumer}) : null);
        if (source === null || consumer === 'model' && source.bytes === null && source.readTier !== 'retain_only') return null;
        const scan=source.artifact?.body?.scan;
        // Accepted findings can come from a different capture of the same bytes, so never cache them as clean.
        const cacheable=source.acceptance===undefined&&scan?.inspected===true&&!scan.truncated&&scan.findings.length===0;
        return { bytes: source.bytes, mediaType: source.mediaType, size: source.size, readTier: source.readTier, cacheable };
      },{type:'retriever'}),source=>source?.cacheable ? source.bytes?.byteLength??0 : -1);
    },
    // Whether the Hub holds the source at all, so refs tells absent from forbidden (D05 R[3], decision 112).
    // Another account's personal copies stay neutral (null), D05 R[3].
    async exists(sha256) {
      const existence = disclosedExistence('', await artifacts.records(sha256));
      return existence === 'neutral' ? null : existence === 'exists';
    },
  };
}

/** Records for reference resolution: run, submission, validation result and action records through their run; contributions through their product. */
export function recordReader(kit: Pick<RecordsKit, 'store' | 'artifacts'> & {principals:Pick<Principals,'get'>}, contributions?: Pick<ContributionLayer, 'read'>,readRun?:(by:Principal,run:RunRecord)=>Promise<boolean>,readResult?:(by:Principal,run:RunRecord,result:unknown)=>Promise<boolean>,readRequest?:(by:Principal,request:unknown)=>Promise<boolean>,readSubmission?:(by:Principal,run:RunRecord,digest:string)=>Promise<boolean>): RecordReader {
  const {store}=kit;
  return {
    async read(digest, reader) {
      const record = await store.get(digest);
      if (record === null) return null;
      const allowed=await mayReadRecord(principalOf(reader),record,{
        account:id=>kit.principals.get(id),
        run:async(by,id)=>{
          const run=(await runById(store,id))?.body;
          return run && await (readRun?readRun(by,run):canViewRun(by,run,store)) ? run : null;
        },
        source:(by,source)=>kit.artifacts.canRead(by,source),
        contribution:async(by,row)=>(await contributions?.read(row.digest,by))!=null,
        request:async(by,_run,row)=>readRequest?readRequest(by,row.body):true,
        result:async(by,run,row)=>readResult?readResult(by,run,row.body):true,
        submission:async(by,run,row)=>(await actionOfSubmission(store,row.digest))?.body.acceptance==='accepted' && (!readSubmission || await readSubmission(by,run,row.digest)),
      });
      if(!allowed)return null;
      return { kind: record.kind, schema: record.schema, provenance: record.provenance, created_at: record.created_at, body: record.body };
    },
    async exists(digest) {
      const existence = await recordExistence(store, '', await store.get(digest));
      return existence === 'neutral' ? null : existence === 'exists';
    },
  };
}
