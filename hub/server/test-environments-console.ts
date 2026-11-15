// Administrator projections over the one records catalog. No independent directory or write path lives here.
import { TeamId, UserId, TestEnvironmentInheritanceCompletion } from '../../contracts/api.ts';
import { ExecutorNames } from '../dispatch/api.ts';
import type { LeaseService } from '../leases/api.ts';
import { AccessError, IntegrityError, isAdmin, sha256Hex, type AuthorizationRecord, type Page, type Principal, type RecordsKit, type Transaction, type User } from '../records/api.ts';
import { collectEnvironmentPermissionSources } from './env-permission-sources.ts';

export type EnvironmentAssignmentSubject = {kind:'all'}|{kind:'account';name:string}|{kind:'team';name:string};
export interface EnvironmentAssignmentView {
  subject:EnvironmentAssignmentSubject;
  source:'direct'|'inherited';
  viaTeam?:string;
  holderIds:readonly string[];
  expiresAt:string|null;
  accountDisabled?:boolean;
  createdByAutomaticInheritance:boolean|null;
}
export interface EnvironmentOwnershipView {
  prefix?:string;
  key?:string;
  ownerName:string|null;
  ownerUnspecified:boolean;
  ownerDisabled:boolean|null;
  ownerDeleted:boolean|null;
}
export interface TestEnvironmentConsoleRow {
  name:string;target:string;prefixes:readonly string[];resources:readonly string[];executors:readonly string[];
  owner:string;ownerDisabled?:boolean;ownership:readonly EnvironmentOwnershipView[];
  assignments:readonly EnvironmentAssignmentView[];occupancyKeys:readonly string[];
}
export interface TestEnvironmentNameChoice {name:string}
export interface TestEnvironmentsConsolePort {
  list(by:Principal):Promise<readonly TestEnvironmentConsoleRow[]>;
  executorChoices(by:Principal):Promise<readonly TestEnvironmentNameChoice[]>;
  ownerChoices(by:Principal):Promise<readonly TestEnvironmentNameChoice[]>;
  teamChoices(by:Principal):Promise<readonly TestEnvironmentNameChoice[]>;
  accountChoices(by:Principal):Promise<readonly TestEnvironmentNameChoice[]>;
}
export interface BookingPrefixConsoleRow {
  prefix:string;ownerName:string;ownerDisabled:boolean;ownerDeleted:boolean;
  holders?:readonly {name:string;since?:string;active?:boolean}[];
  workflowAssignees?:readonly ({kind:'account'|'team'|'all';name:string})[];
  missingFacts:readonly string[];
}
export interface BookingPrefixesConsolePort {list(by:Principal):Promise<readonly BookingPrefixConsoleRow[]>}
type LeaseReads=Pick<LeaseService,'view'> & {
  recentHolders?(prefix:string):Promise<readonly {key:string;user:string;run:string;since:string;until:string|null;active:boolean}[]>;
};

