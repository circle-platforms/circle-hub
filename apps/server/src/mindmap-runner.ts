import { ApiError, MINDMAP_PACK_VERSION, MINDMAP_CONTRACT_VERSION, MINDMAP_MAPPING_VERSION, WorkerReport, canonicalHash, sha256, type AuthContext } from '../../../packages/contracts/src/index.ts';
import type { Store } from '../../../packages/storage/src/index.ts';
import type { Tasks } from '../../../packages/tasks/src/index.ts';
import type { Knowledge } from '../../../packages/knowledge/src/index.ts';
import type { Execution } from '../../../packages/execution/src/index.ts';
import { parseMindmap } from '../../../packages/methods/src/mindmap.ts';
import { verifyMindmapWorkbook } from '../../../packages/methods/src/mindmap-verify.ts';

export class MindmapRunner {
  store: Store; tasks: Tasks; knowledge: Knowledge; execution: Execution;
  constructor(store: Store,tasks: Tasks,knowledge: Knowledge,execution: Execution) {
    this.store = store; this.tasks = tasks; this.knowledge = knowledge; this.execution = execution;
  }
  async runOnce(): Promise<void> {
    await this.execution.expire();
    const candidates = (await this.store.pool.query("SELECT task_id,principal_id,tenant_id FROM tasks WHERE capability_pack_id='mindmap-compile' AND phase='running' AND stage='inspect'")).rows;
    for (const candidate of candidates) await this.store.transaction(async tx => {
      const row = (await tx.query("SELECT * FROM tasks WHERE task_id=$1 AND stage='inspect' AND phase='running' FOR UPDATE SKIP LOCKED", [candidate.task_id])).rows[0];
      if (!row) return;
      const task = await this.tasks.load({ principalId: row.principal_id,tenantId: row.tenant_id,kind: 'user' },row.task_id,'tasks.read',tx);
      if (row.cancel_requested) { await this.tasks.stage(tx,task,'cancelled','done','task.cancelled',{ executionStarted: false }); return; }
      const operationId = await this.execution.enqueue(tx,task);
      await this.tasks.stage(tx,task,'waiting-resource','wait-worker','task.waiting-worker',{ operationId });
    });
  }
  async report(ctx: AuthContext,id: string,input: unknown): Promise<any> {
    const report = WorkerReport.parse(input);
    return this.store.transaction(async tx => {
      const old = await this.execution.lease(ctx,id,report.fencingToken,tx,true);
      if (['succeeded','failed'].includes(old.status)) {
        if (old.result.reportHash !== canonicalHash(report)) throw new ApiError('IDEMPOTENCY_MISMATCH','Completed worker operation received a different report');
        return { operationId:id,deduplicated:true };
      }
      const { row,task,source } = await this.execution.preflight(ctx,id,report.fencingToken,tx);
      if (task.inputRevisionId !== report.inputRevisionId) throw new ApiError('INPUT_REVISION_STALE','Worker receipt is for a different revision');
      const sourceObject = await this.knowledge.sourceBytes({ principalId: task.principalId,tenantId: task.tenantId,kind: 'user' },source.sourceRevisionId,task.scopeId,tx);
      if (report.status === 'failed') {
        let error = report.error!;
        try { parseMindmap(sourceObject.bytes,source.fileName); }
        catch (failure) { if (failure instanceof ApiError) error = { code: failure.code as typeof error.code,message: failure.message }; }
        const evidence = await this.knowledge.evidence(tx,task,id,'unknown',{ kind: 'worker-failure', error, sourceSha256: source.sha256 });
        await this.execution.complete(tx,row,'failed',{ error,evidence,reportHash:canonicalHash(report) }); await this.tasks.fail(tx,task,error,[evidence]);
        return { operationId: id,deduplicated: false,status: 'failed' };
      }
      const bytes = Buffer.from(report.artifactBase64!,'base64');
      const parsed = parseMindmap(sourceObject.bytes,source.fileName);
      const verification = await verifyMindmapWorkbook(bytes,parsed,source.sha256);
      const status = parsed.unmapped.length ? 'partial' : 'succeeded';
      if (report.status !== status) throw new ApiError('ARTIFACT_VERIFICATION_FAILED','Worker status differs from the parsed unmapped list');
      const artifact = await this.knowledge.artifact(tx,task,source.sourceRevisionId,bytes,{ packVersion: MINDMAP_PACK_VERSION,verification,unmapped: parsed.unmapped });
      if (artifact.sha256 !== verification.artifactSha256) throw new ApiError('ARTIFACT_VERIFICATION_FAILED','Cached artifact bytes differ from the deterministic compilation');
      const evidence = await this.knowledge.evidence(tx,task,id,'script-conclusion',{ conclusion: 'structural-workbook-verified',
        inputRevisionId:task.inputRevisionId,ir:parsed.ir,contractVersion:MINDMAP_CONTRACT_VERSION,mappingRulesVersion:MINDMAP_MAPPING_VERSION,
        verification,unmapped:parsed.unmapped,qualityOfTestCasesAssessed:false },
        { sourceSha256: source.sha256,artifactSha256: sha256(bytes),reader: verification.reader });
      const result = { status,artifacts: [artifact],evidence: [evidence],unmapped: parsed.unmapped,verification };
      await this.execution.complete(tx,row,'succeeded',{ ...result,reportHash:canonicalHash(report) }); await this.tasks.deliver(tx,task,result);
      return { operationId: id,deduplicated: false,status };
    });
  }
}
