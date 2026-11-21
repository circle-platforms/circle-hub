import { z } from 'zod';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { PackManifest } from '../../contracts/src/pack.ts';
import { RecordKindSchema } from '../../contracts/src/records.ts';
import { Sha256, RecordId, UserId, TeamId, SchemaId } from '../../contracts/src/common.ts';
import { ProvenanceTypeSchema, PermissionKindSchema, SyncModeSchema } from '../../contracts/generated/vocabulary.ts';
import type { RecordsConfig, Transaction } from './api.ts';
import { Database,iso } from './db.ts';
import type { Row } from './db.ts';
import { PgRecordStore,verifiedRecord } from './store.ts';
import { FileObjectStore } from './objects.ts';
import { isPersonalPackRecord } from './personal-payloads.ts';
import { envelopeDigest,sha256Hex } from './digest.ts';
import { canonicalize,canonicalBytes } from './canonical.ts';
import { parseStrictJson } from './strict-json.ts';
import { IntegrityError,RecordsError } from './errors.ts';
import type { ConfigurationClosure,ConfigurationRow,ConfigurationRecord,ConfigurationObject,ConfigurationPackage } from './configuration-snapshot-types.ts';

function requiredConfigurationPackageObjects(packages:readonly ConfigurationPackage[]):string[]{
  return [...new Set(packages.flatMap(pack=>[pack.digest,...pack.manifest.files.map(file=>file.sha256)]))].sort();
}
function validateConfigurationPackageObjects(packages:readonly ConfigurationPackage[],objects:readonly ConfigurationObject[]):void{
  const stored=new Map(objects.map(object=>[object.sha256,object]));
  for(const pack of packages){
    const canonical=canonicalBytes(pack.manifest),manifest=stored.get(pack.digest);
    if(pack.pack!==pack.manifest.id||pack.version!==pack.manifest.version||sha256Hex(canonical)!==pack.digest||!manifest||!Buffer.from(manifest.bytes_base64,'base64').equals(Buffer.from(canonical)))throw new IntegrityError('包清单的原始字节与发布摘要不符');
    for(const file of pack.manifest.files){const object=stored.get(file.sha256);if(!object||sha256Hex(Buffer.from(object.bytes_base64,'base64'))!==file.sha256)throw new IntegrityError('包清单所需的文件原件不完整');}
  }
}

