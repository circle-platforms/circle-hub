import {ApiError,BotRegistration,TriggerRegistration,ConnectorEventInput,MIN_SCHEDULE_INTERVAL_MS,canonicalHash,newId,requireCondition,type AuthContext} from '../../contracts/src/index.ts';
import type {Store,Transaction} from '../../storage/src/index.ts';
import type {Auth} from './auth.ts';
import type {Tasks} from './index.ts';
import type {Assets} from '../../assets/src/index.ts';
import type {SkillPacks} from '../../skillpacks/src/index.ts';

export class Automations {
  store:Store;auth:Auth;tasks:Tasks;assets:Assets;skills:SkillPacks;
  channels=new Map<string,(tx:Transaction,run:any,result:any)=>Promise<void>>();
  constructor(store:Store,auth:Auth,tasks:Tasks,assets:Assets,skills:SkillPacks){this.store=store;this.auth=auth;this.tasks=tasks;this.assets=assets;this.skills=skills;
    this.channels.set('circle-events',async(tx,run,result)=>this.tasks.emit(tx,run.task_id,'bot.output',{channel:'circle-events',botAssetId:run.bot_id,status:result.status,artifacts:result.artifacts??[],evidence:result.evidence??[],unknowns:result.phase==='unknown'?['Remote stopping is not verified']:[]}));
  }
  async trigger(ctx:AuthContext,value:unknown):Promise<any>{const input=TriggerRegistration.parse(value);await this.auth.check(ctx,'automations.manage',input.scopeId);
    if(input.kind==='event'){const source=await this.assets.row(ctx,input.sourceAssetId);requireCondition(source.kind==='connector-instance'&&source.scope_id===input.scopeId,'FORBIDDEN_SCOPE','Trigger source exceeds its partition');}
    return this.assets.register(ctx,{scopeId:input.scopeId,version:input.version,name:input.name,kind:'trigger',declaration:{reads:['asset-registry'],writes:['task-events'],credentials:[]},configuration:input,readers:[ctx.principalId,'*']});
  }
  async bot(ctx:AuthContext,value:unknown):Promise<any>{const input=BotRegistration.parse(value);await this.auth.check(ctx,'automations.manage',input.scopeId);
    requireCondition(input.identityPrincipalId===ctx.principalId,'FORBIDDEN_ACTION','First version runs under its owner identity');requireCondition(this.channels.has(input.channel),'INVALID_PAYLOAD','Output channel is not registered');
    return this.store.transaction(async tx=>{
      const trigger=await this.assets.row(ctx,input.triggerAssetId,tx),skill=await this.skills.row(ctx,input.skillPackId,'skillpacks.run',tx);
      requireCondition(trigger.kind==='trigger'&&trigger.scope_id===input.scopeId&&skill.scope_id===input.scopeId,'FORBIDDEN_SCOPE','Bot components must share a scope');requireCondition(skill.manifest.triggers.includes(trigger.configuration.kind),'FORBIDDEN_ACTION','Skill does not declare the trigger');
      const asset=await this.assets.register(ctx,{scopeId:input.scopeId,version:input.version,name:input.name,kind:'bot',declaration:{reads:['registered-assets'],writes:['task-events'],credentials:[]},configuration:input,readers:[ctx.principalId,'*']},tx);
      const cursor=Number((await tx.query('SELECT coalesce(max(id),0) AS value FROM automation_events')).rows[0].value);
      await tx.query('INSERT INTO automation_positions(bot_id,version,next_due_at,event_cursor) VALUES($1,$2,$3,$4)',[asset.assetId,asset.version,trigger.configuration.kind==='schedule'?trigger.configuration.startsAt:null,cursor]);return asset;
    });
  }
  async insert(tx:Transaction,ctx:AuthContext,source:any,value:any):Promise<any>{
    const hash=canonicalHash(value),prior=(await tx.query('SELECT * FROM automation_events WHERE tenant_id=$1 AND scope_id=$2 AND source_asset_id=$3 AND external_id=$4',[ctx.tenantId,source.scope_id,source.asset_id,value.externalId])).rows[0];
    if(prior){requireCondition(prior.request_hash===hash,'IDEMPOTENCY_MISMATCH','Connector event id has different content');return {eventId:prior.event_id,deduplicated:true};}
    const eventId=newId('rec');await tx.query('INSERT INTO automation_events(event_id,tenant_id,scope_id,source_asset_id,external_id,name,payload,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[eventId,ctx.tenantId,source.scope_id,source.asset_id,value.externalId,value.name,JSON.stringify(value.payload),hash]);return {eventId,deduplicated:false};
  }
  async event(ctx:AuthContext,id:string,value:unknown):Promise<any>{const input=ConnectorEventInput.parse(value);return this.store.transaction(async tx=>{
    const source=await this.assets.row(ctx,id,tx);await this.auth.check(ctx,'connectors.events',source.scope_id,tx);requireCondition(source.owner_principal_id===ctx.principalId&&source.kind==='connector-instance'&&source.lifecycle==='running','FORBIDDEN_ACTION','Only the active connector owner ingests its events');
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[canonicalHash([id,input.externalId])]);const result=await this.insert(tx,ctx,source,input);await this.auth.audit(ctx,'connectors.event',result,source.scope_id,tx);return result;
  });}
  async observed(tx:Transaction,ctx:AuthContext,id:string,raw:any):Promise<void>{const source=(await tx.query('SELECT * FROM assets WHERE asset_id=$1 AND tenant_id=$2',[id,ctx.tenantId])).rows[0];requireCondition(source,'FORBIDDEN_SCOPE','Observed asset belongs to another tenant');await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[canonicalHash([id,raw.path,raw.sha256])]);await this.insert(tx,ctx,source,{externalId:canonicalHash([raw.path,raw.sha256]),name:'source.changed',payload:{path:raw.path,sha256:raw.sha256}});}
  async runs(ctx:AuthContext,id:string):Promise<any[]>{await this.auth.check(ctx,'automations.read');let row:any;try{row=await this.assets.row(ctx,id,undefined,'automations.read');}catch(error){if(!(error instanceof ApiError))throw error;throw new ApiError('SOURCE_FORBIDDEN','Bot runs are private to the owner');}requireCondition(row.kind==='bot'&&row.owner_principal_id===ctx.principalId,'SOURCE_FORBIDDEN','Bot runs are private to the owner');return (await this.store.pool.query('SELECT * FROM automation_runs WHERE bot_id=$1 ORDER BY created_at,occurrence_key',[id])).rows.map(run=>({taskId:run.task_id,occurrenceKey:run.occurrence_key,channel:run.channel,published:!!run.published_at,status:run.status,trigger:run.occurrence,error:run.error}));}
  async admit(tx:Transaction,bot:any,trigger:any,key:string,occurrence:any):Promise<void>{
    const old=(await tx.query('SELECT 1 FROM automation_runs WHERE bot_id=$1 AND version=$2 AND occurrence_key=$3',[bot.asset_id,bot.version,key])).rowCount;if(old)return;
    const ctx={principalId:bot.owner_principal_id,tenantId:bot.tenant_id,kind:'user'} as AuthContext;await this.auth.check(ctx,'automations.manage',bot.scope_id,tx);
    const accepted=await this.skills.run(ctx,bot.configuration.skillPackId,{inputs:{...bot.configuration.inputs,trigger:occurrence},idempotencyKey:canonicalHash([bot.asset_id,bot.version,key])},trigger.configuration.kind,tx);
    await tx.query('INSERT INTO automation_runs(bot_id,version,occurrence_key,task_id,channel,identity_principal_id,occurrence) VALUES($1,$2,$3,$4,$5,$6,$7)',[bot.asset_id,bot.version,key,accepted.taskId,bot.configuration.channel,ctx.principalId,JSON.stringify(occurrence)]);await this.tasks.emit(tx,accepted.taskId,'bot.started',{botAssetId:bot.asset_id,triggerAssetId:trigger.asset_id,occurrenceKey:key,identityPrincipalId:ctx.principalId,trigger:occurrence});
  }
  async admitOccurrence(tx:Transaction,bot:any,trigger:any,key:string,occurrence:any):Promise<void>{
    await tx.query('SAVEPOINT automation_admission');
    try{await this.admit(tx,bot,trigger,key,occurrence);await tx.query('RELEASE SAVEPOINT automation_admission');}
    catch(error){
      await tx.query('ROLLBACK TO SAVEPOINT automation_admission');await tx.query('RELEASE SAVEPOINT automation_admission');
      if(!(error instanceof ApiError))throw error;
      // A rejected occurrence is a durable outcome, not a partially accepted task.
      // Do not return exception details which may describe inaccessible assets.
      const failure={code:error.code,message:'Bot occurrence was not admitted'};
      const inserted=await tx.query(`INSERT INTO automation_runs(bot_id,version,occurrence_key,task_id,channel,identity_principal_id,status,occurrence,error)
        VALUES($1,$2,$3,NULL,$4,$5,'failed',$6,$7) ON CONFLICT(bot_id,version,occurrence_key) DO NOTHING`,[bot.asset_id,bot.version,key,bot.configuration.channel,bot.owner_principal_id,JSON.stringify(occurrence),JSON.stringify(failure)]);
      if(inserted.rowCount)await this.auth.audit({principalId:bot.owner_principal_id,tenantId:bot.tenant_id,kind:'user'},'bot.admission-failed',{botAssetId:bot.asset_id,occurrenceKey:key,error:failure},bot.scope_id,tx);
    }
  }
  async tick():Promise<void>{
    const bots=(await this.store.pool.query("SELECT a.*,v.* FROM assets a JOIN asset_versions v ON v.asset_id=a.asset_id AND v.version=a.current_version WHERE a.kind='bot' AND v.lifecycle='running' AND v.approved_digest=v.sha256")).rows;
    for(const bot of bots){try{await this.store.transaction(async tx=>{
      const position=(await tx.query('SELECT * FROM automation_positions WHERE bot_id=$1 AND version=$2 FOR UPDATE SKIP LOCKED',[bot.asset_id,bot.version])).rows[0];if(!position)return;
      const active=(await tx.query(`SELECT 1 FROM assets a JOIN asset_versions v ON v.asset_id=a.asset_id AND v.version=a.current_version
        WHERE a.asset_id=$1 AND a.current_version=$2 AND v.lifecycle='running' AND v.approved_digest=v.sha256 FOR SHARE OF a,v`,[bot.asset_id,bot.version])).rowCount;if(!active)return;
      const ctx={principalId:bot.owner_principal_id,tenantId:bot.tenant_id,kind:'user'} as AuthContext,trigger=await this.assets.row(ctx,bot.configuration.triggerAssetId,tx);
      if(trigger.lifecycle!=='running'||trigger.approved_digest!==trigger.sha256)return;
      if(trigger.configuration.kind==='schedule'){
        const first=position.next_due_at as Date,interval=trigger.configuration.intervalMs,now=Date.now();if(first.getTime()>now)return;
        requireCondition(Number.isSafeInteger(interval)&&interval>=MIN_SCHEDULE_INTERVAL_MS,'INVALID_PAYLOAD','Schedule interval must be at least one minute');
        const skippedOccurrences=Math.floor((now-first.getTime())/interval),due=new Date(first.getTime()+skippedOccurrences*interval),next=new Date(due.getTime()+interval);
        await this.admitOccurrence(tx,bot,trigger,`schedule:${due.toISOString()}`,{kind:'schedule',dueAt:due.toISOString(),firstDueAt:first.toISOString(),skippedOccurrences});
        await tx.query('UPDATE automation_positions SET next_due_at=$3 WHERE bot_id=$1 AND version=$2',[bot.asset_id,bot.version,next]);
      }else{
        const events=(await tx.query('SELECT * FROM automation_events WHERE tenant_id=$1 AND scope_id=$2 AND source_asset_id=$3 AND name=$4 AND id>$5 ORDER BY id LIMIT 100',[bot.tenant_id,bot.scope_id,trigger.configuration.sourceAssetId,trigger.configuration.eventName,position.event_cursor])).rows;
        for(const event of events){await this.admitOccurrence(tx,bot,trigger,`event:${event.event_id}`,{kind:'event',eventId:event.event_id,sourceAssetId:event.source_asset_id,payload:event.payload});await tx.query('UPDATE automation_positions SET event_cursor=$3 WHERE bot_id=$1 AND version=$2',[bot.asset_id,bot.version,event.id]);}
      }
    });}catch(error){if(!(error instanceof ApiError))throw error;/* An unavailable trigger has no occurrence to admit; wait for its owner to restore it. */}}
    const unpublished=(await this.store.pool.query("SELECT r.* FROM automation_runs r JOIN tasks t USING(task_id) WHERE r.published_at IS NULL AND t.phase IN ('delivered','failed','unknown','cancelled')")).rows;
    for(const run of unpublished)await this.store.transaction(async tx=>{
      const locked=(await tx.query('SELECT * FROM automation_runs WHERE bot_id=$1 AND version=$2 AND occurrence_key=$3 AND published_at IS NULL FOR UPDATE SKIP LOCKED',[run.bot_id,run.version,run.occurrence_key])).rows[0];if(!locked)return;
      const ctx=await this.auth.policy({principalId:locked.identity_principal_id} as AuthContext,tx),result=await this.tasks.result(ctx,locked.task_id);
      const channel=this.channels.get(locked.channel);requireCondition(channel,'INVALID_PAYLOAD','Output channel was removed');await channel(tx,locked,result);await tx.query('UPDATE automation_runs SET published_at=clock_timestamp() WHERE bot_id=$1 AND version=$2 AND occurrence_key=$3',[run.bot_id,run.version,run.occurrence_key]);
    });
  }
}
