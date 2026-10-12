import {ApiError,canonicalHash,newId,requireCondition,sha256,type AuthContext,type ObjectObservation,type RelationObservation,type Policy} from '../../contracts/src/index.ts';
import type {Store,Transaction} from '../../storage/src/index.ts';
import type {Auth} from '../../tasks/src/auth.ts';
import type {Knowledge} from './index.ts';
import type {TypeCatalog} from './type-catalog.ts';

const aclSql=(observation:string)=>`(${observation}.source_readers ? $3 OR ${observation}.source_readers ? '*') AND (${observation}.platform_readers ? $3 OR ${observation}.platform_readers ? '*')`;
const visibleSql=(entity:string,observation:string)=>`${entity}.tenant_id=$1 AND ${entity}.scope_id=ANY($2::text[]) AND ${aclSql(observation)}`;
const entityJoin='entities e JOIN entity_observations o ON o.entity_revision_id=e.current_revision_id JOIN sources s ON s.source_revision_id=o.source_revision_id';
const entityColumns='e.*,o.*,s.sha256,s.size,s.file_name';

export class Entities {
  store:Store;auth:Auth;knowledge:Knowledge;types:TypeCatalog;
  constructor(store:Store,auth:Auth,knowledge:Knowledge,types:TypeCatalog){this.store=store;this.auth=auth;this.knowledge=knowledge;this.types=types;}
  notVisible():never{throw new ApiError('OBJECT_NOT_VISIBLE','Object is not visible to the authenticated principal');}
  parameters(policy:Policy):[string,string[],string]{return [policy.tenantId,policy.scopes,policy.principalId];}
  view(row:any):any{
    return {entityId:row.entity_id,entityRevisionId:row.entity_revision_id,scopeId:row.scope_id,
      type:{packageId:row.type_package_id,version:row.type_package_version,typeId:row.type_id},
      source:{system:row.source_system,objectType:row.source_type,externalId:row.external_id,revision:row.source_revision},attributes:row.attributes,
      provenance:{observationKey:row.observation_key,observedAt:row.observed_at.toISOString(),observerId:row.observer_id,origin:row.origin,
        raw:this.knowledge.sourceReference(row)}};
  }
  observationView(row:any):any{return {...this.view(row),observationKey:row.observation_key,raw:this.knowledge.sourceReference(row)};}
  async original(tx:Transaction,ctx:AuthContext,scope:string,input:ObjectObservation['source'],key:string):Promise<any>{
    const bytes=Buffer.from(input.contentBase64,'base64');
    requireCondition(!input.sha256||input.sha256===sha256(bytes),'SOURCE_HASH_MISMATCH','Observed original bytes differ from their declared SHA');
    return this.knowledge.upload(ctx,scope,`observation-${canonicalHash(key).slice(0,16)}.bin`,bytes,tx);
  }
  async observe(ctx:AuthContext,input:ObjectObservation):Promise<any>{
    return this.store.transaction(async tx=>{
      const policy=await this.auth.check(ctx,'objects.ingest',input.scopeId,tx);
      await this.types.validate(policy.tenantId,input.type,input.attributes,tx);
      const identity=[policy.tenantId,input.scopeId,input.source.system,input.source.objectType,input.source.externalId];
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(identity)]);
      let entity=(await tx.query('SELECT * FROM entities WHERE tenant_id=$1 AND scope_id=$2 AND source_system=$3 AND source_type=$4 AND external_id=$5',identity)).rows[0];
      const hash=canonicalHash(input);
      if(entity){
        const old=(await tx.query('SELECT request_hash FROM entity_observations WHERE entity_id=$1 AND observation_key=$2',[entity.entity_id,input.observationKey])).rows[0];
        if(old){
          requireCondition(old.request_hash===hash,'IDEMPOTENCY_MISMATCH','Observation key was reused with different content');
          const observed=(await tx.query(`SELECT ${entityColumns} FROM entities e JOIN entity_observations o USING(entity_id) JOIN sources s USING(source_revision_id) WHERE e.entity_id=$1 AND o.observation_key=$2`,[entity.entity_id,input.observationKey])).rows[0];
          const head=(await tx.query(`SELECT ${entityColumns} FROM ${entityJoin} WHERE e.entity_id=$1`,[entity.entity_id])).rows[0];
          return {entity:this.view(head),observation:this.observationView(observed),deduplicated:true};
        }
      }else{
        entity=(await tx.query(`INSERT INTO entities(entity_id,tenant_id,scope_id,source_system,source_type,external_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[newId('ent'),...identity])).rows[0];
      }
      const raw=await this.original(tx,ctx,input.scopeId,input.source,input.observationKey),revision=newId('erev');
      await tx.query(`INSERT INTO entity_observations(entity_revision_id,entity_id,observation_key,request_hash,type_package_id,type_package_version,type_id,
        source_revision,source_revision_id,attributes,source_readers,platform_readers,observer_id,origin)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'manual-observation')`,
        [revision,entity.entity_id,input.observationKey,hash,input.type.packageId,input.type.version,input.type.typeId,input.source.revision,raw.sourceRevisionId,
          JSON.stringify(input.attributes),JSON.stringify(input.acl.sourceReaders),JSON.stringify(input.acl.platformReaders),policy.principalId]);
      await tx.query('UPDATE entities SET current_revision_id=$2 WHERE entity_id=$1',[entity.entity_id,revision]);
      await this.auth.audit(ctx,'objects.observe',{entityId:entity.entity_id,entityRevisionId:revision,sha256:raw.sha256},input.scopeId,tx);
      const row=(await tx.query(`SELECT ${entityColumns} FROM ${entityJoin} WHERE e.entity_id=$1`,[entity.entity_id])).rows[0];
      return {entity:this.view(row),observation:this.observationView(row),deduplicated:false};
    });
  }
  async get(ctx:AuthContext,id:string):Promise<any>{
    const policy=await this.auth.check(ctx,'objects.read');
    const row=(await this.store.pool.query(`SELECT ${entityColumns} FROM ${entityJoin} WHERE ${visibleSql('e','o')} AND e.entity_id=$4`,[...this.parameters(policy),id])).rows[0];
    if(!row)this.notVisible();return this.view(row);
  }
  async list(ctx:AuthContext,query:{limit:number;after?:string;typeId?:string;system?:string}):Promise<any>{
    return this.store.transaction(async tx=>{
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const policy=await this.auth.check(ctx,'objects.read',undefined,tx);
      const filter=`${visibleSql('e','o')} AND ($4::text IS NULL OR o.type_id=$4) AND ($5::text IS NULL OR e.source_system=$5)`;
      const parameters=[...this.parameters(policy),query.typeId??null,query.system??null];
      const total=Number((await tx.query(`SELECT count(*) AS count FROM ${entityJoin} WHERE ${filter}`,parameters)).rows[0].count);
      const rows=(await tx.query(`SELECT ${entityColumns} FROM ${entityJoin} WHERE ${filter} AND ($6::text IS NULL OR e.entity_id<$6) ORDER BY e.entity_id DESC LIMIT $7`,[...parameters,query.after??null,query.limit+1])).rows;
      const items=rows.slice(0,query.limit).map(row=>this.view(row));return {items,total,nextCursor:rows.length>query.limit?items.at(-1).entityId:null};
    });
  }
  async observations(ctx:AuthContext,id:string):Promise<any[]>{
    const policy=await this.auth.check(ctx,'objects.read');
    const rows=(await this.store.pool.query(`SELECT e.*,history.*,s.sha256,s.size,s.file_name FROM entities e
      JOIN entity_observations o ON o.entity_revision_id=e.current_revision_id JOIN entity_observations history ON history.entity_id=e.entity_id
      JOIN sources s ON s.source_revision_id=history.source_revision_id WHERE ${visibleSql('e','o')} AND ${aclSql('history')} AND e.entity_id=$4
      ORDER BY history.observed_at DESC,history.entity_revision_id DESC`,[...this.parameters(policy),id])).rows;
    if(!rows.length)this.notVisible();return rows.map(row=>this.observationView(row));
  }
  async link(ctx:AuthContext,input:RelationObservation):Promise<any>{
    return this.store.transaction(async tx=>{
      const policy=await this.auth.check(ctx,'objects.ingest',input.scopeId,tx);
      for(const id of [input.fromEntityId,input.toEntityId]){
        const entity=(await tx.query('SELECT tenant_id,scope_id FROM entities WHERE entity_id=$1',[id])).rows[0];
        requireCondition(entity,'TARGET_NOT_FOUND','Relation endpoint is not registered');
        requireCondition(entity.tenant_id===policy.tenantId,'FORBIDDEN_SCOPE','Relation endpoints must belong to the authenticated tenant');
        await this.auth.check(ctx,'objects.ingest',entity.scope_id,tx);
      }
      const identity=[policy.tenantId,input.scopeId,input.source.system,input.source.objectType,input.source.externalId];
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['relation',...identity])]);
      let relation=(await tx.query('SELECT * FROM entity_relations WHERE tenant_id=$1 AND scope_id=$2 AND source_system=$3 AND source_type=$4 AND external_id=$5',identity)).rows[0];
      const hash=canonicalHash(input);
      if(relation){
        requireCondition(relation.from_entity_id===input.fromEntityId&&relation.to_entity_id===input.toEntityId&&relation.type===input.type,'IDEMPOTENCY_MISMATCH','A relation source identity cannot be reassigned to different endpoints');
        const old=(await tx.query('SELECT request_hash FROM relation_observations WHERE relation_id=$1 AND observation_key=$2',[relation.relation_id,input.observationKey])).rows[0];
        if(old){requireCondition(old.request_hash===hash,'IDEMPOTENCY_MISMATCH','Relation observation key differs');return {relationId:relation.relation_id,deduplicated:true};}
      }else{
        relation=(await tx.query(`INSERT INTO entity_relations(relation_id,tenant_id,scope_id,type,from_entity_id,to_entity_id,source_system,source_type,external_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[newId('rel'),policy.tenantId,input.scopeId,input.type,input.fromEntityId,input.toEntityId,input.source.system,input.source.objectType,input.source.externalId])).rows[0];
      }
      const raw=await this.original(tx,ctx,input.scopeId,input.source,input.observationKey),revision=newId('rrev');
      await tx.query(`INSERT INTO relation_observations(relation_revision_id,relation_id,observation_key,request_hash,source_revision,source_revision_id,source_readers,platform_readers,observer_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[revision,relation.relation_id,input.observationKey,hash,input.source.revision,raw.sourceRevisionId,JSON.stringify(input.acl.sourceReaders),JSON.stringify(input.acl.platformReaders),policy.principalId]);
      await tx.query('UPDATE entity_relations SET current_revision_id=$2 WHERE relation_id=$1',[relation.relation_id,revision]);
      await this.auth.audit(ctx,'objects.relate',{relationId:relation.relation_id,relationRevisionId:revision,sha256:raw.sha256},input.scopeId,tx);
      return {relationId:relation.relation_id,relationRevisionId:revision,deduplicated:false};
    });
  }
  async relations(ctx:AuthContext,id:string,limit:number,after?:string):Promise<any>{
    const join=`entity_relations r JOIN relation_observations ro ON ro.relation_revision_id=r.current_revision_id
      JOIN entities f ON f.entity_id=r.from_entity_id JOIN entity_observations fo ON fo.entity_revision_id=f.current_revision_id
      JOIN entities t ON t.entity_id=r.to_entity_id JOIN entity_observations too ON too.entity_revision_id=t.current_revision_id
      JOIN sources s ON s.source_revision_id=ro.source_revision_id`;
    const filter=`r.tenant_id=$1 AND r.scope_id=ANY($2::text[]) AND ${aclSql('ro')} AND ${visibleSql('f','fo')} AND ${visibleSql('t','too')} AND (r.from_entity_id=$4 OR r.to_entity_id=$4)`;
    return this.store.transaction(async tx=>{
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const policy=await this.auth.check(ctx,'objects.read',undefined,tx),parameters=[...this.parameters(policy),id];
      const root=(await tx.query(`SELECT 1 FROM ${entityJoin} WHERE ${visibleSql('e','o')} AND e.entity_id=$4`,parameters)).rows[0];
      if(!root)this.notVisible();
      const total=Number((await tx.query(`SELECT count(*) AS count FROM ${join} WHERE ${filter}`,parameters)).rows[0].count);
      const rows=(await tx.query(`SELECT r.*,ro.*,s.sha256,s.size,s.file_name,fo.entity_revision_id AS from_revision_id,too.entity_revision_id AS to_revision_id
        FROM ${join} WHERE ${filter} AND ($5::text IS NULL OR r.relation_id<$5) ORDER BY r.relation_id DESC LIMIT $6`,[...parameters,after??null,limit+1])).rows;
      const items=rows.slice(0,limit).map(row=>({relationId:row.relation_id,relationRevisionId:row.relation_revision_id,type:row.type,
        fromEntityId:row.from_entity_id,toEntityId:row.to_entity_id,fromEntityRevisionId:row.from_revision_id,toEntityRevisionId:row.to_revision_id,
        source:{system:row.source_system,objectType:row.source_type,externalId:row.external_id,revision:row.source_revision},
        provenance:{observedAt:row.observed_at.toISOString(),observerId:row.observer_id,raw:this.knowledge.sourceReference(row)}}));
      return {items,total,nextCursor:rows.length>limit?items.at(-1)!.relationId:null};
    });
  }
  async checkSourceAccess(ctx:AuthContext,sourceId:string,transaction?:Transaction):Promise<void>{
    const tx=transaction??this.store.pool;
    const count=Number((await tx.query(`SELECT (SELECT count(*) FROM entity_observations WHERE source_revision_id=$1)
      +(SELECT count(*) FROM relation_observations WHERE source_revision_id=$1) AS count`,[sourceId])).rows[0].count);
    if(!count)return;
    const policy=await this.auth.policy(ctx,transaction);if(!policy.grants.includes('objects.read'))this.notVisible();
    const parameters=[...this.parameters(policy),sourceId];
    const entity=(await tx.query(`SELECT 1 FROM entity_observations history JOIN entities e USING(entity_id)
      JOIN entity_observations o ON o.entity_revision_id=e.current_revision_id WHERE ${visibleSql('e','o')} AND ${aclSql('history')} AND history.source_revision_id=$4 LIMIT 1`,parameters)).rows[0];
    if(entity)return;
    const relation=(await tx.query(`SELECT 1 FROM relation_observations history JOIN entity_relations r USING(relation_id)
      JOIN relation_observations ro ON ro.relation_revision_id=r.current_revision_id
      JOIN entities f ON f.entity_id=r.from_entity_id JOIN entity_observations fo ON fo.entity_revision_id=f.current_revision_id
      JOIN entities t ON t.entity_id=r.to_entity_id JOIN entity_observations too ON too.entity_revision_id=t.current_revision_id
      WHERE r.tenant_id=$1 AND r.scope_id=ANY($2::text[]) AND ${aclSql('ro')} AND ${aclSql('history')} AND ${visibleSql('f','fo')} AND ${visibleSql('t','too')}
      AND history.source_revision_id=$4 LIMIT 1`,parameters)).rows[0];
    if(!relation)this.notVisible();
  }
}
