import '../packages/contracts/src/hub-environment.ts';
import {requireCondition,type AuthContext} from '../packages/contracts/src/index.ts';
import {MindmapCompileInput,MindmapPack,MINDMAP_FLOW_VERSION} from './apv/contracts.ts';
import {CompilerExecution} from './apv/runtime/operations.ts';
import {MindmapRunner} from './apv/runtime/server.ts';
import {resourceMigration} from './apv/runtime/resource-migration.ts';
import {DefectReviewPack,ResourceCheckPack,PACK_FLOWS} from './synthetic/contracts.ts';
import {ProfessionalRunner} from './synthetic/runtime.ts';
import {Rules} from './synthetic/rules.ts';
import {CONNECTOR_MANIFESTS} from './synthetic/connectors.ts';
import {loadProductLines} from './product-lines.ts';
import {caseExecutionMigration} from './apv/runtime/execution-history-migration.ts';
import {executionHistoryReadonlyMigration} from './apv/runtime/execution-history-readonly-migration.ts';
const installed=await loadProductLines(process.env.CIRCLE_HUB_PRODUCT_LINES);
export const packageMigrations=[resourceMigration,caseExecutionMigration,executionHistoryReadonlyMigration];
export const packageConnectors=CONNECTOR_MANIFESTS;
export const installedProductLines=installed.productLines;
export const installedToolPackages=installed.toolPackages;

export function installPackages(services:any){
  const {store,auth,tasks,knowledge,execution,registry,checklists,approvals,assessments}=services;
  // Preserve the former unqualified task flow pin without relabeling its history.
  tasks.baseFlows.add('synthetic-lbx/1');
  registry.resourceTargets.add('RESOURCE-LAB-01');
  checklists.predicates.set('professional-opinion',(record:any)=>record.body.verdict==='supports');
  checklists.predicates.set('assessment-completed',(record:any)=>record.body.methodId==='resource-comparison'&&typeof record.body.observedTimeout==='number'&&typeof record.body.minimumTimeout==='number');
  checklists.predicates.set('configuration-conforms',(record:any)=>record.body.methodId==='resource-comparison'&&record.body.verdict==='supports');
  const compiler=new CompilerExecution(store,auth,tasks,knowledge),compilation=new MindmapRunner(store,tasks,knowledge,compiler);
  const rules=new Rules(store,auth,tasks,execution,registry),synthetic=new ProfessionalRunner(store,tasks,execution,knowledge,checklists,approvals,assessments);
  for(const [descriptor,flowVersion] of [[MindmapPack,MINDMAP_FLOW_VERSION],[DefectReviewPack,PACK_FLOWS['defect-review']],[ResourceCheckPack,PACK_FLOWS['synthetic-resource-check']]] as const)tasks.capabilities.set(descriptor.capabilityPackId,{version:descriptor.version,flowVersion});
  const operation=MindmapPack.requiredOperations[0];execution.capabilityOnlyOperations.add(operation);execution.customClaimers.set(operation,(ctx:AuthContext)=>compiler.claim(ctx));execution.customPreflights.set(operation,(ctx:AuthContext,id:string,fence:number,tx:any)=>compiler.preflight(ctx,id,fence,tx));execution.customReports.set(operation,(ctx:AuthContext,id:string,input:unknown)=>compilation.report(ctx,id,input));
  tasks.deliveryValidators.set(MindmapPack.capabilityPackId,async(_tx:any,task:any,result:any)=>{
    requireCondition(result.verification&&result.artifacts.length===1&&result.evidence.some((item:any)=>item.kind==='script-conclusion'),'EVIDENCE_INSUFFICIENT','Delivery requires independent fact verification');
    requireCondition(result.verification.artifactSha256===result.artifacts[0].sha256&&result.verification.sourceSha256===task.input.sourceSha256,'EVIDENCE_INSUFFICIENT','Delivery is not bound to the pinned input and artifact bytes');
    return [{itemId:'independent-workbook-readback',conclusionId:result.evidence.find((item:any)=>item.kind==='script-conclusion').evidenceId}];
  });
  const sourceInput=async(ctx:AuthContext,scope:string,value:unknown,tx?:any)=>{await auth.check(ctx,'methods.use',scope,tx);const input=MindmapCompileInput.parse(value),source=await knowledge.source(ctx,input.sourceRevisionId,scope,tx);requireCondition(!input.sourceSha256||input.sourceSha256===source.sha256,'SOURCE_HASH_MISMATCH','Submitted source hash differs');return {...input,sourceSha256:source.sha256};};
  return {
    descriptors:[MindmapPack,DefectReviewPack,ResourceCheckPack],rules,
    prepare:async(ctx:AuthContext,submission:any,tx:any)=>{
      requireCondition(!submission.capabilityPackId||tasks.capabilities.has(submission.capabilityPackId),'UNSUPPORTED_VERSION','Capability package is not installed');
      if(submission.capabilityPackId===MindmapPack.capabilityPackId)submission.input=await sourceInput(ctx,submission.scopeId,submission.input,tx);
      return submission.capabilityPackId===DefectReviewPack.capabilityPackId?rules.authorizeSubmission(ctx,submission.input,submission.scopeId,tx):undefined;
    },
    replacement:async(ctx:AuthContext,task:any,input:any)=>{if(task.capabilityPackId===MindmapPack.capabilityPackId){requireCondition(input.replacement,'INVALID_PAYLOAD','Compilation replacement requires a source');input.replacement=await sourceInput(ctx,task.scopeId,input.replacement);}},
    runOnce:async()=>{await compilation.runOnce();await rules.tick();await synthetic.runOnce();},
  };
}
