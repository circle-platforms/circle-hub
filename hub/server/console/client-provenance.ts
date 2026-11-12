// Which client wrote something, as the Hub recorded it. Names are shown exactly as recorded: the name an MCP client
// reported in initialize (clientInfo), the name an OAuth client registered (client_name, the label of its token) or the
// label an administrator gave a token. Where a name came from is shown only in the technical details. Nothing reported
// is shown as 客户端; no product name is ever assumed.
import type {PageContext} from './pages.ts';
import type {ClientDeclaration} from '../../../contracts/src/spaces.ts';
import {UNNAMED_CLIENT} from '../oauth.ts';
import {evidence} from './presentation.ts';

/** A token label is the client_name it was issued for, or the administrator's label; the Hub's placeholder is 客户端. */
const labelled=(label:string)=>label&&label!==UNNAMED_CLIENT?label:UNREPORTED_CLIENT;

export const UNREPORTED_CLIENT='客户端';
export interface ClientName {name:string;origin:string}

/** The client an entry version declares (MCP initialize clientInfo). */
export function declaredClient(client:ClientDeclaration|undefined):ClientName{
 if(!client)return {name:UNREPORTED_CLIENT,origin:'未报告'};
 return {name:client.version?`${client.name} ${client.version}`:client.name,origin:'MCP initialize clientInfo'};
}

/** The client behind a server token of `owner`: its registered OAuth client_name or the administrator's label. */
export async function tokenClient(ctx:PageContext,owner:string,token:string|null):Promise<ClientName|null>{
 if(!token)return null;
 const row=(await ctx.deps.records.principals.tokens(owner)).find(t=>t.id===token);
 if(!row)return null;
 if(row.client!==null)return {name:labelled(row.label),origin:'OAuth client_name（'+row.client+'）'};
 return {name:labelled(row.label),origin:'管理员命名的令牌'};
}

type EntryOrigin={by:string;at:string;session:string|null;client?:ClientDeclaration;sync_private?:boolean};
/** A sync commit names its audited HTTP request as the entry's session (hub/server/personal-sync.ts). */
async function syncAudit(ctx:PageContext,body:EntryOrigin){
 return body.sync_private!==undefined&&body.session?(await ctx.deps.records.store.find<{by:string;token:string;authenticated_client:string|null;declared_client:string|null}>({kind:'action',key:'personal.sync.http.request',value:body.session,limit:2})).items.find(r=>r.schema==='personal-sync-http-audit@1'&&r.body.by===body.by):undefined;
}

/** The client name an entry version records: its MCP declaration, or the client of the sync request that wrote it. */
export async function entryClientName(ctx:PageContext,body:EntryOrigin):Promise<string>{
 if(body.client)return body.client.name;
 const audit=await syncAudit(ctx,body);
 return (audit?await tokenClient(ctx,body.by,audit.body.token):null)?.name??UNREPORTED_CLIENT;
}

/** Rows of an entry version's provenance: who, when, which session and which client, as the Hub recorded them. */
export async function entryProvenance(ctx:PageContext,body:EntryOrigin):Promise<{rows:Array<[string,unknown]>;technical:Array<[string,unknown]>}>{
 const rows:Array<[string,unknown]>=[['写入人',await ctx.userName(body.by)],['写入时间',body.at]];
 const technical:Array<[string,unknown]>=[];
 const audit=await syncAudit(ctx,body);
 if(audit){
  const client=await tokenClient(ctx,body.by,audit.body.token);
  rows.push(['写入方式','同步'],['客户端',evidence(client?.name??UNREPORTED_CLIENT)]);
  technical.push(['名称来源',client?.origin??'未记录'],['同步请求',body.session],['令牌',audit.body.token],['设备',audit.body.declared_client??'未声明']);
 }else{
  const client=declaredClient(body.client);
  rows.push(['客户端',evidence(client.name)]);
  technical.push(['名称来源',client.origin],['会话',body.session??'未记录']);
 }
 return {rows,technical};
}
