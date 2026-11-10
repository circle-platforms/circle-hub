import {personalLocal,personalSyncNotice,checkPersonalFormEpoch,syncSelected} from './personal-sync.ts';
import {capacitySize} from './capacity.ts';
// Memory uses the existing password session and form boundary, independently of knowledge grants.
import {uiLabelOf,KnowledgeGranteeSchema,isKnowledgeGrantAction,type MemoryAction,type KnowledgeSpaceKind} from '../../../contracts/generated/vocabulary.ts';
import {MemoryShareBody} from '../../../contracts/src/memory.ts';
import {Sha256} from '../../../contracts/src/common.ts';
import {KnowledgeError} from '../../knowledge/api.ts';
import {newId,AccessError} from '../../records/api.ts';
import {html,link,page,pageLayout,pre,table,emptyAction,type Html} from './html.ts';
import {button} from './ui.ts';
import {evidence,panel as card,field as inputField,actionLink,dialog} from './presentation.ts';
import {memoryState,number,timestamp,versionLabel} from './knowledge-display.ts';
import {type PageContext,type PageResult,neutralPage} from './pages.ts';
import {currentAudience,inScope,knowledgeTabs,selectedScope,spaceLayout} from './space-layout.ts';
import {containsDirectory,directoryName} from './audience.ts';
import {grantDialog,checkTable,grantPreviewLocation} from './grant-dialog.ts';

const location=(parameters:Record<string,string|undefined>={})=>'/console/knowledge?'+new URLSearchParams({view:'memory',...Object.fromEntries(Object.entries(parameters).filter((pair):pair is [string,string]=>pair[1]!==undefined))});
const form=(ctx:PageContext,action:string,fields:Html,label:string,disabled=false,danger=false,back?:string)=>html`<form method="post" action="/console/knowledge/do/memory-${action}"${back?html` data-memory-editor`:''}><input type="hidden" name="csrf" value="${ctx.csrf??''}">${ctx.personalEpoch?html`<input type="hidden" name="personal_epoch" value="${ctx.personalEpoch}">`:html``}${fields}<div class="${back?'ch-editor-actions ':''}ch-actions"><button class="ch-btn ${danger||action==='revoke'?'ch-btn--danger':'ch-btn--primary'}" type="submit"${disabled?html` disabled`:''}>${label}</button>${back?actionLink(back,'取消并返回'):''}</div></form>`;
const field=inputField;
const memoryLabel=()=>uiLabelOf('knowledge_view','memory');
const actionLabel=(action:MemoryAction)=>uiLabelOf('memory_action',action);

