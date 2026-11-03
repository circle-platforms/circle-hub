// Personal namespaces reuse the pack publisher's validators, sample runner and immutable extractor. Team records stay separate.
import { join, extname } from 'node:path';
import { PersonalPackVersionBody, PersonalPackGrantBody, PersonalPackRetirementBody, PersonalPackTransferBody } from '../../../contracts/src/sharing.ts';
import { PackId, UserId } from '../../../contracts/src/common.ts';
import { AccessError, IntegrityError, personalPackKey, personalPackGrants, mayUsePersonalPack, type Principal, type RecordKind, type StoredRecord, type Page, type Transaction, type Artifacts } from '../../records/api.ts';
import { ShareCheckSchema } from '../../../contracts/generated/vocabulary.ts';
import type {SharingCheck} from '../../knowledge/api.ts';
import {readFile} from 'node:fs/promises';
import {scanForCredentials} from '../../records/api.ts';
import type { KnowledgeGrantee } from '../../../contracts/generated/vocabulary.ts';
import type { PackRegistry, PackRegistryOptions, OpenedPack } from './registry.ts';
import type { PackVersionInfo, PublishOutcome, PublishCheck, PublishReport, PackProblem } from './types.ts';
import { readPackDirectory, manifestDigest } from './directory.ts';
import { validatePack, versionProblems, credentialProblems } from './validate.ts';
import { runPublishCheck, refusalsOf, needsSandbox } from './samples.ts';
import { Extractor, type StagedTree } from './extract.ts';
import { parseDeclarations, packJsonReader } from './load.ts';
import { compareVersions, parsePackRef } from './versions.ts';
import { problem } from './problems.ts';
import {personalPackProblems} from './personal-capabilities.ts';
import type {SkillDependency} from '../../../contracts/src/skills.ts';

