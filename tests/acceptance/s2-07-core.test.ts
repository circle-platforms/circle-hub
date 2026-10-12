import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../../',import.meta.url));
const packages=['packages/connectors/','packages/object-mappings/','packages/methods/','packages/policies/'];
const specific=/bugzilla|zentao|禅道|lbx|mindmaps?|defect[-_]review|openkm|jira/i;

async function files(directory:string):Promise<string[]>{
  const result:string[]=[];
  for(const entry of await readdir(`${root}${directory}`,{withFileTypes:true})){
    const path=`${directory}/${entry.name}`;
    if(packages.some(allowed=>path.startsWith(allowed)))continue;
    if(entry.isDirectory())result.push(...await files(path));
    else if(/\.(ts|json)$/.test(entry.name))result.push(path);
  }
  return result;
}

test('Act S2.7: core contains no specific system product or capability knowledge',async()=>{
  const violations:{path:string;lines:number[]}[]=[];
  for(const path of [...await files('apps'),...await files('packages')].sort()){
    const lines=(await readFile(`${root}${path}`,'utf8')).split('\n').flatMap((line,index)=>specific.test(line)?[index+1]:[]);
    if(specific.test(path))lines.unshift(0);
    if(lines.length)violations.push({path,lines});
  }
  assert.equal(violations.length,0,`Move specific behavior into declared packages: ${JSON.stringify(violations)}`);
});
