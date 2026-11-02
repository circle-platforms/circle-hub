// Memory uses the existing password session and form boundary, independently of knowledge grants.
import {uiLabelOf,KnowledgeGranteeSchema,isKnowledgeGrantAction,type MemoryAction,type KnowledgeSpaceKind} from '../../../contracts/generated/vocabulary.ts';
import {MemoryShareBody} from '../../../contracts/src/memory.ts';
import {Sha256} from '../../../contracts/src/common.ts';
import {KnowledgeError} from '../../knowledge/api.ts';
import {newId,AccessError} from '../../records/api.ts';
import {html,link,page,pre,table,type Html} from './html.ts';
import {button,card,when} from './ui.ts';
import {type PageContext,type PageResult,neutralPage} from './pages.ts';
import {currentAudience,inScope,knowledgeTabs,selectedScope,spaceLayout} from './space-layout.ts';
import {containsDirectory,directoryName} from './audience.ts';
import {grantDialog,checkTable} from './grant-dialog.ts';

const location=(parameters:Record<string,string|undefined>={})=>'/console/knowledge?'+new URLSearchParams({view:'memory',...Object.fromEntries(Object.entries(parameters).filter((pair):pair is [string,string]=>pair[1]!==undefined))});
const form=(ctx:PageContext,action:string,fields:Html,label:string,disabled=false)=>html`<form method="post" action="/console/knowledge/do/memory-${action}"><input type="hidden" name="csrf" value="${ctx.csrf??''}">${fields}<button class="btn primary mt12" type="submit"${disabled?html` disabled`:''}>${label}</button></form>`;
const field=(name:string,input:Html)=>html`<label>${name}${input}</label>`;
const memoryLabel=()=>uiLabelOf('knowledge_view','memory');
const actionLabel=(action:MemoryAction)=>uiLabelOf('memory_action',action);

