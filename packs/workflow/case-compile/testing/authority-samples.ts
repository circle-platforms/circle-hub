// Current synthetic author samples; no historical results or legacy bytes are rewritten.
import {writeFileSync} from 'node:fs';
import {fixture,cleanup} from './authority-scope.ts';
import {PROFILE_DOC,MANIFEST_DOC} from '../functions/test-support.ts';
import {runtimeDigest} from '../functions/runtime-contract.ts';
const save=(name:string,subject:unknown,code?:string,check='commands_catalog')=>writeFileSync(new URL(`../samples/${code?'negative':'positive'}/typed-${name}.json`,import.meta.url),JSON.stringify({id:name.replaceAll('-','_')+'_'+(code?'negative':'positive'),source:'author',check,note:'合成闭集命令范围、逆序清理、作者次数与台架容量',subject,expect:[{verdict:code?'refute':'support',...(code?{code}:{}),item:'doc-1:c-1',tier:'blocking'}]},null,2)+'\n');
const valid=['demo pool add one 10',cleanup('no demo pool add one')];
save('scope-authorized',fixture(valid).input.subject);
save('scope-missing-cleanup',fixture(['demo pool add one 10']).input.subject,'case-compile.method_forbidden');
save('scope-deleted-occurrence',fixture(valid,['demo pool add one 10','demo pool add one 10']).input.subject,'case-compile.method_forbidden');
const capacity=fixture(valid).input.subject;capacity.profile={...structuredClone(PROFILE_DOC),seats:[{...PROFILE_DOC.seats[0],ordinal:2}]};save('scope-bed-capacity',capacity,'case-compile.bed_unknown','contract_shape');
const example=fixture(valid).contract;example.contract_sha256=runtimeDigest(example);writeFileSync(new URL('../examples/runtime-contract-scope.json',import.meta.url),JSON.stringify(example,null,2)+'\n');
const forbidden=fixture(['demo poolish add one 10']).input.subject;save('scope-authorized',forbidden,'case-compile.method_forbidden');
save('scope-missing-cleanup',fixture(valid).input.subject);
save('scope-deleted-occurrence',fixture(['demo pool add one 10','demo pool add one 11',cleanup('no demo pool add one'),cleanup('no demo pool add one')],['demo pool add one 10','demo pool add one 10']).input.subject);
save('scope-bed-capacity',fixture(valid).input.subject,undefined,'contract_shape');
