// Decision 88 audit summaries: query only participant/all-administrator indexes, never private content or raw receipts.
import { SpaceGrantBody } from '../../../contracts/src/spaces.ts';
import { KnowledgeShareBody, PersonalPackGrantBody } from '../../../contracts/src/sharing.ts';
import {MemoryGrantBody,MemoryShareBody} from '../../../contracts/src/memory.ts';
import { KnowledgeGranteeSchema, MemoryFieldSchema, uiLabelOf } from '../../../contracts/generated/vocabulary.ts';
import {PROTOCOL_CODES} from '../../../contracts/generated/protocol.ts';
import { pathSegments } from '../../refs/api.ts';
import { html, link, table, code, type Html } from './html.ts';
import { card, when } from './ui.ts';
import type { PageContext } from './pages.ts';

const PAGE_SIZE = 50;
const directory = (path: string, team = false) => pathSegments(path).join(' › ') || uiLabelOf('knowledge_space_kind', team ? 'team' : 'personal') + '知识';
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);

async function memoryRefusals(ctx:PageContext,path:string,user?:string,from?:string,to?:string):Promise<Html>{
 const title=uiLabelOf('knowledge_view','memory')+'写入拒收记录',store=ctx.deps.records.store;
 if(ctx.admin){
  if(!store.countIndexed)return card({title},'统计暂不可用');
  const users=user?[user]:(await ctx.deps.records.principals.list()).map(account=>account.id);let total=0,capped=false;
  for(let offset=0;offset<users.length;offset+=1000){
   const index=users.slice(offset,offset+1000).map(value=>({key:'memory.refusal.by',value}));
   const lower=await store.countIndexed({kind:'action',index,since:from,cap:100_000});
   const upper=to?await store.countIndexed({kind:'action',index,since:new Date(Date.parse(to)+1).toISOString(),cap:100_000}):{count:0,capped:false};
   total+=Math.max(0,lower.count-upper.count);capped||=lower.capped||upper.capped;
  }
  return card({title,hint:'按记录创建时间和成员筛选统计；只计数，不读取或显示拒收码、字段、行或正文'},capped?'统计超过上限':html`<p>${total.toLocaleString('en-US')} 次</p>`);
 }
 const cursor='memory_refusals',page=await store.find({kind:'action',key:'memory.refusal.by',value:ctx.principal.id,newestFirst:true,limit:PAGE_SIZE,cursor:ctx.url.searchParams.get(cursor)}),rows=[];
 const fields={title:MemoryFieldSchema.enum.document_title,path:MemoryFieldSchema.enum.directory_path,markdown:MemoryFieldSchema.enum.markdown_text};
 for(const record of page.items){
  const body=record.body;if(record.schema!=='memory-refusal@1'||!object(body)||body.by!==ctx.principal.id||typeof body.code!=='string'||!Object.hasOwn(PROTOCOL_CODES,body.code)||user!==undefined&&body.by!==user||from!==undefined&&record.created_at<from||to!==undefined&&record.created_at>to)continue;
  const positions=Array.isArray(body.positions)?body.positions.filter(position=>object(position)&&typeof position.field==='string'&&Object.hasOwn(fields,position.field)&&Number.isSafeInteger(position.line)&&Number(position.line)>0):[];
  for(const position of positions.length?positions:[null])rows.push([when(record.created_at),code(body.code),position?uiLabelOf('memory_field',fields[position.field as keyof typeof fields]):'—',position?'第 '+position.line+' 行':'—']);
 }
 const parameters=new URLSearchParams(ctx.url.searchParams);if(page.next)parameters.set(cursor,page.next);
 return card({title,hint:'仅显示本人的安全摘要；不显示原文、凭据、内部摘要或自由说明'},html`${table(['时间','拒收码','字段','行'],rows,'本页没有匹配的拒收记录')}${page.next?link(path,'更早的拒收记录',Object.fromEntries(parameters)):''}`);
}