export function createEnvironmentManagementPorts(records:RecordsKit,leases:LeaseReads,options:{names?:Pick<ExecutorNames,'list'>;now?:()=>Date}={}):{testEnvironments:TestEnvironmentsConsolePort;bookingPrefixes:BookingPrefixesConsolePort} {
  const names=options.names??new ExecutorNames(records),now=options.now??(()=>new Date());
  const admin=async(by:Principal,tx:Transaction)=>{
    const user=await records.principals.get(by.id,tx);
    if(!user||user.disabled||user.deleted_at||!isAdmin(user))throw new AccessError('只有启用的管理员可以读取测试环境管理资料');
    return user;
  };
  const history=async(tx:Transaction)=>{
    const rows:AuthorizationRecord[]=[];let cursor:string|null=null;
    do{const page:Page<AuthorizationRecord>=await records.store.list<AuthorizationRecord['body']>({kind:'authorization',newestFirst:false,limit:500,cursor},tx);rows.push(...page.items);cursor=page.next;}while(cursor!==null);
    return rows;
  };
  const state=(by:Principal,withWorkflows=false)=>records.store.withTransaction(async tx=>{
    const actor=await admin(by,tx),at=now();
    const entries=await records.testEnvironments.list(actor,tx),users=await records.principals.list(tx),teams=await records.teams.list(actor,tx);
    const memberships=new Map<string,string[]>();for(const team of teams)memberships.set(team.id,(await records.teams.members(actor,team.id,tx)).map(member=>member.user.id));
    const bindings=await names.list(actor,tx),authorizations=await history(tx),latest=new Map<string,AuthorizationRecord>();
    for(const row of authorizations)latest.set(row.body.permission+'|'+row.body.subject+'|'+row.body.object,row);
    const active=(row:AuthorizationRecord)=>!row.body.revoked&&(row.body.expires_at===null||Date.parse(row.body.expires_at)>at.getTime());
    const inheritance=await records.testEnvironments.inheritance(tx);let inherited:Set<string>|null=inheritance.completed===false?new Set():null;
    if(inheritance.completed===true){
      const marker=inheritance.record===null?null:await records.store.get<AuthorizationRecord['body']>(inheritance.record,tx);
      const bytes=marker?.body.bound?await records.objects.get(marker.body.bound,tx):null;
      if(!bytes||sha256Hex(bytes)!==marker!.body.bound)throw new IntegrityError('测试环境分配的继承来源现在不能核对');
      inherited=new Set(TestEnvironmentInheritanceCompletion.parse(JSON.parse(Buffer.from(bytes).toString('utf8'))).grant_records);
    }
    let workflows:Awaited<ReturnType<typeof collectEnvironmentPermissionSources>>['workflows']|null=null;
    if(withWorkflows)try{workflows=(await collectEnvironmentPermissionSources({store:records.store,objects:records.objects,tx,at:at.toISOString(),authorizations})).workflows;}catch{/* A failed declaration read is not an empty list of former users. */}
    return {entries,users,teams,memberships,bindings,latest,active,inherited,workflows};
  });
  const person=(users:readonly User[],id:string|null)=>id===null?null:users.find(user=>user.id===id)??null;
  const choices=(by:Principal)=>records.store.withTransaction(async tx=>{await admin(by,tx);return (await records.principals.list(tx)).filter(user=>!user.disabled&&!user.deleted_at).map(user=>({name:user.name}));});
  return {
    testEnvironments:{
      async list(by){
        const s=await state(by),held=(await leases.view('',true)).entries;
        if(s.entries.some(row=>!row.isTestEnvironment&&!row.isBookingPrefix))throw new IntegrityError('部分登记的目标归属尚未核对，请先恢复登记事实');
        return s.entries.filter(row=>row.isTestEnvironment).map(environment=>{
          if(environment.name===null||environment.target===null)throw new IntegrityError('测试环境名字或目标尚未核对');
          const ownership:EnvironmentOwnershipView[]=[...environment.prefixes.map(row=>({prefix:row.prefix,owner:row.owner})),...environment.resources.map(row=>({key:row.key,owner:row.owner}))].map(row=>{
            const owner=person(s.users,row.owner);const {owner:_,...identity}=row;
            return {...identity,ownerName:owner&&!owner.deleted_at?owner.name:null,ownerUnspecified:row.owner===null,ownerDisabled:owner?.disabled??null,ownerDeleted:owner?Boolean(owner.deleted_at):null};
          });
          const assignments:EnvironmentAssignmentView[]=[];
          for(const row of s.latest.values()){
            if(row.body.permission!=='resource_assign'||row.body.object!==environment.id||!s.active(row))continue;
            let subject:EnvironmentAssignmentSubject,holderIds:string[],accountDisabled:boolean|undefined;
            if(row.body.subject==='*'){subject={kind:'all'};holderIds=s.users.filter(user=>!user.deleted_at).map(user=>user.id);}
            else if(TeamId.safeParse(row.body.subject).success){const team=s.teams.find(team=>team.id===row.body.subject);if(!team)throw new IntegrityError('分配所引用的团队现在不能核对');subject={kind:'team',name:team.name};holderIds=s.memberships.get(team.id)??[];}
            else if(UserId.safeParse(row.body.subject).success){const user=person(s.users,row.body.subject);if(!user)throw new IntegrityError('分配所引用的账户现在不能核对');if(user.deleted_at)continue;subject={kind:'account',name:user.name};holderIds=[user.id];accountDisabled=user.disabled;}
            else throw new IntegrityError('测试环境分配主体不合正式声明');
            assignments.push({subject,source:'direct',holderIds,expiresAt:row.body.expires_at,...(accountDisabled===undefined?{}:{accountDisabled}),createdByAutomaticInheritance:s.inherited?.has(row.digest)??null});
          }
          const ownerNames=[...new Set(ownership.map(row=>row.ownerName??(row.ownerUnspecified?'责任账户尚未登记':row.ownerDeleted?'已删除的责任账户':'责任账户资料未能读取')))];
          return {name:environment.name,target:environment.target,prefixes:environment.prefixes.map(row=>row.prefix),resources:environment.resources.map(row=>row.key),executors:environment.executors.map(id=>{const binding=s.bindings.find(binding=>binding.executor===id);if(!binding)throw new IntegrityError('关联执行器的名字尚未核对');return binding.name;}),owner:ownerNames.join('、'),...(ownership.length&&ownership.every(row=>row.ownerDisabled===true)?{ownerDisabled:true}:{}),ownership,assignments,
            occupancyKeys:[...new Set([...environment.resources.map(row=>row.key),...held.filter(row=>environment.resources.some(resource=>resource.key===row.key)||environment.prefixes.some(prefix=>row.key.startsWith(prefix.prefix))).map(row=>row.key)])]};
        });
      },
      async executorChoices(by){return records.store.withTransaction(async tx=>{await admin(by,tx);return (await names.list(by,tx)).map(row=>({name:row.name}));});},
      ownerChoices:choices,accountChoices:choices,
      async teamChoices(by){return records.store.withTransaction(async tx=>{await admin(by,tx);return (await records.teams.list(by,tx)).map(team=>({name:team.name}));});},
    },
    bookingPrefixes:{
      async list(by){
        const s=await state(by,true),out:BookingPrefixConsoleRow[]=[];
        for(const entry of s.entries.filter(row=>row.isBookingPrefix))for(const registration of entry.prefixes){
          const owner=person(s.users,registration.owner);if(!owner)throw new IntegrityError('预订前缀的责任账户资料未能读取');
          const missingFacts:string[]=[],assignees=new Map<string,{kind:'account'|'team'|'all';name:string}>();
          if(s.workflows!==null)for(const workflow of s.workflows.filter(workflow=>registration.prefix.startsWith(workflow.prefix)))for(const row of s.latest.values()){
            if(row.body.permission!=='assign'||row.body.object!==workflow.id||!s.active(row))continue;
            let subject:{kind:'account'|'team'|'all';name:string}|null=null;
            if(row.body.subject==='*')subject={kind:'all',name:'全体成员'};
            else if(TeamId.safeParse(row.body.subject).success){const team=s.teams.find(team=>team.id===row.body.subject);if(team)subject={kind:'team',name:team.name};}
            else{const user=person(s.users,row.body.subject);if(user&&!user.disabled&&!user.deleted_at)subject={kind:'account',name:user.name};}
            if(subject)assignees.set(subject.kind+'|'+subject.name,subject);
          }
          else missingFacts.push('正式预订工作流声明本次未能读取，不能判成没有使用分配');
          let holders:BookingPrefixConsoleRow['holders'];
          if(leases.recentHolders){const recent=await leases.recentHolders(registration.prefix),selected=new Map<string,{name:string;since:string;active:boolean}>();for(const row of recent){const user=person(s.users,row.user);const identity=row.user+'|'+row.active,previous=selected.get(identity);if(!previous||row.since>previous.since)selected.set(identity,{name:user&&!user.deleted_at?user.name:'账户资料未能读取',since:row.since,active:row.active});}holders=[...selected.values()];}
          else missingFacts.push('最近持有者读取端口尚未接入，未检查历史持有记录');
          out.push({prefix:registration.prefix,ownerName:owner.deleted_at?'已删除的责任账户':owner.name,ownerDisabled:owner.disabled,ownerDeleted:Boolean(owner.deleted_at),...(holders===undefined?{}:{holders}),...(s.workflows===null?{}:{workflowAssignees:[...assignees.values()]}),missingFacts});
        }
        return out;
      },
    },
  };
}