export async function memoryPage(ctx:PageContext):Promise<PageResult>{
 ctx.personalEpoch=(await ctx.deps.records.personalSync?.state(ctx.principal))?.epoch;
 const memory=ctx.deps.knowledge.memory;if(!memory)return neutralPage(ctx);
 const local=await personalLocal(ctx);
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
  result=card({title:uiLabelOf('knowledge_share_status',body.status),hint:'私人原文与分享保留；确认时重新检查，回执保留实际结果'},html`<p>${body.code??''} ${evidence(body.message)}</p>${body.team_document?link(location({scope:'team',document:body.team_document}),memoryLabel()+' · '+actionLabel('share')):''}`);
 }
 let content:Html;
 if(document){
  const doc=await memory.read(ctx.principal,document,version??undefined),own=doc.space===ctx.principal.id,editable=(own||doc.space==='team'&&ctx.admin)&&doc.version===doc.current_version;
  if(editable&&ctx.url.searchParams.get('edit')==='1')return {status:200,body:page(ctx.chrome('编辑记忆',{active:'knowledge'}),await spaceLayout(ctx,pageLayout(memoryEditor(ctx,doc.space==='team'?'team':'personal',doc),{inspector:null})))};
  const audience=await currentAudience(ctx,doc.space,doc.path,false,undefined,true);
  const toggleForm=form(ctx,'write',html`<input type="hidden" name="space" value="${doc.space==='team'?'team':'personal'}"><input type="hidden" name="document" value="${document}"><input type="hidden" name="expected_version" value="${doc.current_version}"><input type="hidden" name="enabled" value="${doc.state==='enabled'?'false':'true'}"><input type="hidden" name="client_key" value="${newId('evt')}">`,actionLabel(doc.state==='enabled'?'disable_memory':'enable_memory'),false,doc.state==='enabled');
  const manage=html`<footer class="ch-inspector-actions">${own||doc.space==='team'&&ctx.admin?actionLink('#memory-versions','版本记录','ghost'):''}${editable?actionLink('#memory-toggle',doc.state==='enabled'?'停用…':'启用…',doc.state==='enabled'?'danger':'secondary'):''}${own?actionLink(location({scope,document,share:'1'}),'分享到团队…'):''}${editable?actionLink(location({scope,document,edit:'1'}),'编辑','primary'):''}</footer>${editable?dialog('memory-toggle',doc.state==='enabled'?'停用记忆':'启用记忆',html`<p>${doc.state==='enabled'?'停用后不再用于新会话；已有版本保留。':'启用后可用于符合读取权限的会话。'}</p>`,toggleForm):''}`;
  const history=doc.current_version!==null&&(own||doc.space==='team'&&ctx.admin)?await memory.history(ctx.principal,document,ctx.url.searchParams.get('history_cursor')??undefined):null;
  const versions=history?card({title:actionLabel('history'),hint:'仅本人或团队管理员可浏览版本记录；切换版本不修改正文'},html`${table(['版本','标题','状态','大小','更新时间','记录人'],await Promise.all(history.items.map(async (row,index)=>[link(location({scope,document,version:row.version}),versionLabel(row.at,undefined,history.next?undefined:history.items.length-index)),row.title,memoryState(row.state as typeof doc.state),html`${number(row.bytes)} 字节`,timestamp(row.at),await ctx.userName(row.by)])))}${history.next?link(location({scope,document,history_cursor:history.next}),'更早的版本'):''}`):html``;
  let sharing=html``;
  if(own&&ctx.url.searchParams.get('share')==='1'){
   const target=ctx.url.searchParams.get('team_path')??doc.path,key=ctx.url.searchParams.get('client_key')??newId('evt');
   const plan=await memory.share(ctx.principal,{document,version:doc.current_version,team_path:target,client_key:key,check_only:true});
   sharing=card({title:actionLabel('share_preview'),hint:'私人原文和分享设置保留；团队副本独立。预检不写记录，确认时重查管理员停用、大小、凭据和团队修改'},html`${plan.effect?html`<p>${uiLabelOf('memory_share_effect',plan.effect).replace('{title}',plan.title)}</p>`:''}<p>我的：保留不变 · ${audience.text}</p><p>团队：${uiLabelOf('audience_scope','team')}</p><form method="get" action="/console/knowledge"><input type="hidden" name="view" value="memory"><input type="hidden" name="document" value="${document}"><input type="hidden" name="share" value="1"><input type="hidden" name="client_key" value="${key}">${field('团队文件夹',html`<input name="team_path" value="${plan.target_path??''}" maxlength="2000">`)}<button class="ch-btn ch-btn--secondary" type="submit">重新预检</button></form>${checkTable(plan.checks)}${form(ctx,'share',html`<input type="hidden" name="document" value="${document}"><input type="hidden" name="version" value="${doc.current_version}"><input type="hidden" name="team_path" value="${plan.target_path??''}"><input type="hidden" name="client_key" value="${key}">`,'确认分享到团队',!plan.ok)}`);
  }
  const editor=editable&&ctx.url.searchParams.get('edit')==='1'?memoryEditor(ctx,doc.space==='team'?'team':'personal',doc):html``;
  content=html`${result}${card(null,html`<div class="ch-actions"><span class="ch-tag">${memoryLabel()}</span>${memoryState(doc.state)}</div><h2 class="ch-panel-title" title="客户端会话偏好，不经事实验证，不作为运行输入或来源">${evidence(doc.title)}</h2><p>分享范围：${audience.text}${audience.inherited.map(path=>html` · 同文件夹设置 · ${directoryName(path)}`)}</p><p>${number(doc.bytes)} 字节 · ${timestamp(doc.updated_at)} · ${directoryName(doc.path)}</p>${pre(doc.markdown)}`)}${editor}${sharing}${history?dialog('memory-versions','版本记录',versions):''}${manage}`;
  const docs=await memory.items(ctx.principal,scope);
  const rows=await Promise.all(docs.map(async item=>[link(location({scope,document:item.document}),item.title),(await currentAudience(ctx,item.space,item.path,false,undefined,true)).text,memoryState(item.state),number(item.bytes),timestamp(item.updated_at)]));
  content=pageLayout(html`${tabs}${table(['标题','分享','状态','大小','更新'],rows,'没有可读的记忆',undefined,{selected:docs.findIndex(item=>item.document===document),hrefs:docs.map(item=>location({scope,document:item.document}))})}`,{inspector:html`<div class="ch-section" data-area-content data-inspector-content>${content}</div>`,detail:true,back:link(location({scope}),'返回列表')});
 }else{
  const owner=ctx.url.searchParams.get('space'),path=ctx.url.searchParams.get('path')??'/';
  const documents=(await memory.items(ctx.principal,scope)).filter(doc=>(!owner||doc.space===owner)&&containsDirectory(path,doc.path));
  const rows=await Promise.all(documents.map(async doc=>[link(location({scope,document:doc.document}),doc.title),(await currentAudience(ctx,doc.space,doc.path,false,undefined,true)).text,memoryState(doc.state),html`<span class="nowrap">${number(doc.bytes)} 字节</span>`,timestamp(doc.updated_at),directoryName(doc.path)]));
  const team=scope==='team',canWrite=!local&&(scope==='personal'||scope==='all')||team&&ctx.admin;
  const usage=scope==='personal'||team&&ctx.admin?await memory.usage(ctx.principal,team?'team':ctx.principal.id):null;
  if(canWrite&&ctx.url.searchParams.get('edit')==='1')return {status:200,body:page(ctx.chrome('新建记忆',{active:'knowledge'}),await spaceLayout(ctx,pageLayout(memoryEditor(ctx,team?'team':'personal'),{inspector:null})))};
  const controls=canWrite?button(location({scope:team?'team':'personal',edit:'1'}),actionLabel('create'),{primary:true}):html``;
  let grant=html``;
  if(scope==='personal'&&!local){
   const audience=await currentAudience(ctx,ctx.principal.id,path,false,undefined,true);
   grant=await grantDialog(ctx,{id:'memory-grants',trigger:false,current:audience.text,content:directoryName(path)+' · 只读，含全部子文件夹',checks:await memory.precheckGrant(ctx.principal,path),grants:(await memory.grants(ctx.principal)).filter(g=>containsDirectory(g.path,path)),fields:html`<input type="hidden" name="path" value="${path}">`,form:(action,fields,label,disabled)=>form(ctx,action,fields,label,disabled)});
  }
  const selectedSync=syncSelected(ctx)&&(scope==='personal'||scope==='all'),syncPanel=scope==='personal'||scope==='all'?await personalSyncNotice(ctx):html``;
  content=pageLayout(html`${tabs}${result}${selectedSync?'':syncPanel}${grant}${usage?html`<p title="标题、文件夹与正文计入启用内容；旧版本及停用文档不占启用额度，版本记录占用计入私人容量">${uiLabelOf('memory_field','active_content')} ${capacitySize(usage.active)} / ${capacitySize(usage.limits.spaceBytes)} · ${uiLabelOf('memory_field','active_documents')} ${number(usage.activeDocuments)} / ${number(usage.limits.spaceDocuments)} · 单篇正文上限 ${capacitySize(usage.limits.documentBytes)}</p>`:''}${canWrite&&ctx.url.searchParams.get('edit')==='1'?memoryEditor(ctx,team?'team':'personal'):''}${card({title:memoryLabel(),hint:'分享给其他账户的记忆只能查看，不自动加载到其会话；团队与本人启用记忆具备会话读取资格'},table(['标题','分享范围','状态','大小','更新时间','位置'],rows,{title:'还没有记忆',text:'客户端会话写入的记忆和在这里新建的记忆列在这里；启用的记忆可用于新会话。',...(canWrite?{action:emptyAction(location({scope:team?'team':'personal',edit:'1'}),actionLabel('create'))}:{})}))}`,{...(selectedSync?{inspector:syncPanel,detail:true,back:link(location({scope}),'返回记忆')}:{}),actions:html`${scope==='personal'&&!local?html`<a class="ch-btn ch-btn--secondary" href="#memory-grants">分享…</a>`:''}${controls}`});
 }
 return {status:200,body:page(ctx.chrome(memoryLabel(),{active:'knowledge',hint:'记忆只用于客户端会话；知识与记忆的分享设置分别管理'}),await spaceLayout(ctx,content))};
}