export async function memoryPage(ctx:PageContext):Promise<PageResult>{
 const memory=ctx.deps.knowledge.memory;if(!memory)return neutralPage(ctx);
 const scope=selectedScope(ctx),document=ctx.url.searchParams.get('document'),version=ctx.url.searchParams.get('version');
 if(document&&!Sha256.safeParse(document).success||version&&!Sha256.safeParse(version).success)return neutralPage(ctx);
 const tabs=knowledgeTabs(ctx);
 let result=html``;
 const receipt=ctx.url.searchParams.get('receipt');
 if(receipt){
  const record=Sha256.safeParse(receipt).success?await ctx.deps.records.store.get(receipt):null;
  const parsed=record?.kind==='memory_share'?MemoryShareBody.safeParse(record.body):null;
  if(!parsed?.success||parsed.data.by!==ctx.principal.id&&!ctx.admin)return neutralPage(ctx);
  const body=parsed.data;
  result=card({title:uiLabelOf('knowledge_share_status',body.status),hint:'个人原文与授权保留；确认时重新检查，回执保留实际结果'},html`<p>${body.code??''} ${body.message}</p>${body.team_document?link(location({scope:'team',document:body.team_document}),memoryLabel()+' · '+actionLabel('share')):''}`);
 }
 let content:Html;
 if(document){
  const doc=await memory.read(ctx.principal,document,version??undefined),own=doc.space===ctx.principal.id,editable=(own||doc.space==='team'&&ctx.admin)&&doc.version===doc.current_version;
  const audience=await currentAudience(ctx,doc.space,doc.path,false,undefined,true);
  const manage=editable?html`<div class="actions">${link(location({scope,document,edit:'1'}),actionLabel('edit'))}${form(ctx,'write',html`<input type="hidden" name="space" value="${doc.space==='team'?'team':'personal'}"><input type="hidden" name="document" value="${document}"><input type="hidden" name="expected_version" value="${doc.current_version}"><input type="hidden" name="enabled" value="${doc.state==='enabled'?'false':'true'}"><input type="hidden" name="client_key" value="${newId('evt')}">`,actionLabel(doc.state==='enabled'?'disable_memory':'enable_memory'))}${own?link(location({scope,document,share:'1'}),actionLabel('share')):''}</div>`:html``;
  const history=own||doc.space==='team'&&ctx.admin?await memory.history(ctx.principal,document,ctx.url.searchParams.get('history_cursor')??undefined):null;
  const versions=history?card({title:actionLabel('history'),hint:'仅本人或团队管理员可浏览历史；切换版本不修改正文'},html`${table(['版本','标题','状态','大小','更新时间','记录人'],await Promise.all(history.items.map(async row=>[link(location({scope,document,version:row.version}),row.version.slice(0,12)),row.title,uiLabelOf('memory_status',row.state as typeof doc.state),row.bytes+' 字节',when(row.at),await ctx.userName(row.by)])))}${history.next?link(location({scope,document,history_cursor:history.next}),'更早的版本'):''}`):html``;
  let sharing=html``;
  if(own&&ctx.url.searchParams.get('share')==='1'){
   const target=ctx.url.searchParams.get('team_path')??doc.path,key=ctx.url.searchParams.get('client_key')??newId('evt');
   const plan=await memory.share(ctx.principal,{document,version:doc.current_version,team_path:target,client_key:key,check_only:true});
   sharing=card({title:actionLabel('share_preview'),hint:'个人原文和授权保留；团队副本独立。预检不写记录，确认时重查大小、凭据和团队修改'},html`<p>${uiLabelOf('memory_share_effect',plan.effect??'create').replace('{title}',plan.title)}</p><p>个人：保留不变 · ${audience.text}</p><p>团队：${uiLabelOf('audience_scope','team')}</p><form method="get" action="/console/knowledge"><input type="hidden" name="view" value="memory"><input type="hidden" name="document" value="${document}"><input type="hidden" name="share" value="1"><input type="hidden" name="client_key" value="${key}">${field('团队目录',html`<input name="team_path" value="${plan.target_path??''}" maxlength="2000">`)}<button type="submit">重新预检</button></form>${checkTable(plan.checks)}${form(ctx,'share',html`<input type="hidden" name="document" value="${document}"><input type="hidden" name="version" value="${doc.current_version}"><input type="hidden" name="team_path" value="${plan.target_path??''}"><input type="hidden" name="client_key" value="${key}">`,'确认提交共享',!plan.ok)}`);
  }
  const editor=editable&&ctx.url.searchParams.get('edit')==='1'?memoryEditor(ctx,doc.space==='team'?'team':'personal',doc):html``;
  content=html`${tabs}${result}${card({title:doc.title,hint:'客户端会话偏好，不经事实核验，不作为运行输入或依据'},html`<p>可见范围：${audience.text}${audience.inherited.map(path=>html` · 继承自 ${directoryName(path)} 的授权`)}</p><p>${uiLabelOf('memory_status',doc.state)} · ${doc.bytes} 字节 · ${when(doc.updated_at)} · ${directoryName(doc.path)}</p>${manage}${pre(doc.markdown)}`)}${editor}${sharing}${versions}`;
 }else{
  const owner=ctx.url.searchParams.get('space'),path=ctx.url.searchParams.get('path')??'/';
  const documents=(await memory.items(ctx.principal,scope)).filter(doc=>(!owner||doc.space===owner)&&containsDirectory(path,doc.path));
  const rows=await Promise.all(documents.map(async doc=>[link(location({scope,document:doc.document}),doc.title),(await currentAudience(ctx,doc.space,doc.path,false,undefined,true)).text,uiLabelOf('memory_status',doc.state),doc.bytes+' 字节',when(doc.updated_at),directoryName(doc.path)]));
  const team=scope==='team',canWrite=scope==='personal'||scope==='all'||team&&ctx.admin;
  const usage=scope==='personal'||team&&ctx.admin?await memory.usage(ctx.principal,team?'team':ctx.principal.id):null;
  const controls=canWrite?button(location({scope:team?'team':'personal',edit:'1'}),actionLabel('create')):html``;
  let grant=html``;
  if(scope==='personal'){
   const audience=await currentAudience(ctx,ctx.principal.id,path,false,undefined,true);
   grant=await grantDialog(ctx,{id:'memory-grants',current:audience.text,content:directoryName(path)+' · 只读，含全部下级目录',checks:await memory.precheckGrant(ctx.principal,path),grants:(await memory.grants(ctx.principal)).filter(g=>containsDirectory(g.path,path)),fields:html`<input type="hidden" name="path" value="${path}">`,form:(action,fields,label,disabled)=>form(ctx,action,fields,label,disabled)});
  }
  content=html`${tabs}${result}<div class="actions">${controls}${grant}</div>${usage?html`<p title="有效正文不含旧版本与停用文档；历史占用计入个人容量">有效正文 ${usage.active}／${usage.limits.spaceBytes} 字节 · 单篇上限 ${usage.limits.documentBytes} 字节</p>`:''}${canWrite&&ctx.url.searchParams.get('edit')==='1'?memoryEditor(ctx,team?'team':'personal'):''}${card({title:memoryLabel(),hint:'授权给其他账户的记忆只能查看，不自动加载到其会话；团队与本人启用记忆具备会话读取资格'},table(['标题','可见范围','状态','大小','更新时间','位置'],rows,'没有可读的记忆'))}`;
 }
 return {status:200,body:page(ctx.chrome(memoryLabel(),{active:'knowledge',hint:'记忆只用于客户端会话；知识与记忆的授权分别管理'}),await spaceLayout(ctx,content))};
}

