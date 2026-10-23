// The two layers beside the tree (K03), with their write and read API; milestone 1 does not populate them. Neither ever
// enters a root digest: they are claim records next to the tree, not tree nodes.
// - Observation layer: echoes the Hub collected itself in a verification run and the pack declares product observations;
//   append only; device, build, collection time and echo digest; no run id (K03 R[3]); readable by whoever may read the product.
// - Candidate layer: a person's candidates, visible to that person only (admins included, K03 R[4]); bound to the node
//   path, the cited fragment's digest and the root (K03 R[5]); grounded in an uploaded session excerpt whose quotation is
//   verified before the candidate is stored (K03 R[4], R[6]).
import { CandidateProposal, type DocumentOutput } from '../../contracts/src/candidates.ts';
import type { z } from 'zod';
import type { Transaction } from '../records/api.ts';
import { canonicalBytes, canonicalize } from '../records/api.ts';
import { candidateSource, type CandidateSourceScope } from './candidate-source.ts';
import { KnowledgeCandidateBody, KnowledgeObservationBody } from '../../contracts/src/knowledge.ts';
import type { Applicability } from '../../contracts/src/product.ts';
import { labelOf, type PermissionRole, type ValidityStatus } from '../../contracts/generated/vocabulary.ts';
import type { Page, Principal } from '../records/api.ts';
import { sha256Hex } from '../records/api.ts';
import { ReferenceSyntaxError, parseReference, formatReference, pathOf, pathSegments, resolveReference, verifyQuote, type SourceReader } from '../refs/api.ts';
import { normaliseStatement } from './digest.ts';
import type { KnowledgeContext } from './context.ts';
import { KnowledgeError } from './errors.ts';
import type { TreeReading } from './read.ts';
import { INDEX, KnowledgeStore, SCHEMAS } from './store.ts';

export class ObservationLayer {
  readonly #context: KnowledgeContext;
  readonly #reading: TreeReading;

  constructor(context: KnowledgeContext, reading: TreeReading) {
    this.#context = context;
    this.#reading = reading;
  }

