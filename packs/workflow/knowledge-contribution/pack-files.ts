import {readFileSync} from 'node:fs';
import {contributionSlots} from '../../../tools/slot-schema.ts';
// Derive the output vocabulary from the model; never maintain a second enumeration in this pack.
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { READ_TIER, ENTRY_KIND, DOCUMENT_OUTPUT_KIND, RELATION_KIND, PROVENANCE_TYPE, labelOf } from '../../../contracts/generated/vocabulary.ts';
import { FEEDING_SCHEMAS } from '../../../contracts/src/feeding.ts';
import { MAX_UPLOAD_BYTES } from '../../../contracts/src/tools.ts';
import { CREDENTIAL_SCANNER } from '../../../hub/records/scan.ts';
import { operationSchema } from '../../../hub/knowledge/declaration-grade.ts';
import { manifestProblems, signManifest } from '../case-review/packaging.ts';
const directory = fileURLToPath(new URL('./', import.meta.url));
export function slots(){
 const schema=JSON.parse(readFileSync(new URL('../../../contracts/generated/schemas/contribution-input.v1.schema.json',import.meta.url),'utf8'));
 return contributionSlots(schema,DOCUMENT_OUTPUT_KIND.map(code=>({code,label:labelOf('document_output_kind',code)})));
}
export const VERSION = '1.3.2';
export function generated() {
  const axis = (name: string, values: readonly string[]) => values.map(code => ({code,label:labelOf(name as 'entry_kind',code as never)}));
  return {id:'knowledge-contribution',version:VERSION, model_readable:READ_TIER.find(code=>code==='model_readable'), axes: {entry_kind:axis('entry_kind',ENTRY_KIND),document_output_kind:axis('document_output_kind',DOCUMENT_OUTPUT_KIND),relation_kind:axis('relation_kind',RELATION_KIND),read_tier:axis('read_tier',READ_TIER)}};
}
export function operationGenerated() {
  const operation_kinds=Object.fromEntries(ENTRY_KIND.flatMap(kind=>{const id=`fed-${kind}@1`;return operationSchema(id)&&Object.hasOwn(FEEDING_SCHEMAS,id)?[[kind,id]]:[];}));
  return {id:'knowledge-contribution',version:VERSION,assertion:DOCUMENT_OUTPUT_KIND.find(code=>code==='assertion'),provenance_type:PROVENANCE_TYPE.find(code=>code==='client_captured'),event_schema:'operation-capture-event@1',proposal_schema:'operation-integration@1',operation_kinds,scanner:CREDENTIAL_SCANNER};
}
export function egress() { return {default_entry_kinds:ENTRY_KIND.filter(code=>code==='definition'||code==='behaviour'),opt_in_src:'src',max_instructions_chars:2000,max_description_chars:160}; }
export function operationEgress() { return {max_capture_bytes:MAX_UPLOAD_BYTES,max_manifest_bytes:64*1024*1024,max_input_summary_chars:4096,max_proposals:100,http_timeout_ms:20000}; }
export async function verifyInstall(target: string, prefix = 'tools/jev/'): Promise<string[]> {
  if(!['tools/jev/','tools/operation-capture/'].includes(prefix))throw new Error('未知技能目录');
  const manifest=JSON.parse(await readFile(join(directory,'pack.json'),'utf8'));
  const expected=new Map<string,{sha256:string;size:number}>(manifest.files.filter((f:{path:string})=>f.path.startsWith(prefix)).map((f:{path:string;sha256:string;size:number})=>[f.path.slice(prefix.length),f]));
  const seen=new Set<string>(); const problems:string[]=[];
  const walk=async(dir:string,rel=''):Promise<void>=>{ for(const name of await readdir(dir)){const path=rel?rel+'/'+name:name;const file=join(dir,name);const stat=await lstat(file);if(stat.isDirectory()&&!stat.isSymbolicLink())await walk(file,path);else{seen.add(path);const entry=expected.get(path);if(!entry||!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1){problems.push(path);continue;}const bytes=await readFile(file);if(bytes.length!==entry.size||createHash('sha256').update(bytes).digest('hex')!==entry.sha256)problems.push(path);}}};
  const root=await lstat(target);if(!root.isDirectory()||root.isSymbolicLink())return ['.'];await walk(target);for(const path of expected.keys())if(!seen.has(path))problems.push(path);return [...new Set(problems)].sort();
}
if(import.meta.main){
  if(process.argv[2]==='--verify-install'){
    const target=process.argv[3];if(!target)throw new Error('需要安装目录');
    const skill=process.argv.length===4?'jev':process.argv.length===6&&process.argv[4]==='--skill'?process.argv[5]:undefined;
    if(skill!=='jev'&&skill!=='operation-capture')throw new Error('用法：--verify-install <目录> [--skill jev|operation-capture]');
    const problems=await verifyInstall(target,`tools/${skill}/`);if(problems.length)throw new Error('安装不符：'+problems.join('、'));console.log('安装文件与发布清单一致');
  }
  else {
    const files=new Map<string,unknown>([['slots.schema.json',slots()],['tools/jev/generated.json',generated()],['tools/jev/egress.json',egress()],['tools/operation-capture/generated.json',operationGenerated()],['tools/operation-capture/egress.json',operationEgress()]]);
    if(process.argv.includes('--check')){
      const problems=await manifestProblems(directory);const manifest=JSON.parse(await readFile(join(directory,'pack.json'),'utf8'));if(manifest.id!==generated().id||manifest.version!==generated().version)problems.push('pack identity differs from generated snapshot');for(const [path,value] of files)if(await readFile(join(directory,path),'utf8')!==JSON.stringify(value,null,2)+'\n')problems.push(path+' differs from generated vocabulary');
      if(problems.length)throw new Error(problems.join('\n'));console.log('knowledge-contribution: generated vocabulary and manifest match');
    }else{
      const path=join(directory,'pack.json');const manifest=JSON.parse(await readFile(path,'utf8'));manifest.version=VERSION;await writeFile(path,JSON.stringify(manifest,null,2)+'\n');
      for(const [name,value] of files)await writeFile(join(directory,name),JSON.stringify(value,null,2)+'\n');await signManifest(directory);
    }
  }
}