const decimal=z.string().regex(/^[1-9][0-9]*$/),time=z.string().min(1),uuid=z.uuid();
const rawRecord=z.strictObject({seq:decimal,id:RecordId,digest:Sha256,kind:RecordKindSchema,schema:SchemaId,provenance:ProvenanceTypeSchema,created_at:time,body:z.string(),size:z.number().int().nonnegative()});
const object=z.strictObject({sha256:Sha256,size:z.number().int().nonnegative(),media_type:z.string(),created_at:time,bytes_base64:z.string(),public:z.boolean()});
const Team=z.strictObject({id:TeamId,name:z.string(),created_at:time,created_by:UserId,deleted_at:time.nullable()});
const Member=z.strictObject({team_id:TeamId,user_id:UserId,added_at:time,added_by:UserId});
const Pointer=z.strictObject({name:z.string().regex(/^doc:[a-z][a-z0-9-]{0,63}$/),target:Sha256,version:decimal,moved_at:time,action_digest:Sha256});
const Reservation=z.strictObject({prefix:z.string().min(1),owner:UserId,registered_at:time});
const Hold=z.strictObject({record:Sha256,sha256:Sha256,artifact:z.boolean(),members:z.boolean()});
const Personal=z.strictObject({
  personal_spaces:z.array(z.strictObject({owner:UserId,epoch:uuid,mode:SyncModeSchema,account_epoch:uuid.nullable()})),
  personal_payloads:z.array(z.strictObject({owner:UserId,epoch:uuid,sha256:Sha256,data:z.string().regex(/^\\x(?:[0-9a-f]{2})*$/)})),
  personal_record_bindings:z.array(z.strictObject({record:Sha256,owner:UserId,epoch:uuid,sha256:Sha256,bytes:decimal,marker:z.string(),proof:Sha256})),
  personal_objects:z.array(z.strictObject({owner:UserId,epoch:uuid,sha256:Sha256})),
  personal_purges:z.array(z.strictObject({owner:UserId,epoch:uuid,at:time})),
});
const Closure=z.object({records:z.array(rawRecord),indexes:z.array(z.strictObject({key:z.string(),value:z.string(),digest:Sha256,record_seq:decimal})),keys:z.array(z.strictObject({kind:RecordKindSchema,key:z.string(),digest:Sha256})),objects:z.array(object),packages:z.array(z.strictObject({record:Sha256,pack:z.string(),version:z.string(),digest:Sha256,manifest:PackManifest})),teams:z.array(Team),team_members:z.array(Member),pointers:z.array(Pointer),lease_registrations:z.array(Reservation),object_holds:z.array(Hold),personal:Personal});
const docPointer=/^doc:([a-z][a-z0-9-]{0,63})$/;
const docOrigin=/^doc:doc:([a-z][a-z0-9-]{0,63})@([0-9a-f]{64})$/;
const fields='r.seq::text,r.id,r.digest,r.kind,r.schema,r.provenance,r.created_at,r.body,r.size';
function fail(message:string):never { throw new IntegrityError(message); }
const jsonObject=(input:unknown):input is Record<string,unknown>=>typeof input==='object'&&input!==null&&!Array.isArray(input);
function unique<T>(rows:readonly T[],key:(row:T)=>string):void {
  const values=rows.map(key);if(new Set(values).size!==values.length)fail('配置快照存在重复的身份或索引，不能恢复');
}
function bodyOf(record:ConfigurationRecord,state:z.infer<typeof Closure>):Record<string,unknown> {
  const binding=state.personal.personal_record_bindings.find(row=>row.record===record.digest);
  let text=record.body;
  if(binding){
    const payload=state.personal.personal_payloads.find(row=>row.owner===binding.owner&&row.epoch===binding.epoch&&row.sha256===binding.sha256);
    if(!payload)fail('配置快照缺少个人配置的原正文，不能恢复');
    const bytes=Buffer.from(payload.data.slice(2),'hex');
    const proof=sha256Hex([record.digest,binding.sha256,binding.owner,binding.epoch,binding.bytes,record.created_at,record.kind,record.provenance,record.schema].join(':'));
    if(binding.marker!==record.body||proof!==binding.proof||bytes.length!==Number(binding.bytes)||sha256Hex(bytes)!==binding.sha256)fail('个人配置的摘要链不完整，不能恢复');
    text=bytes.toString('utf8');
    if(envelopeDigest({kind:record.kind,schema:record.schema,provenance:record.provenance,created_at:record.created_at},text)!==record.digest)fail('个人配置正文与原记录摘要不符');
  }else verifiedRecord({...record});
  const body=parseStrictJson(text);if(!jsonObject(body))fail('配置记录正文不是当前支持的对象结构');return body;
}

