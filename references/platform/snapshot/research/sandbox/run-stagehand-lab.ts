import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const root=process.env.INFOSEC_LAB_ROOT!;
if(!root) throw new Error('Set INFOSEC_LAB_ROOT');
const require=createRequire(path.join(root,'runtime/package.json'));
const {Stagehand,localBrowser}=await import(path.join(root,'runtime/node_modules/@browserbasehq/stagehand/dist/index.mjs'));
const {chromium}=require('playwright');
let actual=0,modelCalls=0,browser:any;
const server=http.createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<html><body><button id="apply" onclick="this.textContent=\'Applied\';fetch(\'/effect\',{method:\'POST\'})">Apply</button></body></html>'); if(_req.url==='/effect'&&_req.method==='POST')actual++;});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
const startedAt=new Date().toISOString();let observation:any;
try{
 browser=await localBrowser.launch({executablePath:chromium.executablePath(),userDataDir:path.join(root,'private/stagehand-profile'),headless:false,args:['--disable-background-networking']});
 const stagehand=await Stagehand.create({browser,model:{generate:async()=>{modelCalls++;throw new Error('Real model access is forbidden in this research');}},logging:{level:'off'}});
 await browser.context.setDomainPolicy({allowedDomains:['127.0.0.1']});
 const page=await browser.context.newPage(`http://127.0.0.1:${(server.address() as any).port}/`);
 const result=await stagehand.act({selector:'#apply',description:'Apply synthetic local setting',method:'click',arguments:[]},{page});
 for(let i=0;i<30&&actual===0;i++) await new Promise(r=>setTimeout(r,100));
 const visible=await page.locator('#apply').innerText();observation={result,visible,independentEffectCount:actual,modelCalls};console.log(JSON.stringify(observation));assert.equal(actual,1);assert.equal(visible,'Applied');assert.equal(modelCalls,0);
 observation={result,visible,independentEffectCount:actual,modelCalls};
}finally{
 let closeError:string|undefined;try{if(browser)await browser.close();}catch(e:any){closeError=e.message;}
 server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));
 fs.writeFileSync(path.join(root,'evidence/stagehand-lab-receipt.json'),JSON.stringify({startedAt,endedAt:new Date().toISOString(),observation,closeError,browserHandleClosed:browser?.closed,scope:'Installed SDK local synthetic deterministic action, no hosted Browserbase or model evaluation'},null,2));
 console.log(JSON.stringify({observation,closeError}));
}
