// Research extraction only: no producer, no I/O. core.mjs is copied from the pinned browser bundle by the test host.
// @ts-ignore -- the research dependency exists only in the temporary pack, not in the repository
import {load, getVersion} from './core.mjs';
import { posix } from 'node:path';

type Input = {root:string;files:Record<string,string>;memoryIncludes?:boolean;mode?:'extract'|'digest'|'native-include'|'write'|'spawn'|'network'};
type Line = {file:string;line:number;text:string};
// A deliberately small include adapter, not an AsciiDoc parser: whole-file local includes only, no options or I/O.
function expand(input:Input):Line[] {
  const attrs:Record<string,string>={},stack:string[]=[];
  const walk=(file:string):Line[]=>{
    if(stack.includes(file)||stack.length>=16) throw new Error('include cycle or depth limit');
    if(!Object.hasOwn(input.files,file)) throw new Error(`include not supplied: ${file}`);
    stack.push(file);const out:Line[]=[];
    for(const [i,text] of input.files[file].split('\n').entries()) {
      if(/\{(?:docdate|doctime|docdatetime|docyear|localdate|localtime|localdatetime|localyear)\}/.test(text)) throw new Error('clock-dependent attributes outside research subset');
      if(/^(?:ifdef|ifndef|ifeval|endif)::|^:![^:]+:|^:[^:]+!:/.test(text)) throw new Error('conditional or attribute-unset directive outside research subset');
      const attr=/^:([a-z][\w-]*):\s*(.*)$/.exec(text);if(attr)attrs[attr[1]]=attr[2];
      const inc=/^include::(.+)\[\]$/.exec(text);
      if(inc){
        const target=inc[1].replace(/\{([^}]+)\}/g,(_,key:string)=>{if(!Object.hasOwn(attrs,key))throw new Error('unresolved include attribute');return attrs[key];});
        if(/[:\\]/.test(target)||target.startsWith('/')||target.split('/').includes('..'))throw new Error('nonlocal include rejected');
        out.push(...walk(posix.normalize(posix.join(posix.dirname(file),target))));
      } else {
        if(/^include::/.test(text)) throw new Error('include options outside research subset');
        out.push({file,line:i+1,text});
      }
    }
    stack.pop();return out;
  };
  return walk(input.root);
}
const canonical=(value:any):string=>JSON.stringify(value,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
export default async function probe(input:Input):Promise<unknown> {
  if(input.mode==='network') return fetch('https://192.0.2.1/');
  if(input.mode==='write') {const fs=await import('node:fs/promises');return fs.writeFile('synthetic-output','blocked');}
  if(input.mode==='spawn') {const cp=await import('node:child_process');return cp.execFileSync('synthetic-command');}
  const start=performance.now();
  const mapped=input.mode==='native-include'||input.memoryIncludes===false?input.files[input.root].split('\n').map((text,i)=>({file:input.root,line:i+1,text})):expand(input);
  const text=mapped.map(l=>l.text).join('\n');
  const doc=await load(text,{safe:'secure',sourcemap:true,attributes:{reproducible:'',docfile:input.root}});
  const origin=(node:any)=>{
    const at=node.sourceLocation?.lineno;
    const row=typeof at==='number'?mapped[at-1]:undefined;
    return row?{file:row.file,line:row.line,src:`${row.file}:${row.line}`} : null;
  };
  const pathOf=(node:any)=>{const path:any[]=[];for(let n=node.context==='section'?node:node.parent;n&&n.context!=='document';n=n.parent)if(n.context==='section'&&n.level>0)path.unshift({title:n.getTitle(),level:n.level,id:n.getId()??null});return path;};
  const sections:any[]=[],tables:any[]=[],lists:any[]=[],blocks:any[]=[],signatures:any[]=[],examples:any[]=[];
  for(const node of doc.findBy()) {
    // Attribute changes in the body are stored as playback entries on blocks, not already applied by load().
    doc.playbackAttributes(node.attributes);
    const context=node.context,at=origin(node),path=pathOf(node);
    if(context==='section'&&node.level>0)sections.push({...at,path,title:node.getTitle(),level:node.level,id:node.getId()??null});
    if(context==='table')tables.push({...at,path,role:node.getRole()??null,rows:Object.fromEntries(['head','body','foot'].map(part=>[part,node.rows[part].map((row:any[])=>row.map(cell=>({text:cell.text,origin:origin(cell)})))]))});
    if(['ulist','olist','dlist'].includes(context))lists.push({...at,path,kind:context,items:node.getItems().map((item:any)=>({text:item.text??'',origin:origin(item)}))});
    if(['listing','literal'].includes(context)) {
      const source=node.getSource(),role=node.getRole()??null;
      // The AST locates a delimited block at its opening delimiter, not its verbatim first content line.
      const offset=(node.sourceLocation?.lineno??1)-1;
      const first=source.split('\n')[0];
      const sourceRow=mapped[offset]?.text===first?mapped[offset]:mapped[offset+1]?.text===first?mapped[offset+1]:undefined;
      if(!sourceRow)throw new Error('block source alignment not verified');
      const sourceAt={file:sourceRow.file,line:sourceRow.line,src:`${sourceRow.file}:${sourceRow.line}`};
      blocks.push({...sourceAt,path,kind:context,id:node.getId()??null,role,source});
      if(role==='signature')signatures.push({...sourceAt,path,id:node.getId()??null,signature_verbatim:source,expanded:node.subAttributes(source)});
      if(role==='example')examples.push({...sourceAt,path,source,reference_only:true});
    }
    if(context==='paragraph') {
      const source=node.getSource();
      // Candidate convention only: bold-starting paragraphs are not universally command signatures.
      if(/^\*{1,2}[^*]+\*{1,2}(?:\s|$)/.test(source))signatures.push({...at,path,id:node.getId()??null,signature_verbatim:source,expanded:node.subAttributes(source)});
    }
  }
  const result={schema:'adoc-research@1',engine:getVersion(),sections,tables,lists,blocks,signatures,examples};
  const serialized=canonical(result);
  console.log(JSON.stringify({parseAndExtractMs:performance.now()-start,maxRssKiB:process.resourceUsage().maxRSS,heapUsed:process.memoryUsage().heapUsed,inputBytes:Buffer.byteLength(text),outputBytes:Buffer.byteLength(serialized)}));
  if(input.mode==='digest')return {sections:sections.length,tables:tables.length,lists:lists.length,signatures:signatures.length,examples:examples.length,bytes:Buffer.byteLength(serialized)};
  return JSON.parse(serialized);
}
