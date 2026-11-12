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

/** The three inputs a reader most often gets wrong, said the same way in the editors and where a save was refused (issue 234). */
export const MARKDOWN_FIELD={label:'正文（可使用 Markdown 文本）',hint:'按填写的文字原样保存；页面不渲染 Markdown，也不转换格式'} as const;
export const DATA_FIELD={label:'结构化数据（可选 JSON）',hint:'留空表示没有；填写须是 JSON 对象，例如 {"字段":"值"}'} as const;
export const APPLICABILITY_FIELD={label:'适用条件（可选 JSON）',hint:'产品线、版本和运行环境等条件，须是 JSON 对象；留空表示未声明，不要求产品包'} as const;
const FIELD_NAME:Record<string,string>={data:'结构化数据',applicability:'适用条件',markdown:'正文'};
const FIELD_PROBLEM:Record<string,string>={
 data:'这里填的不是 JSON 对象。写成 {"字段":"值"} 这样；不需要时留空。',
 applicability:'这里填的不是 JSON 对象。写成 {"产品线":"值"} 这样；没有适用条件时留空。',
 markdown:'正文超过了大小上限；请缩短后再保存。',
};
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
 // What is wrong with the field, in the field's own terms (issue 234): a reader is not left to guess from a general line.
 const inline=(name:string)=>invalid.has(name)?html`<span class="ch-field-error" id="editor-${name}-error" data-field-error>${FIELD_PROBLEM[name]??'请核对此字段的格式、大小和填写要求。'}</span>`:html``;
 const hidden=(name:string,value:string)=>html`<input type="hidden" name="${name}" value="${value}">`;
 const input=(label:string,name:string,value:string,required=false)=>field(label,html`<input name="${name}" value="${value}"${required?html` required`:''}${described(name)}>`,undefined,inline(name));
 const area=(label:string,name:string,value:string,required=false,hint?:string)=>field(label,html`<textarea name="${name}" rows="${name==='markdown'?14:4}"${required?html` required`:''}${described(name)}>${value}</textarea>`,hint,inline(name));
 const identity=(name:string)=>Sha256.safeParse(values.get(name)).success?values.get(name)!:'';
 const space=memory?values.get('space')==='team'?'team':'personal':values.get('space')==='team'?'team':ctx.principal.id;
 const tokens=html`${hidden('csrf',ctx.csrf??'')}${hidden('space',space)}${hidden('personal_epoch',safe('personal_epoch'))}${hidden('expected_version',identity('expected_version'))}${memory?html`${hidden('document',identity('document'))}${hidden('client_key',newId('evt'))}`:hidden('replaces',identity('replaces'))}`;
 let fields:Html;
 if(memory){
  const enabled=values.get('enabled')!=='false';
  fields=html`${input('标题','title',safe('title'),true)}${input('文件夹','path',safe('path'),true)}${field('状态',html`<select name="enabled"><option value="true"${enabled?html` selected`:''}>${uiLabelOf('memory_status','enabled')}</option><option value="false"${!enabled?html` selected`:''}>${uiLabelOf('memory_status','disabled')}</option></select>`)}${area(MARKDOWN_FIELD.label,'markdown',safe('markdown'),true,MARKDOWN_FIELD.hint)}`;
 }else{
  const kind=values.get('kind');let count=3;for(let i=0;i<100;i++)if(values.get('ground_'+i)||values.get('quotation_'+i))count=Math.max(count,i+1);
  fields=html`${input('文件夹路径','path',safe('path'),true)}${field('类型',html`<select name="kind">${ENTRY_KIND.map(value=>html`<option value="${value}"${value===kind?html` selected`:''}>${uiLabelOf('entry_kind',value)}</option>`)}</select>`)}${area('陈述','statement',safe('statement'),true)}${area(DATA_FIELD.label,'data',safe('data'),false,DATA_FIELD.hint)}${area(APPLICABILITY_FIELD.label,'applicability',safe('applicability'),false,APPLICABILITY_FIELD.hint)}${Array.from({length:count},(_,i)=>html`${input('来源引用 '+(i+1),'ground_'+i,safe('ground_'+i)||(i===0?safe('source_pick_0'):''))}${area('逐字引文 '+(i+1),'quotation_'+i,safe('quotation_'+i))}`)}${input('修改原因','reason',safe('reason'),true)}`;
 }
 const code=error instanceof KnowledgeError?error.code:null;
 const cleanMessage=(text:string,fallback:string)=>{const scan=scanForCredentials(Buffer.from(text));return scan.inspected&&!scan.truncated&&!scan.findings.length?text:fallback;};
 const message=error instanceof KnowledgeError?cleanMessage(error.message,code?PROTOCOL_CODES[code].when:'条目或表单格式不正确'):invalid.size?`${[...invalid].map(name=>FIELD_NAME[name]??name).join('、')}的格式不正确`:'条目或表单格式不正确',fix=error instanceof KnowledgeError?cleanMessage(error.fix??'',code?PROTOCOL_CODES[code].fix:'请核对输入。'):invalid.size?'请按下面标出的字段旁的说明修改后重新保存。':'请核对必填字段后重新保存。';
 const back=memory?'/console/knowledge?view=memory&scope='+space:'/console/knowledge/space?'+new URLSearchParams({space});
 return {status:400,body:page(ctx.chrome(memory?'记忆未保存':'条目未保存',{active:'knowledge'}),html`<section class="ch-section"><div role="alert" id="editor-error" tabindex="-1"><p class="error">${code?html`${code}：`:''}${message}</p>${capacityError(error)??''}<p>${fix}</p><p>本次保存已被拒绝；请修正输入。原版本条件保留，版本冲突时请先查看当前版本。</p>${omitted.length?html`<p>部分字段未回填：含疑似凭据或无法安全检查，请移除敏感内容后重新填写。</p>`:''}</div><form method="post" action="/console/knowledge/do/${action}" aria-describedby="editor-error">${tokens}<div data-fields>${fields}</div><button class="ch-btn ch-btn--primary" type="submit">${memory?'保存记忆':'保存条目'}</button></form><p>${link(back,'查看当前内容')}</p></section>`)};
}
