import {submissionOrigin} from './independence.ts';
// Reuse the evaluator's exact same subject construction; stop before classification and persistence.
import {Submission} from '../../../contracts/src/submission.ts';
import type {EffectCheckReplay} from '../../ports.ts';
import {createEngineContext,type RunsEngineDeps} from './deps.ts';
import {runById,submissionByDigest,resultFor} from './store.ts';
import {buildScope,createResolver,resolveSubmission} from './exact.ts';
import {evaluate,productionEvaluationInput} from './evaluate.ts';
import {authorOriginOf} from './lineage.ts';
import {isProduction} from './start.ts';
export async function recheckEffectChecks(deps:RunsEngineDeps,input:Parameters<EffectCheckReplay>[0]):ReturnType<EffectCheckReplay> {
 const ctx=createEngineContext(deps),store=deps.records.store;
 const saved=await runById(store,input.run);if(!saved)throw new Error('冻结运行不可回读；请管理员恢复运行记录后重核');
 if(ctx.parsers.forRun)ctx.parsers=await ctx.parsers.forRun(saved.body.run);
 const run=saved.body,workflow=await deps.workflows.byDigest(run.pack_digest);
 if(!workflow || workflow.pack.digest!==run.pack_digest || `${workflow.pack.id}@${workflow.pack.version}`!==run.pack)throw new Error('缺少冻结版本的任务包；请恢复原包后重核');
 // Both paths require an active reader; only submitted replay needs the reader value for source resolution.
 const requireReplayReader=async()=>{
   const user=await deps.records.principals?.get(run.runner??run.configurer??'');
   if(!user||user.disabled)throw new Error('缺少评估读取者的有效身份；请恢复授权后重核');
   return user;
 };
 const ids=new Set(input.checks);
 if(!ids.size || [...ids].some(id=>!workflow.checks.some(check=>check.id===id)))throw new Error('点名检查不在冻结的包里；请修正效果表后开始新修订');
 const result=await resultFor(store,run.run,input.submission),record=await submissionByDigest(store,run.run,input.submission);
 if(result?.body.acceptance!=='accepted')throw new Error('缺少已受理核验结果的原记录；请恢复记录后重核');
 // A production result is bound to the immutable run record, not to a model submission.
 if(input.submission===saved.digest&&isProduction(workflow)) {
   await requireReplayReader();
   const replay=await evaluate(ctx,{...productionEvaluationInput(run,workflow,saved.digest,result.body.trace),replayChecks:ids});
   return replay.outcomes;
 }
 const user=await requireReplayReader();
 if(!record)throw new Error('缺少已受理提交的原记录；请恢复记录后重核');
 const submission=Submission.parse(record.body);
 if(submission.run!==run.run)throw new Error('提交归属不符；请核对原运行和提交后重核');
 const scope=await buildScope(ctx,run,workflow,user,'function'),resolver=createResolver(ctx,scope,'function');
 const exact=await resolveSubmission(scope,resolver,workflow,run.items,submission);
 if(exact.errors.length)throw new Error('冻结提交的精确来源当前不能解析；请修复来源、受理或权限后重核');
 const replay=await evaluate(ctx,{run,workflow,submission,submissionDigest:input.submission,exact,carried:new Map(),roundsUsed:new Map(),origin:submissionOrigin(submission,[run.session??null]),author:await authorOriginOf(ctx,run),traceId:result.body.trace,replayChecks:ids});
 return replay.outcomes;
}