function memoryEditor(ctx:PageContext,space:KnowledgeSpaceKind,doc?:{document:string;current_version:string;title:string;path:string;markdown:string;state:string}):Html{
 return card({title:actionLabel(doc?'edit':'create'),hint:'纯文本保存，不执行 Markdown；保存检查大小与疑似凭据，版本变化时拒绝覆盖'},form(ctx,'write',html`<div class="fields"><input type="hidden" name="space" value="${space}"><input type="hidden" name="document" value="${doc?.document??''}"><input type="hidden" name="expected_version" value="${doc?.current_version??''}"><input type="hidden" name="client_key" value="${newId('evt')}">${field('标题',html`<input name="title" value="${doc?.title??''}" required maxlength="300">`)}${field('目录',html`<input name="path" value="${doc?.path??ctx.url.searchParams.get('path')??'/'}" required maxlength="2000">`)}${field('状态',html`<select name="enabled"><option value="true">${uiLabelOf('memory_status','enabled')}</option><option value="false"${doc?.state==='disabled'?html` selected`:''}>${uiLabelOf('memory_status','disabled')}</option></select>`)}<div class="full">${field('Markdown 正文',html`<textarea name="markdown" rows="14" required>${doc?.markdown??''}</textarea>`)}</div></div>`,actionLabel('save')));
}

export async function performMemoryAction(ctx:PageContext,action:string,values:{get(key:string):string|null|undefined}):Promise<string>{
 const memory=ctx.deps.knowledge.memory;if(!memory)throw new AccessError('对象不存在或无权读取');
 const get=(key:string)=>values.get(key)??'';
 if(action==='write'){
  const document=get('document'),enabled=get('enabled');
  const saved=await memory.write(ctx.principal,{space:get('space')||'personal',...(document?{document}:{}),expected_version:get('expected_version')||null,...Object.fromEntries(['title','path','markdown'].filter(key=>values.get(key)!==null&&values.get(key)!==undefined).map(key=>[key,get(key)])),...(enabled?{enabled:enabled==='true'}:{}),client_key:get('client_key')});
  return location({scope:saved.space==='team'?'team':'personal',document:saved.document});
 }
 if(isKnowledgeGrantAction(action)){
  const audience=KnowledgeGranteeSchema.parse(get('audience')),member=get('member_id')||(get('member')?(await ctx.deps.records.principals.findByName(get('member')))?.id:null);
  if(audience==='member'&&!member)throw new KnowledgeError('对象不存在或无权读取',{code:'SOURCE_UNAVAILABLE'});
  await memory.grant(ctx.principal,{path:get('path'),audience,member:audience==='member'?member:null,revoke:action==='revoke'});
  return location({scope:'personal',path:get('path')});
 }
 if(action==='share'){
  const shared=await memory.share(ctx.principal,{document:get('document'),version:get('version'),...(get('team_path')?{team_path:get('team_path')}:{}),client_key:get('client_key')});
  return location({scope:'personal',document:get('document'),receipt:shared.record});
 }
 throw new AccessError('对象不存在或无权读取');
}
