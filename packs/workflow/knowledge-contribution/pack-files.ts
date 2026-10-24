// Derive the output vocabulary from the model; never maintain a second enumeration in this pack.
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { READ_TIER, ENTRY_KIND, DOCUMENT_OUTPUT_KIND, RELATION_KIND, labelOf } from '../../../contracts/generated/vocabulary.ts';
import { manifestProblems, signManifest } from '../case-review/packaging.ts';
const directory = fileURLToPath(new URL('./', import.meta.url));
export function slots() {
  const quote = { type: 'object', additionalProperties: false, required: ['reference', 'quote'],
    properties: { reference: { type: 'string' }, quote: { type: 'string' } } };
  return {
    schema: 'slots@1',
    item: { contribution: {
      min: 1, max: 1,
      codes: DOCUMENT_OUTPUT_KIND.map(code => ({ code, label: labelOf('document_output_kind', code) })),
      data: { type: 'object', additionalProperties: false, required: ['root', 'path', 'source'], properties: {
        root: { type: 'string' }, path: { type: 'string' }, source: quote,
        relation: { type: 'object', additionalProperties: false, required: ['kind', 'other'],
          properties: { kind: { enum: RELATION_KIND }, other: quote } },
      } },
    } },
    run: {},
  };
}
export const VERSION = '1.1.5';
export function generated() {
  const axis = (name: string, values: readonly string[]) => values.map(code => ({code,label:labelOf(name as 'entry_kind',code as never)}));
  return {id:'knowledge-contribution',version:VERSION, model_readable:READ_TIER.find(code=>code==='model_readable'), axes: {entry_kind:axis('entry_kind',ENTRY_KIND),document_output_kind:axis('document_output_kind',DOCUMENT_OUTPUT_KIND),relation_kind:axis('relation_kind',RELATION_KIND),read_tier:axis('read_tier',READ_TIER)}};
}
export function egress() { return {default_entry_kinds:ENTRY_KIND.filter(code=>code==='definition'||code==='behaviour'),opt_in_src:'src',max_instructions_chars:2000,max_description_chars:160}; }
export async function verifyInstall(target: string): Promise<string[]> {
  const manifest=JSON.parse(await readFile(join(directory,'pack.json'),'utf8')); const prefix='tools/jev/';
  const expected=new Map<string,{sha256:string;size:number}>(manifest.files.filter((f:{path:string})=>f.path.startsWith(prefix)).map((f:{path:string;sha256:string;size:number})=>[f.path.slice(prefix.length),f]));
  const seen=new Set<string>(); const problems:string[]=[];
  const walk=async(dir:string,rel=''):Promise<void>=>{ for(const name of await readdir(dir)){const path=rel?rel+'/'+name:name;const file=join(dir,name);const stat=await lstat(file);if(stat.isDirectory()&&!stat.isSymbolicLink())await walk(file,path);else{seen.add(path);const entry=expected.get(path);if(!entry||!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1){problems.push(path);continue;}const bytes=await readFile(file);if(bytes.length!==entry.size||createHash('sha256').update(bytes).digest('hex')!==entry.sha256)problems.push(path);}}};
  const root=await lstat(target);if(!root.isDirectory()||root.isSymbolicLink())return ['.'];await walk(target);for(const path of expected.keys())if(!seen.has(path))problems.push(path);return [...new Set(problems)].sort();
}
if(import.meta.main){
  if(process.argv[2]==='--verify-install'){const target=process.argv[3];if(!target)throw new Error('需要安装目录');const problems=await verifyInstall(target);if(problems.length)throw new Error('安装不符：'+problems.join('、'));console.log('安装文件与发布清单一致');}
  else {
    const files=new Map<string,unknown>([['slots.schema.json',slots()],['tools/jev/generated.json',generated()],['tools/jev/egress.json',egress()]]);
    if(process.argv.includes('--check')){
      const problems=await manifestProblems(directory);const manifest=JSON.parse(await readFile(join(directory,'pack.json'),'utf8'));if(manifest.id!==generated().id||manifest.version!==generated().version)problems.push('pack identity differs from generated snapshot');for(const [path,value] of files)if(await readFile(join(directory,path),'utf8')!==JSON.stringify(value,null,2)+'\n')problems.push(path+' differs from generated vocabulary');
      if(problems.length)throw new Error(problems.join('\n'));console.log('knowledge-contribution: generated vocabulary and manifest match');
    }else{
      const path=join(directory,'pack.json');const manifest=JSON.parse(await readFile(path,'utf8'));manifest.version=VERSION;await writeFile(path,JSON.stringify(manifest,null,2)+'\n');
      for(const [name,value] of files)await writeFile(join(directory,name),JSON.stringify(value,null,2)+'\n');await signManifest(directory);
    }
  }
}
