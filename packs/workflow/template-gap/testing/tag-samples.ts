// Exact declaration examples: the invalid case also remains undeclared, independently of its advisory violation.
import {writeFile} from 'node:fs/promises';
const subject=(resource:string[])=>({item:'synthetic-document',fields:{case_resources:[{case:'synthetic-case',present:true,resource}]}});
for(const polarity of ['positive','negative']){
 const sample={id:'tag_declaration_'+polarity,source:'author',check:'tag_declarations',note:'闭集原文完全相等，大小写不同属于未声明',subject:subject([polarity==='positive'?'functional':'Functional']),expect:polarity==='positive'?[{verdict:'support',item:'synthetic-document',tier:'advisory'}]:[{verdict:'refute',code:'template-gap.undeclared_tag',item:'synthetic-document',tier:'advisory'},{verdict:'unknown',reason:'missing_input',item:'synthetic-document',tier:'advisory'}]};
 await writeFile(new URL('../samples/'+polarity+'/tag-declaration.json',import.meta.url),JSON.stringify(sample,null,2)+'\n');
}
