import {createHash} from 'node:crypto';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {pathToFileURL} from 'node:url';

function canonical(value:any):string{if(value===null||typeof value!=='object')return JSON.stringify(value);if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;return `{${Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;}
export function normalize(fragments:any[]):any{
  const candidates=new Map<string,any>(),unmapped=[];
  for(const fragment of fragments){
    if(fragment.sharingAllowed!==true||!['fact','practice','correction'].includes(fragment.kind)||typeof fragment.subject!=='string'||typeof fragment.predicate!=='string'||typeof fragment.quote!=='string'||!Array.isArray(fragment.evidence)||fragment.evidence.length===0){unmapped.push({id:fragment.id??null,reason:'Unshared or unsupported structured fragment'});continue;}
    const claim={subject:fragment.subject,predicate:fragment.predicate,value:fragment.value,conditions:fragment.conditions??{}},key=createHash('sha256').update(canonical(claim)).digest('hex');
    const old=candidates.get(key)??{key,claim,evidence:[],fragments:[],kind:fragment.kind,state:'candidate',visibility:'personal',knowledgeCategory:'consolidated'};
    old.fragments.push({id:fragment.id,kind:fragment.kind,quote:fragment.quote,toolReturn:fragment.toolReturn??null,sourceRecordId:fragment.sourceRecordId});
    for(const ref of fragment.evidence)if(!old.evidence.some((prior:any)=>prior.evidenceId===ref.evidenceId&&prior.sha256===ref.sha256))old.evidence.push(ref);candidates.set(key,old);
  }return {candidates:[...candidates.values()].sort((a,b)=>a.key.localeCompare(b.key)),unmapped,ruleVersion:'shared-fragment-normalization/1'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const input=JSON.parse(await readFile(process.argv[2],'utf8')),output=process.argv[3]??'out/normalized.json';await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(normalize(input.fragments??[]),null,2)+'\n');}
