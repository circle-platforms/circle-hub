// Synthetic in-memory persistence boundary for the actual lazy catalog traversal. Unselected entry bodies are never made.
import {selectCatalog} from '../catalog-selection.ts';
import type {CatalogSelectionInput} from '../catalog-selection.ts';
const digest=(index:number)=>index.toString(16).padStart(64,'0');
const planned=Number(process.argv[2]??2);
const indexes=Array.from({length:planned},(_,index)=>index===planned-1&&planned>1?11999:17+index);
const lines=indexes.map(index=>'cmd'+index+' 7');
const count=12000,root=digest(99999),entryReads:string[]=[],rowReads:string[]=[],nodeReads:string[]=[];
const nodes=new Map<string,import('../../../contracts/src/knowledge.ts').TreeNodeBody>();
for(let index=0;index<count;index++)nodes.set(digest(index+1),{height:0,name:'cmd'+index,level:'leaf',entries:[digest(index+20000)],children:[]});
const trunk:import('../../../contracts/src/knowledge.ts').TreeNodeBody={height:1,name:'commands',level:'branch',entries:[],children:Array.from({length:count},(_,index)=>({name:'cmd'+index,digest:digest(index+1)})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)};
const input:CatalogSelectionInput={root,selection:{base:'/commands',lines:[...lines,lines[0],'cmd17000 7']},declaration:{id:'commands@1',entry_kind:'definition',complete:true,case_sensitive:true,declared_complete:true,members:count,incomplete_reason:null},
 async nodeAt(){return {digest:root,node:trunk};},
 async node(id){nodeReads.push(id);return nodes.get(id)??null;},
 async rowsAt(path){rowReads.push(path);const index=Number(path.slice('/commands/cmd'.length));const entry=digest(index+20000);return new Map([[entry,{entry,path,kind:'definition',producers:['fixture'],fragments:[`src:${root}/xml@1/x`],basis:'source_structure',decided_by:'fixture@1'}]]);},
 async entries(ids){entryReads.push(...ids);return new Map(ids.map(id=>{const index=parseInt(id,16)-20000;return [id,{kind:'definition',statement:'合成说明'.repeat(1024),data:{words:['cmd'+index],signatures:[{params:[{name:'count',type:'int',minimum:1,maximum:9}]}]},applicability:null}];}));},
};
const before=process.resourceUsage().maxRSS;
const view=await selectCatalog(input);
console.log(JSON.stringify({count,planned,entries:view.entries().map(entry=>entry.words.join(' ')),nodeReads:nodeReads.length,rowReads:rowReads.length,entryReads:entryReads.length,peakKiB:process.resourceUsage().maxRSS,increaseKiB:process.resourceUsage().maxRSS-before}));
