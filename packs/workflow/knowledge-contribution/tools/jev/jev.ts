#!/usr/bin/env node
// Client skill entry point; credentials only enter through stdin, never Hub storage.
import { parseArgs } from 'node:util';
import { Hub, type Piece } from './lib/hub.ts';
import { Judge, questionWork } from './lib/judge.ts';
import { allowedKinds, readPiece } from './lib/pieces.ts';
import { JevError } from './lib/errors.ts';
import { checkModel } from './lib/validate.ts';
import { readJsonFile, secureUrl, readKeys, secretGuard, LocalStore, need, record, Refusal } from './lib/local.ts';
export interface Io { cwd: string; stdin: AsyncIterable<Uint8Array|string>; stdout: (line:string)=>void; stderr:(line:string)=>void }
export async function main(args: string[], io: Io = { cwd:process.cwd(),stdin:process.stdin,stdout:s=>process.stdout.write(s+'\n'),stderr:s=>process.stderr.write(s+'\n') }): Promise<number> {
  let activeJudge:Judge|null=null;
  try {
    const action=args[0]; need(action==='ask'||action==='calibrate'||action==='place'||action==='lock'||action==='submit','子命令是 ask、calibrate、place、lock 或 submit；查看 SKILL.md');
    const {values,positionals}=parseArgs({args:args.slice(1),allowPositionals:false,strict:true,options:{hub:{type:'string'},model:{type:'string'},out:{type:'string'},'base-url':{type:'string'},input:{type:'string'},root:{type:'string'},under:{type:'string'},pieces:{type:'string'},from:{type:'string'},limit:{type:'string'},'dry-run':{type:'boolean'},product:{type:'string'},build:{type:'string'},proposals:{type:'string'},skip:{type:'string',multiple:true},send:{type:'string',multiple:true},'timeout-ms':{type:'string'}}});
    need(positionals.length===0&&values.hub&&values.out,'缺少 --hub 或 --out；按 SKILL.md 填完整命令');
    const judging=action!=='lock'&&action!=='submit'; need(judging?!!values.model:values.model===undefined,'ask/calibrate/place 必须给确切 --model；lock/submit 不给 --model');
    if(values['timeout-ms']!==undefined)need(Number.isSafeInteger(Number(values['timeout-ms']))&&Number(values['timeout-ms'])>=1&&Number(values['timeout-ms'])<=600000,'--timeout-ms 必须为 1 到 600000 的整数；修正参数后重跑');
    const model=judging?checkModel(values.model,false):'';secureUrl(values.hub);if(judging)secureUrl(values['base-url']??'https://api.typesafe.ai',model);
    const keys=await readKeys(io.stdin,judging);const guard=secretGuard([keys.hub,...(judging?[keys.jev]:[])]);guard(values);const store=await LocalStore.open(values.out,io.cwd,guard);const hub=new Hub(values.hub,keys.hub,guard);
    const send=(values.send??[]).flatMap(v=>v.split(','));const allowed=allowedKinds(send);
    const judge=judging?new Judge(model,()=>keys.jev,values['base-url'],store,send,{...(values['timeout-ms']?{timeoutMs:Number(values['timeout-ms'])}:{})}):null;activeJudge=judge;await judge?.load();
    if(action==='ask'){
      need(values.input,'缺少 --input；给出 jev-ask@1 文件');const input=await readJsonFile(values.input,io.cwd,guard);guard(input);need(record(input)&&Array.isArray(input.pieces),'ask 输入缺少 pieces；照合成样例填写');
      need(input.pieces.every((p:unknown)=>record(p)&&typeof p.id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(p.id)&&p.id!=='__proto__'&&typeof p.reference==='string')&&new Set(input.pieces.map((p:any)=>p.id)).size===input.pieces.length,'片段标识重复或形状错误；只给 id 和精确引用');
      const pieces:Piece[]=[];for(const piece of input.pieces)pieces.push(await readPiece(hub,piece.id,piece.reference,allowed));
      const works=questionWork(input,pieces,model);const results:Array<Awaited<ReturnType<Judge['ask']>>> = [];let next=0;
      const worker=async()=>{for(;;){const at=next++;if(at>=works.length)break;results[at]=await judge!.ask(works[at]!);}};await Promise.all([worker(),worker()]);
      const answers=Object.assign({},...results.map(v=>v.answers));const failed=results.flatMap(v=>v.failed);
      await store.write('answers.json',{model,answers,failed},true);
      for(const [id,value] of Object.entries(answers) as Array<[string,any]>){const answer=value.answer;io.stdout(answer.type==='noul'?`${id}：是 p=${answer.noul}，Jev@${model}`:answer.type==='choice'?`${id}：${answer.choice} p=${answer.probabilities[answer.choice]}，Jev@${model}`:`${id}：期望等级 ${answer.score}，各级概率 ${JSON.stringify(answer.probabilities)}，Jev@${model}`);}
      io.stdout(`这次实际外发片段 ${judge!.sentFragments.size} 个，种类 ${[...new Set(judge!.sentFragments.values())].join('、')||'无（回答已复用）'}；选择加入 ${send.join('、')||'无'}；判断只作客户端判断，不是事实`);
      if(failed.length){for(const id of failed)io.stderr(id+'：'+(judge!.failures.get(id)??'未得到回答，稍后重跑'));io.stderr('有题没有回答；核对密钥、限额和服务后重跑，已完成回答会复用；本地超时不证明对方没处理，可能已计费');return 3;}return 0;
    }
    const {runWorkflow}=await import('./lib/workflow.ts');return await runWorkflow(action,{values,hub,judge,store,allowed,model,io});
  }catch(error){
    if(error instanceof Refusal){io.stderr(error.message);return activeJudge&&activeJudge.attempts>0?3:error.code;}
    if(error instanceof JevError){io.stderr(error.status===null?error.message:`Jev ${error.code}（HTTP ${error.status}）；核对服务后重跑`);return error.attempts>0?3:1;}
    io.stderr(`客户端本地异常（${error instanceof Error?error.name:'Unknown'}）；保留已有记录并核对 SKILL.md 后重跑，服务应答正文不显示`);return activeJudge&&activeJudge.attempts>0?3:1;
  }
}
if(import.meta.main)process.exitCode=await main(process.argv.slice(2));
