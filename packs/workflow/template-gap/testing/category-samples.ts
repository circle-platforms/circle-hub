// Explicit synthetic author labels. Expected outcomes are fixed before invoking the checker, never copied from its output.
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import TABLE from '../tables/template-v3.json' with {type:'json'};
import {bind,projectionInput} from './support.ts';
import {projectDocuments} from '../functions/project.ts';
import {classificationSubject} from '../functions/classification-subject.ts';
import {LOCK} from './index.ts';
export function categorySampleSubject(ids:string[],skipped:unknown[]=[]){
 const nodes=ids.map((id,i)=>({data:{id:`c${i}`,text:`合成事项 ${i}`,priority:2,resource:['Functional'],category_ids:[id]},children:[{data:{id:`e${i}`,text:'合成结果'},children:[]}]}));
 const bytes=new TextEncoder().encode(JSON.stringify({root:{data:{id:'r',text:'合成分类范围'},children:nodes}}));
 const source=bind(bytes,{external:'agile:mindmap:880001'}),out=projectDocuments({...projectionInput([source]),context:LOCK});
 if('error'in out)throw new Error(out.error.message);
 const item=out.items[0];return classificationSubject({item:{...item,location:`src:${source.sha256}/kityminder@1/n/r`,fields:{...item.fields,skipped}},slots:{coverage:[]},context:{...LOCK,groups:out.groups}});
}
export async function writeCategorySamples(dir:string){
 const all=TABLE.categories.map(c=>c.id);
 const samples=[
 ['positive','coverage-all-covered.json','all_categories_covered',all,[],'support',undefined],
 ['positive','coverage-skipped-with-reason.json','missing_ones_skipped_with_reason',all.filter(id=>id!=='stress'),[{category:'stress',reason:'合成用户明确声明不适用'}],'support',undefined],
 ['negative','coverage-one-missing.json','one_test_type_missing',all.filter(id=>id!=='stress'),[],'refute','template-gap.category_shortfall'],
 ['negative','coverage-other-category-missing.json','one_other_category_missing',all.filter(id=>id!=='audit_log'),[],'refute','template-gap.category_shortfall'],
 ['negative','coverage-nothing-covered.json','nearly_nothing_covered',['functional'],[],'refute','template-gap.category_shortfall'],
 ['negative','coverage-blank-reason.json','skip_without_reason',all.filter(id=>id!=='stress'),[{category:'stress',reason:' '}],'refute','template-gap.category_invalid'],
 ] as const;
 for(const [polarity,file,id,ids,skipped,verdict,code] of samples){const sample={id,source:'author',check:'coverage',note:'合成原件的显式类别声明；不从正文匹配，期望由删去/加回的闭集声明预先决定',subject:categorySampleSubject([...ids],[...skipped]),expect:[{verdict,...(code?{code}:{}),item:'880001',tier:'advisory'}]};await writeFile(join(dir,'samples',polarity,file),JSON.stringify(sample,null,2)+'\n');}
}