export function validateConfigurationClosure(input:unknown):ConfigurationClosure {
  const checked=Closure.safeParse(input);if(!checked.success)throw new RecordsError('配置快照闭包字段不完整或不是当前结构；请重新导出');
  const state=checked.data,records=new Map(state.records.map(row=>[row.digest,row])),objects=new Map(state.objects.map(row=>[row.sha256,row]));
  unique(state.records,row=>row.digest);unique(state.records,row=>row.id);unique(state.records,row=>row.seq);
  unique(state.objects,row=>row.sha256);
  unique(state.indexes,row=>JSON.stringify([row.key,row.value,row.digest]));
  unique(state.keys,row=>JSON.stringify([row.kind,row.key]));
  for(const item of state.objects){const bytes=Buffer.from(item.bytes_base64,'base64');if(bytes.toString('base64')!==item.bytes_base64||bytes.length!==item.size||sha256Hex(bytes)!==item.sha256)fail('配置原件的字节、大小或摘要不符');}
  const bodies=new Map(state.records.map(row=>[row.digest,bodyOf(row,state)]));
  for(const row of state.records){
    const body=bodies.get(row.digest)!;
    const permitted=row.kind==='authorization'||row.kind==='pack_version'||row.kind==='token_issuance'||isPersonalPackRecord(row.kind)||row.kind==='source_artifact'||row.kind==='action';
    if(!permitted)fail('配置快照夹带未声明的记录种类，不能恢复');
    if(row.kind==='authorization'){
      if(!PermissionKindSchema.safeParse(body.permission).success||body.permission==='share')fail('配置快照夹带运行或知识分享决定，不能恢复');
      if(body.bound!==null&&(!Sha256.safeParse(body.bound).success||!objects.has(String(body.bound))))fail('配置授权缺少它绑定的定义原件');
      if(typeof body.supersedes==='string'&&!records.has(body.supersedes))fail('配置授权的决定链不完整');
    }
    if(row.kind==='source_artifact'&&(!jsonObject(body.origin)||!jsonObject(body.origin.read)||typeof body.origin.read.object!=='string'||!docOrigin.test(body.origin.read.object))&&!state.object_holds.some(hold=>hold.artifact&&hold.sha256===row.digest)&&!state.packages.some(pack=>{const packBody=bodies.get(pack.record);return !!packBody&&jsonObject(packBody.files)&&Object.values(packBody.files).includes(row.digest);}))fail('配置快照含有不属于命名文档或包文件的原件记录');
    if(row.kind==='source_artifact'&&(!Sha256.safeParse(body.sha256).success||!objects.has(String(body.sha256))))fail('配置原件记录缺少原始字节');
    if(row.kind==='action'&&(!jsonObject(body.detail)||typeof body.detail.pointer!=='string'||!docPointer.test(body.detail.pointer)||body.run!==null))fail('配置快照夹带运行历史，不能恢复');
  }
  for(const row of state.indexes)if(!records.has(row.digest)||records.get(row.digest)!.seq!==row.record_seq)fail('配置索引没有对应的原记录与位置');
  for(const row of state.keys)if(records.get(row.digest)?.kind!==row.kind)fail('配置唯一键没有对应的原记录');
  unique(state.packages,row=>row.record);
  const packRecords=state.records.filter(row=>row.kind==='pack_version'||row.kind==='personal_pack_version');
  if(packRecords.length!==state.packages.length||packRecords.some(row=>!state.packages.some(pack=>pack.record===row.digest)))fail('配置包记录缺少清单闭包');
  for(const pack of state.packages){
    const body=bodies.get(pack.record);
    if(!body||body.digest!==pack.digest||body.pack!==pack.pack||body.version!==pack.version||body.kind!==pack.manifest.kind||canonicalize(body.manifest)!==canonicalize(pack.manifest))fail('包的原始记录与清单不一致');
    if(records.get(pack.record)!.kind==='personal_pack_version'){
      if(!jsonObject(body.files))fail('私人包缺少文件原件绑定');
      for(const file of pack.manifest.files){const artifact=body.files[file.path];if(typeof artifact!=='string'||bodies.get(artifact)?.sha256!==file.sha256)fail('私人包文件与原件绑定不一致');}
    }
  }
  validateConfigurationPackageObjects(state.packages,state.objects);
  for(const pointer of state.pointers){if(!records.has(String(pointer.action_digest))||!objects.has(String(pointer.target)))fail('命名文档缺少指针动作或原文字节');}
  for(const hold of state.object_holds)if(!records.has(String(hold.record))||(hold.artifact?!records.has(String(hold.sha256)):!objects.has(String(hold.sha256))))fail('配置持有关系闭包不完整');
  for(const payload of state.personal.personal_payloads)if(sha256Hex(Buffer.from(String(payload.data).slice(2),'hex'))!==payload.sha256)fail('个人配置负载摘要不符');
  for(const object of state.objects)if(!object.public&&!state.personal.personal_objects.some(row=>row.sha256===object.sha256))fail('个人配置原件缺少原来的存储范围');
  return state;
}