export async function spaceRecords(ctx: PageContext, path: string, user?: string, from?: string, to?: string): Promise<Html> {
  if (ctx.url.searchParams.get('tool') || ctx.url.searchParams.get('run')) return html``;
  const inFilter = (by: string, at: string) => (user === undefined || by === user) && (from === undefined || at >= from) && (to === undefined || at <= to);
  const more = (cursor: string, next: string, label: string) => {
    const parameters = new URLSearchParams(ctx.url.searchParams);
    parameters.set(cursor, next);
    return link(path, label, Object.fromEntries(parameters));
  };
  const cards: Html[] = [];
  const kinds = [
    { kind: 'knowledge_space_grant', owner: 'knowledge.space.grant', grantee: 'knowledge.space.grantee', cursor: 'knowledge_grants', schema: SpaceGrantBody, title: uiLabelOf('knowledge_space_kind','personal')+'知识授权记录' },
    { kind: 'personal_pack_grant', owner: 'personal.pack.grant_owner', grantee: 'personal.pack.grantee', cursor: 'pack_grants', schema: PersonalPackGrantBody, title: uiLabelOf('knowledge_space_kind','personal')+uiLabelOf('pack_kind','workflow')+'与'+uiLabelOf('pack_kind','skill')+'授权记录' },
    { kind: 'memory_grant', owner: 'memory.grant.owner', grantee: 'memory.grant.grantee', cursor: 'memory_grants', schema: MemoryGrantBody, title: uiLabelOf('knowledge_view','memory')+'授权记录' },
  ] as const;
  for (const kind of kinds) {
    const sources = [{ key: kind.owner, value: ctx.principal.id, cursor: kind.cursor + '_sent', label: '更早的本人发出授权' }, { key: kind.grantee, value: ctx.principal.id, cursor: kind.cursor + '_received', label: '更早的本人收到授权' },...(ctx.admin?[{ key: kind.grantee, value: KnowledgeGranteeSchema.enum.administrators, cursor: kind.cursor + '_admins', label: '更早的全体管理员授权' }]:[])];
    const pages = await Promise.all(sources.map(source => ctx.deps.records.store.find({ kind: kind.kind, key: source.key, value: source.value, newestFirst: true, limit: PAGE_SIZE, cursor: ctx.url.searchParams.get(source.cursor) })));
    const records = [...new Map(pages.flatMap(page => page.items).map(record => [record.digest, record])).values()].sort((a, b) => b.created_at.localeCompare(a.created_at) || a.digest.localeCompare(b.digest));
    const rows = [];
    for (const record of records) {
      const parsed = kind.schema.safeParse(record.body);
      if (!parsed.success) continue;
      const body = parsed.data;
      // Check the body too: an index is a projection, not authority to disclose a grant.
      const visible = body.space === ctx.principal.id || body.audience === KnowledgeGranteeSchema.enum.member && body.member === ctx.principal.id || ctx.admin && body.audience === KnowledgeGranteeSchema.enum.administrators;
      if (!visible || !inFilter(body.by, body.at)) continue;
      const target = body.audience === KnowledgeGranteeSchema.enum.administrators ? uiLabelOf('knowledge_grantee', body.audience) : `${uiLabelOf('knowledge_grantee', body.audience)}：${await ctx.userName(body.member)}`;
      rows.push([when(body.at), await ctx.userName(body.by), 'pack' in body ? body.pack : directory(body.path), target, uiLabelOf('knowledge_grant_action', body.action)]);
    }
    cards.push(card({ title: kind.title, hint: ctx.admin ? '列出本人发出、本人收到及授权给全体管理员的记录；其他成员之间的授权不显示' : '仅列出本人发出或本人收到的授权历史；收回不删除历史' }, html`${table(['时间', '授权人', '对象', '受众', '操作'], rows, '本页没有匹配的授权记录')}${pages.map((page, i) => page.next ? more(sources[i].cursor, page.next, sources[i].label) : '')}`));
  }
  const cursor = 'knowledge_shares';
  const shares = ctx.admin
    ? await ctx.deps.records.store.list({ kind: 'knowledge_share', newestFirst: true, limit: PAGE_SIZE, cursor: ctx.url.searchParams.get(cursor) })
    : await ctx.deps.records.store.find({ kind: 'knowledge_share', key: 'knowledge.share.by', value: ctx.principal.id, newestFirst: true, limit: PAGE_SIZE, cursor: ctx.url.searchParams.get(cursor) });
  const rows = [];
  for (const record of shares.items) {
    const parsed = KnowledgeShareBody.safeParse(record.body);
    if (!parsed.success) continue;
    const body = parsed.data;
    if (!ctx.admin && body.by !== ctx.principal.id || !inFilter(body.by, body.at)) continue;
    rows.push([when(body.at), await ctx.userName(body.by), directory(body.target_path ?? body.source.path, true), uiLabelOf('knowledge_share_status', body.status), body.code ?? '—', body.message, code(`tree:${body.source.root}${body.source.path}@${body.source.entry}`)]);
  }
  cards.push(card({ title: '提交共享记录', hint: ctx.admin ? '管理员可见全部提交共享的安全回执；不包含个人原文或提交内容' : '仅显示本人提交共享的安全回执，拒收后个人原条目保留' }, html`${table(['时间', '提交人', '团队目录', '状态', '拒收码', '说明', '来源条目'], rows, '本页没有匹配的提交共享记录')}${shares.next ? more(cursor, shares.next, '更早的提交共享') : ''}`));
  const memoryShares=ctx.admin?await ctx.deps.records.store.list({kind:'memory_share',newestFirst:true,limit:PAGE_SIZE,cursor:ctx.url.searchParams.get('memory_shares')}):await ctx.deps.records.store.find({kind:'memory_share',key:'memory.share.by',value:ctx.principal.id,newestFirst:true,limit:PAGE_SIZE,cursor:ctx.url.searchParams.get('memory_shares')});
  const memoryRows=[];
  for(const record of memoryShares.items){
    const parsed=MemoryShareBody.safeParse(record.body);if(!parsed.success)continue;const body=parsed.data;
    if(!ctx.admin&&body.by!==ctx.principal.id||!inFilter(body.by,body.at))continue;
    memoryRows.push([when(body.at),await ctx.userName(body.by),body.target_path?directory(body.target_path,true):'—',uiLabelOf('knowledge_share_status',body.status),body.code??'—',body.message,body.team_document?link('/console/knowledge',uiLabelOf('knowledge_view','memory'),{view:'memory',document:body.team_document,scope:'team'}):'—']);
  }
  cards.push(card({title:uiLabelOf('knowledge_view','memory')+'提交共享记录',hint:'只列安全回执，不显示个人记忆标题或正文'},html`${table(['时间','提交人','团队目录','状态','拒收码','说明','团队文档'],memoryRows,'本页没有匹配的提交共享记录')}${memoryShares.next?more('memory_shares',memoryShares.next,'更早的提交共享'):''}`));
  return html`${cards}${await memoryRefusals(ctx,path,user,from,to)}`;
}