  /** Appends one observation. Called by the Hub's own verification runs (trusted caller); the echo must be a stored source. */
  async append(observation: KnowledgeObservationBody): Promise<string> {
    const parsed = KnowledgeObservationBody.safeParse(observation);
    if (!parsed.success) throw new KnowledgeError('观察记录不合格：只带产品、构建、设备、采集时刻、回显源文件摘要和声明它的任务包');
    if ((await this.#context.records.artifacts.records(parsed.data.echo)).length === 0) throw new KnowledgeError('回显源文件不在 Hub 里，先存源文件再记观察（B05 R[2]）');
    const record = await this.#context.store.putClaim(SCHEMAS.observation, 'observed', parsed.data, [{ key: INDEX.observation, value: parsed.data.product }]);
    return record.digest;
  }

  /** Observations of a product, oldest first, by cursor (K05 R[1]); null when the reader may not read the product. */
  async list(product: string, reader: Principal, query: { cursor?: string | null; limit?: number } = {}): Promise<Page<KnowledgeObservationBody & { record: string }> | null> {
    if (!(await this.#reading.mayReadProducts(reader, [product]))) return null;
    const page = await this.#context.store.records.find<unknown>({ key: INDEX.observation, value: product, kind: 'claim', cursor: query.cursor ?? null, limit: query.limit ?? 100 });
    const items: Array<KnowledgeObservationBody & { record: string }> = [];
    for (const record of page.items) {
      const body = KnowledgeStore.observationOf(record);
      if (body !== null && body.product === product) items.push({ ...body, record: record.digest });
    }
    return { items, next: page.next };
  }
}

export interface CandidateInput {
  root?: string;
  path?: string;
  statement: string;
  /** The uploaded session excerpt (src reference) and the quotation from it the candidate rests on. */
  ground: { reference: string; quote: string; session_excerpt?: boolean };
  scope?: CandidateSourceScope;
  applicability?: Applicability | null;
}

export interface CandidateView {
  record: string;
  candidate: KnowledgeCandidateBody;
  /** valid, or cited_fragment_changed when the reader's root has other text at the path (K03 R[5]). */
  status: Extract<ValidityStatus, 'valid' | 'cited_fragment_changed'>;
  note: string | null;
}

export interface DocumentCandidateRequest {
  declaration: z.infer<typeof DocumentOutput>;
  proposal: CandidateProposal;
}
export interface PreparedCandidates { readonly count:number; readonly sha256:string }
export interface CandidateWriteReceipt { records:string[]; accepted:number; deduplicated:number }
export type CandidateGroundPolicy = boolean;

function candidateIdentity(owner:string,row:DocumentCandidateRequest,privateGround:boolean):string {
  const quote=(q:{reference:string;quote:string})=>({reference:formatReference(parseReference(q.reference)),quote:q.quote.replace(/\s+/gu,' ').trim()});
  const p=row.proposal,ref=parseReference(p.source.reference);
  const binding=p.binding??(ref.scheme==='tree'?{root:ref.root,path:ref.path}:null);
  return sha256Hex(canonicalize({owner,kind:row.declaration.kind,statement:normaliseStatement(p.statement),source:quote(p.source),ground:quote(p.ground??p.source),privateGround,
    binding:binding===null?null:{root:binding.root,path:pathOf(pathSegments(binding.path))},relation:p.relation?{name:p.relation.name,other:quote(p.relation.other)}:null}));
}

export class CandidateLayer {
  readonly #context: KnowledgeContext;
  readonly #reading: TreeReading;
  readonly #prepared = new WeakMap<PreparedCandidates,{owner:string;requests:DocumentCandidateRequest[];model:string;policy:CandidateGroundPolicy;scope?:CandidateSourceScope;bodies:KnowledgeCandidateBody[];identities:string[];existing:string[]}>();

  constructor(context: KnowledgeContext, reading: TreeReading) {
    this.#context = context;
    this.#reading = reading;
  }

  async #account(owner: Principal): Promise<{ id: string; role: PermissionRole }> {
    const account = await this.#context.records.principals.get(owner?.id);
    if (account === null || account.disabled) throw new KnowledgeError('对你不可用', { code: 'SOURCE_UNAVAILABLE' });
    return { id: account.id, role: account.role };
  }

  /** SHA-256 of the text at a path of a root, as the tree reader gives it. */
  async #fragmentDigest(root: string, path: string, reader: { id: string; role: PermissionRole }): Promise<string | null> {
    const read = await this.#reading.treeReader().read(root, path, null, { user: reader.id, role: reader.role });
    return read === null ? null : sha256Hex(read.text);
  }

  async add(owner:Principal,input:CandidateInput):Promise<string>{
    if(input.applicability!=null)throw new KnowledgeError('候选不能增添来源未声明的适用条件',{code:'SUBMISSION_SCHEMA_VIOLATION'});
    const quote={reference:input.ground.reference,quote:input.ground.quote};
    const scope=input.scope??this.#documentScope(input.root);
    const declaration={id:'legacy',kind:'assertion' as const,max_items:1};
    const proposal={output:'legacy',statement:input.statement,source:quote,
      ...(input.root===undefined&&input.path===undefined?{}:{binding:{root:input.root!,path:input.path!}})};
    const prepared=await this.prepareDocuments(owner,[{declaration,proposal}],'(declared)',input.ground.session_excerpt===true,scope);
    return (await this.appendPrepared(owner,prepared)).records[0];
  }

  #documentScope(root?:string):CandidateSourceScope{
    return {begin:async owner=>({resolve:async reference=>{
      const ref=parseReference(reference);
      if(ref.scheme==='src')return {reference,text:'',provenance:'declared'}; // actual source and grade are read below
      if(ref.scheme!=='tree'||(root!==undefined&&ref.root!==root))return null;
      const result=await resolveReference(ref,{reader:{user:owner.id,role:owner.role},parsers:this.#context.parsers,trees:this.#reading.treeReader(),consumer:'model'});
      const metadata=result.resolved?await this.sourceMetadata(owner,result.reference):null;
      return result.resolved&&result.text!==null&&metadata!==null?{reference:result.reference,text:result.text,...metadata}:null;
    }})};
  }

  /** Metadata of the actual immutable tree record, never a model-supplied provenance label. */
  async sourceMetadata(owner:Principal,reference:string):Promise<{provenance:import('../../contracts/generated/vocabulary.ts').ProvenanceType;record:string}|null>{
    const account=await this.#account(owner),ref=parseReference(reference);
    if(ref.scheme!=='tree'||!(await this.#reading.mayReadRoot(account,ref.root)))return null;
    const at=await this.#reading.nodeAt(ref.root,pathSegments(ref.path));
    if(at===null||(ref.entry!==undefined&&!at.node.entries.includes(ref.entry)))return null;
    const page=await this.#context.store.records.find({key:ref.entry===undefined?INDEX.node:INDEX.entry,value:ref.entry??at.digest,kind:'tree_node',limit:1});
    const record=page.items[0];return record?{provenance:record.provenance,record:record.digest}:null;
  }

  /** Verify a whole batch without persisting content. Its opaque handle cannot be forged or altered by a caller. */
  async prepareDocuments(owner:Principal,requests:readonly DocumentCandidateRequest[],model:string,policy:CandidateGroundPolicy,scope?:CandidateSourceScope):Promise<PreparedCandidates> {
    const snapshot=structuredClone(requests) as DocumentCandidateRequest[];
    const account=await this.#account(owner),reader={id:account.id,name:account.id,role:account.role};
    const scoped=scope===undefined?await this.#documentScope().begin(reader):await scope.begin(reader);
    const bodies:KnowledgeCandidateBody[]=[],identities:string[]=[],existing:string[]=[];
    const counts=new Map<string,number>();
    for(const row of snapshot){
      const parsed=CandidateProposal.safeParse(row.proposal);
      if(!parsed.success)throw new KnowledgeError('候选形状不合格，不能自报来源、依据等级或适用条件',{code:'SUBMISSION_SCHEMA_VIOLATION'});
      const p=parsed.data,d=row.declaration;
      if(d.id!==p.output || (counts.get(d.id)??0)>=d.max_items)throw new KnowledgeError('候选超出工作流声明',{code:'SUBMISSION_SCHEMA_VIOLATION'});
      counts.set(d.id,(counts.get(d.id)??0)+1);
      if((d.kind==='placement_proposal' && p.binding===undefined)||(d.kind==='relation')!==(p.relation!==undefined))throw new KnowledgeError('候选种类与工作流声明不一致',{code:'SUBMISSION_SCHEMA_VIOLATION'});
      const identity=candidateIdentity(account.id,row,p.ground!==undefined||policy);
      const prior=await this.#context.store.records.find({key:'knowledge.candidate.identity',value:`${account.id}:${identity}`,kind:'claim',limit:1});
      if(prior.items[0]){existing.push(prior.items[0].digest);continue;}
      const source=await candidateSource(this.#context,reader,p.source,false,scoped);
      const ground=p.ground??p.source;
      if(p.ground!==undefined || policy)await candidateSource(this.#context,reader,ground,true,p.ground===undefined?scoped:undefined);
      let anchor:{product?:string;root?:string;path?:string;cited_fragment:string;source_revision?:string};
      const sourceRef=parseReference(source.reference);
      const binding=p.binding??(sourceRef.scheme==='tree'?{root:sourceRef.root,path:sourceRef.path}:undefined);
      if(binding!==undefined){
        const path=pathOf(pathSegments(binding.path));
        const fragment=await this.#fragmentDigest(binding.root,path,account);
        if(fragment===null)throw new KnowledgeError('提议路径在依据根中不可解析',{code:'REFERENCE_UNRESOLVED'});
        const products=await this.#reading.productsOfRoot(binding.root);
        anchor={product:[...products].sort()[0],root:binding.root,path,cited_fragment:fragment};
      }else{
        const ref=parseReference(source.reference);
        anchor={cited_fragment:source.fragment,source_revision:ref.scheme==='src'?ref.sha256:ref.scheme==='tree'?ref.root:ref.scheme==='rec'?ref.record:ref.entry};
      }
      const relation=p.relation===undefined?undefined:{name:p.relation.name,other:await candidateSource(this.#context,reader,p.relation.other,false,scoped)};
      const body=KnowledgeCandidateBody.parse({...anchor,owner:account.id,statement:normaliseStatement(p.statement),ground,applicability:null,
        kind:d.kind,output:d.id,model,basis_rank:parseReference(source.reference).scheme==='rec'||(relation!==undefined&&parseReference(relation.other.reference).scheme==='rec')?'relay':'judgment',source,...(relation===undefined?{}:{relation})});
      bodies.push(body);
      identities.push(identity);
    }
    const handle=Object.freeze({count:snapshot.length,sha256:sha256Hex(canonicalBytes(snapshot))});
    this.#prepared.set(handle,{owner:account.id,requests:snapshot,model,policy,scope,bodies,identities,existing});
    return handle;
  }

  /** Recheck live source access immediately before a transaction; never evaluate source I/O inside that transaction. */
  async recheckDocuments(owner:Principal,handle:PreparedCandidates):Promise<PreparedCandidates>{
    const saved=this.#prepared.get(handle);
    if(saved===undefined||saved.owner!==owner.id)throw new KnowledgeError('候选核验凭据无效',{code:'SOURCE_UNAVAILABLE'});
    return this.prepareDocuments(owner,saved.requests,saved.model,saved.policy,saved.scope);
  }

  /** Append only the private bodies we verified. The run stores the batch count/digest, never these bodies. */
  async appendPrepared(owner:Principal,handle:PreparedCandidates,tx?:Transaction):Promise<CandidateWriteReceipt>{
    const saved=this.#prepared.get(handle);
    if(saved===undefined||saved.owner!==owner.id)throw new KnowledgeError('候选核验凭据无效',{code:'SOURCE_UNAVAILABLE'});
    if(tx===undefined){const fresh=await this.recheckDocuments(owner,handle);return this.#context.store.records.withTransaction(transaction=>this.appendPrepared(owner,fresh,transaction));}
    const write=async(transaction:Transaction)=>{
      const records:string[]=[...saved.existing];let accepted=0,deduplicated=saved.existing.length;
      for(const [i,body]of saved.bodies.entries()){
        const identity=saved.identities[i];
        const existing=await this.#context.store.records.find({key:'knowledge.candidate.identity',value:`${owner.id}:${identity}`,kind:'claim',limit:1},transaction);
        if(existing.items[0]){records.push(existing.items[0].digest);deduplicated++;continue;}
        const record=await this.#context.store.putClaim(SCHEMAS.candidate,'candidate',body,[{key:INDEX.candidate,value:owner.id},{key:'knowledge.candidate.identity',value:`${owner.id}:${identity}`}],transaction);
        records.push(record.digest);
        accepted++;
      }
      return {records:[...new Set(records)],accepted,deduplicated};
    };
    return tx===undefined?this.#context.store.records.withTransaction(write):write(tx);
  }

  /** The owner's own candidates (nobody else's, admins included), with their status against the root the owner reads. */
  async list(owner: Principal, readerRoot: string | null = null): Promise<CandidateView[]> {
    const account = await this.#account(owner);
    const records = await this.#context.store.all<unknown>({ key: INDEX.candidate, value: account.id, kind: 'claim' });
    const out: CandidateView[] = [];
    for (const record of records) {
      const candidate = KnowledgeStore.candidateOf(record);
      if (candidate === null || candidate.owner !== account.id) continue;
      let status: CandidateView['status'] = 'valid';
      let note: string | null = null;
      if (readerRoot !== null && candidate.root !== undefined && candidate.path !== undefined && readerRoot !== candidate.root) {
        const now = await this.#fragmentDigest(readerRoot, candidate.path, account);
        if (now !== candidate.cited_fragment) {
          status = 'cited_fragment_changed';
          note = `${labelOf('validity_status', 'cited_fragment_changed')}（根 ${candidate.root.slice(0, 12)} → ${readerRoot.slice(0, 12)}）`;
        }
      }
      out.push({ record: record.digest, candidate, status, note });
    }
    return out;
  }
}