export class PersonalPacks {
  #options:PackRegistryOptions; #team:PackRegistry; #extractor:Extractor; #writes:Promise<unknown>=Promise.resolve();
  constructor(options:PackRegistryOptions,team:PackRegistry){this.#options=options;this.#team=team;options.records.memberDeletions?.registerCacheRoot(join(options.extractDir,'personal'));options.records.memberDeletions?.registerCacheRoot(options.extractDir);this.#extractor=new Extractor({root:join(options.extractDir,'personal'),onTamper:options.onTamper});}
  #now(){return (this.#options.now?.()??new Date()).toISOString();}
  async #account(by:Principal){const account=await this.#team.account(by);if(!account)throw new AccessError('对象不存在或无权读取');return account;}
  async #own(by:Principal,space=by.id){by=await this.#account(by);if(by.id!==space)throw new AccessError('对象不存在或无权读取');return by;}
  async #dependencyProblems(by:Principal,dependencies:readonly SkillDependency[],grant=false,targets?:readonly Principal[],owners?:Set<string>):Promise<PackProblem[]>{
    if(!dependencies.length)return [];
    const unavailable=()=>[problem('personal.dependency','pack.json','所依赖的通用技能不存在或无权使用','先发布本人技能、取得授权或安装团队技能，再核对依赖版本')];
    const foreign=()=>[problem('personal.dependency','pack.json','依赖他人的个人通用技能，不能向其他账户授权','改用本人的通用技能或团队通用技能后发布修订版本')];
    const team=await this.#team.installedSkills(),pending=dependencies.map(dep=>({dep,scope:by.id as string|undefined})),seen=new Set<string>(),owned=new Set<string>();
    while(pending.length){
      const {dep,scope:inherited}=pending.shift()!,scope=dep.space??inherited;
      // Foreign ACLs never participate in a grant preview, including through an owned dependency.
      if(grant&&scope&&scope!=='team'&&scope!==by.id)return foreign();
      let info=scope?await this.resolve(by,scope,dep.pack+(dep.version?'@'+dep.version:'')):null;
      if(info?.kind!=='skill')info=null;
      if(!info&&!dep.space)info=team.find(pack=>pack.info.id===dep.pack&&(dep.version===undefined||pack.info.version===dep.version))?.info??null;
      if(!info)return unavailable();
      if(info.space&&info.space!=='team')owners?.add(info.space);
      if(grant&&info.space&&info.space!=='team'){
        if(info.space!==by.id)return foreign();
        owned.add(info.id);
      }
      const key=(info.space??'team')+'/'+info.id+'@'+info.version;if(seen.has(key))continue;seen.add(key);if(seen.size>64)return unavailable();
      for(const nested of info.manifest.dependencies??[])pending.push({dep:nested,scope:info.space});
    }
    if(owned.size&&targets===undefined)return [problem('personal.grantee','pack.json','先填写授权对象并预检','填写授权对象后重试')];
    for(const pack of owned)for(const target of targets??[])if(!await this.mayUse(target,by.id,pack))return [problem('personal.dependency','pack.json','依赖的个人技能对授权对象不可读','先对相同对象授权依赖，或使用团队技能')];
    return [];
  }
  async #all(kind:RecordKind,key:string,value:string,tx?:Transaction){const out:StoredRecord<unknown>[]=[];let cursor:string|null=null;do{const page:Page<StoredRecord<unknown>>=await this.#options.records.store.find({kind,key,value,limit:500,cursor},tx);out.push(...page.items);cursor=page.next;}while(cursor);return out;}
  async mayUse(by:Principal,space:string,pack:string){by=await this.#account(by);if(!UserId.safeParse(space).success||!PackId.safeParse(pack).success)return false;const owner=await this.#options.records.principals.get(space);return !!owner&&!owner.disabled&&await mayUsePersonalPack(this.#options.records.store,by,space,pack);}
  async #info(record:StoredRecord<unknown>,tx?:Transaction):Promise<PackVersionInfo>{
    const body=PersonalPackVersionBody.parse(record.body);
    if(body.publisher!==body.space||body.manifest.id!==body.pack||body.manifest.version!==body.version||body.manifest.kind!==body.kind||manifestDigest(body.manifest)!==body.digest)throw new IntegrityError('个人包版本与清单不一致');
    const retired=(await this.#options.records.store.find({kind:'personal_pack_retirement',key:'personal.pack.retired',value:personalPackKey(body.space,body.pack)+'@'+body.version,limit:1},tx)).items[0];
    const report=body.report as unknown as PublishReport;
    return {space:body.space,id:body.pack,version:body.version,kind:body.kind,digest:body.digest,title:body.title,description:body.description,owner:body.space,publisher:body.publisher,published_at:body.at,withdrawn:!!retired,withdrawn_at:retired?PersonalPackRetirementBody.parse(retired.body).at:null,record:record.digest,publication:record.digest,samples:report.samples.sources,report,manifest:body.manifest};
  }
  async versions(space:string,pack:string,tx?:Transaction){if(!UserId.safeParse(space).success||!PackId.safeParse(pack).success)return [];const records=await this.#all('personal_pack_version','personal.pack.id',personalPackKey(space,pack),tx);return (await Promise.all(records.map(record=>this.#info(record,tx)))).sort((a,b)=>compareVersions(b.version,a.version));}
  async resolve(by:Principal,space:string,ref:string){const parsed=parsePackRef(ref);if(!parsed||!await this.mayUse(by,space,parsed.id))return null;const info=(await this.versions(space,parsed.id)).find(info=>!info.withdrawn&&(parsed.version===null||info.version===parsed.version))??null;return info&&await this.mayUse(by,space,parsed.id)?info:null;}
  async byDigest(space:string,digest:string,tx?:Transaction){const record=(await this.#options.records.store.find({kind:'personal_pack_version',key:'personal.pack.digest',value:space+'/'+digest,limit:1},tx)).items[0];return record?this.#info(record,tx):null;}
  async open(space:string,digest:string):Promise<OpenedPack|null>{
    return this.#options.records.store.withTransaction(async tx=>{
    if(this.#options.records.personalPayloads&&!await this.#options.records.personalPayloads.holdPack(space,digest,tx))return null;
    const info=await this.byDigest(space,digest,tx);if(!info)return null;
    const extraction=await this.#extractor.extract(digest,async()=>({manifest:info.manifest,read:sha=>this.#options.records.objects.get(sha,tx)}));
    const files=new Map<string,Uint8Array>();for(const file of info.manifest.files){if(!['workflow.json','requirements.json','checks.json','slots.schema.json','knowledge.json','ledger.json','skill.json','SKILL.md'].includes(file.path))continue;const bytes=await this.#options.records.objects.get(file.sha256,tx);if(!bytes)throw new IntegrityError('个人包声明文件暂不可读');files.set(file.path,bytes);}
    return {info,handle:{space,id:info.id,version:info.version,digest,kind:info.kind,directory:extraction.directory},declarations:parseDeclarations(info.kind,files),readJson:packJsonReader(extraction.directory,info.manifest,digest)};
    });
  }
  async list(by:Principal):Promise<PackVersionInfo[]>{
    by=await this.#account(by);const owners=new Set([by.id]);
    const grants=await this.#options.records.store.findMany({kind:'personal_pack_grant',key:'personal.pack.grantee',values:[by.id,...(by.role==='admin'?['administrators']:[])]});
    for(const record of grants)owners.add(PersonalPackGrantBody.parse(record.body).space);
    const out:PackVersionInfo[]=[];
    for(const owner of owners)for(const record of await this.#all('personal_pack_version','personal.pack.owner',owner)){const body=PersonalPackVersionBody.parse(record.body);if(await this.mayUse(by,owner,body.pack))out.push(await this.#info(record));}
    return out.sort((a,b)=>a.owner.localeCompare(b.owner)||a.id.localeCompare(b.id)||compareVersions(b.version,a.version));
  }
  async skills(by:Principal){const selected=new Map<string,PackVersionInfo>();for(const info of await this.list(by))if(info.kind==='skill'&&!info.withdrawn&&!selected.has(info.owner+'/'+info.id))selected.set(info.owner+'/'+info.id,info);const opened=await Promise.all([...selected.values()].map(info=>this.open(info.owner,info.digest)));return opened.filter((pack):pack is OpenedPack=>pack!==null);}
  async grants(by:Principal,pack:string){by=await this.#own(by);return personalPackGrants(this.#options.records.store,by.id,PackId.parse(pack));}
  async grant(by:Principal,pack:string,input:{audience:KnowledgeGrantee;member?:string|null;revoke?:boolean}){
    by=await this.#own(by);if(!(await this.versions(by.id,pack)).length)throw new AccessError('对象不存在或无权读取');
    if(input.member){const target=await this.#options.records.principals.get(input.member);if(!target||!input.revoke&&target.deleted_at)throw new AccessError('对象不存在或无权读取');}
    const body=PersonalPackGrantBody.parse({space:by.id,pack,audience:input.audience,member:input.member??null,action:input.revoke?'revoke':'grant',by:by.id,at:this.#now()});
    return this.#options.records.store.withTransaction(async tx=>{await this.#options.records.store.lock('personal-pack:'+personalPackKey(by.id,pack),tx);by=await this.#options.records.principals.lockActive(by,tx);if(!input.revoke){const targets=body.member?[await this.#options.records.principals.get(body.member)]:await this.#options.records.principals.list();const checks=await this.precheckGrant(by,pack,targets.filter((u):u is NonNullable<typeof u>=>!!u&&!u.disabled&&(body.member!==null||u.role==='admin')));if(checks.some(check=>check.state!=='pass'))throw new AccessError('授权前检查未通过');}return this.#options.records.store.put({kind:'personal_pack_grant',schema:'personal-pack-grant@1',provenance:'declared',body,index:[{key:'personal.pack.grant',value:personalPackKey(by.id,pack)},{key:'personal.pack.grantee',value:body.member??'administrators'},{key:'personal.pack.grant_owner',value:by.id}]},tx);});
  }
  async retire(by:Principal,pack:string,version:string){
    by=await this.#own(by);const info=(await this.versions(by.id,pack)).find(info=>info.version===version);if(!info)throw new AccessError('对象不存在或无权读取');
    const body=PersonalPackRetirementBody.parse({space:by.id,pack,version,digest:info.digest,by:by.id,at:this.#now()});
    return this.#options.records.store.withTransaction(async tx=>{await this.#options.records.store.lock('knowledge-space:'+by.id,tx);await this.#options.records.store.lock('personal-pack:'+personalPackKey(by.id,pack),tx);by=await this.#options.records.principals.lockActive(by,tx);return this.#options.records.store.put({kind:'personal_pack_retirement',schema:'personal-pack-retirement@1',provenance:'declared',body,index:[{key:'personal.pack.retired',value:personalPackKey(by.id,pack)+'@'+version}]},tx);});
  }
  async check(by:Principal,directory:string):Promise<PublishCheck>{return await this.#publish(by,directory,true) as PublishCheck;}
  async publish(by:Principal,directory:string):Promise<PublishOutcome>{return await this.#publish(by,directory,false) as PublishOutcome;}
  async #publish(by:Principal,directory:string,dry:boolean):Promise<PublishOutcome|PublishCheck>{
    const work=()=>this.#publishAdmitted(by,directory,dry);
    return this.#options.records.personalPayloads?.withStagingSlot(by.id,work)??work();
  }
  async #publishAdmitted(by:Principal,directory:string,dry:boolean):Promise<PublishOutcome|PublishCheck>{
    by=await this.#own(by);const refuse=(problems:PackProblem[],report:PublishReport|null=null):PublishOutcome=>({ok:false,problems,report});
    const read=await readPackDirectory(directory,{limits:this.#options.limits});if(!read.ok)return refuse(read.problems);
    const {manifest,digest}=read.pack;if(manifest.kind!=='workflow'&&manifest.kind!=='skill')return refuse([problem('personal.kind','pack.json','个人空间只接受工作流与通用技能','选择团队空间并按团队权限发布')]);
    const validation=await validatePack(read.pack,{policy:this.#options.policy});if(!validation.ok)return refuse(validation.problems);const capabilities=personalPackProblems(validation.pack.declarations);if(capabilities.length)return refuse(capabilities);const versionErrors=versionProblems(manifest);if(versionErrors.length)return refuse(versionErrors);
    const dependencyErrors=await this.#dependencyProblems(by,manifest.dependencies??[]);if(dependencyErrors.length)return refuse(dependencyErrors);
    let staged:StagedTree|null=null;
    try{
      if(needsSandbox(validation.pack)){const stage=()=>this.#extractor.stage(digest,read.pack.manifestBytes,read.pack.files.map(file=>({path:file.path,bytes:file.bytes})));staged=await (this.#options.records.personalPayloads?this.#options.records.personalPayloads.stage(by.id,digest,stage):stage());}
      const report=await runPublishCheck({pack:validation.pack,packDir:staged?.directory??null,sandbox:this.#options.sandbox,onError:this.#options.onError});by=await this.#own(by);report.warnings.unshift(...validation.pack.warnings);const errors=refusalsOf(report,validation.pack);if(errors.length)return refuse(errors,report);
      const checkExisting=async(tx?:Transaction)=>{
        const owners=new Set<string>(),dependencies=await this.#dependencyProblems(by,manifest.dependencies??[],false,undefined,owners);if(tx&&!dependencies.length){by=await this.#options.records.principals.lockActive(by,tx,[...owners]);dependencies.push(...await this.#dependencyProblems(by,manifest.dependencies??[]));}if(dependencies.length)return {failure:refuse(dependencies,report)};
        const versions=await this.versions(by.id,manifest.id,tx),existing=versions.find(info=>info.version===manifest.version)??null;
        if(versions.some(info=>info.kind!==manifest.kind))return {failure:refuse([problem('publish.kind_changed','pack.json','包种类与本空间已发布版本不一致','使用新的包号')],report)};
        if(existing&&(existing.digest!==digest||existing.withdrawn))return {failure:refuse([problem(existing.withdrawn?'publish.version_withdrawn':'publish.version_reused','pack.json','本空间中的该版本号已被使用','提高版本号后重新发布')],report)};
        return {existing,current:versions.find(info=>!info.withdrawn)??null};
      };
      const first=await checkExisting();if(first.failure)return first.failure;
      if(dry){by=await this.#own(by);return {ok:true,manifest,digest,report,existing:first.existing,current:first.current};}
      const writing=this.#writes.then(async()=>{by=await this.#own(by);return this.#options.records.store.withTransaction(async tx=>{
        await this.#options.records.store.lock('knowledge-space:'+by.id,tx);
        await this.#options.records.store.lock('personal-pack:'+personalPackKey(by.id,manifest.id),tx);
        by=await this.#options.records.principals.lockActive(by,tx);
        const checked=await checkExisting(tx);if(checked.failure)return checked.failure;if(checked.existing)return {ok:true,created:false,version:checked.existing,report} as PublishOutcome;
        const files:Record<string,string>={};const artifacts=this.#options.records.artifacts;
        for(const file of read.pack.files){await this.#options.records.objects.put(file.bytes,'application/octet-stream',tx,by.id,true);if(artifacts){const artifact=await artifacts.ingest({personalOwner:by.id,accountOwned:true,bytes:file.bytes,mediaType:extname(file.path)==='.json'?'application/json':'text/plain',name:file.path,origin:{upload:{session:null,message:null}},author:{user:by.id,declared:null},provenanceType:'declared',visibility:{readers:[by.id],admins:false,packs:[],shareable:false},readTier:'model_readable'},tx);files[file.path]=artifact.digest;}}
        await this.#options.records.objects.put(read.pack.manifestBytes,'application/json',tx,by.id,true);
        const body=PersonalPackVersionBody.parse({space:by.id,pack:manifest.id,version:manifest.version,kind:manifest.kind,digest,title:manifest.title,description:manifest.description,manifest,publisher:by.id,at:this.#now(),report:JSON.parse(JSON.stringify(report)),files});
        const stored=await this.#options.records.store.put({kind:'personal_pack_version',schema:'personal-pack-version@1',provenance:'declared',body,index:[{key:'personal.pack.owner',value:by.id},{key:'personal.pack.id',value:personalPackKey(by.id,manifest.id)},{key:'personal.pack.digest',value:by.id+'/'+digest}]},tx);
        if(!this.#options.records.store.addIndex)throw new IntegrityError('个人包文件索引端口暂不可用');
        const hashes=[...new Set(manifest.files.map(file=>file.sha256))];for(let at=0;at<hashes.length;at+=100)await this.#options.records.store.addIndex(stored.digest,hashes.slice(at,at+100).map(value=>({key:'personal.pack.file',value})),tx);
        return {ok:true,created:true,version:{space:by.id,id:manifest.id,version:manifest.version,kind:manifest.kind,digest,title:manifest.title,description:manifest.description,owner:by.id,publisher:by.id,published_at:body.at,withdrawn:false,withdrawn_at:null,record:stored.digest,publication:stored.digest,samples:report.samples.sources,report,manifest},report} as PublishOutcome;
      });});this.#writes=writing.then(()=>undefined,()=>undefined);const outcome=await writing;if(outcome.ok&&staged){await this.#options.records.store.withTransaction(async tx=>{await this.#options.records.principals.lockActive(by,tx);await staged!.promote();});staged=null;}return outcome;
    }finally{await (staged as StagedTree|null)?.discard();}
  }
  async precheckPromotion(by:Principal,ref:string){
    const work=()=>this.#precheckPromotionAdmitted(by,ref);
    return this.#options.records.personalPayloads?.withStagingSlot(by.id,work)??work();
  }
  async #precheckPromotionAdmitted(by:Principal,ref:string){
    by=await this.#own(by);const checks:SharingCheck[]=ShareCheckSchema.extract(['permission','structure','sandbox','references','credentials']).options.map(check=>({check,state:'unchecked',code:null,message:'',fix:''}));let phase=0;
    const reject=(problems:PackProblem[])=>{checks[phase]={...checks[phase],state:'violation',message:problems.map(p=>p.rule+'：'+p.message).join('；'),fix:problems.map(p=>p.fix).join('；')};return {ok:false,checks};};
    let staged:StagedTree|null=null;
    try{
      if(!await this.#options.records.authorizations.canPublish(by.id))return reject([problem('publish.no_right','.','没有发布权','由管理员在团队页授予发布权')]);
      checks[phase++].state='pass';
      const info=await this.resolve(by,by.id,ref);if(!info)throw new AccessError('对象不存在或无权读取');const opened=await this.open(by.id,info.digest);if(!opened)throw new IntegrityError('个人包暂不可读');
      const read=await readPackDirectory(opened.handle.directory,{limits:this.#options.limits});if(!read.ok)return reject(read.problems);
      const validated=await validatePack(read.pack,{policy:this.#options.policy,deferCredentials:true});if(!validated.ok)return reject(validated.problems);
      checks[phase++].state='pass';
      if(needsSandbox(validated.pack)){const stage=()=>this.#extractor.stage(info.digest,read.pack!.manifestBytes,read.pack!.files.map(file=>({path:file.path,bytes:file.bytes})));staged=await (this.#options.records.personalPayloads?this.#options.records.personalPayloads.stage(by.id,info.digest,stage):stage());}
      const report=await runPublishCheck({pack:validated.pack,packDir:staged?.directory??null,sandbox:this.#options.sandbox,onError:this.#options.onError});const errors=refusalsOf(report,validated.pack);if(errors.length)return reject(errors);
      checks[phase++].state='pass';
      if(info.manifest.dependencies?.some(dep=>dep.space))return reject([problem('personal.dependency','pack.json','团队发布不能依赖个人空间中的技能','先将依赖发布到团队并更新个人版本')]);
      const team=await this.#team.check(by,opened.handle.directory,{deferCredentials:true});if(!team.ok)return reject(team.problems);
      checks[phase++].state='pass';const credentials=credentialProblems(read.pack);if(credentials.length)return reject(credentials);
      by=await this.#own(by);checks[phase].state='pass';return {ok:true,checks};
    }catch(error){if(error instanceof AccessError)throw error;checks[phase]={...checks[phase],state:'incomplete',message:'发布内容或检查暂不可用',fix:'恢复读取条件后重新预检'};return {ok:false,checks};}finally{await staged?.discard();}
  }
  async precheckGrant(by:Principal,pack:string,targets?:readonly Principal[]){
    by=await this.#own(by);const checks:SharingCheck[]=ShareCheckSchema.extract(['credentials','dependencies']).options.map(check=>({check,state:'unchecked',code:null,message:'',fix:''}));let phase=0;
    try{
      const versions=await this.versions(by.id,pack);if(!versions.length)throw new AccessError('对象不存在或无权读取');
      for(const version of versions){const opened=await this.open(by.id,version.digest);if(!opened)throw new IntegrityError('包文件暂不可读');for(const file of version.manifest.files){const scan=scanForCredentials(await readFile(join(opened.handle.directory,file.path)));if(!scan.inspected||scan.truncated||scan.findings.length){checks[phase]={...checks[phase],state:'violation',message:'包文件可能含有凭据',fix:'移除凭据并发布修订版本'};return checks;}}}
      checks[phase++].state='pass';
      for(const version of versions){const problems=await this.#dependencyProblems(by,version.manifest.dependencies??[],true,targets);if(problems.length){checks[phase]={...checks[phase],state:problems[0].rule==='personal.grantee'?'unchecked':'violation',message:problems[0].message,fix:problems[0].fix};return checks;}}
      checks[phase].state='pass';return checks;
    }catch(error){if(error instanceof AccessError)throw error;checks[phase]={...checks[phase],state:'incomplete',message:'包文件暂不可读',fix:'恢复读取后重试'};return checks;}
  }
  async promote(by:Principal,ref:string):Promise<PublishOutcome>{
    by=await this.#own(by);return this.#options.records.store.withTransaction(async tx=>{by=await this.#options.records.principals.lockActive(by,tx);const info=await this.resolve(by,by.id,ref);if(!info)throw new AccessError('对象不存在或无权读取');const opened=await this.open(by.id,info.digest);if(!opened)throw new IntegrityError('个人包文件暂不可读');
    if(info.manifest.dependencies?.some(dep=>dep.space))return {ok:false,report:null,problems:[problem('personal.dependency','pack.json','团队发布不能依赖个人空间中的技能','先将依赖发布并安装到团队，修改依赖后重新发布')]};
    const outcome=await this.#team.publish(by,opened.handle.directory);if(!outcome.ok)return outcome;
    await this.#options.records.store.put({kind:'personal_pack_transfer',schema:'personal-pack-transfer@1',provenance:'declared',body:PersonalPackTransferBody.parse({space:by.id,pack:info.id,version:info.version,digest:info.digest,source:info.record,target:outcome.version.record,by:by.id,at:this.#now()}),index:[{key:'personal.pack.transferred',value:info.digest}]},tx);return outcome;});
  }
  async transferred(digest:string){return (await this.#options.records.store.find({kind:'personal_pack_transfer',key:'personal.pack.transferred',value:digest,limit:1})).items.length>0;}
  async source(by:Principal,sha256:string,runId?:string,capture?:string){
    const artifacts=this.#options.records.artifacts;if(!artifacts)return null;
    const records=await this.#options.records.store.findMany({kind:'personal_pack_version',key:'personal.pack.file',values:[sha256]});
    for(const record of records){const body=PersonalPackVersionBody.parse(record.body);if(!await this.mayUse(by,body.space,body.pack))continue;if(runId){const run=(await this.#options.records.store.find<any>({kind:'run',key:'runs.id',value:runId,limit:1})).items[0]?.body;const owner=run?.runner?await this.#options.records.principals.get(run.runner):null;if(!owner||owner.disabled||!await this.mayUse(owner,body.space,body.pack)||!(run.pack_space===body.space&&run.pack_digest===body.digest||(run.skills??[]).some((skill:any)=>skill.space===body.space&&skill.digest===body.digest)))continue;}const owner=await this.#options.records.principals.get(body.space);if(!owner||owner.disabled)continue;const file=body.manifest.files.find(file=>file.sha256===sha256&&(!capture||body.files[file.path]===capture));const artifact=file?body.files[file.path]:undefined;if(artifact){const source=await artifacts.source(owner,sha256,{record:artifact,consumer:'model'});return await this.mayUse(by,body.space,body.pack)?source:null;}}
    return null;
  }
  async mayReadSource(by:Principal,sha256:string,runId?:string,capture?:string){
    const artifacts=this.#options.records.artifacts;if(!artifacts)return false;
    const records=await this.#options.records.store.findMany({kind:'personal_pack_version',key:'personal.pack.file',values:[sha256]});
    for(const record of records){const body=PersonalPackVersionBody.parse(record.body);if(!await this.mayUse(by,body.space,body.pack))continue;if(runId){const run=(await this.#options.records.store.find<any>({kind:'run',key:'runs.id',value:runId,limit:1})).items[0]?.body;const owner=run?.runner?await this.#options.records.principals.get(run.runner):null;if(!owner||owner.disabled||!await this.mayUse(owner,body.space,body.pack)||!(run.pack_space===body.space&&run.pack_digest===body.digest||(run.skills??[]).some((skill:any)=>skill.space===body.space&&skill.digest===body.digest)))continue;}const owner=await this.#options.records.principals.get(body.space);if(!owner||owner.disabled)continue;const file=body.manifest.files.find(file=>file.sha256===sha256&&(!capture||body.files[file.path]===capture));const artifact=file?body.files[file.path]:undefined;if(artifact){const source=await this.#options.records.store.get<import('../../records/api.ts').SourceArtifactBody>(artifact);if(source?.kind==='source_artifact'&&source.body.sha256===sha256&&await artifacts.canRead(owner,source))return true;}}
    return false;
  }
  async hasSource(sha256:string){return (await this.#options.records.store.find({kind:'personal_pack_version',key:'personal.pack.file',value:sha256,limit:1})).items.length>0;}
}