function memoryEditor(ctx:PageContext,space:KnowledgeSpaceKind,doc?:{document:string;current_version:string;title:string;path:string;markdown:string;state:string}):Html{
 const back=location({scope:ctx.url.searchParams.get('scope')??(space==='team'?'team':'personal'),document:doc?.document,version:ctx.url.searchParams.get('version')??undefined,path:ctx.url.searchParams.get('path')??undefined});
 return html`<section data-editor-foreground>${card({title:actionLabel(doc?'edit':'create'),hint:'纯文本保存，不执行 Markdown；保存检查大小与疑似凭据，版本变化时拒绝覆盖'},form(ctx,'write',html`<div data-fields><input type="hidden" name="space" value="${space}"><input type="hidden" name="document" value="${doc?.document??''}"><input type="hidden" name="expected_version" value="${doc?.current_version??''}"><input type="hidden" name="client_key" value="${newId('evt')}">${field('标题',html`<input name="title" value="${doc?.title??''}" required maxlength="300">`)}${field('文件夹',html`<input name="path" value="${doc?.path??ctx.url.searchParams.get('path')??'/'}" required maxlength="2000">`)}${field('状态',html`<select name="enabled"><option value="true">${uiLabelOf('memory_status','enabled')}</option><option value="false"${doc?.state==='disabled'?html` selected`:''}>${uiLabelOf('memory_status','disabled')}</option></select>`)}<div data-wide-field>${field('Markdown 正文',html`<textarea name="markdown" rows="6" required>${doc?.markdown??''}</textarea>`)}</div></div>`,actionLabel('save'),false,false,back))}</section>`;
}

export async function performMemoryAction(ctx:PageContext,action:string,values:{get(key:string):string|null|undefined}):Promise<string>{
 const memory=ctx.deps.knowledge.memory;if(!memory)throw new AccessError('对象不存在或无权读取');
 const get=(key:string)=>values.get(key)??'';
 if(get('space')!=='team')await checkPersonalFormEpoch(ctx,get('personal_epoch'));
 if(action==='write'){
  const document=get('document'),enabled=get('enabled');
  const saved=await memory.write(ctx.principal,{space:get('space')||'personal',...(document?{document}:{}),expected_version:get('expected_version')||null,...Object.fromEntries(['title','path','markdown'].filter(key=>values.get(key)!==null&&values.get(key)!==undefined).map(key=>[key,get(key)])),...(enabled?{enabled:enabled==='true'}:{}),client_key:get('client_key')});
  return location({scope:saved.space==='team'?'team':'personal',document:saved.document});
 }
 if(isKnowledgeGrantAction(action)){
  if(action==='grant'&&get('preview_grant')==='1')return grantPreviewLocation('/console/knowledge',{view:'memory',scope:'personal',path:get('path')},'memory-grants',values);
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
