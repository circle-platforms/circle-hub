import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../../',import.meta.url));
const packages=['packages/connectors/','packages/object-mappings/','packages/methods/','packages/policies/'];
const specific=/bugzilla|zentao|禅道|lbx|mindmaps?|defect[-_]review|openkm|jira|apv|photon|meridian|xmind/i;
const productLine=/apv|photon|meridian|xmind/i;

async function files(directory:string):Promise<string[]>{
  const result:string[]=[];
  for(const entry of await readdir(`${root}${directory}`,{withFileTypes:true})){
    const path=`${directory}/${entry.name}`;
    if(entry.isDirectory())result.push(...await files(path));
    else if(/\.(ts|json)$/.test(entry.name))result.push(path);
  }
  return result;
}

test('Act S2.7: core contains no specific system product or capability knowledge',async()=>{
  const violations:{path:string;lines:number[]}[]=[];
  for(const path of [...await files('apps'),...await files('packages')].sort()){
    const pattern=packages.some(allowed=>path.startsWith(allowed))?productLine:specific;
    const lines=(await readFile(`${root}${path}`,'utf8')).split('\n').flatMap((line,index)=>pattern.test(line)?[index+1]:[]);
    if(pattern.test(path))lines.unshift(0);
    if(lines.length)violations.push({path,lines});
  }
  assert.equal(violations.length,0,`Move specific behavior into declared packages: ${JSON.stringify(violations)}`);
});

test('Act S2.7: connector implementations contain no product-line names or product fixtures',async()=>{
  const violations:{path:string;lines:number[]}[]=[];
  for(const path of (await files('packages/connectors')).sort()){
    const lines=(await readFile(`${root}${path}`,'utf8')).split('\n').flatMap((line,index)=>productLine.test(line)?[index+1]:[]);
    if(productLine.test(path))lines.unshift(0);
    if(lines.length)violations.push({path,lines});
  }
  assert.equal(violations.length,0,`Move product fixtures into declared packages: ${JSON.stringify(violations)}`);
});
