import {DefectReviewPack,OperationRequest,canonicalHash,newId,requireCondition,type AuthContext} from '../../contracts/src/index.ts';
import {connectorIdentity} from '../../connectors/src/index.ts';
import type {Store,Transaction} from '../../storage/src/index.ts';
import type {Auth} from './auth.ts';
import type {Tasks} from './index.ts';
import type {Operations} from '../../execution/src/operations.ts';
import type {ConnectorRegistry} from './connector-registry.ts';

export class Rules {
  store:Store;auth:Auth;tasks:Tasks;operations:Operations;registry:ConnectorRegistry;
  constructor(store:Store,auth:Auth,tasks:Tasks,operations:Operations,registry:ConnectorRegistry){this.store=store;this.auth=auth;this.tasks=tasks;this.operations=operations;this.registry=registry;}
  view(row:any):any{return {ruleId:row.rule_id,ownerId:row.owner_id,servicePrincipalId:row.service_principal_id,scopeId:row.scope_id,capabilityPackId:row.capability_pack_id,bindings:row.bindings,cursor:Number(row.cursor),enabled:row.enabled};}
  async create(ctx:AuthContext,input:any):Promise<any>{return this.store.transaction(async tx=>{
    await this.auth.check(ctx,'rules.manage',input.scopeId,tx);
    const service=await this.auth.intersectService(input.servicePrincipalId,ctx.principalId,tx);requireCondition(service.scopes.includes(input.scopeId),'FORBIDDEN_SCOPE','Service and owner scopes do not overlap');
    for(const name of DefectReviewPack.requiredOperations){const target=name.startsWith('defects.')?input.bindings.defects:name.startsWith('docs.')?input.bindings.documents:input.bindings.product;
      await this.registry.check(tx,service,input.scopeId,{name,target,args:{},delegatedOwnerId:ctx.principalId});}
    const row=(await tx.query('INSERT INTO rules(rule_id,tenant_id,scope_id,owner_id,service_principal_id,capability_pack_id,bindings,options,interval_ms) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
      [newId('rule'),ctx.tenantId,input.scopeId,ctx.principalId,input.servicePrincipalId,input.capabilityPackId,JSON.stringify(input.bindings),JSON.stringify({simulateCommentTimeout:input.simulateCommentTimeout}),input.intervalMs])).rows[0];
    await this.auth.audit(ctx,'rules.create',{ruleId:row.rule_id},input.scopeId,tx);return this.view(row);
  });}
  async get(ctx:AuthContext,id:string):Promise<any>{const row=(await this.store.pool.query('SELECT * FROM rules WHERE rule_id=$1',[id])).rows[0];requireCondition(row,'TARGET_NOT_FOUND','Rule not found');
    const policy=await this.auth.check(ctx,'tasks.read',row.scope_id);requireCondition(policy.tenantId===row.tenant_id,'FORBIDDEN_SCOPE','Rule belongs to another tenant');return this.view(row);}
  async authorizeSubmission(ctx:AuthContext,input:any,scope:string,tx:Transaction):Promise<string|undefined>{
    const policy=await this.auth.policy(ctx,tx);if(policy.kind!=='service')return undefined;
    const rule=(await tx.query('SELECT * FROM rules WHERE rule_id=$1 AND enabled',[input.ruleId??''])).rows[0];
    requireCondition(rule&&rule.service_principal_id===ctx.principalId&&rule.tenant_id===ctx.tenantId&&rule.scope_id===scope,'FORBIDDEN_SCOPE','Service task needs its approved rule');
    const effective=await this.registry.effective(ctx,rule.owner_id,tx);requireCondition(effective.defects.includes(input.defectId),'FORBIDDEN_TARGET','Defect is hidden from the rule owner');return rule.owner_id;
  }
  async tick():Promise<void>{
    const candidates=(await this.store.pool.query('SELECT rule_id FROM rules WHERE enabled AND (poll_operation_id IS NOT NULL OR next_poll_at<=clock_timestamp())')).rows;
    for(const candidate of candidates)await this.store.transaction(async tx=>{
      const rule=(await tx.query('SELECT * FROM rules WHERE rule_id=$1 FOR UPDATE SKIP LOCKED',[candidate.rule_id])).rows[0];if(!rule)return;
      const actor={principalId:rule.service_principal_id,tenantId:rule.tenant_id,kind:'service'} as const;
      if(rule.poll_operation_id){
        const op=(await tx.query('SELECT * FROM operations WHERE operation_id=$1',[rule.poll_operation_id])).rows[0];if(!['succeeded','failed','reconciled'].includes(op.status))return;
        if(op.status==='succeeded'){
          const data=op.result.output,effective=await this.registry.effective(actor,rule.owner_id,tx);
          for(const event of data.events??[]){
            if(!effective.defects.includes(event.defectId))continue;
            if((await tx.query('SELECT 1 FROM connector_events WHERE rule_id=$1 AND connector_id=$2 AND external_event_id=$3',[rule.rule_id,rule.bindings.defects,event.externalId])).rowCount)continue;
            const task=await this.tasks.submit(actor,{scopeId:rule.scope_id,title:'Review a synthetic product defect',capabilityPackId:'defect-review',
              input:{ruleId:rule.rule_id,externalEventId:event.externalId,defectId:event.defectId,bindings:rule.bindings,simulateCommentTimeout:rule.options.simulateCommentTimeout},idempotencyKey:`event-${rule.rule_id}-${event.externalId}`},tx);
            await tx.query('UPDATE tasks SET context=$2 WHERE task_id=$1',[task.taskId,JSON.stringify({delegatedOwnerId:rule.owner_id,step:'inspect'})]);
            await tx.query('INSERT INTO connector_events(rule_id,connector_id,external_event_id,payload,sha256,task_id) VALUES($1,$2,$3,$4,$5,$6)',[rule.rule_id,rule.bindings.defects,event.externalId,JSON.stringify(event),canonicalHash(event),task.taskId]);
          }
          await tx.query('UPDATE rules SET cursor=$2 WHERE rule_id=$1',[rule.rule_id,data.cursor]);
        }
        const task=await this.tasks.internal(tx,rule.poll_task_id);await tx.query("UPDATE tasks SET phase=$2,stage='done',result_status=$3 WHERE task_id=$1",[task.taskId,op.status==='succeeded'?'delivered':'failed',op.status]);
        await this.tasks.emit(tx,task.taskId,'rule.poll-completed',{ruleId:rule.rule_id,status:op.status});
        await tx.query("UPDATE rules SET poll_operation_id=NULL,poll_task_id=NULL,next_poll_at=clock_timestamp()+(interval_ms::double precision*interval '1 millisecond') WHERE rule_id=$1",[rule.rule_id]);return;
      }
      const round=Number(rule.poll_round)+1;
      const task=await this.tasks.submit(actor,{scopeId:rule.scope_id,title:'Poll synthetic defect events',input:{ruleId:rule.rule_id,poll:true},idempotencyKey:`poll-${rule.rule_id}-${round}`},tx);
      await tx.query('UPDATE tasks SET internal=true,context=$2 WHERE task_id=$1',[task.taskId,JSON.stringify({delegatedOwnerId:rule.owner_id})]);
      const op=await this.operations.submit(actor,task.taskId,OperationRequest.parse({inputRevisionId:task.inputRevisionId,name:'defects.search',target:rule.bindings.defects,targetIdentity:connectorIdentity(rule.bindings.defects),args:{cursor:Number(rule.cursor)},idempotencyKey:`poll-${rule.rule_id}-${round}`}),tx,rule.owner_id);
      await tx.query('UPDATE rules SET poll_task_id=$2,poll_operation_id=$3,poll_round=$4 WHERE rule_id=$1',[rule.rule_id,task.taskId,op.operationId,round]);
    });
  }
}
