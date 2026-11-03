// Real password sessions and uploads; queue rejection must remove unpacked files before the HTTP response ends.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {request} from 'node:http';
import {access,readFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {zipSync} from 'fflate';
import {createTestHub} from '../testing-real.ts';
import {openConsole,type ConsoleClient} from '../../../tests/acceptance/support/console.ts';
import {barrier} from '../../testing/member-freeze.ts';
import {temporaryDirectory,writePack} from '../../runs/api.ts';
import {wordingProblems} from './testing-wording.ts';

function upload(browser:ConsoleClient,bytes:Buffer,csrf:string){
 const boundary='synthetic-staging-boundary',body=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="csrf"\r\n\r\n${csrf}\r\n--${boundary}\r\nContent-Disposition: form-data; name="archive"; filename="synthetic.zip"\r\nContent-Type: application/zip\r\n\r\n`),bytes,Buffer.from(`\r\n--${boundary}--\r\n`)]);
 return new Promise<{status:number;body:string}>((resolve,reject)=>{
  const req=request({host:'127.0.0.1',port:browser.port,path:'/console/packs/do/stage',method:'POST',headers:{host:'127.0.0.1:'+browser.port,origin:'http://127.0.0.1:'+browser.port,cookie:'circle_hub_session='+browser.sessionCookie,'content-type':'multipart/form-data; boundary='+boundary,'content-length':String(body.length)}},res=>{const chunks:Buffer[]=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode??0,body:Buffer.concat(chunks).toString()}));});
  req.on('error',reject);req.setTimeout(10000,()=>req.destroy(new Error('synthetic busy upload did not answer while other checks were held')));req.end(body);
 });
}

test('a refused personal upload returns a busy page and releases its files before held checks finish',async t=>{
 const hub=await createTestHub({repositoryPacks:false,stubs:false,mindmapSkill:false,workbookSkill:false,xmlSkill:false,htmlSkill:false});t.after(()=>hub.close());
 const owner=await hub.createUser('合成繁忙发布成员'),browser=await openConsole(hub,owner.token),page=await browser.get('/console/packs/-/publish'),csrf=/name="csrf" value="([^"]+)"/.exec(page.body)?.[1];assert.equal(page.status,200);assert.ok(csrf);
 const temp=await temporaryDirectory();t.after(()=>temp.remove());const written=await writePack(join(temp.path,'skill'),{id:'synthetic-bounded-upload',version:'1.0.0',kind:'skill',title:'合成排队技能',description:'合成队列回归',files:{'SKILL.md':'# 合成排队技能\n\n核对合成输入。\n','skill.json':{schema:'skill@1',parsers:[]}}}),entries:Record<string,Uint8Array>={};
 for(const path of ['pack.json',...written.manifest.files.map(file=>file.path)])entries[path]=await readFile(join(written.dir,path));const zip=Buffer.from(zipSync(entries));
 const personal=hub.hub.registry.personal!,check=personal.check.bind(personal),directories:string[]=[];
 t.mock.method(personal,'check',async(by:Parameters<typeof check>[0],dir:string)=>{directories.push(dir);return check(by,dir);});
 const gate=barrier();let completed=0;const jobs=Array.from({length:3},()=>hub.records.personalPayloads!.withStagingSlot(owner.user.id,async()=>{await gate.promise;completed++;})),all=Promise.allSettled(jobs);
 try{
  for(let n=0;n<2;n++){
   const reply=await upload(browser,zip,csrf);assert.equal(reply.status,429,reply.body);assert.match(reply.body,/发布校验繁忙，请稍后重试/);assert.deepEqual(wordingProblems(reply.body),[]);assert.equal(completed,0);assert.equal(directories.length,n+1);
   await assert.rejects(access(directories[n]));await assert.rejects(access(dirname(directories[n])));assert.ok(!reply.body.includes(directories[n]));
  }
 }finally{gate.release();await all;}
 assert.equal(completed,3);const recovered=await upload(browser,zip,csrf);assert.equal(recovered.status,303,recovered.body);await access(directories.at(-1)!);
});