export async function captureConfigurationClosure(config:RecordsConfig,db:Database,tx:Transaction):Promise<ConfigurationClosure> {
  const store=new PgRecordStore(db,{maxRecordBytes:config.limits.maxRecordBytes,now:()=>new Date()});
  const objects=new FileObjectStore(join(config.dataDir,'objects'),db,{maxBytes:config.limits.maxUploadBytes,now:()=>new Date(),personalPayloads:store.personalPayloads});
  const selected=new Map<string,ConfigurationRecord>(),bodies=new Map<string,Record<string,unknown>>(),needed=new Set<string>();
  const packages:ConfigurationPackage[]=[];
  const add=async(row:Row):Promise<void>=>{
    const digest=String(row.digest);if(selected.has(digest))return;
    const verified=await store.get(digest,tx);if(!verified||!jsonObject(verified.body))fail('配置记录没有完整可核对的正文');
    const physical=(await db.query(`SELECT ${fields} FROM public.records r WHERE digest=$1`,[digest],tx)).rows[0];if(!physical)fail('配置记录原始行缺失');
    const record:ConfigurationRecord={seq:String(physical.seq),id:String(physical.id),digest,kind:verified.kind,schema:verified.schema,provenance:verified.provenance,created_at:iso(physical.created_at),body:String(physical.body),size:Number(physical.size)};
    selected.set(digest,record);bodies.set(digest,verified.body);
  };
  const kinds=RecordKindSchema.options.filter(kind=>kind==='authorization'||kind==='pack_version'||kind==='token_issuance'||isPersonalPackRecord(kind));
  for(const row of (await db.query(`SELECT ${fields} FROM public.hub_read_records() r WHERE r.kind=ANY($1::text[]) AND NOT EXISTS(SELECT 1 FROM public.personal_record_bindings b JOIN public.personal_purges p ON (p.owner,p.epoch)=(b.owner,b.epoch) WHERE b.record=r.digest) ORDER BY r.seq`,[kinds],tx)).rows){
    if(row.kind==='authorization'){const verified=await store.get(String(row.digest),tx);if(!verified||!jsonObject(verified.body))fail('配置授权记录不可核对');if(verified.body.permission==='share')continue;}
    await add(row);
  }
  const pointers=(await db.query<{state:ConfigurationRow}>("SELECT to_jsonb(p)||jsonb_build_object('version',p.version::text) AS state FROM public.pointers p WHERE name ~ '^doc:[a-z][a-z0-9-]{0,63}$' ORDER BY name",[],tx)).rows.map(row=>row.state);
  const pointerNames=pointers.map(row=>String(row.name));
  if(pointerNames.length)for(const row of (await db.query(`SELECT DISTINCT ${fields} FROM public.record_index i JOIN public.hub_read_records() r ON r.digest=i.digest WHERE i.key='pointer.name' AND i.value=ANY($1::text[]) AND r.kind='action'`,[pointerNames],tx)).rows)await add(row);
  for(const pointer of pointers){
    if(!selected.has(String(pointer.action_digest))){const row=(await db.query(`SELECT ${fields} FROM public.records r WHERE digest=$1`,[pointer.action_digest],tx)).rows[0];if(!row)fail('命名文档指针动作缺失');await add(row);}
  }
  const docs=new Map<string,string>();
  for(const pointer of pointers)docs.set(`doc:doc:${String(pointer.name).slice(4)}@${pointer.target}`,String(pointer.target));
  for(const body of bodies.values())if(jsonObject(body.detail)&&typeof body.detail.pointer==='string'&&docPointer.test(body.detail.pointer)&&Sha256.safeParse(body.detail.next).success)docs.set(`doc:doc:${body.detail.pointer.slice(4)}@${body.detail.next}`,String(body.detail.next));
  const foundDocs=new Set<string>();
  if(docs.size)for(const row of (await db.query(`SELECT DISTINCT ${fields} FROM public.record_index i JOIN public.hub_read_records() r ON r.digest=i.digest WHERE i.key='artifact.sha256' AND i.value=ANY($1::text[]) AND r.kind='source_artifact'`,[[...new Set(docs.values())]],tx)).rows){const verified=await store.get(String(row.digest),tx),body=verified?.body;if(jsonObject(body)&&jsonObject(body.origin)&&jsonObject(body.origin.read)&&typeof body.origin.read.object==='string'&&docs.has(body.origin.read.object)){await add(row);foundDocs.add(body.origin.read.object);}}
  if([...docs.keys()].some(origin=>!foundDocs.has(origin)))fail('命名文档缺少对应的原件记录，不能完整导出');
  for(const [digest,body]of [...bodies]){
    const record=selected.get(digest)!;
    if(record.kind==='authorization'&&body.bound!==null){if(!Sha256.safeParse(body.bound).success)fail('配置定义摘要不完整');needed.add(String(body.bound));}
    if(record.kind==='pack_version'||isPersonalPackRecord(record.kind)&&record.kind==='personal_pack_version'){
      const manifest=PackManifest.safeParse(body.manifest);if(!manifest.success||typeof body.digest!=='string'||body.pack!==manifest.data.id||body.version!==manifest.data.version||body.kind!==manifest.data.kind)fail('已发布包的清单不符合当前结构');
      packages.push({record:digest,pack:manifest.data.id,version:manifest.data.version,digest:body.digest,manifest:manifest.data});
      if(jsonObject(body.files))for(const artifact of Object.values(body.files)){if(!Sha256.safeParse(artifact).success)fail('私人包文件原件引用不完整');const row=(await db.query(`SELECT ${fields} FROM public.records r WHERE digest=$1`,[artifact],tx)).rows[0];if(!row)fail('私人包文件原件记录缺失');await add(row);}
    }
  }
  for(const digest of requiredConfigurationPackageObjects(packages))needed.add(digest);
  const holds:ConfigurationRow[]=[];const expanded=new Set<string>();
  for(;;){const fresh=[...selected.keys()].filter(digest=>!expanded.has(digest));if(!fresh.length)break;fresh.forEach(digest=>expanded.add(digest));
    for(const row of (await db.query<{state:ConfigurationRow}>('SELECT to_jsonb(h) AS state FROM public.object_holds h WHERE record=ANY($1::text[]) ORDER BY record,sha256',[fresh],tx)).rows){holds.push(row.state);if(row.state.artifact){const target=(await db.query(`SELECT ${fields} FROM public.records r WHERE digest=$1`,[row.state.sha256],tx)).rows[0];if(!target)fail('配置持有的原件记录缺失');await add(target);}else needed.add(String(row.state.sha256));}
  }
  for(const [digest,body]of bodies)if(selected.get(digest)!.kind==='source_artifact'){if(!Sha256.safeParse(body.sha256).success)fail('配置原件的字节摘要不完整');needed.add(String(body.sha256));}
  const objectRows:ConfigurationObject[]=[];
  for(const digest of [...needed].sort()){
    const row=(await db.query<{sha256:string;size:string;media_type:string;created_at:string}>('SELECT sha256,size::text,media_type,created_at::text FROM public.objects WHERE sha256=$1',[digest],tx)).rows[0];
    let independent=false;try{const file=await lstat(objects.path(digest));if(!file.isFile()||file.isSymbolicLink())fail('配置原件不是普通文件');independent=true;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const bytes=await objects.get(digest,tx);if(!row||!bytes||sha256Hex(bytes)!==digest||bytes.length!==Number(row.size))fail('配置原件缺失、大小不符或摘要不符');
    objectRows.push({...row,size:Number(row.size),bytes_base64:Buffer.from(bytes).toString('base64'),public:independent});
  }
  const digests=[...selected.keys()];
  const indexes=(await db.query<{key:string;value:string;digest:string;record_seq:string}>('SELECT key,value,digest,record_seq::text FROM public.record_index WHERE digest=ANY($1::text[]) ORDER BY record_seq,key,value',[digests],tx)).rows;
  const keys=(await db.query<{kind:ConfigurationClosure['keys'][number]['kind'];key:string;digest:string}>('SELECT kind,key,digest FROM public.record_keys WHERE digest=ANY($1::text[]) ORDER BY kind,key',[digests],tx)).rows;
  const rows=async(table:string,where:string,parameters:unknown[],extra='')=>(await db.query<{state:ConfigurationRow}>(`SELECT to_jsonb(t)${extra} AS state FROM public.${table} t ${where}`,parameters,tx)).rows.map(row=>row.state);
  const bindings=await rows('personal_record_bindings','WHERE record=ANY($1::text[])',[digests],"||jsonb_build_object('bytes',t.bytes::text)");
  const scopes=bindings.map(row=>[String(row.owner),String(row.epoch)]),privateObjectRows=await rows('personal_objects','WHERE sha256=ANY($1::text[])',[objectRows.filter(row=>!row.public).map(row=>row.sha256)]);
  for(const row of privateObjectRows)if(!scopes.some(([owner,epoch])=>owner===row.owner&&epoch===row.epoch))scopes.push([String(row.owner),String(row.epoch)]);
  const owners=[...new Set(scopes.map(([owner])=>owner))];
  const payloadShas=[...new Set([...bindings.map(row=>String(row.sha256)),...privateObjectRows.map(row=>String(row.sha256))])];
  const personal={personal_spaces:await rows('personal_spaces','WHERE owner=ANY($1::text[])',[owners]),personal_payloads:(await rows('personal_payloads','WHERE owner=ANY($1::text[]) AND sha256=ANY($2::text[])',[owners,payloadShas])).filter(row=>scopes.some(([owner,epoch])=>owner===row.owner&&epoch===row.epoch)),personal_record_bindings:bindings,personal_objects:privateObjectRows,personal_purges:(await rows('personal_purges','WHERE owner=ANY($1::text[])',[owners])).filter(row=>scopes.some(([owner,epoch])=>owner===row.owner&&epoch===row.epoch))};
  return validateConfigurationClosure({records:[...selected.values()],indexes,keys,objects:objectRows,packages,teams:await rows('teams','ORDER BY id',[]),team_members:await rows('team_members','ORDER BY team_id,user_id',[]),pointers,lease_registrations:await rows('lease_registrations','ORDER BY prefix',[]),object_holds:holds,personal});
}
