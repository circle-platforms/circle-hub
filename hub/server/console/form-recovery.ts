import {z} from 'zod';
import {ENTRY_KIND,uiLabelOf} from '../../../contracts/generated/vocabulary.ts';
import {Sha256} from '../../../contracts/src/common.ts';
import {PROTOCOL_CODES} from '../../../contracts/generated/protocol.ts';
import {KnowledgeError} from '../../knowledge/api.ts';
import {newId,scanForCredentials} from '../../records/api.ts';
import {html,link,page,type Html} from './html.ts';
import {capacityError} from './capacity.ts';
import {field} from './presentation.ts';
import type {PageContext,PageResult} from './pages.ts';

type Values={get(key:string):string|null|undefined};

export function recoverEditor(ctx:PageContext,action:string,values:Values,error:unknown):PageResult|null{
 if(action!=='entry'&&action!=='memory-write'||action==='memory-write'&&values.get('markdown')==null)return null;
 if(error instanceof KnowledgeError&&(error.code===null||error.code.startsWith('SOURCE_')||error.code.startsWith('SYNC_')||error.code==='IDEMPOTENCY_MISMATCH'))return null;
 if(!(error instanceof KnowledgeError||error instanceof z.ZodError||error instanceof SyntaxError))return null;
 const memory=action==='memory-write',omitted:string[]=[];
 const safe=(name:string)=>{
  const text=values.get(name)??'',scan=scanForCredentials(Buffer.from(text));
  if(!scan.inspected||scan.truncated||scan.findings.length){omitted.push(name);return '';}
  return text;
 };
 const invalid=new Set<string>();
 if(error instanceof z.ZodError)for(const issue of error.issues)if(typeof issue.path[0]==='string')invalid.add(issue.path[0]);
 if(error instanceof SyntaxError)for(const name of ['data','applicability']){const text=values.get(name);if(text)try{JSON.parse(text);}catch{invalid.add(name);}}
 if(error instanceof KnowledgeError&&error.code==='MEMORY_DOCUMENT_LIMIT')invalid.add('markdown');
 const described=(name:string)=>invalid.has(name)?html` aria-invalid="true" aria-describedby="editor-${name}-error"`:html``;
 const inline=(name:string)=>invalid.has(name)?html`<span class="ch-field-error" id="editor-${name}-error" data-field-error>请核对此字段的格式、大小和填写要求。</span>`:html``;
 const hidden=(name:string,value:string)=>html`<input type="hidden" name="${name}" value="${value}">`;
 const input=(label:string,name:string,value:string,required=false)=>field(label,html`<input name="${name}" value="${value}"${required?html` required`:''}${described(name)}>`,undefined,inline(name));
 const area=(label:string,name:string,value:string,required=false)=>field(label,html`<textarea name="${name}" rows="${name==='markdown'?14:4}"${required?html` required`:''}${described(name)}>${value}</textarea>`,undefined,inline(name));
 const identity=(name:string)=>Sha256.safeParse(values.get(name)).success?values.get(name)!:'';
 const space=memory?values.get('space')==='team'?'team':'personal':values.get('space')==='team'?'team':ctx.principal.id;
 const tokens=html`${hidden('csrf',ctx.csrf??'')}${hidden('space',space)}${hidden('personal_epoch',safe('personal_epoch'))}${hidden('expected_version',identity('expected_version'))}${memory?html`${hidden('document',identity('document'))}${hidden('client_key',newId('evt'))}`:hidden('replaces',identity('replaces'))}`;
 let fields:Html;
 if(memory){
  const enabled=values.get('enabled')!=='false';
  fields=html`${input('标题','title',safe('title'),true)}${input('文件夹','path',safe('path'),true)}${field('状态',html`<select name="enabled"><option value="true"${enabled?html` selected`:''}>${uiLabelOf('memory_status','enabled')}</option><option value="false"${!enabled?html` selected`:''}>${uiLabelOf('memory_status','disabled')}</option></select>`)}${area('Markdown 正文','markdown',safe('markdown'),true)}`;
 }else{
  const kind=values.get('kind');let count=3;for(let i=0;i<100;i++)if(values.get('ground_'+i)||values.get('quotation_'+i))count=Math.max(count,i+1);
  fields=html`${input('文件夹路径','path',safe('path'),true)}${field('类型',html`<select name="kind">${ENTRY_KIND.map(value=>html`<option value="${value}"${value===kind?html` selected`:''}>${uiLabelOf('entry_kind',value)}</option>`)}</select>`)}${area('陈述','statement',safe('statement'),true)}${area('结构化数据（可选 JSON）','data',safe('data'))}${area('适用条件（可选 JSON）','applicability',safe('applicability'))}${Array.from({length:count},(_,i)=>html`${input('来源引用 '+(i+1),'ground_'+i,safe('ground_'+i))}${area('逐字引文 '+(i+1),'quotation_'+i,safe('quotation_'+i))}`)}${input('修改原因','reason',safe('reason'),true)}`;
 }
 const code=error instanceof KnowledgeError?error.code:null;
 const cleanMessage=(text:string,fallback:string)=>{const scan=scanForCredentials(Buffer.from(text));return scan.inspected&&!scan.truncated&&!scan.findings.length?text:fallback;};
 const message=error instanceof KnowledgeError?cleanMessage(error.message,code?PROTOCOL_CODES[code].when:'条目或表单格式不正确'):'条目或表单格式不正确',fix=error instanceof KnowledgeError?cleanMessage(error.fix??'',code?PROTOCOL_CODES[code].fix:'请核对输入。'):'请核对 JSON 格式和必填字段后重新保存。';
 const back=memory?'/console/knowledge?view=memory&scope='+space:'/console/knowledge/space?'+new URLSearchParams({space});
 return {status:400,body:page(ctx.chrome(memory?'记忆未保存':'条目未保存',{active:'knowledge'}),html`<section class="ch-section"><div role="alert" id="editor-error" tabindex="-1"><p class="error">${code?html`${code}：`:''}${message}</p>${capacityError(error)??''}<p>${fix}</p><p>本次保存已被拒绝；请修正输入。原版本条件保留，版本冲突时请先查看当前版本。</p>${omitted.length?html`<p>部分字段未回填：含疑似凭据或无法安全检查，请移除敏感内容后重新填写。</p>`:''}</div><form method="post" action="/console/knowledge/do/${action}" aria-describedby="editor-error">${tokens}<div data-fields>${fields}</div><button class="ch-btn ch-btn--primary" type="submit">${memory?'保存记忆':'保存条目'}</button></form><p>${link(back,'查看当前内容')}</p></section>`)};
}
